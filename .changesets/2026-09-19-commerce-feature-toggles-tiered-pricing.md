---
bump: minor
type: structure
impact: internal
---

# Commerce feature toggles per tenant + tiered pricing at quote for logged-in customers

Issue #118 (epic #33 C9, contract #106 D10, closing ADR-0016 D6's tiered-pricing
follow-up).

- `apps/cms/src/modules/commerce/module.ts` gains `settings: {schemaVersion: 1,
  defaults: {features: {pos, inbox, campaigns, gateway, courier}}}` (every flag
  `true` by default — no behaviour change for a tenant that never opens the new
  "Fitur" section) — `commerce`'s first use of `module_management`'s generic
  tenant-settings service.
- `apps/cms/src/modules/commerce/domain/commerce-features.ts` (new): pure
  `resolveCommerceFeatures`/`assertFeatureEnabled`/`FeatureDisabledError`.
  `apps/cms/src/modules/commerce/application/commerce-feature-gate.ts` (new):
  `fetchCommerceFeatures` + owner (`409 FEATURE_DISABLED`) and public (neutral
  `404`) route-guard helpers. Applied to every owner + storefront route of the
  inbox (conversations), campaigns, gateway (webhook-endpoints; the storefront
  payment-gateway-session route folds a disabled gateway into its existing `503
  GATEWAY_UNAVAILABLE`; the public webhook intake route answers the same neutral
  `404` an unknown token does), and courier (`GET /shipping/destinations`) —
  documented 409-vs-404 rule: `409` on an authenticated owner route, `404`/`503`
  on an anonymous one, never the reverse.
- `ModuleNavigationEntry` gains an optional `requiredFeature`, applied to the
  Inbox/Campaigns admin nav entries; `AdminLayout.astro` hides them per-tenant.
- `GET /api/v1/commerce/store-settings/public` gains `inboxEnabled`,
  `campaignsEnabled`, and `whatsappOtpEnabled` (matching `apps/storefront`'s
  already-expected field names); `gatewayEnabled`/`courierEnabled` now also
  require `features.gateway`/`features.courier`.
- `/admin/commerce-settings` gains a "Fitur" section writing through the generic
  `PATCH /api/v1/tenant/modules/commerce/settings` (`updateModuleSettings`,
  audited), gated on `module_management.settings.update`.
- `domain/cart-quote.ts`'s `quoteCart` accepts an optional `customerLevel`
  (1–4) and prices a line at `price_level_{n}` (falling back to `price`);
  `POST .../storefront/cart/quote` resolves it from an optional Bearer;
  `createOrderFromCart` resolves the same account's level before its own
  re-quote so quote and order always agree. No new column: the level is
  snapshotted only implicitly, via `order_items.unit_price`.
- Docs: `docs/cms.md`/`.id.md`, `docs/api.md`/`.id.md`, ADR-0016 status note,
  `apps/cms/src/modules/commerce/README.md`/`.id.md`.
