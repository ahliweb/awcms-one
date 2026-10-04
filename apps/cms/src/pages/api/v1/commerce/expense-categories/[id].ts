/**
 * `GET|PATCH /api/v1/commerce/expense-categories/{id}` — one expense category
 * (Issue #294, ADR-0031). `GET` is `commerce.expense_categories.read`; `PATCH`
 * (`commerce.expense_categories.update`) renames or (de)activates it - a
 * deactivated category accepts no NEW expense but its history stays readable.
 * The `code` never changes. An unknown id and another tenant's id are the same
 * `404`.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  fetchExpenseCategory,
  updateExpenseCategory
} from "../../../../../modules/commerce/application/expense-category-directory";
import {
  readValidatedBody,
  requireExpenseFeature
} from "../../../../../modules/commerce/application/expense-http";
import {
  validateUpdateExpenseCategoryInput,
  type UpdateExpenseCategoryInput
} from "../../../../../modules/commerce/domain/expense";
import { isUuid } from "../../../../../modules/commerce/domain/register";
import { COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE,
  action: "read"
} as const;

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE,
  action: "update"
} as const;

const NOT_FOUND = () =>
  fail(404, "RESOURCE_NOT_FOUND", "Expense category not found.");

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) return NOT_FOUND();
    const category = await fetchExpenseCategory(tx, tenantId, params.id);
    return category ? ok(category) : NOT_FOUND();
  }
});

export const PATCH = defineTenantRoute<UpdateExpenseCategoryInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateUpdateExpenseCategoryInput),
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) return NOT_FOUND();
    const outcome = await updateExpenseCategory(
      tx,
      tenantId,
      auth.context.tenantUserId,
      params.id,
      prepared,
      locals.correlationId
    );
    return outcome.kind === "not_found" ? NOT_FOUND() : ok(outcome.category);
  }
});
