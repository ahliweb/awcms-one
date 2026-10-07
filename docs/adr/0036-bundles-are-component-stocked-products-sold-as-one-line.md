🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0036-bundles-are-component-stocked-products-sold-as-one-line.id.md)

# ADR-0036 — Bundles are products made of components: sold as one line, stocked through their components

- **Status:** Accepted
- **Date:** 5 October 2026
- **Decision maker:** ahliweb
- **Related:** issue [#290](https://github.com/ahliweb/awcms-one/issues/290) (parent epic [#281](https://github.com/ahliweb/awcms-one/issues/281); template-only: a generic, reusable capability, [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)); [ADR-0038](0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md) (the inventory adapter every stock movement here goes through); [ADR-0039](0039-commerce-tax-is-computed-by-the-tax-module-behind-a-per-tenant-mode.md) (per-line tax); [ADR-0033](0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md) (returns; per-unit value); [ADR-0032](0032-barcodes-are-a-derived-identifier-and-the-cashier-keyboard-layer-is-chord-only.md) (barcodes); [ADR-0029](0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md) (immutable snapshots); [ADR-0035](0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md) (the bundle report it deferred); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (the migration band).

## Context

A shop sells "a coffee set": two bags of coffee and a bottle of syrup at one price. Until now the only way to do that was a product with its own `stock` counter that somebody kept in step with the three real products by hand — the exact two-sources-of-truth problem [ADR-0038](0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md) removed for the stock itself. Selling the set must take the parts off the shelf, a cancelled order must put them back, and a returned set must restock the parts — without a hidden decrement anywhere and without the set having a count that can drift.

Migration 935 (issue #266) already added `awcms_commerce_products.type = 'bundle'`. That is a descriptive product _type_ for entitlement-style packages and carries no stock semantics; it is left exactly as it is and is **not** what this decision builds on.

## Decision

### D1 — A bundle is a product with `kind = 'bundle'`

`awcms_commerce_products` gains `kind` (`standard`, the default, or `bundle`), `bundle_pricing` and `bundle_discount_percent` (`sql/953`). A bundle has **no variants** (a trigger refuses one), **no stock of its own** (the column is held at `0` by a `CHECK`, ignored by every reader, and the admin API and the CSV import refuse a non-zero value), is **not a service product** (`service_form IS NULL` by `CHECK`) and is **not eligible for a flash sale** (refused when a flash sale names it, and a product in a flash sale cannot become a bundle). These are deliberate scope limits, not omissions: a bundle's quantity is a function of its parts, so a variant axis, a counter or a flash-sale quota would each be a second source of truth. Because a bundle _is_ a product, it keeps its slug, SKU, category, images, attributes, barcode ([ADR-0032](0032-barcodes-are-a-derived-identifier-and-the-cashier-keyboard-layer-is-chord-only.md): the bundle product's own barcode is the "bundle barcode") and every existing list, search and POS path.

### D2 — Components are rows, nesting is impossible

`awcms_commerce_bundle_components` (`sql/953`): `(tenant_id, bundle_product_id, position, component_product_id, component_variant_id?, quantity)`, `FORCE` RLS and a tenant-isolation policy like every sibling table. References are **composite** (`(tenant_id, id)` on products, `(variant, product)` on variants), so a component cannot name another tenant's product or another product's variant even through a bug — foreign-key checks bypass RLS, so the constraint carries the tenant. Unique `(tenant, bundle, position)` and `(tenant, bundle, component product, component variant)`; 1–20 lines; `quantity` 1–10000. A trigger enforces the rules the schema cannot express: the bundle row must be a bundle, a component is **never itself a bundle**, a bundle cannot name itself, a component product that has live variants must name one, and a bundle has at most 20 lines. The mirror trigger on `products.kind` refuses turning a product that is used as a component into a bundle, turning a product with variants into one, and turning a bundle back into a standard product while it still has components. The two triggers lock the rows they read (`FOR NO KEY UPDATE` on the bundle, `FOR SHARE` on the component), so a concurrent "add P as a component" and "make P a bundle" serialise and one of them loses. **Nesting is rejected**; cycles are therefore impossible by construction and no graph walk exists to get wrong.

### D3 — Two pricing strategies, server-authoritative

`fixed` (default): the bundle product's own price, tiers and percentage, exactly as any product. `derived`: **Σ (component list unit price × quantity)** less `bundle_discount_percent`, rounded half-up to the cent, in integer cents through the module's money helpers ([ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md)). A component's list unit price is its variant's price override or its product's price after the product's own percentage; tier prices and flash sales do not apply to a derived bundle. The figure is computed at quote time on the server, never taken from a client, and the public `finalPrice` of a derived bundle carries it (the raw `price` column is left alone so the admin form cannot write a derived number back). A further strategy is a **versioned extension**: a new value of `bundle_pricing` behind the same `CHECK`, never a free-form formula.

### D4 — Availability is computed, and shown as `stock`

`availability = min over components of floor(component sellable stock / quantity)`, where the stock is the component variant's or product's `stock` — in `ledger` mode the write-through cache of [ADR-0038](0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md) D3, so there is still one authority. A component that cannot be sold at all (deleted, not `active`, a variant that was deleted, or a product that gained variants after it was added) makes the bundle unavailable. The cart quote folds this into the bundle's product snapshot, so a short bundle is `out_of_stock` / `quantity_reduced` through the existing status machine; the catalog read model reports the computed number as the bundle's `stock`, so the storefront, the POS search and the barcode lookup need no new field.

### D5 — One order line, an immutable component snapshot

A bundle sells as **one `awcms_commerce_order_items` row** at the bundle's price: the customer and the cashier see one line, and every figure on it (subtotal, discount share, tax, the return value of [ADR-0033](0033-returns-refunds-and-exchanges-are-additive-records-that-compensate-through-the-existing-ledgers.md)) is the line's own. Beside it, `awcms_commerce_order_item_components` (`sql/954`) holds one row per component as sold: ids, SKU, name, variant name, units per bundle, units in total and `allocated_value` (`numeric(14,2)`) — the line total split across components by their list value with **largest-remainder cents**, so the shares sum to the line total exactly (ties go to the earlier position; an all-zero list value splits evenly). The rows are **append-only** (a trigger refuses an UPDATE; the application role holds no DELETE; a purged order item cascades them), so editing or deleting a bundle definition never changes what an old order's restock or return undoes.

### D6 — Stock movements: no hidden decrement

The bundle line itself never moves stock. **Its components do, through the one adapter** ([ADR-0038](0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md)):

| Path | `counter` mode | `ledger` mode (source `(type, id, line)`) |
| --- | --- | --- |
| storefront order, POS sale | each component's counter, products then variants, ascending id | `sale` per component, `commerce_order`, order id, **`<orderItemId>:c<position>`** |
| cancel / expiry | the same counters back up | `sale_return` per component, `commerce_order_restock`, order id, `<orderItemId>:c<position>` |
| return | the same counters back up | `sale_return` per component, `commerce_return`, return id, `<returnLineId>:c<position>` |

In `ledger` mode the component lines are posted **in the same savepoint, sorted with every other line of the order** by `(itemType, itemRef, line)`, so balance locks stay in one global order and two bundles that share a component never deadlock. A ledger refusal rolls the whole order back and answers `cart_changed` / `PosCartChangedError` exactly as for a standard product. In `counter` mode the order locks the bundle's component rows (`FOR NO KEY UPDATE`, products then variants, ascending id), **re-quotes against the locked counts**, and only then writes: a sale that lost the race for the last component unit answers `cart_changed` before any row of it exists, and the `CHECK (stock >= 0)` is never the thing that refuses. Restocks and returns read the **snapshot**, not the current definition (D5). A return is in **whole bundle units** only — the return line is the bundle line, so partial component return is not possible — and its restock disposition applies to every component; `damaged` / `quarantine` change nothing here, as for any line. **Tax** ([ADR-0039](0039-commerce-tax-is-computed-by-the-tax-module-behind-a-per-tenant-mode.md)): the bundle is taxed as **one line, by the bundle product's own tax category**; per-component tax classes are deferred (a bundle of goods taxed differently would need a per-component engine input and a per-component reversal).

### D7 — Admin, POS, storefront

The product form gets a "Bundle" toggle, a pricing strategy, a discount percent and a contents editor that is a plain `<textarea>` of `SKU x quantity` lines (the line order is the component order); the server resolves each SKU to a live product or variant of the tenant, so the editor needs no picker script, and an unknown SKU is refused exactly like an unknown product id. The product admin DTO carries `kind`, `bundlePricing`, `bundleDiscountPercent` and `bundle` (the components: ids, SKU, names, units — never a cost or a stock count). No new permission: a bundle is a product, so `commerce.products.*` governs it. The POS search and barcode scan find a bundle like any product (the barcode lookup reports the computed availability and derived price); the storefront product page lists the contents under "Isi paket" from the build-time catalog fetch (static output, no new runtime call); the cart quote line carries the contents so a cart can show them.

### D8 — Reporting

None new. A bundle report (sales by bundle, component consumption) is deferred, as [ADR-0035](0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md) recorded: the sales projections already count a bundle as the product line it is, and component movements are the ledger's own `inventory` reports.

## Options considered

| Question | Option | Verdict |
| --- | --- | --- |
| **Where do the parts leave stock?** | A: the bundle has its own counter, kept in step by hand or by a job | **Rejected.** A second source of truth that drifts, and the exact thing the inventory adapter exists to avoid. |
|  | B: sell the bundle as N order lines, one per component | **Rejected.** The customer and cashier would see N lines, the bundle price would have to be spread into line prices, a return would be N returns, and "one set" would stop being an object anywhere. |
|  | **C: one line, a snapshot of components, stock moved per component through the adapter** | **Chosen.** One thing sold, one place stock moves. |
| **Nested bundles?** | A: allow, with a cycle check | **Rejected.** A graph walk under concurrency, a depth limit and a snapshot that must itself be recursive, for a need ("a set of sets") that a flat bundle of the same parts meets. |
|  | **B: no nesting, enforced by trigger** | **Chosen.** Cycles are impossible rather than detected. |
| **Pricing** | A: a formula language | **Rejected** (an expression evaluator is an attack and a support surface). |
|  | **B: two named strategies behind a `CHECK`, more by versioned extension** | **Chosen.** |
| **Counter-mode oversell** | A: let the `CHECK (stock >= 0)` fail | **Rejected.** A 500 and a half-written order. |
|  | **B: lock component rows, re-quote, then write** | **Chosen.** The existing `cart_changed` answer, before any write. |

## Consequences

- A set sells with one price, one line and one return, and its parts leave and re-enter stock through the same adapter as everything else, in either authority mode.
- A bundle's availability is derived on every read; the cost is one extra query per page of products that contains a bundle and one more at quote time.
- A component product that gains variants after it was added makes every bundle that uses it unavailable until the bundle names a variant (the trigger only checks at insert time). A product that is a component cannot become a bundle, and a bundle cannot be nested — an operator who wants a set of sets lists the parts flat.
- In `counter` mode a cart that holds both a bundle and a standard line of one of its components is quoted line by line, so the combined demand is checked only by the `CHECK (stock >= 0)` (`ledger` mode: by the ledger). The cart-level combined check is not built.
- A bundle's weight for shipping is the bundle product's own `weight_grams`, which the merchant sets (it is not summed from the components).
- Converting a stocked product to a bundle in `ledger` mode leaves its ledger balance where it is (the ledger does not convert); the operator moves it with an adjustment.

## Security & privacy

- Both new tables are `FORCE`-RLS with the tenant policy and composite tenant foreign keys; nothing is reachable across tenants even by id. An unknown, deleted or cross-tenant component reference is refused with the **same** message.
- No new unauthenticated surface. The public catalog gains contents (ids the product DTOs already expose, SKU, names, units) and never a cost price or a component stock count; the quote line carries the same.
- `awcms_worker` gains `SELECT, DELETE` on the two new tables and nothing else (the expiry restock reads the snapshot; the retention engine ages the snapshot by `created_at` and a replaced component line by `deleted_at` — a live line is never a purge candidate). The application role cannot update or delete a snapshot row.
- The snapshot and the definitions hold no personal data; the audit event of a definition change carries kind, pricing and a count.

## Rollback

- Stop creating bundles: a bundle is a product, so setting it `archived` removes it from sale. Orders already placed keep their snapshot and restock correctly.
- `sql/953`–`955` are additive: three defaulted/nullable product columns, two tables and four triggers (an edit soft-deletes the component lines it replaces). Older code ignores the columns; a database rolled back to older code simply never reads the new tables. Removing them (not recommended while any order holds a snapshot) is a restore-class decision.

## Deferred

Per-component tax classes; partial component return (a return is in whole bundles); a bundle report; nested bundles (rejected, not postponed); a cart-level combined component check in `counter` mode; weight summed from components; variants of a bundle; per-component price overrides in a derived bundle; a picker script for the contents editor (the `SKU x quantity` textarea is the contract).
