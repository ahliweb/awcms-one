---
bump: minor
type: structure
impact: public
---

# Commerce marketing surface: flash sales, vouchers, sliders, testimonials, promo popup, store settings

Everything mart.borneojek.com's home page and promotions run on, as tenant-scoped tables in the one `commerce` module (issue #26, epic #21) — with a public read model per family that `apps/storefront` bakes the home page from, and six admin screens.

Why one module rather than three (the decision is recorded by issue #31, https://github.com/ahliweb/awcms-one/issues/31): every admission touches the same shared registries, and an order references products, flash-sale prices and vouchers as one aggregate.

- New tables `awcms_commerce_{flash_sales,flash_sale_products,vouchers,sliders,testimonials,popups,store_settings}` (`sql/161`–`164`), 22 new permissions, two flash-sale events fired by the `commerce:flash-sales:tick` job, 20 new OpenAPI operations.
- Voucher arithmetic is exact (integer cents, `maxDiscount` cap); `POST …/vouchers/validate` is a read — redemption belongs to the order (#29). Flash-sale status is derived from the window and persisted by the tick, never trusted from the column. At most one active popup per tenant, enforced by a partial unique index.
- Store settings are one versioned `jsonb` document per tenant; the public read model never carries a bank account number, holder, or QRIS reference. `DELETE` resets to defaults by stamping `deleted_at`, which is also what lets the singleton answer the retention question with a column rather than an exemption.
- Two #23 follow-ups: `downloadLink` (a digital product's paid asset) leaves the public product DTO for the admin record; `sizeChartImageUrl` joins it.
- Two latent defects found while proving the seed end to end: batch reads of images/variants bound a JS array straight into `= ANY(…)` (fails on two or more ids — now `tx.array(…)::uuid[]`, with a regression test); and `Bun.SQL` decodes a stored `0.00` as `"0"` through a parameterised query — every money field now passes through `normalizeMoney` so the wire shape is always two decimals.
- `tools/seed-borneojek-mart.ts` applies the #23 product fields and variants, seeds one flash sale, two vouchers, three testimonials, one popup and the live store-settings block (bank account a placeholder), and issues the storefront build credential with every marketing `read`. Product images and sliders stay recorded under `future`: both need a media object, and media objects need the R2-backed upload session.
