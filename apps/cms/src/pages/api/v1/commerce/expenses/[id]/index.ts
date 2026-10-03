/**
 * `GET|PATCH /api/v1/commerce/expenses/{id}` — one expense (Issue #294, ADR-0031).
 * `GET` is `commerce.expenses.read`; `PATCH` (`commerce.expenses.update`) edits a
 * DRAFT only (`409 EXPENSE_NOT_DRAFT` otherwise): the posted / pending content
 * is frozen, mechanically (`sql/990`'s guard trigger) as well as here. Employee
 * scope: only the draft's creator, or a supervisor (a caller who also holds
 * `commerce.expense_postings.approve`, checked here through the access
 * chokepoint only when needed), may change it (`403 NOT_EXPENSE_OWNER`). An
 * unknown id and another tenant's id are the same `404`. The receipt is never in
 * the body - only `hasReceipt`; it is reachable through its own gated route.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { authorizeInTransaction } from "../../../../../../modules/identity-access/application/access-guard";
import {
  fetchExpense,
  updateExpenseDraft
} from "../../../../../../modules/commerce/application/expense-directory";
import {
  expenseRefusalResponse,
  readValidatedBody,
  requireExpenseFeature,
  requireRegisterFeatureForExpense
} from "../../../../../../modules/commerce/application/expense-http";
import {
  validateUpdateExpenseInput,
  type UpdateExpenseInput
} from "../../../../../../modules/commerce/domain/expense";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import {
  COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
  COMMERCE_EXPENSES_ACTIVITY_CODE
} from "../../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSES_ACTIVITY_CODE,
  action: "read"
} as const;

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

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Expense not found.");
    }
    const expense = await fetchExpense(tx, tenantId, params.id);
    return expense
      ? ok(expense)
      : fail(404, "RESOURCE_NOT_FOUND", "Expense not found.");
  }
});

export const PATCH = defineTenantRoute<UpdateExpenseInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, (body) => validateUpdateExpenseInput(body)),
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
    if (typeof prepared.registerSessionId === "string") {
      const registerGate = await requireRegisterFeatureForExpense(tx, tenantId);
      if (registerGate) return registerGate;
    }
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Expense not found.");
    }
    const outcome = await updateExpenseDraft(
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
            SUPERVISOR_GUARD
          )
        ).allowed,
      locals.correlationId
    );
    return (
      expenseRefusalResponse(outcome) ??
      ok((outcome as { expense: unknown }).expense)
    );
  }
});
