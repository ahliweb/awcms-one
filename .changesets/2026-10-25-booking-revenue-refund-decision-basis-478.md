---
bump: minor
type: content
impact: public
---

# Booking revenue: refunds on a decision basis, tax-aware allocation, cash view and CSV

Implements the owner decisions for #450 (metrics section 3.9, ADR-0045) in the `commerce.booking_revenue` projection. Migration `sql/1055`, additive, no down migration. The descriptor goes from version 1 to 2 (the issue said "v2 to v3"; the booking descriptor was at version 1), so a tenant that already sold bookings runs one rebuild of `commerce.booking_revenue`.

- **A refund counts when it is decided.** The Refunds step is built from the order's return records: three parts that add up (paid back, payable, uncollected balance) and a new companion column, the refund still payable. Settling a refund leg moves cents from payable to paid back and never moves net. All parts still land on the original paid day.
- **Tax-aware allocation.** Each refund and each uncollected amount is allocated across goods, shipping, insurance and tax in integer cents with the largest-remainder function the returns module uses (an exact split on a return record wins). Only the goods share is in the Refunds step; the others lower their own companion columns, so a full refund of a taxed order gives net 0 and tax 0, never a negative net.
- **Control identity.** `net + shipping + insurance + tax (each after its refunded share) = settled - refund payable + outstanding - surplus`, per order and in the reconciliation's control totals (new keys: refund payable, net, companions, surplus).
- **New routes** on `reporting.dashboard.read`: `GET /api/v1/reports/commerce/booking-revenue-cash` (the cash view of refunds by the day they were paid out, labelled `basis: "cash"`) and `GET /api/v1/reports/commerce/booking-revenue.csv` (the waterfall as a formula-neutralised CSV, audited as `booking_revenue_report.export`). The report JSON gains `refundsPayable`, `refundPayableBalance` and `basis`; the companions are now after their refunded share. The `/admin/commerce-reports` panel shows the three parts, the companions, the refund payable, a CSV link and the cash table, and says the figure is an operational sales measure, not a financial-statement figure.
- **Rollout.** The migration seeds the goods shares of existing rows from their money columns so a tenant that has not rebuilt reads as before; `POST /api/v1/reports/projections/commerce.booking_revenue/rebuild` re-derives every row (equal to the live table byte for byte, repeatable).
- Not here (decided in #450): ADR and RevPAN as stored figures, channel and segment slices.
