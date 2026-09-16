-- `commerce:orders:expire` (Issue #29) runs as `awcms_worker`
-- (`WORKER_DATABASE_URL`, opt-in — `src/lib/database/client.ts`'s
-- `getWorkerDatabaseClient` header) when a deployment actually configures
-- the least-privilege worker role, rather than falling back to `awcms_app`.
--
-- Unlike `data-lifecycle:archive-purge` (SELECT + DELETE only, `sql/155`/
-- `sql/164`/`sql/167`), this job does real business-logic WRITES: it moves
-- an order to `expired`, records the transition, and restocks the order's
-- line items and any redeemed voucher — the exact same
-- `transitionOrderStatus`/`restockCancelledOrRefreshedOrder` code path a
-- customer's own cancel or an admin's status change already runs (as
-- `awcms_app`, which already holds these grants by default —
-- `sql/019`'s `ALTER DEFAULT PRIVILEGES`). `awcms_worker` gets nothing by
-- default (`sql/155`'s header) and needs its own, narrower grant for
-- exactly the columns/tables this ONE job writes — found by actually
-- running `commerce:orders:expire` against a database connected as
-- `awcms_worker` while proving Issue #29 end to end, not by inspection.
--
-- `awcms_commerce_flash_sale_products`/`_products`/`_product_variants`/
-- `_vouchers` are owned by earlier issues (#23/#26); this migration grants
-- only the ADDITIONAL privilege (`UPDATE`) this job's own restock/
-- un-redeem step needs on them, the same "narrower than default, stated
-- once" discipline `awcms-new-migration`'s skill describes for a
-- non-owning module's job.
GRANT UPDATE ON awcms_commerce_orders TO awcms_worker;
GRANT INSERT ON awcms_commerce_order_events TO awcms_worker;
GRANT UPDATE ON awcms_commerce_products TO awcms_worker;
GRANT UPDATE ON awcms_commerce_product_variants TO awcms_worker;
GRANT UPDATE ON awcms_commerce_flash_sale_products TO awcms_worker;
GRANT UPDATE ON awcms_commerce_vouchers TO awcms_worker;
