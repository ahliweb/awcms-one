/**
 * The booking-derived fact scans of a CRM segment rule (Issue #390, ADR-0051,
 * rule schema 2). Pure SQL fragments, like `segment-sql.ts`, which composes them.
 *
 * ## What a booking fact is, and where it comes from
 *
 * No adapter table has a customer column (ADR-0045 D3, finding X7): a
 * reservation's customer is the customer of the ORDER its link points to. Every
 * scan below therefore starts at a commerce-owned table and reaches the
 * customer through `awcms_commerce_orders.customer_id`:
 *
 *   facts "bookings"   link (active) -> order -> reservation (Booking's row)
 *   facts "decisions"  refund decision -> order
 *
 * `booking_count` and `stay_count` need the reservation's STATUS and arrival
 * instant, which only Booking holds (`BookingPort` has no bulk read, upstream
 * addition U1), so the first scan names `awcms_booking_reservations` - in
 * `SELECT` only, three columns (`status`, `starts_at` and the join keys), never
 * `external_customer_ref`, `customer_note` or any other personal column; a test
 * pins that. `no_show_count` and `cancellation_count` read the adapter's own
 * evidence (`awcms_commerce_booking_refund_decisions`) and touch no Booking
 * table. Nothing is copied or stored: the figures are aggregated per evaluation
 * under the caller's tenant RLS, exactly as the order facts are.
 *
 * ## The definitions (frozen for rule schema 2)
 *
 *   booking    an ACTIVE link whose reservation is `confirmed`, `checked_in` or
 *              `completed` and whose order is paid (`paid_at` set and not after
 *              the as-of). Counted per reservation; a reschedule's replacement
 *              is one booking (the old link is `superseded`, its reservation
 *              `rescheduled`). The window is the order's `paid_at` - the same
 *              anchor as the retention cohort (ADR-0045, D-R2).
 *   stay       a reservation that is `checked_in` or `completed` and whose
 *              arrival (`starts_at`) is not after the as-of. The window and
 *              `last_stay_date` use the arrival instant.
 *   no-show    a `no_show` refund decision of the customer's order; the window
 *              is the decision's `created_at`.
 *   cancel     a `customer_cancel` refund decision (a cancellation the CUSTOMER
 *              made). A `staff_cancel` is the venue's decision and is never
 *              counted against a customer.
 *
 * Statuses are read as they are NOW (Booking keeps no queryable status
 * history), like the loyalty balance (ADR-0042 A4); instants are cut at the
 * as-of, so a rule with relative windows is still deterministic for a given
 * as-of and data. A reservation with no link (a staff-only reservation) is in no
 * customer's facts (data model 5.1).
 *
 * ## Cost
 *
 * One grouped scan per family, each skipped entirely when the rule reads none of
 * its facts, and each computing the all-time figure and the (up to three)
 * windowed variants as FILTERed aggregates in the same pass - the shape of the
 * order-facts scan. ADR-0051 D6 records the measurement.
 */
export type WindowSlot = "all" | "w0" | "w1" | "w2";

type Bound = { asOf: string };

/** The Booking statuses that make a reservation a standing booking. */
const BOOKING_STATUSES = ["confirmed", "checked_in", "completed"] as const;
/** The Booking statuses that mean the guest arrived. */
const STAY_STATUSES = ["checked_in", "completed"] as const;

/** Which booking fact families a rule reads, so an unused scan is neither joined nor run. */
export type SegmentBookingNeeds = {
  /** booking_count, stay_count, last_stay_date: the link -> order -> reservation scan. */
  bookings: boolean;
  /** no_show_count, cancellation_count: the refund-decision scan. */
  decisions: boolean;
};

/** The rule's distinct windows in slot order (`stats.windows`), padded with nulls. */
export type SlotWindows = [number | null, number | null, number | null];

/**
 * The join of the customer's booking facts (`b`): `bk_*` booking counts,
 * `st_*` stay counts and the latest arrival `last_stay_at`.
 */
