🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.id.md)

# ADR-0003 — Money is `numeric(14,2)`, and crosses the wire as a string

- **Status:** Accepted
- **Date:** 15 September 2026
- **Decision maker:** ahliweb
- **Related:** [issue #4](https://github.com/ahliweb/awcms-one/issues/4) (the `commerce` module, where this decision was made); [`apps/cms/sql/901_awcms_commerce_schema.sql`](../../apps/cms/sql/901_awcms_commerce_schema.sql); [`docs/skema-basis-data.md`](../skema-basis-data.md); [`docs/kamus-data.md`](../kamus-data.md)

## Context

`awcms_commerce_products.price` is the one column in this slice where a wrong representation is a silent, compounding defect rather than an obvious bug. Binary floating point cannot represent `0.10` exactly (the familiar `0.1 + 0.2 !== 0.3`), and repeated arithmetic on a float-backed price — a discount applied, a total summed across a cart — drifts by a cent here and there in a way that never throws and never fails a test that happens to use round numbers. A customer's invoice is the audience for that drift.

The legacy `commerce_bj_mart.products.price` column arrives from a MySQL/Laravel stack where this exact failure class is common; re-platforming it is the moment to close it, not to carry it forward unexamined.

## Decision

`price` is `numeric(14,2)` in PostgreSQL (`sql/901`) — 12 integer digits and 2 fractional, exact fixed-point, comfortably covering a Rupiah price into the hundreds of billions. `Bun.SQL` hands a `numeric` column back as a **string**, never a JS `number`, and `commerce/application/product-directory.ts`'s `toRecord()` — the one place the wire shape is assembled — never parses it. The `CommerceProduct` DTO (`openapi/modules/commerce.openapi.yaml`, mirrored in `packages/kontrak`'s scope discussion even though the DTO itself lives in `application/`, not `domain/` — see [ADR-0004](0004-a-type-only-contract-package-with-an-import-direction-gate.md)) declares `price` as a `string`, all the way to the storefront, which formats it for display with `Intl.NumberFormat` (`apps/storefront/src/lib/catalog.ts`'s `formatPrice`) and performs no arithmetic on it at all — it shows the price and the `discountPercent` **percentage** `apps/cms` sends, never a computed discounted amount, so it never has to invent a rounding rule that might disagree with whatever a future checkout computes.

`discount_percent` and `stock` are plain PostgreSQL `integer`, deliberately not `numeric`: neither is money, and both are exact in floating point anyway (a 0–100 percentage and a unit count), so `numeric` there would add ceremony without closing any real gap.

A database-level `CHECK (price >= 0)` backs the same invariant server-side; `commerce/domain/product-validation.ts` validates the incoming string shape (a non-negative decimal, at most two fractional digits) before it ever reaches the database.

## Consequences

- Every layer that touches `price` — the SQL column, `Bun.SQL`'s driver behaviour, the domain validator, the DTO, the OpenAPI schema, and the storefront's rendering — agrees it is a string. There is exactly one place in the whole system that ever calls `Number()` on it: `formatPrice`, for display only, immediately fed into `Intl.NumberFormat.prototype.format()` (which has no string overload) and never stored or recombined.
- A future feature that needs to compute with money — a cart subtotal, a checkout total — inherits a value that is already exact and already a string; it must choose its own arithmetic strategy (a decimal library, or integer minor-units) rather than assuming `Number(price) + Number(price)` is safe, because it is not.
- `openapi/modules/commerce.openapi.yaml` documents `price` as `type: string` with the note "never a JSON number" precisely so a future API consumer does not have to discover this by reading `product-directory.ts`.
