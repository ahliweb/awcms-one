---
bump: minor
type: structure
impact: public
---

# Public store-settings tax field now discriminates between flat and engine tax modes

Issue #324 — the `payment.tax` field in the public store-settings DTO (`GET /api/v1/commerce/store-settings/public`) is now a discriminated union based on the tenant's tax mode (ADR-0039):

- **Flat mode** (default): `{ mode: "flat", active: boolean, percent: number }` — additive `mode` field; existing consumers remain unaffected.
- **Engine mode**: `{ mode: "engine", inclusive?: boolean }` — omits `active` and `percent` fields, exposes only the mode discriminator.

A storefront that needs to display the tax rate should check the `mode` field and render the percent only for `mode: "flat"`. The OpenAPI schema for `CommerceStoreSettingsPublic` is updated to describe this discriminated union.
