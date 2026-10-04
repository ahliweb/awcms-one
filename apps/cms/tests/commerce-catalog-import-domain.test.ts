/**
 * The catalog CSV file contract (Issue #291) — pure: header validation, row
 * reading, the core-cell -> product-body mapping, report shaping, the client
 * helpers, and source-level contract checks over the import/export/attribute
 * routes. No database (the plan/apply behaviour is in
 * `tests/integration/commerce-catalog-attributes.integration.test.ts`).
 *
 * Source-text assertions here use plain `indexOf`/`includes`, never a
 * `<tag>…</tag>` regex (CodeQL `js/bad-tag-filter`).
 */
import { describe, expect, test } from "bun:test";

import { stripComments } from "../scripts/lib/source-text";
import { validateAttributeAssignments } from "../src/modules/commerce/domain/attribute-assignment";
import {
  buildReportRows,
  coreCellsToProductBody,
  CORE_IMPORT_COLUMNS,
  FULL_DIAGNOSTICS_ROW_LIMIT,
  isCatalogImportContentType,
  isRaggedRow,
  MAX_CATALOG_EXPORT_ROWS,
  MAX_CATALOG_IMPORT_ROWS,
  MAX_REPORTED_ERROR_ROWS,
  parseImportHeader,
  readImportRow,
  type ImportRowDiagnostic
} from "../src/modules/commerce/domain/catalog-import";
import { neutralizeCsvCell } from "../src/modules/commerce/domain/catalog-csv";
import {
  buildConstraintsPayload,
  collectAttributeValues,
  formatOptionsText,
  parseOptionsText
} from "../src/lib/ui/commerce-attributes-client";
import { fillTemplate } from "../src/lib/ui/commerce-catalog-import-client";

const KNOWN = new Set(["weight", "color"]);

function header(cells: string[]) {
  return parseImportHeader(cells, KNOWN);
}

describe("import header", () => {
  test("accepts core columns and known attr: columns in any order", () => {
    const result = header(["attr:weight", "sku", "name", "attr:color"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns.map((column) => column.kind)).toEqual([
        "attribute",
        "core",
        "core",
        "attribute"
      ]);
    }
  });

  test("sku is required; unknown, duplicate and empty columns are errors, never ignored", () => {
    expect(header(["name", "price"]).ok).toBe(false);
    expect(header(["sku", "prise"]).ok).toBe(false);
    expect(header(["sku", "sku"]).ok).toBe(false);
    expect(header(["sku", ""]).ok).toBe(false);
    expect(header(["sku", "attr:nope"]).ok).toBe(false);
    expect(header(["sku", "attr:"]).ok).toBe(false);
    expect(header(["sku", "attr:Weight"]).ok).toBe(false);
    // Media is not a column: nothing in a file can name a URL or a media object.
    for (const media of [
      "imageUrl",
      "image",
      "media",
      "mediaObjectId",
      "images"
    ]) {
      expect(header(["sku", media]).ok).toBe(false);
    }
    expect(CORE_IMPORT_COLUMNS).not.toContain("costPrice" as never);
    expect(CORE_IMPORT_COLUMNS).not.toContain("downloadLink" as never);
  });
});

