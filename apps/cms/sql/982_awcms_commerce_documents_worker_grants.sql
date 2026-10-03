-- `data-lifecycle:archive-purge` runs as `awcms_worker` (`WORKER_DATABASE_URL`)
-- and, for an `executionMode: "generic"` descriptor, issues a SELECT of
-- candidates by `(tenant_id, <cursor>)` and a `hard_delete` DELETE. Issue
-- #286's descriptors (`commerce/domain/documents-lifecycle.ts`, ADR-0029)
-- declare exactly that shape for the sequence, held-sale, quotation, version,
-- work-order, event and document tables, so the grants must exist
-- (`data-lifecycle:worker-grants:check`) — `sql/937`/`sql/942`/`sql/973`'s
-- reasoning. No UPDATE: the engine never rewrites these rows, and the guard
-- triggers of `sql/980` would refuse it anyway.
--
-- The document-sequences table IS here, and that is safe by construction: a
-- counter row is keyed by (tenant, type, UTC year) and allocation only ever
-- touches the row of the CURRENT year, so a counter whose last bump is older
-- than the descriptor's floor (366 days, default ten years) belongs to a year
-- that is over and can never be allocated from again. Deleting it cannot
-- restart a number; the unique indexes on the numbered tables would refuse a
-- duplicate in any case.
-- `awcms_app` LOSES DELETE on every table of this feature (`sql/980`'s
-- REVOKEs): the role that issues a legal document must not be the role that
-- can erase one; only the retention engine, past the fiscal horizon, may.
GRANT SELECT, DELETE ON awcms_commerce_document_sequences TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_held_sales TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_quotations TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_quotation_versions TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_work_orders TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_work_order_events TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_documents TO awcms_worker;
