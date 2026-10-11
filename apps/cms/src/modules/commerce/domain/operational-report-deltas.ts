/**
 * POS operational-report delta rules - Issue #296 (ADR-0035). PURE: no
 * database, no I/O, no clock. Everything the five `commerce.pos_*` reporting
 * projections ever add to their tables is computed here and ONLY here - the
 * incremental worker, a rebuild and the reconciliation control totals all run
 * the same functions over the same source facts, which is what makes "rebuild
 * equals live" and "reconcile reports no mismatch" properties of the code
 * rather than hopes (the argument `sales-report-deltas.ts` makes for the sales
 * projections, applied to five more).
 *
 * ## The metric contract (the issue's nine questions, one block per family)
 *
 * ### tenders - `commerce.pos_tender_daily`
 * Source `awcms_commerce_payment_allocations`, cursor `settled_at` (a pending
 * gateway leg has no `settled_at` and is therefore invisible until it
 * resolves; ADR-0025's append-only guard lets a row change exactly once, from
 * pending to succeeded/failed, and `settled_at` is set in that same update).
 * Dimensions: day x register x tender. A `payment` leg ADDS to the payment
 * count/sum, a `reversal` leg ADDS to the reversal count/sum (both positive;
 * net is derived at read), a `failed` leg is ignored. Day = `settled_at` in
 * {@link SALES_REPORT_TIME_ZONE}. The register is the one stamped on the leg
 * through its session (`register_session_id`); an unstamped leg (online,
 * back-office) lands on {@link OPERATIONAL_NO_REGISTER_ID}.
 *
 * ### cash-ups - `commerce.pos_cash_up_variance`
 * Sources `awcms_commerce_register_close_requests` (cursor `decided_at`, only
 * decision `auto`/`approved` - a `pending`/`rejected` attempt never closed the
 * session) with its `register_close_lines`, and `awcms_commerce_register_
 * corrections` (cursor `created_at`). Dimensions: session x tender, carrying
 * the register, the cashier of record and the day the session closed. The
 * approved close adds expected + counted; a correction adds a signed
 * adjustment to the counted figure (ADR-0028 D5: the corrected figure is the
 * original plus its corrections). Variance = counted + adjustment - expected,
 * derived at read.
 *
 * ### expenses - `commerce.pos_expense_daily`
 * Source `awcms_commerce_expenses`, TWO streams: cursor `posted_at` (a posting
 * ADDS) and cursor `reversed_at` (a reversal ADDS to the reversed columns).
 * Both land on the expense's `occurred_on` - the business date the tenant
 * typed, a calendar date and not an instant, so no time-zone conversion - so
 * a reversal subtracts from the same day row its posting added to. Dimensions:
 * day x category x tender. Drafts, pending and cancelled expenses never enter.
 *
 * ### loyalty - `commerce.pos_loyalty_daily` and stored value
 * ### - `commerce.pos_stored_value_daily`
 * Sources the append-only ledgers (cursor `created_at`). Each entry is
 * classified into a bucket by `kind`, with adjustments and reversals split by
 * sign so "points given back" and "points taken back" stay apart. Day =
 * `created_at` in {@link SALES_REPORT_TIME_ZONE}. The figure per bucket is the
 * signed sum; OUTSTANDING is the sum of every bucket ever (the ledger's own
 * definition of a balance), read as a cumulative at query time.
 *
 * ### returns - `commerce.pos_returns_daily` (Issue #316)
 * Three streams into one long table, every one over a source whose cursor is
 * NOT NULL from insert. (1) `awcms_commerce_returns`, cursor `created_at`: a
 * return or exchange adds one to its `return`/`exchange` bucket and its refund
 * total (goods - discount + shipping + tax) to the amount. (2) `awcms_commerce_
 * return_lines`, cursor `created_at`, append-only: a line adds one line, its
 * units and its refunded value to its disposition bucket (`restock` = put back
 * on the shelf, `damaged` = written off, `quarantine` = held). (3) the payment
 * ledger's succeeded REVERSAL legs that a refund booked (the existing
 * `settled_at` stream; a reversal with no refund behind it - an order
 * cancellation - is the tender report's, not this one's): one refund leg, its
 * money, by the tender it went back by and whether it went to the original
 * tender or into store credit. Returns and lines land on the day they were
 * RECORDED and on the register of the original sale; a refund leg lands on the
 * day it SETTLED and the register of the session that paid it out. Nothing
 * here is signed: a refund is its own positive column, never a negative sale.
 * The original sale's day is amended by the sales projections (ADR-0033), not
 * by this one.
 *
 * ## Late events
 *
 * Every figure lands on the day the source fact carries, never on the day it
 * was processed, so a late-arriving fact (a gateway leg that settles after
 * midnight, a correction a week after the close) is added to ITS day: history
 * is amended, never today's number inflated. The cost is that a published day
 * can change; the freshness policy and the reconcile report are how that is
 * surfaced, and a rebuild reproduces it exactly.
 *
 * ## Money
 *
 * Integer cents as `bigint` (the module's one signed parser), rendered back as
 * a signed `numeric(14,2)` string for SQL. Loyalty points are plain integers.
 */
