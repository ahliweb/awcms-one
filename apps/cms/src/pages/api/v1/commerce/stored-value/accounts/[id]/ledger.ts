/**
 * `GET /api/v1/commerce/stored-value/accounts/{id}/ledger` — an account's
 * append-only history, newest first, keyset-paginated on the per-account
 * sequence (`?before=<account_seq>`) (Issue #288, ADR-0030). Every entry shows
 * its kind, signed amount, running balance and the order/payment it mirrors
 * (`allocationId`), never the code. Gated on `commerce.stored_value.read` and
 * the `storedValue` feature; an unknown or other-tenant account is the same
 * `404`.
 */
import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { listStoredValueLedger } from "../../../../../../../modules/commerce/application/stored-value-directory";
import { requireStoredValueFeature } from "../../../../../../../modules/commerce/application/stored-value-http";
import { COMMERCE_STORED_VALUE_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";
import { isUuid } from "../../../../../../../modules/commerce/domain/stored-value";

export const GET = defineTenantRoute<number | null>({
  workClass: "interactive",
  prepare: ({ url }) => {
    const before = url.searchParams.get("before");
    if (before === null || before === "") return null;
    if (!/^\d{1,15}$/.test(before)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "before must be a positive integer."
      );
    }
    return Number(before);
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, params, prepared }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Account not found.");
    }
    const page = await listStoredValueLedger(tx, tenantId, params.id, prepared);
    if (!page) return fail(404, "RESOURCE_NOT_FOUND", "Account not found.");
    return ok(page);
  }
});
