---
bump: minor
type: content
impact: public
---

# Booking-commerce adapter: reschedule with the price difference carried by the order and refund paths, and staff no-show (issue #382, ADR-0045)

Behind the tenant's `booking` feature (**default OFF**; a tenant that never turns it on sees no change). Staff can now move a confirmed booking to new dates, and mark a guest who did not arrive, without the order ever being edited.

- **Reschedule** (`commerce.booking_reservation_links.update`): `POST .../reservations/{id}/reschedule` and a non-binding `GET .../reschedule-quote` (staff only; a customer asks, staff move it). The order keeps TWO references that move together in one guarded transaction - the old reservation link is superseded, a new one points at the same order and line, Booking carries its own reference - and a Booking refusal (the new dates are taken) or an unsellable supplement rolls everything back to the untouched original. The request never carries a price (`amount`, `price`, `refund`, `orderId` and the like are `400`); the server prices the difference in integer cents: the same length changes nothing, more nights become a supplementary order paid through the ordinary payment paths (no new payment flow), fewer nights become pending refund legs of a return of kind `cancellation`, limited by the policy version of the ORIGINAL booking from the ORIGINAL arrival, so a chain of reschedules can neither extend the window nor change the version. The paid order, its lines and its payment allocations are never edited. It is idempotent (`Idempotency-Key`, namespaced by the actor), and a concurrent reschedule and cancel of one booking queue on the order lock.
- **No-show**: `POST .../reservations/{id}/no-show` (the two keys a cancel needs; a cashier cannot). Booking measures the arrival plus the grace (`409 NO_SHOW_TOO_EARLY`). What is kept is the `no_show_retention` rule of the policy version in force when the booking was made; NO refund leg is ever created (the decision's refunds are zero by a CHECK and a trigger refuses to give it a return). One audit event records the amount paid, the amount retained and the policy version.
- **Order detail**: the booking panel gains a reschedule dialog (the earliest date comes from the server's clock; "Check the price" shows only the server's answer), the reschedule history with its extra orders, and a no-show control with a confirm dialog that says nothing is refunded.
- **Schema** (`sql/1045`): the append-only `awcms_commerce_booking_reschedules` record, `retained_amount` on the refund decision, the permission key, the worker grant. New event `awcms.commerce.booking_reservation.rescheduled`; consumers `commerce.booking_rescheduled_link_reconciler` (repairs a reschedule made in Booking's own screen to two references) and `commerce.booking_no_show_decision_recorder`; three new reconciliation findings. The client asset budget is raised to 487,000 B with its measurement in the constant's docblock.

Not here: a customer reschedule request, the POS check-in (#383), and automatic refund of a paid supplementary order when the booking is cancelled.
