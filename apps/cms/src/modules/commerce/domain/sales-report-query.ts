/**
 * Query-string validation for the three sales-report read routes (Issue
 * #117) — `GET /api/v1/reports/commerce/sales-daily?from&to`,
 * `sales-by-product?from&to&limit`, `sales-by-category?from&to`. Pure; the
 * same `{ field, message }` error shape every other validator in this module
 * returns, so a route folds a rejection into an ordinary `400
 * VALIDATION_ERROR`.
 *
 * Defaults: the last {@link DEFAULT_SALES_REPORT_RANGE_DAYS} days ending
 * today (in the report's own time zone — a projection day is a
 * `SALES_REPORT_TIME_ZONE` day, so the default window must be too). A range
 * may span at most {@link MAX_SALES_REPORT_RANGE_DAYS} days: the daily table
 * holds one row per day so a year is ~366 rows, and the by-product read
 * groups every line of the range, which is what the bound keeps bounded.
 */
import { resolveSalesReportDay } from "./sales-report-deltas";

export const DEFAULT_SALES_REPORT_RANGE_DAYS = 30;
export const MAX_SALES_REPORT_RANGE_DAYS = 366;
export const DEFAULT_SALES_BY_PRODUCT_LIMIT = 20;
export const MAX_SALES_BY_PRODUCT_LIMIT = 200;

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SalesReportRange = { from: string; to: string };

export type SalesReportQueryResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: { field: string; message: string }[] };

/** A calendar day string is valid when it round-trips through `Date` unchanged (rejects `2026-02-30`). */
export function isValidIsoDay(value: string): boolean {
  if (!ISO_DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function shiftIsoDay(day: string, deltaDays: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + deltaDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() -
      new Date(`${from}T00:00:00Z`).getTime()) /
      DAY_MS
  );
}

export function validateSalesReportRange(
  input: { from?: string | null; to?: string | null },
  now: Date = new Date()
): SalesReportQueryResult<SalesReportRange> {
  const errors: { field: string; message: string }[] = [];
  const today = resolveSalesReportDay(now);

  const rawTo = input.to?.trim();
  const rawFrom = input.from?.trim();

  if (rawTo && !isValidIsoDay(rawTo)) {
    errors.push({ field: "to", message: "to must be a YYYY-MM-DD date." });
  }
  if (rawFrom && !isValidIsoDay(rawFrom)) {
    errors.push({ field: "from", message: "from must be a YYYY-MM-DD date." });
  }
  if (errors.length > 0) return { valid: false, errors };

  const to = rawTo || today;
  const from =
    rawFrom || shiftIsoDay(to, -(DEFAULT_SALES_REPORT_RANGE_DAYS - 1));

  if (from > to) {
    return {
      valid: false,
      errors: [{ field: "from", message: "from must not be after to." }]
    };
  }
  if (daysBetween(from, to) + 1 > MAX_SALES_REPORT_RANGE_DAYS) {
    return {
      valid: false,
      errors: [
        {
          field: "to",
          message: `A range may span at most ${MAX_SALES_REPORT_RANGE_DAYS} days.`
        }
      ]
    };
  }

  return { valid: true, value: { from, to } };
}

export function validateSalesByProductLimit(
  raw: string | null | undefined
): SalesReportQueryResult<number> {
  const trimmed = raw?.trim();
  if (!trimmed) return { valid: true, value: DEFAULT_SALES_BY_PRODUCT_LIMIT };
  if (!/^\d+$/.test(trimmed)) {
    return {
      valid: false,
      errors: [{ field: "limit", message: "limit must be a positive integer." }]
    };
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < 1 || parsed > MAX_SALES_BY_PRODUCT_LIMIT) {
    return {
      valid: false,
      errors: [
        {
          field: "limit",
          message: `limit must be between 1 and ${MAX_SALES_BY_PRODUCT_LIMIT}.`
        }
      ]
    };
  }
  return { valid: true, value: parsed };
}
