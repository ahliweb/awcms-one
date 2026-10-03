---
"awcms": minor
---

feat(commerce): loyalty & rewards points ledger (Issue #289, awcms-one ADR-0026)

New append-only points ledger in `commerce` (`sql/950` schema, `sql/951` worker grants, `sql/952` permission seed): `awcms_commerce_loyalty_programs` (versioned, effective-dated earn rules), `awcms_commerce_loyalty_accounts` (a projected balance kept in the same transaction as each ledger insert under a `FOR UPDATE` row lock) and `awcms_commerce_loyalty_ledger` (kinds `earn`/`redeem`/`expire`/`adjustment`/`reversal`, integer points, per-tenant unique idempotency key, composite `(tenant_id, id)` foreign keys, FORCE RLS; `awcms_app` is revoked `UPDATE`/`DELETE` and a trigger rejects every `UPDATE`). `application/loyalty-ledger.ts`'s `appendLedgerEntry` is the only writer.

Earn and reversal are `domain_event_runtime` consumers on `order.paid` / `order.cancelled` (`commerce.order_paid_loyalty_earner`, `commerce.order_cancelled_loyalty_reverser`) — exactly once per order, from server-side order facts only, so no order/POS/pricing/payment code changed. Expiry is per earn lot (`commerce:loyalty:expire`, hourly, idempotent; a redemption/adjustment/reversal also expires due lots first under the lock). `commerce:loyalty:reconcile` (daily, read-only) reports projection drift and ledger breaks; `POST .../loyalty/reconcile {repair:true}` rewrites only the projection.

New endpoints under `/api/v1/commerce/loyalty/*` (programs, accounts, ledger, redeem, adjust, summary, reconcile) and `GET /api/v1/commerce/storefront/account/loyalty` (bearer session, owner-scoped by construction); new `awcms.commerce.loyalty.entry_recorded` domain event; new `/admin/commerce-loyalty` screen. New sixth feature flag `features.loyalty`, **default off**. Permissions: `commerce.loyalty.{read,manage}`, `commerce.loyalty_adjustments.create`, `commerce.loyalty_redemptions.create`. `awcms_worker` gains `SELECT` on `awcms_module_settings`.

Shared files touched, each additively: `scripts/security-readiness.ts` (the `awcms_worker` grant matrix), `domain-event-runtime/infrastructure/consumer-registry.ts` and `domain/event-type-registry.ts`, `module-management/domain/sidebar-menu.ts`, `src/lib/ui/commerce-admin-labels.ts`, and the expectations of `tests/{admin-commerce-page-contract,commerce-admin-labels,commerce-feature-toggles,module-management-job-registry,domain-event-runtime-consumer-registry}.test.ts`.
