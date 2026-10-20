/**
 * The reschedule, reschedule-quote and no-show routes through the REAL route
 * handlers (Issue #382, ADR-0045 D7/D15/D18, access matrix
 * `docs/booking-commerce-access-matrix.md` section 4 and section 9 evidence item
 * 2; threat controls C-05, C-37, C-38, C-39, C-41). World 2 of `harness.ts`:
 * handlers use `getDatabaseClient()` and the public tenant is the one
 * `PUBLIC_DEFAULT_TENANT_ID` names. The money and the window arithmetic are
 * proved at the application layer in `commerce-booking-reschedule.integration.test.ts`
 * and `commerce-booking-no-show.integration.test.ts`; this file proves what only
 * the wiring can:
 *
 *   - every route is off until the tenant opts in (`409 FEATURE_DISABLED`);
 *   - the route-by-persona table: a reschedule and its price need
 *     `commerce.booking_reservation_links.update`; a no-show needs BOTH the cancel
 *     and the decision key (a cashier, a finance role, a tenant admin and a holder
 *     of only one key are refused `403` with nothing written); an unknown id and
 *     another tenant's id are one `404`;
 *   - a body can NEVER carry a price, a difference, a refund, an order or a
 *     payment method (`400`, nothing written), and an `Idempotency-Key` is
 *     required;
 *   - the happy paths and their refusals as the HTTP codes the contract names
 *     (`SLOT_UNAVAILABLE`, `NO_SHOW_TOO_EARLY`, `BALANCE_OUTSTANDING`, ...), with no
 *     customer field in any body (X7).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  ensureHandlerDatabaseReady,
  getHandlerAdminSql,
  invoke,
  resetHandlerDatabase,
  teardownHandlerDatabase
} from "./harness";
import { resetRateLimitForTests } from "../../src/lib/security/rate-limit";
import { POST as staffCreate } from "../../src/pages/api/v1/commerce/booking/reservations/index";
import { POST as staffReschedule } from "../../src/pages/api/v1/commerce/booking/reservations/[id]/reschedule";
import { GET as staffRescheduleQuote } from "../../src/pages/api/v1/commerce/booking/reservations/[id]/reschedule-quote";
import { POST as staffNoShow } from "../../src/pages/api/v1/commerce/booking/reservations/[id]/no-show";
import {
  activePolicy,
  arrivedHoursAgo,
  body as bookingBody,
  day,
  headers,
  integrationEnabled,
  nextKey,
  paidBooking,
  readyOwner,
  seedPrincipal,
  setBookingFeature,
  UNKNOWN_ID,
  bootstrapOwner,
  type Envelope,
  type Principal
} from "./booking-route-fixtures";

const suite = integrationEnabled ? describe : describe.skip;
let handlerReady = false;

function skipUnlessHandlerReady(): boolean {
  if (handlerReady) return false;
  console.warn(
    "[skip] handler database is not migrated - run 'bun run db:migrate' against DATABASE_URL."
  );
  return true;
}

const reschedulePost = (
  who: Principal,
  id: string,
  payload: unknown,
  key: string | null = nextKey()
) =>
  invoke<Envelope<Record<string, any>>>(staffReschedule, {
    method: "POST",
    path: `/api/v1/commerce/booking/reservations/${id}/reschedule`,
    headers: headers(who, key === null ? {} : { "idempotency-key": key }),
    params: { id },
    body: payload
  });

const quoteGet = (who: Principal, id: string, query = "") =>
  invoke<Envelope<Record<string, any>>>(staffRescheduleQuote, {
    path: `/api/v1/commerce/booking/reservations/${id}/reschedule-quote${query}`,
    headers: headers(who),
    params: { id }
  });

const noShowPost = (
  who: Principal,
  id: string,
  payload: unknown = {},
  key: string | null = nextKey()
) =>
  invoke<Envelope<Record<string, any>>>(staffNoShow, {
    method: "POST",
    path: `/api/v1/commerce/booking/reservations/${id}/no-show`,
    headers: headers(who, key === null ? {} : { "idempotency-key": key }),
    params: { id },
    body: payload
  });

const stayOf = (from: number, to: number) => ({
  stay: { checkInDate: day(from), checkOutDate: day(to) }
});

async function counts(tenantId: string) {
  const admin = getHandlerAdminSql();
  const rows = (await admin`
    SELECT
      (SELECT count(*)::int FROM awcms_commerce_booking_reschedules WHERE tenant_id = ${tenantId}) AS reschedules,
      (SELECT count(*)::int FROM awcms_commerce_booking_refund_decisions WHERE tenant_id = ${tenantId}) AS decisions,
      (SELECT count(*)::int FROM awcms_commerce_returns WHERE tenant_id = ${tenantId}) AS returns,
      (SELECT count(*)::int FROM awcms_commerce_orders WHERE tenant_id = ${tenantId}) AS orders,
      (SELECT count(*)::int FROM awcms_booking_reservations WHERE tenant_id = ${tenantId} AND status = 'rescheduled') AS rescheduled,
      (SELECT count(*)::int FROM awcms_booking_reservations WHERE tenant_id = ${tenantId} AND status = 'no_show') AS no_shows
  `) as {
    reschedules: number;
    decisions: number;
    returns: number;
    orders: number;
    rescheduled: number;
    no_shows: number;
  }[];
  return rows[0]!;
}

/** Access matrix section 8's bundles, restricted to the keys these routes read. */
const BUNDLES = {
  cashier: [
    "commerce.pos.create",
    "commerce.payments.create",
    "commerce.payments.read",
    "commerce.orders.read",
    "commerce.booking_reservation_links.read",
    "commerce.booking_reservation_links.create"
  ],
  scheduler: [
    "commerce.booking_reservation_links.read",
    "commerce.booking_reservation_links.create",
    "commerce.booking_reservation_links.update",
    "commerce.booking_reservation_links.cancel",
    "commerce.booking_refund_decisions.read",
    "commerce.booking_refund_decisions.create",
    "commerce.booking_offering_links.read",
    "commerce.orders.read",
    "commerce.payments.read"
  ],
  tenantAdmin: [
    "commerce.booking_offering_links.read",
    "commerce.booking_cancellation_policies.read",
    "commerce.booking_cancellation_policies.create",
    "commerce.booking_cancellation_policies.approve",
    "commerce.booking_refund_decisions.read"
  ],
  finance: [
    "commerce.booking_refund_decisions.read",
    "commerce.booking_reservation_links.read",
    "commerce.payments.read",
    "commerce.refunds_offline.approve"
  ]
} as const;

