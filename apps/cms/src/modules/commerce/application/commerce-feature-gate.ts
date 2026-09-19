/**
 * The one call every route guarding an inbox/campaigns/gateway/courier path
 * makes (Issue #118) — reads this tenant's CURRENT effective `commerce`
 * module settings and resolves the feature flags `domain/commerce-features.ts`
 * defines. A thin application-layer wrapper over
 * `module-management/application/module-settings.ts`'s `fetchModuleSettingsView`
 * so every call site imports one thing rather than wiring the module-key
 * string and the settings-view shape itself each time.
 */
import { fail } from "../../_shared/api-response";
import { fetchModuleSettingsView } from "../../module-management/application/module-settings";
import {
  assertFeatureEnabled,
  FeatureDisabledError,
  resolveCommerceFeatures,
  type CommerceFeatureKey,
  type CommerceFeatures
} from "../domain/commerce-features";

const COMMERCE_MODULE_KEY = "commerce";

export async function fetchCommerceFeatures(
  tx: Bun.SQL,
  tenantId: string
): Promise<CommerceFeatures> {
  const view = await fetchModuleSettingsView(tx, tenantId, COMMERCE_MODULE_KEY);
  return resolveCommerceFeatures(view?.effective);
}

/**
 * The one-liner every AUTHENTICATED owner route calls right after its
 * `authorize` guard passes: `null` when the feature is on, a ready-to-return
 * `409 FEATURE_DISABLED` `Response` when it is not. See
 * `domain/commerce-features.ts`'s header for why this is `409` here and a
 * neutral `404` on the public/storefront side ({@link
 * requireCommerceFeatureForPublicRoute}).
 */
export async function requireCommerceFeatureForOwnerRoute(
  tx: Bun.SQL,
  tenantId: string,
  feature: CommerceFeatureKey
): Promise<Response | null> {
  const features = await fetchCommerceFeatures(tx, tenantId);
  try {
    assertFeatureEnabled(features, feature);
    return null;
  } catch (error) {
    if (error instanceof FeatureDisabledError) {
      return fail(
        409,
        "FEATURE_DISABLED",
        `The "${error.feature}" feature is disabled for this tenant.`
      );
    }
    throw error;
  }
}

/**
 * The public/storefront counterpart — `notFound` is the caller's own neutral
 * 404 builder (each surface already has one, with its own CORS/`Vary`
 * headers: `public-commerce-tenant.ts`'s callers, the webhook intake route's
 * own shape, …), so this never hard-codes a response shape a public route
 * would then have to override.
 */
export async function requireCommerceFeatureForPublicRoute(
  tx: Bun.SQL,
  tenantId: string,
  feature: CommerceFeatureKey,
  notFound: () => Response
): Promise<Response | null> {
  const features = await fetchCommerceFeatures(tx, tenantId);
  return features[feature] ? null : notFound();
}
