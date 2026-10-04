---
"awcms": minor
---

feat(commerce): POS operational reports as reporting projections (Issue #296, epic #281)

Five new `commerce` `reportingProjections` on the existing reporting engine (no new engine): `commerce.pos_tender_daily`, `commerce.pos_cash_up_variance`, `commerce.pos_expense_daily`, `commerce.pos_loyalty_daily`, `commerce.pos_stored_value_daily`. Tables `awcms_commerce_report_{tender_daily,cash_up_tenders,expense_daily,loyalty_daily,stored_value_daily}` and four `security_invoker` source views `awcms_commerce_report_src_{allocations,close_decisions,expenses_posted,expenses_reversed}` (`sql/998`: FORCE RLS with `WITH CHECK`, additive upserts, four partial cursor indexes on the source tables, `awcms_worker` grants mirrored in `security-readiness.ts`; `sql/999`: ten permission rows). The views exist because the engine's rebuild scan has no `IS NOT NULL` predicate and resets its cursor to the epoch on a NULL cursor value — a table whose cursor is NULL until the fact happens (`settled_at`, `decided_at`, `posted_at`, `reversed_at`) must be read through a view that filters them out (ADR-0035 D3).

New endpoints (all `reporting` work class, `?from&to` at most 366 days, `400 VALIDATION_ERROR` only after the permission check; a family whose feature — `register`, `expenses`, `loyalty`, `storedValue` — is OFF answers `200` with `enabled: false`):

- `GET /api/v1/reports/commerce/operational-tenders` (`commerce.report_tenders.read`), `operational-cash-ups` (`commerce.report_cash_ups.read`), `operational-expenses` (`commerce.report_expenses.read`), `operational-loyalty` (`commerce.report_loyalty.read`), `operational-stored-value` (`commerce.report_stored_value.read`)
- the same five with a `.csv` suffix (`commerce.report_*.export`, high-risk; formula-neutralised via `csvCell`/`csvNumber`, `no-store`, audited as `operational_report.export`)

`/admin/commerce-reports` renders five panels through `src/components/CommerceOperationalReports.astro`; the freshness and export-run panels list the new projections. Ten new permissions, existing `AccessAction` verbs only (the upstream-owned union is not widened). Retention (cursor `day`, 3650 days) and subject-data descriptors in `domain/operational-report-lifecycle.ts`. No domain events added.

Tests: `tests/commerce-operational-report-domain.test.ts`, `tests/commerce-operational-report-permissions.test.ts`, `tests/integration/commerce-operational-reports.integration.test.ts` (live = rebuild byte for byte, reconcile tamper and drift detection, late events, timezone boundary, feature off, RLS) and `tests/integration/commerce-operational-reports-routes.integration.test.ts` (permission matrix, BOLA, CSV neutralisation, audit).
