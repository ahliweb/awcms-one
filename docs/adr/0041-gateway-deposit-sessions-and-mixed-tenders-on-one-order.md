🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0041-gateway-deposit-sessions-and-mixed-tenders-on-one-order.id.md)

# ADR-0041 — Gateway deposit sessions and mixed tenders on one order

- **Status:** Accepted
- **Date:** 10 October 2026
- **Decision maker:** ahliweb (owner answers of 10 October 2026 applied: PRD Q2, Q3, Q5, Q8)
- **Related:** issue [#353](https://github.com/ahliweb/awcms-one/issues/353) (this ADR), cross-spec finding X2 of [`docs/aw-business-platform-dor.md`](../aw-business-platform-dor.md), control C-07 of [`docs/aw-business-platform-threat-model.md`](../aw-business-platform-threat-model.md), epic [#280](https://github.com/ahliweb/awcms-one/issues/280), gate tracker [#339](https://github.com/ahliweb/awcms-one/issues/339); [ADR-0025](0025-payments-are-an-allocation-ledger-separate-from-order-status.md) (D3 release threshold, D5 overpayment, D7 deferral revisited here); [ADR-0026](0026-loyalty-points-are-an-append-only-ledger.md) (D5 earn on `order.paid`); [ADR-0030](0030-stored-value-is-a-closed-loop-liability-ledger.md) (stored value); [ADR-0033](0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md) (refunds); [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (money); [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (gateway port); [ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md) (migration allocation); [ADR-0040](0040-aw-business-platform-capability-ownership-and-boundaries.md) (D5 item 9, D7 docs-only gate)

## Context

PRD workflow 4.1 has a customer pay a booking deposit through a gateway session and the balance later, possibly at the POS. Today that fails twice. First, the amount guard (`apps/cms/src/modules/commerce/domain/payment-amount-guard.ts`, `sql/934`) requires the provider's `gross_amount` to equal the **whole order total**, read from the order row at intake (`application/payment-webhook-intake.ts`, and again in `application/payment-reconcile.ts`); a partial deposit is recorded as an `amount_mismatch` and never settles. Second, ADR-0025 D7 and its "Behaviour changes" refuse to open a gateway session on an order with `settled > 0` (`409 ORDER_PARTIALLY_SETTLED`) and defer mixing a gateway leg with another tender. The gateway session row (`awcms_commerce_payment_gateway_sessions`, `sql/926`) carries no amount at all: the expected figure is implicitly "the order total, now".

The ledger itself (ADR-0025 D1–D4) already expresses a deposit: a down-payment order (`payment_method = 'dp'`, `dp_amount < total`) is released when settlement reaches `dp_amount`, shows `payment_status = 'dp_paid'` and carries an explicit outstanding balance. What is missing is a safe way for a gateway leg to be less than the total, and a decision on how the order reads between the two payments. Threat-model control C-07 names the fix ("server-computed expected deposit per session, integer-cent comparison, ordinary order guard unchanged") without deciding it. This ADR decides it. It is docs only (ADR-0040 D7): no migration, route, OpenAPI path or code lands here; the implementation belongs to the commerce issues that follow (the adapter, Wave C, depends on this ADR).

## Options considered

| Option                                                                                                                 | Security                                                                                                                                                                                                             | Performance                                                    | Maintainability                                                                    | Compatibility                                                                   | Operational complexity                                        |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A. Loosen the guard to "reported amount is positive and at most the order total"                                       | Weak: a tampered or stale callback for Rp 1 passes and is booked as a deposit; the control becomes a ceiling, not an equality check                                                                                  | None                                                           | Simple but wrong                                                                   | Changes behaviour for ordinary orders                                           | Mismatch investigations lose their signal                     |
| B. Freeze a server-computed **expected amount on each session** and compare the provider figure to it in integer cents | Strong: the expected value is fixed server-side under the order lock before the provider is called, immutable, never taken from the request or the provider; whole-total sessions keep equality with the order total | One extra column read on a path that already reads the session | A single comparison against a stored value; one rule for deposit, balance and full | Whole-total orders unchanged; legacy sessions without the column read as "full" | One column and one purpose enum; no new job or provider call  |
| C. Compare against the order's outstanding balance at intake time                                                      | Mixed: the expected value moves with concurrent manual payments, so a legitimate deposit can be rejected and a stale callback accepted                                                                               | Same                                                           | Hidden coupling to timing; a mismatch is hard to reproduce                         | Changes the meaning of the guard for whole-total orders                         | Races between the webhook and a cashier become incidents      |
| D. Keep the status quo: deposits only by staff-accepted manual transfer or QRIS, gateway only for whole-total orders   | Strong (nothing new)                                                                                                                                                                                                 | None                                                           | Nothing to maintain, but the booking story cannot use the gateway                  | Fully compatible                                                                | Every online deposit needs staff confirmation; defeats PRD A3 |

**Chosen: B.** It is the only option that keeps the guard an equality check against a value the platform alone computed, and it leaves the ordinary path untouched.

## Decision

### D1 — Every gateway session carries a server-computed expected amount and a purpose

A gateway session gains two immutable facts, fixed when it is created: `purpose` (`full` | `deposit` | `balance`) and `expected_amount` (`numeric(14,2)`, stored and compared in integer cents, ADR-0003). They are computed by the server **inside the order-row lock** (`FOR NO KEY UPDATE`, ADR-0025 D4), from the ledger, never from the request body and never from a provider response:

- `full`: `expected_amount` is the order total. Allowed only while `settled = 0`, exactly as today.
- `deposit`: `expected_amount` is the release threshold minus `settled`, where the release threshold is the order's `dp_amount` (D4). Allowed only on a down-payment order whose settlement is still below the threshold.
- `balance`: `expected_amount` is `total − settled`. Allowed only on a down-payment order whose settlement has reached the threshold and is still below the total.

That figure is exactly what is sent to the provider as `gross_amount`. The client may only ask for "pay the deposit" or "pay the balance"; it supplies no amount. `purpose` and `expected_amount` are frozen by a trigger in the same style as ADR-0025 D2 (only the status, `last_checked_at` and `raw_status` of a session may change), so an operator or a bug cannot rewrite what a session was meant to collect. Sessions created before this change have no `expected_amount`; they read as `purpose = 'full'` with the order total, which is what they were.

### D2 — The guard compares the provider figure to the session's expected amount, in integer cents

`checkPaymentAmount` keeps its shape and its integer-cent comparison (`toCents`; an unparseable value remains a mismatch, never a pass). Its second argument changes from "the order's current total" to "the session's expected amount", resolved from the session row found by `provider_ref`. The webhook route and the reconcile job both call it, as now, so the two paths cannot disagree.

A `full` session is checked twice: the reported amount must equal the session's `expected_amount` **and** the order's current total, so a whole-total order is exactly as guarded as before this ADR (an amended total or a stale callback still mismatches). A `deposit` or `balance` session is checked against its own `expected_amount` only, which must be greater than zero; at leg-resolution time, a leg larger than the order's outstanding amount falls under D5's overpayment rule. A mismatch behaves as today: an `amount_mismatch` payment event and audit entry, the ledger untouched, the session moved only on a terminal provider failure. The ledger leg that resolves a verified session records the **session's** `expected_amount` as the applied amount, with the existing `gateway:{provider}:{ref}` source key (ADR-0025 D6); a replay, a re-delivery under a new event key or the reconcile job racing the webhook still credits once.

### D3 — Whole-total orders behave exactly as today

An order with no deposit policy (D4) has no down payment, so only `full` sessions can be created for it, only while `settled = 0`; `ORDER_PARTIALLY_SETTLED` and every other ADR-0025 rule on that path are unchanged, as are the storefront, the POS and every payload that exists today. The regression bar for the implementation is that the existing whole-total gateway tests pass unchanged and that a whole-total order cannot obtain a `deposit` or `balance` session by any request.

### D4 — Deposit policy is per product; the order snapshots the deposit

Per the owner answer to PRD Q2, the deposit policy is set **per product**, as either a percentage or a fixed amount; **unset means full payment** and there is **no tenant-level default**. When an order is created, the server derives `dp_amount` from the lines: a line with a policy contributes its deposit, a line without one contributes its whole line total (it is due up front), and a cart where no line has a policy is an ordinary whole-total order (D3). The percentage applies to the line's taxed total and rounds half up in integer cents; a fixed amount is per unit of quantity; either is capped at the line total and floored at one cent. The result is snapshotted on the order as `dp_amount` and is the release threshold of ADR-0025 D3. A later change to a product's policy never alters an existing order. The catalog field, its validation and its admin screen are implementation work and do not exist yet (see "What is not here yet").

### D5 — Mixed tenders over time on one order are allowed; the ledger is the arbiter

ADR-0025 D7's deferral ends for deposit orders. A gateway deposit followed by a cash, QRIS or transfer balance at the counter, a cash deposit followed by a gateway balance, and any sequence of ledger legs are all valid, because settlement is already derived from the legs and not from a tender. Rules that keep it safe:

1. At most **one live session per order** (status `created` or `pending`); creating another requires the previous to be terminal or expired, as the directory already enforces for one session.
2. The session's `expected_amount` is computed under the order lock, but a manual leg may be recorded while a session is live, and a gateway leg can capture money after that. If the verified leg then exceeds the outstanding amount, ADR-0025 D5 applies unchanged: an externally confirmed gateway leg is recorded in full, and the excess surfaces as `overpaid` for an operator to refund through a reversal. Nothing is dropped and nothing is silently capped.
3. Staff still cannot type a `gateway` tender (ADR-0025 D7); a deposit session is created through the storefront or an owner route that goes through the gateway port, and manual legs keep their own permission and audit.
4. No provider call enters a transaction (ADR-0017): the expected amount is fixed in the first short transaction, the provider is called with none open, and the result is persisted in a second one, as `createGatewaySession` does today.
5. An expired or failed session never reserves money; a deposit that arrives after the order or its hold expired is recorded and flagged (ADR-0025 D5; PRD A3), never silently confirming a released slot.

### D6 — What the order shows between deposit and balance

The lifecycle is unchanged: the order reaches `paid` when settlement reaches the release threshold, because fulfilment, the reservation confirmation in the adapter and the existing event consumers key on that transition (ADR-0025 D3). Between the two payments the order exposes the following, all derived from the ledger and never stored independently:

- `payment_status = 'dp_paid'` (the existing cache value), and a `settlement` object carrying `total`, `settled`, `deposit` (the snapshotted `dp_amount`), `balanceDue` (`total − settled`) and, once outstanding reaches zero, `settledAt` (the settled time of the ledger leg that took it there);
- the storefront order page and the admin and POS order views render "Deposit paid Rp X, balance due Rp Y" from those numbers; a booking adapter may add a balance due date, which this ADR does not define;
- the order stays on the outstanding-balances report (ADR-0025 D10) until settled, and is never expired while it holds received money (ADR-0025 "Behaviour changes").

The platform does not cancel or chase an unpaid balance. What happens when the balance is not paid (retention, no-show, cancellation) is the adapter's and the tenant's policy, not this ADR's; a refund of any leg is a reversal under ADR-0033, capped per payment.

### D7 — Consequence for loyalty earning (owner answer Q5, cross-spec X3)

Per owner answer Q5, **points earn only at full settlement on a deposit order**; whole-total orders are unchanged. ADR-0026 D5 earns on `order.paid`, which for a deposit order fires at the deposit, so the earn trigger needs one new fact: an event announcing that settlement has reached the total (`settledAt` above), emitted once in the same transaction as the ledger write that makes outstanding zero. The earner then reacts to `order.paid` for a whole-total order exactly as today and to the settlement event for a deposit order, under the existing earn source key so that no order can earn twice; ADR-0033 D9 reversal is unchanged. The event name and payload, the interaction with the revenue attribution of metrics section 3.3 (X6) and the loyalty metrics are decided in [#355](https://github.com/ahliweb/awcms-one/issues/355), not here.

### D8 — Not combinable in v1: points and a refundable deposit; rental security deposits

Per owner answer Q8, **points redemption and a deposit may not be combined on one order in v1**: checkout and POS refuse to redeem points on an order whose `dp_amount` is below its total (a `409` with a stable code, defined in the implementation issue), and refuse to create a deposit order that already carries redemption, so no refund-ordering rule between a points leg and a deposit leg is needed. Per owner answer Q3, **rental security deposits are out of v1**: there is no distinct "returned, never revenue" tender or label, the tender CHECK of ADR-0025 D1 is not widened, and the deposit of this ADR is always an earned part of the price that a refund may return under ADR-0033.

### D9 — The "no payment-service activity" non-goal is intact

A deposit session charges the **merchant's own order** through the merchant's own gateway account; the platform observes the provider's confirmation and records a ledger fact. It never holds, transmits or disburses customer funds, a deposit is not stored value held for a third party (contrast ADR-0030), and nothing here changes that model. A change of that model still triggers its own legal assessment.

## Security and control mapping

This ADR **resolves threat-model control C-07** ("Deposit amount guard"): the expected deposit is server-computed per session (D1), compared in integer cents and never taken from the provider or the client (D2), and the ordinary order guard is unchanged (D3). The remaining evidence C-07 asks for is the implementation's tests: a mismatch test, a partial-payment (deposit then balance) test, a regression test that whole-total orders are still guarded, a replay test that a deposit credits once, and a concurrent webhook-versus-cash test that ends `overpaid` rather than lost or double-counted. Related controls are unchanged: C-06 (token, signature, replay) and the staff-cannot-type-gateway rule.

## Consequences

- Positive: the booking deposit and balance can use the gateway; the guard stays an equality check against a number only the server computed; whole-total orders and every existing payload are untouched; no new tender, no new ledger and no change to how settlement is derived.
- Cost: one table change to the session (purpose, expected amount, a freeze trigger) and a read of it in the webhook and reconcile paths; a per-product policy field and the order-time derivation of `dp_amount`; a new settlement event and an earner branch; storefront and admin wording for the in-between state.
- Risk accepted and recorded: because a manual leg may land while a session is live, a rare double payment surfaces as `overpaid` for an operator to reverse, consistent with ADR-0025 D5, rather than the platform refusing a cashier.

## What is not here yet

This ADR changes no code. Left to follow-up issues: the session columns and freeze trigger (a migration from 1001 onward, ADR-0037), the per-product deposit policy and its admin field, the order-time `dp_amount` derivation, the gateway-port change to send the session amount, the storefront and POS wording, the settlement event and earner branch (with #355), the points-with-deposit refusal, the OpenAPI contract for the session purpose (draft in #358), and the tests listed above. Until they land, ADR-0025 D7 describes what is built.
