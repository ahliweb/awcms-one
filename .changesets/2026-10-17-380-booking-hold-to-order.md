---
bump: minor
type: content
impact: public
---

# Booking-commerce adapter: hold-to-order, deposit-threshold confirm and the booking consumers (issue #380, ADR-0045)

A shopper or a staff member can hold a Booking slot or stay and get the commerce order from it in one idempotent call, and the two stay in step. A tenant that never turns on the `booking` feature (**default OFF**) sees **no change**: the new routes answer `409 FEATURE_DISABLED` (staff) or the neutral `404` (storefront), and no ordinary cart, order, quote or return behaves differently - a tenant with no deposit-policy row keeps today's store-wide down-payment rule byte for byte.

- **Routes** (`sql/1041` registers `commerce.booking_reservation_links.{read,create}`): `POST /api/v1/commerce/storefront/booking/reservations` (anonymous guest or `customerBearer`) and `POST /api/v1/commerce/booking/reservations` (staff) write the hold, the order and the reservation link in ONE transaction; `GET /api/v1/commerce/booking/reservations/{id}` (staff), `GET /api/v1/commerce/storefront/booking/reservations/{orderCode}` (the shopper's own, by bearer or phone) and `GET /api/v1/commerce/booking/reconciliation` (threat control C-09: paid-without-confirm, confirmed-without-deposit). The price is the linked product's, never the client's (a body naming a price, amount, deposit or customer is `400`); the order expires with the hold; the `Idempotency-Key` is namespaced by who asks and replays the same order; refusals are returned values that write nothing; the product's stock counter is not moved. Booking sees the acting staff member, or the tenant's service-account user for a shopper.
- **Deposit rule** (decision G10): the cart quote derives `dp_amount` from the product's deposit policy (percent of the taxed line, or a fixed amount per night), policy row first.
- **Five consumers**: the order is confirmed when it reaches its release threshold; a Booking `expired` or `cancelled` event closes the UNPAID order; an unpaid booking order cancelled through the generic path frees its hold; a payment landing on a dead reservation is flagged. An order that holds money is **never auto-cancelled**: an attention flag and the new event `awcms.commerce.booking_reservation_link.attention_raised` ask an operator instead (control C-08).
- **Guards**: a product with an active offering link cannot be sold through the ordinary cart, storefront order, quotation or POS path; a booking order that holds money is refused by the generic admin cancel, customer cancel and returns with `409 BOOKING_ORDER_USE_ADAPTER`.
- **Operators:** the consumers call `BookingPort`, which `awcms_worker` cannot, so `domain-events:dispatch` must run with the application role (no least-privilege `WORKER_DATABASE_URL`) until upstream offers a worker-callable confirm and cancel.

Not here: storefront availability and offering reads (upstream port addition U1), the POS variant, cancellation and refunds, reschedule, no-show, check-in and every screen. Docs: `docs/api.md`, `docs/status.md`, the contracts page, the ADR-0045 implementation notes and the commerce README.
