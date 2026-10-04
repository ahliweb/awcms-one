/**
 * Stable identifiers of the six POS operational-report projections
 * `commerce` contributes to the `reporting` engine (Issue #296, ADR-0035) -
 * the same role `sales-report-keys.ts` plays for the three sales projections.
 * Pure constants; the descriptors live in `commerce/module.ts`
 * (`reportingProjections`), the sinks and hooks in
 * `application/operational-report-projection.ts`, the arithmetic in
 * `domain/operational-report-deltas.ts`.
 *
 * ## Adding a family (the returns contract)
 *
 * A new family (returns/refunds from #287, inventory from #282, tax from #293
 * once those exist) is one more entry in {@link OPERATIONAL_REPORT_FAMILIES}
 * and one more block of the five pieces above. The registry below is the one
 * place that says which feature gates a family, which permission reads it and
 * which projection feeds it, so the routes, the screen, the CSV export and
 * the tests cannot drift into four slightly different answers.
 */

export const POS_TENDER_DAILY_PROJECTION_KEY = "commerce.pos_tender_daily";
export const POS_CASH_UP_VARIANCE_PROJECTION_KEY =
  "commerce.pos_cash_up_variance";
export const POS_EXPENSE_DAILY_PROJECTION_KEY = "commerce.pos_expense_daily";
export const POS_LOYALTY_DAILY_PROJECTION_KEY = "commerce.pos_loyalty_daily";
export const POS_STORED_VALUE_DAILY_PROJECTION_KEY =
  "commerce.pos_stored_value_daily";

export const POS_RETURNS_DAILY_PROJECTION_KEY = "commerce.pos_returns_daily";

export const OPERATIONAL_REPORT_PROJECTION_KEYS = [
  POS_TENDER_DAILY_PROJECTION_KEY,
  POS_CASH_UP_VARIANCE_PROJECTION_KEY,
  POS_EXPENSE_DAILY_PROJECTION_KEY,
  POS_LOYALTY_DAILY_PROJECTION_KEY,
  POS_STORED_VALUE_DAILY_PROJECTION_KEY,
  POS_RETURNS_DAILY_PROJECTION_KEY
] as const;

export type OperationalReportProjectionKey =
  (typeof OPERATIONAL_REPORT_PROJECTION_KEYS)[number];

/** Stream keys. Cursors are per (tenant, projection, stream), so the cash-up and expense projections, which read two sources each, keep one cursor per source. */
export const OPERATIONAL_STREAM_KEYS = {
  allocations: "payment_allocations",
  closeRequests: "close_requests",
  corrections: "corrections",
  expensesPosted: "expenses_posted",
  expensesReversed: "expenses_reversed",
  loyaltyLedger: "loyalty_ledger",
  storedValueLedger: "stored_value_ledger",
  returns: "returns",
  returnLines: "return_lines"
} as const;

/** The scalar "rows consumed" counters each stream keeps in the engine's own metrics (what the generic projection card shows and the engine's own `COUNT(*)` reconciliation checks). */
export const OPERATIONAL_METRIC_KEYS = {
  tenderSucceeded: "allocations_succeeded",
  cashUpAuto: "cash_ups_auto",
  cashUpApproved: "cash_ups_approved",
  corrections: "corrections_recorded",
  expensePostedAuto: "expenses_posted_auto",
  expensePostedApproved: "expenses_posted_approved",
  expenseReversed: "expenses_reversed",
  loyaltyEntries: "loyalty_entries",
  storedValueEntries: "stored_value_entries",
  returnsRecorded: "returns_recorded",
  returnLinesRecorded: "return_lines_recorded",
  refundLegsScanned: "refund_ledger_legs_succeeded"
} as const;

/** Reconciliation keys of the dimensional control totals (integers: counts, points, or money in cents). */
export const TENDER_CONTROL_KEYS = {
  paymentCount: "tender_payment_count",
  paymentCents: "tender_payment_cents",
  reversalCount: "tender_reversal_count",
  reversalCents: "tender_reversal_cents"
} as const;

export const CASH_UP_CONTROL_KEYS = {
  lines: "cash_up_lines",
  expectedCents: "cash_up_expected_cents",
  countedCents: "cash_up_counted_cents",
  adjustmentCents: "cash_up_adjustment_cents"
} as const;

export const EXPENSE_CONTROL_KEYS = {
  postedCount: "expense_posted_count",
  postedCents: "expense_posted_cents",
  reversedCount: "expense_reversed_count",
  reversedCents: "expense_reversed_cents"
} as const;

export const LOYALTY_CONTROL_KEYS = {
  entries: "loyalty_entries_bucketed",
  pointsNet: "loyalty_points_net"
} as const;

export const STORED_VALUE_CONTROL_KEYS = {
  entries: "stored_value_entries_bucketed",
  netCents: "stored_value_net_cents"
} as const;

export const RETURNS_CONTROL_KEYS = {
  returnCount: "returns_count",
  returnCents: "returns_cents",
  lineCount: "return_lines_count",
  lineUnits: "return_lines_units",
  lineCents: "return_lines_cents",
  refundCount: "refund_legs_count",
  refundCents: "refund_legs_cents"
} as const;

/** The report families the read routes, CSV exports and the screen expose. Each maps 1:1 to a projection. */
export type OperationalReportFamily =
  "tenders" | "cash-ups" | "expenses" | "loyalty" | "stored-value" | "returns";

export type OperationalReportFamilyDefinition = {
  family: OperationalReportFamily;
  projectionKey: OperationalReportProjectionKey;
  /** The commerce feature that must be ON for the family to show anything; `null` when the source exists in every tenant (payments). */
  feature:
    "register" | "expenses" | "loyalty" | "storedValue" | "returns" | null;
};

export const OPERATIONAL_REPORT_FAMILIES: readonly OperationalReportFamilyDefinition[] =
  [
    {
      family: "tenders",
      projectionKey: POS_TENDER_DAILY_PROJECTION_KEY,
      feature: null
    },
    {
      family: "cash-ups",
      projectionKey: POS_CASH_UP_VARIANCE_PROJECTION_KEY,
      feature: "register"
    },
    {
      family: "expenses",
      projectionKey: POS_EXPENSE_DAILY_PROJECTION_KEY,
      feature: "expenses"
    },
    {
      family: "loyalty",
      projectionKey: POS_LOYALTY_DAILY_PROJECTION_KEY,
      feature: "loyalty"
    },
    {
      family: "stored-value",
      projectionKey: POS_STORED_VALUE_DAILY_PROJECTION_KEY,
      feature: "storedValue"
    },
    {
      family: "returns",
      projectionKey: POS_RETURNS_DAILY_PROJECTION_KEY,
      feature: "returns"
    }
  ];
