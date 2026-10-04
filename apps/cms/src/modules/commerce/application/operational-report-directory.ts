/**
 * Read side of the POS operational reports (Issue #296, ADR-0035) - the five
 * `GET /api/v1/reports/commerce/operational-*` routes, their `.csv` siblings
 * and the panels on `admin/commerce-reports.astro` read the projection tables
 * through these functions and nothing else. Every function only READs
 * `awcms_commerce_report_*` (maintained by `operational-report-projection.ts`
 * under the `reporting` engine); money is re-rendered through the signed
 * normaliser so the wire always carries the canonical two-decimal string
 * (ADR-0003, and the `Bun.SQL` numeric scale quirk `price-calculation.ts`
 * documents), and every numeric is cast to text in SQL.
 *
 * ## Feature gating
 *
 * A family whose source feature is OFF answers `enabled: false` with empty
 * figures - not an error and not a 409: a report is a view, and "nothing to
 * show because the tenant never opted in" is a state the screen hides, not a
 * fault the caller must handle. History left behind by a feature that was
 * switched OFF is deliberately NOT shown either (the tenant turned the surface
 * off), but it is kept in the tables and reappears if the feature is switched
 * back on.
 *
 * `from`/`to` are inclusive `YYYY-MM-DD` projection days, already validated by
 * `domain/sales-report-query.ts`.
 */
import {
  OPERATIONAL_NO_REGISTER_ID,
  SALES_REPORT_TIME_ZONE,
  cashUpVarianceCents,
  formatSignedCents,
  summariseDispositionUnits
} from "../domain/operational-report-deltas";
import {
  OPERATIONAL_REPORT_FAMILIES,
  type OperationalReportFamily
} from "../domain/operational-report-keys";
import { normalizeSignedMoney, signedToCents } from "../domain/register";
import type { SalesReportRange } from "../domain/sales-report-query";
import { fetchCommerceFeatures } from "./commerce-feature-gate";

type ReportEnvelope = {
  from: string;
  to: string;
  /** The zone every `day` is bucketed in. */
  timeZone: string;
  /** `false` while the family's source feature is off: the rest is empty. */
  enabled: boolean;
};

/** Whether the tenant has the family's source feature switched on. */
export async function isOperationalFamilyEnabled(
  tx: Bun.SQL,
  tenantId: string,
  family: OperationalReportFamily
): Promise<boolean> {
  const feature = OPERATIONAL_REPORT_FAMILIES.find(
    (entry) => entry.family === family
  )?.feature;
  if (feature === null || feature === undefined) return true;
  return (await fetchCommerceFeatures(tx, tenantId))[feature];
}

function envelope(range: SalesReportRange, enabled: boolean): ReportEnvelope {
  return {
    from: range.from,
    to: range.to,
    timeZone: SALES_REPORT_TIME_ZONE,
    enabled
  };
}

const money = (value: unknown) => normalizeSignedMoney(String(value ?? "0"));

// ---------------------------------------------------------------------------
// tenders
// ---------------------------------------------------------------------------

export type TenderReportRow = {
  day: string;
  /** `null` for legs not taken on a register (online, back office). */
  registerId: string | null;
  registerCode: string | null;
  registerName: string | null;
  tenderType: string;
  paymentCount: number;
  payments: string;
  reversalCount: number;
  reversals: string;
  net: string;
};

export type TenderSummaryRow = Omit<TenderReportRow, "day">;

export type TenderReport = ReportEnvelope & {
  items: TenderReportRow[];
  /** `items` folded over the whole range per register and tender (exact cents). */
  summary: TenderSummaryRow[];
  totalPayments: string;
  totalReversals: string;
  totalNet: string;
};

