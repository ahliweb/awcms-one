import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../modules/commerce/application/commerce-feature-gate";
import {
  clearRedemptionSettings,
  fetchRedemptionSettings,
  saveRedemptionSettings
} from "../../../../../modules/commerce/application/loyalty-redemption";
import { COMMERCE_LOYALTY_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateRedemptionSettingsInput,
  type RedemptionSettingsInput
} from "../../../../../modules/commerce/domain/loyalty-redemption";

/**
 * `GET|PUT|DELETE /api/v1/commerce/loyalty/redemption-settings` (Issue #363,
 * ADR-0043, owner answer Q6) - the tenant's point value (whole rupiah per
 * point) and the optional cap on the share of the goods subtotal payable in
 * points. There is NO default: until a tenant `PUT`s a value, redemption is
 * unavailable, and `GET` answers `{ settings: null }`. `DELETE` removes the
 * value again. A change affects only orders created afterwards.
 *
 * Reading needs `commerce.loyalty.read`; changing needs `commerce.loyalty.manage`
 * (a high-risk action: it sets what a point is worth in money). All three are
 * gated by the tenant's `loyalty` feature (`409 FEATURE_DISABLED`); the separate
 * `loyaltyRedemption` toggle decides whether the value is honoured at checkout,
 * so a tenant can prepare the value before turning spending on.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
  action: "read"
} as const;

const MANAGE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
  action: "manage"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    return ok({ settings: await fetchRedemptionSettings(tx, tenantId) });
  }
});

export const PUT = defineTenantRoute<RedemptionSettingsInput>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<RedemptionSettingsInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateRedemptionSettingsInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Redemption settings are invalid.",
        {},
        validation.errors
      );
    }
    return validation.value;
  },
  authorize: MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    return ok({
      settings: await saveRedemptionSettings(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      )
    });
  }
});

export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, locals }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    const removed = await clearRedemptionSettings(
      tx,
      tenantId,
      auth.context.tenantUserId,
      locals.correlationId
    );
    return ok({ removed });
  }
});
