-- `data-lifecycle:archive-purge` runs as `awcms_worker` (`WORKER_DATABASE_URL`)
-- and, for an `executionMode: "generic"` descriptor, issues a SELECT of
-- candidates by `(tenant_id, <cursor>)` and a `hard_delete` DELETE. Issue
-- #288's three stored-value tables each declare exactly that shape in
-- `commerce/domain/stored-value-lifecycle.ts` (ten-year ceiling, five-year
-- floor), so the grants must exist (`data-lifecycle:worker-grants:check`) —
-- `sql/937`/`sql/942`/`sql/973`'s reasoning. No UPDATE: the engine never
-- rewrites these rows, and `sql/985`'s triggers would refuse it. `awcms_app`,
-- by contrast, LOSES DELETE on all three (sql/985's REVOKEs) and UPDATE on
-- the ledger: the role that runs the till must not be the role that can erase
-- a liability record; only the retention engine, past the fiscal horizon, may.
GRANT SELECT, DELETE ON awcms_commerce_stored_value_programs TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_stored_value_accounts TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_stored_value_ledger TO awcms_worker;
