/**
 * Customer-retention rules - Issue #364, ADR-0044, spec
 * `docs/aw-business-platform-metrics.md` section 6. PURE: no database, no I/O,
 * no clock (every function that needs "now" takes it). The `commerce.
 * customer_retention` reporting projection, its reconciliation control totals
 * and its read route all run THESE functions, which is what makes "rebuild
 * equals live" a property of the code and not a hope.
 *
 * ## The contract in one paragraph
 *
 * A customer belongs to the cohort of the `Asia/Jakarta` calendar month of
 * their FIRST qualifying event, once, forever (until a late event moves it).
 * Commerce-only, so a qualifying event is a paid order that was not fully
 * refunded or cancelled afterwards. The cohort's retention is the share of its
 * customers with a SECOND qualifying order whose instant is after the first
 * and within `90 x 24 h` of it, inclusive of the final instant. A cohort whose
 * window has not fully elapsed is IMMATURE ("to date"); a cohort under 20
 * customers shows counts, not a percentage.
 *
 * ## Qualifying order
 *
 * `paid_at` is set, the lifecycle status is a paid state (`paid`, `processing`,
 * `shipped`, `completed` - the sales reports' own set), and the cached payment
 * axis is not `refunded` (a ledger whose net settled amount fell to zero after
 * money had come in: the payment ledger derives `refunded` exactly then, so a
 * PARTIAL refund keeps the order qualifying and a full one removes it). A
 * cancelled or expired order is not in a paid state.
 *
 * ## Why the instant is `paid_at`
 *
 * It is the moment the order reached paid and never moves afterwards (the
 * sales reports attribute to it for the same reason). The cohort month is the
 * Jakarta calendar month of that instant.
 *
 * ## The booking anchor (Issue #389, metrics 6.2)
 *
 * A customer's events are no longer only orders. A paid order that carries a
 * Booking reservation link is ONE booking event (the confirmed booking), and:
 *
 *   * its instant is the order's first paid transition - the instant the
 *     adapter confirms the reservation on (`commerce.booking_order_paid_
 *     confirmer` consumes `order.paid`), so "the confirmation instant is the
 *     anchor" reads `paid_at` on the commerce side of the seam;
 *   * a reschedule's replacement reservation sits on the SAME order, and the
 *     supplementary order a reschedule that added nights created is part of the
 *     same stay: neither is a second event (the replacement counts once, and
 *     the second event must be a distinct order or reservation);
 *   * a booking that was CANCELLED (every standing reservation link released by
 *     a cancellation decision) is not an event even when a retained deposit
 *     keeps the order from being fully refunded; a no-show still is one (the
 *     contract excludes cancelled, expired and rescheduled-away bookings, and a
 *     guest who booked, paid and did not come did book);
 *   * a reservation with no link has no derivable customer and is in no cohort
 *     (data model 5.1 rule 3, metrics Q7).
 *
 * The facts the rule reads - link statuses and decision kinds - are
 * APPEND-ONLY or write-once, so the recompute is triggered by the two streams
 * that carry them (the refund decision and the reschedule record), not by a
 * mutable flag. The attention flag is deliberately NOT consulted.
 *
 * ## Time zone
 *
 * The 90-day window is absolute time (`90 x 24 h`), not 90 calendar days. The
 * cohort month boundary is the Jakarta midnight; `Asia/Jakarta` is UTC+7 with
 * no daylight saving (spec 1.1 rule 3), so the month start instant is the UTC
 * month start minus seven hours. {@link cohortMonthOf} goes through the same
 * `Intl` resolver the sales reports use, and the unit tests pin the two
 * together.
 */
import {
  SALES_PAID_STATES,
  SALES_REPORT_TIME_ZONE,
  resolveSalesReportDay
} from "./sales-report-deltas";

export { SALES_REPORT_TIME_ZONE as RETENTION_TIME_ZONE };

/** N, configuration-free in v1 (spec 6.2). */
export const RETENTION_WINDOW_DAYS = 90;
export const RETENTION_WINDOW_MS = RETENTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** The window as hours, for the SQL that evaluates it (`interval '2160 hours'` is absolute, a `'90 days'` interval is calendar-aware and zone-dependent). */
export const RETENTION_WINDOW_HOURS = RETENTION_WINDOW_DAYS * 24;

/** A cohort smaller than this shows counts, not a percentage (spec 6.2: noise and re-identification). */
export const RETENTION_MIN_COHORT_FOR_RATE = 20;

/** Owner-accepted restatement window (spec 1.2, Q1). */
export const RETENTION_RESTATEMENT_WINDOW_DAYS = 35;
export const RETENTION_RESTATEMENT_WINDOW_HOURS =
  RETENTION_RESTATEMENT_WINDOW_DAYS * 24;
