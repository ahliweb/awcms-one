/**
 * `POST /api/v1/commerce/expenses/{id}/reverse` — reverse a POSTED expense with
 * a compensating entry (Issue #294, ADR-0031). Gated on
 * `commerce.expense_reversals.approve` (a high-risk verb); requires
 * `Idempotency-Key` and a `reason`. A drawer-paid expense appends a
 * `correction` cash-IN movement for the same amount - to its own session when
 * still open, else to the open session of the same register - and never edits
 * the original movement or a closed cash-up; with no open session on the
 * register it is refused (`409 REGISTER_SESSION_REQUIRED`) rather than
 * silently skipping the drawer. A reversed expense is terminal.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { reverseExpense } from "../../../../../../modules/commerce/application/expense-posting";
import {
  expenseRefusalResponse,
  idempotencyErrorResponse,
  readValidatedBody,
  requireExpenseFeature,
  requireIdempotencyKey
} from "../../../../../../modules/commerce/application/expense-http";
import {
  validateReverseExpenseInput,
  type ReverseExpenseInput
} from "../../../../../../modules/commerce/domain/expense";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_EXPENSE_REVERSALS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const APPROVE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_REVERSALS_ACTIVITY_CODE,
  action: "approve"
} as const;

export const POST = defineTenantRoute<ReverseExpenseInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateReverseExpenseInput(body, key.key)
    );
  },
  authorize: APPROVE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Expense not found.");
    }
    try {
      const outcome = await reverseExpense(
        tx,
        tenantId,
        auth.context.tenantUserId,
        params.id,
        prepared,
        locals.correlationId
      );
      return (
        expenseRefusalResponse(outcome) ??
        ok((outcome as { result: unknown }).result)
      );
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
