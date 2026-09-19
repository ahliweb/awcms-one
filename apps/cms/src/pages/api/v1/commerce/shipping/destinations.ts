import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { COMMERCE_SETTINGS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { resolveShippingRateProvider } from "../../../../../modules/commerce/infrastructure/shipping-rate-provider-resolver";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../modules/commerce/application/commerce-feature-gate";

/**
 * `GET /api/v1/commerce/shipping/destinations?search=` (Issue #107, contract
 * #106's D4) — owner-only, behind the same permission the store-settings
 * `PUT` already requires (`commerce.settings.update`, the real permission
 * key this codebase's `commerce-permissions.ts` seeds for the `settings`
 * singleton — the issue's own prose names it `store_settings.update`, same
 * resource). Backs the admin origin-destination picker in
 * `commerce-settings.astro`'s courier section: an owner types their store's
 * city/subdistrict name and picks the provider's own destination id to save
 * as `shipping.courier.originDestinationId`.
 *
 * A deliberate, scoped exception to "never call a provider inside a DB
 * transaction" (ADR-0006/0010): `defineTenantRoute`'s handler always runs
 * inside the tenant's own transaction, and this is a low-volume,
 * admin-only, on-demand lookup with no cache read/write around it (unlike
 * `application/shipping-rate-directory.ts`'s `resolveDestination`, which
 * DOES enforce the no-provider-in-tx rule because it runs on the hot
 * storefront quote path). Held open only for the single provider round
 * trip, never inside a write.
 */
export const GET = defineTenantRoute<{ search: string }>({
  workClass: "interactive",
  prepare: ({ url }) => {
    const search = (url.searchParams.get("search") ?? "").trim();
    if (search.length === 0) {
      return fail(400, "VALIDATION_ERROR", "search is required.", {}, [
        { field: "search", message: "search is required." }
      ]);
    }
    return { search: search.slice(0, 200) };
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_SETTINGS_ACTIVITY_CODE,
    action: "update"
  },
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "courier"
    );
    if (gate) return gate;

    const provider = resolveShippingRateProvider();
    if (!provider) {
      return fail(
        503,
        "PROVIDER_UNAVAILABLE",
        "No courier rate provider is configured for this deployment."
      );
    }

    const candidates = await provider.searchDestination(prepared.search);
    return ok({
      items: candidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        provinceName: candidate.provinceName,
        cityName: candidate.cityName,
        districtName: candidate.districtName,
        subdistrictName: candidate.subdistrictName,
        zipCode: candidate.zipCode
      }))
    });
  }
});