const RESTATEMENT_WINDOW_MS =
  RETENTION_RESTATEMENT_WINDOW_HOURS * 60 * 60 * 1000;

/** `Asia/Jakarta` is UTC+7 all year. */
const JAKARTA_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/** How many cohort months one read may span. */
export const RETENTION_MAX_MONTHS = 36;
export const RETENTION_DEFAULT_MONTHS = 12;

export const RETENTION_PROJECTION_KEY = "commerce.customer_retention";

/** Stream keys: cursors are per (tenant, projection, stream). */
export const RETENTION_STREAM_KEYS = {
  orderEvents: "order_events",
  reversalLegs: "reversal_legs",
  /** Issue #389 - the booking anchor: a cancellation or no-show decision of a reservation link. */
  bookingDecisions: "booking_decisions",
  /** Issue #389 - the booking anchor: a reschedule (and the supplementary order it created). */
  bookingReschedules: "booking_reschedules"
} as const;

export const RETENTION_METRIC_KEYS = {
  paidEvents: "retention_paid_events",
  reversalLegs: "retention_reversal_legs",
  bookingDecisions: "retention_booking_decisions",
  bookingReschedules: "retention_booking_reschedules"
} as const;

/** Reconciliation keys of the dimensional control totals (integers). */
export const RETENTION_CONTROL_KEYS = {
  customers: "retention_customers",
  repeaters: "retention_repeaters",
  qualifyingOrders: "retention_qualifying_orders",
  /** Issue #389 - how many of the qualifying events are bookings. */
  bookingEvents: "retention_booking_events"
} as const;

// ---------------------------------------------------------------------------
// Qualifying orders and per-customer derivation
// ---------------------------------------------------------------------------

/**
 * What the booking adapter says about an order (Issue #389): `reservation` -
 * the order carries reservation links (`standing` = at least one is not
 * superseded and not released by a cancellation); `supplement` - the
 * supplementary order of a reschedule. Absent = an ordinary order.
 */
export type RetentionBookingFact =
  { kind: "reservation"; standing: boolean } | { kind: "supplement" };

export type RetentionOrderFact = {
  orderId: string;
  paidAt: Date | null;
  status: string;
  paymentStatus: string;
  booking?: RetentionBookingFact;
};

export function isQualifyingRetentionOrder(
  fact: Pick<RetentionOrderFact, "paidAt" | "status" | "paymentStatus">
): boolean {
  return (
    fact.paidAt !== null &&
    SALES_PAID_STATES.has(fact.status) &&
    fact.paymentStatus !== "refunded"
  );
}

export type RetentionEventKind = "order" | "booking";

export type RetentionEvent = {
  orderId: string;
  at: number;
  kind: RetentionEventKind;
};

/**
 * The qualifying EVENT an order contributes, or `null`: an ordinary qualifying
 * order is an `order` event, a qualifying booking order whose stay still
 * stands is a `booking` event, a supplementary order and a cancelled stay are
 * none (see the file header).
 */
export function retentionEventOf(
  fact: RetentionOrderFact
): RetentionEvent | null {
  if (!isQualifyingRetentionOrder(fact)) return null;
  const at = fact.paidAt!.getTime();
  if (!fact.booking) return { orderId: fact.orderId, at, kind: "order" };
  if (fact.booking.kind === "supplement") return null;
  return fact.booking.standing
    ? { orderId: fact.orderId, at, kind: "booking" }
    : null;
}

export type CustomerRetention = {
  /** First day of the Jakarta calendar month of {@link firstEventAt}, `YYYY-MM-01`. */
  cohortMonth: string;
  firstEventAt: Date;
  /** Earliest qualifying instant strictly after the first; `null` when there is none. */
  secondEventAt: Date | null;
  /** Qualifying events: ordinary orders plus bookings (a stay is one event). */
  qualifyingOrderCount: number;
  /** Issue #389 - what the first event was. */
  firstEventKind: RetentionEventKind;
  /** Issue #389 - how many of the qualifying events are bookings. */
  qualifyingBookingCount: number;
};

/**
 * Derives one customer's row from the customer's CURRENT order facts - the only
 * way the sink ever writes a row (a recompute, never an increment). `null`
 * when the customer has no qualifying event (the row is then deleted).
 *
 * Ties: two events at the same instant are two distinct events, but the second
 * event must be strictly AFTER the first, so the second is the earliest
 * instant greater than the first. When a booking and an order tie for first,
 * the booking is the anchor (deterministic and independent of read order).
 */
