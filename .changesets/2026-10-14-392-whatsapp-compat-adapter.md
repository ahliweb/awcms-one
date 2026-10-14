---
bump: minor
type: structure
impact: public
---

# Commerce WhatsApp: a per-tenant mode routes new messages to the upstream queue

Phase 2 of upstream ADR-0133 section 6, issue #392, decided in ADR-0046. `enqueueWhatsappMessage` keeps its signature and becomes a router over a new per-tenant mode, `awcms_commerce_store_settings.whatsapp_mode` (`sql/1027`, default `legacy`).

- `legacy` (every tenant today) is unchanged: the same INSERT into `awcms_commerce_whatsapp_messages`, drained by `commerce:whatsapp:dispatch`. The function body moved to `whatsapp-enqueue-legacy.ts` without edits.
- `upstream` enqueues through `WhatsappDeliveryPort` into the `whatsapp_delivery` queue in the caller's transaction, with the four `commerce.*` templates registered there (customer OTP `security` with an expiry, order paid and documents `transactional`, campaigns `marketing`). No dual write and no row copying.
- Nothing sets the mode yet: the guarded flip and the drain report are issue #393. Before a tenant is flipped, read the known gaps in ADR-0046 (marketing consent is not bridged to the upstream consent store, upstream variables are single-line and capped at 1,000 characters, Meta needs a provider template identity).
- The legacy dispatcher, purge, admin screens and API paths stay. The adapter has a dated end: the second minor release after the one that first ships this mode (ADR-0133 section 6 backstop).
- `resetStoreSettings` also keeps the settings row live while the mode is `upstream`, so retention cannot purge the mode.
- Recorded divergence: `apps/cms/scripts/whatsapp-dispatch.ts` carries one side-effect import of the template registration (`AGENTS.md`).
- The migration is additive (two columns on the settings table); no data is moved. `sql/1028` is held for #393.
