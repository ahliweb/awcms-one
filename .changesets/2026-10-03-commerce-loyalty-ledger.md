---
bump: minor
type: content
impact: public
---

# Loyalty points: an append-only ledger with earn, redeem, expiry, reversal and reconciliation (#289)

`commerce` gains a loyalty/rewards capability designed as an auditable points **ledger**, not a mutable points column ([ADR-0026](../docs/adr/0026-loyalty-points-are-an-append-only-ledger.md)). The "why": the epic's rules (#281) are exact arithmetic, no destructive edits, payments and points as separate ledgers, idempotency on every high-risk write — so a balance is the _sum_ of immutable facts, kept in the same transaction as each insert under a row lock, and every correction is a compensating row.

- Migrations `sql/950`–`952`: `awcms_commerce_loyalty_programs` (versioned, effective-dated earn rules), `_accounts` (projected balance) and `_ledger` (append-only — `awcms_app` is revoked `UPDATE`/`DELETE`, a trigger rejects every `UPDATE`; per-tenant unique idempotency key; composite tenant-safe foreign keys), FORCE RLS, worker grants, four permissions.
- Earn and reversal are driven by the `order.paid` / `order.cancelled` domain events (two new `domain_event_runtime` consumers), so **no order, POS, pricing or payment-webhook code changed**. Exactly once per order, from the order row's `subtotal - discount` in integer cents with FLOOR rounding, under the program version effective at `paid_at`. Walk-in customers never earn.
- `commerce:loyalty:expire` (hourly, append-only, idempotent) and a read-only `commerce:loyalty:reconcile` (daily); an audited repair that rewrites only the projection.
- Owner API (programs, accounts, ledger, redeem, adjust, summary, reconcile), a bearer-secured customer balance/history endpoint, and the `/admin/commerce-loyalty` screen. OpenAPI and AsyncAPI updated.
- **Behaviour change to know about:** a sixth feature flag, `features.loyalty`, **defaults to off** — nothing changes for a tenant until it opts in.
- Permissions are `commerce.loyalty.{read,manage}`, `commerce.loyalty_adjustments.create` and `commerce.loyalty_redemptions.create`, not `loyalty.adjust|redeem`, so the upstream-owned `AccessAction` union is not widened (a new subtree divergence).
- `awcms_worker` gains `SELECT` on `awcms_module_settings` (the earn consumer reads the feature flag).
- Deferred, with reasons in the ADR: redemption into checkout pricing/POS tender (needs #285), tiers, per-line return compensation (#287), campaign eligibility (#280), a storefront balance page.
- **Review hardening.** Reconcile repair now rewrites only complete ledger histories (an account whose early rows were purged is reported `unrepairable_history_purged`), and an earn whose key belongs to another account is a recorded `skipped_conflict` instead of an endless retry.
