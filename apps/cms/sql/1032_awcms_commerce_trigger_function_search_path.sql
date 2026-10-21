-- Pin search_path on every commerce trigger function (Issue #377, the
-- awcms#1046 sweep arriving with the v10.8.0 subtree sync).
--
-- `awcms_app` and `awcms_worker` hold TEMP, and PostgreSQL resolves an
-- unqualified relation name through the session's temp schema BEFORE `public`
-- unless `pg_temp` is named later in the path. A guard trigger that reads
-- `awcms_commerce_*` without a pin therefore reads whatever table the calling
-- role created as a TEMP shadow first. `db:function-search-path:check` now
-- fails on any trigger function without `SET search_path = ..., pg_temp`.
--
-- The functions were created by migrations 953 to 1001, which are applied
-- already (checksums are immutable), so the pin is added here with
-- ALTER FUNCTION, which the gate folds in migration order. Nothing in any body
-- changes; the path is the standard one, pg_catalog first, public, pg_temp last.
-- ALTER ... SET is idempotent, so a re-run is harmless.

ALTER FUNCTION awcms_commerce_append_only_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_barcode_cross_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_bundle_components_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_bundle_no_flash_sale_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_bundle_no_variants_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_document_deliveries_append_only() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_document_deliveries_check_target() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_document_sequences_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_documents_append_only() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_documents_match_source() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_expenses_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_held_sales_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_loyalty_ledger_reject_update() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_loyalty_programs_eligibility_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_loyalty_redemptions_reject_update() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_order_item_components_immutable() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_orders_register_session_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_payment_allocations_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_payment_allocations_register_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_payment_allocations_reversal_cap() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_payment_allocations_stored_value_pairing() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_products_kind_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_quotations_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_refunds_cap_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_refunds_update_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_register_append_only() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_register_close_requests_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_register_corrections_require_closed() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_register_require_open_session() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_register_sessions_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_return_lines_insert_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_returns_insert_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_returns_update_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_segment_versions_reject_update() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_segments_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_stored_value_accounts_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_stored_value_accounts_insert_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_stored_value_accounts_issue_check() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_stored_value_ledger_append_only() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_stored_value_ledger_apply() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_stored_value_programs_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION awcms_commerce_work_orders_guard() SET search_path = pg_catalog, public, pg_temp;
