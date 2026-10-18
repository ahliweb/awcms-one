---
bump: minor
type: content
impact: public
---

# A cancelled or refunded counter sale voids its commission (issue #391 second half, ADR-0046 D9)

The reversal half of the `commerce` employee-commission adapter, on top of upstream's `CommissionAccrualPort.void` (contract 1.1.0, ahliweb/awcms#1109). Nothing changes for a tenant that never enabled the adapter.

- Two descriptor-declared domain-event consumers, default `runtime_effect_once`: `commerce.order_cancelled_commission_reverser` (`awcms.commerce.order.cancelled`, every line of the order) and `commerce.refund_settled_commission_reverser` (`awcms.commerce.refund.settled`, each line of the completed return that is now fully returned). They void by the same source identity `(sourceType, order id, order-line id)` the accrue used, read the database and never the payload, and try every employment the login was ever linked to (a link retired between the sale and its refund does not strand the accrual). Replays are one void, one transition, one `awcms.hr.commission.voided` event.
- **A partly returned line keeps its accrual** until the last unit is returned: the port voids a whole accrual and a voided accrual is never resurrected, so the conservative option is chosen and the case is flagged, not silent.
- **`period_closed`** (the accrual is already `payable` or `paid`) is never retried and never thrown: one `commerce.commission.reversal_needs_attention` warning audit row (counts only, no amount, source reference, accrual or employment id) is the work item for a person. A new void writes `commerce.commission.reversed`.
- The voider stamped on the ledger is the tenant user who last saved the commission settings (a consumer has no acting user; none means `actor_required` and the reversal waits for a person). A reversal needs `hr_commission` on and the adapter configured once, not `enabled`.
- Migration `1051` gives `awcms_worker` `UPDATE (status, voided_at, voided_by, void_reason_code)` on the ledger's accruals and nothing else: it still cannot approve, pay, rewrite an amount or delete. Commerce still reads no commission table, and the AGENTS.md divergence list does not grow.
- Not here: a clawback of a closed-period accrual, a pro-rata reversal of a partly returned line, the admin screens.
