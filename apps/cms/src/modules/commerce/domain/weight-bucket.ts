/**
 * Weight bucketing for the courier-rate cache (Issue #107, contract #106's
 * D4). Pure — no database, no I/O.
 *
 * RajaOngkir bills in 1 kg (1000 g) minimum increments and rounds up to the
 * next 100 g above that — a 350 g parcel and a 400 g parcel would otherwise
 * each mint their own cache row for a rate that is, in practice, identical,
 * so `getCourierRates` (`application/shipping-rate-directory.ts`) always
 * caches by this BUCKETED weight, never the cart's raw `weightGrams`. This
 * also means the FIRST kilogram is never billed any lower than 1000 g, even
 * for a 10 g cart — a documented floor, not an oversight (RajaOngkir's own
 * minimum billable weight).
 */
const GRAMS_PER_BUCKET = 100;
export const MINIMUM_BILLABLE_GRAMS = 1000;

/**
 * Rounds `grams` up to the next 100 g, then floors it at
 * {@link MINIMUM_BILLABLE_GRAMS}. Negative/non-finite input is treated as 0
 * before rounding (never thrown) — the caller (cart-quote's weight sum) is
 * already trusted to produce a non-negative number; this stays defensive
 * rather than assume that forever.
 */
export function computeWeightBucketGrams(grams: number): number {
  const safeGrams = Number.isFinite(grams) && grams > 0 ? grams : 0;
  const rounded = Math.ceil(safeGrams / GRAMS_PER_BUCKET) * GRAMS_PER_BUCKET;
  return Math.max(rounded, MINIMUM_BILLABLE_GRAMS);
}
