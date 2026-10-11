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
  | "pos"
  | "inbox"
  | "campaigns"
  | "gateway"
  | "courier"
  | "register"
  | "documents"
  | "loyalty"
  | "loyaltyRedemption"
  | "storedValue"
  | "expenses"
  | "documentDelivery"
  | "barcode"
  | "returns"
  | "retention"
  | "segments";

export type CommerceFeatures = Readonly<Record<CommerceFeatureKey, boolean>>;

/**
 * Default-ON for every feature but `register` (Issue #284), `loyalty` (Issue #289) and `storedValue` (Issue #288), below — turning a feature toggle ON by default
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
  courier: true,
  // Issue #284 (ADR-0028) — the one flag that defaults OFF. Every other
  // default is ON because it describes what the platform already did; this
  // one ADDS an obligation (a POS sale needs an open register session), so a
  // tenant that never opens "Fitur" must see exactly today's POS.
  register: false,
  // Issue #286 (ADR-0029) - the second flag that defaults OFF: held sales,
  // quotations, work orders and numbered receipt/invoice documents are a whole
  // new surface (and a numbering obligation once a document is issued), so a
  // tenant that never opens "Fitur" must see exactly today's commerce module.
  documents: false,
  // Issue #289 (ADR-0026 D2) — the one flag that defaults OFF. The five above
  // default ON because they gated behaviour that already existed; loyalty is
  // NEW behaviour that accrues points on every paid order and exposes a
  // customer-visible balance, so a tenant must choose it. A tenant that never
  // opens the "Features" section therefore sees no change at all.
  loyalty: false,
  // Issue #363 (ADR-0043) - defaults OFF, and means nothing without `loyalty`:
  // turning points into a discount on an order is money, so a tenant that has
  // loyalty on (earning points) still chooses separately whether those points
  // can be spent. Even when ON it does nothing until the tenant sets a point
  // value - there is no default value (owner answer Q6).
  loyaltyRedemption: false,
  // Issue #288 (ADR-0030) — the second flag that defaults OFF. Stored value is
  // a liability the tenant takes on (money held that is not yet revenue),
  // which has accounting, consumer-protection and regulatory consequences it
  // must choose to accept; a tenant that never opens "Fitur" must see exactly
  // today's commerce.
  storedValue: false,
  // Issue #294 (ADR-0031) — defaults OFF. Expenses are a brand-new surface
  // with its own approval obligation; a tenant that never opens "Fitur" must
  // see exactly today's store (and, with it OFF, a raw `expense` drawer
  // movement stays what #284 made it).
  expenses: false,
  // Issue #295 (ADR-0034) - defaults OFF: sending a receipt, quotation or
  // work-order notice to a customer is an outbound communication a tenant
  // must opt into (it needs a working e-mail or WhatsApp channel, and it puts
  // customer data on the wire). It also requires `documents`: there is
  // nothing to deliver without it.
  documentDelivery: false,
  // Issue #292 (ADR-0032) - defaults OFF: barcode identity, label printing,
  // the POS scan field and the cashier shortcut layer change what the counter
  // screen does with a keystroke, so a tenant that never opens "Fitur" must
  // see exactly today's POS.
  barcode: false,
  // Issue #287 (ADR-0033) — also OFF. Returns and refunds put goods back into
  // stock and money back into customers' hands: new behaviour with a security
  // posture of its own (separately granted permissions, a provider call), so a
  // tenant chooses it. A tenant that never opens "Features" sees no change.
  returns: false,
  // Issue #364 (ADR-0044) - OFF. The customer-retention report is a new admin
  // surface over a new per-customer projection; a tenant that never opens
  // "Features" must see exactly today's reports screen.
  retention: false,
  // Issue #360 (ADR-0042) - OFF. CRM segments are a new surface that turns a
  // rule into a list of customers (disclosure and evaluation-cost risks of its
  // own, threat model F8), so a tenant chooses it. A tenant that never opens
  // "Features" sees no change: no route answers, no sidebar entry shows.
  segments: false
};

const FEATURE_KEYS: readonly CommerceFeatureKey[] = [
  "documents",
  "pos",
  "inbox",
  "campaigns",
  "gateway",
  "courier",
  "register",
  "loyalty",
  "loyaltyRedemption",
  "storedValue",
  "expenses",
  "documentDelivery",
  "barcode",
  "returns",
  "retention",
  "segments"
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
