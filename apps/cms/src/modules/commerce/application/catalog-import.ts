/**
 * Catalog CSV import (Issue #291): upload -> dry-run report -> apply, ONE code
 * path.
 *
 * ## Dry-run/apply parity
 *
 * {@link planCatalogImport} reads the file, validates every row and decides each
 * row's action (`create` | `update` | `unchanged` | `error`) WITHOUT writing.
 * {@link applyCatalogImport} calls the SAME planner and, only when the plan has
 * no error, executes it. There is no second parser: the report an operator
 * reviews and the writes an apply performs are derived from one function, so
 * they cannot disagree about what a row means (the parity test asserts it).
 *
 * ## All-or-nothing
 *
 * An apply is one unit: every row lands or none does. It runs inside a SAVEPOINT
 * on the request transaction; any failure (a race the planner could not see —
 * another request taking a slug between plan and write — or an unexpected
 * error) rolls the savepoint back, so no product, attribute value, audit row or
 * domain event of the batch survives. The alternative, chunked/partial apply,
 * leaves a catalog that is half the file the operator reviewed and needs a
 * second tool to reconcile; it is deliberately not offered (ADR-0027).
 *
 * ## What an import can never do
 *
 *   - bypass validation: rows go through `validateCreateProductInput`/
 *     `validateUpdateProductInput` and `validateAttributeAssignments`;
 *   - fetch anything: this module has no network code, and no column accepts a
 *     media URL or reference — images stay a separate, explicit step;
 *   - cross a tenant: every statement carries `tenantId` and the transaction's
 *     RLS context, and rows are matched only against the caller's own products;
 *   - write what the caller may not: the route requires import + create + update.
 */
import { createHash } from "node:crypto";

import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  readInventoryConfig,
  StockManagedByInventoryError
} from "./commerce-inventory";
import { STOCK_MANAGED_BY_INVENTORY_MESSAGE } from "../domain/commerce-inventory";
import {
  validateAttributeAssignments,
  type AttributeAssignment
} from "../domain/attribute-assignment";
import {
  coreCellsToProductBody,
  FULL_DIAGNOSTICS_ROW_LIMIT,
  buildReportRows,
  isRaggedRow,
  MAX_CATALOG_IMPORT_ROWS,
  parseImportHeader,
  readImportRow,
  type ImportReport,
  type ImportRowAction,
  type ImportRowDiagnostic,
  type ImportRowError,
  type ImportSummary
} from "../domain/catalog-import";
import { DEFAULT_CSV_LIMITS, parseCsv } from "../domain/catalog-csv";
import { normalizeMoney } from "../domain/price-calculation";
import {
  applyProductStatus,
  isProductStatus,
  PRODUCT_STATUSES,
  type ProductStatus
} from "../domain/product-status";
import {
  validateCreateProductInput,
  validateUpdateProductInput,
  type CreateProductInput,
  type UpdateProductInput
} from "../domain/product-validation";
import { attributeAppliesToTarget } from "../domain/attribute-definition";
import { listAttributeDefinitions } from "./attribute-definition-directory";
import {
  applyAttributeAssignments,
  loadCanonicalProductValues
} from "./attribute-value-directory";
import { BundleDefinitionInvalidError } from "./bundle-directory";
import {
  createProduct,
  DuplicateProductSkuError,
  DuplicateProductSlugError,
  fetchLiveSlugOwners,
  fetchProductsBySkusForAdmin,
  IllegalProductStatusTransitionError,
  InvalidSizeChartFieldsError,
  ProductCategoryNotFoundError,
  updateProduct,
  type ProductAdminRecord
} from "./product-directory";

const AUDIT_MODULE_KEY = "commerce";
const IMPORT_SAVEPOINT = "catalog_import_apply";

export type PlannedRow = {
  row: number;
  line: number;
  sku: string;
  action: Exclude<ImportRowAction, "error">;
  /** `create`: the validated create input. */
  createInput?: CreateProductInput;
  /** `update`: ONLY the fields that differ from the stored product. */
  updateInput?: UpdateProductInput;
  /** A create that asks for a non-draft status moves there after the insert. */
  statusAfterCreate?: ProductStatus;
  /** The product being updated (`update`/`unchanged`); `null` for a create. */
  existingProductId: string | null;
  assignments: AttributeAssignment[];
};