describe("row reading and the product body mapping", () => {
  const columns = (() => {
    const result = header([
      "sku",
      "name",
      "price",
      "stock",
      "isFeatured",
      "attr:weight",
      "attr:color"
    ]);
    if (!result.ok) throw new Error("header");
    return result.columns;
  })();

  test("core cells are trimmed and blank ones dropped; attr cells map blank -> null (clear)", () => {
    const row = readImportRow(columns, [
      "  A-1 ",
      "Name",
      "",
      "5",
      "TRUE",
      "1.5",
      ""
    ]);
    expect(row.core).toEqual({
      sku: "A-1",
      name: "Name",
      stock: "5",
      isFeatured: "TRUE"
    });
    expect(row.attributes).toEqual({ weight: "1.5", color: null });
  });

  test("an exported, neutralised cell is restored on import", () => {
    const row = readImportRow(columns, [
      "A-1",
      neutralizeCsvCell("=cmd"),
      "",
      "",
      "",
      "",
      ""
    ]);
    expect(row.core.name).toBe("=cmd");
  });

  test("cells map to the JSON body the product validators already take; malformed ones pass through as text", () => {
    const { body } = coreCellsToProductBody({
      sku: "A",
      stock: "5",
      isFeatured: "TRUE",
      discountPercent: "10%",
      price: "12,5"
    });
    expect(body).toMatchObject({
      sku: "A",
      stock: 5,
      isFeatured: true,
      // Not coerced: the product validator refuses these in its own words.
      discountPercent: "10%",
      price: "12,5"
    });
  });

  test("status and categorySlug are returned apart (they need a lookup / the status machine)", () => {
    const mapped = coreCellsToProductBody({
      sku: "A",
      status: "active",
      categorySlug: "drinks"
    });
    expect(mapped.status).toBe("active");
    expect(mapped.categorySlug).toBe("drinks");
    expect(mapped.body).not.toHaveProperty("status");
    expect(mapped.body).not.toHaveProperty("categorySlug");
  });

  test("a ragged row is detected", () => {
    expect(isRaggedRow(3, ["a", "b"])).toBe(true);
    expect(isRaggedRow(3, ["a", "b", "c"])).toBe(false);
  });
});

describe("attribute assignments are one validation path", () => {
  const definitions = [
    {
      id: "d1",
      key: "weight",
      valueType: "decimal" as const,
      constraints: {},
      appliesTo: "product" as const
    },
    {
      id: "d2",
      key: "finish",
      valueType: "text" as const,
      constraints: {},
      appliesTo: "variant" as const
    }
  ];

  test("a value, a null (clear) and an absent key", () => {
    const result = validateAttributeAssignments(
      { weight: "2.50" },
      definitions,
      "product"
    );
    expect(result.valid).toBe(true);
    if (result.valid)
      expect(result.assignments[0]?.value?.canonical).toBe("2.5");
    const cleared = validateAttributeAssignments(
      { weight: null },
      definitions,
      "product"
    );
    expect(cleared.valid && cleared.assignments[0]?.value).toBeNull();
  });

  test("unknown, wrong-target and malformed keys read the same; bad values are rejected", () => {
    for (const bad of [
      { nope: "x" },
      { finish: "matte" },
      { "w;DROP": "x" },
      { weight: "1,5" }
    ]) {
      expect(
        validateAttributeAssignments(bad, definitions, "product").valid
      ).toBe(false);
    }
    expect(validateAttributeAssignments([], definitions, "product").valid).toBe(
      false
    );
    expect(
      validateAttributeAssignments("x", definitions, "product").valid
    ).toBe(false);
    const unknown = validateAttributeAssignments(
      { nope: "x" },
      definitions,
      "product"
    );
    const wrongTarget = validateAttributeAssignments(
      { finish: "x" },
      definitions,
      "product"
    );
    expect(!unknown.valid && unknown.errors[0]?.message).toBe(
      !wrongTarget.valid && wrongTarget.errors[0]?.message
    );
  });
});

describe("report shaping and limits", () => {
  const rows = (count: number, errorEvery: number): ImportRowDiagnostic[] =>
    Array.from({ length: count }, (_, index) => ({
      row: index + 1,
      line: index + 2,
      sku: `S${index}`,
      action:
        index % errorEvery === 0 ? ("error" as const) : ("create" as const),
      errors:
        index % errorEvery === 0 ? [{ column: "price", message: "bad" }] : []
    }));

  test("a file at or under the limit gets a diagnostic for EVERY row", () => {
    const shaped = buildReportRows(rows(FULL_DIAGNOSTICS_ROW_LIMIT, 7));
    expect(shaped.truncated).toBe(false);
    expect(shaped.rows).toHaveLength(FULL_DIAGNOSTICS_ROW_LIMIT);
  });

  test("a larger file lists only error rows, capped", () => {
    const shaped = buildReportRows(rows(FULL_DIAGNOSTICS_ROW_LIMIT + 1, 1));
    expect(shaped.truncated).toBe(true);
    expect(shaped.rows.length).toBe(MAX_REPORTED_ERROR_ROWS);
    expect(shaped.rows.every((row) => row.action === "error")).toBe(true);
  });

  test("an export always re-imports: the export ceiling equals the import ceiling", () => {
    expect(MAX_CATALOG_EXPORT_ROWS).toBe(MAX_CATALOG_IMPORT_ROWS);
  });
});

