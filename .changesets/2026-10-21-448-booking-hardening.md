---
bump: patch
type: fix
impact: public
---

# Booking adapter hardening from the wave C review (#448)

Low-severity findings of the wave C review, each verified against the code first. Two items of the issue (the deposits screen limit and the focus after a reload, from #423) are left to their own follow-up.

- The guest cancel route's per-phone rate limit is keyed on the phone plus the order code, with a coarser per-phone ceiling (ten times the budget), so a stranger who only knows a phone number can no longer exhaust the guest's own budget for their reservation. Bearer cancels are unaffected.
- `sql/1054` narrows the register-session ledger guard: the booking-balance exception now also needs the `posbal:<link id>:` marker the balance route writes, naming an active link of the same order.
- A reschedule that would plan refund legs (fewer nights) also needs `commerce.booking_refund_decisions.create` (403 before any write); same-length and longer moves still need `.update` only.
- Storefront availability for an offering link that names no resource now answers a neutral 404 for a resource that is not an active resource of the tenant in the offering's mode, as the bound path does; a bound resource that was since retired is the same 404.
- An active link on a cancelled or expired booking order stays active by design (the late-payment flagger and the reconciliation read it); documented and pinned by a test.
- Tests: a parallel same-key hold-to-order test, the cancel limiter, the POS guard marker, the reschedule permission and the availability resource check. Docs: ADR-0045 implementation notes (en and id), the restore-drill runbook note about `SETUP_DATABASE_URL`, and the benchmark commit reference.