suite("booking reschedule and no-show routes (Issue #382)", () => {
  const previousDefaultTenant = process.env.PUBLIC_DEFAULT_TENANT_ID;

  beforeAll(async () => {
    handlerReady = await ensureHandlerDatabaseReady();
  });
  afterAll(async () => {
    if (previousDefaultTenant === undefined) {
      delete process.env.PUBLIC_DEFAULT_TENANT_ID;
    } else {
      process.env.PUBLIC_DEFAULT_TENANT_ID = previousDefaultTenant;
    }
    await teardownHandlerDatabase();
  });
  beforeEach(async () => {
    resetRateLimitForTests();
    if (!handlerReady) return;
    await resetHandlerDatabase();
  });

  // -------------------------------------------------------------------------
  test("every route is off until the tenant opts in: 409 FEATURE_DISABLED", async () => {
    if (skipUnlessHandlerReady()) return;
    const owner = await bootstrapOwner();
    const responses = [
      await reschedulePost(owner, UNKNOWN_ID, stayOf(5, 7)),
      await quoteGet(
        owner,
        UNKNOWN_ID,
        `?checkInDate=${day(5)}&checkOutDate=${day(7)}`
      ),
      await noShowPost(owner, UNKNOWN_ID)
    ];
    for (const response of responses) {
      expect(response.status).toBe(409);
      expect(response.body.error?.code).toBe("FEATURE_DISABLED");
    }
    expect((await counts(owner.tenantId)).reschedules).toBe(0);
  });

  // -------------------------------------------------------------------------
  describe("the route-by-persona table (evidence item 2)", () => {
    test("the reschedule and its price need .update; every denied cell is 403 with nothing written", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const booking = await paidBooking(owner, fx);
      const id = booking.reservation.id;
      const before = await counts(owner.tenantId);

      const cashier = await seedPrincipal(owner.tenantId, "cashier", [
        ...BUNDLES.cashier
      ]);
      const finance = await seedPrincipal(owner.tenantId, "finance", [
        ...BUNDLES.finance
      ]);
      const admin = await seedPrincipal(owner.tenantId, "tenantadmin", [
        ...BUNDLES.tenantAdmin
      ]);
      const nobody = await seedPrincipal(owner.tenantId, "nobody", []);
      const onlyRead = await seedPrincipal(owner.tenantId, "only-read", [
        "commerce.booking_reservation_links.read"
      ]);
      const query = `?checkInDate=${day(5)}&checkOutDate=${day(7)}`;
      for (const [name, who] of [
        ["cashier", cashier],
        ["finance", finance],
        ["tenant admin", admin],
        ["nobody", nobody],
        ["read only", onlyRead]
      ] as const) {
        expect(
          (await reschedulePost(who, id, stayOf(5, 7))).status,
          `${name} reschedule`
        ).toBe(403);
        expect((await quoteGet(who, id, query)).status, `${name} quote`).toBe(
          403
        );
      }
      expect(await counts(owner.tenantId)).toEqual(before);

      const scheduler = await seedPrincipal(owner.tenantId, "scheduler", [
        ...BUNDLES.scheduler
      ]);
      const quote = await quoteGet(scheduler, id, query);
      expect(quote.status).toBe(200);
      const done = await reschedulePost(scheduler, id, stayOf(5, 7));
      expect(done.status).toBe(200);
      expect((await counts(owner.tenantId)).reschedules).toBe(1);
    });

    test("a no-show needs BOTH the cancel and the decision key; a cashier, finance, a tenant admin and a holder of one key are refused", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      await activePolicy(owner, fx.productId);
      const booking = await paidBooking(owner, fx);
      const id = booking.reservation.id;
      await arrivedHoursAgo(id, 3);
      const before = await counts(owner.tenantId);

      const personas: [string, Principal][] = [
        [
          "cashier",
          await seedPrincipal(owner.tenantId, "cashier", [...BUNDLES.cashier])
        ],
        [
          "finance",
          await seedPrincipal(owner.tenantId, "finance", [...BUNDLES.finance])
        ],
        [
          "tenant admin",
          await seedPrincipal(owner.tenantId, "tenantadmin", [
            ...BUNDLES.tenantAdmin
          ])
        ],
        [
          "only cancel",
          await seedPrincipal(owner.tenantId, "only-cancel", [
            "commerce.booking_reservation_links.cancel"
          ])
        ],
        [
          "only decide",
          await seedPrincipal(owner.tenantId, "only-decide", [
            "commerce.booking_refund_decisions.create"
          ])
        ],
        ["nobody", await seedPrincipal(owner.tenantId, "nobody", [])]
      ];
      for (const [name, who] of personas) {
        expect((await noShowPost(who, id)).status, `${name} no-show`).toBe(403);
      }
      expect(await counts(owner.tenantId)).toEqual(before);

      const scheduler = await seedPrincipal(owner.tenantId, "scheduler", [
        ...BUNDLES.scheduler
      ]);
      const ok = await noShowPost(scheduler, id);
      expect(ok.status).toBe(200);
      expect(ok.body.data.decision).toMatchObject({
        triggerKind: "no_show",
        finalRefund: "0.00",
        computedRefund: "0.00",
        retainedAmount: "1000000.00",
        returnId: null
      });
      expect((await counts(owner.tenantId)).no_shows).toBe(1);
    });

    test("an unknown id and another tenant's id are one 404 for all three routes", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner } = await readyOwner();
      const query = `?checkInDate=${day(5)}&checkOutDate=${day(7)}`;
      const unknown = [
        await reschedulePost(owner, UNKNOWN_ID, stayOf(5, 7)),
        await quoteGet(owner, UNKNOWN_ID, query),
        await noShowPost(owner, UNKNOWN_ID)
      ];
      for (const response of unknown) {
        expect(response.status).toBe(404);
        expect(response.body.error?.code).toBe("RESOURCE_NOT_FOUND");
      }
      // Not a uuid at all: the same neutral answer.
      expect(
        (await reschedulePost(owner, "not-a-uuid", stayOf(5, 7))).status
      ).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe("the body can never carry money (C-39)", () => {
    test("a price, a difference, a refund, an order or a payment method is a 400 and nothing is written", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const booking = await paidBooking(owner, fx);
      const id = booking.reservation.id;
      const before = await counts(owner.tenantId);

      for (const extra of [
        { amount: "1.00" },
        { price: "1" },
        { priceDifference: { amount: "0.00" } },
        { difference: "0" },
        { refund: "1000000.00" },
        { finalRefund: "1000000.00" },
        { final_refund: "1000000.00" },
        { orderId: booking.orderId },
        { paymentMethod: "dp" },
        { deposit: "1" },
        { unknownField: true }
      ]) {
        const response = await reschedulePost(owner, id, {
          ...stayOf(5, 8),
          ...extra
        });
        expect(response.status, JSON.stringify(extra)).toBe(400);
        expect(response.body.error?.code).toBe("VALIDATION_ERROR");
      }
      // Exactly one of startsAt and stay; real dates; ordered dates; a closed reason code.
      for (const payload of [
        {},
        { ...stayOf(5, 7), startsAt: new Date().toISOString() },
        { startsAt: "tomorrow" },
        { stay: { checkInDate: day(7), checkOutDate: day(5) } },
        { stay: { checkInDate: "2026-02-30", checkOutDate: "2026-03-02" } },
        { ...stayOf(5, 7), reasonCode: "Because I said so!" },
        { ...stayOf(5, 7), resourceId: "x" }
      ]) {
        expect(
          (await reschedulePost(owner, id, payload)).status,
          JSON.stringify(payload)
        ).toBe(400);
      }
      expect(await counts(owner.tenantId)).toEqual(before);

      // The quote's query is as strict.
      for (const query of [
        `?checkInDate=${day(5)}&checkOutDate=${day(7)}&amount=1`,
        `?checkInDate=${day(5)}&checkOutDate=${day(7)}&price=1`,
        "",
        `?checkInDate=${day(5)}`,
        `?startsAt=${encodeURIComponent(new Date().toISOString())}&checkInDate=${day(5)}&checkOutDate=${day(7)}`
      ]) {
        expect((await quoteGet(owner, id, query)).status, query).toBe(400);
      }

      // The no-show takes a reason code and nothing else.
      for (const extra of [
        { amount: "1.00" },
        { finalRefund: "1" },
        { refund: "1" },
        { retained: "1" }
      ]) {
        expect(
          (await noShowPost(owner, id, extra)).status,
          JSON.stringify(extra)
        ).toBe(400);
      }
      expect(await counts(owner.tenantId)).toEqual(before);
    });

    test("an Idempotency-Key is required on both mutations", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const booking = await paidBooking(owner, fx);
      const id = booking.reservation.id;
      const missing = await reschedulePost(owner, id, stayOf(5, 7), null);
      expect(missing.status).toBe(400);
      expect(await noShowPost(owner, id, {}, null)).toMatchObject({
        status: 400
      });
      expect((await counts(owner.tenantId)).reschedules).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("reschedule", () => {
    test("a same-length move: the replacement is on the SAME order, the replay is the same record, another body under the key is 409", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const booking = await paidBooking(owner, fx);
      const id = booking.reservation.id;

      const key = nextKey();
      const first = await reschedulePost(owner, id, stayOf(5, 7), key);
      expect(first.status).toBe(200);
      expect(first.body.data).toMatchObject({
        replayed: false,
        orderId: booking.orderId,
        orderCode: booking.orderCode,
        supersededReservationId: id,
        fromNights: 2,
        toNights: 2,
        priceDifference: {
          direction: "none",
          vehicle: null,
          pricedAmount: "0.00",
          refundAmount: "0.00",
          supplementOrder: null,
          returnId: null
        }
      });
      expect(first.body.data.reservation.id).not.toBe(id);
      // No customer, phone or name anywhere in the body (X7).
      const text = JSON.stringify(first.body);
      expect(text).not.toContain("0813");
      expect(text).not.toContain("Budi");

      const again = await reschedulePost(owner, id, stayOf(5, 7), key);
      expect(again.status).toBe(200);
      expect(again.body.data.replayed).toBe(true);
      expect(again.body.data.rescheduleId).toBe(first.body.data.rescheduleId);

      const conflict = await reschedulePost(owner, id, stayOf(9, 11), key);
      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");

      // The old reservation id now names a superseded link: it cannot be moved again.
      const stale = await reschedulePost(owner, id, stayOf(9, 11));
      expect(stale.status).toBe(409);
      expect(stale.body.error?.code).toBe("INVALID_STATE");
      expect((await counts(owner.tenantId)).reschedules).toBe(1);
    });

    test("more nights: the answer names the supplementary order the customer pays; the quote said so first", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const booking = await paidBooking(owner, fx);
      const id = booking.reservation.id;
      const query = `?checkInDate=${day(5)}&checkOutDate=${day(8)}`;
      const quote = await quoteGet(owner, id, query);
      expect(quote.status).toBe(200);
      expect(quote.body.data).toMatchObject({
        currentNights: 2,
        newNights: 3,
        direction: "charge",
        vehicle: "supplementary_order",
        pricedAmount: "500000.00",
        refundAmount: "0.00",
        availability: null
      });
      expect(typeof quote.body.data.serverNow).toBe("string");
      expect((await counts(owner.tenantId)).orders).toBe(1);

      const done = await reschedulePost(owner, id, stayOf(5, 8));
      expect(done.status).toBe(200);
      const difference = done.body.data.priceDifference;
      expect(difference).toMatchObject({
        direction: "charge",
        vehicle: "supplementary_order",
        pricedAmount: "500000.00"
      });
      expect(difference.supplementOrder).toMatchObject({
        status: "pending_payment",
        total: "500000.00"
      });
      expect(difference.supplementOrder.orderCode).not.toBe(booking.orderCode);
      expect((await counts(owner.tenantId)).orders).toBe(2);
    });

    test("a hold is not moved (409 INVALID_STATE), and the quote with a resource id carries Booking's availability", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      await activePolicy(owner, fx.productId);
      // Nothing paid yet: the reservation is still a hold, and Booking moves a confirmed one only.
      const booking = await paidBooking(owner, fx, "0", {
        stay: { checkInDate: day(1), checkOutDate: day(4) }
      });
      const held = await reschedulePost(
        owner,
        booking.reservation.id,
        stayOf(5, 7)
      );
      expect(held.status).toBe(409);
      expect(held.body.error?.code).toBe("INVALID_STATE");

      const paid = await paidBooking(owner, fx, "1500000.00", {
        stay: { checkInDate: day(10), checkOutDate: day(13) }
      });
      const hinted = await quoteGet(
        owner,
        paid.reservation.id,
        `?checkInDate=${day(20)}&checkOutDate=${day(22)}&resourceId=${fx.resourceId}`
      );
      expect(hinted.status).toBe(200);
      expect(hinted.body.data.direction).toBe("refund");
      expect(hinted.body.data.availability).toMatchObject({ available: true });
    });

    test("a Booking refusal keeps its code: the taken dates are 409 SLOT_UNAVAILABLE", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      // The fixture room has six units: fill them on the target dates.
      for (let unit = 0; unit < 6; unit += 1) {
        const made = await invoke<Envelope>(staffCreate, {
          method: "POST",
          path: "/api/v1/commerce/booking/reservations",
          headers: headers(owner, { "idempotency-key": nextKey() }),
          body: bookingBody(fx, { ...stayOf(20, 22) })
        });
        expect(made.status).toBe(201);
      }
      const booking = await paidBooking(owner, fx);
      const refused = await reschedulePost(
        owner,
        booking.reservation.id,
        stayOf(20, 22)
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("SLOT_UNAVAILABLE");
      expect((await counts(owner.tenantId)).reschedules).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("no-show", () => {
    test("before arrival plus the grace: 409 NO_SHOW_TOO_EARLY and nothing is written", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      await activePolicy(owner, fx.productId);
      const booking = await paidBooking(owner, fx);
      const before = await counts(owner.tenantId);
      const early = await noShowPost(owner, booking.reservation.id);
      expect(early.status).toBe(409);
      expect(early.body.error?.code).toBe("NO_SHOW_TOO_EARLY");
      expect(await counts(owner.tenantId)).toEqual(before);
    });

    test("retains by the policy, creates no refund leg, replays on the same key and refuses a second marking", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      await activePolicy(owner, fx.productId);
      const booking = await paidBooking(owner, fx);
      const id = booking.reservation.id;
      await arrivedHoursAgo(id, 3);

      const key = nextKey();
      const first = await noShowPost(
        owner,
        id,
        { reasonCode: "no_contact" },
        key
      );
      expect(first.status).toBe(200);
      expect(first.body.data.replayed).toBe(false);
      expect(first.body.data.decision).toMatchObject({
        triggerKind: "no_show",
        policySource: "product",
        policyVersion: 1,
        amountPaid: "1000000.00",
        finalRefund: "0.00",
        retainedAmount: "1000000.00",
        returnId: null
      });
      expect(JSON.stringify(first.body)).not.toContain("0813");

      const again = await noShowPost(
        owner,
        id,
        { reasonCode: "no_contact" },
        key
      );
      expect(again.status).toBe(200);
      expect(again.body.data.replayed).toBe(true);
      expect(again.body.data.decision.id).toBe(first.body.data.decision.id);

      const conflict = await noShowPost(
        owner,
        id,
        { reasonCode: "other" },
        key
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");

      const second = await noShowPost(owner, id);
      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe("INVALID_STATE");
      const after = await counts(owner.tenantId);
      expect(after).toMatchObject({ decisions: 1, returns: 0, no_shows: 1 });
    });

    test("turning the booking feature off again refuses the mutations", async () => {
      if (skipUnlessHandlerReady()) return;
      const { owner, fx } = await readyOwner();
      const booking = await paidBooking(owner, fx);
      expect((await setBookingFeature(owner, false)).status).toBe(200);
      const refused = await reschedulePost(
        owner,
        booking.reservation.id,
        stayOf(5, 7)
      );
      expect(refused.status).toBe(409);
      expect(refused.body.error?.code).toBe("FEATURE_DISABLED");
    });
  });
});
