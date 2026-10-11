/**
 * Loyalty & rewards — shared types, constants and integer helpers
 * (Issue #289, ADR-0026). Pure — no database, no I/O.
 *
 * ## Points are integers, never floats and never money
 *
 * Every quantity of points in this feature is a JavaScript `number` that is a
 * SAFE INTEGER, bounded by {@link MAX_LEDGER_POINTS} (`sql/950`'s
 * `awcms_commerce_loyalty_ledger_points_range` CHECK states the same bound in
 * the database). {@link assertPoints} is the single guard every write path and
 * every row-decoder goes through. Money (`numeric(14,2)`) only appears at the
 * earn boundary (`domain/loyalty-earn.ts`), where it is converted to integer
 * cents first and never touches a float.
 *
 * ## Five entry kinds, one sign discipline each
 *
 *   earn        > 0   points granted for a paid order (a LOT: may carry `expiresAt`)
 *   redeem      < 0   points spent
 *   expire      <= 0  an earn lot (or its remainder) lapsing; 0 is a marker for a
 *                     lot already fully consumed when it fell due
 *   adjustment  != 0  a manual correction — attributable, reason mandatory
 *   reversal    != 0  the compensating entry for ONE earn (an order cancelled)
 *   restore     > 0   the compensating entry for ONE redeem (Issue #363): points
 *                     given back when the order they paid for is cancelled or
 *                     refunded; a new lot, with the soonest expiry the redeem
 *                     had consumed
 *
 * The same rules are CHECK constraints in `sql/950`; {@link isValidEntrySign}
 * is the pure statement of them so the application never relies on a database
 * error to learn it built a bad entry.
 */

export const LOYALTY_ENTRY_KINDS = [
  "earn",
  "redeem",
  "expire",
  "adjustment",
  "reversal",
  // Issue #363 (ADR-0043): gives back points a cancelled/refunded order had
  // spent - the compensating row for ONE `redeem`.
  "restore"
] as const;

export type LoyaltyEntryKind = (typeof LOYALTY_ENTRY_KINDS)[number];

export function isLoyaltyEntryKind(value: unknown): value is LoyaltyEntryKind {
  return (
    typeof value === "string" &&
    (LOYALTY_ENTRY_KINDS as readonly string[]).includes(value)
  );
}

/** Where a ledger row came from. `order` ids are order ids; `expiry` ids are the lapsing lot's entry id. */
export const LOYALTY_SOURCE_TYPES = [
  "order",
  "expiry",
  "redemption",
  "manual",
  // Issue #287 (ADR-0033): a reversal compensating a REFUND of the order, in
  // proportion to the money refunded; `source_id` is the refund's id.
  "refund"
] as const;

export type LoyaltySourceType = (typeof LOYALTY_SOURCE_TYPES)[number];

export const LOYALTY_PROGRAM_STATUSES = ["draft", "active", "retired"] as const;

export type LoyaltyProgramStatus = (typeof LOYALTY_PROGRAM_STATUSES)[number];

export function isLoyaltyProgramStatus(
  value: unknown
): value is LoyaltyProgramStatus {
  return (
    typeof value === "string" &&
    (LOYALTY_PROGRAM_STATUSES as readonly string[]).includes(value)
  );
}

/** Mirrors `sql/950`'s `*_points_range` / `*_balance_range` CHECKs — far inside `Number.MAX_SAFE_INTEGER`. */
export const MAX_LEDGER_POINTS = 1_000_000_000_000;

/** Longest `reason` a ledger row carries (`sql/950`'s `*_reason_check`). */
export const MAX_LOYALTY_REASON_LENGTH = 500;

/** Longest client-supplied `Idempotency-Key` accepted before it is namespaced into a ledger key. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * Asserts `value` is a safe integer within the ledger bound and returns it —
 * the guard behind every decoder of a `bigint` column (the driver may hand one
 * back as a string or a bigint; `Number()` of either is exact inside the
 * bound) and every constructor of a new entry.
 */
export function assertPoints(value: unknown, label = "points"): number {
  const numeric =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string"
        ? Number(value)
        : value;
  if (
    typeof numeric !== "number" ||
    !Number.isSafeInteger(numeric) ||
    Math.abs(numeric) > MAX_LEDGER_POINTS
  ) {
    throw new RangeError(
      `${label} must be a safe integer within ±${MAX_LEDGER_POINTS}.`
    );
  }
  return numeric;
}

/** The sign rule of `sql/950`'s `awcms_commerce_loyalty_ledger_sign_check`, as a pure predicate. */
export function isValidEntrySign(
  kind: LoyaltyEntryKind,
  points: number
): boolean {
  if (!Number.isSafeInteger(points)) return false;
  switch (kind) {
    case "earn":
      return points > 0;
    case "redeem":
      return points < 0;
    case "expire":
      return points <= 0;
    case "adjustment":
    case "reversal":
      return points !== 0;
    case "restore":
      return points > 0;
  }
}

/** One decoded ledger row — what every read path and the lot replay work with. */
export type LoyaltyLedgerEntry = {
  id: string;
  accountId: string;
  accountSeq: number;
  kind: LoyaltyEntryKind;
  points: number;
  balanceAfter: number;
  programId: string | null;
  sourceType: LoyaltySourceType;
  sourceId: string | null;
  reversesEntryId: string | null;
  expiresAt: string | null;
  actorTenantUserId: string | null;
  reason: string | null;
  createdAt: string;
};

export type LoyaltyAccount = {
  id: string;
  customerId: string;
  balance: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type LoyaltyProgram = {
  id: string;
  version: number;
  name: string;
  status: LoyaltyProgramStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** `numeric(14,2)` as a normalised decimal string (ADR-0003). */
  earnUnitAmount: string;
  earnPointsPerUnit: number;
  earnRounding: "floor";
  minOrderAmount: string;
  maxPointsPerOrder: number | null;
  expiryDays: number | null;
  notes: string | null;
  /** Issue #361: the CRM segment (and its immutable version) this version is restricted to; `null` = every customer earns. */
  eligibilitySegmentId: string | null;
  eligibilitySegmentVersion: number | null;
  createdAt: string;
  updatedAt: string;
};

/** The customer-facing projection of a ledger row: no actor, no staff-written reason. */
export type CustomerLoyaltyHistoryItem = {
  id: string;
  kind: LoyaltyEntryKind;
  points: number;
  balanceAfter: number;
  expiresAt: string | null;
  createdAt: string;
};