export function deriveCustomerRetention(
  facts: readonly RetentionOrderFact[]
): CustomerRetention | null {
  const events: RetentionEvent[] = [];
  for (const fact of facts) {
    const event = retentionEventOf(fact);
    if (event !== null) events.push(event);
  }
  if (events.length === 0) return null;
  let first = events[0]!;
  for (const event of events) {
    if (
      event.at < first.at ||
      (event.at === first.at &&
        event.kind === "booking" &&
        first.kind !== "booking")
    ) {
      first = event;
    }
  }
  let second: number | null = null;
  for (const event of events) {
    if (event.at > first.at && (second === null || event.at < second)) {
      second = event.at;
    }
  }
  const firstEventAt = new Date(first.at);
  return {
    cohortMonth: cohortMonthOf(firstEventAt),
    firstEventAt,
    secondEventAt: second === null ? null : new Date(second),
    qualifyingOrderCount: events.length,
    firstEventKind: first.kind,
    qualifyingBookingCount: events.filter((event) => event.kind === "booking")
      .length
  };
}

// ---------------------------------------------------------------------------
// Cohort month and the windows
// ---------------------------------------------------------------------------

/** `YYYY-MM-01` of the Jakarta calendar month containing `instant`. */
export function cohortMonthOf(instant: Date): string {
  return `${resolveSalesReportDay(instant).slice(0, 7)}-01`;
}

function monthParts(cohortMonth: string): { year: number; monthIndex: number } {
  const year = Number(cohortMonth.slice(0, 4));
  const monthIndex = Number(cohortMonth.slice(5, 7)) - 1;
  return { year, monthIndex };
}

/** The first instant of the Jakarta month `cohortMonth` (`YYYY-MM-01`). */
export function cohortMonthStart(cohortMonth: string): Date {
  const { year, monthIndex } = monthParts(cohortMonth);
  return new Date(Date.UTC(year, monthIndex, 1) - JAKARTA_UTC_OFFSET_MS);
}

/** The first instant AFTER the month: the half-open end of the cohort month. */
export function cohortMonthEnd(cohortMonth: string): Date {
  const { year, monthIndex } = monthParts(cohortMonth);
  return new Date(Date.UTC(year, monthIndex + 1, 1) - JAKARTA_UTC_OFFSET_MS);
}

/** The instant from which every member's 90-day window has fully elapsed. */
export function cohortMaturesAt(cohortMonth: string): Date {
  return new Date(cohortMonthEnd(cohortMonth).getTime() + RETENTION_WINDOW_MS);
}

export function isCohortMature(cohortMonth: string, now: Date): boolean {
  return now.getTime() >= cohortMaturesAt(cohortMonth).getTime();
}

/** The instant after which a change to the cohort is a restatement (month end + 35 days). */
export function cohortRestatementThreshold(cohortMonth: string): Date {
  return new Date(
    cohortMonthEnd(cohortMonth).getTime() + RESTATEMENT_WINDOW_MS
  );
}

/** `true` when the second event falls after the first and within the window (the final instant is inside). */
export function isRepeatWithinWindow(
  firstEventAt: Date,
  secondEventAt: Date | null
): boolean {
  if (secondEventAt === null) return false;
  const gap = secondEventAt.getTime() - firstEventAt.getTime();
  return gap > 0 && gap <= RETENTION_WINDOW_MS;
}

/** Adds `delta` calendar months to a `YYYY-MM-01` string. */
export function addCohortMonths(cohortMonth: string, delta: number): string {
  const { year, monthIndex } = monthParts(cohortMonth);
  const total = year * 12 + monthIndex + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
}

// ---------------------------------------------------------------------------
// Cohort tallies (the read model)
// ---------------------------------------------------------------------------

export type RetentionCohortCounts = {
  cohortMonth: string;
  size: number;
  repeaters: number;
  /** Issue #389 - cohort members whose first event was a confirmed booking. */
  bookingAnchored?: number;
};

export type RetentionCohort = Omit<RetentionCohortCounts, "bookingAnchored"> & {
  /** Issue #389 - cohort members whose first event was a confirmed booking. */
  bookingAnchored: number;
  /** `true` once every member's 90-day window has elapsed; otherwise the figure is "to date". */
  mature: boolean;
  /** ISO instant the cohort matures. */
  maturesAt: string;
  /** `false` under {@link RETENTION_MIN_COHORT_FOR_RATE}: counts only. */
  rateShown: boolean;
  /** One decimal place, round-half-up, or `null` when {@link rateShown} is `false`. */
  ratePercent: string | null;
  /** The cohort changed after its restatement window closed (spec 1.2). */
  restated: boolean;
  restatedAt: string | null;
};

