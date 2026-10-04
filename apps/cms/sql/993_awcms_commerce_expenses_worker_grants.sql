-- `data-lifecycle:archive-purge` runs as `awcms_worker` (`WORKER_DATABASE_URL`)
-- and, for an `executionMode: "generic"` descriptor, issues a SELECT of
-- candidates by `(tenant_id, <cursor>)` and a `hard_delete` DELETE. Issue
-- #294's two expense tables each declare exactly that shape in
-- `commerce/domain/expense-lifecycle.ts` (ten-year ceiling, five-year floor), so
-- the grants must exist (`data-lifecycle:worker-grants:check`) - `sql/973`'s
-- reasoning. No UPDATE: the engine never rewrites these rows. `awcms_app` has
-- lost DELETE on both (`sql/990`'s REVOKEs): the role that records an expense
-- must not be the role that can erase one; only the retention engine, past the
-- fiscal horizon, may.
GRANT SELECT, DELETE ON awcms_commerce_expense_categories TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_expenses TO awcms_worker;