export type CatalogImportPlan = {
  fileSha256: string;
  rowCount: number;
  summary: ImportSummary;
  fatalErrors: ImportReport["fatalErrors"];
  diagnostics: ImportRowDiagnostic[];
  planned: PlannedRow[];
  valid: boolean;
};

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function emptySummary(): ImportSummary {
  return { create: 0, update: 0, unchanged: 0, error: 0 };
}

function fatalPlan(
  fileSha256: string,
  fatal: ImportReport["fatalErrors"]
): CatalogImportPlan {
  return {
    fileSha256,
    rowCount: 0,
    summary: emptySummary(),
    fatalErrors: fatal,
    diagnostics: [],
    planned: [],
    valid: false
  };
}

/** Field -> column name for a validator error (`discountPercent`, `attributes.size` -> `attr:size`). */
function columnForField(field: string): string {
  if (field.startsWith("attr.")) return `attr:${field.slice("attr.".length)}`;
  return field;
}

function changedUpdateFields(
  input: UpdateProductInput,
  existing: ProductAdminRecord
): UpdateProductInput {
  const changed: Record<string, unknown> = {};
  const source = input as Record<string, unknown>;
  const current = existing as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const stored = current[key];
    const same =
      key === "price"
        ? normalizeMoney(value as string) === stored
        : value === stored;
    if (!same) changed[key] = value;
  }
  return changed as UpdateProductInput;
}

/**
 * Reads, validates and plans a catalog CSV. Pure with respect to the database
 * writes: it only SELECTs. Safe to call for a dry-run, and is exactly what
 * {@link applyCatalogImport} calls before it writes.
 */
