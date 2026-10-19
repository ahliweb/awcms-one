/**
 * Booking no-show against a REAL migrated PostgreSQL (Issue #382, ADR-0045 D15,
 * contracts 3.8; threat control C-41). World 1 of `harness.ts`: the application
 * functions are called with the `awcms_app` runtime pool and the REAL composed
 * `BookingPort`; domain events are dispatched through the real consumer registry.
 * The wiring (permissions, the strict body, the persona table) is proved through
 * the real handlers in `commerce-booking-reschedule-routes.integration.test.ts`.
 *
 * What only a database can prove:
 *
 *   - a no-show retains by the `no_show_retention` rule of the policy version in
 *     force WHEN THE BOOKING WAS MADE (a later version never changes it), for all
 *     three rules and for a booking made while no policy applied;
 *   - it creates NO refund leg: no return, no refund row, the decision's refunds
 *     are zero, the paid order is not edited - and the database stops a no-show
 *     decision from ever receiving a return or a positive refund;
 *   - Booking decides "too early" (arrival plus the grace): the refusal keeps its
 *     code and writes nothing;
 *   - the audit row and the event carry the amount paid, the amount retained, the
 *     rule and the policy version;
 *   - idempotency, and serialisation with a concurrent cancel;
 *   - a no-show a person marked in Booking's own screen is recorded by the
 *     `commerce.booking_no_show_decision_recorder` consumer as the system, and a
 *     no-show made through the adapter is not recorded twice.
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
import { setProductDepositPolicy } from "../../src/modules/commerce/application/booking-deposit-policies";
import { cancelBookingReservation } from "../../src/modules/commerce/application/booking-cancellation";
import {
  computeNoShowPreview,
  recordBookingNoShow,
  type NoShowResult
} from "../../src/modules/commerce/application/booking-no-show";
import { fetchReservationLinkByReservationId } from "../../src/modules/commerce/application/booking-reservation-links";
import { DEFAULT_NO_SHOW_REASON_CODE } from "../../src/modules/commerce/domain/booking-no-show";
import { createAdapterFixtures } from "./booking-adapter-fixtures";
import {
  getAdminSql,
  getAppRoleSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "38200000-0382-4000-8000-0000000000a1";
const TENANT_B = "38200000-0382-4000-8000-0000000000a2";
const STAFF = "38200000-0382-4000-8000-0000000000c1";
const MANAGER = "38200000-0382-4000-8000-0000000000c2";
const SERVICE = "38200000-0382-4000-8000-0000000000c3";
const STAFF_B = "38200000-0382-4000-8000-0000000000c4";
const SERVICE_B = "38200000-0382-4000-8000-0000000000c5";

const fx = createAdapterFixtures({
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  staff: STAFF,
  manager: MANAGER,
  service: SERVICE,
  staffB: STAFF_B,
  serviceB: SERVICE_B,
  keyPrefix: "n382"
});
const {
  inTenant,
  newFixture,
  book,
  pay,
  bookedAndPaid,
  dispatch,
  reservationStatus,
  orderStatus,
  policy,
  auditActions,
  attemptSql,
  arrivedHoursAgo,
  nextKey
} = fx;

async function noShow(
  reservationId: string,
  options: { key?: string; reasonCode?: string; now?: Date } = {}
): Promise<NoShowResult> {
  return inTenant(async (tx) => {
    const link = await fetchReservationLinkByReservationId(
      tx,
      TENANT_A,
      reservationId
    );
    if (!link) throw new Error("no link");
    return recordBookingNoShow(
      tx,
      {
        tenantId: TENANT_A,
        actor: { kind: "staff", tenantUserId: STAFF },
        correlationId: crypto.randomUUID(),
        port: await composedBookingPort(),
        ...(options.now ? { now: options.now } : {})
      },
      {
        link,
        idempotencyKey: options.key ?? nextKey(),
        reasonCode: options.reasonCode ?? DEFAULT_NO_SHOW_REASON_CODE
      }
    );
  });
}

function marked(result: NoShowResult) {
  if (result.kind === "refused") {
    throw new Error(`expected a no-show, got ${JSON.stringify(result)}`);
  }
  return result.decision;
}

async function counts() {
  const rows = (await getAdminSql()`
    SELECT
      (SELECT count(*)::int FROM awcms_commerce_returns WHERE tenant_id = ${TENANT_A}) AS returns,
      (SELECT count(*)::int FROM awcms_commerce_refunds WHERE tenant_id = ${TENANT_A}) AS refunds,
      (SELECT count(*)::int FROM awcms_commerce_booking_refund_decisions WHERE tenant_id = ${TENANT_A}) AS decisions
  `) as { returns: number; refunds: number; decisions: number }[];
  return rows[0]!;
}

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

/** A confirmed, paid reservation whose arrival (plus the 15-minute grace) has passed. */
async function arrived(
  f: Awaited<ReturnType<typeof newFixture>>,
  options: { nights?: number; amount?: string } = {}
) {
  const view = await bookedAndPaid(f, options);
  await arrivedHoursAgo(view.reservationId, 3);
  return view;
}