export async function fetchTenderReport(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange
): Promise<TenderReport> {
  if (!(await isOperationalFamilyEnabled(tx, tenantId, "tenders"))) {
    return {
      ...envelope(range, false),
      items: [],
      summary: [],
      totalPayments: "0.00",
      totalReversals: "0.00",
      totalNet: "0.00"
    };
  }
  const rows = (await tx`
    SELECT to_char(t.day, 'YYYY-MM-DD') AS day, t.register_id, r.code AS register_code,
      r.name AS register_name, t.tender_type, t.payment_count,
      t.payments::text AS payments, t.reversal_count, t.reversals::text AS reversals
    FROM awcms_commerce_report_tender_daily t
    LEFT JOIN awcms_commerce_registers r
      ON r.tenant_id = t.tenant_id AND r.id = t.register_id
    WHERE t.tenant_id = ${tenantId}
      AND t.day >= ${range.from}::date AND t.day <= ${range.to}::date
    ORDER BY t.day ASC, r.code ASC NULLS FIRST, t.tender_type ASC
  `) as {
    day: string;
    register_id: string;
    register_code: string | null;
    register_name: string | null;
    tender_type: string;
    payment_count: number;
    payments: string;
    reversal_count: number;
    reversals: string;
  }[];
  let totalPayments = 0n;
  let totalReversals = 0n;
  const items = rows.map((row): TenderReportRow => {
    const payments = signedToCents(String(row.payments));
    const reversals = signedToCents(String(row.reversals));
    totalPayments += payments;
    totalReversals += reversals;
    return {
      day: row.day,
      registerId:
        row.register_id === OPERATIONAL_NO_REGISTER_ID ? null : row.register_id,
      registerCode: row.register_code,
      registerName: row.register_name,
      tenderType: row.tender_type,
      paymentCount: Number(row.payment_count),
      payments: formatSignedCents(payments),
      reversalCount: Number(row.reversal_count),
      reversals: formatSignedCents(reversals),
      net: formatSignedCents(payments - reversals)
    };
  });
  return {
    ...envelope(range, true),
    items,
    summary: summariseTenders(items),
    totalPayments: formatSignedCents(totalPayments),
    totalReversals: formatSignedCents(totalReversals),
    totalNet: formatSignedCents(totalPayments - totalReversals)
  };
}

/** Folds the per-day rows over the range into register x tender, in exact integer cents. */
export function summariseTenders(
  items: readonly TenderReportRow[]
): TenderSummaryRow[] {
  const folded = new Map<
    string,
    {
      row: TenderSummaryRow;
      payments: bigint;
      reversals: bigint;
    }
  >();
  for (const item of items) {
    const key = `${item.registerId ?? "none"}|${item.tenderType}`;
    let entry = folded.get(key);
    if (!entry) {
      entry = {
        row: {
          registerId: item.registerId,
          registerCode: item.registerCode,
          registerName: item.registerName,
          tenderType: item.tenderType,
          paymentCount: 0,
          payments: "0.00",
          reversalCount: 0,
          reversals: "0.00",
          net: "0.00"
        },
        payments: 0n,
        reversals: 0n
      };
      folded.set(key, entry);
    }
    entry.row.paymentCount += item.paymentCount;
    entry.row.reversalCount += item.reversalCount;
    entry.payments += signedToCents(item.payments);
    entry.reversals += signedToCents(item.reversals);
  }
  return [...folded.values()].map(({ row, payments, reversals }) => ({
    ...row,
    payments: formatSignedCents(payments),
    reversals: formatSignedCents(reversals),
    net: formatSignedCents(payments - reversals)
  }));
}

// ---------------------------------------------------------------------------
// cash-ups
// ---------------------------------------------------------------------------

export type CashUpReportRow = {
  day: string;
  sessionId: string;
  registerId: string;
  registerCode: string | null;
  registerName: string | null;
  cashierTenantUserId: string;
  tenderType: string;
  expected: string;
  /** The counted amount of the approved close, before corrections. */
  counted: string;
  /** Signed sum of the corrections applied after the close. */
  adjustment: string;
  /** `counted + adjustment`: the figure the variance is measured from. */
  countedWithCorrections: string;
  /** `counted + adjustment - expected`; negative is short. */
  variance: string;
};

export type CashUpReport = ReportEnvelope & {
  items: CashUpReportRow[];
  /** Number of distinct sessions in `items`. */
  sessionCount: number;
  totalVariance: string;
  /** Sum of the negative per-row variances (money missing), as a non-positive figure. */
  totalShort: string;
  /** Sum of the positive per-row variances (money over). */
  totalOver: string;
};

