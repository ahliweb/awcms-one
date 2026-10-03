🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0025-payments-are-an-allocation-ledger-separate-from-order-status.id.md)

# ADR-0025 — Payments are an append-only allocation ledger, separate from order status

- **Status:** Accepted
- **Date:** 3 October 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (money); [ADR-0010](0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md) and [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (payment gateway, POS, no provider call inside a transaction); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (migration range); issue [#285](https://github.com/ahliweb/awcms-one/issues/285) under epic [#281](https://github.com/ahliweb/awcms-one/issues/281).

## Context

Until now an order's payment was one fact: `payment_method` (what the customer said they would use) and one `payment_status` axis that the order-status machine overwrote to `paid` the moment `pending_payment -> paid` ran. That cannot express "Rp 60.000 cash and Rp 40.000 QRIS", "Rp 50.000 paid, the rest due", or "Rp 20.000 of that was refunded", and it let three unrelated paths (an accepted storefront transfer confirmation, a Midtrans webhook, a POS tender) each decide "paid" in their own way — an accepted confirmation for Rp 1 moved a Rp 100.000 order to `paid`. Epic #281 builds a one-ledger sales model (loyalty points and gift-card value are separate ledgers); this ADR is the payments half of it and the foundation the loyalty/gift-card/refund work reuses.

## Decision

### D1 — One append-only table, `awcms_commerce_payment_allocations`, and settlement is DERIVED

Every tender leg and every compensating reversal is one row (`sql/940`): `kind` (`payment` | `reversal`), `tender_type` (`cash`, `manual_qris`, `manual_bank_transfer`, `gateway`), `amount numeric(14,2) > 0` (the amount APPLIED to the order), `status` (`pending` | `succeeded` | `failed`), provider/provider reference, cash `tendered_amount`/`change_amount`, `source`, `actor`, and a unique `(tenant_id, source_key)`. Settlement is `Σ succeeded payments − Σ succeeded reversals`; `outstanding = max(0, total − settled)`. **No running balance is stored**, so a balance cannot drift from the rows that justify it. `awcms_commerce_orders.payment_status` stays, as a CACHE of the derivation (`unpaid | partially_paid | dp_paid | paid | refunded`), rewritten in the same transaction as every ledger write so the existing admin filter and storefront read keep their one-column shape.

`store_credit`/`gift_card` are deliberately absent from the tender CHECK: their ledgers (#288/#289) do not exist, and a value no code path can write is a claim, not a feature. The migration that ships the first writer widens the constraint.

### D2 — Append-only is mechanical, not a convention

`awcms_app` loses `DELETE` (`REVOKE`, because `sql/019` grants all four verbs by default — `sql/125`'s precedent; `security-readiness.ts` asserts the exact grant set both ways). A `BEFORE UPDATE` trigger freezes every column except the one legal transition: a `pending` gateway leg resolving to `succeeded`/`failed` (+ `settled_at`). An amount, tender, reference or actor can never be edited; a correction is a NEW `reversal` row pointing at the payment it compensates, capped at that payment's amount. Only `awcms_worker` keeps `DELETE`, for the data-lifecycle engine's ten-year ceiling (`commerce.payment_allocations`, five-year floor).

### D3 — Payment status is independent of the order lifecycle; the lifecycle moves through the one existing machine

The order reaches `paid` exactly when settlement reaches its **release threshold**: the total — or, for a down-payment order (`payment_method = 'dp'`, `dp_amount < total`), the down payment, which is exactly what the pre-ledger flow did (the first accepted confirmation released the order) minus the silent forgiveness of the balance (it is now `dp_paid` with an explicit outstanding amount). The transition is NOT forked: the ledger is handed a release callback that is a closure over `order-directory.ts`'s `transitionOrderStatus` (status timestamp, `order_events`, audit, `order.paid`/`order.status_changed` events are the ones every path already produces). A **reversal never moves the lifecycle backwards** — it lowers settlement and re-derives `payment_status`; cancelling fulfilment because money went back stays a human decision (`domain/order-status.ts`'s existing refund stance). Consequence: a manual admin `PATCH .../status -> paid` is refused with `409 PAYMENT_NOT_SETTLED` until the ledger says so — "paid" can no longer be claimed without recorded money. This is a deliberate behaviour change, called out in the changeset.

### D4 — Concurrency: lock the order row, `FOR NO KEY UPDATE`

Every ledger writer first locks the order row, then reads the ledger, validates, inserts, recomputes — in that order everywhere (no deadlock between writers). Two concurrent final allocations serialise; the second sees the first and fails its own overpayment check, so an order can never be over-settled nor released twice. The lock is `FOR NO KEY UPDATE`, **not** `FOR UPDATE`: a child insert with an FK to the order (a `payment_events` row, a ledger row) takes `FOR KEY SHARE`, which `FOR UPDATE` conflicts with — the genuinely-concurrent webhook test found the resulting deadlock (delivery A holds the gateway-session row and waits for the order; delivery B holds key-share on the order and waits for the session). The unique `source_key` is the independent second guard.

### D5 — Overpayment is rejected, except cash change; change comes from the cash leg only

`domain/payment-allocation.ts`'s `planTenders` subtracts every non-cash tender from the amount due first, then applies cash to what is left: `change = handed over − applied`, never negative. A short tender is a shortfall (`409 INSUFFICIENT_TENDER`), never hidden behind another tender's change; non-cash tenders summing above the total are `409 OVERPAYMENT`; a cash tender when nothing is left to pay is refused (change out of thin air). The table CHECK makes `tendered = amount + change` an invariant of the row. **Exception, recorded not hidden:** an externally-confirmed gateway leg (the provider already captured the money) is recorded even if the order is cancelled/expired/already paid — the excess surfaces as `overpaid` for an operator to refund via a reversal, rather than being silently dropped. An accepted manual-transfer confirmation is capped at the outstanding amount (the cap is written on the row's `note`), never a reason to refuse the acceptance.

### D6 — Idempotency in two independent layers

The shared `awcms_idempotency_keys` store gives HTTP replay/conflict semantics (`commerce.payments.record`, `.reverse`, `commerce.pos.create`; the hash binds the actor and the resource ids, so another cashier or another order can never replay a response). The ledger's own `source_key` covers the paths with no client key: `gateway:{provider}:{ref}` (a webhook replay, a re-delivery under a new event key, or the reconcile job racing the webhook all find the leg already `succeeded`), `confirmation:{id}`, `api:{key}`, `reversal:{key}`, `pos:{key}:{n}`, `backfill:{order id}`.

### D7 — Gateway legs are pending until confirmed; no provider call enters a transaction

`createGatewaySession` opens a `pending` leg in its persist transaction (after the provider call returned); the verified webhook/reconcile outcome resolves it to `succeeded` (or a `failed`/`expired` session resolves it to `failed`). A pending leg counts for nothing and fires no event. Gateway refunds are NOT auto-reversed (the existing "refunded never moves the order" decision); an operator records the reversal. No code in this ADR makes a provider/network call at all: a reversal is the book-keeping fact, returning the money is the operator's act. Gateway tenders cannot be typed by staff (`POST .../payments` accepts `cash`, `manual_qris`, `manual_bank_transfer`). The gateway amount guard still requires the provider's `gross_amount` to equal the order total, so a gateway session always charges the whole total today — mixing a gateway leg with another tender on one order is deferred.

### D8 — POS: legacy payload adapted, explicit `tenders[]`, permissioned due balance (contract version 2)

`POST /api/v1/commerce/pos/orders` accepts EITHER the legacy `payment: { method, amountTendered }` — adapted to exactly one ledger leg with the same arithmetic and errors, its idempotency hash byte-identical to before — OR an explicit `tenders[]` (never both). Non-cash tender `amount` = applied; the (single) cash tender `amount` = handed over. `allowDue: true` (requires `tenders[]`, a customer phone — the walk-in row cannot be asked to pay — and the SEPARATE permission `commerce.pos_due.create`, checked in the handler through the same chokepoint in addition to `commerce.pos.create`) lets a sale finalize with a balance due: it stays `pending_payment`, `payment_status` `unpaid`/`partially_paid`, `expires_at NULL` (the expiry job never reclaims a counter sale's stock), with `settlement.outstanding` explicit, and the owner-side payments endpoint settles it later. The 201 gains `payments[]` (every tender, for the receipt) and `settlement`; `change`/`amountTendered` keep their legacy meaning. `orders.payment_method` becomes a legacy summary hint (the tender with the largest applied amount); the ledger is the truth. OpenAPI documents this as additive: version 1 clients are unaffected, nothing is removed.

### D9 — Permissions and events

`commerce.payments.read | create | revoke` (+ `commerce.pos_due.create`). A reversal uses the platform's existing HIGH-RISK verb `revoke` rather than adding `reverse` to the upstream-owned `AccessAction` union: taking recorded money out of the books is exactly what the high-risk set (and the SoD rules a tenant may author) is for. Events `awcms.commerce.payment.recorded` / `.payment.reversed` ride the ORDER aggregate (one ordered stream per order), carry ids/tender/amounts/resulting settlement and never a customer name/phone or a payment reference; a pending leg and the backfill fire none. Audit `payment.record` / `payment.reverse`.

### D10 — Reporting reads the ledger directly

`GET /api/v1/reports/commerce/tender-mix` (payments, reversals, net per tender over a range of `Asia/Jakarta` report days, attributed to the day each leg was recorded) and `.../outstanding-balances` (orders still owing money, re-derived from the ledger, count/total over EVERY match) are live aggregates over an indexed append-only table — no second projection to drift or reconcile. If volume ever warrants it, a projection can be added behind the same routes. The order detail and POS screens show the same derived numbers.

### D11 — Expand → backfill

`sql/943` writes ONE deterministic `backfill` leg per already-paid order (`ON CONFLICT DO NOTHING`, skipped for any order with a ledger row, timestamp = the order's own `paid_at`, never `now()`), reconstructing the tender from `payment_method` (gateway from `gateway_provider/ref`) and, for the one legacy shape where "paid" never meant paid in full (a down-payment order), the accepted confirmations' sum capped at the total (or `dp_amount`) — correcting that order's cached status to `dp_paid`. It invents no cash change and announces nothing.

### D12 — Tenant-safe references

Both references are composite FKs on `(tenant_id, …)` (a `UNIQUE (tenant_id, id)` on the allocation table and on `awcms_commerce_orders`), plus FORCE RLS with a `WITH CHECK`. Owner routes resolve an order and a payment tenant- AND order-scoped: another tenant's order, an unknown payment and a payment of a different order are the same `404` (no BOLA oracle).

## Consequences

- Positive: split/due/refunded payments are expressible and exact; "paid" is derived and can no longer be claimed without recorded money; every payment is auditable, idempotent and replay-safe; reports need no invented numbers; the loyalty/gift-card/refund work has a ledger shape to copy.
- Cost: an accepted manual-transfer confirmation for less than the total no longer marks the order paid (the balance is explicit); a manual `-> paid` override on an order that already has ledger legs but is not settled is refused (record the payment instead), while on an order with no leg at all it records one full-amount manual leg itself (see "Behaviour changes" below); an order that holds received money is never expired by the expiry job and is offered no gateway session; an extra `FOR NO KEY UPDATE` row lock per payment write; reports are live aggregates (bounded by the `(tenant_id, created_at)` index, a projection is the escape hatch).
- Compatibility: legacy single-tender POS and storefront payloads keep working; `payment_status` gains `partially_paid` (the OpenAPI field is a plain string; admin labels were extended).

## Behaviour changes (review fixes)

- **Manual `PATCH .../status -> paid`.** Decided under the order-row lock (`FOR NO KEY UPDATE`, the same lock order as every writer): an order with NO ledger leg at all (a COD / offline tenant that never used the ledger) gets ONE succeeded leg for the full total, source `admin`, source key `status-paid:{order id}` (a replay is a no-op), audited like any payment, with the tender taken from the order's `payment_method` (`cash`, `manual_qris`, `gateway` with provider `legacy` as `sql/943` backfilled it, otherwise `manual_bank_transfer`), and the ledger releases the order to `paid`; an order WITH legs that is not settled stays `409 PAYMENT_NOT_SETTLED` with the outstanding amount. No migration is needed (the existing tender kinds fit; `sql/944` stays unused).
- **Gateway sessions refuse a part-paid order.** A hosted-checkout session charges the whole order total, so `createGatewaySession` neither creates nor hands back a session when `settled > 0`: `409 ORDER_PARTIALLY_SETTLED` with `details.outstanding`. The check is repeated in the persist transaction (a payment can land while the provider call is in flight). Part-amount gateway legs remain deferred; the balance is settled with a manual tender.
- **Expiry never strands received money.** `listExpirableOrderIds` skips, and `expireOrderBySystem` re-checks under the order lock, any order whose `settled > 0`: it is not expired and not restocked, and stays on the outstanding-balances report for an operator to settle or cancel.
- **Source-key conflicts.** A ledger `source_key` found on the same order is a replay only if it is the SAME request (tender, and amount or handed-over cash for a payment; the reversed payment and amount for a reversal). A key already used for another order, or for a different request, is `AllocationSourceKeyConflictError`, mapped to `409 IDEMPOTENCY_CONFLICT` by the payment, reversal and POS routes.

## Deferred (not built here, on purpose)

Store-credit / gift-card tenders (#288/#289); automatic provider refunds and refund-driven order/fulfilment changes; a gateway leg for less than the whole total (partial-amount sessions, which also needs the amount guard to compare against the outstanding balance); a tender-mix projection; a customer-facing "balance due" on the storefront order page; per-tender cash-drawer/shift reconciliation.
