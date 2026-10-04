/**
 * `POST /api/v1/commerce/expenses/{id}/post` — submit a draft expense for
 * posting (Issue #294, ADR-0031). Gated on `commerce.expense_postings.create`;
 * requires `Idempotency-Key`; idempotent and concurrency-safe (the expense row
 * is locked first, a replay returns the stored answer).
 *
 * Within the tenant's `expenses.approvalThreshold` the expense is posted
 * outright (`outcome: "posted"`); above it, a caller who ALSO holds
 * `commerce.expense_postings.approve` (checked here, through the same
 * chokepoint, only when needed) AND did not create the expense posts it in one
 * step, and anyone else leaves it `pending_approval` for a second person
 * (`.../decision`). Posting a drawer-paid expense appends a register `expense`
 * cash-out movement to the expense's session (`409 REGISTER_SESSION_NOT_OPEN`
 * when it is not open) - it never edits a cash-up total.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { authorizeInTransaction } from "../../../../../../modules/identity-access/application/access-guard";
import { postExpense } from "../../../../../../modules/commerce/application/expense-posting";
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
import { COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
  action: "create"
} as const;

const APPROVE_GUARD = {
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
  authorize: CREATE_GUARD,
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
      const outcome = await postExpense(
        tx,
        tenantId,
        auth.context.tenantUserId,
        params.id,
        prepared,
        async () =>
          (
            await authorizeInTransaction(
              tx,
              tenantId,
              tokenHash,
              now,
              APPROVE_GUARD
            )
          ).allowed,
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
