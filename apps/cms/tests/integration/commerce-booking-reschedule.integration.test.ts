/**
 * Booking reschedule against a REAL migrated PostgreSQL (Issue #382, ADR-0045 D7
 * as amended for #382, G2/G5, contracts 3.7; threat controls C-37, C-38, C-39).
 * World 1 of `harness.ts`: the application functions are called with the
 * `awcms_app` runtime pool and the REAL composed `BookingPort`; domain events are
 * dispatched through the real consumer registry. The wiring (permission, strict
 * body, persona table) is proved through the real handlers in
 * `commerce-booking-reschedule-routes.integration.test.ts`.
 *
 * What only a database can prove:
 *
 *   - the order keeps TWO references (C-38): the old link is `superseded`, a new
 *     link points at the SAME order and line, Booking carries its own reference
 *     to the replacement; no order, line or allocation is edited;
 *   - a Booking refusal (the new dates are taken) and an unsellable supplement
 *     roll back to the untouched original on both sides;
 *   - the price difference is priced by the server and never by the request
 *     (C-39): the same length writes nothing else, more nights become a
 *     supplementary ORDER priced by the ordinary cart quote, fewer nights a
 *     policy-limited refund return planned through the existing refund planner;
 *   - the window is the ORIGINAL booking's (C-37): a chain of reschedules can
 *     neither extend the notice nor change the policy version;
 *   - a concurrent reschedule and cancel of one booking serialise on the order
 *     lock, and a replay answers the stored record;
 *   - the append-only record, its CHECKs and RLS;
 *   - the reconciler consumer repairs a reschedule made in Booking's own screen,
 *     and finds nothing to do after one made through the adapter.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { composedBookingPort } from "../../src/lib/composition/booking-port";
import {
  cancelBookingReservation,
  fetchDecisionForLink
} from "../../src/modules/commerce/application/booking-cancellation";
import {
  computeRescheduleQuote,
  listReschedulesForOrder,
  rescheduleBookingReservation,
  type RescheduleResult
} from "../../src/modules/commerce/application/booking-reschedule";
import { loadBookingOrderPanel } from "../../src/modules/commerce/application/booking-order-panel";
import { recordBookingNoShow } from "../../src/modules/commerce/application/booking-no-show";
import { setProductDepositPolicy } from "../../src/modules/commerce/application/booking-deposit-policies";
import { reconcileBookingOrders } from "../../src/modules/commerce/application/booking-reservation-reads";
import { fetchReservationLinkByReservationId } from "../../src/modules/commerce/application/booking-reservation-links";
import {
  DEFAULT_RESCHEDULE_REASON_CODE,
  type RescheduleRequest
} from "../../src/modules/commerce/domain/booking-reschedule";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import {
  createAdapterFixtures,
  D,
  HOUR,
  PRICE
} from "./booking-adapter-fixtures";
import {
  getAdminSql,
  getAppRoleSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "38200000-0382-4000-8000-00000000000a";
const TENANT_B = "38200000-0382-4000-8000-00000000000b";
const STAFF = "38200000-0382-4000-8000-0000000000b1";
const MANAGER = "38200000-0382-4000-8000-0000000000b2";
const SERVICE = "38200000-0382-4000-8000-0000000000b3";
const STAFF_B = "38200000-0382-4000-8000-0000000000b4";
const SERVICE_B = "38200000-0382-4000-8000-0000000000b5";

const fx = createAdapterFixtures({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  staff: STAFF,
  manager: MANAGER,
  service: SERVICE,
  staffB: STAFF_B,
  serviceB: SERVICE_B,
  keyPrefix: "r382"
});
const {
  inTenant,
  newFixture,
  newSlotFixture,
  slotAt,
  book,
  pay,
  bookedAndPaid,
  dispatch,
  startsAtOf,
  reservationStatus,
  orderStatus,
  policy,
  auditActions,
  attemptSql,
  arrivedHoursAgo,
  legsOf,
  tamperReservation,
  nextKey
} = fx;

type Resched = Partial<Pick<RescheduleRequest, "resourceId" | "reasonCode">> &
  (
    | { stay: { checkInDate: string; checkOutDate: string } }
    | { startsAt: string }
  );

/** Reschedules `reservationId` as the staff member; `now` moves the policy clock only. */
async function resched(
  reservationId: string,
  to: Resched,
  options: {
    key?: string;
    now?: Date;
    tenantId?: string;
    staffId?: string;
  } = {}
): Promise<RescheduleResult> {
  const tenantId = options.tenantId ?? TENANT_A;
  return inTenant(async (tx) => {
    const link = await fetchReservationLinkByReservationId(
      tx,
      tenantId,
      reservationId
    );
    if (!link) throw new Error("no link");
    return rescheduleBookingReservation(
      tx,
      {
        tenantId,
        actor: { kind: "staff", tenantUserId: options.staffId ?? STAFF },
        correlationId: crypto.randomUUID(),
        port: await composedBookingPort(),
        mediaPort: mediaLibraryPortAdapter,
        ...(options.now ? { now: options.now } : {})
      },
      {
        link,
        idempotencyKey: options.key ?? nextKey(),
        request: {
          startsAt: "startsAt" in to ? to.startsAt : null,
          stay: "stay" in to ? to.stay : null,
          resourceId: to.resourceId ?? null,
          reasonCode: to.reasonCode ?? DEFAULT_RESCHEDULE_REASON_CODE
        }
      }
    );
  }, tenantId);
}

function moved(result: RescheduleResult) {
  if (result.kind === "refused") {
    throw new Error(`expected a reschedule, got ${JSON.stringify(result)}`);
  }
  return result.view;
}

