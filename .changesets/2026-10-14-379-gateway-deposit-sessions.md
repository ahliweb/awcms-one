---
bump: minor
type: content
impact: public
---

# Gateway deposit sessions and mixed tenders over time on one order (issue #379, ADR-0041)

A down-payment order (`payment_method = 'dp'`, `dp_amount` below the total) can now take its deposit, and later its balance, through the payment gateway as well as at the counter, in any order. A tenant that never creates a deposit session sees **no change**: the whole-total gateway path is the code that existed before, every existing test for it passes unchanged, and no whole-total order can obtain a deposit or balance session.

- A hosted-checkout session carries a `purpose` (`full`, `deposit`, `balance`) and a server-computed `expected_amount` (`sql/1025`, frozen by a trigger). `POST /api/v1/commerce/storefront/orders/{orderCode}/payment-gateway/sessions` takes an optional `purpose` (default `full`); the client never supplies an amount (a body naming `amount`, `expectedAmount` or `grossAmount` is `400`), the server computes it under the order-row lock from the ledger and sends exactly that to the provider. The `201` adds `purpose` and `expectedAmount` for a deposit/balance session only. New `409` codes: `PURPOSE_NOT_ALLOWED` (`details.allowed`) and `SESSION_IN_PROGRESS` (one live session per order).
- **Control C-07.** The webhook and reconcile guard compares the provider's `gross_amount` with the session's frozen expected amount in integer cents, in both directions; a mismatch is recorded as `amount_mismatch`, audited, and credits nothing. A `full` session is still checked against the order total. A replayed webhook, a re-delivery under a new event key and the reconcile job racing the webhook credit once; a cash payment that lands while a session is live is recorded, and any excess surfaces as `overpaid`.
- The order detail and the order payments read add the derived `deposit`, `balanceDue` and `settledAt` to `settlement`; the admin order screen shows the deposit and the date the order was fully settled.
- **Loyalty.** A deposit order earns points only at full settlement (owner answer Q5): the ledger write that makes the outstanding amount zero emits the new `awcms.commerce.order.settled` event once, the earner subscribes to it, and a deposit alone earns nothing. A whole-total order emits no settled event and earns at `order.paid` as before.
- Migration `1025`, OpenAPI and AsyncAPI updates, en/id strings, and ADR-0041's implementation record. The `awcms.commerce.order.settled` name and the deposit-session error codes are the ones the booking adapter drafts were waiting for.
- Not here yet (ADR-0041): the per-product deposit policy and the order-time `dp_amount` derivation (a `dp` order still uses the store-wide down-payment percentage), a staff-started deposit/balance session route, and storefront and POS wording for the in-between state.
