/**
 * `POST /api/v1/commerce/stored-value/expire` — release the balance of every
 * lapsed account (Issue #288, ADR-0029): one `expire` ledger entry per account
 * past its expiry, bounded to one batch (`more: true` = call again). Idempotent
 * by construction (the entry's source key is the account and its expiry
 * instant), so it needs no `Idempotency-Key`. The application never WAITS for
 * this: an account about to be used is settled first, so a lapsed balance can
 * never be spent however rarely this runs — it exists so the books stop
 * showing lapsed value as outstanding. Gated on `commerce.stored_value.update`
 * and the `storedValue` feature.
 */
import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { sweepExpiredStoredValue } from "../../../../../modules/commerce/application/stored-value-directory";
import { requireStoredValueFeature } from "../../../../../modules/commerce/application/stored-value-http";
import { COMMERCE_STORED_VALUE_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

export const POST = defineTenantRoute({
  workClass: "interactive",
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
    action: "update"
  },
  handler: async ({ tx, tenantId, locals }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    return ok(
      await sweepExpiredStoredValue(tx, tenantId, locals.correlationId)
    );
  }
});