export async function planCatalogImport(
  tx: Bun.SQL,
  tenantId: string,
  csvText: string
): Promise<CatalogImportPlan> {
  const fileSha256 = sha256Hex(csvText);

  const parsed = parseCsv(csvText, {
    ...DEFAULT_CSV_LIMITS,
    maxRows: MAX_CATALOG_IMPORT_ROWS
  });
  if (!parsed.ok) {
    return fatalPlan(fileSha256, [
      { line: parsed.line, message: parsed.message }
    ]);
  }

  const definitions = (await listAttributeDefinitions(tx, tenantId)).filter(
    (definition) => attributeAppliesToTarget(definition.appliesTo, "product")
  );
  const header = parseImportHeader(
    parsed.header.cells,
    new Set(definitions.map((definition) => definition.key))
  );
  if (!header.ok) {
    return fatalPlan(
      fileSha256,
      header.errors.map((error) => ({
        line: parsed.header.line,
        column: error.column,
        message: error.message
      }))
    );
  }
  const columns = header.columns;

  // Pass 1 — read every record and collect the lookups the database must answer.
  const records = parsed.rows.map((record, index) => ({
    row: index + 1,
    line: record.line,
    ragged: isRaggedRow(parsed.header.cells.length, record.cells),
    cells: readImportRow(columns, record.cells)
  }));

  const skus = new Set<string>();
  const categorySlugs = new Set<string>();
  const slugs = new Set<string>();
  for (const record of records) {
    if (record.cells.core.sku) skus.add(record.cells.core.sku);
    if (record.cells.core.categorySlug) {
      categorySlugs.add(record.cells.core.categorySlug);
    }
    if (record.cells.core.slug) slugs.add(record.cells.core.slug);
  }

  const existingBySku = new Map(
    (await fetchProductsBySkusForAdmin(tx, tenantId, [...skus])).map(
      (product) => [product.sku, product]
    )
  );
  const slugOwners = await fetchLiveSlugOwners(tx, tenantId, [...slugs]);
  const categoryBySlug = new Map<string, string>();
  if (categorySlugs.size > 0) {
    const rows = (await tx`
      SELECT id, slug
      FROM awcms_commerce_categories
      WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
        AND slug = ANY(${tx.array([...categorySlugs], "text")}::text[])
    `) as { id: string; slug: string }[];
    for (const row of rows) categoryBySlug.set(row.slug, row.id);
  }
  // Issue #282 (ADR-0038 D6) - in `ledger` mode a `stock` cell may not change
  // a count (an unchanged value passes), and a new product starts at zero.
  const ledgerOwnsStock =
    (await readInventoryConfig(tx, tenantId)).mode === "ledger";
  const currentValues = await loadCanonicalProductValues(
    tx,
    tenantId,
    [...existingBySku.values()].map((product) => product.id),
    definitions
  );

  // Pass 2 — decide every row.
  const diagnostics: ImportRowDiagnostic[] = [];
  const planned: PlannedRow[] = [];
  const summary = emptySummary();
  const firstRowOfSku = new Map<string, number>();
  const firstRowOfSlug = new Map<string, number>();

  for (const record of records) {
    const errors: ImportRowError[] = [];
    const sku = record.cells.core.sku ?? null;

    if (record.ragged) {
      errors.push({
        column: "*",
        message: `has a different number of cells than the header (expected ${parsed.header.cells.length}).`
      });
    }

    if (sku === null) {
      errors.push({ column: "sku", message: "sku is required." });
    } else if (firstRowOfSku.has(sku)) {
      errors.push({
        column: "sku",
        message: `duplicate sku in this file (first seen on row ${firstRowOfSku.get(sku)}).`
      });
    } else {
      firstRowOfSku.set(sku, record.row);
    }

    const slugCell = record.cells.core.slug;
    if (slugCell !== undefined) {
      const firstSlugRow = firstRowOfSlug.get(slugCell);
      if (firstSlugRow !== undefined) {
        errors.push({
          column: "slug",
          message: `duplicate slug in this file (first seen on row ${firstSlugRow}).`
        });
      } else {
        firstRowOfSlug.set(slugCell, record.row);
      }
    }

    const existing = sku === null ? undefined : existingBySku.get(sku);
    const { body, status, categorySlug } = coreCellsToProductBody(
      record.cells.core
    );

    let categoryId: string | null | undefined;
    if (categorySlug !== null) {
      categoryId = categoryBySlug.get(categorySlug);
      if (categoryId === undefined) {
        errors.push({
          column: "categorySlug",
          message: "does not match a live category in this tenant."
        });
      }
    }
    if (categoryId) body.categoryId = categoryId;

    // The slug must not already belong to a DIFFERENT live product.
    if (slugCell !== undefined) {
      const owner = slugOwners.get(slugCell);
      if (owner !== undefined && owner !== sku) {
        errors.push({
          column: "slug",
          message: `is already used by the product with sku "${owner}".`
        });
      }
    }

    // Attribute cells: the shared assignment validator (empty cell -> clear).
    const assignmentResult = validateAttributeAssignments(
      record.cells.attributes,
      definitions,
      "product",
      "attr"
    );
    let assignments: AttributeAssignment[] = [];
    if (assignmentResult.valid) {
      assignments = assignmentResult.assignments;
    } else {
      for (const error of assignmentResult.errors) {
        errors.push({
          column: columnForField(error.field),
          message: error.message
        });
      }
    }

    let createInput: CreateProductInput | undefined;
    let updateInput: UpdateProductInput | undefined;
    let statusAfterCreate: ProductStatus | undefined;
    let action: Exclude<ImportRowAction, "error"> = "unchanged";

    // Product fields go through the SAME validators the single-product API
    // uses; every column error of the row is reported in one pass.
    if (sku !== null && !record.ragged) {
      if (status !== null && !isProductStatus(status)) {
        errors.push({
          column: "status",
          message: `must be one of: ${PRODUCT_STATUSES.join(", ")}.`
        });
      }
      const knownStatus =
        status !== null && isProductStatus(status) ? status : null;

      if (existing) {
        const validation = validateUpdateProductInput({
          ...body,
          // sku is the match key and never changes through an import.
          sku: undefined,
          ...(knownStatus === null ? {} : { status: knownStatus })
        });
        if (!validation.valid) {
          for (const error of validation.errors) {
            errors.push({
              column: columnForField(error.field),
              message: error.message
            });
          }
        } else {
          if (knownStatus !== null) {
            const transition = applyProductStatus(existing.status, knownStatus);
            if (!transition.valid) {
              for (const error of transition.errors) {
                errors.push({ column: "status", message: error.message });
              }
            }
          }
          updateInput = changedUpdateFields(validation.value, existing);
          if (ledgerOwnsStock && updateInput.stock !== undefined) {
            errors.push({
              column: "stock",
              message: STOCK_MANAGED_BY_INVENTORY_MESSAGE
            });
          }
        }
      } else {
        const validation = validateCreateProductInput(body);
        if (!validation.valid) {
          for (const error of validation.errors) {
            errors.push({
              column: columnForField(error.field),
              message: error.message
            });
          }
        } else {
          createInput = validation.value;
          if (ledgerOwnsStock && validation.value.stock !== 0) {
            errors.push({
              column: "stock",
              message: STOCK_MANAGED_BY_INVENTORY_MESSAGE
            });
          }
          if (knownStatus !== null && knownStatus !== "draft") {
            const transition = applyProductStatus("draft", knownStatus);
            if (!transition.valid) {
              for (const error of transition.errors) {
                errors.push({ column: "status", message: error.message });
              }
            } else {
              statusAfterCreate = knownStatus;
            }
          }
        }
      }
    }

    if (errors.length === 0 && sku !== null) {
      if (createInput) {
        action = "create";
      } else {
        const current = existing ? currentValues.get(existing.id) : undefined;
        const attributeChanges = assignments.filter((assignment) => {
          const stored = current?.get(assignment.key) ?? null;
          return (assignment.value?.canonical ?? null) !== stored;
        });
        const hasFieldChanges =
          updateInput !== undefined && Object.keys(updateInput).length > 0;
        action =
          hasFieldChanges || attributeChanges.length > 0
            ? "update"
            : "unchanged";
        assignments = attributeChanges;
      }
    }

    if (errors.length > 0 || sku === null) {
      summary.error += 1;
      diagnostics.push({
        row: record.row,
        line: record.line,
        sku,
        action: "error",
        errors
      });
      continue;
    }

    summary[action] += 1;
    diagnostics.push({
      row: record.row,
      line: record.line,
      sku,
      action,
      errors: []
    });
    planned.push({
      row: record.row,
      line: record.line,
      sku,
      action,
      createInput,
      updateInput,
      statusAfterCreate,
      existingProductId: existing?.id ?? null,
      assignments
    });
  }

  return {
    fileSha256,
    rowCount: records.length,
    summary,
    fatalErrors: [],
    diagnostics,
    planned,
    valid: summary.error === 0
  };
}

