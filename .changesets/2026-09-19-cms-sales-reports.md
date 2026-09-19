---
bump: minor
type: structure
impact: public
---

# Sales reports — three commerce reporting projections over order events + reports screen (C8)

Issue #117 (part of epic #33, C8; contract #106's D7, ADR-0017). `commerce`
contributes three `cursor_table` projections to the `reporting` module's generic
projection engine (Issue #753) from its own `module.ts` (`reportingProjections`):
`commerce.sales_daily`, `commerce.sales_by_product`, `commerce.sales_by_category`,
all over the append-only `awcms_commerce_order_events` log. The engine keeps its
cursor, freshness, rebuild, reconciliation and export machinery; `commerce`
supplies the descriptor, the pure delta rules and the sinks.

**Why a projection and not a live `GROUP BY`.** A sales report that re-aggregates
every order on each page view costs what the order table costs; a projection costs
one bounded pass per worker tick and answers from a table the size of the calendar.
The event log is the right source because it is the ONE append-only record of
"this order became paid / stopped being paid", which is exactly the property the
`cursor_table` strategy needs to be correct.

**Delta rules** (`domain/sales-report-deltas.ts`, pure): `-> paid` from a
not-yet-paid state adds the order's totals (gross = subtotal, discount = order +
voucher discount, shipping, net = total) and its lines per product and per
category; `-> cancelled|refunded` from a paid state subtracts them; every other
transition is a no-op — including a cancellation of a never-paid order and a refund
after a cancellation, so an order is never subtracted twice. Everything is
attributed to the day of the order's `paid_at` in `Asia/Jakarta`, so a reversal
lands on the same day row as its payment and `net` is a true per-day net.

**Schema** (`apps/cms/sql/933_awcms_commerce_reporting_projections_schema.sql`):
`awcms_commerce_sales_daily` (day, orders_paid, gross, discount, shipping, net),
`awcms_commerce_sales_by_product` (day, product_id, name snapshot, qty, gross),
`awcms_commerce_sales_by_category` (day, category_id, name, qty, gross) — all
`FORCE RLS`, upserted with additive deltas by primary key; `awcms_worker` gets
`SELECT, INSERT, UPDATE, DELETE` (mirrored in `WORKER_ROLE_GRANTS`); retention
answered by three `dataLifecycle` descriptors (cursor `day`, the same 3650-day
ceiling as `commerce.order_events`), subject data by `NO_SUBJECT_DATA` (derived,
rebuildable aggregates about nobody).

**One additive engine extension** — `MODULE_CONTRACT_VERSION` 4.1.0 → 4.2.0:
`ProjectionCursorStream.dimensional` (`selectColumns` + `applyBatch`, called by the
incremental worker AND the rebuild pass on every fetched batch, inside the same
bounded transaction, before the cursor advance) and
`ProjectionDescriptor.dimensional` (`resetForTenant` in the rebuild reset's own
transaction; `readProjectionTotals`/`computeSourceTotals` merged into
reconciliation; `exportRows` so exports carry the rows, not a metric snapshot).
`reporting:projections:registry:check` refuses a sink without the contract and vice
versa. No existing descriptor changes.

**Read routes** (`reporting.dashboard.read`, `defineTenantRoute`, `reporting` work
class): `GET /api/v1/reports/commerce/sales-daily?from&to`,
`sales-by-product?from&to&limit`, `sales-by-category?from&to` — owned by `commerce`
via `api.routes: ["/api/v1/reports/commerce"]`, documented in
`openapi/modules/commerce.openapi.yaml`, and their three `ROUTE_PARITY_EXEMPTIONS`
entries from the #106 contract-only PR are removed.

**Admin screen** `/admin/commerce-reports`: a GET date-range form, the three tables,
projection freshness (`reporting.projections.read`), an **Export CSV** button per
projection that POSTs to the real `/api/v1/reports/exports/trigger`
(`reporting.exports.export`), and the recent export runs with checksum-verified
download links (`reporting.exports.read`). English + Indonesian strings; nav entry
under Commerce.

**Tests**: pure delta rules + registry pairing (`apps/cms/tests/commerce-sales-report-domain.test.ts`);
against a real Postgres under the unprivileged role
(`apps/cms/tests/integration/commerce-sales-reports.integration.test.ts`): paid → rows,
cancel-after-paid → subtracted on the same day, rebuild byte-equal to live,
reconcile with no mismatch (a tampered table IS flagged), tabular export, RLS.

**Known limitation, stated**: order items snapshot the product name but not its
category, so by-category attribution reads the product's category at processing
time; a rebuild after a recategorisation re-attributes past sales. The control
totals are category-agnostic, so this never reads as a reconcile mismatch.

Docs: `docs/cms.md` "Sales reports", `docs/skema-basis-data.md` "Sales-report
projections", the commerce and reporting module READMEs, plus Indonesian mirrors.
