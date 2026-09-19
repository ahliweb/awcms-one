-- Same reasoning as `sql/903`'s, `sql/908`'s, `sql/912`'s and `sql/915`'s
-- headers, extended to the two Issue #92 tables: `commerce/module.ts`'s
-- `dataLifecycle` descriptors for `commerce.affiliates` and
-- `commerce.affiliate_commissions` both declare `executionMode: "generic"`,
-- so `data-lifecycle:archive-purge` needs SELECT + DELETE on each as
-- `awcms_worker` — never granted by default (`sql/013`'s `ALTER DEFAULT
-- PRIVILEGES` only ever covered `awcms_app`), and caught by
-- `data-lifecycle:worker-grants:check` the moment a descriptor claims a
-- retention the worker role cannot enforce.
GRANT SELECT, DELETE ON awcms_commerce_affiliates TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_affiliate_commissions TO awcms_worker;