export async function fetchCashUpReport(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange
): Promise<CashUpReport> {
  if (!(await isOperationalFamilyEnabled(tx, tenantId, "cash-ups"))) {
    return {
      ...envelope(range, false),
      items: [],
      sessionCount: 0,
      totalVariance: "0.00",
      totalShort: "0.00",
      totalOver: "0.00"
    };
  }
  const rows = (await tx`
    SELECT to_char(c.day, 'YYYY-MM-DD') AS day, c.session_id, c.register_id,
      r.code AS register_code, r.name AS register_name,
      c.cashier_tenant_user_id, c.tender_type, c.expected::text AS expected,
      c.counted::text AS counted, c.adjustment::text AS adjustment
    FROM awcms_commerce_report_cash_up_tenders c
    LEFT JOIN awcms_commerce_registers r
      ON r.tenant_id = c.tenant_id AND r.id = c.register_id
    WHERE c.tenant_id = ${tenantId}
      AND c.day >= ${range.from}::date AND c.day <= ${range.to}::date
    ORDER BY c.day ASC, r.code ASC NULLS LAST, c.session_id ASC, c.tender_type ASC
  `) as {
    day: string;
    session_id: string;
    register_id: string;
    register_code: string | null;
    register_name: string | null;
    cashier_tenant_user_id: string;
    tender_type: string;
    expected: string;
    counted: string;
    adjustment: string;
  }[];
  let total = 0n;
  let short = 0n;
  let over = 0n;
  const sessions = new Set<string>();
  const items = rows.map((row): CashUpReportRow => {
    const variance = cashUpVarianceCents({
      expectedCents: signedToCents(String(row.expected)),
      countedCents: signedToCents(String(row.counted)),
      adjustmentCents: signedToCents(String(row.adjustment))
    });
    total += variance;
    if (variance < 0n) short += variance;
    if (variance > 0n) over += variance;
    sessions.add(row.session_id);
    return {
      day: row.day,
      sessionId: row.session_id,
      registerId: row.register_id,
      registerCode: row.register_code,
      registerName: row.register_name,
      cashierTenantUserId: row.cashier_tenant_user_id,
      tenderType: row.tender_type,
      expected: money(row.expected),
      counted: money(row.counted),
      adjustment: money(row.adjustment),
      countedWithCorrections: formatSignedCents(
        signedToCents(String(row.counted)) +
          signedToCents(String(row.adjustment))
      ),
      variance: formatSignedCents(variance)
    };
  });
  return {
    ...envelope(range, true),
    items,
    sessionCount: sessions.size,
    totalVariance: formatSignedCents(total),
    totalShort: formatSignedCents(short),
    totalOver: formatSignedCents(over)
  };
}

// ---------------------------------------------------------------------------
// expenses
// ---------------------------------------------------------------------------

export type ExpenseReportRow = {
  day: string;
  categoryId: string;
  categoryName: string;
  tenderType: string;
  postedCount: number;
  posted: string;
  reversedCount: number;
  reversed: string;
  net: string;
};

export type ExpenseSummaryRow = Omit<ExpenseReportRow, "day">;

export type ExpenseReport = ReportEnvelope & {
  items: ExpenseReportRow[];
  /** `items` folded over the whole range per category and tender (exact cents). */
  summary: ExpenseSummaryRow[];
  totalPosted: string;
  totalReversed: string;
  totalNet: string;
};

export function summariseExpenses(
  items: readonly ExpenseReportRow[]
): ExpenseSummaryRow[] {
  const folded = new Map<
    string,
    { row: ExpenseSummaryRow; posted: bigint; reversed: bigint }
  >();
  for (const item of items) {
    const key = `${item.categoryId}|${item.tenderType}`;
    let entry = folded.get(key);
    if (!entry) {
      entry = {
        row: {
          categoryId: item.categoryId,
          categoryName: item.categoryName,
          tenderType: item.tenderType,
          postedCount: 0,
          posted: "0.00",
          reversedCount: 0,
          reversed: "0.00",
          net: "0.00"
        },
        posted: 0n,
        reversed: 0n
      };
      folded.set(key, entry);
    }
    entry.row.postedCount += item.postedCount;
    entry.row.reversedCount += item.reversedCount;
    entry.row.categoryName = item.categoryName;
    entry.posted += signedToCents(item.posted);
    entry.reversed += signedToCents(item.reversed);
  }
  return [...folded.values()].map(({ row, posted, reversed }) => ({
    ...row,
    posted: formatSignedCents(posted),
    reversed: formatSignedCents(reversed),
    net: formatSignedCents(posted - reversed)
  }));
}

