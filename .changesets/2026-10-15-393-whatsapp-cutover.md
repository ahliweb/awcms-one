---
bump: minor
type: structure
impact: public
---

# Commerce WhatsApp: a guarded per-tenant cutover with a drain check

Phase 3 of upstream `awcms` ADR-0133 section 6, issue #393, decided in ADR-0047 "Cutover". A tenant can now be moved between commerce's own WhatsApp outbox (`legacy`) and the upstream `whatsapp_delivery` queue (`upstream`) by an operator, and only when it is safe: a tenant is in exactly one mode at a time.

- One function, `flipWhatsappMode`, is the only writer of `whatsapp_mode`. Under the exclusive per-tenant mode lock it refuses (`409`) while the queue being left holds a non-terminal row (legacy: `queued`, `sending`; upstream, for the reverse flip: also `retry_wait`), while the queue being entered cannot send (its enable flag is off, the `whatsapp_delivery` module is off for the tenant, no recipient-hash key ring, no provider), and, into `upstream`, until the ADR-0047 known gaps are acknowledged. An enqueue racing the flip either lands before the count (the flip refuses) or waits and reads the new mode, so no legacy row can appear after the drain check.
- `bun run commerce:whatsapp:cutover --tenant <id> (--status | --to upstream|legacy --reason "<why>" [--dry-run] [--ack-warnings] [--wait <seconds>])` prints a JSON evidence record (queue counts per status, oldest age, blockers, warnings, audit event id) for the runbook; exit 0 / 1 refused / 2 usage. Applying is the default, `--dry-run` writes nothing.
- `GET` / `POST /api/v1/commerce/whatsapp/mode` are the same decision over HTTP: `commerce.whatsapp_mode.read` / `.manage` (high-risk, `sql/1028`), a real flip needs a recent step-up and an `Idempotency-Key`, a refusal is `409` with the evidence in `error.details`. Existing tenants run `bun run identity-access:permissions:backfill`.
- Audited: a flip writes `whatsapp_mode.flip`, a refused attempt writes only `whatsapp_mode.flip_refused`, a dry run writes nothing.
- No tenant changes mode on deploy; every tenant stays `legacy` until an operator flips it. Runbook: `docs/deployment.md`. No admin screen (recorded in the admin-screen coverage ledger).
- Corrects a comment from #392: the legacy table has no `retry_wait` (a retrying row is `queued` again); `retry_wait` belongs to the upstream queue.
