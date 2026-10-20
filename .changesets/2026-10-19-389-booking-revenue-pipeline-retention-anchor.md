---
bump: minor
type: content
impact: public
---

# Booking-commerce adapter: booking-sourced revenue waterfall, hold pipeline, no-show figures and the booking anchor of retention (issue #389, ADR-0045)

Behind the tenant's `booking` feature (**default OFF**; a tenant that never turns it on sees no change, and the retention booking anchor only matters to a tenant that sells bookings). Commerce half of epic #280 items 10 and 18; Booking's own occupancy and utilisation stay upstream (`ahliweb/awcms#944`). On the `reporting` engine, no second analytics store, migration `sql/1047` only.

- **Revenue waterfall** (`commerce.booking_revenue`): revenue follows the commerce order and the payment ledger only. Per booking-sourced paid order (an order with a reservation link, or the supplementary order of a stay that grew) one row is RECOMPUTED from the order, the ledger and the adapter's refund decisions, so a day is the sum of its rows: gross recognised once on the Asia/Jakarta day of the first paid transition (a deposit order's whole gross on the deposit day), discounts, Refunds as the money paid back plus the unpaid balance of a cancelled or no-show order ("uncollected balance, no money moved") on the ORIGINAL day, net, the shipping / insurance / tax companions, and the balance still outstanding beside the waterfall. A late refund or a no-show restates the original day; a day older than 35 days that a late event changed is flagged `restated`. A rebuild equals the live table byte for byte.
- **No-show figures** joined through the order (count, retained amount, rate against the stays of the day) and the **hold pipeline** (held nights and slots, their value, the oldest hold, the next expiry) as a live read-only query, not a projection.
- **Retention booking anchor**: a paid order carrying a reservation link is ONE booking event; a reschedule's replacement and the supplementary order of a stay that grew are the same stay (not a repeat), a cancelled stay is no event, a no-show still is one. The cohort report gains `bookingAnchored` and the retention panel a "Began with a booking" column. The descriptor is version 2: a tenant that already sold bookings runs one rebuild of `commerce.customer_retention`.
- **Reading**: `GET /api/v1/reports/commerce/booking-revenue` (`?from&to`) and `GET .../booking-pipeline` on `reporting.dashboard.read` (no new permission), `200 enabled: false` while `booking` is off, and a panel on `/admin/commerce-reports`. The per-day aggregates are also written by the generic projection export. The three rows of the metrics deposit example and the villa week (net 5,150,000) are asserted to the cent against the real adapter flows.
- **Schema** (`sql/1047`): `awcms_commerce_report_booking_orders`, `awcms_commerce_report_booking_restated`, the `awcms_commerce_report_src_booking_legs` view, two columns on the retention row, the worker grants.

Not here: a CSV route for the waterfall, the by-refund-day cash view, ADR and RevPAN as stored figures (they take Booking's nights), channel and segment slices, and the owner's answer on whether a pending refund leg counts before it settles.
