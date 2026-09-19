/**
 * Feature toggles per tenant (Issue #118, epic #33 C9, contract #106 D10) —
 * BjekMart's "Features" screen is `commerce`'s own `module.ts`
 * `settings.defaults.features`, read through
 * `module-management/application/module-settings.ts`'s
 * `fetchModuleSettingsView`. Pure — no database, no I/O — so it is trivially
 * unit-testable and safe to call from both the owner-side route guards and
 * the public store-settings composition.
 *
 * ## The 409-vs-404 rule (documented once, applied everywhere)
 *
 * A disabled feature answers:
 * - `409 FEATURE_DISABLED` on every AUTHENTICATED owner (staff) route — the
 *   caller already proved who they are and already has the permission for
 *   the resource; the fact blocking them is "this tenant turned the feature
 *   off", a conflict with the tenant's own configuration, not a missing
 *   permission (403) or a missing resource (404). The tenant staff member
 *   NEEDS to see this reason (it points them at the settings screen).
 * - `404` (the same neutral shape every other unresolvable-tenant/disabled-
 *   module case on the public/storefront surface already answers) on every
 *   ANONYMOUS/public route — `application/public-commerce-tenant.ts`'s own
 *   rule is "never reveal to an anonymous caller whether a tenant/module
 *   exists"; a disabled COMMERCE FEATURE is the same class of fact. Telling
 *   an anonymous prober "this route exists but is disabled" (409) would leak
 *   more than the neutral 404 the rest of that surface already commits to.
 *
 * `assertFeatureEnabled` throws one typed error regardless of caller kind;
 * each route decides which of the two responses to render (there is no
 * shared HTTP helper here — `_shared/api-response.ts`'s `fail()` already
 * differs enough between an authenticated JSON error body and the
 * public surface's neutral, CORS-headpresent 404 that forcing one wrapper
 * over both would be the false abstraction, not the shared one).
 */

/** Every togglable commerce feature, contract #106 D10's own five. `pos` has no route/screen wired to it YET (issue #116, landing in parallel) — the default exists so the settings document has a stable shape from day one and #116's own gate has nothing left to add here. */
export type CommerceFeatureKey =
  "pos" | "inbox" | "campaigns" | "gateway" | "courier";

export type CommerceFeatures = Readonly<Record<CommerceFeatureKey, boolean>>;

/**
 * Default-ON for every feature — turning a feature toggle ON by default
 * means shipping this settings document changes NOTHING for an existing
 * tenant that never opens the new "Fitur" section, matching this repo's
 * "migration-free upgrade" convention (`store-settings-validation.ts`'s own
 * `buildDefaultStoreSettings` follows the same "off/on default preserves
 * today's behaviour" rule for every OTHER settings default it defines).
 */
export const DEFAULT_COMMERCE_FEATURES: CommerceFeatures = {
  pos: true,
  inbox: true,
  campaigns: true,
  gateway: true,
  courier: true
};

const FEATURE_KEYS: readonly CommerceFeatureKey[] = [
  "pos",
  "inbox",
  "campaigns",
  "gateway",
  "courier"
];

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Resolves the EFFECTIVE feature flags from a `commerce` module settings
 * view's `effective.features` (i.e. AFTER `mergeEffectiveSettings` already
 * layered the tenant's override on top of `module.ts`'s defaults) — or from
 * any other object shaped like it (a raw stored `settings.features`, a test
 * fixture, …).
 *
 * This is the SECOND layer of the migration-free upgrade path, one level
 * below `mergeEffectiveSettings`'s own shallow top-level merge: that merge
 * only guarantees a `features` key exists once ANY tenant override is
 * present (a shallow merge REPLACES the whole `features` object the moment a
 * tenant patches even one flag in it — see `module-settings.ts`'s own
 * header). A tenant who saved a settings row before this issue shipped a new
 * sixth flag would otherwise read that new flag as `undefined`, not as its
 * documented default. Resolving every key here, individually, against
 * {@link DEFAULT_COMMERCE_FEATURES} closes that gap for good — a future
 * flag added to the union only needs a default here, never a data migration
 * for tenants who already saved a settings row.
 */
export function resolveCommerceFeatures(
  effectiveSettings: Record<string, unknown> | null | undefined
): CommerceFeatures {
  const raw = effectiveSettings?.features;
  const rawFeatures =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const resolved = {} as Record<CommerceFeatureKey, boolean>;
  for (const key of FEATURE_KEYS) {
    const value = rawFeatures[key];
    resolved[key] = isBoolean(value) ? value : DEFAULT_COMMERCE_FEATURES[key];
  }
  return resolved;
}

export function isCommerceFeatureEnabled(
  features: CommerceFeatures,
  feature: CommerceFeatureKey
): boolean {
  return features[feature];
}

/** Thrown by {@link assertFeatureEnabled}; each route maps it to `409 FEATURE_DISABLED` (owner) or a neutral `404` (public/storefront) per this file's own header rule. */
export class FeatureDisabledError extends Error {
  readonly feature: CommerceFeatureKey;

  constructor(feature: CommerceFeatureKey) {
    super(`Commerce feature "${feature}" is disabled for this tenant.`);
    this.name = "FeatureDisabledError";
    this.feature = feature;
  }
}

export function assertFeatureEnabled(
  features: CommerceFeatures,
  feature: CommerceFeatureKey
): void {
  if (!features[feature]) {
    throw new FeatureDisabledError(feature);
  }
}
