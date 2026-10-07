---
bump: minor
type: structure
impact: public
---

# A return refunds the tax on the returned units (issue #323, ADR-0033 addendum)

A return's `refund_total` was goods less discount plus shipping, pinned by a `CHECK` with no tax term. The customer was never given back the tax charged on the units they returned (flat mode), and in engine mode (ADR-0039) the tax ledger reversed an amount the refund money did not include. A return now carries a `tax_refund` component and `refund_total` is `goods_gross - discount_share + shipping_refund + tax_refund`.

- New: `sql/1000_awcms_commerce_returns_tax_refund.sql` (the first number of the four-digit continuation band, ADR-0037 amended). It adds `awcms_commerce_returns.tax_refund` (default `0.00`, so every existing return stays valid), re-adds the amounts `CHECK` by name with the extra term, adds `tax_refund` to the immutable columns of the update guard, and makes the insert guard refuse a return that would refund more tax than the order was charged.
- Flat mode (and an engine-mode order with no tax snapshot): the order's tax is prorated per unit with the same decomposition as goods and discount (`allocateOrderTax` reuses `allocateOrderDiscount`; units carry leftover cents first), so the parts of every return of an order add up to the order's tax to the cent and the order's whole total is back once every unit is returned.
- Engine mode, exclusive pricing: `tax_refund` is exactly the reversal snapshot's tax total, so the money refunded and the tax ledger agree. Inclusive pricing adds nothing (the tax is inside the goods value already refunded); the ledger still reverses it.
- The reversal now happens before the refund is planned and, in engine mode, inside a savepoint that a refused refund rolls back, so a refusal leaves no reversal snapshot behind. A replayed `Idempotency-Key` still reverses and refunds nothing twice.
- The refund legs, the payment-ledger reversals, the loyalty and affiliate compensations, the sales-report projections and the returns report (`returnedValue` equals `refundedTotal`) all follow `refund_total`; no projection table changed.
- API: return records and `awcms.commerce.return.recorded` gain `taxRefund`; `refundTotal` now includes it. Admin: the returns panel shows "Tax refunded". No new client script.
- Not changed: the insurance fee is still not refunded; `return_lines.refund_amount` stays goods less discount.
- **Backward compatible** for stored data. A client that recomputed `refundTotal` as goods - discount + shipping must add `taxRefund`.
