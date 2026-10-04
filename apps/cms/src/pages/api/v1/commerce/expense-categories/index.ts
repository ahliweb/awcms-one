/**
 * `GET|POST /api/v1/commerce/expense-categories` — expense categories (Issue
 * #294, epic #281, ADR-0031). `GET` (`commerce.expense_categories.read`) lists
 * the tenant's categories; `POST` (`commerce.expense_categories.create`)
 * defines one (`code` unique per tenant, case-insensitively). Both are gated on
 * the tenant's `expenses` feature (`409 FEATURE_DISABLED` while it is off).
 */
import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  createExpenseCategory,
  listExpenseCategories
} from "../../../../../modules/commerce/application/expense-category-directory";
import {
  readValidatedBody,
  requireExpenseFeature
} from "../../../../../modules/commerce/application/expense-http";
import {
  validateCreateExpenseCategoryInput,
  type CreateExpenseCategoryInput
} from "../../../../../modules/commerce/domain/expense";
import { COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE,
  action: "create"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, url }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    const includeInactive = url.searchParams.get("includeInactive") !== "false";
    return ok({
      items: await listExpenseCategories(tx, tenantId, { includeInactive })
    });
  }
});

export const POST = defineTenantRoute<CreateExpenseCategoryInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateCreateExpenseCategoryInput),
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    const outcome = await createExpenseCategory(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared,
      locals.correlationId
    );
    if (outcome.kind === "code_taken") {
      return fail(
        409,
        "EXPENSE_CATEGORY_CODE_TAKEN",
        "An expense category with this code already exists."
      );
    }
    return created(outcome.category);
  }
});
