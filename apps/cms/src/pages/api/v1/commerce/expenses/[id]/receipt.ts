/**
 * `POST /api/v1/commerce/expenses/{id}/receipt` — attach a PRIVATE receipt to an
 * expense (Issue #294, ADR-0031). Gated on `commerce.expense_receipts.create`.
 * Body `{ mediaObjectId }` - a verified `visibility: "private"` media-library
 * object the CALLER uploaded (upload it through the media upload-session API
 * with `visibility: "private"`). Refusals: a public object, someone else's
 * upload or an unverified one is `409 EXPENSE_RECEIPT_NOT_ELIGIBLE`; an object
 * already used as a receipt or as a product's protected download is
 * `409 EXPENSE_RECEIPT_ALREADY_USED`; a posted expense already holding a
 * receipt is `409 EXPENSE_RECEIPT_ALREADY_ATTACHED` (a posted expense accepts one
 * once and never replaces it). Employee scope on a draft: its creator or a
 * supervisor. The attached object is never returned - read it through
 * `.../receipt-url`.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { authorizeInTransaction } from "../../../../../../modules/identity-access/application/access-guard";
import { attachExpenseReceipt } from "../../../../../../modules/commerce/application/expense-directory";
import {
  expenseRefusalResponse,
  readValidatedBody,
  requireExpenseFeature
} from "../../../../../../modules/commerce/application/expense-http";
import {
  validateAttachReceiptInput,
  type AttachReceiptInput
} from "../../../../../../modules/commerce/domain/expense";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import {
  COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
  COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE
} from "../../../../../../modules/commerce/domain/commerce-permissions";

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE,
  action: "create"
} as const;

const SUPERVISOR_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
  action: "approve"
} as const;

export const POST = defineTenantRoute<AttachReceiptInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateAttachReceiptInput),
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
    const outcome = await attachExpenseReceipt(
      tx,
      tenantId,
      auth.context.tenantUserId,
      params.id,
      prepared.mediaObjectId,
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
