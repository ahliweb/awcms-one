/**
 * The booking hold pipeline (Issue #389, ADR-0045 amendment note; metrics spec
 * sections 4.3 and 8.2): the Booking holds the commerce adapter is waiting to
 * see paid, with the held units (resource-nights for a stay product, one per
 * slot), their value, the age of the oldest hold and the soonest expiry. Held
 * space is NOT occupancy and NOT revenue - it is a pipeline line of its own
 * (metrics O8).
 *
 * ## Live, not projected
 *
 * A hold is a CURRENT state: an active reservation link on an order that has
 * not yet reached its first paid transition and has not expired. There is no
 * event stream whose sum is "holds right now" (a hold disappears by being paid,
 * expiring or being cancelled, none of which is a counter), and a projection of
 * a gauge would be a second store of a fact the adapter tables already hold. So
 * this is one read-only, tenant-scoped query over the adapter's link table, the
 * order and its line - tenant isolation by the statement AND by RLS - and it is
 * as fresh as the database. It reads no table of the `booking` module.
 *
 * ## What counts as a hold
 *
 * `link.status = 'active'`, `order.status = 'pending_payment'`, `paid_at IS
 * NULL`, and the order's `expires_at` (which IS the hold's expiry, ADR-0045 G11)
 * in the future or not recorded. An order whose hold has run out but that the
 * expirer has not yet cancelled is not a hold any more. A deposit order that
 * has paid its deposit is `paid` and so leaves the pipeline for the waterfall
 * (its balance is shown as outstanding there).
 */
import {
  shapeHoldPipeline,
  type HoldPipeline,
  type HoldRow
} from "../domain/booking-revenue";
import { toCents } from "../domain/price-calculation";
import { fetchCommerceFeatures } from "./commerce-feature-gate";

export type BookingPipelineReport = {
  enabled: boolean;
  /** ISO instant the pipeline was read at. */
  asOf: string;
  currency: string;
  pipeline: HoldPipeline;
};

type HoldQueryRow = {
  total: string;
  units: number;
  created_at: Date | string;
  expires_at: Date | string | null;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export async function listBookingHolds(
  tx: Bun.SQL,
  tenantId: string,
  now: Date
): Promise<HoldRow[]> {
  const rows = (await tx`
    SELECT o.total::text AS total,
      CASE WHEN ol.quantity_basis = 'nights' THEN oi.quantity ELSE 1 END AS units,
      l.created_at, o.expires_at
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_commerce_orders o
      ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    JOIN awcms_commerce_order_items oi
      ON oi.tenant_id = l.tenant_id AND oi.id = l.order_item_id
    JOIN awcms_commerce_booking_offering_links ol
      ON ol.tenant_id = l.tenant_id AND ol.id = l.offering_link_id
    WHERE l.tenant_id = ${tenantId}
      AND l.status = 'active'
      AND o.status = 'pending_payment'
      AND o.paid_at IS NULL
      AND (o.expires_at IS NULL OR o.expires_at > ${now})
    ORDER BY l.created_at ASC, l.id ASC
  `) as HoldQueryRow[];
  return rows.map((row) => ({
    totalCents: toCents(String(row.total)),
    units: Number(row.units),
    createdAt: toDate(row.created_at),
    expiresAt: row.expires_at === null ? null : toDate(row.expires_at)
  }));
}

export async function fetchBookingPipeline(
  tx: Bun.SQL,
  tenantId: string,
  now: Date = new Date()
): Promise<BookingPipelineReport> {
  const envelope = { asOf: now.toISOString(), currency: "IDR" };
  if (!(await fetchCommerceFeatures(tx, tenantId)).booking) {
    return {
      ...envelope,
      enabled: false,
      pipeline: shapeHoldPipeline([], now)
    };
  }
  return {
    ...envelope,
    enabled: true,
    pipeline: shapeHoldPipeline(await listBookingHolds(tx, tenantId, now), now)
  };
}
