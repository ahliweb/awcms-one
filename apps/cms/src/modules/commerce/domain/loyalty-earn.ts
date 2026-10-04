/**
 * Loyalty earn rule — Issue #289, ADR-0026 D3. Pure — no database, no I/O.
 *
 * ## The rule
 *
 * A program VERSION says: "`earnPointsPerUnit` points for every WHOLE
 * `earnUnitAmount` of eligible spend", with an optional minimum order, an
 * optional per-order cap and an optional expiry period in days. Eligible spend
 * is the order's merchandise net of voucher discount
 * (`subtotal - discount`, floored at zero): shipping, insurance and tax are
 * never rewarded, and the figure comes ONLY from the order row — a client
 * claim never reaches this function.
 *
 * ## Exactness
 *
 * All arithmetic is `bigint` integer cents / integer points. `numeric(14,2)`
 * strings are converted with `price-calculation.ts`'s `toCents` (never
 * `parseFloat`), the division is bigint division (truncating toward zero —
 * which for non-negative operands IS floor), and the result is bounded by
 * {@link MAX_LEDGER_POINTS} before it becomes a `number`. The rounding mode is
 * explicit and stored on the program (`earn_rounding = 'floor'`): the
 * remainder below one unit is dropped, never carried, never rounded up.
 */
import { toCents } from "./price-calculation";
import { MAX_LEDGER_POINTS } from "./loyalty";

export type LoyaltyEarnRule = {
  /** `numeric(14,2)` as a decimal string. Must be > 0. */
  earnUnitAmount: string;
  earnPointsPerUnit: number;
  /** `numeric(14,2)` as a decimal string, >= 0. */
  minOrderAmount: string;
  maxPointsPerOrder: number | null;
};

export type LoyaltyEarnBasis = {
  /** `awcms_commerce_orders.subtotal` — merchandise after per-item discounts. */
  subtotal: string;
  /** `awcms_commerce_orders.discount` — the voucher discount. */
  discount: string;
};

/** Eligible spend in integer cents: `max(0, subtotal - discount)`. */
export function computeEligibleSpendCents(basis: LoyaltyEarnBasis): bigint {
  const net = toCents(basis.subtotal) - toCents(basis.discount);
  return net > 0n ? net : 0n;
}

/**
 * Whole points a paid order earns under `rule` — always a non-negative safe
 * integer; `0` means "earns nothing" (below the minimum, below one unit, or a
 * zero basis), never an error.
 */
export function computeEarnPoints(
  rule: LoyaltyEarnRule,
  basis: LoyaltyEarnBasis
): number {
  const spendCents = computeEligibleSpendCents(basis);
  if (spendCents <= 0n) return 0;

  const minOrderCents = toCents(rule.minOrderAmount);
  if (spendCents < minOrderCents) return 0;

  const unitCents = toCents(rule.earnUnitAmount);
  if (unitCents <= 0n) return 0;

  const wholeUnits = spendCents / unitCents;
  let points = wholeUnits * BigInt(rule.earnPointsPerUnit);

  if (rule.maxPointsPerOrder !== null) {
    const cap = BigInt(rule.maxPointsPerOrder);
    if (points > cap) points = cap;
  }

  const bound = BigInt(MAX_LEDGER_POINTS);
  if (points > bound) points = bound;

  return Number(points);
}

const MS_PER_DAY = 86_400_000;

/**
 * When points earned at `earnedAt` lapse under `expiryDays` — `null` when the
 * program has no expiry. Calendar arithmetic is plain UTC milliseconds (a day
 * is 86,400,000 ms), so the instant is the same on every server regardless of
 * its time zone.
 */
export function computeExpiresAt(
  earnedAt: Date,
  expiryDays: number | null
): Date | null {
  if (expiryDays === null) return null;
  return new Date(earnedAt.getTime() + expiryDays * MS_PER_DAY);
}

/** Minimal program shape the version selector needs. */
export type EffectiveWindowProgram = {
  id: string;
  version: number;
  status: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

/**
 * The program version in force at `at`: status `active` or `retired` (a
 * retired version still governs the period it WAS effective — its `effective_to`
 * closes it), `effectiveFrom <= at < effectiveTo` (a null `effectiveTo` is
 * open-ended). When windows overlap (they must not — the activate
 * transaction prevents it) the highest `version` wins, deterministically.
 */
export function selectEffectiveProgram<T extends EffectiveWindowProgram>(
  programs: readonly T[],
  at: Date
): T | null {
  const instant = at.getTime();
  let best: T | null = null;

  for (const program of programs) {
    if (program.status !== "active" && program.status !== "retired") continue;
    if (program.effectiveFrom === null) continue;
    if (Date.parse(program.effectiveFrom) > instant) continue;
    if (
      program.effectiveTo !== null &&
      Date.parse(program.effectiveTo) <= instant
    ) {
      continue;
    }
    if (best === null || program.version > best.version) best = program;
  }

  return best;
}
