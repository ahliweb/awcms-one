---
bump: minor
type: structure
impact: public
---

# Customer campaigns: consent, mass e-mail/WhatsApp, dispatcher, admin screen (issue #114, C6 of #33)

`apps/cms` gains a consent-gated mass e-mail/WhatsApp send to a filtered
slice of a tenant's customer accounts, coded against
[issue #106](https://github.com/ahliweb/awcms-one/issues/106)'s
ADR-0017 D9 — reusing the SAME e-mail/WhatsApp outboxes D5/D8 already
dispatch from, no third delivery mechanism.

- `awcms_commerce_customer_accounts.marketing_consent_at` (nullable
  timestamp) — toggled only by the account itself, via `PATCH
  .../account/me {marketingConsent}` (matching the storefront shape
  `apps/storefront` already shipped against this contract). Both a grant
  and a revoke are audited.
- `awcms_commerce_campaigns`/`awcms_commerce_campaign_recipients`
  (`sql/929`, permission seed `sql/930` —
  `commerce.campaigns.{read,update,send}`): CRUD on a `draft`, an
  audience-count-only preview (never a resolved list), `send`/`cancel`
  (`Idempotency-Key` required, gated on the separate `.send` permission).
- `commerce:campaigns:dispatch` (script, `awcms_worker`, every 1-2
  minutes): claims due/resumed campaigns (`FOR UPDATE SKIP LOCKED`) and
  fans each one out in pages of 200 consented, addressable customers,
  inserting one recipient row per customer (resumable — a crash mid-send
  is picked back up from wherever the recipient ledger left off) and
  enqueuing into the e-mail outbox (a pass-through `derived.commerce_campaign`
  template) or the WhatsApp outbox (`commerce.campaign` template). A
  `cancel` between pages stops further dispatch immediately.
- A campaign's own `subject`/`body` may interpolate `{{name}}`/
  `{{storeName}}` only — an unknown placeholder is left as a literal.
- Admin screen `/admin/commerce-campaigns`: list, create-draft form,
  detail/editor panel with an audience-preview button and send/cancel
  actions.
- `ROUTE_PARITY_EXEMPTIONS` (`apps/cms/scripts/api-spec-check.ts`) loses
  its five `commerce/campaigns*` entries; the OpenAPI draft's
  `marketingConsent`/campaign paths are flipped from "not yet
  implemented" to real.

Docs updated: `docs/cms.md`, `docs/api.md`, `docs/skema-basis-data.md`,
`apps/cms/src/modules/commerce/README.md`, all with their Indonesian
mirrors.