import { signedFromCents, signedToCents } from "./register";
import {
  resolveSalesReportDay,
  SALES_REPORT_TIME_ZONE
} from "./sales-report-deltas";

export { SALES_REPORT_TIME_ZONE };

/** All-zero uuid: the `register_id` of a leg that was not taken on a register - `register_id` is part of the primary key and cannot be NULL. */
export const OPERATIONAL_NO_REGISTER_ID =
  "00000000-0000-0000-0000-000000000000";

/** Signed `numeric(14,2)` string for a cents delta (`-150n` -> `"-1.50"`). */
export const formatSignedCents = signedFromCents;

// ---------------------------------------------------------------------------
// tenders
// ---------------------------------------------------------------------------

export type TenderAllocationFact = {
  kind: string;
  tenderType: string;
  /** `numeric(14,2)` string, always positive in the ledger. */
  amount: string;
  status: string;
  settledAt: Date | null;
  /** The register of the session the leg was stamped with, `null` when unstamped. */
  registerId: string | null;
};

export type TenderDailyDelta = {
  day: string;
  registerId: string;
  tenderType: string;
  paymentCount: number;
  paymentCents: bigint;
  reversalCount: number;
  reversalCents: bigint;
};

export function computeTenderDailyDelta(
  fact: TenderAllocationFact
): TenderDailyDelta | null {
  if (fact.status !== "succeeded" || fact.settledAt === null) return null;
  const cents = signedToCents(fact.amount);
  const isReversal = fact.kind === "reversal";
  return {
    day: resolveSalesReportDay(fact.settledAt),
    registerId: fact.registerId ?? OPERATIONAL_NO_REGISTER_ID,
    tenderType: fact.tenderType,
    paymentCount: isReversal ? 0 : 1,
    paymentCents: isReversal ? 0n : cents,
    reversalCount: isReversal ? 1 : 0,
    reversalCents: isReversal ? cents : 0n
  };
}

// ---------------------------------------------------------------------------
// cash-ups
// ---------------------------------------------------------------------------

export type CashUpSessionFact = {
  sessionId: string;
  registerId: string;
  cashierTenantUserId: string;
  /** When the session reached `closed`; the day bucket. Falls back to the decision time. */
  closedAt: Date | null;
};

export type CashUpLineFact = {
  tenderType: string;
  expected: string;
  counted: string;
};

export type CashUpCorrectionFact = {
  tenderType: string;
  /** Signed `numeric(14,2)`, never zero. */
  adjustment: string;
};

export type CashUpDelta = {
  sessionId: string;
  tenderType: string;
  registerId: string;
  cashierTenantUserId: string;
  day: string;
  lines: number;
  expectedCents: bigint;
  countedCents: bigint;
  adjustmentCents: bigint;
};

export function computeCashUpLineDelta(
  session: CashUpSessionFact,
  decidedAt: Date,
  line: CashUpLineFact
): CashUpDelta {
  return {
    sessionId: session.sessionId,
    tenderType: line.tenderType,
    registerId: session.registerId,
    cashierTenantUserId: session.cashierTenantUserId,
    day: resolveSalesReportDay(session.closedAt ?? decidedAt),
    lines: 1,
    expectedCents: signedToCents(line.expected),
    countedCents: signedToCents(line.counted),
    adjustmentCents: 0n
  };
}

export function computeCashUpCorrectionDelta(
  session: CashUpSessionFact,
  correctedAt: Date,
  correction: CashUpCorrectionFact
): CashUpDelta {
  return {
    sessionId: session.sessionId,
    tenderType: correction.tenderType,
    registerId: session.registerId,
    cashierTenantUserId: session.cashierTenantUserId,
    day: resolveSalesReportDay(session.closedAt ?? correctedAt),
    lines: 0,
    expectedCents: 0n,
    countedCents: 0n,
    adjustmentCents: signedToCents(correction.adjustment)
  };
}

/** Variance of a cash-up row: counted (with corrections applied) minus expected; negative = short. */
export function cashUpVarianceCents(row: {
  expectedCents: bigint;
  countedCents: bigint;
  adjustmentCents: bigint;
}): bigint {
  return row.countedCents + row.adjustmentCents - row.expectedCents;
}