export function planToReport(
  plan: CatalogImportPlan,
  mode: ImportReport["mode"],
  batchId?: string
): ImportReport {
  const { rows, truncated } = buildReportRows(plan.diagnostics);
  return {
    mode,
    valid: plan.valid,
    fileSha256: plan.fileSha256,
    rowCount: plan.rowCount,
    summary: plan.summary,
    fatalErrors: plan.fatalErrors,
    rows,
    rowsTruncated: truncated,
    ...(batchId === undefined ? {} : { batchId })
  };
}

/** The dry-run: validate and plan, write nothing. */
export async function dryRunCatalogImport(
  tx: Bun.SQL,
  tenantId: string,
  csvText: string
): Promise<ImportReport> {
  const plan = await planCatalogImport(tx, tenantId, csvText);
  return planToReport(plan, "dry_run");
}

export type ApplyCatalogImportResult =
  | { kind: "applied"; report: ImportReport }
  /** The plan has errors (or the file is unusable): nothing was written. */
  | { kind: "invalid"; report: ImportReport }
  /** The plan was valid but a write failed (a race): the savepoint was rolled back, nothing persists. */
  | { kind: "rolled_back"; report: ImportReport; message: string }
  /**
   * The `Idempotency-Key` already owns a committed batch (a replay, or a
   * concurrent request that committed first): nothing was written. The caller
   * answers with the stored replay, or `409 IDEMPOTENCY_CONFLICT`.
   */
  | { kind: "duplicate_key" };

/**
 * Applies a catalog CSV all-or-nothing. The caller has already checked
 * permissions, the `Idempotency-Key` and (optionally) that the file's hash
 * matches the dry-run it reviewed.
 */