export async function fetchExpenseReport(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange
): Promise<ExpenseReport> {
  if (!(await isOperationalFamilyEnabled(tx, tenantId, "expenses"))) {
    return {
      ...envelope(range, false),
      items: [],
      summary: [],
      totalPosted: "0.00",
      totalReversed: "0.00",
      totalNet: "0.00"
    };
  }
  const rows = (await tx`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, category_id, category_name,
      tender_type, posted_count, posted::text AS posted, reversed_count,
      reversed::text AS reversed
    FROM awcms_commerce_report_expense_daily
    WHERE tenant_id = ${tenantId}
      AND day >= ${range.from}::date AND day <= ${range.to}::date
    ORDER BY day ASC, category_name ASC, category_id ASC, tender_type ASC
  `) as {
    day: string;
    category_id: string;
    category_name: string;
    tender_type: string;
    posted_count: number;
    posted: string;
    reversed_count: number;
    reversed: string;
  }[];
  let totalPosted = 0n;
  let totalReversed = 0n;
  const items = rows.map((row): ExpenseReportRow => {
    const posted = signedToCents(String(row.posted));
    const reversed = signedToCents(String(row.reversed));
    totalPosted += posted;
    totalReversed += reversed;
    return {
      day: row.day,
      categoryId: row.category_id,
      categoryName: row.category_name,
      tenderType: row.tender_type,
      postedCount: Number(row.posted_count),
      posted: formatSignedCents(posted),
      reversedCount: Number(row.reversed_count),
      reversed: formatSignedCents(reversed),
      net: formatSignedCents(posted - reversed)
    };
  });
  return {
    ...envelope(range, true),
    items,
    summary: summariseExpenses(items),
    totalPosted: formatSignedCents(totalPosted),
    totalReversed: formatSignedCents(totalReversed),
    totalNet: formatSignedCents(totalPosted - totalReversed)
  };
}

// ---------------------------------------------------------------------------
// loyalty
// ---------------------------------------------------------------------------

export type LoyaltyReportRow = {
  day: string;
  bucket: string;
  entries: number;
  /** Signed integer points, as a decimal string (bigint-safe). */
  points: string;
};

export type LoyaltySummaryRow = Omit<LoyaltyReportRow, "day">;

export type LoyaltyReport = ReportEnvelope & {
  items: LoyaltyReportRow[];
  /** `items` folded over the whole range per bucket. */
  summary: LoyaltySummaryRow[];
  /** Outstanding points (the liability) at the START of `from`: the sum of every bucket before it. */
  openingPoints: string;
  /** Net points moved inside the range. */
  movementPoints: string;
  /** Outstanding points at the END of `to`: opening + movement. */
  closingPoints: string;
};

export async function fetchLoyaltyReport(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange
): Promise<LoyaltyReport> {
  if (!(await isOperationalFamilyEnabled(tx, tenantId, "loyalty"))) {
    return {
      ...envelope(range, false),
      items: [],
      summary: [],
      openingPoints: "0",
      movementPoints: "0",
      closingPoints: "0"
    };
  }
  const rows = (await tx`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, bucket, entries, points::text AS points
    FROM awcms_commerce_report_loyalty_daily
    WHERE tenant_id = ${tenantId}
      AND day >= ${range.from}::date AND day <= ${range.to}::date
    ORDER BY day ASC, bucket ASC
  `) as { day: string; bucket: string; entries: number; points: string }[];
  const [opening] = (await tx`
    SELECT COALESCE(SUM(points), 0)::text AS points
    FROM awcms_commerce_report_loyalty_daily
    WHERE tenant_id = ${tenantId} AND day < ${range.from}::date
  `) as { points: string }[];
  const openingPoints = BigInt(opening?.points ?? "0");
  const movement = rows.reduce((sum, row) => sum + BigInt(row.points), 0n);
  const items = rows.map((row) => ({
    day: row.day,
    bucket: row.bucket,
    entries: Number(row.entries),
    points: String(BigInt(row.points))
  }));
  const folded = new Map<string, { entries: number; points: bigint }>();
  for (const item of items) {
    const entry = folded.get(item.bucket) ?? { entries: 0, points: 0n };
    entry.entries += item.entries;
    entry.points += BigInt(item.points);
    folded.set(item.bucket, entry);
  }
  return {
    ...envelope(range, true),
    items,
    summary: [...folded.entries()].map(([bucket, entry]) => ({
      bucket,
      entries: entry.entries,
      points: entry.points.toString()
    })),
    openingPoints: openingPoints.toString(),
    movementPoints: movement.toString(),
    closingPoints: (openingPoints + movement).toString()
  };
}

// ---------------------------------------------------------------------------
// stored value
// ---------------------------------------------------------------------------

export type StoredValueReportRow = {
  day: string;
  accountKind: string;
  bucket: string;
  entries: number;
  amount: string;
};

