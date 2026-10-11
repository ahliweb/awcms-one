---
bump: minor
type: content
impact: public
---

# Commerce customer-retention report (commerce-only projection)

Issue #364 (epic #280, Wave B), [ADR-0044](../docs/adr/0044-customer-retention-is-a-per-customer-recompute-projection-on-the-reporting-engine.md). The 90-day repeat rate of customer cohorts, built as a `reporting` projection over commerce orders - no second analytics store.

- A cohort is the `Asia/Jakarta` month of a customer's first qualifying paid order; the repeat must be a distinct order within 90 x 24 hours of it. A cohort is "to date" until its window has elapsed, shows counts and no percentage under 20 customers, and is flagged restated when a late event changes it after 35 days.
- Recompute, not increment: a refunded first purchase or a cancelled repeat moves the customer correctly, and a rebuild reproduces the live table byte for byte. Migrations `1020`-`1021`.
- `GET /api/v1/reports/commerce/retention` (and `.csv`) under the new `commerce.report_retention.read|export` permissions, behind the per-tenant `retention` feature, which defaults OFF. A panel on `/admin/commerce-reports`.
- The booking input, a CRM win-back list and a configurable window are not here.