suite("booking no-show (Issue #382)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await fx.seedTenant(TENANT_A, "tenant-ns-a", [
      [STAFF, "ns-staff"],
      [MANAGER, "ns-manager"],
      [SERVICE, "ns-service"]
    ]);
    await fx.seedTenant(TENANT_B, "tenant-ns-b", [
      [STAFF_B, "nb-staff"],
      [SERVICE_B, "nb-service"]
    ]);
    await fx.configureTenant(TENANT_A, STAFF, SERVICE);
    await fx.configureTenant(TENANT_B, STAFF_B, SERVICE_B);
  }, 60000);

  // ---------------------------------------------------------------------------
  describe("retention by the ORIGINAL policy version", () => {
    test("retain_deposit keeps the deposit and reports the rest as not retained; no money moves", async () => {
      const f = await newFixture();
      await policy(f.productId, undefined, { retention: "retain_deposit" });
      await inTenant((tx) =>
        setProductDepositPolicy(tx, TENANT_A, STAFF, f.productId, {
          kind: "percent",
          percent: "30.00"
        })
      );
      const view = await book(f, { req: { paymentMethod: "dp" } });
      await pay(view.orderId, "300000.00");
      await dispatch();
      await pay(view.orderId, "700000.00");
      await arrivedHoursAgo(view.reservationId, 3);
      const before = await frozen(view.orderId);

      const decision = marked(await noShow(view.reservationId));
      expect(decision).toMatchObject({
        triggerKind: "no_show",
        actorKind: "staff",
        amountPaid: "1000000.00",
        computedRefund: "0.00",
        finalRefund: "0.00",
        overridden: false,
        retainedAmount: "300000.00",
        returnId: null,
        policySource: "product",
        policyVersion: 1
      });
      expect(await counts()).toEqual({ returns: 0, refunds: 0, decisions: 1 });
      expect(await frozen(view.orderId)).toBe(before);
      expect(await reservationStatus(view.reservationId)).toBe("no_show");

      const audit = (await auditActions(decision.reservationLinkId)).filter(
        (row) => row.action === "commerce.booking_reservation.no_show"
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.attributes).toMatchObject({
        orderId: view.orderId,
        amountPaid: "1000000.00",
        retainedAmount: "300000.00",
        notRetainedAmount: "700000.00",
        retentionRule: "retain_deposit",
        policySource: "product",
        policyVersion: 1,
        refundAmount: "0.00",
        actorKind: "staff"
      });
    });

    test("retain_deposit on an order paid in full retains the whole total (the deposit IS the total)", async () => {
      const f = await newFixture();
      await policy(f.productId, undefined, { retention: "retain_deposit" });
      const view = await arrived(f);
      const decision = marked(await noShow(view.reservationId));
      expect(decision).toMatchObject({
        amountPaid: "1000000.00",
        retainedAmount: "1000000.00",
        finalRefund: "0.00"
      });
    });

    test("retain_all keeps everything paid", async () => {
      const f = await newFixture();
      await policy(f.productId, undefined, { retention: "retain_all" });
      const view = await arrived(f);
      const decision = marked(await noShow(view.reservationId));
      expect(decision).toMatchObject({
        retainedAmount: "1000000.00",
        finalRefund: "0.00",
        returnId: null
      });
    });

    test("refund_per_windows evaluates the windows at the no-show instant, which is after arrival: nothing comes back", async () => {
      const f = await newFixture();
      await policy(f.productId, undefined, { retention: "refund_per_windows" });
      const view = await arrived(f);
      const decision = marked(await noShow(view.reservationId));
      expect(decision).toMatchObject({
        retainedAmount: "1000000.00",
        computedRefund: "0.00",
        finalRefund: "0.00"
      });
      expect(await counts()).toEqual({ returns: 0, refunds: 0, decisions: 1 });
    });

    test("a booking made while no policy applied keeps everything paid and says so (D6, fail closed)", async () => {
      const f = await newFixture();
      const view = await arrived(f);
      const decision = marked(await noShow(view.reservationId));
      expect(decision).toMatchObject({
        policySource: "none",
        policyId: null,
        policyVersion: null,
        retainedAmount: "1000000.00",
        finalRefund: "0.00"
      });
    });

    test("a policy version activated AFTER the booking never changes what it retains", async () => {
      const f = await newFixture();
      const v1 = await policy(f.productId, undefined, {
        retention: "retain_deposit"
      });
      await inTenant((tx) =>
        setProductDepositPolicy(tx, TENANT_A, STAFF, f.productId, {
          kind: "percent",
          percent: "30.00"
        })
      );
      const view = await book(f, { req: { paymentMethod: "dp" } });
      await pay(view.orderId, "300000.00");
      await dispatch();
      await pay(view.orderId, "700000.00");
      await arrivedHoursAgo(view.reservationId, 3);
      // The business later switches to keeping everything.
      await policy(f.productId, undefined, { retention: "retain_all" });

      const decision = marked(await noShow(view.reservationId));
      expect(decision).toMatchObject({
        policyId: v1.id,
        policyVersion: 1,
        retainedAmount: "300000.00"
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe("Booking decides when (NO_SHOW_TOO_EARLY)", () => {
    test("before arrival plus the grace the refusal keeps Booking's code and nothing is written", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await bookedAndPaid(f);
      const before = await frozen(view.orderId);
      const result = await noShow(view.reservationId);
      expect(result).toEqual({
        kind: "refused",
        refusal: { code: "BOOKING", reason: "NO_SHOW_TOO_EARLY" }
      });
      expect(await counts()).toEqual({ returns: 0, refunds: 0, decisions: 0 });
      expect(await reservationStatus(view.reservationId)).toBe("confirmed");
      const link = await inTenant((tx) =>
        fetchReservationLinkByReservationId(tx, TENANT_A, view.reservationId)
      );
      expect(link!.status).toBe("active");
      expect(await frozen(view.orderId)).toBe(before);
    });

    test("only a confirmed reservation can be marked: a hold is INVALID_STATE", async () => {
      const f = await newFixture();
      const view = await book(f);
      await arrivedHoursAgo(view.reservationId, 3);
      expect(await noShow(view.reservationId)).toEqual({
        kind: "refused",
        refusal: { code: "INVALID_STATE", reason: "held" }
      });
    });

    test("the preview is read-only and carries the same figure the decision then records", async () => {
      const f = await newFixture();
      await policy(f.productId, undefined, { retention: "retain_all" });
      const view = await arrived(f);
      const port = await composedBookingPort();
      const preview = await inTenant(async (tx) => {
        const link = (await fetchReservationLinkByReservationId(
          tx,
          TENANT_A,
          view.reservationId
        ))!;
        return computeNoShowPreview(tx, TENANT_A, link, port, {
          now: new Date(),
          expectStatus: "confirmed"
        });
      });
      if (!preview.ok) throw new Error(JSON.stringify(preview.refusal));
      expect(preview.value.preview).toMatchObject({
        retentionRule: "retain_all",
        amountPaid: "1000000.00",
        retainedAmount: "1000000.00",
        notRetainedAmount: "0.00"
      });
      expect(preview.value.preview.hoursBeforeStart).toBeLessThan(0);
      expect((await counts()).decisions).toBe(0);
      const decision = marked(await noShow(view.reservationId));
      expect(decision.retainedAmount).toBe(
        preview.value.preview.retainedAmount
      );
    });
  });

  // ---------------------------------------------------------------------------
  describe("no refund leg can exist (C-41)", () => {
    test("the database refuses a return on a no-show decision, a positive refund, and any edit", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await arrived(f);
      const decision = marked(await noShow(view.reservationId));
      const admin = getAdminSql();

      // A return, even the owner's: the guard trigger.
      const stray = (await admin`
        INSERT INTO awcms_commerce_returns (
          tenant_id, order_id, kind, status, goods_gross, refund_total, source_key, actor_tenant_user_id)
        VALUES (${TENANT_A}, ${view.orderId}, 'cancellation', 'open', 1, 1, 'stray', ${SERVICE})
        RETURNING id
      `) as { id: string }[];
      expect(
        await attemptSql(
          admin`UPDATE awcms_commerce_booking_refund_decisions SET return_id = ${stray[0]!.id} WHERE id = ${decision.id}`
        )
      ).toContain("a no-show retains and creates no refund leg");
      // The application role cannot edit the decision at all.
      expect(
        await attemptSql(
          getAppRoleSql()`UPDATE awcms_commerce_booking_refund_decisions SET final_refund = 1 WHERE id = ${decision.id}`
        )
      ).toContain("permission denied");

      // A no-show row with a positive refund or no retained amount cannot be inserted.
      const insert = (computed: string, retained: string | null) =>
        attemptSql(admin`
          INSERT INTO awcms_commerce_booking_refund_decisions (
            tenant_id, order_id, reservation_link_id, trigger_kind, actor_kind,
            actor_tenant_user_id, policy_source, hours_before_start, refundable_percent,
            amount_paid, computed_refund, final_refund, retained_amount, source_key)
          SELECT ${TENANT_A}, order_id, id, 'no_show', 'staff', ${STAFF}, 'none', -1, 0,
                 1000000, ${computed}, ${computed}, ${retained}, ${`x-${computed}-${retained}`}
          FROM awcms_commerce_booking_reservation_links WHERE order_id = ${view.orderId}
        `);
      expect(await insert("1.00", "999999.00")).toContain("no_show_check");
      expect(await insert("0", null)).toContain("no_show_check");
      expect(await insert("0", "1000001.00")).toContain("no_show_check");
    });

    test("a cancellation decision never carries a retained amount", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await bookedAndPaid(f);
      const cancelled = await inTenant(async (tx) => {
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
            port: await composedBookingPort()
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
      if (cancelled.kind === "refused") throw new Error("refused");
      expect(cancelled.decision.retainedAmount).toBeNull();
      expect(cancelled.decision.triggerKind).toBe("staff_cancel");
    });
  });

  // ---------------------------------------------------------------------------
  describe("idempotency and serialisation", () => {
    test("the same key and body replays the decision; another body is IDEMPOTENCY_CONFLICT; a new key on a decided reservation is INVALID_STATE", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await arrived(f);
      const key = "no-show-key-1";
      const first = marked(await noShow(view.reservationId, { key }));
      const again = await noShow(view.reservationId, { key });
      expect(again.kind).toBe("replayed");
      expect(marked(again).id).toBe(first.id);
      expect(
        await noShow(view.reservationId, { key, reasonCode: "other_reason" })
      ).toEqual({ kind: "refused", refusal: { code: "IDEMPOTENCY_CONFLICT" } });
      expect(await noShow(view.reservationId)).toEqual({
        kind: "refused",
        refusal: { code: "INVALID_STATE", reason: "released" }
      });
      expect((await counts()).decisions).toBe(1);
    });

    test("a concurrent no-show and cancel queue on the order lock: one decision, never two", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await arrived(f);
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
              port: await composedBookingPort()
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
      const [n, c] = await Promise.all([
        noShow(view.reservationId),
        cancelNow()
      ]);
      expect(
        [n.kind === "marked", c.kind === "cancelled"].filter(Boolean)
      ).toHaveLength(1);
      expect((await counts()).decisions).toBe(1);
      // A no-show leaves no refund; a cancel after arrival refunds nothing either.
      expect((await counts()).refunds).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe("the decision recorder consumer", () => {
    test("a no-show a person marked in Booking's own screen is recorded as the system, with no refund leg", async () => {
      const f = await newFixture();
      await policy(f.productId, undefined, { retention: "retain_all" });
      const view = await arrived(f);
      const port = await composedBookingPort();
      const outside = await inTenant((tx) =>
        port.markNoShow(tx, {
          tenantId: TENANT_A,
          reservationId: view.reservationId,
          idempotencyKey: "outside-ns-1",
          correlationId: crypto.randomUUID(),
          actorTenantUserId: STAFF
        })
      );
      expect(outside.ok).toBe(true);
      expect((await counts()).decisions).toBe(0);

      await dispatch();
      const rows = (await getAdminSql()`
        SELECT trigger_kind, actor_kind, actor_tenant_user_id, retained_amount,
               final_refund, return_id
        FROM awcms_commerce_booking_refund_decisions WHERE tenant_id = ${TENANT_A}
      `) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        trigger_kind: "no_show",
        actor_kind: "system",
        actor_tenant_user_id: null,
        retained_amount: "1000000.00",
        return_id: null
      });
      expect(Number(rows[0]!.final_refund)).toBe(0);
      expect(await counts()).toMatchObject({ returns: 0, refunds: 0 });
      const link = await inTenant((tx) =>
        fetchReservationLinkByReservationId(tx, TENANT_A, view.reservationId)
      );
      expect(link!.status).toBe("released");
    });

    test("a no-show made THROUGH the adapter is not recorded a second time", async () => {
      const f = await newFixture();
      await policy(f.productId);
      const view = await arrived(f);
      marked(await noShow(view.reservationId));
      await dispatch();
      await dispatch();
      expect((await counts()).decisions).toBe(1);
      expect(await orderStatus(view.orderId)).toBe("paid");
    });
  });

  // ---------------------------------------------------------------------------
  test("a decision is tenant-scoped: tenant B sees none of tenant A's (RLS)", async () => {
    const f = await newFixture();
    await policy(f.productId);
    const view = await arrived(f);
    marked(await noShow(view.reservationId));
    const seen = await inTenant(
      (tx) =>
        tx`SELECT count(*)::int AS n FROM awcms_commerce_booking_refund_decisions`,
      TENANT_B
    );
    expect((seen as { n: number }[])[0]!.n).toBe(0);
  });
});