export type StoredValueKindBalance = {
  accountKind: string;
  /** Outstanding liability at the start of `from`. */
  opening: string;
  /** Net movement inside the range. */
  movement: string;
  /** Outstanding liability at the end of `to`. */
  closing: string;
};

export type StoredValueSummaryRow = Omit<StoredValueReportRow, "day">;

export type StoredValueReport = ReportEnvelope & {
  items: StoredValueReportRow[];
  /** `items` folded over the whole range per account kind and bucket (exact cents). */
  summary: StoredValueSummaryRow[];
  balances: StoredValueKindBalance[];
  totalClosing: string;
};

const STORED_VALUE_KINDS = ["gift_card", "store_credit"] as const;

export async function fetchStoredValueDailyReport(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange
): Promise<StoredValueReport> {
  if (!(await isOperationalFamilyEnabled(tx, tenantId, "stored-value"))) {
    return {
      ...envelope(range, false),
      items: [],
      summary: [],
      balances: [],
      totalClosing: "0.00"
    };
  }
  const rows = (await tx`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, account_kind, bucket, entries,
      amount::text AS amount
    FROM awcms_commerce_report_stored_value_daily
    WHERE tenant_id = ${tenantId}
      AND day >= ${range.from}::date AND day <= ${range.to}::date
    ORDER BY day ASC, account_kind ASC, bucket ASC
  `) as {
    day: string;
    account_kind: string;
    bucket: string;
    entries: number;
    amount: string;
  }[];
  const opening = (await tx`
    SELECT account_kind, COALESCE(SUM(amount), 0)::text AS amount
    FROM awcms_commerce_report_stored_value_daily
    WHERE tenant_id = ${tenantId} AND day < ${range.from}::date
    GROUP BY account_kind
  `) as { account_kind: string; amount: string }[];

  let totalClosing = 0n;
  const balances = STORED_VALUE_KINDS.map((accountKind) => {
    const open = signedToCents(
      String(
        opening.find((row) => row.account_kind === accountKind)?.amount ?? "0"
      )
    );
    const moved = rows
      .filter((row) => row.account_kind === accountKind)
      .reduce((sum, row) => sum + signedToCents(String(row.amount)), 0n);
    totalClosing += open + moved;
    return {
      accountKind,
      opening: formatSignedCents(open),
      movement: formatSignedCents(moved),
      closing: formatSignedCents(open + moved)
    };
  });
  const foldedRows = new Map<
    string,
    StoredValueSummaryRow & { cents: bigint }
  >();
  for (const row of rows) {
    const key = `${row.account_kind}|${row.bucket}`;
    const entry = foldedRows.get(key) ?? {
      accountKind: row.account_kind,
      bucket: row.bucket,
      entries: 0,
      amount: "0.00",
      cents: 0n
    };
    entry.entries += Number(row.entries);
    entry.cents += signedToCents(String(row.amount));
    foldedRows.set(key, entry);
  }
  return {
    ...envelope(range, true),
    items: rows.map((row) => ({
      day: row.day,
      accountKind: row.account_kind,
      bucket: row.bucket,
      entries: Number(row.entries),
      amount: money(row.amount)
    })),
    summary: [...foldedRows.values()].map(({ cents, ...entry }) => ({
      ...entry,
      amount: formatSignedCents(cents)
    })),
    balances,
    totalClosing: formatSignedCents(totalClosing)
  };
}

// ---------------------------------------------------------------------------
// returns & refunds (Issue #316)
// ---------------------------------------------------------------------------

export type ReturnsReportRow = {
  day: string;
  /** `null` for activity not taken on a register (online orders, back office). */
  registerId: string | null;
  registerCode: string | null;
  registerName: string | null;
  /** `return` | `disposition` | `refund`. */
  section: string;
  /** Return kind, stock disposition, or the refund's tender. */
  bucket: string;
  /** `original_tender` | `store_credit` for a refund; `''` otherwise. */
  detail: string;
  count: number;
  /** Units of a `disposition` row; `0` elsewhere. */
  units: number;
  amount: string;
};

export type ReturnsSummaryRow = Omit<
  ReturnsReportRow,
  "day" | "registerId" | "registerCode" | "registerName"
>;

export type ReturnsReport = ReportEnvelope & {
  items: ReturnsReportRow[];
  /** `items` folded over the whole range per section, bucket and detail (exact cents). */
  summary: ReturnsSummaryRow[];
  returnCount: number;
  /** Refund total promised by the returns recorded in the range. */
  returnedValue: string;
  /** Money that actually went back (settled refund legs), by any destination. */
  refundedTotal: string;
  /** The part of `refundedTotal` that went to the original tender. */
  refundedToTender: string;
  /** The part of `refundedTotal` redirected into store credit. */
  refundedToStoreCredit: string;
  restockedUnits: number;
  /** Units written off (disposition `damaged`). */
  writtenOffUnits: number;
  quarantinedUnits: number;
};

