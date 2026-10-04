/**
 * `POST /api/v1/commerce/stored-value/reconcile` — compare every account's
 * projected balance with its ledger, the ledger with itself, and every
 * redemption with its payment-allocation leg (Issue #288, ADR-0030). Body
 * `{ "repair": false }` (default) is READ-ONLY and needs only
 * `commerce.stored_value.read`; `{ "repair": true }` additionally needs
 * `commerce.stored_value_reconcile.approve` (a high-risk verb: it rewrites a
 * projection) and rebuilds ONLY the `balance`/`version` of drifted accounts,
 * under the account lock, auditing each. A ledger that contradicts itself, a
 * status that disagrees with its entries and an unmatched redemption are
 * REPORTED and never repaired. Gated on the `storedValue` feature.
 */
import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { authorizeInTransaction } from "../../../../../modules/identity-access/application/access-guard";
import { reconcileStoredValue } from "../../../../../modules/commerce/application/stored-value-directory";
import { readValidatedBody } from "../../../../../modules/commerce/application/register-http";
import { requireStoredValueFeature } from "../../../../../modules/commerce/application/stored-value-http";
import {
  COMMERCE_STORED_VALUE_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_RECONCILE_ACTIVITY_CODE
} from "../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateReconcileInput,
  type ReconcileInput
} from "../../../../../modules/commerce/domain/stored-value";

const REPAIR_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_STORED_VALUE_RECONCILE_ACTIVITY_CODE,
  action: "approve"
} as const;

export const POST = defineTenantRoute<ReconcileInput>({
  workClass: "interactive",
  prepare: ({ request }) => readValidatedBody(request, validateReconcileInput),
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, auth, prepared, locals, tokenHash, now }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    if (prepared.repair) {
      const repairAuth = await authorizeInTransaction(
        tx,
        tenantId,
        tokenHash,
        now,
        REPAIR_GUARD
      );
      if (!repairAuth.allowed) return repairAuth.denied;
    }
    return ok(
      await reconcileStoredValue(tx, tenantId, {
        repair: prepared.repair,
        actor: { kind: "tenant_user", tenantUserId: auth.context.tenantUserId },
        correlationId: locals.correlationId
      })
    );
  }
});
