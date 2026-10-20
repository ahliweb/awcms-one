---
bump: patch
type: content
impact: internal
---

# Booking orders earn loyalty points at full settlement: integration proofs (issue #384, ADR-0045)

No behaviour change. A real-PostgreSQL integration suite proves that an order created from a Booking hold with a deposit policy earns nothing at the deposit, earns once on the whole total at full settlement (key `earn:order:<id>`, ledger shape unchanged), earns once however often `order.paid` or `order.settled` is replayed, is reversed by a compensating `reversal:refund:<id>` row on refund, and can never carry points together with a deposit (Q8, C-33). The booking `cancellation` return kind and its loyalty coverage stay with issue #381.