export async function applyCatalogImport(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  csvText: string,
  idempotencyKey: string,
  correlationId?: string
): Promise<ApplyCatalogImportResult> {
  const plan = await planCatalogImport(tx, tenantId, csvText);
  if (!plan.valid) {
    return { kind: "invalid", report: planToReport(plan, "apply") };
  }

  await tx.unsafe(`SAVEPOINT ${IMPORT_SAVEPOINT}`);
  let batchId: string;
  try {
    // Claim the Idempotency-Key BEFORE any product write, inside the savepoint.
    // A concurrent apply with the same key blocks on the unique index until the
    // winner commits, then gets no row back and writes nothing — so the loser
    // never hits a raw unique violation (a 500) and never double-applies. If
    // the writes below fail, the rollback releases the claim too.
    const keyHash = sha256Hex(idempotencyKey);
    const batchRows = (await tx`
      INSERT INTO awcms_commerce_catalog_import_batches (
        tenant_id, file_sha256, idempotency_key_hash, row_count,
        created_count, updated_count, unchanged_count, actor_tenant_user_id
      )
      VALUES (
        ${tenantId}, ${plan.fileSha256}, ${keyHash}, ${plan.rowCount},
        ${plan.summary.create}, ${plan.summary.update}, ${plan.summary.unchanged},
        ${actorTenantUserId}
      )
      ON CONFLICT (tenant_id, idempotency_key_hash) DO NOTHING
      RETURNING id
    `) as { id: string }[];
    if (batchRows.length === 0) {
      await tx.unsafe(`ROLLBACK TO SAVEPOINT ${IMPORT_SAVEPOINT}`);
      return { kind: "duplicate_key" };
    }
    batchId = batchRows[0]!.id;

    for (const row of plan.planned) {
      if (row.action === "unchanged") continue;

      let productId: string;
      if (row.action === "create") {
        const product = await createProduct(
          tx,
          tenantId,
          actorTenantUserId,
          row.createInput as CreateProductInput,
          correlationId
        );
        productId = product.id;
        if (row.statusAfterCreate) {
          await updateProduct(
            tx,
            tenantId,
            actorTenantUserId,
            productId,
            { status: row.statusAfterCreate },
            correlationId
          );
        }
      } else {
        productId = row.existingProductId as string;
        if (row.updateInput && Object.keys(row.updateInput).length > 0) {
          const updated = await updateProduct(
            tx,
            tenantId,
            actorTenantUserId,
            productId,
            row.updateInput,
            correlationId
          );
          if (!updated)
            throw new RowWriteError(row.row, "product no longer exists.");
        }
      }

      if (row.assignments.length > 0) {
        await applyAttributeAssignments(
          tx,
          tenantId,
          actorTenantUserId,
          { productId },
          row.assignments,
          correlationId,
          { skipTargetCheck: true }
        );
      }
    }
    await tx.unsafe(`RELEASE SAVEPOINT ${IMPORT_SAVEPOINT}`);
  } catch (error) {
    await tx.unsafe(`ROLLBACK TO SAVEPOINT ${IMPORT_SAVEPOINT}`);
    // A conflict the planner could not see (a concurrent request took a slug
    // between plan and write) is an expected, caller-actionable outcome. Any
    // other error is a defect: the savepoint is already rolled back, and the
    // error propagates so `withTenant` rolls back the request and the route
    // answers 500 — never a swallowed exception.
    if (!isExpectedWriteConflict(error)) throw error;
    return {
      kind: "rolled_back",
      message: describeWriteFailure(error),
      report: planToReport(plan, "apply")
    };
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "catalog_import.apply",
    resourceType: "catalog_import_batch",
    resourceId: batchId,
    severity: "warning",
    message: `Catalog import applied: ${plan.summary.create} created, ${plan.summary.update} updated, ${plan.summary.unchanged} unchanged.`,
    attributes: {
      fileSha256: plan.fileSha256,
      rowCount: plan.rowCount,
      ...plan.summary
    },
    correlationId
  });

  return { kind: "applied", report: planToReport(plan, "apply", batchId) };
}

class RowWriteError extends Error {
  constructor(
    public readonly row: number,
    message: string
  ) {
    super(message);
    this.name = "RowWriteError";
  }
}

function isExpectedWriteConflict(error: unknown): boolean {
  return (
    error instanceof RowWriteError ||
    error instanceof StockManagedByInventoryError ||
    error instanceof BundleDefinitionInvalidError ||
    error instanceof DuplicateProductSlugError ||
    error instanceof DuplicateProductSkuError ||
    error instanceof ProductCategoryNotFoundError ||
    error instanceof IllegalProductStatusTransitionError ||
    error instanceof InvalidSizeChartFieldsError
  );
}

function describeWriteFailure(error: unknown): string {
  if (error instanceof RowWriteError)
    return `row ${error.row}: ${error.message}`;
  const detail = error instanceof Error ? error.message : "a conflict";
  return `a row conflicted with the catalog while writing (${detail}); nothing was applied.`;
}

export { FULL_DIAGNOSTICS_ROW_LIMIT };
