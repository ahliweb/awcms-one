/**
 * The reporting-engine registrations of the booking-aware figures (Issue #389,
 * ADR-0045 amendment note), declared once here and spread into `module.ts`'s
 * `reportingProjections` array - the shape `booking-adapter-permissions.ts` and
 * the other part files use, so the hot file `module.ts` carries one import and
 * three spreads and nothing else of this issue. Pure data plus references to
 * the sinks (no pool, no `withTenant`).
 *
 *   * `commerce.booking_revenue` - a NEW projection: one row per booking-sourced
 *     paid order, recomputed from the order, the payment ledger and the adapter's
 *     decision records (`booking-revenue-projection.ts`); the waterfall, the
 *     companion columns, the outstanding balance and the no-show figures are
 *     sums of those rows grouped by the order's Asia/Jakarta paid day.
 *   * the booking anchor of `commerce.customer_retention` - two more streams on
 *     the EXISTING retention descriptor (`RETENTION_BOOKING_STREAMS`), feeding
 *     the same recompute.
 *
 * Booking's own occupancy, lead time and utilisation are NOT rebuilt here: they
 * are Booking's projections (`ahliweb/awcms#944`).
 */
import type {
  ProjectionCursorStream,
  ProjectionDescriptor
} from "../../_shared/module-contract";
import {
  BOOKING_REVENUE_METRIC_KEYS,
  BOOKING_REVENUE_PROJECTION_KEY,
  BOOKING_REVENUE_STREAM_KEYS
} from "../domain/booking-revenue";
import {
  RETENTION_METRIC_KEYS,
  RETENTION_STREAM_KEYS
} from "../domain/retention";
import {
  BOOKING_REVENUE_DECISION_SINK,
  BOOKING_REVENUE_DIMENSIONAL,
  BOOKING_REVENUE_EVENT_SINK,
  BOOKING_REVENUE_LEG_SINK,
  BOOKING_REVENUE_RESCHEDULE_SINK
} from "./booking-revenue-projection";
import {
  RETENTION_BOOKING_DECISION_SINK,
  RETENTION_BOOKING_RESCHEDULE_SINK
} from "./retention-projection";

/**
 * The booking anchor's two extra streams on `commerce.customer_retention`: the
 * refund decisions (a cancellation or no-show releases the reservation link)
 * and the reschedule record (names the supplementary order folded into its
 * stay). Both cursors are NOT NULL insert-time columns of append-only tables.
 */
export const RETENTION_BOOKING_STREAMS: readonly ProjectionCursorStream[] = [
  {
    streamKey: RETENTION_STREAM_KEYS.bookingDecisions,
    tableName: "awcms_commerce_booking_refund_decisions",
    cursorColumn: "created_at",
    metrics: [
      { metricKey: RETENTION_METRIC_KEYS.bookingDecisions, effect: "increment" }
    ],
    dimensional: RETENTION_BOOKING_DECISION_SINK
  },
  {
    streamKey: RETENTION_STREAM_KEYS.bookingReschedules,
    tableName: "awcms_commerce_booking_reschedules",
    cursorColumn: "created_at",
    metrics: [
      {
        metricKey: RETENTION_METRIC_KEYS.bookingReschedules,
        effect: "increment"
      }
    ],
    dimensional: RETENTION_BOOKING_RESCHEDULE_SINK
  }
];

export const RETENTION_BOOKING_METRIC_LABELS: Readonly<Record<string, string>> =
  {
    [RETENTION_METRIC_KEYS.bookingDecisions]:
      "Booking cancellation and no-show decisions consumed",
    [RETENTION_METRIC_KEYS.bookingReschedules]: "Booking reschedules consumed"
  };

