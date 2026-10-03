-- `data-lifecycle:archive-purge` runs as `awcms_worker` (`WORKER_DATABASE_URL`)
-- and, for an `executionMode: "generic"` descriptor, issues a SELECT of
-- candidates by `(tenant_id, <cursor>)` and a `hard_delete` DELETE. Issue
-- #284's six register tables each declare exactly that shape in
-- `commerce/module.ts` (ten-year ceiling, five-year floor), so the grants must
-- exist (`data-lifecycle:worker-grants:check`) — `sql/937`/`sql/942`'s
-- reasoning. No UPDATE: the engine never rewrites these rows, and the append-
-- only triggers of `sql/970` would refuse it. `awcms_app` keeps INSERT/UPDATE
-- where the table is mutable and LOSES DELETE everywhere (`sql/970`'s
-- REVOKEs): the role that runs a shift must not be the role that can erase
-- one; only the retention engine, past the fiscal horizon, may.
GRANT SELECT, DELETE ON awcms_commerce_registers TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_register_sessions TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_register_movements TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_register_close_requests TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_register_close_lines TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_register_corrections TO awcms_worker;
