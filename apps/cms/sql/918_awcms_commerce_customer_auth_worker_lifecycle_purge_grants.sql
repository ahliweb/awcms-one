-- Same reasoning as `sql/903`'s, `sql/908`'s, `sql/912`'s and `sql/915`'s
-- headers, extended to the two Issue #87 purge-only tables:
-- `commerce:customer-auth:purge` (`scripts/commerce-customer-auth-purge.ts`,
-- `module.ts`'s `jobs` descriptor) runs as `awcms_worker`
-- (`WORKER_DATABASE_URL`) and deletes expired OTPs
-- (`awcms_commerce_customer_otps`) and expired/revoked sessions older than
-- 7 days (`awcms_commerce_customer_sessions`) — SELECT + DELETE only, never
-- UPDATE (this job never rewrites a row, only removes rows that are already
-- past their own useful life), never granted by default (`sql/019`'s
-- `ALTER DEFAULT PRIVILEGES` only ever covered `awcms_app`).
--
-- `awcms_commerce_customer_accounts` is granted here too, on the strength of
-- its own `deleted_at`-cursor `dataLifecycle` descriptor (`module.ts`,
-- `executionMode: 'generic'`) — the SAME "generic engine could in principle
-- run, in practice never matches" reasoning `sql/915`'s header already gives
-- for `awcms_commerce_orders`: `commerce:customer-auth:purge` itself never
-- touches this table (an account is blocked, not deleted), but
-- `data-lifecycle:worker-grants:check` requires the grant the moment a
-- descriptor claims `executionMode: 'generic'`, regardless of which job
-- would actually run it.
GRANT SELECT, DELETE ON awcms_commerce_customer_accounts TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_customer_otps TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_customer_sessions TO awcms_worker;
