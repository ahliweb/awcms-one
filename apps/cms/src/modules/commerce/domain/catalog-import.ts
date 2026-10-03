/**
 * The catalog CSV file contract (Issue #291) — pure: which columns exist, how a
 * header is validated, and how a record's cells become the typed input the
 * ordinary product validators already understand. The DB-touching planner and
 * the apply step live in `application/catalog-import.ts`.
 *
 * ## One validation path
 *
 * A CSV row is NOT validated by import-specific rules. Its core cells are mapped
 * to the same JSON-shaped body `POST/PATCH /products` accepts and handed to
 * `validateCreateProductInput`/`validateUpdateProductInput`; its `attr:<key>`
 * cells go through `validateAttributeAssignments`, the validator the attribute
 * endpoints use. So a value that the interactive API refuses, the import refuses
 * for the same reason, and a rule added to a validator reaches the import for
 * free.
 *
 * ## Cell semantics
 *
 *   core column, empty cell   -> "no change" (update) / "use the default" (create)
 *   `attr:<key>`, empty cell  -> CLEAR that attribute (so an export re-imports
 *                                as a no-op, and a cleared cell clears)
 *   column absent from header -> untouched
 *
 * The match key is the `sku` column: a live product with that SKU is updated,
 * otherwise a product is created.
 */
import { ATTRIBUTE_KEY_PATTERN } from "./attribute-definition";
import { unneutralizeCsvCell } from "./catalog-csv";

export const CORE_IMPORT_COLUMNS = [
  "sku",
  "name",
  "slug",
  "type",
  "status",
  "categorySlug",
  "price",
  "discountPercent",
  "stock",
  "weightGrams",
  "minPurchase",
  "description",
  "isFeatured",
  "isRecommended"
] as const;
export type CoreImportColumn = (typeof CORE_IMPORT_COLUMNS)[number];

export const ATTRIBUTE_COLUMN_PREFIX = "attr:";

/** Hard ceiling on data rows per file; the HTTP route's own limit never exceeds it. */
export const MAX_CATALOG_IMPORT_ROWS = 5000;
/** Rows the export writes before it flags truncation — equal to the import ceiling, so an export always re-imports. */
export const MAX_CATALOG_EXPORT_ROWS = MAX_CATALOG_IMPORT_ROWS;

export type ImportColumn =
  | { kind: "core"; name: CoreImportColumn; index: number }
  | { kind: "attribute"; key: string; name: string; index: number };

export type ImportHeaderResult =
  | { ok: true; columns: ImportColumn[] }
  | { ok: false; errors: { column: string; message: string }[] };

export function attributeColumnName(key: string): string {
  return `${ATTRIBUTE_COLUMN_PREFIX}${key}`;
}

/**
 * Validates the header. Unknown columns are an ERROR, not ignored: a typo such
 * as `prise` silently dropped would import a different file than the operator
 * reviewed. `knownAttributeKeys` are the tenant's live, product-applicable
 * definition keys.
 */
