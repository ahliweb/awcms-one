/**
 * The adapter's READS of Booking's reservation rows (Issue #380, ADR-0045 D3,
 * threat controls C-08/C-09). The only file besides `booking-offering-links.ts`
 * that names a Booking table, and like it only in `SELECT`s: commerce imports
 * nothing from `booking`'s code and writes none of its tables (a static test
 * pins both).
 *
 * ## Why a table read and not the port
 *
 * `BookingPort` has no reservation read by id (upstream port addition U1, with
 * the offering read, the check-in/out/no-show verbs and an availability read -
 * recorded in ADR-0045). The adapter needs three things the port cannot say
 * yet: the reservation's current STATUS (to decide between "confirm", "raise
 * attention" and "nothing to do" without provoking a refusal), its dates and
 * number for the reservation view, and the C-09 comparison of that status with
 * the order's ledger. Each is a tenant-scoped `SELECT` of a few columns; RLS is
 * FORCEd on the table, so a read can never reach another tenant's row.
 *
 * ## The C-09 reconciliation
 *
 * Booking holds the claim, commerce holds the money, and the two commit in
 * different transactions (the order's payment arrives later). Two states must
 * never persist silently:
 *
 *   - `paid_without_confirm`: the ledger holds at least the release threshold
 *     (the deposit, or the total) but the reservation is not confirmed - still
 *     `held` (the confirm is pending or failed) or already `expired` /
 *     `cancelled` (the deposit arrived after the hold lapsed, C-08).
 *   - `confirmed_without_deposit`: the reservation is confirmed (or beyond) but
 *     the ledger holds less than the threshold (a payment was reversed, or
 *     staff confirmed it in Booking's own screen).
 *
 * Issue #382 adds three findings of the reschedule (control C-38 and C-39):
 *
 *   - `booking_reference_missing` / `commerce_link_missing`: the order has ONE
 *     reference instead of two (zero or two, never one). The commerce link is
 *     active but Booking's reservation does not name the order, or a live Booking
 *     reservation names an order that has no active link to it (a reschedule made
 *     in Booking's own screen that the reconciler consumer has not repaired);
 *   - `reschedule_difference_unpaid`: the supplementary order of a reschedule that
 *     added nights is still unsettled after it expired or was cancelled, while
 *     the longer stay is live - nights nobody paid for.
 *
 * A settled refund of a reschedule that shortened a stay lowers the ledger below
 * the order's total, as any refund of a paid order does; that is not a missing
 * deposit, so the refunded part (the settled legs of the order's cancellation
 * returns) is netted out of the threshold before the comparison.
 *
 * The queries are read-only and bounded; they write nothing and fix nothing - an
 * operator decides (the attention flag is the work queue, this is its audit).
 */

import type {
  ReferenceDriftItem,
  ReferenceKind
} from "../domain/booking-restore-drill";
import { BOOKING_RESERVATION_ORDER_REFERENCE_TYPE } from "../domain/booking-adapter";
import { normalizeMoney } from "../domain/price-calculation";

export type BookingReservationFacts = {
  id: string;
  reservationNo: string;
  status: string;
  startsAt: string;
  endsAt: string;
  holdExpiresAt: string | null;
  externalRefType: string | null;
  externalRef: string | null;
};

type ReservationRow = {
  id: string;
  reservation_no: string;
  status: string;
  starts_at: Date | string;
  ends_at: Date | string;
  hold_expires_at: Date | string | null;
  external_ref_type: string | null;
  external_ref: string | null;
};

const iso = (value: Date | string): string => new Date(value).toISOString();

function toFacts(row: ReservationRow): BookingReservationFacts {
  return {
    id: row.id,
    reservationNo: row.reservation_no,
    status: row.status,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    holdExpiresAt:
      row.hold_expires_at === null ? null : iso(row.hold_expires_at),
    externalRefType: row.external_ref_type,
    externalRef: row.external_ref
  };
}

/** One reservation by id; `null` for an unknown or another tenant's id, indistinguishably. */
export async function readBookingReservation(
  tx: Bun.SQL,
  tenantId: string,
  reservationId: string
): Promise<BookingReservationFacts | null> {
  const rows = (await tx`
    SELECT id, reservation_no, status, starts_at, ends_at, hold_expires_at,
           external_ref_type, external_ref
    FROM awcms_booking_reservations
    WHERE tenant_id = ${tenantId} AND id = ${reservationId}
  `) as ReservationRow[];
  return rows[0] ? toFacts(rows[0]) : null;
}

