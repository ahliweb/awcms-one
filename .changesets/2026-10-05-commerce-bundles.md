---
bump: minor
type: structure
impact: public
---

# Commerce bundles: item kits stocked through their components (issue #290, ADR-0036)

A shop can now sell a set - "two coffees and a syrup at one price" - without a stock counter on the set that somebody keeps in step by hand. A bundle is a **product with `kind = 'bundle'`**: no variants, no stock of its own, not a service product, not flash-sale eligible, and made of 1-20 component lines (a product, a variant when that product has live variants, and a quantity per bundle). **Nesting is refused by trigger**, so a cycle cannot exist. Decision and rejected alternatives: `docs/adr/0036-bundles-are-component-stocked-products-sold-as-one-line.md`.

- New: `sql/953` to `sql/955` under `apps/cms` - `kind` / `bundle_pricing` / `bundle_discount_percent` on `awcms_commerce_products`, `awcms_commerce_bundle_components` (composite tenant FKs, FORCE RLS, the nesting/variant/flash-sale triggers), the append-only `awcms_commerce_order_item_components` snapshot, and the `awcms_worker` grant the expiry restock needs. Existing tenants need no backfill; every product is `standard`.
- Pricing is `fixed` (the product's own price) or `derived` (the components' list prices x quantity, less a percent, half-up to the cent). Availability is `min floor(component stock / quantity)` and is reported as the bundle's `stock`, so the storefront, POS search and barcode scan need no new field.
- A bundle sells as **one order line** with an immutable component snapshot (units, text as sold, the line value split across components to the cent). The components - never the bundle - move stock: a counter decrement after locking and re-quoting in `counter` mode, a `sale` per component with source line `<orderItemId>:c<position>` through the inventory adapter in `ledger` mode. Cancel, expiry and a whole-bundle return put exactly those components back from the snapshot; editing the bundle afterwards changes nothing about an old order. Tax is one line by the bundle's own category.
- API: `POST`/`PATCH /api/v1/commerce/products` accept `kind`, `bundlePricing`, `bundleDiscountPercent` and `bundleComponents` (ids or SKUs); product reads gain `kind`, `bundlePricing`, `bundleDiscountPercent` and `bundle`; a cart quote line for a bundle carries `bundle.components`. No new permission (`commerce.products.*`).
- Admin: a Bundle toggle, pricing strategy, discount and a `SKU x quantity` contents textarea on the product form. Storefront: an "Isi paket" list on the product page.
- Not here (recorded in the ADR): per-component tax classes, partial component return, a bundle report, nested bundles, a cart-level combined component check in `counter` mode.
- **Backward compatible.** Nothing changes for an existing product or order.
