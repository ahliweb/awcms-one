-- `data-lifecycle:archive-purge` runs as `awcms_worker` (`WORKER_DATABASE_URL`)
-- and, for an `executionMode: "generic"` descriptor, issues a SELECT of
-- candidates by `(tenant_id, <cursor>)` and a `hard_delete` DELETE. Issue
-- #287's four tables each declare exactly that shape in
-- `commerce/domain/returns-lifecycle.ts` (ten-year ceiling, five-year floor),
-- so the grants must exist (`data-lifecycle:worker-grants:check`) —
-- `sql/937`/`sql/942`/`sql/988`'s reasoning. No UPDATE: the engine never
-- rewrites these rows. `awcms_app`, by contrast, LOSES DELETE on all four
-- (sql/994's REVOKEs): the role that runs the till must not be the role that
-- can erase a refund; only the retention engine, past the fiscal horizon, may.
GRANT SELECT, DELETE ON awcms_commerce_returns TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_return_lines TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_refunds TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_refund_compensations TO awcms_worker;
