/**
 * Read-only fact loaders of the two booking-aware reporting projections (Issue
 * #389, ADR-0045 amendment note): the booking revenue waterfall
 * (`commerce.booking_revenue`) and the booking anchor of the customer-retention
 * projection (`commerce.customer_retention`). Every function takes the ENGINE's
 * transaction (`tx`), is tenant-scoped in the statement AND by RLS, and only
 * READS: the adapter's link, decision and reschedule tables, the order header,
 * its items and the payment ledger. Nothing here reads a table of the `booking`
 * module - the seam is the adapter's own tables (ADR-0040 D5.9) - and nothing
 * here imports a pool or `withTenant`, so `module.ts` can reference the sinks
 * that use it without dragging a connection into every registry gate.
 *
 * ## Which orders are booking-sourced
 *
 * An order is booking-sourced when it carries a reservation link
 * (`reservation`), or when a reschedule record names it as the supplementary
 * order of a stay that grew (`supplement`). Both relationships are written in
 * the transaction that creates the order and are never removed, so the set only
 * grows and a recompute can find an order's provenance at any later time.
 */
import type { RetentionBookingFact } from "../domain/retention";
import {
  NO_DECIDED_REFUNDS,
  type BookingDecidedRefunds,
  type BookingOrderFacts,
  type BookingSourceKind
} from "../domain/booking-revenue";
import { toCents } from "../domain/price-calculation";

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

type LinkAggregateRow = {
  order_id: string;
  stays: number;
  standing: number;
};

type SupplementRow = { supplement_order_id: string };

/**
 * Which of `orderIds` are booking orders, with the number of reservation chain
 * heads (links that are not `superseded`) and how many of those still stand
 * (not released by a CANCELLATION decision; a no-show release still stands).
 */
async function loadLinkAggregates(
  tx: Bun.SQL,
  tenantId: string,
  orderIds: readonly string[]
): Promise<Map<string, { stays: number; standing: number }>> {
  const found = new Map<string, { stays: number; standing: number }>();
  if (orderIds.length === 0) return found;
  const rows = (await tx`
    SELECT l.order_id,
      (count(*) FILTER (WHERE l.status <> 'superseded'))::int AS stays,
      (count(*) FILTER (
        WHERE l.status <> 'superseded'
          AND NOT (
            l.status = 'released'
            AND EXISTS (
              SELECT 1 FROM awcms_commerce_booking_refund_decisions d
              WHERE d.tenant_id = l.tenant_id
                AND d.reservation_link_id = l.id
                AND d.trigger_kind <> 'no_show'
            )
          )
      ))::int AS standing
    FROM awcms_commerce_booking_reservation_links l
    WHERE l.tenant_id = ${tenantId}
      AND l.order_id = ANY(${tx.array([...orderIds], "uuid")}::uuid[])
    GROUP BY l.order_id
  `) as LinkAggregateRow[];
  for (const row of rows) {
    found.set(row.order_id, {
      stays: Number(row.stays),
      standing: Number(row.standing)
    });
  }
  return found;
}

async function loadSupplementOrderIds(
  tx: Bun.SQL,
  tenantId: string,
  orderIds: readonly string[]
): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  const rows = (await tx`
    SELECT DISTINCT supplement_order_id
    FROM awcms_commerce_booking_reschedules
    WHERE tenant_id = ${tenantId}
      AND supplement_order_id = ANY(${tx.array([...orderIds], "uuid")}::uuid[])
  `) as SupplementRow[];
  return new Set(rows.map((row) => row.supplement_order_id));
}

/** The booking anchor facts of the retention recompute: only booking orders appear in the map. */
export async function loadRetentionBookingFacts(
  tx: Bun.SQL,
  tenantId: string,
  orderIds: readonly string[]
): Promise<Map<string, RetentionBookingFact>> {
  const facts = new Map<string, RetentionBookingFact>();
  if (orderIds.length === 0) return facts;
  const links = await loadLinkAggregates(tx, tenantId, orderIds);
  for (const [orderId, aggregate] of links) {
    facts.set(orderId, {
      kind: "reservation",
      standing: aggregate.standing > 0
    });
  }
  for (const orderId of await loadSupplementOrderIds(tx, tenantId, orderIds)) {
    if (!facts.has(orderId)) facts.set(orderId, { kind: "supplement" });
  }
  return facts;
}

type HeaderRow = {
  id: string;
  paid_at: Date | string | null;
  status: string;
  subtotal: string;
  shipping_cost: string;
  insurance_fee: string;
  tax: string;
  total: string;
};

type LedgerRow = {
  order_id: string;
  paid_in: string;
  paid_back: string;
};

type ReturnsRow = {
  order_id: string;
  goods: string;
  shipping: string;
  tax: string;
  lump: string;
};

type DecisionRow = {
  order_id: string;
  no_shows: number;
  retained: string;
  cancellations: number;
};

