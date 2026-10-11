/**
 * Loyalty point redemption into pricing - Issue #363, ADR-0043. Pure - no
 * database, no I/O.
 *
 * ## What the client may say, and what it may not
 *
 * A client (a signed-in shopper, or a cashier) sends ONE number: how many whole
 * points to spend. It never sends a discount, a rate, a total or an account.
 * Everything else is computed here from facts the server holds - the tenant's
 * point value, the optional cap, the order's goods subtotal - so there is no
 * client-supplied figure to tamper with (threat-model control C-31).
 *
 * ## The arithmetic, in integer cents
 *
 *   discountCents = points * rupiahPerPoint * 100
 *
 * A point is a whole number and the rate is a whole number of rupiah, so the
 * product is exact; there is no rounding step in which a fraction of a rupiah
 * could be created (`sql/1010`'s CHECK states the same identity in the
 * database). The discount is then bounded by
 *
 *   * the GOODS basis - `subtotal - voucher discount` of the order. Shipping,
 *     insurance and tax are never part of it, so they remain payable in money
 *     only (owner answer Q6);
 *   * the tenant's cap, when one is set: `floor(goodsBasis * percent / 100)`.
 *
 * A request above either bound is REFUSED whole, with the largest number of
 * points that would fit - never silently clamped, because the points debited
 * must be exactly the points the customer agreed to spend.
 *
 * Points do not reduce the tax: tax is computed on `subtotal - voucher
 * discount` before points exist, and a points redemption is a way of paying
 * for goods, not a price reduction on them (ADR-0043 D3).
 */
import { MAX_LEDGER_POINTS } from "./loyalty";
import { fromCents, toCents } from "./price-calculation";

export const MAX_RUPIAH_PER_POINT = 1_000_000;

/** Stable machine codes of every refusal a redemption can produce. */
export const LOYALTY_REDEMPTION_ERROR_CODES = {
  /** Feature off, loyalty off, or the tenant never set a point value. */
  unavailable: "LOYALTY_REDEMPTION_UNAVAILABLE",
  /** A storefront redemption without a verified customer session. */
  requiresAccount: "LOYALTY_REDEMPTION_REQUIRES_ACCOUNT",
  /** A POS redemption on a walk-in sale (no customer attached). */
  requiresCustomer: "LOYALTY_REDEMPTION_REQUIRES_CUSTOMER",
  /** Points and a refundable deposit on one order (Q8). */
  depositConflict: "LOYALTY_REDEMPTION_DEPOSIT_CONFLICT",
  /** Above the goods subtotal or the tenant's cap. */
  exceedsLimit: "LOYALTY_REDEMPTION_EXCEEDS_LIMIT",
  /** The balance cannot cover the request (shared with the manual redeem). */
  insufficientPoints: "INSUFFICIENT_POINTS",
  /** The customer is blocked or deleted. */
  customerUnavailable: "LOYALTY_REDEMPTION_CUSTOMER_UNAVAILABLE"
} as const;

export type LoyaltyRedemptionErrorCode =
  (typeof LOYALTY_REDEMPTION_ERROR_CODES)[keyof typeof LOYALTY_REDEMPTION_ERROR_CODES];

export type RedemptionRate = {
  rupiahPerPoint: number;
  /** Whole percentage 1..100, or `null` for no cap. */
  maxGoodsPercent: number | null;
};

export type RedemptionComputation =
  | {
      ok: true;
      discountCents: bigint;
      discount: string;
    }
  | {
      ok: false;
      reason: "goods" | "cap";
      /** The largest whole number of points that would have fit (0 when none). */
      maxPoints: number;
    };

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator;
}

/** The most the points may be worth, in cents, for this goods basis and rate. */
export function redemptionLimitCents(
  goodsBasisCents: bigint,
  rate: RedemptionRate
): { limitCents: bigint; binding: "goods" | "cap" } {
  const goods = goodsBasisCents > 0n ? goodsBasisCents : 0n;
  if (rate.maxGoodsPercent === null) {
    return { limitCents: goods, binding: "goods" };
  }
  const cap = floorDiv(goods * BigInt(rate.maxGoodsPercent), 100n);
  return cap < goods
    ? { limitCents: cap, binding: "cap" }
    : { limitCents: goods, binding: "goods" };
}

/**
 * The discount `points` is worth, or the refusal. `points` must already be a
 * positive safe integer (the request validator guarantees it; this function
 * re-checks because it is the one that protects the money).
 */