// ---------------------------------------------------------------------------
// expenses
// ---------------------------------------------------------------------------

export type ExpenseFact = {
  /** `YYYY-MM-DD`, the `occurred_on` calendar date. */
  occurredOn: string;
  categoryId: string;
  categoryName: string;
  tenderType: string;
  amount: string;
};

export type ExpenseDailyDelta = {
  day: string;
  categoryId: string;
  categoryName: string;
  tenderType: string;
  postedCount: number;
  postedCents: bigint;
  reversedCount: number;
  reversedCents: bigint;
};

export function computeExpensePostedDelta(
  fact: ExpenseFact
): ExpenseDailyDelta {
  return {
    day: fact.occurredOn,
    categoryId: fact.categoryId,
    categoryName: fact.categoryName,
    tenderType: fact.tenderType,
    postedCount: 1,
    postedCents: signedToCents(fact.amount),
    reversedCount: 0,
    reversedCents: 0n
  };
}

export function computeExpenseReversedDelta(
  fact: ExpenseFact
): ExpenseDailyDelta {
  return {
    day: fact.occurredOn,
    categoryId: fact.categoryId,
    categoryName: fact.categoryName,
    tenderType: fact.tenderType,
    postedCount: 0,
    postedCents: 0n,
    reversedCount: 1,
    reversedCents: signedToCents(fact.amount)
  };
}

// ---------------------------------------------------------------------------
// ledgers (loyalty points, stored value)
// ---------------------------------------------------------------------------

export const LOYALTY_BUCKETS = [
  "earn",
  "redeem",
  "expire",
  "adjustment_up",
  "adjustment_down",
  "reversal_up",
  "reversal_down"
] as const;
export type LoyaltyBucket = (typeof LOYALTY_BUCKETS)[number];

export const STORED_VALUE_BUCKETS = [
  "issue",
  "load",
  "redeem",
  "refund",
  "expire",
  "adjust_up",
  "adjust_down"
] as const;
export type StoredValueBucket = (typeof STORED_VALUE_BUCKETS)[number];

export type LoyaltyLedgerFact = {
  kind: string;
  /** Signed integer points, as the ledger stores them. */
  points: bigint;
  createdAt: Date;
};

export type LoyaltyDailyDelta = {
  day: string;
  bucket: LoyaltyBucket;
  entries: number;
  points: bigint;
};

/** `null` when the ledger kind carries no points (nothing in the loyalty ledger does today, but the table's CHECK allows a zero `expire`). */
export function classifyLoyaltyBucket(
  kind: string,
  points: bigint
): LoyaltyBucket | null {
  switch (kind) {
    case "earn":
    case "redeem":
    case "expire":
      return points === 0n ? null : (kind as LoyaltyBucket);
    case "adjustment":
      return points === 0n
        ? null
        : points > 0n
          ? "adjustment_up"
          : "adjustment_down";
    case "reversal":
      return points === 0n
        ? null
        : points > 0n
          ? "reversal_up"
          : "reversal_down";
    case "restore":
      // Issue #363: a restore is the positive compensating row of a redeem, so
      // it reads in the same "reversed up" bucket a positive reversal does -
      // the bucket vocabulary (and its table CHECK, sql/998) is unchanged.
      return points > 0n ? "reversal_up" : null;
    default:
      return null;
  }
}

export function computeLoyaltyDailyDelta(
  fact: LoyaltyLedgerFact
): LoyaltyDailyDelta | null {
  const bucket = classifyLoyaltyBucket(fact.kind, fact.points);
  if (bucket === null) return null;
  return {
    day: resolveSalesReportDay(fact.createdAt),
    bucket,
    entries: 1,
    points: fact.points
  };
}

export type StoredValueLedgerFact = {
  kind: string;
  /** Signed `numeric(14,2)` string. */
  amount: string;
  /** The account's own kind: `gift_card` or `store_credit`. */
  accountKind: string;
  createdAt: Date;
};

export type StoredValueDailyDelta = {
  day: string;
  accountKind: string;
  bucket: StoredValueBucket;
  entries: number;
  cents: bigint;
};

/** `null` for `disable`/`enable` (zero-amount state changes move no money). */
export function classifyStoredValueBucket(
  kind: string,
  cents: bigint
): StoredValueBucket | null {
  switch (kind) {
    case "issue":
    case "load":
    case "redeem":
    case "refund":
    case "expire":
      return cents === 0n ? null : (kind as StoredValueBucket);
    case "adjust":
      return cents === 0n ? null : cents > 0n ? "adjust_up" : "adjust_down";
    default:
      return null;
  }
}

