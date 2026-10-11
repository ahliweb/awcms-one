/**
 * Read side of the customer-retention report (Issue #364, ADR-0044) - the
 * `GET /api/v1/reports/commerce/retention` route, its `.csv` sibling and the
 * panel on `admin/commerce-reports.astro` read the projection table through
 * this function and nothing else. It only READs `awcms_commerce_report_
 * retention_*` (maintained by `retention-projection.ts` under the `reporting`
 * engine) and joins `awcms_commerce_customers` for the three exclusions that
 * are mutable state with no event: a blocked customer, a retention-purged
 * customer, and the walk-in sentinel. It returns counts only - never a
 * customer id, name or contact (spec 6.2, "the projection itself holds counts
 * only"); the win-back list is a CRM segment behind its own permissions.
 *
 * ## Feature gating
 *
 * While the tenant's `retention` feature is OFF (the default) the answer is
 * `enabled: false` with no cohorts - not an error: a report is a view, and
 * "nothing to show because the tenant never opted in" is a state the screen
 * hides. The projection keeps running, so switching the feature on shows
 * history immediately.
 *
 * ## "Unlinked"
 *
 * Every commerce order carries a customer id (a guest checkout creates or
 * reuses the customer row by phone). The one order with NO resolvable customer
 * is an anonymous POS walk-in sale, attributed to the tenant's shared walk-in
 * placeholder; those qualifying orders are reported as `unlinkedOrders`, never
 * guessed into a cohort (metrics Q7).
 */
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import { POS_WALK_IN_CUSTOMER_SENTINEL_PHONE } from "../domain/phone-normalisation";
import {
  RETENTION_MIN_COHORT_FOR_RATE,
  RETENTION_RESTATEMENT_WINDOW_DAYS,
  RETENTION_TIME_ZONE,
  RETENTION_WINDOW_DAYS,
  RETENTION_WINDOW_HOURS,
  addCohortMonths,
  cohortMonthOf,
  shapeRetentionCohorts,
  type RetentionCohort,
  type RetentionRange
} from "../domain/retention";

export type RetentionReport = {
  enabled: boolean;
  timeZone: string;
  windowDays: number;
  minCohortForRate: number;
  restatementWindowDays: number;
  /** ISO instant the report was computed at: maturity and "to date" are relative to it. */
  asOf: string;
  /** First and last cohort month asked for, `YYYY-MM-01`. */
  from: string;
  to: string;
  cohorts: RetentionCohort[];
  /** Qualifying orders of the anonymous walk-in placeholder, all time, outside every cohort. */
  unlinkedOrders: number;
};

export function retentionWindow(
  range: RetentionRange,
  now: Date
): { from: string; to: string } {
  const to = cohortMonthOf(now);
  return { from: addCohortMonths(to, -(range.months - 1)), to };
}

export async function fetchRetentionReport(
  tx: Bun.SQL,
  tenantId: string,
  range: RetentionRange,
  now: Date = new Date()
): Promise<RetentionReport> {
  const window = retentionWindow(range, now);
  const envelope = {
    timeZone: RETENTION_TIME_ZONE,
    windowDays: RETENTION_WINDOW_DAYS,
    minCohortForRate: RETENTION_MIN_COHORT_FOR_RATE,
    restatementWindowDays: RETENTION_RESTATEMENT_WINDOW_DAYS,
    asOf: now.toISOString(),
    from: window.from,
    to: window.to
  };
  if (!(await fetchCommerceFeatures(tx, tenantId)).retention) {
    return { ...envelope, enabled: false, cohorts: [], unlinkedOrders: 0 };
  }

  const rows = (await tx`
    SELECT to_char(r.cohort_month, 'YYYY-MM-DD') AS cohort_month,
      count(*)::int AS size,
      (count(*) FILTER (
        WHERE r.second_event_at IS NOT NULL
          AND r.second_event_at > r.first_event_at
          AND r.second_event_at <= r.first_event_at + make_interval(hours => ${RETENTION_WINDOW_HOURS})
      ))::int AS repeaters
    FROM awcms_commerce_report_retention_customers r
    JOIN awcms_commerce_customers c
      ON c.tenant_id = r.tenant_id AND c.id = r.customer_id
    WHERE r.tenant_id = ${tenantId}
      AND r.cohort_month >= ${window.from}::date
      AND r.cohort_month <= ${window.to}::date
      AND c.status = 'active'
      AND c.deleted_at IS NULL
      AND c.phone <> ${POS_WALK_IN_CUSTOMER_SENTINEL_PHONE}
    GROUP BY r.cohort_month
    ORDER BY r.cohort_month ASC
  `) as { cohort_month: string; size: number; repeaters: number }[];

  const restated = (await tx`
    SELECT to_char(cohort_month, 'YYYY-MM-DD') AS cohort_month, restated_at
    FROM awcms_commerce_report_retention_restated
    WHERE tenant_id = ${tenantId}
      AND cohort_month >= ${window.from}::date
      AND cohort_month <= ${window.to}::date
  `) as { cohort_month: string; restated_at: Date | string }[];

  const unlinked = (await tx`
    SELECT COALESCE(sum(r.qualifying_order_count), 0)::int AS orders
    FROM awcms_commerce_report_retention_customers r
    JOIN awcms_commerce_customers c
      ON c.tenant_id = r.tenant_id AND c.id = r.customer_id
    WHERE r.tenant_id = ${tenantId}
      AND c.phone = ${POS_WALK_IN_CUSTOMER_SENTINEL_PHONE}
  `) as { orders: number }[];

  return {
    ...envelope,
    enabled: true,
    cohorts: shapeRetentionCohorts(
      rows.map((row) => ({
        cohortMonth: row.cohort_month,
        size: Number(row.size),
        repeaters: Number(row.repeaters)
      })),
      now,
      new Map(
        restated.map((row) => [
          row.cohort_month,
          row.restated_at instanceof Date
            ? row.restated_at
            : new Date(row.restated_at)
        ])
      )
    ),
    unlinkedOrders: Number(unlinked[0]?.orders ?? 0)
  };
}
