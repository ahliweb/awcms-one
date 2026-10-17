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

// ---------------------------------------------------------------------------
// Issue #380 - the reservation reads (contracts section 3.4)
// ---------------------------------------------------------------------------

/** How a storefront caller proves the order is theirs: the bearer session's customer, or the order's own phone (C-05, C-32). */
export type OwnReservationIdentity =
  { kind: "customer"; customerId: string } | { kind: "phone"; phone: string };

/**
 * The link of the order `orderCode`, ONLY when it belongs to the caller. The
 * ownership check is part of the query - the customer id compared to the
 * server-resolved one, or the customer's phone to the normalised one the caller
 * typed - so an unknown code, another customer's code and another tenant's code
 * are one `null` (the route answers one neutral 404). The active link wins over
 * a superseded or released one.
 */
export async function fetchReservationLinkForOrderCode(
  tx: Bun.SQL,
  tenantId: string,
  orderCode: string,
  identity: OwnReservationIdentity
): Promise<ReservationLinkSummary | null> {
  const customerId = identity.kind === "customer" ? identity.customerId : null;
  const phone = identity.kind === "phone" ? identity.phone : null;
  const rows = (await tx`
    SELECT ${tx.unsafe(SUMMARY_COLUMNS)}
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_commerce_orders o
      ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    JOIN awcms_commerce_customers c
      ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
    WHERE l.tenant_id = ${tenantId}
      AND o.order_code = ${orderCode}
      AND o.channel = 'storefront'
      AND (
        (${customerId}::uuid IS NOT NULL AND c.id = ${customerId}::uuid)
        OR (${phone}::text IS NOT NULL AND c.phone = ${phone}::text)
      )
    ORDER BY (l.status = 'active') DESC, l.created_at DESC, l.id DESC
    LIMIT 1
  `) as SummaryRow[];
  return rows[0] ? toSummary(rows[0]) : null;
}

/** The link of a Booking reservation, staff view (tenant-scoped by RLS and the predicate); the active one wins. */
export async function fetchReservationLinkByReservationId(
  tx: Bun.SQL,
  tenantId: string,
  reservationId: string
): Promise<ReservationLinkSummary | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(SUMMARY_COLUMNS)}
    FROM awcms_commerce_booking_reservation_links l
    WHERE l.tenant_id = ${tenantId} AND l.reservation_id = ${reservationId}
    ORDER BY (l.status = 'active') DESC, l.created_at DESC, l.id DESC
    LIMIT 1
  `) as SummaryRow[];
  return rows[0] ? toSummary(rows[0]) : null;
}
