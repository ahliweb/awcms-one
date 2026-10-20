/**
 * `GET|PUT /api/v1/commerce/products/{id}/deposit-policy` - a product's deposit
 * policy (Issue #378, ADR-0045 D5, ADR-0041 D4, owner answer Q2).
 *
 * `GET` (`commerce.booking_deposit_policies.read`) returns the active policy
 * (`null` = the product is paid in full) and the mirrored `allowDp` flag. `PUT`
 * (`commerce.booking_deposit_policies.update`) sets, replaces or removes it:
 * `{ "kind": "percent", "percent": "30.00" }` (a share of the line's taxed
 * total), `{ "kind": "fixed", "fixedAmount": "50000.00" }` (per unit of
 * quantity - per night for a nightly product) or `{ "kind": "full" }` (no
 * deposit: retires the policy). The same write keeps `allow_dp` in step. A
 * body naming an `amount` or `price` is a `400`. There is no tenant default and
 * no delete. An unknown id and another tenant's id are the same `404`. Both
 * methods are gated on the tenant's `booking` feature (`409 FEATURE_DISABLED`
 * while off). `PUT` is state-setting and naturally idempotent, so it takes no
 * `Idempotency-Key`.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  readValidatedBody,
  requireBookingFeature
} from "../../../../../../modules/commerce/application/booking-adapter-http";
import {
  fetchProductDepositPolicy,
  setProductDepositPolicy
} from "../../../../../../modules/commerce/application/booking-deposit-policies";
import {
  validateSetDepositPolicyInput,
  type SetDepositPolicyInput
} from "../../../../../../modules/commerce/domain/booking-adapter";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_BOOKING_DEPOSIT_POLICIES_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/booking-adapter-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_DEPOSIT_POLICIES_ACTIVITY_CODE,
  action: "read"
} as const;

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_DEPOSIT_POLICIES_ACTIVITY_CODE,
  action: "update"
} as const;

const notFound = (): Response =>
  fail(404, "RESOURCE_NOT_FOUND", "Product not found.");

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) return notFound();
    const result = await fetchProductDepositPolicy(tx, tenantId, params.id);
    return result ? ok(result) : notFound();
  }
});

export const PUT = defineTenantRoute<SetDepositPolicyInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateSetDepositPolicyInput),
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) return notFound();
    const outcome = await setProductDepositPolicy(
      tx,
      tenantId,
      auth.context.tenantUserId,
      params.id,
      prepared,
      locals.correlationId
    );
    if (outcome.kind === "product_not_found") return notFound();
    return ok(outcome.result);
  }
});
