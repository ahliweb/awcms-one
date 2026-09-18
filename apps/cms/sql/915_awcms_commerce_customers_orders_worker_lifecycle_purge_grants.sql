-- Same reasoning as `sql/903`'s, `sql/908`'s and `sql/912`'s headers,
-- extended to the eight Issue #29 tables: `commerce/module.ts`'s
-- `dataLifecycle` descriptors for `commerce.customers`,
-- `commerce.customer_addresses`, `commerce.orders`, `commerce.order_items`,
-- `commerce.order_events`, `commerce.payment_confirmations`,
-- `commerce.reviews` and `commerce.wishlists` all declare
-- `executionMode: "generic"`, so `data-lifecycle:archive-purge` needs
-- SELECT + DELETE on each as `awcms_worker` — never granted by default
-- (`sql/013`'s `ALTER DEFAULT PRIVILEGES` only ever covered `awcms_app`),
-- and caught by `data-lifecycle:worker-grants:check` the moment a
-- descriptor claims a retention the worker role cannot enforce.
--
-- `commerce.orders`'s own descriptor is `retain_under_obligation` (fiscal
-- retention) with a very long `retentionMaxDays` — the grant below is what
-- lets the engine enforce that window once it is reached, not a signal that
-- orders are purged casually.
GRANT SELECT, DELETE ON awcms_commerce_customers TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_customer_addresses TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_orders TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_order_items TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_order_events TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_payment_confirmations TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_reviews TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_wishlists TO awcms_worker;