/** The status only - the consumers' fast question. `null` when the row is not visible. */
export async function readBookingReservationStatus(
  tx: Bun.SQL,
  tenantId: string,
  reservationId: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT status FROM awcms_booking_reservations
    WHERE tenant_id = ${tenantId} AND id = ${reservationId}
  `) as { status: string }[];
  return rows[0]?.status ?? null;
}

/** What the till's lookup finds: the link, and the customer the order belongs to (raw; the caller masks the contact). */
export type PosLookupMatch = {
  linkId: string;
  orderId: string;
  orderItemId: string;
  reservationId: string;
  linkStatus: string;
  guestName: string;
  guestPhone: string;
  guestEmail: string | null;
};

type PosLookupRow = {
  link_id: string;
  order_id: string;
  order_item_id: string;
  reservation_id: string;
  link_status: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string | null;
};

/**
 * The till's lookup (Issue #383, controls C-34 and C-36): ONE reservation by its
 * EXACT code AND the customer's EXACT phone or e-mail, in a single statement.
 * The customer condition is part of the query, so an unknown code, a code whose
 * customer is somebody else and another tenant's code are one `null` - there is
 * no second query whose outcome could tell them apart. Equality only (`=`, never
 * `LIKE`), so there is no partial or prefix search; the caller has already
 * normalised the phone (E.164) and lower-cased the e-mail.
 *
 * The ACTIVE link wins over a superseded or released one (a rescheduled
 * reservation's old code still finds its history, but cannot be acted on).
 */
export async function findReservationLinkForPosLookup(
  tx: Bun.SQL,
  tenantId: string,
  reservationNo: string,
  identifier: { kind: "phone" | "email"; value: string }
): Promise<PosLookupMatch | null> {
  const phone = identifier.kind === "phone" ? identifier.value : null;
  const email = identifier.kind === "email" ? identifier.value : null;
  const rows = (await tx`
    SELECT l.id AS link_id, l.order_id, l.order_item_id, l.reservation_id,
           l.status AS link_status, c.name AS guest_name, c.phone AS guest_phone,
           c.email AS guest_email
    FROM awcms_booking_reservations r
    JOIN awcms_commerce_booking_reservation_links l
      ON l.tenant_id = r.tenant_id AND l.reservation_id = r.id
    JOIN awcms_commerce_orders o
      ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    JOIN awcms_commerce_customers c
      ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
    WHERE r.tenant_id = ${tenantId}
      AND r.reservation_no = ${reservationNo}
      AND (
        (${phone}::text IS NOT NULL AND c.phone = ${phone}::text)
        OR (${email}::text IS NOT NULL AND lower(c.email) = ${email}::text)
      )
    ORDER BY (l.status = 'active') DESC, l.created_at DESC, l.id DESC
    LIMIT 1
  `) as PosLookupRow[];
  const row = rows[0];
  if (!row) return null;
  return {
    linkId: row.link_id,
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    reservationId: row.reservation_id,
    linkStatus: row.link_status,
    guestName: row.guest_name,
    guestPhone: row.guest_phone,
    guestEmail: row.guest_email
  };
}

export const RECONCILIATION_KINDS = [
  "paid_without_confirm",
  "confirmed_without_deposit",
  "booking_reference_missing",
  "commerce_link_missing",
  "reschedule_difference_unpaid"
] as const;
export type ReconciliationKind = (typeof RECONCILIATION_KINDS)[number];

export type ReconciliationItem = {
  kind: ReconciliationKind;
  /** `null` for `commerce_link_missing`: there is no link to name. */
  linkId: string | null;
  orderId: string;
  orderCode: string;
  orderStatus: string;
  reservationId: string;
  reservationNo: string;
  reservationStatus: string;
  /** `numeric(14,2)` strings, from the ledger. */
  total: string;
  threshold: string;
  settled: string;
  attentionReason: string | null;
  attentionOpen: boolean;
};

export type ReconciliationReport = {
  items: ReconciliationItem[];
  /** `true` when the bound cut the list short; narrow by resolving what is shown and read again. */
  truncated: boolean;
};

export const RECONCILIATION_LIMIT = 200;

const CONFIRMED_OR_BEYOND = ["confirmed", "checked_in", "completed", "no_show"];

type ReconRow = {
  link_id: string | null;
  order_id: string;
  order_code: string;
  order_status: string;
  total: string;
  threshold: string;
  settled: string;
  reservation_id: string;
  reservation_no: string;
  reservation_status: string;
  attention_reason: string | null;
  attention_resolved_at: Date | string | null;
};

function toItem(row: ReconRow, kind: ReconciliationKind): ReconciliationItem {
  return {
    kind,
    linkId: row.link_id,
    orderId: row.order_id,
    orderCode: row.order_code,
    orderStatus: row.order_status,
    reservationId: row.reservation_id,
    reservationNo: row.reservation_no,
    reservationStatus: row.reservation_status,
    total: normalizeMoney(row.total),
    threshold: normalizeMoney(row.threshold),
    settled: normalizeMoney(row.settled),
    attentionReason: row.attention_reason,
    attentionOpen:
      row.attention_reason !== null && row.attention_resolved_at === null
  };
}

/**
 * Active links whose order's ledger and reservation status disagree (control
 * C-09), and the three reschedule findings above. Money is read from the
 * allocation ledger exactly as settlement is derived: succeeded payments minus
 * succeeded reversals. The release threshold is `dp_amount` for a down-payment
 * order and the total otherwise (`releaseThresholdCents`, ADR-0025 D3),
 * restated in SQL so each report is one bounded statement.
 */
export async function reconcileBookingOrders(
  tx: Bun.SQL,
  tenantId: string,
  limit: number = RECONCILIATION_LIMIT
): Promise<ReconciliationReport> {
  const rows = (await tx`
    WITH active AS (
      SELECT l.id AS link_id, l.order_id, l.reservation_id, l.attention_reason,
             l.attention_resolved_at, l.created_at
      FROM awcms_commerce_booking_reservation_links l
      WHERE l.tenant_id = ${tenantId} AND l.status = 'active'
    ),
    ledger AS (
      SELECT a.order_id,
             COALESCE(SUM(CASE
               WHEN a.kind = 'payment' THEN a.amount
               WHEN a.kind = 'reversal' THEN -a.amount
               ELSE 0 END), 0) AS settled
      FROM awcms_commerce_payment_allocations a
      WHERE a.tenant_id = ${tenantId}
        AND a.status = 'succeeded'
        AND a.order_id IN (SELECT order_id FROM active)
      GROUP BY a.order_id
    ),
    -- Issue #382: money a reschedule that shortened the stay already gave back
    -- (settled legs of the order's cancellation returns) is not a missing deposit.
    refunded AS (
      SELECT f.order_id, COALESCE(SUM(f.amount), 0) AS refunded
      FROM awcms_commerce_refunds f
      JOIN awcms_commerce_returns t
        ON t.tenant_id = f.tenant_id AND t.id = f.return_id
      WHERE f.tenant_id = ${tenantId}
        AND t.kind = 'cancellation'
        AND f.status = 'succeeded'
        AND f.order_id IN (SELECT order_id FROM active)
      GROUP BY f.order_id
    ),
    joined AS (
      SELECT active.link_id, active.order_id, o.order_code, o.status AS order_status,
             o.total - COALESCE(refunded.refunded, 0) AS total,
             (CASE WHEN o.payment_method = 'dp' AND o.dp_amount IS NOT NULL
                        AND o.dp_amount > 0 AND o.dp_amount < o.total
                   THEN o.dp_amount ELSE o.total END)
               - COALESCE(refunded.refunded, 0) AS threshold,
             COALESCE(ledger.settled, 0) AS settled,
             r.id AS reservation_id, r.reservation_no, r.status AS reservation_status,
             active.attention_reason, active.attention_resolved_at, active.created_at
      FROM active
      JOIN awcms_commerce_orders o
        ON o.tenant_id = ${tenantId} AND o.id = active.order_id
      JOIN awcms_booking_reservations r
        ON r.tenant_id = ${tenantId} AND r.id = active.reservation_id
      LEFT JOIN ledger ON ledger.order_id = active.order_id
      LEFT JOIN refunded ON refunded.order_id = active.order_id
    )
    SELECT * FROM joined
    WHERE (settled >= threshold AND total > 0
           AND reservation_status IN ('held', 'expired', 'cancelled'))
       OR (settled < threshold
           AND reservation_status IN ('confirmed', 'checked_in', 'completed', 'no_show'))
    ORDER BY created_at DESC, link_id DESC
    LIMIT ${limit + 1}
  `) as ReconRow[];

  const items = rows.map((row): ReconciliationItem =>
    toItem(
      row,
      CONFIRMED_OR_BEYOND.includes(row.reservation_status)
        ? "confirmed_without_deposit"
        : "paid_without_confirm"
    )
  );

  // -- Issue #382: the order with ONE reference instead of two (C-38) -----------
  const missingOnBookingSide = (await tx`
    SELECT l.id AS link_id, l.order_id, o.order_code, o.status AS order_status,
           o.total, o.total AS threshold, 0::numeric AS settled,
           r.id AS reservation_id, r.reservation_no, r.status AS reservation_status,
           l.attention_reason, l.attention_resolved_at
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_commerce_orders o
      ON o.tenant_id = ${tenantId} AND o.id = l.order_id
    JOIN awcms_booking_reservations r
      ON r.tenant_id = ${tenantId} AND r.id = l.reservation_id
    WHERE l.tenant_id = ${tenantId} AND l.status = 'active'
      AND (r.external_ref_type IS DISTINCT FROM ${BOOKING_RESERVATION_ORDER_REFERENCE_TYPE}
           OR r.external_ref IS DISTINCT FROM l.order_id::text)
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limit + 1}
  `) as ReconRow[];
  items.push(
    ...missingOnBookingSide.map((row) =>
      toItem(row, "booking_reference_missing")
    )
  );

  const missingOnCommerceSide = (await tx`
    SELECT NULL::uuid AS link_id, o.id AS order_id, o.order_code,
           o.status AS order_status, o.total, o.total AS threshold, 0::numeric AS settled,
           r.id AS reservation_id, r.reservation_no, r.status AS reservation_status,
           NULL::text AS attention_reason, NULL::timestamptz AS attention_resolved_at
    FROM awcms_booking_reservations r
    JOIN awcms_commerce_orders o
      ON o.tenant_id = ${tenantId} AND o.id::text = r.external_ref
    WHERE r.tenant_id = ${tenantId}
      AND r.external_ref_type = ${BOOKING_RESERVATION_ORDER_REFERENCE_TYPE}
      AND r.status IN ('held', 'confirmed', 'checked_in')
      AND NOT EXISTS (
        SELECT 1 FROM awcms_commerce_booking_reservation_links l
        WHERE l.tenant_id = ${tenantId} AND l.reservation_id = r.id
          AND l.status = 'active'
      )
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${limit + 1}
  `) as ReconRow[];
  items.push(
    ...missingOnCommerceSide.map((row) => toItem(row, "commerce_link_missing"))
  );

  // -- Issue #382: nights added by a reschedule that nobody paid for (C-39) --------
  const unpaidDifference = (await tx`
    SELECT l.id AS link_id, s.id AS order_id, s.order_code, s.status AS order_status,
           s.total, s.total AS threshold,
           COALESCE((
             SELECT SUM(CASE WHEN a.kind = 'payment' THEN a.amount
                             WHEN a.kind = 'reversal' THEN -a.amount ELSE 0 END)
             FROM awcms_commerce_payment_allocations a
             WHERE a.tenant_id = ${tenantId} AND a.order_id = s.id
               AND a.status = 'succeeded'
           ), 0) AS settled,
           r.id AS reservation_id, r.reservation_no, r.status AS reservation_status,
           l.attention_reason, l.attention_resolved_at
    FROM awcms_commerce_booking_reschedules rs
    JOIN awcms_commerce_orders s
      ON s.tenant_id = ${tenantId} AND s.id = rs.supplement_order_id
    JOIN awcms_commerce_booking_reservation_links l
      ON l.tenant_id = ${tenantId} AND l.order_id = rs.order_id AND l.status = 'active'
    JOIN awcms_booking_reservations r
      ON r.tenant_id = ${tenantId} AND r.id = l.reservation_id
    WHERE rs.tenant_id = ${tenantId} AND rs.difference_direction = 'charge'
      AND r.status IN ('confirmed', 'checked_in')
      AND (s.status IN ('cancelled', 'expired')
           OR (s.status = 'pending_payment' AND s.expires_at < now()))
      AND COALESCE((
        SELECT SUM(CASE WHEN a.kind = 'payment' THEN a.amount
                        WHEN a.kind = 'reversal' THEN -a.amount ELSE 0 END)
        FROM awcms_commerce_payment_allocations a
        WHERE a.tenant_id = ${tenantId} AND a.order_id = s.id
          AND a.status = 'succeeded'
      ), 0) < s.total
    ORDER BY rs.created_at DESC, rs.id DESC
    LIMIT ${limit + 1}
  `) as ReconRow[];
  items.push(
    ...unpaidDifference.map((row) =>
      toItem(row, "reschedule_difference_unpaid")
    )
  );

  return { items: items.slice(0, limit), truncated: items.length > limit };
}

// ---------------------------------------------------------------------------
// C-38: the zero-or-two-references reconciliation (Issue #396).
// ---------------------------------------------------------------------------

// "Live" below means the statuses in which Booking's partial unique index on
// `(external_ref_type, external_ref)` (`sql/180`) binds a reservation: held,
// confirmed, checked_in. A completed, no-show, expired, cancelled or
// rescheduled reservation keeps its `external_ref` as history and holds no
// claim on the order, so it is never reported.

export const REFERENCE_DRIFT_KINDS = [
  "back_reference_missing",
  "back_reference_mismatch",
  "link_on_rescheduled_reservation",
  "orphan_back_reference",
  "order_multiple_references"
] as const satisfies readonly ReferenceKind[];
export type ReferenceDriftKind = (typeof REFERENCE_DRIFT_KINDS)[number];

export type ReferenceDriftReport = {
  items: ReferenceDriftItem[];
  /** `true` when any of the statements hit its bound; the drift is real either way. */
  truncated: boolean;
};

export const REFERENCE_DRIFT_LIMIT = 200;

type LinkSideRow = {
  kind: ReferenceDriftKind;
  link_id: string;
  order_id: string;
  reservation_id: string;
  reservation_no: string;
  reservation_status: string;
  external_ref_type: string | null;
  external_ref: string | null;
};

type OrphanRow = {
  reservation_id: string;
  reservation_no: string;
  reservation_status: string;
  external_ref_type: string;
  external_ref: string;
  order_exists: boolean;
};

type MultiRow = {
  order_ref: string;
  live_references: number | string;
  active_links: number | string;
};

const emptyItem = (kind: ReferenceDriftKind): ReferenceDriftItem => ({
  kind,
  linkId: null,
  orderId: null,
  reservationId: null,
  reservationNo: null,
  reservationStatus: null,
  externalRefType: null,
  externalRef: null,
  orderExists: null,
  liveReferences: null,
  activeLinks: null
});

/**
 * Orders whose reference to a reservation is not exactly one on each side (the
 * "zero or two live references" report of threat control C-38, restated for the
 * restore drill). Booking holds the reverse reference as the opaque
 * `external_ref_type = 'commerce_order'` / `external_ref = <order id>` pair; the
 * adapter holds the forward one as the active reservation link. A paid order
 * must be reachable from exactly one live reservation, and that reservation from
 * exactly one active link. Five ways to break it, none of which a foreign key
 * can see (the reverse reference is opaque text):
 *
 *   - `back_reference_missing`: an active link whose reservation carries no
 *     reference (ONE reference: the order names a stay that does not name it);
 *   - `back_reference_mismatch`: the reservation's reference names another order
 *     or another type;
 *   - `link_on_rescheduled_reservation`: an active link left on the reservation
 *     a reschedule replaced ("the old reservation is never left linked", A6);
 *   - `orphan_back_reference`: a LIVE reservation names an order but no active
 *     link points at it (a hold with no link; also reports whether the order
 *     exists at all);
 *   - `order_multiple_references`: an order named by more than one live
 *     reservation or by active links on more than one reservation (TWO
 *     references: a paid order covers two stays). Booking's partial unique index
 *     makes the first impossible while the index exists, which is exactly why a
 *     restore that lost the index shows up here.
 *
 * Read-only, tenant-scoped, and each statement is bounded by `limit`. A restore
 * is a point-in-time image, so a database that was consistent when the dump was
 * taken is consistent here: every row this returns is a defect of the backup, of
 * the restore, or one that was already live in the source.
 */
export async function reconcileBookingReferences(
  tx: Bun.SQL,
  tenantId: string,
  limit: number = REFERENCE_DRIFT_LIMIT
): Promise<ReferenceDriftReport> {
  const linkSide = (await tx`
    SELECT
      CASE
        WHEN r.status = 'rescheduled' THEN 'link_on_rescheduled_reservation'
        WHEN r.external_ref IS NULL THEN 'back_reference_missing'
        ELSE 'back_reference_mismatch'
      END AS kind,
      l.id AS link_id, l.order_id, l.reservation_id,
      r.reservation_no, r.status AS reservation_status,
      r.external_ref_type, r.external_ref
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_booking_reservations r
      ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id
    WHERE l.tenant_id = ${tenantId}
      AND l.status = 'active'
      AND (
        r.status = 'rescheduled'
        OR r.external_ref IS NULL
        OR r.external_ref_type IS DISTINCT FROM 'commerce_order'
        OR r.external_ref <> l.order_id::text
      )
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limit + 1}
  `) as LinkSideRow[];

  const orphans = (await tx`
    SELECT r.id AS reservation_id, r.reservation_no, r.status AS reservation_status,
           r.external_ref_type, r.external_ref,
           EXISTS (
             SELECT 1 FROM awcms_commerce_orders o
             WHERE o.tenant_id = r.tenant_id AND o.id::text = r.external_ref
           ) AS order_exists
    FROM awcms_booking_reservations r
    WHERE r.tenant_id = ${tenantId}
      AND r.external_ref_type = 'commerce_order'
      AND r.status IN ('held', 'confirmed', 'checked_in')
      AND NOT EXISTS (
        SELECT 1 FROM awcms_commerce_booking_reservation_links l
        WHERE l.tenant_id = r.tenant_id
          AND l.reservation_id = r.id
          AND l.status = 'active'
      )
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${limit + 1}
  `) as OrphanRow[];

  const multiples = (await tx`
    WITH refs AS (
      SELECT r.external_ref AS order_ref, count(*)::int AS live_references
      FROM awcms_booking_reservations r
      WHERE r.tenant_id = ${tenantId}
        AND r.external_ref_type = 'commerce_order'
        AND r.status IN ('held', 'confirmed', 'checked_in')
      GROUP BY r.external_ref
      HAVING count(*) > 1
    ),
    links AS (
      SELECT l.order_id::text AS order_ref,
             count(DISTINCT l.reservation_id)::int AS active_links
      FROM awcms_commerce_booking_reservation_links l
      WHERE l.tenant_id = ${tenantId} AND l.status = 'active'
      GROUP BY l.order_id
      HAVING count(DISTINCT l.reservation_id) > 1
    )
    SELECT COALESCE(refs.order_ref, links.order_ref) AS order_ref,
           COALESCE(refs.live_references, 0) AS live_references,
           COALESCE(links.active_links, 0) AS active_links
    FROM refs
    FULL JOIN links ON links.order_ref = refs.order_ref
    ORDER BY 1
    LIMIT ${limit + 1}
  `) as MultiRow[];

  const truncated =
    linkSide.length > limit ||
    orphans.length > limit ||
    multiples.length > limit;

  const items: ReferenceDriftItem[] = [
    ...linkSide.slice(0, limit).map((row): ReferenceDriftItem => ({
      ...emptyItem(row.kind),
      linkId: row.link_id,
      orderId: row.order_id,
      reservationId: row.reservation_id,
      reservationNo: row.reservation_no,
      reservationStatus: row.reservation_status,
      externalRefType: row.external_ref_type,
      externalRef: row.external_ref
    })),
    ...orphans.slice(0, limit).map((row): ReferenceDriftItem => ({
      ...emptyItem("orphan_back_reference"),
      orderId: row.external_ref,
      reservationId: row.reservation_id,
      reservationNo: row.reservation_no,
      reservationStatus: row.reservation_status,
      externalRefType: row.external_ref_type,
      externalRef: row.external_ref,
      orderExists: row.order_exists
    })),
    ...multiples.slice(0, limit).map((row): ReferenceDriftItem => ({
      ...emptyItem("order_multiple_references"),
      orderId: row.order_ref,
      liveReferences: Number(row.live_references),
      activeLinks: Number(row.active_links)
    }))
  ];

  return { items, truncated };
}
