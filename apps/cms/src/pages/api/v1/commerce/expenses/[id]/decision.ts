/**
 * `POST /api/v1/commerce/expenses/{id}/decision` — approve or reject a
 * `pending_approval` expense (Issue #294, ADR-0031). Gated on
 * `commerce.expense_postings.approve` (a high-risk verb, so a tenant may author
 * SoD rules against it); requires `Idempotency-Key`. Segregation of duties is
 * enforced here as well as by schema: an expense cannot be approved by the
 * person who created it or by the person who submitted it
 * (`403 SEGREGATION_OF_DUTIES`). Approving posts it - a drawer-paid expense
 * appends its register `expense` cash-out movement, with the APPROVER as the
 * movement's actor (`409 REGISTER_SESSION_NOT_OPEN` when its session is no
 * longer open; the expense then stays pending). Rejecting needs a `note` and
 * returns the expense to `draft`.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { decideExpense } from "../../../../../../modules/commerce/application/expense-posting";
import {
  expenseRefusalResponse,
  idempotencyErrorResponse,
  readValidatedBody,
  requireExpenseFeature,
  requireIdempotencyKey
} from "../../../../../../modules/commerce/application/expense-http";
import {
  validateExpenseDecisionInput,
  type ExpenseDecisionInput
} from "../../../../../../modules/commerce/domain/expense";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const APPROVE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
  action: "approve"
} as const;

export const POST = defineTenantRoute<ExpenseDecisionInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateExpenseDecisionInput(body, key.key)
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
      const outcome = await decideExpense(
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