export function bookingFactsJoin(
  tx: Bun.SQL,
  tenantId: string,
  windows: SlotWindows,
  bound: Bound,
  needs: SegmentBookingNeeds,
  customerId: string | null
) {
  if (!needs.bookings) return tx``;
  const onlyCustomer =
    customerId === null ? tx`` : tx`AND o.customer_id = ${customerId}::uuid`;
  const bookingStatuses = tx.array([...BOOKING_STATUSES], "text");
  const stayStatuses = tx.array([...STAY_STATUSES], "text");
  const [w0, w1, w2] = windows;
  return tx`
    LEFT JOIN (
      SELECT o.customer_id,
        (count(*) FILTER (WHERE r.status = ANY(${bookingStatuses}::text[])
          AND o.paid_at IS NOT NULL AND o.paid_at <= ${bound.asOf}::timestamptz))::int AS bk_all,
        (count(*) FILTER (WHERE r.status = ANY(${bookingStatuses}::text[])
          AND o.paid_at IS NOT NULL AND o.paid_at <= ${bound.asOf}::timestamptz
          AND ${w0}::int IS NOT NULL
          AND o.paid_at > ${bound.asOf}::timestamptz - make_interval(days => ${w0}::int)))::int AS bk_w0,
        (count(*) FILTER (WHERE r.status = ANY(${bookingStatuses}::text[])
          AND o.paid_at IS NOT NULL AND o.paid_at <= ${bound.asOf}::timestamptz
          AND ${w1}::int IS NOT NULL
          AND o.paid_at > ${bound.asOf}::timestamptz - make_interval(days => ${w1}::int)))::int AS bk_w1,
        (count(*) FILTER (WHERE r.status = ANY(${bookingStatuses}::text[])
          AND o.paid_at IS NOT NULL AND o.paid_at <= ${bound.asOf}::timestamptz
          AND ${w2}::int IS NOT NULL
          AND o.paid_at > ${bound.asOf}::timestamptz - make_interval(days => ${w2}::int)))::int AS bk_w2,
        (count(*) FILTER (WHERE r.status = ANY(${stayStatuses}::text[])
          AND r.starts_at <= ${bound.asOf}::timestamptz))::int AS st_all,
        (count(*) FILTER (WHERE r.status = ANY(${stayStatuses}::text[])
          AND r.starts_at <= ${bound.asOf}::timestamptz
          AND ${w0}::int IS NOT NULL
          AND r.starts_at > ${bound.asOf}::timestamptz - make_interval(days => ${w0}::int)))::int AS st_w0,
        (count(*) FILTER (WHERE r.status = ANY(${stayStatuses}::text[])
          AND r.starts_at <= ${bound.asOf}::timestamptz
          AND ${w1}::int IS NOT NULL
          AND r.starts_at > ${bound.asOf}::timestamptz - make_interval(days => ${w1}::int)))::int AS st_w1,
        (count(*) FILTER (WHERE r.status = ANY(${stayStatuses}::text[])
          AND r.starts_at <= ${bound.asOf}::timestamptz
          AND ${w2}::int IS NOT NULL
          AND r.starts_at > ${bound.asOf}::timestamptz - make_interval(days => ${w2}::int)))::int AS st_w2,
        max(r.starts_at) FILTER (WHERE r.status = ANY(${stayStatuses}::text[])
          AND r.starts_at <= ${bound.asOf}::timestamptz) AS last_stay_at
      FROM awcms_commerce_booking_reservation_links l
      JOIN awcms_commerce_orders o
        ON o.tenant_id = l.tenant_id AND o.id = l.order_id
      JOIN awcms_booking_reservations r
        ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id
      WHERE l.tenant_id = ${tenantId}
        AND l.status = 'active'
        AND l.deleted_at IS NULL
        AND o.deleted_at IS NULL
        ${onlyCustomer}
      GROUP BY o.customer_id
    ) b ON b.customer_id = c.id`;
}

/**
 * The join of the customer's cancellation and no-show decisions (`bd`):
 * `ns_*` no-shows, `cx_*` cancellations the customer made.
 */