describe("attribute screen client helpers", () => {
  test("option text <-> option list", () => {
    expect(parseOptionsText("red\nblue|Blue\n\n  green | Green  \n")).toEqual([
      { value: "red", label: "red" },
      { value: "blue", label: "Blue" },
      { value: "green", label: "Green" }
    ]);
    expect(formatOptionsText(parseOptionsText("red\nblue|Blue"))).toBe(
      "red\nblue|Blue"
    );
  });

  test("constraints: only the selected type's keys, blank fields omitted", () => {
    const fields: Record<string, string> = {
      minLength: "2",
      maxLength: "",
      min: "0",
      max: "100.5",
      scale: "3",
      dateMin: "2024-01-01",
      dateMax: "",
      options: "a\nb"
    };
    const read = (name: string) => fields[name] ?? "";
    expect(buildConstraintsPayload("text", read)).toEqual({ minLength: 2 });
    expect(buildConstraintsPayload("integer", read)).toEqual({
      min: "0",
      max: "100.5"
    });
    expect(buildConstraintsPayload("decimal", read)).toEqual({
      min: "0",
      max: "100.5",
      scale: 3
    });
    expect(buildConstraintsPayload("date", read)).toEqual({
      min: "2024-01-01"
    });
    expect(buildConstraintsPayload("enum", read)).toEqual({
      options: [
        { value: "a", label: "a" },
        { value: "b", label: "b" }
      ]
    });
    expect(buildConstraintsPayload("boolean", read)).toEqual({});
  });

  test("attribute form values: blank clears, text is trimmed, non-attr controls ignored", () => {
    const data = new FormData();
    data.set("attr:weight", " 2.5 ");
    data.set("attr:color", "");
    data.set("name", "ignored");
    expect(collectAttributeValues(data)).toEqual({
      weight: "2.5",
      color: null
    });
  });

  test("template filling leaves unknown placeholders alone", () => {
    expect(fillTemplate("{a} of {b} ({c})", { a: 1, b: 2 })).toBe(
      "1 of 2 ({c})"
    );
  });
});