const BOOKING_REVENUE_STREAMS: readonly ProjectionCursorStream[] = [
  {
    streamKey: BOOKING_REVENUE_STREAM_KEYS.orderEvents,
    tableName: "awcms_commerce_order_events",
    cursorColumn: "created_at",
    metrics: [
      {
        metricKey: BOOKING_REVENUE_METRIC_KEYS.orderEvents,
        effect: "increment"
      }
    ],
    dimensional: BOOKING_REVENUE_EVENT_SINK
  },
  {
    // The view of sql/1047: settled payment AND reversal legs with their order
    // (sql/998's view carries no order id, sql/1020's only reversals).
    streamKey: BOOKING_REVENUE_STREAM_KEYS.paymentLegs,
    tableName: "awcms_commerce_report_src_booking_legs",
    cursorColumn: "settled_at",
    metrics: [
      {
        metricKey: BOOKING_REVENUE_METRIC_KEYS.paymentLegs,
        effect: "increment",
        matchColumn: "status",
        matchValue: "succeeded"
      }
    ],
    dimensional: BOOKING_REVENUE_LEG_SINK
  },
  {
    streamKey: BOOKING_REVENUE_STREAM_KEYS.refundDecisions,
    tableName: "awcms_commerce_booking_refund_decisions",
    cursorColumn: "created_at",
    metrics: [
      {
        metricKey: BOOKING_REVENUE_METRIC_KEYS.refundDecisions,
        effect: "increment"
      }
    ],
    dimensional: BOOKING_REVENUE_DECISION_SINK
  },
  {
    streamKey: BOOKING_REVENUE_STREAM_KEYS.reschedules,
    tableName: "awcms_commerce_booking_reschedules",
    cursorColumn: "created_at",
    metrics: [
      {
        metricKey: BOOKING_REVENUE_METRIC_KEYS.reschedules,
        effect: "increment"
      }
    ],
    dimensional: BOOKING_REVENUE_RESCHEDULE_SINK
  }
];

/** Same policy as the sales and retention projections (the refresh job runs every 2 minutes). */
const BOOKING_REPORT_FRESHNESS = {
  targetSeconds: 300,
  staleAfterSeconds: 1800,
  errorAfterConsecutiveFailures: 3
} as const;

export const BOOKING_REPORT_PROJECTIONS: ProjectionDescriptor[] = [
  {
    key: BOOKING_REVENUE_PROJECTION_KEY,
    version: 1,
    ownerModuleKey: "commerce",
    scope: "tenant",
    description:
      "Per booking-sourced paid order (an order carrying a Booking reservation link, or the supplementary order of a stay that grew): gross, discounts, shipping, insurance and tax recognised once on the Asia/Jakarta day of the first paid transition, the money paid back and the unpaid balance of a closed order (no money moved) that leave on that same original day, the balance still outstanding on an open order, and the stay and no-show counts. Recomputed from the order, the payment ledger and the adapter's refund decisions whenever one of them changes, so a late refund or a no-show restates the original day. The waterfall per day is a sum of these rows; the row holds no name or contact.",
    source: { strategy: "cursor_table", streams: BOOKING_REVENUE_STREAMS },
    rebuildSource: { streams: BOOKING_REVENUE_STREAMS },
    metricLabels: {
      [BOOKING_REVENUE_METRIC_KEYS.orderEvents]: "Order events consumed",
      [BOOKING_REVENUE_METRIC_KEYS.paymentLegs]:
        "Settled payment ledger legs consumed",
      [BOOKING_REVENUE_METRIC_KEYS.refundDecisions]:
        "Booking cancellation and no-show decisions consumed",
      [BOOKING_REVENUE_METRIC_KEYS.reschedules]: "Booking reschedules consumed"
    },
    // The generic projection surface is gated like every other projection; the
    // business read routes sit behind `reporting.dashboard.read` (the sales
    // routes' own gate).
    requiredPermission: "reporting.projections.read",
    freshness: BOOKING_REPORT_FRESHNESS,
    drillDownPath: "/api/v1/reports/commerce/booking-revenue",
    retentionClass:
      "commerce.booking_revenue / commerce.booking_revenue_restated (this module's own dataLifecycle descriptors, cursor `paid_day` and `day`, the same 3650-day ceiling as the order ledger): derived, fully rebuildable per-order rows - a rebuild after the source's own retention purge recomputes from surviving orders only.",
    batchLimit: 500,
    dimensional: BOOKING_REVENUE_DIMENSIONAL
  }
];