export function computeStoredValueDailyDelta(
  fact: StoredValueLedgerFact
): StoredValueDailyDelta | null {
  const cents = signedToCents(fact.amount);
  const bucket = classifyStoredValueBucket(fact.kind, cents);
  if (bucket === null) return null;
  return {
    day: resolveSalesReportDay(fact.createdAt),
    accountKind: fact.accountKind,
    bucket,
    entries: 1,
    cents
  };
}

// ---------------------------------------------------------------------------
// returns & refunds (Issue #316)
// ---------------------------------------------------------------------------

export const RETURN_KINDS = ["return", "exchange"] as const;
/** `restock` = back on the shelf; `damaged` = written off; `quarantine` = held, neither. */
export const RETURN_DISPOSITIONS = [
  "restock",
  "damaged",
  "quarantine"
] as const;
export const REFUND_DESTINATIONS = ["original_tender", "store_credit"] as const;
export type ReturnsReportSection = "return" | "disposition" | "refund";

export type ReturnsDailyDelta = {
  day: string;
  registerId: string;
  section: ReturnsReportSection;
  bucket: string;
  /** `''` where the section has no third dimension. */
  detail: string;
  count: number;
  units: number;
  cents: bigint;
};

export type ReturnFact = {
  kind: string;
  /** `numeric(14,2)` string: goods - discount + shipping + tax (Issue #323). */
  refundTotal: string;
  createdAt: Date;
  /** Register of the ORIGINAL sale's session, `null` when not a register sale. */
  registerId: string | null;
};

export function computeReturnDelta(fact: ReturnFact): ReturnsDailyDelta | null {
  if (!(RETURN_KINDS as readonly string[]).includes(fact.kind)) return null;
  return {
    day: resolveSalesReportDay(fact.createdAt),
    registerId: fact.registerId ?? OPERATIONAL_NO_REGISTER_ID,
    section: "return",
    bucket: fact.kind,
    detail: "",
    count: 1,
    units: 0,
    cents: signedToCents(fact.refundTotal)
  };
}

export type ReturnLineFact = {
  disposition: string;
  quantity: number;
  /** `numeric(14,2)` string: the line's goods minus its discount share. */
  refundAmount: string;
  createdAt: Date;
  registerId: string | null;
};

export function computeReturnLineDelta(
  fact: ReturnLineFact
): ReturnsDailyDelta | null {
  if (!(RETURN_DISPOSITIONS as readonly string[]).includes(fact.disposition)) {
    return null;
  }
  return {
    day: resolveSalesReportDay(fact.createdAt),
    registerId: fact.registerId ?? OPERATIONAL_NO_REGISTER_ID,
    section: "disposition",
    bucket: fact.disposition,
    detail: "",
    count: 1,
    units: fact.quantity,
    cents: signedToCents(fact.refundAmount)
  };
}

export type RefundLegFact = {
  /** The ledger leg's kind: only `reversal` can be a refund. */
  kind: string;
  status: string;
  settledAt: Date | null;
  tenderType: string;
  amount: string;
  /** The refund the reversal leg belongs to; `null` when none points at it (a cancellation reversal). */
  destination: string | null;
  registerId: string | null;
};

export function computeRefundLegDelta(
  fact: RefundLegFact
): ReturnsDailyDelta | null {
  if (
    fact.kind !== "reversal" ||
    fact.status !== "succeeded" ||
    fact.settledAt === null ||
    fact.destination === null ||
    !(REFUND_DESTINATIONS as readonly string[]).includes(fact.destination)
  ) {
    return null;
  }
  return {
    day: resolveSalesReportDay(fact.settledAt),
    registerId: fact.registerId ?? OPERATIONAL_NO_REGISTER_ID,
    section: "refund",
    bucket: fact.tenderType,
    detail: fact.destination,
    count: 1,
    units: 0,
    cents: signedToCents(fact.amount)
  };
}

/** Stock the business got back (`restock`) against stock it wrote off (`damaged`), from the disposition rows of a range. */
export function summariseDispositionUnits(
  rows: readonly { bucket: string; units: number }[]
): { restocked: number; writtenOff: number; quarantined: number } {
  let restocked = 0;
  let writtenOff = 0;
  let quarantined = 0;
  for (const row of rows) {
    if (row.bucket === "restock") restocked += row.units;
    else if (row.bucket === "damaged") writtenOff += row.units;
    else if (row.bucket === "quarantine") quarantined += row.units;
  }
  return { restocked, writtenOff, quarantined };
}
