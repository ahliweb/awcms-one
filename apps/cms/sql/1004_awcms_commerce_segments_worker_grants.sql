-- `data-lifecycle:archive-purge` runs as `awcms_worker` (`WORKER_DATABASE_URL`)
-- and, for an `executionMode: "generic"` descriptor, issues a SELECT of
-- candidates by `(tenant_id, <cursor>)` and a `hard_delete` DELETE. Issue
-- #360's two segment tables each declare exactly that shape in
-- `commerce/domain/segment-lifecycle.ts`, so the grants must exist
-- (`data-lifecycle:worker-grants:check`) - `sql/973`'s reasoning. No UPDATE:
-- the engine never rewrites these rows. `awcms_app` has lost DELETE on both
-- (`sql/1001`'s REVOKEs); the cursor column (`deleted_at`) is never set by this
-- module, so the purge predicate cannot match and a referenced version is
-- never removed.
GRANT SELECT, DELETE ON awcms_commerce_segments TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_segment_versions TO awcms_worker;