export function bookingDecisionFactsJoin(
  tx: Bun.SQL,
  tenantId: string,
  windows: SlotWindows,
  bound: Bound,
  needs: SegmentBookingNeeds,
  customerId: string | null
) {
  if (!needs.decisions) return tx``;
  const onlyCustomer =
    customerId === null ? tx`` : tx`AND o.customer_id = ${customerId}::uuid`;
  const [w0, w1, w2] = windows;
  return tx`
    LEFT JOIN (
      SELECT o.customer_id,
        (count(*) FILTER (WHERE d.trigger_kind = 'no_show'
          AND d.created_at <= ${bound.asOf}::timestamptz))::int AS ns_all,
        (count(*) FILTER (WHERE d.trigger_kind = 'no_show'
          AND d.created_at <= ${bound.asOf}::timestamptz AND ${w0}::int IS NOT NULL
          AND d.created_at > ${bound.asOf}::timestamptz - make_interval(days => ${w0}::int)))::int AS ns_w0,
        (count(*) FILTER (WHERE d.trigger_kind = 'no_show'
          AND d.created_at <= ${bound.asOf}::timestamptz AND ${w1}::int IS NOT NULL
          AND d.created_at > ${bound.asOf}::timestamptz - make_interval(days => ${w1}::int)))::int AS ns_w1,
        (count(*) FILTER (WHERE d.trigger_kind = 'no_show'
          AND d.created_at <= ${bound.asOf}::timestamptz AND ${w2}::int IS NOT NULL
          AND d.created_at > ${bound.asOf}::timestamptz - make_interval(days => ${w2}::int)))::int AS ns_w2,
        (count(*) FILTER (WHERE d.trigger_kind = 'customer_cancel'
          AND d.created_at <= ${bound.asOf}::timestamptz))::int AS cx_all,
        (count(*) FILTER (WHERE d.trigger_kind = 'customer_cancel'
          AND d.created_at <= ${bound.asOf}::timestamptz AND ${w0}::int IS NOT NULL
          AND d.created_at > ${bound.asOf}::timestamptz - make_interval(days => ${w0}::int)))::int AS cx_w0,
        (count(*) FILTER (WHERE d.trigger_kind = 'customer_cancel'
          AND d.created_at <= ${bound.asOf}::timestamptz AND ${w1}::int IS NOT NULL
          AND d.created_at > ${bound.asOf}::timestamptz - make_interval(days => ${w1}::int)))::int AS cx_w1,
        (count(*) FILTER (WHERE d.trigger_kind = 'customer_cancel'
          AND d.created_at <= ${bound.asOf}::timestamptz AND ${w2}::int IS NOT NULL
          AND d.created_at > ${bound.asOf}::timestamptz - make_interval(days => ${w2}::int)))::int AS cx_w2
      FROM awcms_commerce_booking_refund_decisions d
      JOIN awcms_commerce_orders o
        ON o.tenant_id = d.tenant_id AND o.id = d.order_id
      WHERE d.tenant_id = ${tenantId}
        AND o.deleted_at IS NULL
        ${onlyCustomer}
      GROUP BY o.customer_id
    ) bd ON bd.customer_id = c.id`;
}

// ---------------------------------------------------------------------------
// The columns a leaf compares. Each is a literal template: the slot selects a
// column NAME written here, never a value a rule supplies.
// ---------------------------------------------------------------------------

export function bookingCountColumn(tx: Bun.SQL, slot: WindowSlot) {
  switch (slot) {
    case "all":
      return tx`COALESCE(b.bk_all, 0)`;
    case "w0":
      return tx`COALESCE(b.bk_w0, 0)`;
    case "w1":
      return tx`COALESCE(b.bk_w1, 0)`;
    case "w2":
      return tx`COALESCE(b.bk_w2, 0)`;
  }
}

export function stayCountColumn(tx: Bun.SQL, slot: WindowSlot) {
  switch (slot) {
    case "all":
      return tx`COALESCE(b.st_all, 0)`;
    case "w0":
      return tx`COALESCE(b.st_w0, 0)`;
    case "w1":
      return tx`COALESCE(b.st_w1, 0)`;
    case "w2":
      return tx`COALESCE(b.st_w2, 0)`;
  }
}

export function noShowCountColumn(tx: Bun.SQL, slot: WindowSlot) {
  switch (slot) {
    case "all":
      return tx`COALESCE(bd.ns_all, 0)`;
    case "w0":
      return tx`COALESCE(bd.ns_w0, 0)`;
    case "w1":
      return tx`COALESCE(bd.ns_w1, 0)`;
    case "w2":
      return tx`COALESCE(bd.ns_w2, 0)`;
  }
}

export function cancellationCountColumn(tx: Bun.SQL, slot: WindowSlot) {
  switch (slot) {
    case "all":
      return tx`COALESCE(bd.cx_all, 0)`;
    case "w0":
      return tx`COALESCE(bd.cx_w0, 0)`;
    case "w1":
      return tx`COALESCE(bd.cx_w1, 0)`;
    case "w2":
      return tx`COALESCE(bd.cx_w2, 0)`;
  }
}
