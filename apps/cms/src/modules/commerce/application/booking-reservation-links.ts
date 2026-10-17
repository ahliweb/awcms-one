/**
 * Reads over the reservation-link table that DERIVE the customer through the
 * linked order (Issue #378, ADR-0045 D3, finding X7). Reads only; the writer is
 * the hold-to-order path of a later issue.
 *
 * ## The customer is derived, never stored
 *
 * No adapter table has a customer column. A reservation's customer is the
 * customer of the order its ACTIVE link points to:
 *
 *     reservation -> reservation_links (status = 'active') -> orders.customer_id
 *
 * RLS on the link table gives tenant isolation only - it knows no customer - so
 * a customer-scoped read is the join below with the order's `customer_id`
 * compared to the id the bearer session resolved ON THE SERVER. The customer id
 * is an argument of these functions and is never taken from a request body or
 * query, and a link of another customer of the same tenant is simply not in the
 * result (an unknown id and another customer's id are indistinguishable to the
 * caller, control C-05/C-32). The integration test fails if the equality is
 * removed.
 *
 * Nothing here selects a name, a phone or an e-mail: the customer id is used as
 * a filter and returned only by {@link fetchReservationLinkCustomer}, whose
 * caller is a staff/consumer path that already holds the order.
 */
import type { BookingReservationLinkStatus } from "../domain/booking-adapter";

export type ReservationLinkSummary = {
  id: string;
  orderId: string;
  orderItemId: string;
  reservationId: string;
  offeringLinkId: string;
  status: BookingReservationLinkStatus;
  supersedesLinkId: string | null;
  attentionReason: string | null;
  attentionAt: string | null;
  attentionResolvedAt: string | null;
  createdAt: string;
};

type SummaryRow = {
  id: string;
  order_id: string;
  order_item_id: string;
  reservation_id: string;
  offering_link_id: string;
  status: BookingReservationLinkStatus;
  supersedes_link_id: string | null;
  attention_reason: string | null;
  attention_at: Date | string | null;
  attention_resolved_at: Date | string | null;
  created_at: Date | string;
};

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

function toSummary(row: SummaryRow): ReservationLinkSummary {
  return {
    id: row.id,
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    reservationId: row.reservation_id,
    offeringLinkId: row.offering_link_id,
    status: row.status,
    supersedesLinkId: row.supersedes_link_id,
    attentionReason: row.attention_reason,
    attentionAt: isoOrNull(row.attention_at),
    attentionResolvedAt: isoOrNull(row.attention_resolved_at),
    createdAt: iso(row.created_at)
  };
}

const SUMMARY_COLUMNS = `l.id, l.order_id, l.order_item_id, l.reservation_id,
  l.offering_link_id, l.status, l.supersedes_link_id, l.attention_reason,
  l.attention_at, l.attention_resolved_at, l.created_at`;

/**
 * The ACTIVE reservation links of one customer's own orders, newest first. The
 * customer id comes from the server-resolved session; another customer's links
 * of the same tenant are not returned.
 */
export async function listActiveReservationLinksForCustomer(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<ReservationLinkSummary[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(SUMMARY_COLUMNS)}
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_commerce_orders o
      ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    WHERE l.tenant_id = ${tenantId}
      AND l.status = 'active'
      AND o.customer_id = ${customerId}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT 100
  `) as SummaryRow[];
  return rows.map(toSummary);
}

/**
 * One reservation link by id, only when it belongs to `customerId`'s own order;
 * `null` for an unknown id, another tenant's and another customer's alike.
 */
export async function fetchReservationLinkForCustomer(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  linkId: string
): Promise<ReservationLinkSummary | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(SUMMARY_COLUMNS)}
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_commerce_orders o
      ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    WHERE l.tenant_id = ${tenantId}
      AND l.id = ${linkId}
      AND o.customer_id = ${customerId}
  `) as SummaryRow[];
  return rows[0] ? toSummary(rows[0]) : null;
}

/**
 * The customer of a reservation: the `customer_id` of the order its ACTIVE link
 * points to (a guest checkout is a customer row keyed by phone, ADR-0009, so
 * the id is always present; the result is `null` when the reservation has no
 * active link - a staff-only reservation has no derivable customer, and shows
 * as "unlinked" in retention and segment reports).
 */
export async function fetchReservationLinkCustomer(
  tx: Bun.SQL,
  tenantId: string,
  reservationId: string
): Promise<{ linkId: string; orderId: string; customerId: string } | null> {
  const rows = (await tx`
    SELECT l.id, l.order_id, o.customer_id
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_commerce_orders o
      ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    WHERE l.tenant_id = ${tenantId}
      AND l.reservation_id = ${reservationId}
      AND l.status = 'active'
  `) as { id: string; order_id: string; customer_id: string }[];
  const row = rows[0];
  return row
    ? { linkId: row.id, orderId: row.order_id, customerId: row.customer_id }
    : null;
}