/** Everything a reschedule must never edit: the order, its lines and its allocations. */
async function frozen(orderId: string): Promise<string> {
  const rows = (await getAdminSql()`
    SELECT jsonb_build_object(
      'order', (SELECT to_jsonb(o) FROM awcms_commerce_orders o WHERE o.id = ${orderId}),
      'items', (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
                FROM awcms_commerce_order_items i WHERE i.order_id = ${orderId}),
      'allocations', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
                      FROM awcms_commerce_payment_allocations a WHERE a.order_id = ${orderId})
    )::text AS snapshot
  `) as { snapshot: string }[];
  return rows[0]!.snapshot;
}

async function links(orderId: string) {
  return (await getAdminSql()`
    SELECT id, reservation_id, status, supersedes_link_id, order_item_id
    FROM awcms_commerce_booking_reservation_links
    WHERE order_id = ${orderId} ORDER BY created_at, id
  `) as {
    id: string;
    reservation_id: string;
    status: string;
    supersedes_link_id: string | null;
    order_item_id: string;
  }[];
}

async function countRows(table: string, tenantId = TENANT_A): Promise<number> {
  const rows = (await getAdminSql().unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = '${tenantId}'`
  )) as { n: number }[];
  return rows[0]!.n;
}

suite("booking reschedule (Issue #382)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await fx.seedTenant(TENANT_A, "tenant-rs-a", [
      [STAFF, "rs-staff"],
      [MANAGER, "rs-manager"],
      [SERVICE, "rs-service"]
    ]);
    await fx.seedTenant(TENANT_B, "tenant-rs-b", [
      [STAFF_B, "rb-staff"],
      [SERVICE_B, "rb-service"]
    ]);
    await fx.configureTenant(TENANT_A, STAFF, SERVICE);
    await fx.configureTenant(TENANT_B, STAFF_B, SERVICE_B);
  }, 60000);

  // ---------------------------------------------------------------------------
  describe("the order keeps two references (C-38)", () => {
    test("a same-length move supersedes the link, points a new one at the SAME order and line, and edits nothing", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      const before = await frozen(view.orderId);
      const oldStart = await startsAtOf(view.reservationId);

      const result = await resched(view.reservationId, {
        stay: { checkInDate: D(20), checkOutDate: D(22) }
      });
      expect(result.kind).toBe("rescheduled");
      const done = moved(result);

      // The order, its line and its allocations are exactly as they were.
      expect(await frozen(view.orderId)).toBe(before);

      // Both sides moved: commerce's links and Booking's reference.
      const chain = await links(view.orderId);
      expect(chain).toHaveLength(2);
      expect(chain[0]).toMatchObject({
        reservation_id: view.reservationId,
        status: "superseded"
      });
      expect(chain[1]).toMatchObject({
        reservation_id: done.reservation.reservationId,
        status: "active",
        supersedes_link_id: chain[0]!.id
      });
      expect(chain[1]!.order_item_id).toBe(chain[0]!.order_item_id);
      expect(done.reservation.orderId).toBe(view.orderId);
      expect(done.supersededReservationId).toBe(view.reservationId);

      const port = await composedBookingPort();
      const replacement = await inTenant((tx) =>
        port.get(tx, {
          tenantId: TENANT_A,
          reservationId: done.reservation.reservationId
        })
      );
      expect(replacement.ok).toBe(true);
      if (replacement.ok) {
        expect(replacement.reservation.status).toBe("confirmed");
        expect(replacement.reservation.externalRef).toEqual({
          type: "commerce_order",
          id: view.orderId
        });
      }
      expect(await reservationStatus(view.reservationId)).toBe("rescheduled");
      expect(await startsAtOf(done.reservation.reservationId)).toBeGreaterThan(
        oldStart
      );

      // Nothing was priced: no supplement, no return, no leg.
      expect(done.record).toMatchObject({
        direction: "none",
        pricedAmount: "0.00",
        refundAmount: "0.00",
        supplementOrderId: null,
        returnId: null,
        fromNights: 2,
        toNights: 2
      });
      expect(done.supplementOrder).toBeNull();
      expect(await countRows("awcms_commerce_returns")).toBe(0);
      expect(await countRows("awcms_commerce_refunds")).toBe(0);
      expect(await countRows("awcms_commerce_orders")).toBe(1);
    });

    test("one audit row and one domain event carry the evidence, and name no customer", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      const done = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(20), checkOutDate: D(22) },
          reasonCode: "guest_asked"
        })
      );
      const audit = (await auditActions(done.reservation.linkId)).filter(
        (row) => row.action === "commerce.booking_reservation.rescheduled"
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.severity).toBe("warning");
      expect(audit[0]!.attributes).toMatchObject({
        orderId: view.orderId,
        fromReservationId: view.reservationId,
        toReservationId: done.reservation.reservationId,
        direction: "none",
        fromNights: 2,
        toNights: 2,
        reasonCode: "guest_asked",
        actorKind: "staff"
      });
      expect(JSON.stringify(audit[0]!.attributes)).not.toContain("0813");

      const events = (await getAdminSql()`
        SELECT payload, aggregate_id FROM awcms_domain_events
        WHERE tenant_id = ${TENANT_A}
          AND event_type = 'awcms.commerce.booking_reservation.rescheduled'
      `) as { payload: Record<string, unknown>; aggregate_id: string }[];
      expect(events).toHaveLength(1);
      expect(events[0]!.aggregate_id).toBe(view.orderId);
      expect(events[0]!.payload).toMatchObject({
        orderId: view.orderId,
        direction: "none",
        supplementOrderId: null,
        returnId: null
      });
      expect(JSON.stringify(events[0]!.payload)).not.toContain("Budi");
    });

    test("a refusal Booking gives (the new dates are taken) leaves the original untouched on both sides", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      // A second reservation holds the only room on the target dates.
      await book(f, {
        req: { stay: { checkInDate: D(20), checkOutDate: D(22) } }
      });
      const before = await frozen(view.orderId);

      const result = await resched(view.reservationId, {
        stay: { checkInDate: D(20), checkOutDate: D(22) }
      });
      expect(result).toEqual({
        kind: "refused",
        refusal: { code: "BOOKING", reason: "SLOT_UNAVAILABLE" }
      });
      expect(await frozen(view.orderId)).toBe(before);
      expect(await reservationStatus(view.reservationId)).toBe("confirmed");
      const chain = await links(view.orderId);
      expect(chain).toHaveLength(1);
      expect(chain[0]!.status).toBe("active");
      expect(await countRows("awcms_commerce_booking_reschedules")).toBe(0);
    });

    test("a Booking reservation that does not name the order is refused before anything moves", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      await tamperReservation(
        view.reservationId,
        "external_ref = gen_random_uuid()::text"
      );
      const result = await resched(view.reservationId, {
        stay: { checkInDate: D(20), checkOutDate: D(22) }
      });
      expect(result).toEqual({
        kind: "refused",
        refusal: { code: "REFERENCE_MISMATCH" }
      });
      expect(await reservationStatus(view.reservationId)).toBe("confirmed");
      expect(await links(view.orderId)).toHaveLength(1);
    });

    test("refusals decided by reading: not a change, wrong shape for the product, a hold is not moved", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      expect(
        await resched(view.reservationId, {
          stay: { checkInDate: D(10), checkOutDate: D(12) }
        })
      ).toEqual({ kind: "refused", refusal: { code: "NOT_A_CHANGE" } });
      expect(
        await resched(view.reservationId, {
          startsAt: new Date(Date.now() + 70 * 86_400_000).toISOString()
        })
      ).toEqual({
        kind: "refused",
        refusal: { code: "QUANTITY_BASIS_MISMATCH" }
      });

      // An unpaid booking is still a hold: Booking moves a confirmed one only.
      const held = await book(f, {
        req: { stay: { checkInDate: D(30), checkOutDate: D(32) } }
      });
      expect(
        await resched(held.reservationId, {
          stay: { checkInDate: D(35), checkOutDate: D(37) }
        })
      ).toEqual({
        kind: "refused",
        refusal: { code: "INVALID_STATE", reason: "held" }
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe("idempotency (G5)", () => {
    test("the same key and body replays the record; another body under the key is IDEMPOTENCY_CONFLICT", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      const key = "resched-key-1";
      const first = moved(
        await resched(
          view.reservationId,
          { stay: { checkInDate: D(20), checkOutDate: D(22) } },
          { key }
        )
      );
      const again = await resched(
        view.reservationId,
        { stay: { checkInDate: D(20), checkOutDate: D(22) } },
        { key }
      );
      expect(again.kind).toBe("replayed");
      expect(moved(again).record.id).toBe(first.record.id);
      expect(await countRows("awcms_commerce_booking_reschedules")).toBe(1);

      const conflict = await resched(
        view.reservationId,
        { stay: { checkInDate: D(25), checkOutDate: D(27) } },
        { key }
      );
      expect(conflict).toEqual({
        kind: "refused",
        refusal: { code: "IDEMPOTENCY_CONFLICT" }
      });
      expect(await countRows("awcms_commerce_booking_reschedules")).toBe(1);
    });

    test("the stored key names neither the staff member nor the key the client sent", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      await resched(
        view.reservationId,
        { stay: { checkInDate: D(20), checkOutDate: D(22) } },
        { key: "my-secret-client-key" }
      );
      const rows = (await getAdminSql()`
        SELECT client_key FROM awcms_commerce_booking_reschedules
      `) as { client_key: string }[];
      expect(rows[0]!.client_key).toMatch(/^br1:[0-9a-f]{40}:[0-9a-f]{40}$/);
      expect(rows[0]!.client_key).not.toContain("my-secret-client-key");
      expect(rows[0]!.client_key).not.toContain(STAFF);
    });
  });

  // ---------------------------------------------------------------------------
  describe("more nights: a supplementary order, priced by the server (C-39)", () => {
    test("two nights become three: the extra night is an ordinary order at the product price, and the paid order is untouched", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      const before = await frozen(view.orderId);

      const done = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(20), checkOutDate: D(23) }
        })
      );
      expect(await frozen(view.orderId)).toBe(before);
      expect(done.record).toMatchObject({
        direction: "charge",
        fromNights: 2,
        toNights: 3,
        pricedAmount: PRICE,
        refundAmount: "0.00",
        returnId: null
      });
      const supplement = done.supplementOrder!;
      expect(supplement).toMatchObject({
        status: "pending_payment",
        total: PRICE,
        paymentStatus: "unpaid"
      });
      expect(supplement.orderId).not.toBe(view.orderId);
      expect(done.record.supplementOrderId).toBe(supplement.orderId);

      // An ordinary order: one line of the linked product, one night, the same
      // customer as the booking, and no reservation link of its own.
      const lines = (await getAdminSql()`
        SELECT quantity, unit_price FROM awcms_commerce_order_items WHERE order_id = ${supplement.orderId}
      `) as { quantity: number; unit_price: string }[];
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ quantity: 1, unit_price: PRICE });
      const customers = (await getAdminSql()`
        SELECT a.customer_id = b.customer_id AS same
        FROM awcms_commerce_orders a, awcms_commerce_orders b
        WHERE a.id = ${supplement.orderId} AND b.id = ${view.orderId}
      `) as { same: boolean }[];
      expect(customers[0]!.same).toBe(true);
      expect((await links(supplement.orderId)).length).toBe(0);

      // The customer pays it through the ORDINARY payment path (no new flow).
      await pay(supplement.orderId, PRICE);
      expect(await orderStatus(supplement.orderId)).toBe("paid");
      // ...and the booking order's own paid state is unaffected.
      expect(await orderStatus(view.orderId)).toBe("paid");
    });

    test("the price is the server's: it follows the product's CURRENT price, never a figure the request could carry", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      await getAdminSql()`
        UPDATE awcms_commerce_products SET price = '700000.00' WHERE id = ${f.productId}
      `;
      const done = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(20), checkOutDate: D(23) }
        })
      );
      // The extra night is sold at today's cart price; the paid order keeps its snapshot.
      expect(done.supplementOrder!.total).toBe("700000.00");
      expect(done.record.pricedAmount).toBe("700000.00");
    });

    test("a supplement that cannot be sold rolls the whole reschedule back (original on both sides)", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      await getAdminSql()`
        UPDATE awcms_commerce_products SET status = 'archived' WHERE id = ${f.productId}
      `;
      const before = await frozen(view.orderId);
      const result = await resched(view.reservationId, {
        stay: { checkInDate: D(20), checkOutDate: D(23) }
      });
      expect(result).toEqual({
        kind: "refused",
        refusal: { code: "SUPPLEMENT_UNAVAILABLE" }
      });
      expect(await frozen(view.orderId)).toBe(before);
      expect(await reservationStatus(view.reservationId)).toBe("confirmed");
      expect(await links(view.orderId)).toHaveLength(1);
      expect(await countRows("awcms_commerce_orders")).toBe(1);
    });

    test("cancelling afterwards cancels the supplement nobody paid for, and keeps the original policy window", async () => {
      const f = await newFixture();
      const v1 = await policy(f.productId);
      const view = await bookedAndPaid(f);
      const done = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(20), checkOutDate: D(23) }
        })
      );
      const supplementId = done.supplementOrder!.orderId;
      const startsAt = await startsAtOf(view.reservationId);

      const cancelled = await inTenant(async (tx) => {
        const link = (await fetchReservationLinkByReservationId(
          tx,
          TENANT_A,
          done.reservation.reservationId
        ))!;
        return cancelBookingReservation(
          tx,
          {
            tenantId: TENANT_A,
            actor: { kind: "staff", tenantUserId: STAFF },
            correlationId: crypto.randomUUID(),
            port: await composedBookingPort(),
            // 100 hours before the ORIGINAL arrival.
            now: new Date(startsAt - 100 * HOUR)
          },
          {
            link,
            idempotencyKey: nextKey(),
            reasonCode: "guest_request",
            acknowledgedRefund: null,
            override: null
          }
        );
      });
      if (cancelled.kind === "refused") {
        throw new Error(JSON.stringify(cancelled.refusal));
      }
      // 50% of what the MAIN order holds (the supplement is a separate order).
      expect(cancelled.decision).toMatchObject({
        policyId: v1.id,
        amountPaid: "1000000.00",
        computedRefund: "500000.00"
      });
      expect(await orderStatus(supplementId)).toBe("cancelled");
    });
  });

  // ---------------------------------------------------------------------------
  describe("fewer nights: a policy-limited refund from the ORIGINAL arrival (C-37, C-39)", () => {
    test("three nights become two: the value of one night, judged by the original policy, planned as pending legs", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await bookedAndPaid(f, { nights: 3 });
      const startsAt = await startsAtOf(view.reservationId);
      const before = await frozen(view.orderId);

      const done = moved(
        await resched(
          view.reservationId,
          { stay: { checkInDate: D(10), checkOutDate: D(12) } },
          { now: new Date(startsAt - 100 * HOUR) }
        )
      );
      expect(done.record).toMatchObject({
        direction: "refund",
        fromNights: 3,
        toNights: 2,
        pricedAmount: "500000.00",
        // 100 hours before arrival: the 50% window.
        refundAmount: "250000.00",
        policySource: "product",
        policyVersion: 1,
        hoursBeforeStart: 100,
        refundablePercent: "50.00"
      });
      // The return carries the legs; nothing is settled by the reschedule.
      const returnId = done.record.returnId!;
      const legs = await legsOf(returnId);
      expect(legs).toHaveLength(1);
      expect(legs[0]).toMatchObject({ amount: "250000.00", status: "pending" });
      expect(legs[0]!.actor_tenant_user_id).toBe(SERVICE);
      const returns = (await getAdminSql()`
        SELECT kind, status, refund_total FROM awcms_commerce_returns WHERE id = ${returnId}
      `) as Record<string, string>[];
      expect(returns[0]).toMatchObject({
        kind: "cancellation",
        status: "open",
        refund_total: "250000.00"
      });
      const lines = (await getAdminSql()`
        SELECT quantity FROM awcms_commerce_return_lines WHERE return_id = ${returnId}
      `) as { quantity: number }[];
      expect(lines).toEqual([{ quantity: 1 }]);

      // The paid order, its line and its allocations are not edited: the refund
      // is a NEW record. (The order event row is the return's own.)
      const after = JSON.parse(await frozen(view.orderId));
      expect(after).toEqual(JSON.parse(before));
      expect(done.supplementOrder).toBeNull();
      expect(await orderStatus(view.orderId)).toBe("paid");
    });

    test("the policy can give nothing back: the record is written, no return, no leg", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await bookedAndPaid(f, { nights: 3 });
      const startsAt = await startsAtOf(view.reservationId);
      const done = moved(
        await resched(
          view.reservationId,
          { stay: { checkInDate: D(10), checkOutDate: D(12) } },
          { now: new Date(startsAt - 10 * HOUR) }
        )
      );
      expect(done.record).toMatchObject({
        direction: "refund",
        pricedAmount: "500000.00",
        refundAmount: "0.00",
        returnId: null,
        refundablePercent: "0.00"
      });
      expect(await countRows("awcms_commerce_returns")).toBe(0);
      expect(await countRows("awcms_commerce_refunds")).toBe(0);
    });

    test("no policy at all: a shorter stay refunds nothing (D6) and says so in the record", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f, { nights: 3 });
      const done = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(10), checkOutDate: D(12) }
        })
      );
      expect(done.record).toMatchObject({
        direction: "refund",
        policySource: "none",
        policyId: null,
        refundAmount: "0.00",
        returnId: null
      });
    });

    test("a chain of reschedules can NEITHER extend the window NOR change the policy version (C-37)", async () => {
      const f = await newFixture();
      const v1 = await policy(f.productId);
      const view = await bookedAndPaid(f, { nights: 3 });
      const originalStart = await startsAtOf(view.reservationId);

      // Move the whole stay a month later (same length): the new arrival is far away.
      const first = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(40), checkOutDate: D(43) }
        })
      );
      expect(await startsAtOf(first.reservation.reservationId)).toBeGreaterThan(
        originalStart + 20 * 24 * HOUR
      );

      // A generous version is activated AFTER the booking was made.
      await policy(f.productId, [
        { minHoursBeforeStart: 0, refundablePercent: "100.00" }
      ]);

      // 100 hours before the ORIGINAL arrival, shorten by one night: the original
      // 50% window of version 1 applies, not the far-future 100% of the new date.
      const second = moved(
        await resched(
          first.reservation.reservationId,
          { stay: { checkInDate: D(40), checkOutDate: D(42) } },
          { now: new Date(originalStart - 100 * HOUR) }
        )
      );
      expect(second.record).toMatchObject({
        direction: "refund",
        policyId: v1.id,
        hoursBeforeStart: 100,
        refundablePercent: "50.00",
        refundAmount: "250000.00"
      });
      // ...and the cancellation window of the same chain is the same one.
      const links2 = await links(view.orderId);
      expect(links2.map((l) => l.status)).toEqual([
        "superseded",
        "superseded",
        "active"
      ]);
    });

    test("reductions are valued cumulatively: the cents never drift and never exceed the order's worth", async () => {
      const f = await newFixture(TENANT_A, STAFF, { price: "333333.33" });
      await policy(f.productId, [
        { minHoursBeforeStart: 0, refundablePercent: "100.00" }
      ]);
      // 3 nights at 333,333.33 = 999,999.99: not divisible by three.
      const view = await bookedAndPaid(f, { nights: 3, amount: "999999.99" });
      const first = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(10), checkOutDate: D(12) }
        })
      );
      const second = moved(
        await resched(first.reservation.reservationId, {
          stay: { checkInDate: D(10), checkOutDate: D(11) }
        })
      );
      expect(first.record.pricedAmount).toBe("333333.33");
      expect(second.record.pricedAmount).toBe("333333.33");
      // Two of three nights removed in all: floor(99999999 * 2 / 3) cents.
      const cents = (text: string) => Math.round(Number(text) * 100);
      expect(
        cents(first.record.pricedAmount) + cents(second.record.pricedAmount)
      ).toBe(Math.floor((99999999 * 2) / 3));
      expect(
        cents(first.record.refundAmount) + cents(second.record.refundAmount)
      ).toBeLessThanOrEqual(99999999);
    });

    test("an order keeps at least one night, and only a fully paid order is shortened", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await bookedAndPaid(f, { nights: 3 });
      // 3 -> 1 is allowed (room 2); the record can never describe zero nights.
      const once = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(10), checkOutDate: D(11) }
        })
      );
      expect(once.record.toNights).toBe(1);

      // A deposit confirms the booking while 70% is still owed.
      const f2 = await newFixture();
      await policy(f2.productId);
      await inTenant((tx) =>
        setProductDepositPolicy(tx, TENANT_A, STAFF, f2.productId, {
          kind: "percent",
          percent: "30.00"
        })
      );
      const partial = await book(f2, {
        req: {
          stay: { checkInDate: D(10), checkOutDate: D(13) },
          paymentMethod: "dp"
        }
      });
      await pay(partial.orderId, "450000.00");
      await dispatch();
      expect(await reservationStatus(partial.reservationId)).toBe("confirmed");
      const refused = await resched(partial.reservationId, {
        stay: { checkInDate: D(10), checkOutDate: D(12) }
      });
      expect(refused).toEqual({
        kind: "refused",
        refusal: { code: "BALANCE_OUTSTANDING", outstanding: "1050000.00" }
      });
      // A longer stay needs no fully paid order: it is a new order.
      const longer = await resched(partial.reservationId, {
        stay: { checkInDate: D(10), checkOutDate: D(14) }
      });
      expect(longer.kind).toBe("rescheduled");
    });

    test("nights sold on a supplement are not reduced from the main order", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await bookedAndPaid(f, { nights: 2 });
      const longer = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(10), checkOutDate: D(13) }
        })
      );
      // Reservation is 3 nights, the main order sold 2: it can lose one, not two.
      const refused = await resched(longer.reservation.reservationId, {
        stay: { checkInDate: D(10), checkOutDate: D(11) }
      });
      expect(refused).toEqual({
        kind: "refused",
        refusal: { code: "REDUCTION_NOT_SUPPORTED", roomNights: 1 }
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe("a time-slot reservation", () => {
    test("moves to another start with nothing priced, keeps the same order, and refuses a stay body", async () => {
      const f = await newSlotFixture();
      const view = await book(f, {
        req: { stay: null, startsAt: slotAt(10, 5) }
      });
      await pay(view.orderId, PRICE);
      await dispatch();
      expect(await reservationStatus(view.reservationId)).toBe("confirmed");
      const before = await frozen(view.orderId);

      // A slot product is moved with startsAt; a stay body is the wrong shape.
      expect(
        await resched(view.reservationId, {
          stay: { checkInDate: D(20), checkOutDate: D(21) }
        })
      ).toEqual({
        kind: "refused",
        refusal: { code: "QUANTITY_BASIS_MISMATCH" }
      });
      expect(
        await resched(view.reservationId, { startsAt: slotAt(10, 5) })
      ).toEqual({ kind: "refused", refusal: { code: "NOT_A_CHANGE" } });

      const done = moved(
        await resched(view.reservationId, { startsAt: slotAt(12, 8) })
      );
      expect(done.record).toMatchObject({
        direction: "none",
        fromNights: 1,
        toNights: 1,
        pricedAmount: "0.00",
        supplementOrderId: null,
        returnId: null
      });
      expect(done.reservation.orderId).toBe(view.orderId);
      expect(await frozen(view.orderId)).toBe(before);
      expect(await reservationStatus(view.reservationId)).toBe("rescheduled");
      expect(Date.parse(done.reservation.startsAt)).toBe(
        Date.parse(slotAt(12, 8))
      );

      // The panel of a slot booking offers no stay dates.
      const panel = await inTenant((tx) =>
        loadBookingOrderPanel(tx, TENANT_A, view.orderId, {
          canCancel: true,
          canOverride: false,
          canReschedule: true,
          canReadDecision: true
        })
      );
      expect(panel!.stay).toBeNull();
      expect(panel!.nights).toBe(1);
      expect(panel!.canReschedule).toBe(true);
    });

    test("the quote with a resource id reports Booking's availability of the asked slot", async () => {
      const f = await newSlotFixture();
      const view = await book(f, {
        req: { stay: null, startsAt: slotAt(10, 5) }
      });
      await pay(view.orderId, PRICE);
      await dispatch();
      const port = await composedBookingPort();
      const quote = await inTenant(async (tx) => {
        const link = (await fetchReservationLinkByReservationId(
          tx,
          TENANT_A,
          view.reservationId
        ))!;
        return computeRescheduleQuote(
          tx,
          TENANT_A,
          link,
          port,
          mediaLibraryPortAdapter,
          {
            startsAt: slotAt(15, 9),
            stay: null,
            resourceId: f.resourceId
          },
          new Date()
        );
      });
      if (!quote.ok) throw new Error(JSON.stringify(quote.refusal));
      expect(quote.value.quote).toMatchObject({
        direction: "none",
        vehicle: null,
        availability: { available: true }
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe("the quote", () => {
    test("is read-only, equals what the reschedule then writes, and reports availability only for a named resource", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await bookedAndPaid(f, { nights: 3 });
      const startsAt = await startsAtOf(view.reservationId);
      const port = await composedBookingPort();
      const now = new Date(startsAt - 100 * HOUR);
      const stay = { checkInDate: D(10), checkOutDate: D(12) };

      const quoteOf = (resourceId: string | null) =>
        inTenant(async (tx) => {
          const link = (await fetchReservationLinkByReservationId(
            tx,
            TENANT_A,
            view.reservationId
          ))!;
          return computeRescheduleQuote(
            tx,
            TENANT_A,
            link,
            port,
            mediaLibraryPortAdapter,
            { startsAt: null, stay, resourceId },
            now
          );
        });

      const plain = await quoteOf(null);
      if (!plain.ok) throw new Error(JSON.stringify(plain.refusal));
      expect(plain.value.quote).toMatchObject({
        direction: "refund",
        vehicle: "refund_return",
        pricedAmount: "500000.00",
        refundAmount: "250000.00",
        availability: null
      });
      expect(await countRows("awcms_commerce_booking_reschedules")).toBe(0);

      const withResource = await quoteOf(f.resourceId);
      if (!withResource.ok) throw new Error("quote refused");
      expect(withResource.value.quote.availability).not.toBeNull();

      const done = moved(await resched(view.reservationId, { stay }, { now }));
      expect(done.record.refundAmount).toBe(plain.value.quote.refundAmount);
      expect(done.record.pricedAmount).toBe(plain.value.quote.pricedAmount);
    });
  });

  // ---------------------------------------------------------------------------
  describe("serialisation", () => {
    test("a concurrent reschedule and cancel of one booking queue on the order lock: one wins, the other finds its result", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await bookedAndPaid(f);
      const startsAt = await startsAtOf(view.reservationId);

      const cancelNow = () =>
        inTenant(async (tx) => {
          const link = (await fetchReservationLinkByReservationId(
            tx,
            TENANT_A,
            view.reservationId
          ))!;
          return cancelBookingReservation(
            tx,
            {
              tenantId: TENANT_A,
              actor: { kind: "staff", tenantUserId: STAFF },
              correlationId: crypto.randomUUID(),
              port: await composedBookingPort(),
              now: new Date(startsAt - 200 * HOUR)
            },
            {
              link,
              idempotencyKey: nextKey(),
              reasonCode: "guest_request",
              acknowledgedRefund: null,
              override: null
            }
          );
        });

      const [r, c] = await Promise.all([
        resched(view.reservationId, {
          stay: { checkInDate: D(20), checkOutDate: D(22) }
        }),
        cancelNow()
      ]);
      const reschedWon = r.kind === "rescheduled";
      const cancelWon = c.kind === "cancelled";
      // Exactly one of them won; the other was refused with INVALID_STATE.
      expect(reschedWon !== cancelWon).toBe(true);
      if (reschedWon) {
        expect(c).toMatchObject({
          kind: "refused",
          refusal: { code: "INVALID_STATE" }
        });
        // The cancel resolved the OLD (superseded) link: nothing was cancelled.
        expect(await reservationStatus(view.reservationId)).toBe("rescheduled");
        expect((await links(view.orderId)).map((l) => l.status)).toEqual([
          "superseded",
          "active"
        ]);
      } else {
        expect(r).toMatchObject({
          kind: "refused",
          refusal: { code: "INVALID_STATE" }
        });
        expect(await reservationStatus(view.reservationId)).toBe("cancelled");
        expect(await countRows("awcms_commerce_booking_reschedules")).toBe(0);
      }
      // Never both, never neither: the order has exactly one live reference or none.
      const live = (await links(view.orderId)).filter(
        (l) => l.status === "active"
      );
      expect(live.length).toBe(reschedWon ? 1 : 0);
    });

    test("two concurrent requests under one key produce one record", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      const key = "resched-concurrent";
      const stay = { checkInDate: D(20), checkOutDate: D(22) };
      const [a, b] = await Promise.all([
        resched(view.reservationId, { stay }, { key }),
        resched(view.reservationId, { stay }, { key })
      ]);
      expect([a.kind, b.kind].sort()).toEqual(["replayed", "rescheduled"]);
      expect(await countRows("awcms_commerce_booking_reschedules")).toBe(1);
      expect(await links(view.orderId)).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  describe("the record is append-only and tenant-scoped", () => {
    test("no UPDATE (a trigger, even for the owner) and no DELETE for the application role; the CHECKs hold", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await bookedAndPaid(f, { nights: 3 });
      const done = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(10), checkOutDate: D(12) }
        })
      );
      const id = done.record.id;
      const admin = getAdminSql();
      expect(
        await attemptSql(
          admin`UPDATE awcms_commerce_booking_reschedules SET priced_amount = 1 WHERE id = ${id}`
        )
      ).toContain("append-only");
      expect(
        await attemptSql(
          getAppRoleSql()`DELETE FROM awcms_commerce_booking_reschedules WHERE id = ${id}`
        )
      ).toContain("permission denied");
      expect(
        await attemptSql(
          getAppRoleSql()`UPDATE awcms_commerce_booking_reschedules SET created_at = now() WHERE id = ${id}`
        )
      ).toContain("permission denied");

      // A refund above the price of what was removed is refused by the table itself (C-39).
      const link = (await links(view.orderId))[0]!;
      const insertWith = (priced: string, refund: string) =>
        attemptSql(admin`
          INSERT INTO awcms_commerce_booking_reschedules (
            tenant_id, order_id, from_link_id, to_link_id, from_nights, to_nights,
            difference_direction, priced_amount, refund_amount, policy_source,
            hours_before_start, refundable_percent, actor_tenant_user_id,
            client_key, request_hash)
          VALUES (${TENANT_A}, ${view.orderId}, ${link.id}, ${link.id}, 3, 2,
                  'refund', ${priced}, ${refund}, 'none', 1, 0, ${STAFF}, 'k', 'h')
        `);
      expect(await insertWith("100.00", "100.01")).toContain("amounts_check");
    });

    test("tenant B sees none of tenant A's reschedules (RLS)", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      await resched(view.reservationId, {
        stay: { checkInDate: D(20), checkOutDate: D(22) }
      });
      const seen = await inTenant(
        (tx) =>
          tx`SELECT count(*)::int AS n FROM awcms_commerce_booking_reschedules`,
        TENANT_B
      );
      expect((seen as { n: number }[])[0]!.n).toBe(0);
      const own = await inTenant((tx) =>
        listReschedulesForOrder(tx, TENANT_A, view.orderId)
      );
      expect(own).toHaveLength(1);
      // Another tenant cannot name tenant A's order either.
      const other = await inTenant(
        (tx) => listReschedulesForOrder(tx, TENANT_B, view.orderId),
        TENANT_B
      );
      expect(other).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe("the reconciler consumer and the reconciliation report", () => {
    test("a reschedule made in Booking's own screen is repaired to TWO references and flagged for an operator", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      const port = await composedBookingPort();
      const outsider = await inTenant((tx) =>
        port.reschedule(tx, {
          tenantId: TENANT_A,
          reservationId: view.reservationId,
          stay: { checkInDate: D(20), checkOutDate: D(22) },
          idempotencyKey: "outside-1",
          correlationId: crypto.randomUUID(),
          actorTenantUserId: STAFF
        })
      );
      if (!outsider.ok) throw new Error(`refused: ${outsider.reason}`);

      // Before the consumer runs, the report lists the order with one reference.
      const drift = await inTenant((tx) =>
        reconcileBookingOrders(tx, TENANT_A, 50)
      );
      expect(drift.items.map((i) => i.kind)).toContain("commerce_link_missing");

      await dispatch();
      const chain = await links(view.orderId);
      expect(chain.map((l) => l.status)).toEqual(["superseded", "active"]);
      expect(chain[1]).toMatchObject({
        reservation_id: outsider.reservationId,
        supersedes_link_id: chain[0]!.id
      });
      const flagged = (await getAdminSql()`
        SELECT attention_reason FROM awcms_commerce_booking_reservation_links
        WHERE id = ${chain[1]!.id}
      `) as { attention_reason: string | null }[];
      expect(flagged[0]!.attention_reason).toBe("rescheduled_externally");
      const after = await inTenant((tx) =>
        reconcileBookingOrders(tx, TENANT_A, 50)
      );
      expect(
        after.items.filter((i) => i.kind === "commerce_link_missing")
      ).toHaveLength(0);
    });

    test("a reschedule made THROUGH the adapter leaves the consumer nothing to do and raises no flag", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(20), checkOutDate: D(22) }
        })
      );
      await dispatch();
      const chain = await links(view.orderId);
      expect(chain).toHaveLength(2);
      const flags = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_booking_reservation_links
        WHERE order_id = ${view.orderId} AND attention_reason IS NOT NULL
      `) as { n: number }[];
      expect(flags[0]!.n).toBe(0);
      const drift = await inTenant((tx) =>
        reconcileBookingOrders(tx, TENANT_A, 50)
      );
      expect(drift.items).toEqual([]);
    });

    test("the report lists a reference Booking lost, and a supplement nobody paid while the longer stay is live", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      const done = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(20), checkOutDate: D(23) }
        })
      );
      // The supplement lapses unpaid while the longer stay stays confirmed.
      await getAdminSql()`
        UPDATE awcms_commerce_orders SET status = 'expired'
        WHERE id = ${done.supplementOrder!.orderId}
      `;
      const unpaid = await inTenant((tx) =>
        reconcileBookingOrders(tx, TENANT_A, 50)
      );
      expect(unpaid.items.map((i) => i.kind)).toEqual([
        "reschedule_difference_unpaid"
      ]);

      await tamperReservation(
        done.reservation.reservationId,
        "external_ref = NULL, external_ref_type = NULL"
      );
      const lost = await inTenant((tx) =>
        reconcileBookingOrders(tx, TENANT_A, 50)
      );
      expect(lost.items.map((i) => i.kind).sort()).toEqual([
        "booking_reference_missing",
        "reschedule_difference_unpaid"
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  describe("the booking panel of the order detail", () => {
    const caps = {
      canCancel: true,
      canOverride: false,
      canReschedule: true,
      canReadDecision: true
    };
    const panelOf = (
      orderId: string,
      overrides: Partial<typeof caps> = {},
      now?: Date
    ) =>
      inTenant((tx) =>
        loadBookingOrderPanel(
          tx,
          TENANT_A,
          orderId,
          { ...caps, ...overrides },
          now
        )
      );

    test("a confirmed future booking offers the reschedule, shows its stay and the server's clock, and no no-show yet", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await bookedAndPaid(f);
      const now = new Date("2026-11-01T03:00:00.000Z");
      const panel = (await panelOf(view.orderId, {}, now))!;
      expect(panel.canReschedule).toBe(true);
      expect(panel.canNoShow).toBe(false);
      expect(panel.noShow).toBeNull();
      expect(panel.nights).toBe(2);
      expect(panel.stay).toEqual({
        checkInDate: D(10),
        checkOutDate: D(12)
      });
      expect(panel.reschedules).toEqual([]);
      expect(panel.serverNow).toBe("2026-11-01T03:00:00.000Z");
      // Without the update key the control is not offered.
      expect(
        (await panelOf(view.orderId, { canReschedule: false }))!.canReschedule
      ).toBe(false);
    });

    test("after a longer-stay reschedule the panel lists it with the extra order and shows the new reservation", async () => {
      const f = await newFixture();
      const view = await bookedAndPaid(f);
      const done = moved(
        await resched(view.reservationId, {
          stay: { checkInDate: D(20), checkOutDate: D(23) }
        })
      );
      const panel = (await panelOf(view.orderId))!;
      expect(panel.reservation.reservationId).toBe(
        done.reservation.reservationId
      );
      expect(panel.nights).toBe(3);
      expect(panel.stay).toEqual({ checkInDate: D(20), checkOutDate: D(23) });
      expect(panel.reschedules).toHaveLength(1);
      expect(panel.reschedules[0]).toMatchObject({
        direction: "charge",
        fromNights: 2,
        toNights: 3,
        pricedAmount: PRICE
      });
      expect(panel.reschedules[0]!.supplementOrder).toMatchObject({
        orderCode: done.supplementOrder!.orderCode,
        status: "pending_payment",
        total: PRICE
      });
    });

    test("once the arrival has passed the panel previews what a no-show retains, only for a viewer who may cancel; after it the decision shows and nothing more is offered", async () => {
      const f = await newFixture();
      await policy(f.productId, undefined, { retention: "retain_all" });
      const view = await bookedAndPaid(f);
      await arrivedHoursAgo(view.reservationId, 3);

      const panel = (await panelOf(view.orderId))!;
      expect(panel.canNoShow).toBe(true);
      expect(panel.canReschedule).toBe(true);
      expect(panel.noShow).toMatchObject({
        retentionRule: "retain_all",
        amountPaid: "1000000.00",
        retainedAmount: "1000000.00",
        notRetainedAmount: "0.00"
      });
      expect(panel.noShow!.hoursBeforeStart).toBeLessThan(0);
      const readOnly = (await panelOf(view.orderId, { canCancel: false }))!;
      expect(readOnly.canNoShow).toBe(false);
      expect(readOnly.noShow).toBeNull();

      const marked = await inTenant(async (tx) => {
        const link = (await fetchReservationLinkByReservationId(
          tx,
          TENANT_A,
          view.reservationId
        ))!;
        return recordBookingNoShow(
          tx,
          {
            tenantId: TENANT_A,
            actor: { kind: "staff", tenantUserId: STAFF },
            correlationId: crypto.randomUUID(),
            port: await composedBookingPort()
          },
          {
            link,
            idempotencyKey: nextKey(),
            reasonCode: "guest_did_not_arrive"
          }
        );
      });
      expect(marked.kind).toBe("marked");
      const after = (await panelOf(view.orderId))!;
      expect(after.decision).toMatchObject({
        triggerKind: "no_show",
        retainedAmount: "1000000.00",
        finalRefund: "0.00"
      });
      expect(after.canReschedule).toBe(false);
      expect(after.canNoShow).toBe(false);
      expect(after.quote).toBeNull();
      expect(after.legs).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  test("a rescheduled booking has no decision on its new link until it is cancelled or marked no-show", async () => {
    const f = await newFixture();
    const view = await bookedAndPaid(f);
    const done = moved(
      await resched(view.reservationId, {
        stay: { checkInDate: D(20), checkOutDate: D(22) }
      })
    );
    const decision = await inTenant((tx) =>
      fetchDecisionForLink(tx, TENANT_A, done.reservation.linkId)
    );
    expect(decision).toBeNull();
  });
});
