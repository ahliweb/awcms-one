---
bump: patch
type: docs
impact: internal
---

# ADR-0045: booking-commerce adapter

Docs only (ADR-0040 D7): no code, migration, permission or OpenAPI path. Resolves issue #376 and ends the "pending" status of the four booking-commerce drafts (data model, access matrix, contracts, UX flows), whose open-points sections now point to the ADR.

- One active product per offering and vice versa; composite foreign keys to Booking with a verification precondition; the customer stays derived through the order and Booking's `external_customer_ref` stays unset.
- Cancellation refund legs ride a new returns `kind = 'cancellation'`; the deposit policy row is the only deposit authority and `allow_dp` becomes a mirror; no active policy refunds nothing (owner may revise).
- The refund override is an inline parameter of the staff cancel, behind step-up; a customer cancel plans refund legs under a system actor; the adapter-owned error codes and the six `commerce.booking_*` consumer names are frozen.
- A reschedule keeps the stay length in v1 (difference zero; a supplementary order is the decided vehicle for later); check-in with an unpaid balance is a tenant setting, default allowed (owner may revise). Control C-20 re-run: pass.
