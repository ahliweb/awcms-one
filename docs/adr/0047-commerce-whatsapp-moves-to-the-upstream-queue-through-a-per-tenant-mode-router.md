🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0047-commerce-whatsapp-moves-to-the-upstream-queue-through-a-per-tenant-mode-router.id.md)

# ADR-0047 — Commerce WhatsApp moves to the upstream queue through a per-tenant mode router

- **Status:** Accepted
- **Date:** 14 October 2026
- **Decision maker:** ahliweb
- **Related:** issue [#392](https://github.com/ahliweb/awcms-one/issues/392) (this ADR and phase 2), [#393](https://github.com/ahliweb/awcms-one/issues/393) (the guarded flip and the drain report, phase 3), epic [#280](https://github.com/ahliweb/awcms-one/issues/280) item 31; upstream ADR-0133 section 6 (the phases and the end condition) under `apps/cms/docs/adr/`; [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) D5 (the commerce-owned outbox this retires), [ADR-0034](0034-commercial-documents-are-delivered-through-the-existing-outboxes-as-transactional-messages-built-from-immutable-sources.md) (document delivery), [ADR-0038](0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md) (the same per-tenant-mode shape for stock), [ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md) (the migration number)

## Context

Upstream promoted WhatsApp delivery to a generic module, `whatsapp_delivery` (ADR-0133, synced by #409): one queue per channel, three purpose classes, a consent store, suppression, expiry for security messages, and `WhatsappDeliveryPort`. Commerce still owns a second queue, `awcms_commerce_whatsapp_messages`, with its own provider, dispatcher and purge. ADR-0133 section 6 phase 2 asks for a compatibility adapter and a per-tenant mode that selects where **new** messages go, with no dual write and no row copying, and a dated end condition that deletes the adapter.

## Decision

**D1 — `enqueueWhatsappMessage` becomes a mode router; its signature does not change.** `application/whatsapp-enqueue.ts` reads the tenant's mode and calls either the legacy writer (`whatsapp-enqueue-legacy.ts`, the old function moved unchanged) or the upstream adapter (`whatsapp-upstream-enqueue.ts`, `WhatsappDeliveryPort.enqueue` in the caller's transaction). The four callers (customer OTP, order paid, campaigns, document delivery) import only the router. Rejected: keeping one function with an `if` inside (the upstream path could not be shown to be free of the legacy table), and a second public function (every caller would change).

**D2 — The mode is two columns on `awcms_commerce_store_settings` (`sql/1027`).** `whatsapp_mode` (`legacy` default, `upstream`) and `whatsapp_mode_changed_at`, the shape ADR-0038 gave `inventory_mode`: columns, not the settings jsonb, so an owner's "reset my store" cannot move a tenant between queues; `resetStoreSettings` now also keeps the row live while the mode is `upstream`, so the retention purge cannot delete it. A tenant with no settings row is `legacy`. Rejected: a new table (a row to keep consistent with the settings row for one value) and an environment variable (it is per tenant by the ADR, not per deployment).

**D3 — The mode is read under a shared advisory lock; there is no writer in this change.** `resolveWhatsappMode` takes `pg_advisory_xact_lock_shared` before it reads, so the answer cannot change under the transaction. `lockWhatsappModeExclusive` is the seam for #393: the flip takes it, refuses while the legacy queue holds a non-terminal row (`queued`, `sending`, `retry_wait`), upserts the settings row, writes the column and audits. #392 sets the column only in tests, by SQL.

**D4 — `legacy` is byte-for-byte unchanged.** Same INSERT, columns and values; the optional new input field `idempotencyKey` is ignored by it. Pinned by a statement-level unit test and a row-level integration test. The only added legacy-mode work is one lock and one `SELECT` of the mode per enqueue, and, only when exactly one of the two channel flags is on, one `SELECT` of the mode for channel availability.

**D5 — `upstream` maps each message to a registered template.** `commerce.customer_otp` is `security` (secret variable `code`, `expiresAt` = now plus the code's own validity), `commerce.order_paid` and `commerce.document` are `transactional`, `commerce.campaign` is `marketing`. The wording and variable lists are the legacy registry's own, read through one accessor, so the two modes cannot drift. The recipient is an address (a commerce customer has no `profile_identity` profile). The correlation id is the caller's. A refusal or suppression is returned as `enqueued: false` with a reason, never thrown.

**D6 — The idempotency key comes from the caller's identity, and an OTP has none.** A campaign recipient is `campaign:<campaignId>:<customerId>` and a document delivery `document:<deliveryId>`, prefixed `commerce:`. The legacy path never had a key, so the identity is the one its own tables are unique on. A customer OTP gets a fresh key per call: a replay would deliver the previous code for the new one. The campaign dispatch correlation id is per run, not per campaign, so it cannot be the identity.

**D7 — Channel availability and status reads follow the mode.** `legacy` asks `COMMERCE_WHATSAPP_ENABLED`; `upstream` asks `WHATSAPP_ENABLED`, because each is the gate its own dispatcher honours. The OTP channel resolver returns a channel that looks the mode up at send time, so the legacy `log` adapter (which prints the code) is never used for an `upstream` tenant. The document-delivery history reads the legacy table first and then the queue, through the port, for the ids it does not find. A not-queued document delivery is recorded with the two `failure_reason` values its CHECK allows (recipient side: `RECIPIENT_SUPPRESSED`; sending side: `TEMPLATE_UNAVAILABLE`).

**D8 — Template registration is a dependency-free side-effect file, and the dispatch process needs one import.** `domain/whatsapp-upstream-templates.ts` registers the templates with `registerWhatsappTemplate`; `module.ts` imports it for the CMS server. The `whatsapp:dispatch` process imports no module and upstream offers no descriptor-declared registration, so without it every commerce message would fail as `template_unknown`. `apps/cms/scripts/whatsapp-dispatch.ts` carries one side-effect import (a recorded divergence in `AGENTS.md`, the same shape as the e-mail one). The `commerce -> whatsapp_delivery` edge is a `capabilities.consumes` entry (optional), not a `dependencies` one, so enabling commerce does not require a tenant to enable `whatsapp_delivery`.

**D9 — The end condition's first test exists now.** `apps/cms/tests/commerce-whatsapp-upstream-boundary.test.ts` fails if a file on the upstream path names a legacy table, provider, dispatcher or writer, if a commerce caller reaches WhatsApp other than through the router, or if a file outside a short allowlist names a legacy table. When the legacy path is deleted the allowlist empties and the rule becomes the upstream `awcms` ADR-0133 wording.

## Known gaps a tenant must accept before #393 flips it

These are properties of the upstream queue, found while building the adapter, and none is fixed here (they belong upstream or to #393):

1. **Marketing consent is not bridged.** A campaign recipient needs a recorded opt-in in `whatsapp_delivery`'s consent store; commerce's `marketing_consent_at` is not copied there. A tenant flipped without importing its opted-in numbers sends no WhatsApp campaign (every recipient is `skipped`). #393's runbook must say so.
2. **Variables are single-line and capped at 1,000 characters.** The upstream renderer collapses line breaks in a variable and truncates it, so a long, multi-line document body (a receipt) or campaign body is flattened or cut. Needs an upstream template option before a tenant that depends on long documents flips.
3. **Meta needs a provider template identity.** The commerce templates carry none; with `WHATSAPP_PROVIDER=meta` they fail terminally (never free text). Fonnte and `log` are unaffected.
4. **Rate limits differ.** Upstream limits a recipient to 10 messages an hour (5 for `security`) and a tenant to 2,000.
5. **No `order_paid` caller exists yet.** The template is registered and the router serves it; nothing in commerce sends it today.

## Consequences

- Phase 2 is shippable with every tenant on `legacy`; nothing observable changes until a tenant's column is set.
- The upstream `awcms` ADR-0133 backstop (the adapter is removed no later than the second minor release after the one that first ships `upstream` mode) starts with this change's release.
- The two admin screens, `commerce:whatsapp:dispatch` and `commerce:whatsapp:purge` stay and keep draining legacy rows.
