🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](bun-omnichannel-delivery-realtime.id.md)

# AWCMS-One Bun-only CRM dispatch and realtime standard (proposed)

> **Runtime and implementation requirements, NOT evidence that realtime WebSocket/SSE is already deployed.** Issue [#467](https://github.com/ahliweb/awcms-one/issues/467), upstream AWCMS [#1167](https://github.com/ahliweb/awcms/issues/1167) and realtime ADR [#1168](https://github.com/ahliweb/awcms/issues/1168), as of 24 October 2026. [Current-state status](status.md) remains authoritative.

## Runtime ownership and deployed facts

`awcms-one` is Bun monorepo pinned **`bun@1.4.3`** in root `package.json`. `apps/cms` embeds upstream AWCMS through a **full-history git subtree**; provider/channel transport is upstream-owned, while `commerce` owns segment audiences, campaign selection and specific business adapters. Storefront remains Astro with `toko`, `berita`, `landing` SSG profiles. Runtime launching of **any AWCMS-One-owned** email marketing/WhatsApp/Telegram/customer Web Push/social publishing campaign worker, scheduler, outbox, real-time gateway/SSE/WS **must use the pinned Bun binary**. No new Node.js server, Node-based Socket.IO daemon, npm/yarn/pnpm runtime, or unrelated Python-based campaign dispatcher. Bun-compatible `node:*` builtins and Bun-hosted `@astrojs/node` adapter are permitted.

**Not in scope:** OMES host pull-worker is Python and uses signed outbound-only HTTPS poll; Hermes owns AI runtime; external providers have their own runtimes. This standard does not rewrite these third-party/external engines, turn them into AWCMS servers or violate OMES security boundaries.

## Transport and status matrix

| Domain | Current on main | Bun-only target |
| --- | --- | --- |
| Generic email/Mailketing | Upstream `email` with Bun `email:dispatch`; upstream Mailketing v1 | Multi-account/v2 CRM marketing (#461, upstream #1158–#1162) uses existing Bun email outbox and provider HTTP; no second campaign mailer |
| Generic WhatsApp | Upstream Bun `whatsapp:dispatch` Meta/Fonnte/log; commerce retains guarded legacy/upstream queue migration | Multi-device StarSender / multi-WABA Meta (#458, upstream #1141–#1143) via **one upstream Bun WhatsApp queue** after safe cutover, default provider chosen per tenant/brand; never dispatch over WebSocket |
| Push notifications | Upstream Bun `push:dispatch`; customer device subscriptions (#430) and the transactional fan-out worker `commerce:customer-push:dispatch` (#432) exist, marketing push is reserved and not built | Existing Bun push worker + web service worker, not Node-based FCM/Web Push service |
| Telegram | Upstream `telegram_delivery` staff-only | Customer multi-bot planned #460 / upstream #1155–#1157; separate admitted Bun provider worker/HTTPS, no repurposing staff queue |
| Social campaigns | Registry and social publishing planned upstream; commerce segments/campaign UI exists | Account-scoped, consent/permission-gated Bun job worker via officially supported provider APIs |
| OMES/Hermes CRM events | OMES observation and host assurance exists; CRM AI #459 is proposed | AWCMS Bun projects sanitized progress to admin, requests typed agent work; OMES host Python HTTPS worker and native Hermes runtime remain unchanged |
| Admin realtime status | No generic AWCMS Bun WebSocket/SSE service verified | **Not implemented:** use secure polling now, evaluate Bun SSE first (one-way) or Bun native WebSocket for authorized duplex only after #1168 |

**Durability:** domain transaction → canonical outbox enqueue → Bun worker claim/lease/retry → provider HTTPS API → verified provider status/webhook → durable audit → optional Bun SSE/WS UI event. WebSocket is a **status transport**, not an email/WA/Telegram send path, an inbox system of record, or a browser-closed Web Push replacement.

## Planned WebSocket/SSE controls (subject to upstream ADR)
- Bun `Bun.serve` protocol choice: **SSE** for broadcast progress, totals and notifications; **WebSocket** when a demonstrated two-way presence/interactive requirement needs it; authenticated HTTPS polling as fallback. Verify compatibility with current Bun version, Astro standalone entry and proxy HTTP/1.1 WebSocket upgrade, not imaginary WS-over-HTTP/2 support.
- Never leak `Authorization` bearer, API keys or PII in connection URLs/frames. Verify Origin, issue short-lived audience-scoped single-use ticket or approved session, recheck tenant ID, brand, business scope, role and subscriptions against authoritative ABAC/RLS. No unscoped `subscribe("all")` or client-defined tenant topics.
- Use redacted versioned envelopes `tenant/campaign/channel/account/status/occurred_at/sequence/correlation` without raw contacts/messages; audit and consent checks remain deterministic and upstream-owned.
- Connection quotas, message size limit, idle/ping, backpressure, slow-client eviction, rate limited upgrades, revocation, reconnection, heartbeat, cursor and REST snapshot recovery; multi-instance distribution requires approved broker/coordination and consistent auth. Treat stale/unknown correctly.
- Preserve server/client CSP `connect-src`, WCAG feedback without realtime connection, operation during iOS suspended/closed browser, and no Node-only WebSocket dependency.

## Tracking and gates

- Current source: [AWCMS module emails](https://github.com/ahliweb/awcms/blob/main/src/modules/email/README.md), [WhatsApp](https://github.com/ahliweb/awcms/blob/main/src/modules/whatsapp-delivery/README.md), [Web Push](https://github.com/ahliweb/awcms/blob/main/src/modules/push-delivery/README.md); [AWCMS ADR-0002](https://github.com/ahliweb/awcms/blob/main/docs/adr/0002-bun-only-runtime.md).
- Planned consumers: CRM multi-sender [#458](https://github.com/ahliweb/awcms-one/issues/458), Hermes [#459](https://github.com/ahliweb/awcms-one/issues/459), Telegram [#460](https://github.com/ahliweb/awcms-one/issues/460), Mailketing [#461](https://github.com/ahliweb/awcms-one/issues/461), WhatsApp regression [#466](https://github.com/ahliweb/awcms-one/issues/466), Web Push [#430](https://github.com/ahliweb/awcms-one/issues/430)–[#432](https://github.com/ahliweb/awcms-one/issues/432), CRM SRS draft [#462](https://github.com/ahliweb/awcms-one/issues/462).
- Acceptance: Bun-only process and deploy manifest checks; two-tenant sender/provider integration and consent/opt-out; browser upgrade origin/session isolation and replay; validated unknown vs delivered; worker crash/idempotency; SSE/WS network recovery; schema/AsyncAPI, docs EN/ID, relevant DB integration, `bun test`, `bun run check`, `bun run check:cms`, `bun run audit:dokumen`, `bun run audit:translation`, all three SSG profiles, `template:init`.
- Upstream `apps/cms` changes must arrive through **git subtree pull with MERGE COMMIT, never squash/rebase**; never import upstream tags into this repository. No applied migration rewrite or manual `bun.lock` edits.

## Atomic enforcement follow-up (2026-10-24)

- [AWCMS #1170](https://github.com/ahliweb/awcms/issues/1170) enforces pinned Bun on provider workers/deploy manifests.
- [AWCMS #1171](https://github.com/ahliweb/awcms/issues/1171) admits/implements SSE-first and optional Bun-native WebSocket gateway only once the upstream [#1168](https://github.com/ahliweb/awcms/issues/1168) ADR is accepted.
- [AWCMS-One #469](https://github.com/ahliweb/awcms-one/issues/469) enforces Bun-only deployment/job/commerce runtime integration without modifying the upstream subtree; this specification remains documentation until tests/PRs land.