export async function fetchReturnsReport(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange
): Promise<ReturnsReport> {
  if (!(await isOperationalFamilyEnabled(tx, tenantId, "returns"))) {
    return {
      ...envelope(range, false),
      items: [],
      summary: [],
      returnCount: 0,
      returnedValue: "0.00",
      refundedTotal: "0.00",
      refundedToTender: "0.00",
      refundedToStoreCredit: "0.00",
      restockedUnits: 0,
      writtenOffUnits: 0,
      quarantinedUnits: 0
    };
  }
  const rows = (await tx`
    SELECT to_char(t.day, 'YYYY-MM-DD') AS day, t.register_id,
      r.code AS register_code, r.name AS register_name, t.section, t.bucket,
      t.detail, t.entry_count, t.units, t.amount::text AS amount
    FROM awcms_commerce_report_returns_daily t
    LEFT JOIN awcms_commerce_registers r
      ON r.tenant_id = t.tenant_id AND r.id = t.register_id
    WHERE t.tenant_id = ${tenantId}
      AND t.day >= ${range.from}::date AND t.day <= ${range.to}::date
    ORDER BY t.day ASC, r.code ASC NULLS FIRST, t.section ASC, t.bucket ASC,
      t.detail ASC
  `) as {
    day: string;
    register_id: string;
    register_code: string | null;
    register_name: string | null;
    section: string;
    bucket: string;
    detail: string;
    entry_count: number;
    units: number;
    amount: string;
  }[];
  const items = rows.map((row): ReturnsReportRow => ({
    day: row.day,
    registerId:
      row.register_id === OPERATIONAL_NO_REGISTER_ID ? null : row.register_id,
    registerCode: row.register_code,
    registerName: row.register_name,
    section: row.section,
    bucket: row.bucket,
    detail: row.detail,
    count: Number(row.entry_count),
    units: Number(row.units),
    amount: money(row.amount)
  }));
  return {
    ...envelope(range, true),
    items,
    ...summariseReturns(items)
  };
}

/** Folds the per-day rows over the range, in exact integer cents. */
export function summariseReturns(
  items: readonly ReturnsReportRow[]
): Omit<ReturnsReport, keyof ReportEnvelope | "items"> {
  const folded = new Map<string, ReturnsSummaryRow & { cents: bigint }>();
  let returnCount = 0;
  let returnedValue = 0n;
  let refundedToTender = 0n;
  let refundedToStoreCredit = 0n;
  for (const item of items) {
    const key = `${item.section}|${item.bucket}|${item.detail}`;
    const entry = folded.get(key) ?? {
      section: item.section,
      bucket: item.bucket,
      detail: item.detail,
      count: 0,
      units: 0,
      amount: "0.00",
      cents: 0n
    };
    const cents = signedToCents(item.amount);
    entry.count += item.count;
    entry.units += item.units;
    entry.cents += cents;
    folded.set(key, entry);
    if (item.section === "return") {
      returnCount += item.count;
      returnedValue += cents;
    } else if (item.section === "refund") {
      if (item.detail === "store_credit") refundedToStoreCredit += cents;
      else refundedToTender += cents;
    }
  }
  const units = summariseDispositionUnits(
    items
      .filter((item) => item.section === "disposition")
      .map((item) => ({ bucket: item.bucket, units: item.units }))
  );
  return {
    summary: [...folded.values()]
      .sort(
        (a, b) =>
          a.section.localeCompare(b.section) ||
          a.bucket.localeCompare(b.bucket) ||
          a.detail.localeCompare(b.detail)
      )
      .map(({ cents, ...entry }) => ({
        ...entry,
        amount: formatSignedCents(cents)
      })),
    returnCount,
    returnedValue: formatSignedCents(returnedValue),
    refundedTotal: formatSignedCents(refundedToTender + refundedToStoreCredit),
    refundedToTender: formatSignedCents(refundedToTender),
    refundedToStoreCredit: formatSignedCents(refundedToStoreCredit),
    restockedUnits: units.restocked,
    writtenOffUnits: units.writtenOff,
    quarantinedUnits: units.quarantined
  };
}
