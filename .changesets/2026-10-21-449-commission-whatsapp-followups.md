---
bump: minor
type: fix
impact: public
---

# Wave C review follow-ups: commission delayed delivery, WhatsApp rollback and checkout idempotency namespace

The low-severity findings of the commission (ADR-0046) and WhatsApp cutover (ADR-0047) reviews, plus the checkout idempotency namespace of the loyalty redemption review (ADR-0043). The commission adapter is still dormant (ADR-0046 D10), so the commission fixes take effect when it is re-enabled; the WhatsApp and checkout changes are live.

- **WhatsApp rollback (`upstream` to `legacy`) counts only commerce's own rows.** A booking reminder in the shared upstream queue no longer blocks it; other modules' rows are reported in `queues.upstreamScope`. A status holding more than one page of the operator read counts its remainder as commerce's (fail closed).
- **New, audited rollback override.** `force: true` on `POST /api/v1/commerce/whatsapp/mode` and `--force` (with `--operator`) on `bun run commerce:whatsapp:cutover`, rollback only, bypass the drain check and nothing else, under the same permission, step-up and idempotency key as any real flip. Audited as `whatsapp_mode.flip_forced` with the number of messages bypassed; the bypassed messages stay with the upstream dispatcher (late, not lost, not duplicated).
- **The environment warning is in the HTTP response.** `GET` and `POST /api/v1/commerce/whatsapp/mode` carry `channelEnvironmentNotice`: the channel facts are read from the web server process, not the dispatchers. The CLI prints it on stderr. API change is additive (`force`, `queues.upstreamScope`, `force`, `channelEnvironmentNotice`); `queues.upstream` now counts commerce's non-terminal rows only.
- **A signed-in storefront checkout's idempotency record is keyed to that customer** (`user:customer:<id>`), so another visitor cannot claim its key or replay its order. A retry that straddles the deploy still replays through a bounded fallback that honours only the identical request on the customer's own order; remove it after the idempotency table's 30-day retention.
- **Commission, for re-enablement:** the beneficiary is the employment linked when the sale was paid, not when a delayed delivery runs; the attributor skips lines already fully returned and serialises with the reversers on a per-order lock; the voider identity is unchanged and recorded as an owner question (ADR-0046 D12).
- Documentation: ADR-0046 D11-D12, ADR-0047 D16-D17, ADR-0043 D12 (English and Indonesian), the API reference, the deployment runbook, the commerce module README, `docs/status.md`.
