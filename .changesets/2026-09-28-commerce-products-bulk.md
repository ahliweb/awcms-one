---
bump: minor
type: structure
impact: public
---

# Commerce products: translated labels, status-tab counts, bulk publish/draft/delete

Issue #247, part of the commerce admin v2 epic. Depends on #242 (the
accessible confirm dialog) and #243 (`commerce-admin-labels.ts`).

- `commerce.astro` renders product type/status through
  `commerce-admin-labels.ts`'s shared maps everywhere the raw column value
  used to appear: the table cell, the status badge, the filter `<select>`,
  the create-form type `<select>`, and both inline-edit `<select>`s. The
  raw value survives in a `data-product-type`/`data-product-status`
  attribute on the cell/badge it replaced, so it is still readable by
  anything that needs the untranslated value.
- The All/Published/Draft quick-filter tabs now show a per-status count,
  as `commerce-orders.astro`'s own status tabs already do. A new
  `countProductsByStatus(tx, tenantId)` in `product-directory.ts` runs one
  grouped `count(*)` query, zero-filling a status with no rows — the SAME
  choice `order-directory.ts`'s `countOrdersByStatus` made, generalised:
  it deliberately ignores this screen's `categoryId`/`q`/`featured`/
  `recommended` filters, matching the tabs' own `href`s (which already
  drop those filters when a tab is clicked). Covered by two new
  integration tests in `commerce-catalog.integration.test.ts` (grouping +
  soft-delete exclusion, and cross-tenant isolation).
- The product list gets a real checkbox column (header select-all with
  indeterminate state, each row checkbox labelled with the product's
  name) and a working `.admin-bulk-bar` with Publish/Move to draft/Delete
  — gated on the same `canUpdate`/`canDelete` permissions the row Actions
  column already uses. Per the reference repo `media-lenterakalteng`'s
  ADR-0123 §5 pattern (no bulk API): every action loops over the EXISTING
  per-item `PATCH`/`DELETE
  /api/v1/commerce/products/{id}` endpoints, one request per selected
  product, each carrying its own `Idempotency-Key` (neither route reads
  one today, but sending it costs nothing and matches the convention
  every other high-risk mutation in this module follows). Requests run
  SEQUENTIALLY with a "Processing N of M…" progress label; a run that
  does not fully succeed reports which SKUs failed and why in the
  existing `role="alert"` error box, then leaves the page as-is (matching
  `mutateAndReload`'s own "reload only on success" convention); a fully
  successful run reloads. Bulk delete confirms through
  `CommerceConfirmDialog`, with a count-aware message ("N selected
  product(s) will be moved to trash…") filled client-side from two
  server-rendered plural forms.
- New `apps/cms/src/lib/ui/commerce-products-bulk-client.ts`: the pure
  selection-state/plural-template/idempotency-key/result-aggregation
  helpers, plus the DOM wiring `commerce.astro`'s `<script>` calls
  (`initCommerceProductsBulk()`). Its own header explains the `{n}`
  placeholder (never `{count}`) the live selection count and the delete
  confirmation both rely on to stay correctly translated without a
  client-side i18n runtime. The checkbox column and the bar are
  CSS-hidden (`commerce.astro`'s own scoped `<style>`) until this module
  actually runs, so a no-JS visitor keeps the per-row-only UI the screen
  always had.
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised
  265,000 -> 269,000 B (measured 268,549 B) for the new client module and
  a dozen new i18n catalogue entries; docblock entry added in the same
  style as every prior commerce raise.
- New msgids for the bar's copy, the delete confirmation, and per-action
  failure headers — English + natural Indonesian (the plural pair's
  Indonesian form is a single string, since `id.po`'s `Plural-Forms` is
  `nplurals=1`).
- Tests: `apps/cms/tests/commerce-products-bulk-247.test.ts` — pure
  helper coverage (placeholder filling, plural-form selection, select-all
  tri-state, the per-item idempotency key, error-message extraction, the
  sequential runner and its progress/failure aggregation, failure-summary
  formatting) plus the static contract (label call sites, tab counts, the
  bar/column hidden-until-JS contract, the confirm button's
  `data-confirm-*` attributes, no `window.confirm`, and a directory
  listing proving no new route was added under
  `src/pages/api/v1/commerce/products/`).

Bulk actions for orders remain deliberately out of scope, per the issue:
status transitions there have side effects (stock, notifications,
payment) a bulk mistake would make costly.
