/**
 * `finalPrice` — `price` after `discountPercent`, computed server-side so the
 * storefront never has to (and never could, without risking the exact float
 * drift ADR-0003/`sql/153`'s header exists to rule out). Pure — no database,
 * no I/O.
 *
 * `price` and the result are both `numeric(14,2)` STRINGS (never a JS
 * `number` — see this module's README "Money is numeric(14,2)" section).
 * Arithmetic runs entirely in integer CENTS via `BigInt`, never
 * floating-point: `19.10` at 10% becomes `1910n` cents, `1910n * 90n =
 * 171900n`, `/ 100n = 1719n` cents, formatted back to `"17.19"` — never
 * `17.189999999999998`, the classic `0.1 + 0.2` failure mode with a price on
 * the other end.
 *
 * Rounding is HALF-UP to the nearest cent (`+ 50n` before the floor-dividing
 * `/ 100n`), matching ordinary retail discount rounding. `price` is never
 * negative and `discountPercent` is `0..100` (both enforced before this runs
 * — `domain/product-validation.ts`), so the result is never negative either.
 */
const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/** Parses a `numeric(14,2)`-shaped decimal string into integer cents. */
function toCents(price: string): bigint {
  const [wholePart, fractionalPart = ""] = price.split(".");
  const paddedFraction = (fractionalPart + "00").slice(0, 2);
  return BigInt(wholePart!) * 100n + BigInt(paddedFraction);
}

/** Formats integer cents back into a `numeric(14,2)` decimal string. */
function fromCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = cents % 100n;
  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * `price` after `discountPercent` off, as a `numeric(14,2)` string.
 *
 * @throws {Error} `price` is not a valid `numeric(14,2)` decimal string, or
 *   `discountPercent` is not an integer in `0..100` — both are caller
 *   invariants this function trusts rather than re-validates (the caller has
 *   already run `product-validation.ts`), but a thrown error beats a silently
 *   wrong price if that invariant is ever broken.
 */
export function computeFinalPrice(
  price: string,
  discountPercent: number
): string {
  if (!PRICE_PATTERN.test(price)) {
    throw new Error(
      `computeFinalPrice: "${price}" is not a numeric(14,2) string.`
    );
  }
  if (
    !Number.isInteger(discountPercent) ||
    discountPercent < 0 ||
    discountPercent > 100
  ) {
    throw new Error(
      `computeFinalPrice: discountPercent must be an integer in 0..100, got ${discountPercent}.`
    );
  }

  const priceCents = toCents(price);
  const remainingBasisPoints = 100n - BigInt(discountPercent);
  const finalCents = (priceCents * remainingBasisPoints + 50n) / 100n;

  return fromCents(finalCents);
}
