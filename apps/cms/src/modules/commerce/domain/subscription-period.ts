/**
 * `subscription_period` union (Issue #23, catalog-parity increment). Pure —
 * no database, no I/O.
 *
 * Only meaningful when `product.type === "subscription"` — a physical/
 * digital/service row simply leaves this `null`. That relationship is
 * descriptive, not enforced: BjekMart's own source column carries a value
 * independent of the row's type, and re-deriving which rows "should" have had
 * one from data that never recorded the rule would not be possible. So
 * `product-validation.ts` validates the STRING shape only, the same choice it
 * already makes for `download_link`/`type = digital`.
 */
export const SUBSCRIPTION_PERIODS = ["day", "week", "month", "year"] as const;

export type SubscriptionPeriod = (typeof SUBSCRIPTION_PERIODS)[number];

export function isSubscriptionPeriod(
  value: unknown
): value is SubscriptionPeriod {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_PERIODS as readonly string[]).includes(value)
  );
}