describe("route and screen contracts (source level)", () => {
  async function source(path: string): Promise<string> {
    return stripComments(await Bun.file(path).text());
  }

  test("import: needs import + create + update, an Idempotency-Key to apply, a body ceiling, and no remote fetch", async () => {
    const route = await source("src/pages/api/v1/commerce/products/import.ts");
    expect(route).toContain('action: "import"');
    expect(route).toContain('action: "create"');
    expect(route).toContain('action: "update"');
    expect(route).toContain("IDEMPOTENCY_REQUIRED");
    expect(route).toContain("IDEMPOTENCY_CONFLICT");
    expect(route).toContain('readTextBody(request, "large")');
    expect(route).toContain("expectedSha256");
    expect(route).toContain("IMPORT_VALIDATION_FAILED");
    // The importer never fetches anything.
    for (const file of [
      route,
      await source("src/modules/commerce/application/catalog-import.ts"),
      await source("src/modules/commerce/domain/catalog-import.ts"),
      await source("src/modules/commerce/domain/catalog-csv.ts")
    ]) {
      expect(file).not.toContain("fetch(");
      expect(file).not.toContain("http://");
    }
  });

  test("export: gated on products.export, neutralised cells, no-store", async () => {
    const route = await source(
      "src/pages/api/v1/commerce/products/export.csv.ts"
    );
    expect(route).toContain('action: "export"');
    expect(route).toContain("no-store");
    const exporter = await source(
      "src/modules/commerce/application/catalog-export.ts"
    );
    expect(exporter).toContain("serializeCsv");
    expect(exporter).not.toContain("costPrice");
    expect(exporter).not.toContain("downloadLink");
  });

  test("the admin attribute read is NOT gated on products.read (a storefront credential holds that)", async () => {
    const route = await source(
      "src/pages/api/v1/commerce/products/[id]/attributes.ts"
    );
    const getGuard = route.slice(
      route.indexOf("const READ_GUARD"),
      route.indexOf("const UPDATE_GUARD")
    );
    expect(getGuard).toContain("COMMERCE_ATTRIBUTES_ACTIVITY_CODE");
    expect(getGuard).not.toContain("COMMERCE_PRODUCTS_ACTIVITY_CODE");
  });

  test("the public product routes expose attributes only through attachPublicAttributes", async () => {
    for (const path of [
      "src/pages/api/v1/commerce/products/index.ts",
      "src/pages/api/v1/commerce/products/[id].ts",
      "src/pages/api/v1/commerce/products/by-slug/[slug].ts"
    ]) {
      const route = await source(path);
      expect(route).toContain("attachPublicAttributes");
      expect(route).not.toContain("loadAttributeSets");
    }
  });

  test("no SQL text is built from a filter key, value or operator", async () => {
    const sql = await source(
      "src/modules/commerce/application/attribute-filter-sql.ts"
    );
    // `tx.unsafe` is how identifiers/expressions would be spliced; this module
    // must have none, and must not template a column name.
    expect(sql).not.toContain("tx.unsafe");
    expect(sql).not.toContain("sql.unsafe");
    expect(sql).not.toContain("${column");
    expect(sql).not.toContain("${operator");
    expect(sql).not.toContain("${filter.key");
    const directory = await source(
      "src/modules/commerce/application/product-directory.ts"
    );
    // The only `tx.unsafe` calls splice module-local string CONSTANTS.
    for (const line of directory.split("\n")) {
      if (line.includes("tx.unsafe(")) {
        expect(
          line.includes("PRODUCT_COLUMNS") ||
            line.includes("keysetCursorCreatedAtSql") ||
            line.includes("ORDER_BY_SQL[sort]")
        ).toBe(true);
      }
    }
  });

  test("the new screens use the shared dialog, never window.confirm or a literal data-label", async () => {
    for (const path of [
      "src/pages/admin/commerce-attributes.astro",
      "src/pages/admin/commerce-catalog-import.astro"
    ]) {
      const page = await source(path);
      expect(page).not.toContain("window.confirm");
      expect(page).not.toContain('data-label="');
      expect(page).toContain("CommerceConfirmDialog");
    }
  });

  test("the import accepts exactly text/csv: text/plain (CORS-safelisted, no preflight) and friends are refused", async () => {
    expect(isCatalogImportContentType("text/csv")).toBe(true);
    expect(isCatalogImportContentType("text/csv; charset=utf-8")).toBe(true);
    expect(isCatalogImportContentType("TEXT/CSV;charset=UTF-8")).toBe(true);
    for (const rejected of [
      "text/plain",
      "text/plain; charset=utf-8",
      "application/csv",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/json",
      "",
      null
    ]) {
      expect(isCatalogImportContentType(rejected)).toBe(false);
    }
    const route = stripComments(
      await source("src/pages/api/v1/commerce/products/import.ts")
    );
    expect(route).toContain("isCatalogImportContentType(");
    expect(route).not.toContain("text/plain");
  });

  test("a products.read / export holder without attributes.read cannot reach non-public attributes", async () => {
    // Admin `q` search: the audience follows attributes.read, not products.read.
    const screen = stripComments(
      await source("src/pages/admin/commerce.astro")
    );
    expect(screen).toContain(
      'attributeAudience: canReadAttributes ? "admin" : "public"'
    );
    expect(screen).not.toContain('attributeAudience: "admin"');
    // CSV export: the attribute columns widen only with attributes.read.
    const route = stripComments(
      await source("src/pages/api/v1/commerce/products/export.csv.ts")
    );
    expect(route).toContain("COMMERCE_ATTRIBUTES_ACTIVITY_CODE");
    expect(route).toContain("attributeDecision.allowed");
  });
});
