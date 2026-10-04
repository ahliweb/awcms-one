/**
 * `POST /api/v1/commerce/expenses/{id}/cancel` — discard a DRAFT expense (Issue
 * #294, ADR-0031). Gated on `commerce.expenses.update`; requires
 * `Idempotency-Key`. Terminal (`cancelled`); only a draft can be discarded
 * (`409 EXPENSE_NOT_DRAFT` - a posted expense is reversed, never deleted), and
 * only by its creator or a supervisor (`403 NOT_EXPENSE_OWNER`).
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { authorizeInTransaction } from "../../../../../../modules/identity-access/application/access-guard";
import { cancelExpenseDraft } from "../../../../../../modules/commerce/application/expense-directory";
import {
  expenseRefusalResponse,
  idempotencyErrorResponse,
  readValidatedBody,
  requireExpenseFeature,
  requireIdempotencyKey
} from "../../../../../../modules/commerce/application/expense-http";
import {
  validateKeyedInput,
  type KeyedInput
} from "../../../../../../modules/commerce/domain/expense";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import {
  COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
  COMMERCE_EXPENSES_ACTIVITY_CODE
} from "../../../../../../modules/commerce/domain/commerce-permissions";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSES_ACTIVITY_CODE,
  action: "update"
} as const;

const SUPERVISOR_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
  action: "approve"
} as const;

export const POST = defineTenantRoute<KeyedInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, () => validateKeyedInput(key.key));
  },
  authorize: UPDATE_GUARD,
  handler: async ({
    tx,
    tenantId,
    auth,
    params,
    prepared,
    locals,
    tokenHash,
    now
  }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Expense not found.");
    }
    try {
      const outcome = await cancelExpenseDraft(
        tx,
        tenantId,
        auth.context.tenantUserId,
        params.id,
        prepared.idempotencyKey,
        async () =>
          (
            await authorizeInTransaction(
              tx,
              tenantId,
              tokenHash,
              now,
              SUPERVISOR_GUARD
            )
          ).allowed,
        locals.correlationId
      );
      return (
        expenseRefusalResponse(outcome) ??
        ok((outcome as { expense: unknown }).expense)
      );
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
