/**
 * All price display for the storefront — the ONLY file that turns a
 * `numeric(14,2)` price STRING into anything numeric or human-readable.
 *
 * ADR-0003: money is `numeric(14,2)` and travels as a string precisely so
 * nothing downstream loses precision converting it to a JS `number`. This
 * app does no arithmetic on a price — it displays `price`/`finalPrice`/
 * `salePrice`/tier prices exactly as awcms computed them (`domain/
 * price-calculation.ts`'s integer-cents `BigInt` math is the ONE place a
 * discount is ever computed, and it is not this app). `tests/
 * katalog-harga.test.ts` grep-guards `src/` for `Number(`/`parseFloat(` on
 * a field named `price*` OUTSIDE this file — every OTHER numeric handling
 * of a price string in this app (sorting a listing, a min/max range filter)
 * is required to come through `priceToNumber`/`comparePrices` below rather
 * than reaching for `Number()`/`parseFloat()` itself, so the guard has
 * exactly one, auditable place to trust.
 */

const PRICE_FORMATTER = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0
});

/**
 * `price` (or any `numeric(14,2)` string this app renders) as a locale
 * currency string, e.g. `"Rp85.000"`.
 *
 * `Intl.NumberFormat.prototype.format()` has no string overload, so a
 * single, terminal conversion to `number` right before formatting is not
 * the ACCUMULATING float error ADR-0003 warns against (a discount applied,
 * a total summed) — this app never does that; it shows the amount awcms
 * already computed, once, for display only.
 */
export function formatPrice(price: string): string {
  return PRICE_FORMATTER.format(priceToNumber(price));
}

/**
 * The ONE conversion of a price string to a `number`, for every caller in
 * this app that needs to ORDER or COMPARE prices (never to compute a new
 * one) — `catalog.ts`'s `filterProdukIndex` sort/range filters go through
 * this rather than calling `Number()`/`parseFloat()` themselves.
 *
 * Throws rather than returning `NaN`: awcms declares every price field
 * `numeric(14,2)`, so a value that does not parse is a changed response
 * shape, not a product with no price — the same posture `formatPrice`'s
 * increment-1 revision already took.
 */
export function priceToNumber(price: string): number {
  const value = Number(price);

  if (!Number.isFinite(value)) {
    throw new Error(
      `priceToNumber: "${price}" is not a finite number. awcms declares ` +
        `every price field numeric(14,2), so a value that does not parse is ` +
        `a changed response shape.`
    );
  }

  return value;
}

/** `a` vs `b`, both price strings — negative when `a < b`, for `Array.prototype.sort`. */
export function comparePrices(a: string, b: string): number {
  return priceToNumber(a) - priceToNumber(b);
}

/** `discountPercent` as the badge text this app shows next to a struck-through original price, e.g. `"10%"`. */
export function formatDiscountPercent(discountPercent: number): string {
  return `${discountPercent}%`;
}