/** `repeaters / size` as a one-decimal percentage string, round-half-up on integers (no float). */
export function formatRetentionRate(repeaters: number, size: number): string {
  if (size <= 0) return "0.0";
  // tenths = round-half-up(repeaters * 1000 / size)
  const tenths = Math.floor((repeaters * 2000 + size) / (size * 2));
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

export function shapeRetentionCohorts(
  rows: readonly RetentionCohortCounts[],
  now: Date,
  restatedAtByMonth: ReadonlyMap<string, Date> = new Map()
): RetentionCohort[] {
  return [...rows]
    .sort((a, b) => a.cohortMonth.localeCompare(b.cohortMonth))
    .map((row) => {
      const rateShown = row.size >= RETENTION_MIN_COHORT_FOR_RATE;
      const restatedAt = restatedAtByMonth.get(row.cohortMonth) ?? null;
      return {
        ...row,
        bookingAnchored: row.bookingAnchored ?? 0,
        mature: isCohortMature(row.cohortMonth, now),
        maturesAt: cohortMaturesAt(row.cohortMonth).toISOString(),
        rateShown,
        ratePercent: rateShown
          ? formatRetentionRate(row.repeaters, row.size)
          : null,
        restated: restatedAt !== null,
        restatedAt: restatedAt === null ? null : restatedAt.toISOString()
      };
    });
}

// ---------------------------------------------------------------------------
// Restatement
// ---------------------------------------------------------------------------

export type RetentionRowState = {
  cohortMonth: string;
  firstEventAt: Date;
  secondEventAt: Date | null;
};

/**
 * Which cohort months a recompute restated, given the customer's previous row
 * (`null` = none) and the new one (`null` = none), at `now`. A cohort is
 * restated when it changed AFTER its restatement window closed (month end plus
 * 35 days) and the change is not ordinary maturation:
 *
 *   * membership changed (the customer joined, left or moved cohort) - in the
 *     normal flow a customer only ever joins the CURRENT month, whose window
 *     has not closed, so a join to a closed cohort is a backdated fact;
 *   * a repeat was lost (true -> false): a repeat order was cancelled/refunded;
 *   * a repeat appeared (false -> true) while the cohort is already mature: no
 *     ordinary order can still arrive inside a matured window, so it is a
 *     backdated fact. Before maturity it is just the cohort filling in.
 */
export function restatedCohortMonths(
  previous: RetentionRowState | null,
  next: RetentionRowState | null,
  now: Date
): string[] {
  const months = new Set<string>();
  const closed = (cohortMonth: string) =>
    now.getTime() >= cohortRestatementThreshold(cohortMonth).getTime();
  const repeat = (state: RetentionRowState | null) =>
    state !== null &&
    isRepeatWithinWindow(state.firstEventAt, state.secondEventAt);

  if (previous === null && next === null) return [];
  if (previous === null || next === null) {
    const only = (previous ?? next)!;
    if (closed(only.cohortMonth)) months.add(only.cohortMonth);
  } else if (previous.cohortMonth !== next.cohortMonth) {
    if (closed(previous.cohortMonth)) months.add(previous.cohortMonth);
    if (closed(next.cohortMonth)) months.add(next.cohortMonth);
  } else {
    const was = repeat(previous);
    const is = repeat(next);
    if (closed(next.cohortMonth)) {
      if (was && !is) months.add(next.cohortMonth);
      if (!was && is && isCohortMature(next.cohortMonth, now)) {
        months.add(next.cohortMonth);
      }
    }
  }
  return [...months].sort();
}

// ---------------------------------------------------------------------------
// Control totals
// ---------------------------------------------------------------------------

export type RetentionControlTotals = {
  customers: number;
  repeaters: number;
  qualifyingOrders: number;
  bookingEvents: number;
};

export function emptyRetentionControlTotals(): RetentionControlTotals {
  return { customers: 0, repeaters: 0, qualifyingOrders: 0, bookingEvents: 0 };
}

export function accumulateRetentionControlTotals(
  totals: RetentionControlTotals,
  customer: CustomerRetention
): void {
  totals.customers += 1;
  totals.qualifyingOrders += customer.qualifyingOrderCount;
  totals.bookingEvents += customer.qualifyingBookingCount;
  if (isRepeatWithinWindow(customer.firstEventAt, customer.secondEventAt)) {
    totals.repeaters += 1;
  }
}

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

export type RetentionRange = { months: number };

export function validateRetentionRange(input: {
  months: string | null;
}):
  | { valid: true; value: RetentionRange }
  | { valid: false; errors: { field: string; message: string }[] } {
  if (input.months === null || input.months === "") {
    return { valid: true, value: { months: RETENTION_DEFAULT_MONTHS } };
  }
  if (!/^\d{1,2}$/.test(input.months)) {
    return {
      valid: false,
      errors: [
        {
          field: "months",
          message: `months must be an integer from 1 to ${RETENTION_MAX_MONTHS}.`
        }
      ]
    };
  }
  const months = Number(input.months);
  if (months < 1 || months > RETENTION_MAX_MONTHS) {
    return {
      valid: false,
      errors: [
        {
          field: "months",
          message: `months must be an integer from 1 to ${RETENTION_MAX_MONTHS}.`
        }
      ]
    };
  }
  return { valid: true, value: { months } };
}
