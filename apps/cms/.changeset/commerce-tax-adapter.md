---
"awcms": minor
---

feat(commerce): adapter from the flat store-level tax percentage to the `tax` module, per tenant (Issue #293, ADR-0039)

`sql/948` adds `awcms_commerce_store_settings.tax_mode` (`flat` default | `engine`) and `tax_profile_code`, `awcms_commerce_products.tax_category_code` and `awcms_commerce_orders.tax_snapshot_id` (composite FK to `awcms_tax_snapshots`, `ON DELETE SET NULL (tax_snapshot_id)`, partial unique), plus `INSERT, UPDATE` for `awcms_worker` on `awcms_tax_snapshots` (the expiry reversal; mirrored in `security-readiness.ts`). `commerce` depends on `tax`. `domain/tax-adapter.ts` maps a quote onto tax lines (voucher allocated by largest remainder in cents) and `quoteCart` gains an engine branch with `flat` unchanged; `application/tax-adapter-directory.ts` finalises one snapshot per storefront/POS order (fail-closed if it differs from the priced tax) and reverses returns, cancellations and expiries from the ORIGINAL snapshot; `application/tax-cutover.ts` + `scripts/commerce-tax-cutover.ts` (`bun run commerce:tax:cutover`, dry-run default, shadow parity, audited flip and rollback). Additive OpenAPI: quote `tax.{mode,inclusive,error,engine}`, settings `taxMode`/`taxProfileCode` (read-only), product `taxCategoryCode`.

Tests: `tests/commerce-tax-adapter.test.ts` (parity over seeded random carts at the adapter and through `quoteCart`, allocation, categories, inclusive, refusals) and `tests/integration/commerce-tax-adapter.integration.test.ts` (flat unchanged, cut-over/refusal/rollback, one snapshot per storefront and POS order, replay, history immutability, return/cancel/expiry reversals incl. the worker role, RLS and the composite FK, client tax ignored, settings reset).
