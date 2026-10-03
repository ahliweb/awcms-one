/**
 * Expense categories (Issue #294, ADR-0031) - the small CRUD half of the
 * expense model: a category is a `code` (unique per tenant, case-insensitively),
 * a `name` and an `active` flag. It is never deleted: it is deactivated,
 * because the expenses that used it are fiscal records that keep pointing at it.
 * A deactivated category accepts no NEW expense (checked when a draft is created,
 * edited and posted) but its history stays readable.
 *
 * Tenant isolation: every query filters on `tenant_id` explicitly on top of
 * RLS, and an id from another tenant resolves to nothing, exactly like an
 * unknown id (no BOLA oracle).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import type {
  CreateExpenseCategoryInput,
  UpdateExpenseCategoryInput
} from "../domain/expense";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "expense_category";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const CODE_CONSTRAINT = "awcms_commerce_expense_categories_tenant_code_key";

export const EXPENSE_CATEGORY_LIST_LIMIT = 200;

export type ExpenseCategoryRecord = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type CategoryRow = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = "id, code, name, active, created_at, updated_at";

function toRecord(row: CategoryRow): ExpenseCategoryRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

/** Categories, active first then by code. */
export async function listExpenseCategories(
  tx: Bun.SQL,
  tenantId: string,
  options: { includeInactive?: boolean } = {}
): Promise<ExpenseCategoryRecord[]> {
  const includeInactive = options.includeInactive ?? true;
  const rows = (await tx`
    SELECT ${tx.unsafe(COLUMNS)}
    FROM awcms_commerce_expense_categories
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (${includeInactive}::boolean OR active)
    ORDER BY active DESC, lower(code) ASC, id ASC
    LIMIT ${EXPENSE_CATEGORY_LIST_LIMIT}
  `) as CategoryRow[];
  return rows.map(toRecord);
}

export async function fetchExpenseCategory(
  tx: Bun.SQL,
  tenantId: string,
  categoryId: string
): Promise<ExpenseCategoryRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(COLUMNS)}
    FROM awcms_commerce_expense_categories
    WHERE tenant_id = ${tenantId} AND id = ${categoryId} AND deleted_at IS NULL
  `) as CategoryRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export type CreateExpenseCategoryOutcome =
  { kind: "created"; category: ExpenseCategoryRecord } | { kind: "code_taken" };

export async function createExpenseCategory(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateExpenseCategoryInput,
  correlationId?: string
): Promise<CreateExpenseCategoryOutcome> {
  let id: string;
  try {
    const rows = (await tx`
      INSERT INTO awcms_commerce_expense_categories (
        tenant_id, code, name, created_by_tenant_user_id, updated_by_tenant_user_id
      )
      VALUES (${tenantId}, ${input.code}, ${input.name}, ${actorTenantUserId}, ${actorTenantUserId})
      RETURNING id
    `) as { id: string }[];
    id = rows[0]!.id;
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === CODE_CONSTRAINT
    ) {
      return { kind: "code_taken" };
    }
    throw error;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "expense_category.create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: id,
    message: `Expense category ${input.code} defined.`,
    attributes: { code: input.code },
    correlationId
  });

  return {
    kind: "created",
    category: (await fetchExpenseCategory(tx, tenantId, id))!
  };
}

export type UpdateExpenseCategoryOutcome =
  { kind: "not_found" } | { kind: "updated"; category: ExpenseCategoryRecord };

export async function updateExpenseCategory(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  categoryId: string,
  input: UpdateExpenseCategoryInput,
  correlationId?: string
): Promise<UpdateExpenseCategoryOutcome> {
  const locked = (await tx`
    SELECT id, code, name, active
    FROM awcms_commerce_expense_categories
    WHERE tenant_id = ${tenantId} AND id = ${categoryId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as { id: string; code: string; name: string; active: boolean }[];
  const current = locked[0];
  if (!current) return { kind: "not_found" };

  const name = input.name ?? current.name;
  const active = input.active ?? current.active;
  await tx`
    UPDATE awcms_commerce_expense_categories
    SET name = ${name}, active = ${active},
        updated_by_tenant_user_id = ${actorTenantUserId}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${categoryId}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "expense_category.update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: categoryId,
    message: `Expense category ${current.code} updated.`,
    attributes: {
      code: current.code,
      nameChanged: name !== current.name,
      active
    },
    correlationId
  });

  return {
    kind: "updated",
    category: (await fetchExpenseCategory(tx, tenantId, categoryId))!
  };
}