/**
 * The CURRENT facts of the booking-sourced orders among `orderIds`, ready for
 * {@link deriveBookingOrderRow}. An id that is not booking-sourced is simply
 * absent from the map. The ledger sums count only `succeeded` legs (a pending
 * or failed gateway leg is not money that moved).
 *
 * The refunds DECIDED on the order (Issue #478, metrics 3.9 D1) come from its
 * return records: every refund, whether a goods return, an exchange, a booking
 * cancellation or a reschedule's shortening, writes one (ADR-0033) in the same
 * transaction as its refund legs, so a record IS the obligation. A goods or
 * exchange record carries an exact split (goods gross less the discount released,
 * shipping, tax) that wins over pro rata; a `cancellation` record is a lump with
 * no split (sql/1043: one line, no shipping, no tax share), which is allocated.
 */
export async function loadBookingOrderFacts(
  tx: Bun.SQL,
  tenantId: string,
  orderIds: readonly string[]
): Promise<Map<string, BookingOrderFacts>> {
  const result = new Map<string, BookingOrderFacts>();
  const distinct = [...new Set(orderIds)];
  if (distinct.length === 0) return result;

  const links = await loadLinkAggregates(tx, tenantId, distinct);
  const supplements = await loadSupplementOrderIds(tx, tenantId, distinct);
  const kindOf = (orderId: string): BookingSourceKind | null =>
    links.has(orderId)
      ? "reservation"
      : supplements.has(orderId)
        ? "supplement"
        : null;
  const sourced = distinct.filter((orderId) => kindOf(orderId) !== null);
  if (sourced.length === 0) return result;
  const ids = tx.array(sourced, "uuid");

  const headers = (await tx`
    SELECT id, paid_at, status, subtotal, shipping_cost, insurance_fee, tax, total
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ANY(${ids}::uuid[])
  `) as HeaderRow[];

  const ledger = (await tx`
    SELECT order_id,
      COALESCE(sum(amount) FILTER (WHERE kind = 'payment'), 0)::text AS paid_in,
      COALESCE(sum(amount) FILTER (WHERE kind = 'reversal'), 0)::text AS paid_back
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND status = 'succeeded'
      AND order_id = ANY(${ids}::uuid[])
    GROUP BY order_id
  `) as LedgerRow[];
  const ledgerByOrder = new Map(ledger.map((row) => [row.order_id, row]));

  // Goods and exchange records carry an exact split; a cancellation record is a
  // lump. Exchange refund_total can be 0; the filter keeps it in the exact side.
  const returns = (await tx`
    SELECT order_id,
      COALESCE(sum(goods_gross - discount_share) FILTER (WHERE kind <> 'cancellation'), 0)::text AS goods,
      COALESCE(sum(shipping_refund) FILTER (WHERE kind <> 'cancellation'), 0)::text AS shipping,
      COALESCE(sum(tax_refund) FILTER (WHERE kind <> 'cancellation'), 0)::text AS tax,
      COALESCE(sum(refund_total) FILTER (WHERE kind = 'cancellation'), 0)::text AS lump
    FROM awcms_commerce_returns
    WHERE tenant_id = ${tenantId} AND order_id = ANY(${ids}::uuid[])
    GROUP BY order_id
  `) as ReturnsRow[];
  const returnsByOrder = new Map(returns.map((row) => [row.order_id, row]));

  const decisions = (await tx`
    SELECT order_id,
      (count(*) FILTER (WHERE trigger_kind = 'no_show'))::int AS no_shows,
      COALESCE(sum(retained_amount) FILTER (WHERE trigger_kind = 'no_show'), 0)::text AS retained,
      (count(*) FILTER (WHERE trigger_kind <> 'no_show'))::int AS cancellations
    FROM awcms_commerce_booking_refund_decisions
    WHERE tenant_id = ${tenantId} AND order_id = ANY(${ids}::uuid[])
    GROUP BY order_id
  `) as DecisionRow[];
  const decisionsByOrder = new Map(decisions.map((row) => [row.order_id, row]));

  for (const header of headers) {
    const sourceKind = kindOf(header.id);
    if (sourceKind === null) continue;
    const money = ledgerByOrder.get(header.id);
    const decided = decisionsByOrder.get(header.id);
    const returned = returnsByOrder.get(header.id);
    const refunds: BookingDecidedRefunds = returned
      ? {
          exact: {
            goods: toCents(String(returned.goods)),
            shipping: toCents(String(returned.shipping)),
            insurance: 0n,
            tax: toCents(String(returned.tax))
          },
          lumpCents: toCents(String(returned.lump))
        }
      : NO_DECIDED_REFUNDS;
    result.set(header.id, {
      orderId: header.id,
      sourceKind,
      paidAt: header.paid_at === null ? null : toDate(header.paid_at),
      status: header.status,
      subtotal: String(header.subtotal),
      shippingCost: String(header.shipping_cost),
      insuranceFee: String(header.insurance_fee),
      tax: String(header.tax),
      total: String(header.total),
      paidInCents: money ? toCents(String(money.paid_in)) : 0n,
      paidBackCents: money ? toCents(String(money.paid_back)) : 0n,
      refunds,
      stays: links.get(header.id)?.stays ?? 0,
      noShows: decided ? Number(decided.no_shows) : 0,
      noShowRetainedCents: decided ? toCents(String(decided.retained)) : 0n,
      cancellations: decided ? Number(decided.cancellations) : 0
    });
  }
  return result;
}
