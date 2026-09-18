-- `commerce:orders:expire` (Issue #29) runs as `awcms_worker`
-- (`WORKER_DATABASE_URL`, opt-in — `src/lib/database/client.ts`'s
-- `getWorkerDatabaseClient` header) when a deployment actually configures
-- the least-privilege worker role, rather than falling back to `awcms_app`.
--
-- Unlike `data-lifecycle:archive-purge` (SELECT + DELETE only, `sql/903`/
-- `sql/912`/`sql/915`), this job does real business-logic WRITES: it moves
-- an order to `expired`, records the transition, and restocks the order's
-- line items and any redeemed voucher — the exact same
-- `transitionOrderStatus`/`restockCancelledOrRefreshedOrder` code path a
-- customer's own cancel or an admin's status change already runs (as
-- `awcms_app`, which already holds these grants by default —
-- `sql/019`'s `ALTER DEFAULT PRIVILEGES`). `awcms_worker` gets nothing by
-- default (`sql/903`'s header) and needs its own, narrower grant for
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

-- Same gap, one job earlier: `commerce:flash-sales:tick` (Issue #26,
-- `scripts/commerce-flash-sales-tick.ts`) persists a sale's derived status
-- with an UPDATE on `awcms_commerce_flash_sales`, and `sql/912` granted the
-- worker only the purge engine's SELECT + DELETE. Found while proving
-- `commerce:orders:expire` as `awcms_worker` (PR #42); granted here rather
-- than in a fifth migration because it is the same concern — the worker
-- role must be able to run the module's own jobs.
GRANT UPDATE ON awcms_commerce_flash_sales TO awcms_worker;
