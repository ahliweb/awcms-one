---
bump: minor
type: structure
impact: public
---

# Returns & refunds operational report (issue #316, ADR-0035 addendum)

The POS operational reports shipped without returns because returns did not exist yet. They do now (issue #287), and the same screen should answer the questions a shop asks about them: how many returns this week, how much stock went back on the shelf versus was written off, and how much money went back, by which payment method — and how much of it was kept as store credit instead. One new `reporting` projection on the existing engine (migrations `945`–`946` under `apps/cms/sql/`, starting at `apps/cms/sql/945_awcms_commerce_returns_report_schema.sql`). Decision and numbering rationale: the addendum to `docs/adr/0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md`.

- New: `commerce.pos_returns_daily` — returns and exchanges recorded (count and refund total), returned lines by stock disposition (restocked, written off, quarantined: lines, units, value) and settled refund legs by tender and destination (original tender or store credit), per day and register, in exact cents, days bucketed in `Asia/Jakarta`. A return lands on the day it was recorded and the register of the original sale; a refund on the day it settled. Rebuildable (a rebuild reproduces the live rows byte for byte) and reconcilable like the other six.
- New endpoints, `GET /api/v1/reports/commerce/operational-returns` and `.csv` (`?from&to`, at most 366 days). The CSV is one long file with a `section` column, formula-neutralised, `no-store`, audited as `operational_report.export`. `/admin/commerce-reports` gains a Returns and refunds panel for holders of the new permission.
- Two new permissions, `commerce.report_returns.read` and the high-risk `commerce.report_returns.export`, not implied by `reporting.dashboard.read`, `commerce.returns.read` or `commerce.refunds.read`. Existing tenants do not gain them retroactively — grant them to the roles that should see the report.
- **Backward compatible, opt-in by feature.** While the `returns` feature (default OFF) is off the report answers `200` with `enabled: false` and no rows, and its CSV is a header row. The projection fills on the next `reporting:projections:refresh` (or an on-demand rebuild) — nothing is backfilled by the migration.
- Hardening: one new table with FORCE RLS and `WITH CHECK` and CHECKs pinning its section, bucket and detail; `awcms_worker` grant asserted in `security-readiness.ts`; retention (3650-day ceiling) and subject-data descriptors (no person column).
