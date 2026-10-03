---
"awcms": minor
---

feat(commerce): multi-tender, partial/due settlement and an append-only payment-allocation ledger (Issue #285, epic #281)

New `awcms_commerce_payment_allocations` table (`sql/940` schema + trigger + `REVOKE DELETE`, `sql/941` permissions, `sql/942` worker purge grant, `sql/943` backfill) recording every tender leg (`cash`, `manual_qris`, `manual_bank_transfer`, `gateway`) and every compensating reversal. An order's settlement is DERIVED from the rows; `awcms_commerce_orders.payment_status` (now also `partially_paid`) is a cache of it, independent of the order lifecycle. The order reaches `paid` exactly when settlement reaches its release threshold (the total; a down-payment order's down payment) through the one existing `transitionOrderStatus`. Reversals never move the lifecycle backwards.

New endpoints:

- `GET`/`POST /api/v1/commerce/orders/{id}/payments` — ledger + settlement (`commerce.payments.read`) / record a tender (`commerce.payments.create`, `Idempotency-Key`, `409 OVERPAYMENT`)
- `POST /api/v1/commerce/orders/{id}/payments/{paymentId}/reversals` — compensating reversal (`commerce.payments.revoke`, `Idempotency-Key`, reason required)
- `GET /api/v1/reports/commerce/tender-mix`, `GET /api/v1/reports/commerce/outstanding-balances` (`commerce.payments.read`, read the ledger directly)

POS (`POST /api/v1/commerce/pos/orders`) keeps the legacy `payment` payload unchanged (adapted to one leg, identical idempotency hash) and additionally accepts `tenders[]` and `allowDue` (separate permission `commerce.pos_due.create`; a customer phone is required). The 201 gains `payments[]`, `settlement` and the order `id`.

Existing flows now write the ledger: an accepted manual-transfer confirmation records a leg (capped at the outstanding amount) instead of flipping the order — a short confirmation leaves it `partially_paid`; `createGatewaySession` opens a `pending` gateway leg and the verified webhook / reconcile job resolves it idempotently (`gateway:{provider}:{ref}`); a manual `PATCH .../status -> paid` is `409 PAYMENT_NOT_SETTLED` until the ledger agrees.

Concurrency: every writer locks the order row with `FOR NO KEY UPDATE` (not `FOR UPDATE`, which deadlocked against the webhook path's FK key-share locks — found by the genuinely-concurrent webhook test). Events `awcms.commerce.payment.recorded`/`.reversed` ride the order aggregate. `dataLifecycle`/`subjectData` descriptors added (ten-year ceiling, hard delete reachable only by the retention worker). Admin: order detail payments panel, POS split-tender entry and per-tender receipt, tender-mix and outstanding-balance panels on the reports screen.