export function computeRedemptionDiscount(
  points: number,
  rate: RedemptionRate,
  goodsBasisCents: bigint
): RedemptionComputation {
  if (
    !Number.isSafeInteger(points) ||
    points <= 0 ||
    points > MAX_LEDGER_POINTS
  ) {
    throw new RangeError("points must be a positive whole number.");
  }
  if (
    !Number.isSafeInteger(rate.rupiahPerPoint) ||
    rate.rupiahPerPoint < 1 ||
    rate.rupiahPerPoint > MAX_RUPIAH_PER_POINT
  ) {
    throw new RangeError("rupiahPerPoint must be a whole number of rupiah.");
  }

  const centsPerPoint = BigInt(rate.rupiahPerPoint) * 100n;
  const discountCents = BigInt(points) * centsPerPoint;
  const { limitCents, binding } = redemptionLimitCents(goodsBasisCents, rate);

  if (discountCents > limitCents) {
    return {
      ok: false,
      reason: binding,
      maxPoints: Number(floorDiv(limitCents, centsPerPoint))
    };
  }
  return { ok: true, discountCents, discount: fromCents(discountCents) };
}

/** The goods basis of an order in cents: `subtotal - voucher discount`, floored at zero. */
export function goodsBasisCents(subtotal: string, discount: string): bigint {
  const net = toCents(subtotal) - toCents(discount);
  return net > 0n ? net : 0n;
}

// ---------------------------------------------------------------------------
// Giving points back
// ---------------------------------------------------------------------------

/**
 * Points a REFUND must have given back by now, in total: the redeemed points
 * in proportion to the money refunded out of the money paid
 * (`floor(points * refunded / total)`), the whole of them once the order is
 * fully refunded. Pure; the caller subtracts what was already restored.
 *
 * It is computed on cash paid (`total` is already net of the points
 * discount), so refunding every rupiah the customer paid returns every point
 * they spent, and a half refund returns half (threat-model control C-33).
 */
export function pointsToHaveRestored(
  redeemedPoints: number,
  refundedCents: bigint,
  totalCents: bigint
): number {
  if (redeemedPoints <= 0 || refundedCents <= 0n || totalCents <= 0n) return 0;
  if (refundedCents >= totalCents) return redeemedPoints;
  return Number((BigInt(redeemedPoints) * refundedCents) / totalCents);
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export type RedemptionValidationError = { field: string; message: string };

/**
 * Reads the redemption part of an order request: `undefined`/absent means "no
 * redemption", an object must carry exactly one key, `points`, a positive whole
 * number. Any other key (`discount`, `rate`, `total`, `accountId`, ...) is a
 * `400`, not silently ignored: a client that sends a figure it should not is
 * told so (C-31), and a request that hashes differently can never replay
 * as a different one.
 */
export function readLoyaltyRedemptionInput(
  value: unknown,
  field = "loyaltyRedemption"
):
  | { ok: true; points: number | null }
  | { ok: false; errors: RedemptionValidationError[] } {
  if (value === undefined || value === null) return { ok: true, points: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      errors: [{ field, message: `${field} must be an object.` }]
    };
  }
  const record = value as Record<string, unknown>;
  const errors: RedemptionValidationError[] = [];
  for (const key of Object.keys(record)) {
    if (key !== "points") {
      errors.push({
        field: `${field}.${key}`,
        message: `${field}.${key} is not accepted: the server computes the discount.`
      });
    }
  }
  const points = record.points;
  if (
    typeof points !== "number" ||
    !Number.isSafeInteger(points) ||
    points < 1 ||
    points > MAX_LEDGER_POINTS
  ) {
    errors.push({
      field: `${field}.points`,
      message: `${field}.points must be a positive whole number.`
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, points: points as number };
}

export type RedemptionSettingsInput = {
  rupiahPerPoint: number;
  maxGoodsPercent: number | null;
};

/** `PUT` body of the settings route: a whole rupiah per point and an optional whole-percent cap. */
export function validateRedemptionSettingsInput(
  value: unknown
):
  | { valid: true; value: RedemptionSettingsInput }
  | { valid: false; errors: RedemptionValidationError[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "body must be a JSON object." }]
    };
  }
  const record = value as Record<string, unknown>;
  const errors: RedemptionValidationError[] = [];
  for (const key of Object.keys(record)) {
    if (key !== "rupiahPerPoint" && key !== "maxGoodsPercent") {
      errors.push({ field: key, message: `${key} is not a known field.` });
    }
  }

  const rate = record.rupiahPerPoint;
  if (
    typeof rate !== "number" ||
    !Number.isSafeInteger(rate) ||
    rate < 1 ||
    rate > MAX_RUPIAH_PER_POINT
  ) {
    errors.push({
      field: "rupiahPerPoint",
      message: `rupiahPerPoint must be a whole number of rupiah between 1 and ${MAX_RUPIAH_PER_POINT}.`
    });
  }

  let maxGoodsPercent: number | null = null;
  const cap = record.maxGoodsPercent;
  if (cap !== undefined && cap !== null) {
    if (
      typeof cap !== "number" ||
      !Number.isSafeInteger(cap) ||
      cap < 1 ||
      cap > 100
    ) {
      errors.push({
        field: "maxGoodsPercent",
        message:
          "maxGoodsPercent must be a whole percentage between 1 and 100, or null for no cap."
      });
    } else {
      maxGoodsPercent = cap;
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { rupiahPerPoint: rate as number, maxGoodsPercent }
  };
}
