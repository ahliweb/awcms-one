import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import {
  fetchAffiliateCommissionRate,
  fetchStoreSettings,
  toPublicRecord
} from "../../../../../modules/commerce/application/store-settings-directory";
import { COMMERCE_SETTINGS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { isShippingRateProviderConfigured } from "../../../../../modules/commerce/infrastructure/shipping-rate-provider-resolver";
import { isPaymentGatewayProviderConfigured } from "../../../../../modules/commerce/infrastructure/payment-gateway-provider-resolver";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SETTINGS_ACTIVITY_CODE,
  action: "read"
} as const;

/**
 * `GET /api/v1/commerce/store-settings/public` — the storefront's identity/
 * shipping/payment-availability read model (contract:
 * `commerce-public-read-models.md`). Bank account numbers, account holder
 * names, and the QRIS media id NEVER cross into this shape —
 * `toPublicRecord` strips them before this route ever sees them.
 */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId }) => {
    const [settings, affiliateCommissionRate] = await Promise.all([
      fetchStoreSettings(tx, tenantId),
      fetchAffiliateCommissionRate(tx, tenantId)
    ]);
    return ok(
      await toPublicRecord(
        tx,
        tenantId,
        settings,
        mediaLibraryPortAdapter,
        affiliateCommissionRate !== null,
        isShippingRateProviderConfigured(),
        isPaymentGatewayProviderConfigured()
      )
    );
  }
});