export function parseImportHeader(
  cells: readonly string[],
  knownAttributeKeys: ReadonlySet<string>
): ImportHeaderResult {
  const errors: { column: string; message: string }[] = [];
  const columns: ImportColumn[] = [];
  const seen = new Set<string>();

  cells.forEach((raw, index) => {
    const name = raw.trim();
    if (name.length === 0) {
      errors.push({
        column: `#${index + 1}`,
        message: "header cell is empty."
      });
      return;
    }
    if (seen.has(name)) {
      errors.push({ column: name, message: "column appears more than once." });
      return;
    }
    seen.add(name);

    if (name.startsWith(ATTRIBUTE_COLUMN_PREFIX)) {
      const key = name.slice(ATTRIBUTE_COLUMN_PREFIX.length);
      if (!ATTRIBUTE_KEY_PATTERN.test(key) || !knownAttributeKeys.has(key)) {
        errors.push({
          column: name,
          message: "is not an attribute that can be set on a product."
        });
        return;
      }
      columns.push({ kind: "attribute", key, name, index });
      return;
    }

    if ((CORE_IMPORT_COLUMNS as readonly string[]).includes(name)) {
      columns.push({ kind: "core", name: name as CoreImportColumn, index });
      return;
    }

    errors.push({
      column: name,
      message: `is not a recognised column. Known columns: ${CORE_IMPORT_COLUMNS.join(", ")}, and attr:<key> for a product attribute.`
    });
  });

  if (!seen.has("sku")) {
    errors.push({
      column: "sku",
      message: "the sku column is required: it is the key rows are matched on."
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, columns };
}

export type ImportRowCells = {
  /** Non-empty core cells, trimmed and un-neutralised. */
  core: Partial<Record<CoreImportColumn, string>>;
  /** `attr:<key>` cells: the text, or `null` for an empty cell (= clear). */
  attributes: Record<string, string | null>;
};

/** Splits one record's cells by the header's columns. Cells beyond the header are the caller's "ragged row" error. */
export function readImportRow(
  columns: readonly ImportColumn[],
  cells: readonly string[]
): ImportRowCells {
  const core: ImportRowCells["core"] = {};
  const attributes: ImportRowCells["attributes"] = {};

  for (const column of columns) {
    const cell = unneutralizeCsvCell(cells[column.index] ?? "");
    if (column.kind === "core") {
      const value = cell.trim();
      if (value.length > 0) core[column.name] = value;
    } else {
      const value = cell.trim();
      attributes[column.key] = value.length === 0 ? null : value;
    }
  }
  return { core, attributes };
}

const STRICT_INTEGER = /^[0-9]{1,9}$/;

function toIntegerOrRaw(value: string): number | string {
  return STRICT_INTEGER.test(value) ? Number(value) : value;
}

function toBooleanOrRaw(value: string): boolean | string {
  const lowered = value.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  return value;
}

/**
 * Maps the core cells to the JSON body the product validators take. A cell that
 * does not match its column's strict shape is passed through AS TEXT so the
 * validator reports it in its own words ("discountPercent must be an integer
 * between 0 and 100") — the importer never invents a second message.
 *
 * `categorySlug` is NOT mapped here (it needs a database lookup); `status` is
 * returned separately because a create always starts as `draft` and moves
 * through the normal status machine afterwards.
 */
export function coreCellsToProductBody(core: ImportRowCells["core"]): {
  body: Record<string, unknown>;
  status: string | null;
  categorySlug: string | null;
} {
  const body: Record<string, unknown> = {};
  if (core.sku !== undefined) body.sku = core.sku;
  if (core.name !== undefined) body.name = core.name;
  if (core.slug !== undefined) body.slug = core.slug;
  if (core.type !== undefined) body.type = core.type;
  if (core.price !== undefined) body.price = core.price;
  if (core.description !== undefined) body.description = core.description;
  if (core.discountPercent !== undefined) {
    body.discountPercent = toIntegerOrRaw(core.discountPercent);
  }
  if (core.stock !== undefined) body.stock = toIntegerOrRaw(core.stock);
  if (core.weightGrams !== undefined) {
    body.weightGrams = toIntegerOrRaw(core.weightGrams);
  }
  if (core.minPurchase !== undefined) {
    body.minPurchase = toIntegerOrRaw(core.minPurchase);
  }
  if (core.isFeatured !== undefined) {
    body.isFeatured = toBooleanOrRaw(core.isFeatured);
  }
  if (core.isRecommended !== undefined) {
    body.isRecommended = toBooleanOrRaw(core.isRecommended);
  }
  return {
    body,
    status: core.status ?? null,
    categorySlug: core.categorySlug ?? null
  };
}

/** Rows whose cell count differs from the header's. */
export function isRaggedRow(
  headerLength: number,
  cells: readonly string[]
): boolean {
  return cells.length !== headerLength;
}

export type ImportRowAction = "create" | "update" | "unchanged" | "error";

export type ImportRowError = { column: string; message: string };

export type ImportRowDiagnostic = {
  /** 1-based data-row number (the first record after the header is row 1). */
  row: number;
  /** 1-based physical line in the file, for opening it in an editor. */
  line: number;
  sku: string | null;
  action: ImportRowAction;
  errors: ImportRowError[];
};

export type ImportSummary = {
  create: number;
  update: number;
  unchanged: number;
  error: number;
};

export type ImportReport = {
  mode: "dry_run" | "apply";
  /** `true` when nothing blocks an apply: no fatal error, no row error. */
  valid: boolean;
  fileSha256: string;
  rowCount: number;
  summary: ImportSummary;
  /** File-level problems (unparsable CSV, bad header). When present, `rows` is empty. */
  fatalErrors: { line?: number; column?: string; message: string }[];
  rows: ImportRowDiagnostic[];
  /** `true` when `rows` was reduced to the error rows (large files). */
  rowsTruncated: boolean;
  /** Set only on a successful apply. */
  batchId?: string;
};

/** Files at or under this many rows get a diagnostic for EVERY row; larger files list only the error rows. */
export const FULL_DIAGNOSTICS_ROW_LIMIT = 1000;
/** Error rows reported at most. */
export const MAX_REPORTED_ERROR_ROWS = 500;

export function buildReportRows(diagnostics: readonly ImportRowDiagnostic[]): {
  rows: ImportRowDiagnostic[];
  truncated: boolean;
} {
  if (diagnostics.length <= FULL_DIAGNOSTICS_ROW_LIMIT) {
    return { rows: [...diagnostics], truncated: false };
  }
  const errorRows = diagnostics.filter((row) => row.action === "error");
  return {
    rows: errorRows.slice(0, MAX_REPORTED_ERROR_ROWS),
    truncated: true
  };
}

/**
 * The only request media type the import endpoint accepts. `text/plain` (and
 * `application/x-www-form-urlencoded`, `multipart/form-data`) are CORS-safelisted
 * — a cross-site form or `fetch` can send them without a preflight — so
 * accepting `text/plain` would let a foreign page post a dry-run with no
 * `Idempotency-Key` and no preflight. `text/csv` is not safelisted.
 */
export const CATALOG_IMPORT_CONTENT_TYPE = "text/csv";

/** `true` for exactly `text/csv` (parameters such as `; charset=utf-8` ignored, case-insensitive). */
export function isCatalogImportContentType(header: string | null): boolean {
  return (
    (header ?? "").split(";")[0]!.trim().toLowerCase() ===
    CATALOG_IMPORT_CONTENT_TYPE
  );
}
