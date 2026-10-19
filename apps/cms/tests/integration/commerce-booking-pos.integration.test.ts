/**
 * The POS side of the booking adapter through the REAL route handlers (Issue
 * #383, ADR-0045 D19, `docs/booking-ux-flows.md` section 5; threat controls
 * C-34, C-35 and C-36). World 2 of `harness.ts`: handlers use
 * `getDatabaseClient()` and the public tenant is the one
 * `PUBLIC_DEFAULT_TENANT_ID` names.
 *
 *   - C-34 (lookup and data exposure): code plus customer, exactly, in one
 *     statement; no partial search; byte-identical neutral misses (unknown code,
 *     wrong customer, truncated code); a per-actor rate and miss budget; every
 *     lookup audited with a digest and never the identifier; the contact masked;
 *     `Cache-Control: no-store`; nothing from another tenant;
 *   - C-35 (permission separation and cashier abuse): check-in, check-out and
 *     taking the balance are three keys, each refused to a holder of the other
 *     two; each is bound to the actor's OWN open register session; the balance
 *     is stamped with that session, so the shift's cash-up counts it and a
 *     cashier who pockets it shows as a variance, in the session report and in
 *     the per-register tender report;
 *   - C-36 (balance and service-line integrity): the balance is read from the
 *     ledger (a client balance or price is a 400, an amount above the balance is
 *     `409 OVERPAYMENT`, change is the server's), the service line is the order
 *     line the product priced, a replayed check-in is harmless, and the POS
 *     writes no reservation or balance state of its own;
 *   - D19: the check-in policy, both variants, default BLOCK.
 *
 * The persona tables use principals seeded with EXACTLY the keys under test, so
 * a 403 means "that key was missing".
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
  getHandlerDatabaseClient,
  invoke,
  resetHandlerDatabase,
  teardownHandlerDatabase
} from "./harness";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { resetRateLimitForTests } from "../../src/lib/security/rate-limit";
import { findReservationLinkForPosLookup } from "../../src/modules/commerce/application/booking-reservation-reads";
import {
  fetchCashUpReport,
  fetchTenderReport
} from "../../src/modules/commerce/application/operational-report-directory";
import {
  POS_CASH_UP_VARIANCE_PROJECTION_KEY,
  POS_TENDER_DAILY_PROJECTION_KEY
} from "../../src/modules/commerce/domain/operational-report-keys";
import { commerceModule } from "../../src/modules/commerce/module";
import { runIncrementalUpdateForTenant } from "../../src/modules/reporting/application/projection-incremental-worker";
import { PATCH as patchModuleSettings } from "../../src/pages/api/v1/tenant/modules/[moduleKey]/settings";
import { POST as createRegister } from "../../src/pages/api/v1/commerce/registers/index";
import { POST as openSession } from "../../src/pages/api/v1/commerce/register-sessions/index";
import { GET as getSession } from "../../src/pages/api/v1/commerce/register-sessions/[id]/index";
import { POST as closeSession } from "../../src/pages/api/v1/commerce/register-sessions/[id]/close";
import { POST as lookupRoute } from "../../src/pages/api/v1/commerce/pos/booking/lookup";
import { POST as checkInRoute } from "../../src/pages/api/v1/commerce/pos/booking/reservations/[id]/check-in";
import { POST as checkOutRoute } from "../../src/pages/api/v1/commerce/pos/booking/reservations/[id]/check-out";
import { POST as balanceRoute } from "../../src/pages/api/v1/commerce/pos/booking/reservations/[id]/balance-payments";
import { PUT as putDepositPolicy } from "../../src/pages/api/v1/commerce/products/[id]/deposit-policy";
import {
  DELETE as deleteStoreSettings,
  GET as getStoreSettings
} from "../../src/pages/api/v1/commerce/store-settings/index";
import { POST as staffCreate } from "../../src/pages/api/v1/commerce/booking/reservations/index";
import { POST as staffCancel } from "../../src/pages/api/v1/commerce/booking/reservations/[id]/cancel";
import {
  body as bookingBody,
  bootstrapOwner,
  dispatchEvents,
  headers,
  integrationEnabled,
  nextKey,
  paidBooking,
  putSettings,
  seedFixture,
  seedPrincipal,
  stepUp,
  tamperReservation,
  UNKNOWN_ID,
  type Envelope,
  type Fixture,
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

// ---------------------------------------------------------------------------
// Personas (access matrix section 8, restricted to the keys these routes read)
// ---------------------------------------------------------------------------

const SESSION_KEYS = [
  "commerce.registers.read",
  "commerce.register_sessions.read",
  "commerce.register_sessions.create",
  "commerce.register_sessions.update",
  "commerce.register_cash_ups.create"
];
const READ_KEY = "commerce.booking_reservation_links.read";
const CHECK_IN_KEY = "commerce.booking_check_ins.create";
const CHECK_OUT_KEY = "commerce.booking_check_outs.create";
const BALANCE_KEY = "commerce.booking_balance_payments.create";

const PERSONAS = {
  /** Front desk: the three till keys, the lookup and a shift. */
  desk: [...SESSION_KEYS, READ_KEY, CHECK_IN_KEY, CHECK_OUT_KEY, BALANCE_KEY],
  checkInOnly: [...SESSION_KEYS, READ_KEY, CHECK_IN_KEY],
  checkOutOnly: [...SESSION_KEYS, READ_KEY, CHECK_OUT_KEY],
  payOnly: [...SESSION_KEYS, READ_KEY, BALANCE_KEY],
  /** The generic POS / payment keys are NOT the till keys. */
  genericCashier: [
    ...SESSION_KEYS,
    READ_KEY,
    "commerce.pos.create",
    "commerce.payments.create",
    "commerce.payments.read",
    "commerce.orders.read"
  ],
  scheduler: [
    READ_KEY,
    "commerce.booking_reservation_links.create",
    "commerce.booking_reservation_links.update",
    "commerce.booking_reservation_links.cancel",
    "commerce.booking_refund_decisions.read",
    "commerce.booking_refund_decisions.create",
    "commerce.orders.read",
    "commerce.payments.read"
  ],
  noLookup: [...SESSION_KEYS, CHECK_IN_KEY]
} as const;

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const lookup = (who: Principal, payload: unknown) =>
  invoke<Envelope<Record<string, any>>>(lookupRoute, {
    method: "POST",
    path: "/api/v1/commerce/pos/booking/lookup",
    headers: headers(who),
    body: payload
  });

function stay(
  route: typeof checkInRoute | typeof checkOutRoute,
  verb: "check-in" | "check-out"
) {
  return (
    who: Principal,
    id: string,
    payload: unknown,
    key: string | null = nextKey()
  ) =>
    invoke<Envelope<Record<string, any>>>(route, {
      method: "POST",
      path: `/api/v1/commerce/pos/booking/reservations/${id}/${verb}`,
      headers: headers(who, key === null ? {} : { "idempotency-key": key }),
      params: { id },
      body: payload
    });
}
const checkIn = stay(checkInRoute, "check-in");
const checkOut = stay(checkOutRoute, "check-out");

const collect = (
  who: Principal,
  id: string,
  payload: unknown,
  key: string | null = nextKey()
) =>
  invoke<Envelope<Record<string, any>>>(balanceRoute, {
    method: "POST",
    path: `/api/v1/commerce/pos/booking/reservations/${id}/balance-payments`,
    headers: headers(who, key === null ? {} : { "idempotency-key": key }),
    params: { id },
    body: payload
  });

const setFeatures = (
  who: Principal,
  features: { booking: boolean; register: boolean; pos?: boolean }
) =>
  invoke<Envelope>(patchModuleSettings, {
    method: "PATCH",
    path: "/api/v1/tenant/modules/commerce/settings",
    headers: headers(who),
    params: { moduleKey: "commerce" },
    body: {
      features: {
        pos: features.pos ?? true,
        inbox: true,
        campaigns: true,
        gateway: true,
        courier: true,
        register: features.register,
        documents: false,
        booking: features.booking
      }
    }
  });

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

type Till = {
  owner: Principal;
  fx: Fixture;
  desk: Principal;
  registerId: string;
  sessionId: string;
};

async function newRegister(owner: Principal, code: string): Promise<string> {
  const created = await invoke<Envelope<{ id: string }>>(createRegister, {
    method: "POST",
    path: "/api/v1/commerce/registers",
    headers: headers(owner),
    body: { code, name: `Register ${code}`, locationLabel: "Front" }
  });
  expect(created.status).toBe(201);
  return created.body.data.id;
}

async function openShift(
  who: Principal,
  registerId: string,
  openingFloat = "100000.00"
): Promise<string> {
  const opened = await invoke<Envelope<{ id: string }>>(openSession, {
    method: "POST",
    path: "/api/v1/commerce/register-sessions",
    headers: headers(who, { "idempotency-key": nextKey() }),
    body: { registerId, openingFloat }
  });
  expect(opened.status).toBe(201);
  return opened.body.data.id;
}

/** An owner with booking + register on, a 30% deposit policy, one front-desk cashier and an open shift. */
async function readyTill(): Promise<Till> {
  const owner = await bootstrapOwner();
  expect(
    (await setFeatures(owner, { booking: true, register: true })).status
  ).toBe(200);
  expect(
    (
      await putSettings(owner, {
        bookingServiceTenantUserId: owner.tenantUserId
      })
    ).status
  ).toBe(200);
  process.env.PUBLIC_DEFAULT_TENANT_ID = owner.tenantId;
  const fx = await seedFixture(owner);
  const deposit = await invoke<Envelope>(putDepositPolicy, {
    method: "PUT",
    path: `/api/v1/commerce/products/${fx.productId}/deposit-policy`,
    headers: headers(owner),
    params: { id: fx.productId },
    body: { kind: "percent", percent: "30.00" }
  });
  expect(deposit.status).toBe(200);
  const desk = await seedPrincipal(owner.tenantId, "desk", [...PERSONAS.desk]);
  const registerId = await newRegister(owner, "FD-1");
  const sessionId = await openShift(desk, registerId);
  return { owner, fx, desk, registerId, sessionId };
}

const GUEST = {
  name: "Budi Santoso",
  phone: "081311112222",
  email: "budi@tamu.example"
};

/** A deposit booking: 2 nights at 500,000 = 1,000,000; 30% deposit paid (300,000) and confirmed by the real consumer; 700,000 still owed. */
function depositBooking(
  till: Pick<Till, "owner" | "fx">,
  overrides: Record<string, unknown> = {}
) {
  return paidBooking(till.owner, till.fx, "300000.00", {
    payment: { method: "dp" },
    guest: GUEST,
    ...overrides
  });
}

/** Moves a stay's check-in date to today in the resource's zone, as no application path can (the items table is append-only). */
async function arriveToday(reservationId: string): Promise<void> {
  const admin = getHandlerAdminSql();
  await admin.unsafe(
    "ALTER TABLE awcms_booking_reservation_items DISABLE TRIGGER awcms_booking_reservation_items_append_only"
  );
  try {
    await admin.unsafe(
      `UPDATE awcms_booking_reservation_items
       SET check_in_date = (now() AT TIME ZONE timezone)::date,
           check_out_date = (now() AT TIME ZONE timezone)::date + nights
       WHERE reservation_id = '${reservationId}'`
    );
  } finally {
    await admin.unsafe(
      "ALTER TABLE awcms_booking_reservation_items ENABLE TRIGGER awcms_booking_reservation_items_append_only"
    );
  }
}

const reservationStatus = async (id: string): Promise<string> =>
  (
    (await getHandlerAdminSql()`
      SELECT status FROM awcms_booking_reservations WHERE id = ${id}
    `) as { status: string }[]
  )[0]!.status;

async function auditRows(tenantId: string, action: string) {
  return (await getHandlerAdminSql()`
    SELECT severity, attributes, message, actor_tenant_user_id
    FROM awcms_audit_events
    WHERE tenant_id = ${tenantId} AND action = ${action}
    ORDER BY created_at ASC, id ASC
  `) as {
    severity: string;
    attributes: Record<string, any>;
    message: string;
    actor_tenant_user_id: string | null;
  }[];
}

async function ledgerOf(orderId: string) {
  return (await getHandlerAdminSql()`
    SELECT id, kind, tender_type, amount::text AS amount, status, source,
           register_session_id, actor_tenant_user_id,
           tendered_amount::text AS tendered_amount, change_amount::text AS change_amount
    FROM awcms_commerce_payment_allocations
    WHERE order_id = ${orderId}
    ORDER BY created_at ASC, id ASC
  `) as {
    id: string;
    kind: string;
    tender_type: string;
    amount: string;
    status: string;
    source: string;
    register_session_id: string | null;
    actor_tenant_user_id: string | null;
    tendered_amount: string | null;
    change_amount: string | null;
  }[];
}

const CASH = (amount: string) => ({ tenderType: "cash", amount });

suite("booking POS: lookup, check-in, check-out, balance (Issue #383)", () => {
  const previousDefaultTenant = process.env.PUBLIC_DEFAULT_TENANT_ID;
  const previousLag = process.env.REPORTING_PROJECTION_LAG_SECONDS;

  beforeAll(async () => {
    handlerReady = await ensureHandlerDatabaseReady();
  });
  afterAll(async () => {
    if (previousDefaultTenant === undefined) {
      delete process.env.PUBLIC_DEFAULT_TENANT_ID;
    } else {
      process.env.PUBLIC_DEFAULT_TENANT_ID = previousDefaultTenant;
    }
    if (previousLag === undefined) {
      delete process.env.REPORTING_PROJECTION_LAG_SECONDS;
    } else {
      process.env.REPORTING_PROJECTION_LAG_SECONDS = previousLag;
    }
    await teardownHandlerDatabase();
  });
  beforeEach(async () => {
    resetRateLimitForTests();
    if (!handlerReady) return;
    await resetHandlerDatabase();
  });

  // -------------------------------------------------------------------------
  describe("the gates", () => {
    test("every route is off until the tenant opts in: 409 FEATURE_DISABLED, nothing written", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const registerId = "00000000-0000-4000-8000-0000000000bb";
      const responses = [
        await lookup(owner, { reservationNo: "RSV-0001", phone: GUEST.phone }),
        await checkIn(owner, UNKNOWN_ID, { registerId }),
        await checkOut(owner, UNKNOWN_ID, { registerId }),
        await collect(owner, UNKNOWN_ID, {
          registerId,
          tenders: [CASH("1000.00")]
        })
      ];
      for (const response of responses) {
        expect(response.status).toBe(409);
        expect(response.body.error?.code).toBe("FEATURE_DISABLED");
        expect(response.response.headers.get("cache-control")).toBe("no-store");
      }
      expect(
        await auditRows(owner.tenantId, "commerce.booking_pos.lookup")
      ).toEqual([]);
    });

    test("the three writes need the register feature (they are bound to a session); the lookup does not", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      expect(
        (await setFeatures(till.owner, { booking: true, register: false }))
          .status
      ).toBe(200);
      const registerGate = [
        await checkIn(till.desk, booking.reservation.id, {
          registerId: till.registerId
        }),
        await checkOut(till.desk, booking.reservation.id, {
          registerId: till.registerId
        }),
        await collect(till.desk, booking.reservation.id, {
          registerId: till.registerId,
          tenders: [CASH("1000.00")]
        })
      ];
      for (const response of registerGate) {
        expect(response.status).toBe(409);
        expect(response.body.error?.code).toBe("FEATURE_DISABLED");
        expect(response.body.error?.message).toContain("register");
      }
      const found = await lookup(till.desk, {
        reservationNo: await reservationNoOf(booking.reservation.id),
        phone: GUEST.phone
      });
      expect(found.status).toBe(200);
      expect((await ledgerOf(booking.orderId)).length).toBe(1);
    });

    test("the POS feature gates the whole surface", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      expect(
        (
          await setFeatures(till.owner, {
            booking: true,
            register: true,
            pos: false
          })
        ).status
      ).toBe(200);
      const response = await lookup(till.desk, {
        reservationNo: await reservationNoOf(booking.reservation.id),
        phone: GUEST.phone
      });
      expect(response.status).toBe(409);
      expect(response.body.error?.message).toContain("pos");
    });
  });

  // -------------------------------------------------------------------------
  describe("C-34: the lookup is not an oracle", () => {
    test("an exact code and the customer's phone find the reservation: masked contact, ledger balance, the service line the product priced, no-store, no customer id", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const reservationNo = await reservationNoOf(booking.reservation.id);

      const found = await lookup(till.desk, {
        reservationNo,
        phone: "0813-1111-2222"
      });
      expect(found.status).toBe(200);
      expect(found.response.headers.get("cache-control")).toBe("no-store");
      const card = found.body.data;
      expect(card).toMatchObject({
        reservationId: booking.reservation.id,
        reservationNo,
        status: "confirmed",
        linkStatus: "active",
        orderId: booking.orderId,
        orderCode: booking.orderCode,
        serviceLine: {
          quantity: 2,
          unitPrice: "500000.00",
          lineTotal: "1000000.00"
        },
        settlement: {
          total: "1000000.00",
          paid: "300000.00",
          deposit: "300000.00",
          balanceDue: "700000.00"
        },
        // D19: the default blocks a check-in with a balance owed.
        policy: { checkInRequiresSettlement: true }
      });
      expect(card.actions).toEqual({
        canCollectBalance: true,
        canCheckIn: false,
        checkInBlockedReason: "balance_not_settled",
        canCheckOut: false
      });
      // The contact is masked and never raw anywhere in the body.
      expect(card.guest.name).toBe(GUEST.name);
      expect(card.guest.phoneMasked).toBe("+62813•••2222");
      expect(card.guest.emailMasked).toBe("bu•••@tamu.example");
      const text = JSON.stringify(found.body);
      expect(text).not.toContain("81311112222");
      expect(text).not.toContain("budi@tamu.example");
      expect(text).not.toMatch(/customerId|customer_id/);

      // By e-mail, upper-case code: the same reservation.
      const byEmail = await lookup(till.desk, {
        reservationNo: reservationNo.toLowerCase(),
        email: " Budi@Tamu.Example "
      });
      expect(byEmail.status).toBe(200);
      expect(byEmail.body.data.reservationId).toBe(booking.reservation.id);

      // Both lookups are audited as hits, with a digest and never the identifier.
      const rows = await auditRows(
        till.owner.tenantId,
        "commerce.booking_pos.lookup"
      );
      expect(rows.map((row) => row.attributes.outcome)).toEqual(["hit", "hit"]);
      expect(rows[0]!.actor_tenant_user_id).toBe(till.desk.tenantUserId);
      const audited = JSON.stringify(rows);
      expect(audited).not.toContain("81311112222");
      expect(audited).not.toContain("budi@tamu.example");
      expect(audited).not.toContain("0813");
      expect(rows[0]!.attributes.identifierDigest).toMatch(/^[0-9a-f]{16}$/);
      expect(rows[0]!.attributes.identifierKind).toBe("phone");
      expect(rows[1]!.attributes.identifierKind).toBe("email");
    });

    test("an unknown code, a wrong customer, another customer's phone and a truncated code are ONE neutral 404, byte for byte, and each miss is audited", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const first = await depositBooking(till);
      const second = await depositBooking(till, {
        stay: { checkInDate: dayFrom(5), checkOutDate: dayFrom(7) },
        guest: { name: "Siti", phone: "081377778888" }
      });
      const codeA = await reservationNoOf(first.reservation.id);
      const codeB = await reservationNoOf(second.reservation.id);

      const misses = [
        // Unknown code, a known phone.
        await lookup(till.desk, {
          reservationNo: "RSV-NOPE-9999",
          phone: GUEST.phone
        }),
        // Real code, wrong phone.
        await lookup(till.desk, {
          reservationNo: codeA,
          phone: "081200000000"
        }),
        // Real code, ANOTHER real customer's phone.
        await lookup(till.desk, {
          reservationNo: codeA,
          phone: "081377778888"
        }),
        // The other reservation's code with the first customer's phone.
        await lookup(till.desk, { reservationNo: codeB, phone: GUEST.phone }),
        // A truncated code (no prefix search), right phone.
        await lookup(till.desk, {
          reservationNo: codeA.slice(0, -1),
          phone: GUEST.phone
        }),
        // Right code, wrong e-mail.
        await lookup(till.desk, {
          reservationNo: codeA,
          email: "nobody@tamu.example"
        })
      ];
      for (const miss of misses) {
        expect(miss.status).toBe(404);
        expect(miss.response.headers.get("cache-control")).toBe("no-store");
        expect(miss.body).toEqual(misses[0]!.body);
        expect(JSON.stringify(miss.body)).toBe(JSON.stringify(misses[0]!.body));
      }
      const rows = await auditRows(
        till.owner.tenantId,
        "commerce.booking_pos.lookup"
      );
      expect(rows.map((row) => row.attributes.outcome)).toEqual(
        misses.map(() => "miss")
      );
      expect(rows.every((row) => row.severity === "warning")).toBe(true);
      // The right pair still finds each reservation.
      expect(
        (
          await lookup(till.desk, {
            reservationNo: codeB,
            phone: "081377778888"
          })
        ).status
      ).toBe(200);
    });

    test("there is no search: a code alone, an identifier alone, both identifiers, a name, a prefix wildcard and an extra key are 400, nothing audited", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const code = await reservationNoOf(booking.reservation.id);
      const bad: unknown[] = [
        { reservationNo: code },
        { phone: GUEST.phone },
        { reservationNo: code, phone: GUEST.phone, email: "budi@tamu.example" },
        { reservationNo: code, name: GUEST.name },
        { name: GUEST.name, phone: GUEST.phone },
        { reservationNo: `${code.slice(0, 4)}%`, phone: GUEST.phone },
        { reservationNo: "R", phone: GUEST.phone },
        { reservationNo: code, phone: "not a phone" },
        { reservationNo: code, email: "%@tamu.example" },
        { reservationNo: code, phone: GUEST.phone, q: "budi" },
        { reservationNo: code, phone: GUEST.phone, date: "2026-12-01" },
        { reservationNo: 12345, phone: GUEST.phone },
        {}
      ];
      for (const payload of bad) {
        const response = await lookup(till.desk, payload);
        expect(response.status, JSON.stringify(payload)).toBe(400);
        expect(response.response.headers.get("cache-control")).toBe("no-store");
      }
      expect(
        await auditRows(till.owner.tenantId, "commerce.booking_pos.lookup")
      ).toEqual([]);
    });

    test("a per-actor lookup rate and a miss budget: 429 with Retry-After, audited as throttled; a hit gives its unit back", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const code = await reservationNoOf(booking.reservation.id);
      const miss = () =>
        lookup(till.desk, {
          reservationNo: "RSV-NOPE-9999",
          phone: GUEST.phone
        });

      // Hits refund: 8 misses, 8 hits, 8 misses stay within a budget of 10.
      for (let i = 0; i < 8; i += 1) expect((await miss()).status).toBe(404);
      for (let i = 0; i < 8; i += 1) {
        expect(
          (await lookup(till.desk, { reservationNo: code, phone: GUEST.phone }))
            .status
        ).toBe(200);
      }
      // 8 misses so far; two more fill the budget, the next lookup - even a valid one - is throttled.
      expect((await miss()).status).toBe(404);
      expect((await miss()).status).toBe(404);
      const throttled = await lookup(till.desk, {
        reservationNo: code,
        phone: GUEST.phone
      });
      expect(throttled.status).toBe(429);
      expect(throttled.body.error?.code).toBe("RATE_LIMITED");
      expect(
        Number(throttled.response.headers.get("retry-after"))
      ).toBeGreaterThan(0);
      expect(throttled.response.headers.get("cache-control")).toBe("no-store");
      const outcomes = (
        await auditRows(till.owner.tenantId, "commerce.booking_pos.lookup")
      ).map((row) => row.attributes.outcome);
      expect(outcomes.at(-1)).toBe("throttled");
      // Audit L3: only the FIRST throttle of the window is audited. Hammering the
      // throttled endpoint must not write a row per request.
      for (let i = 0; i < 4; i += 1) {
        expect(
          (await lookup(till.desk, { reservationNo: code, phone: GUEST.phone }))
            .status
        ).toBe(429);
      }
      const throttledRows = (
        await auditRows(till.owner.tenantId, "commerce.booking_pos.lookup")
      ).filter((row) => row.attributes.outcome === "throttled");
      expect(throttledRows).toHaveLength(1);
      expect(throttledRows[0]!.severity).toBe("warning");
      expect(throttledRows[0]!.attributes.throttle).toBe("misses");

      // Another actor is not affected by this one's budget.
      const other = await seedPrincipal(till.owner.tenantId, "desk2", [
        ...PERSONAS.desk
      ]);
      expect(
        (await lookup(other, { reservationNo: code, phone: GUEST.phone }))
          .status
      ).toBe(200);
    });

    test("the general per-minute rate also stops a fast hitter", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const code = await reservationNoOf(booking.reservation.id);
      let status = 0;
      for (let i = 0; i < 31; i += 1) {
        status = (
          await lookup(till.desk, { reservationNo: code, phone: GUEST.phone })
        ).status;
        if (i < 30) expect(status).toBe(200);
      }
      expect(status).toBe(429);
      // Audit L3: the per-minute throttle is audited once per window as well.
      for (let i = 0; i < 3; i += 1) {
        expect(
          (await lookup(till.desk, { reservationNo: code, phone: GUEST.phone }))
            .status
        ).toBe(429);
      }
      const throttledRows = (
        await auditRows(till.owner.tenantId, "commerce.booking_pos.lookup")
      ).filter((row) => row.attributes.outcome === "throttled");
      expect(throttledRows).toHaveLength(1);
      expect(throttledRows[0]!.attributes.throttle).toBe("rate");
    });

    test("nothing of another tenant: the same code and phone asked in another tenant finds nothing (the tenant is in the query, and RLS backs it where it is enforced)", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const code = await reservationNoOf(booking.reservation.id);
      const otherTenant = (
        (await getHandlerAdminSql()`
          INSERT INTO awcms_tenants (tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
          VALUES ('other-co', 'Other', 'Other Legal', 'active', 'en', 'light')
          RETURNING id
        `) as { id: string }[]
      )[0]!.id;
      const lookupIn = (tenantId: string) =>
        withTenantOrThrow(getHandlerDatabaseClient(), tenantId, (tx) =>
          findReservationLinkForPosLookup(tx, tenantId, code, {
            kind: "phone",
            value: "+6281311112222"
          })
        );
      expect(await lookupIn(till.owner.tenantId)).not.toBeNull();
      expect(await lookupIn(otherTenant)).toBeNull();
    });

    test("the lookup needs .read: a holder of the till keys without it, and a persona with nothing, get 403", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const code = await reservationNoOf(booking.reservation.id);
      const noRead = await seedPrincipal(till.owner.tenantId, "noread", [
        ...PERSONAS.noLookup
      ]);
      const nobody = await seedPrincipal(till.owner.tenantId, "nobody", []);
      for (const who of [noRead, nobody]) {
        const denied = await lookup(who, {
          reservationNo: code,
          phone: GUEST.phone
        });
        expect(denied.status).toBe(403);
      }
      expect(
        await auditRows(till.owner.tenantId, "commerce.booking_pos.lookup")
      ).toEqual([]);
    });

    test("the contact stays masked for the owner too (the unmasked contact is the customers screen's)", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const code = await reservationNoOf(booking.reservation.id);
      const response = await lookup(till.owner, {
        reservationNo: code,
        phone: GUEST.phone
      });
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain("81311112222");
    });
  });

  // -------------------------------------------------------------------------
  describe("C-35: three separate permissions, each bound to the actor's own open register session", () => {
    test("the persona table: each till key opens exactly its own route; the other two, the generic POS keys, a scheduler and nobody get 403, nothing written", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const id = booking.reservation.id;
      const ledgerBefore = (await ledgerOf(booking.orderId)).length;

      const cells = [
        ["checkInOnly", { in: true, out: false, pay: false }],
        ["checkOutOnly", { in: false, out: true, pay: false }],
        ["payOnly", { in: false, out: false, pay: true }],
        ["genericCashier", { in: false, out: false, pay: false }],
        ["scheduler", { in: false, out: false, pay: false }]
      ] as const;
      for (const [persona, allowed] of cells) {
        const who = await seedPrincipal(till.owner.tenantId, persona, [
          ...PERSONAS[persona]
        ]);
        const body = { registerId: till.registerId };
        const results = {
          in: await checkIn(who, id, body),
          out: await checkOut(who, id, body),
          pay: await collect(who, id, {
            ...body,
            tenders: [CASH("1000.00")]
          })
        };
        for (const verb of ["in", "out", "pay"] as const) {
          // An allowed key reaches the handler (and is then refused for the
          // session: it is the desk's shift); a missing key is a 403.
          expect(results[verb].status === 403, `${persona} ${verb}`).toBe(
            !allowed[verb]
          );
        }
      }
      const nobody = await seedPrincipal(till.owner.tenantId, "nobody", []);
      for (const response of [
        await checkIn(nobody, id, { registerId: till.registerId }),
        await checkOut(nobody, id, { registerId: till.registerId }),
        await collect(nobody, id, {
          registerId: till.registerId,
          tenders: [CASH("1000.00")]
        })
      ]) {
        expect(response.status).toBe(403);
      }

      expect((await ledgerOf(booking.orderId)).length).toBe(ledgerBefore);
      expect(await reservationStatus(id)).toBe("confirmed");
      for (const action of [
        "commerce.booking_pos.check_in",
        "commerce.booking_pos.check_out",
        "commerce.booking_pos.balance_collected"
      ]) {
        expect(await auditRows(till.owner.tenantId, action)).toEqual([]);
      }
    });

    test("bound to the actor's own OPEN session: no session, another cashier's session, a closed one, a closing one, an unknown register - nothing written", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const id = booking.reservation.id;
      const ledgerBefore = (await ledgerOf(booking.orderId)).length;
      const attempt = async (who: Principal, registerId: string) => [
        await checkIn(who, id, { registerId }),
        await checkOut(who, id, { registerId }),
        await collect(who, id, { registerId, tenders: [CASH("1000.00")] })
      ];
      const expectAll = (
        responses: Envelope[] | { status: number; body: Envelope }[],
        status: number,
        code: string
      ) => {
        for (const response of responses as {
          status: number;
          body: Envelope;
        }[]) {
          expect(response.status).toBe(status);
          expect(response.body.error?.code).toBe(code);
        }
      };

      // A register that has no session at all.
      const idle = await newRegister(till.owner, "FD-2");
      expectAll(
        await attempt(till.desk, idle),
        409,
        "REGISTER_SESSION_REQUIRED"
      );

      // Another cashier on the desk's register: the session is the desk's.
      const second = await seedPrincipal(till.owner.tenantId, "desk2", [
        ...PERSONAS.desk
      ]);
      expectAll(
        await attempt(second, till.registerId),
        409,
        "NOT_SESSION_CASHIER"
      );
      // Audit I3: ringing money (or a stay) into another cashier's register is an
      // event, audited at `warning` and COMMITTED although the write was refused.
      const intrusions = await auditRows(
        till.owner.tenantId,
        "commerce.booking_pos.not_session_cashier"
      );
      expect(intrusions).toHaveLength(3);
      expect(intrusions.map((row) => row.attributes.operation).sort()).toEqual([
        "balance",
        "check_in",
        "check_out"
      ]);
      for (const row of intrusions) {
        expect(row.severity).toBe("warning");
        expect(row.actor_tenant_user_id).toBe(second.tenantUserId);
        expect(row.attributes).toMatchObject({
          registerId: till.registerId,
          reservationId: id
        });
      }

      // An unknown register is the neutral 404.
      expectAll(
        await attempt(till.desk, UNKNOWN_ID),
        404,
        "RESOURCE_NOT_FOUND"
      );

      // A short count the cashier cannot approve leaves the session CLOSING.
      const closing = await invoke<Envelope<{ outcome: string }>>(
        closeSession,
        {
          method: "POST",
          path: `/api/v1/commerce/register-sessions/${till.sessionId}/close`,
          headers: headers(till.desk, { "idempotency-key": nextKey() }),
          params: { id: till.sessionId },
          body: { counted: { cash: "90000.00" }, varianceReason: "short" }
        }
      );
      expect(closing.body.data.outcome).toBe("pending_approval");
      expectAll(
        await attempt(till.desk, till.registerId),
        409,
        "REGISTER_SESSION_CLOSING"
      );

      // A closed session (the owner approves the short count) is no session.
      const closedOk = await invoke<Envelope>(
        (
          await import("../../src/pages/api/v1/commerce/register-sessions/[id]/close-decision")
        ).POST,
        {
          method: "POST",
          path: `/api/v1/commerce/register-sessions/${till.sessionId}/close-decision`,
          headers: headers(till.owner, { "idempotency-key": nextKey() }),
          params: { id: till.sessionId },
          body: { decision: "approve" }
        }
      );
      expect(closedOk.status).toBe(200);
      expectAll(
        await attempt(till.desk, till.registerId),
        409,
        "REGISTER_SESSION_REQUIRED"
      );

      // A malformed register id is a 400 before anything runs.
      expect(
        (await checkIn(till.desk, id, { registerId: "not-a-uuid" })).status
      ).toBe(400);

      expect((await ledgerOf(booking.orderId)).length).toBe(ledgerBefore);
      expect(await reservationStatus(id)).toBe("confirmed");
      // Only the not-the-cashier refusal is an intrusion: the other refusals
      // above (no session, closing, closed, unknown register) added no row.
      expect(
        await auditRows(
          till.owner.tenantId,
          "commerce.booking_pos.not_session_cashier"
        )
      ).toHaveLength(3);
    });

    test("the balance is stamped with the cashier's session: the shift's cash-up and the per-register tender report count it, and pocketing it is a variance", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const id = booking.reservation.id;

      // The customer hands over 1,000,000 for a 700,000 balance.
      const paid = await collect(till.desk, id, {
        registerId: till.registerId,
        tenders: [CASH("1000000.00")]
      });
      expect(paid.status).toBe(200);
      expect(paid.response.headers.get("cache-control")).toBe("no-store");
      expect(paid.body.data).toMatchObject({
        replayed: false,
        balanceBefore: "700000.00",
        change: "300000.00",
        registerSessionId: till.sessionId,
        payments: [
          {
            tenderType: "cash",
            amount: "700000.00",
            tenderedAmount: "1000000.00",
            changeAmount: "300000.00"
          }
        ],
        settlement: {
          total: "1000000.00",
          paid: "1000000.00",
          outstanding: "0.00",
          paymentStatus: "paid"
        }
      });

      // The leg is on the ORDINARY ledger: source pos, the cashier, the session.
      const ledger = await ledgerOf(booking.orderId);
      expect(ledger).toHaveLength(2);
      expect(ledger[1]).toMatchObject({
        kind: "payment",
        tender_type: "cash",
        amount: "700000.00",
        status: "succeeded",
        source: "pos",
        register_session_id: till.sessionId,
        actor_tenant_user_id: till.desk.tenantUserId
      });
      // The deposit (taken before the till) belongs to no session.
      expect(ledger[0]!.register_session_id).toBeNull();

      // The session report: expected cash = float 100,000 + the balance 700,000.
      const report = await invoke<Envelope<Record<string, any>>>(getSession, {
        path: `/api/v1/commerce/register-sessions/${till.sessionId}`,
        headers: headers(till.desk),
        params: { id: till.sessionId }
      });
      expect(report.status).toBe(200);
      const cash = (report.body.data.tenders as any[]).find(
        (row) => row.tenderType === "cash"
      );
      expect(cash.expected).toBe("800000.00");

      // The cashier pockets it: counts only the float. The variance is the whole balance.
      const closed = await invoke<Envelope<Record<string, any>>>(closeSession, {
        method: "POST",
        path: `/api/v1/commerce/register-sessions/${till.sessionId}/close`,
        headers: headers(till.desk, { "idempotency-key": nextKey() }),
        params: { id: till.sessionId },
        body: { counted: { cash: "100000.00" }, varianceReason: "count" }
      });
      expect(closed.status).toBe(200);
      expect(closed.body.data.outcome).toBe("pending_approval");
      const closedCash = (closed.body.data.report.tenders as any[]).find(
        (row) => row.tenderType === "cash"
      );
      expect(closedCash).toMatchObject({
        expected: "800000.00",
        counted: "100000.00",
        variance: "-700000.00"
      });
      expect(closed.body.data.report.session.currentCashierTenantUserId).toBe(
        till.desk.tenantUserId
      );

      // The supervisor approves; the reporting projections (lag 0) then carry it.
      const approved = await invoke<Envelope>(
        (
          await import("../../src/pages/api/v1/commerce/register-sessions/[id]/close-decision")
        ).POST,
        {
          method: "POST",
          path: `/api/v1/commerce/register-sessions/${till.sessionId}/close-decision`,
          headers: headers(till.owner, { "idempotency-key": nextKey() }),
          params: { id: till.sessionId },
          body: { decision: "approve" }
        }
      );
      expect(approved.status).toBe(200);
      process.env.REPORTING_PROJECTION_LAG_SECONDS = "0";
      for (const key of [
        POS_TENDER_DAILY_PROJECTION_KEY,
        POS_CASH_UP_VARIANCE_PROJECTION_KEY
      ]) {
        const descriptor = commerceModule.reportingProjections!.find(
          (candidate) => candidate.key === key
        )!;
        const outcome = await runIncrementalUpdateForTenant(
          getHandlerDatabaseClient(),
          descriptor,
          till.owner.tenantId
        );
        expect(outcome.failed).toBe(false);
      }
      const range = {
        from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
        to: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
      };
      const tenders = await withTenantOrThrow(
        getHandlerDatabaseClient(),
        till.owner.tenantId,
        (tx) => fetchTenderReport(tx, till.owner.tenantId, range)
      );
      const deskCash = tenders.items.filter(
        (row: any) =>
          row.registerId === till.registerId && row.tenderType === "cash"
      );
      // The desk's register carries the balance (the deposit, taken before the
      // till, is on no register).
      expect(deskCash.map((row: any) => row.payments)).toEqual(["700000.00"]);
      expect(deskCash.map((row: any) => row.paymentCount)).toEqual([1]);
      const cashUps = await withTenantOrThrow(
        getHandlerDatabaseClient(),
        till.owner.tenantId,
        (tx) => fetchCashUpReport(tx, till.owner.tenantId, range)
      );
      const row = cashUps.items.find(
        (item: any) =>
          item.sessionId === till.sessionId && item.tenderType === "cash"
      );
      expect(row).toMatchObject({
        cashierTenantUserId: till.desk.tenantUserId,
        expected: "800000.00",
        counted: "100000.00",
        variance: "-700000.00"
      });
      expect(cashUps.totalShort).toBe("-700000.00");
    });

    test("split tenders and part payments run through the ordinary planner; every leg is the desk's, in its session", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const id = booking.reservation.id;

      const split = await collect(till.desk, id, {
        registerId: till.registerId,
        tenders: [
          { tenderType: "manual_qris", amount: "200000.00", reference: "QR-1" },
          CASH("300000.00")
        ]
      });
      expect(split.status).toBe(200);
      expect(
        split.body.data.payments.map((p: any) => [p.tenderType, p.amount])
      ).toEqual([
        ["manual_qris", "200000.00"],
        ["cash", "300000.00"]
      ]);
      expect(split.body.data.change).toBe("0.00");
      expect(split.body.data.settlement).toMatchObject({
        paid: "800000.00",
        outstanding: "200000.00",
        paymentStatus: "dp_paid"
      });

      const rest = await collect(till.desk, id, {
        registerId: till.registerId,
        tenders: [CASH("200000.00")]
      });
      expect(rest.status).toBe(200);
      expect(rest.body.data.settlement.paymentStatus).toBe("paid");

      const none = await collect(till.desk, id, {
        registerId: till.registerId,
        tenders: [CASH("1000.00")]
      });
      expect(none.status).toBe(409);
      expect(none.body.error?.code).toBe("NO_BALANCE_DUE");

      const ledger = (await ledgerOf(booking.orderId)).slice(1);
      expect(ledger).toHaveLength(3);
      for (const leg of ledger) {
        expect(leg.register_session_id).toBe(till.sessionId);
        expect(leg.actor_tenant_user_id).toBe(till.desk.tenantUserId);
        expect(leg.source).toBe("pos");
      }
      const audit = await auditRows(
        till.owner.tenantId,
        "commerce.booking_pos.balance_collected"
      );
      expect(audit).toHaveLength(2);
      expect(audit[0]!.attributes).toMatchObject({
        balanceBefore: "700000.00",
        balanceAfter: "200000.00",
        registerSessionId: till.sessionId
      });
    });

    test("two cashiers reusing one Idempotency-Key never share a leg: each collects into their own session, no silent deduplication (audit L2)", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const id = booking.reservation.id;
      const second = await seedPrincipal(till.owner.tenantId, "desk2", [
        ...PERSONAS.desk
      ]);
      const secondRegister = await newRegister(till.owner, "FD-2");
      const secondSession = await openShift(second, secondRegister);

      const key = nextKey();
      const first = await collect(
        till.desk,
        id,
        { registerId: till.registerId, tenders: [CASH("100000.00")] },
        key
      );
      expect(first.status).toBe(200);
      const other = await collect(
        second,
        id,
        { registerId: secondRegister, tenders: [CASH("100000.00")] },
        key
      );
      // Not a replay of the first cashier's answer, and not their allocation.
      expect(other.status).toBe(200);
      expect(other.body.data.replayed).toBe(false);
      expect(other.body.data.registerSessionId).toBe(secondSession);
      expect(other.body.data.payments[0].id).not.toBe(
        first.body.data.payments[0].id
      );

      const legs = (await ledgerOf(booking.orderId)).slice(1);
      expect(legs).toHaveLength(2);
      expect(
        legs.map((leg) => [leg.actor_tenant_user_id, leg.register_session_id])
      ).toEqual([
        [till.desk.tenantUserId, till.sessionId],
        [second.tenantUserId, secondSession]
      ]);

      // Each cashier's own repeat is still a replay of their own answer.
      const again = await collect(
        till.desk,
        id,
        { registerId: till.registerId, tenders: [CASH("100000.00")] },
        key
      );
      expect(again.body.data.replayed).toBe(true);
      expect(again.body.data.payments[0].id).toBe(
        first.body.data.payments[0].id
      );
      expect(await ledgerOf(booking.orderId)).toHaveLength(3);
    });

    test("the database guard: a payment stamped with a foreign session is refused unless it is the till's balance of a booking order, recorded by that session's own cashier", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const admin = getHandlerAdminSql();
      /** Resolves to the database's refusal text, or "" when the insert was accepted. */
      const attempt = async (
        orderId: string,
        source: string,
        sourceKey: string,
        actor:
          { kind: "tenant_user"; tenantUserId: string } | { kind: "system" } = {
          kind: "tenant_user",
          tenantUserId: till.desk.tenantUserId
        }
      ): Promise<string> => {
        const actorId =
          actor.kind === "tenant_user" ? actor.tenantUserId : null;
        try {
          await admin`
            INSERT INTO awcms_commerce_payment_allocations
              (tenant_id, order_id, kind, tender_type, amount, status, source, source_key,
               actor_kind, actor_tenant_user_id, register_session_id, settled_at)
            VALUES (${till.owner.tenantId}, ${orderId}, 'payment', 'cash', '1000.00', 'succeeded',
                    ${source}, ${sourceKey}, ${actor.kind}, ${actorId},
                    ${till.sessionId}, now())
          `;
          return "";
        } catch (error) {
          return (error as Error).message;
        }
      };
      // The booking order, source pos: allowed (this is the app's own path).
      expect(await attempt(booking.orderId, "pos", "guard-ok")).toBe("");
      // Issue #383 audit L1: the exception names the session's OWN cashier. The
      // session is open and the order is a live booking, but the actor is
      // somebody else (the owner, and a second cashier with the same keys): the
      // database refuses it, whatever the application would have done.
      expect(
        await attempt(booking.orderId, "pos", "guard-other-cashier", {
          kind: "tenant_user",
          tenantUserId: till.owner.tenantUserId
        })
      ).toMatch(/register session of its own order/);
      const second = await seedPrincipal(till.owner.tenantId, "desk3", [
        ...PERSONAS.desk
      ]);
      expect(
        await attempt(booking.orderId, "pos", "guard-second-cashier", {
          kind: "tenant_user",
          tenantUserId: second.tenantUserId
        })
      ).toMatch(/register session of its own order/);
      // A system-recorded leg has no cashier to bind: refused as well.
      expect(
        await attempt(booking.orderId, "pos", "guard-system", {
          kind: "system"
        })
      ).toMatch(/register session of its own order/);
      // The refused attempts left nothing behind.
      const stamped = (await admin`
        SELECT count(*)::int AS n FROM awcms_commerce_payment_allocations
        WHERE order_id = ${booking.orderId}
          AND source_key IN ('guard-other-cashier', 'guard-second-cashier', 'guard-system')
      `) as { n: number }[];
      expect(stamped[0]!.n).toBe(0);
      // The same order from the admin path: refused.
      expect(await attempt(booking.orderId, "admin", "guard-admin")).toMatch(
        /register session of its own order/
      );
      // An ordinary order with no reservation link: refused, even as pos.
      const plain = (await admin`
        SELECT o.id FROM awcms_commerce_orders o
        WHERE o.tenant_id = ${till.owner.tenantId}
          AND NOT EXISTS (SELECT 1 FROM awcms_commerce_booking_reservation_links l WHERE l.order_id = o.id)
        LIMIT 1
      `) as { id: string }[];
      if (plain[0]) {
        expect(await attempt(plain[0].id, "pos", "guard-plain")).toMatch(
          /register session of its own order/
        );
      }
      // A released link is no longer a live booking balance.
      await admin`
        UPDATE awcms_commerce_booking_reservation_links SET status = 'released'
        WHERE order_id = ${booking.orderId}
      `;
      expect(await attempt(booking.orderId, "pos", "guard-released")).toMatch(
        /register session of its own order/
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("C-36: the balance and the price are the server's; the POS writes no reservation or balance state", () => {
    test("a body naming a balance, a price, an order, a customer or a session is a 400 with nothing written; a non-cash tender above the balance is 409 OVERPAYMENT", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const id = booking.reservation.id;
      const base = { registerId: till.registerId, tenders: [CASH("1000.00")] };
      for (const extra of [
        { balance: "1.00" },
        { balanceDue: "1.00" },
        { outstanding: "1.00" },
        { price: "1.00" },
        { unitPrice: "1.00" },
        { total: "1.00" },
        { orderId: booking.orderId },
        { reservationId: id },
        { customerId: UNKNOWN_ID },
        { status: "paid" },
        { registerSessionId: till.sessionId },
        { discount: "100.00" }
      ]) {
        const response = await collect(till.desk, id, { ...base, ...extra });
        expect(response.status, JSON.stringify(extra)).toBe(400);
      }
      for (const bad of [
        { registerId: till.registerId },
        { registerId: till.registerId, tenders: [] },
        {
          registerId: till.registerId,
          tenders: [{ tenderType: "gateway", amount: "1.00" }]
        },
        {
          registerId: till.registerId,
          tenders: [{ tenderType: "cash", amount: 1000 }]
        },
        { registerId: till.registerId, tenders: [CASH("0.00")] },
        { tenders: [CASH("1000.00")] }
      ]) {
        expect((await collect(till.desk, id, bad)).status).toBe(400);
      }
      // No Idempotency-Key.
      expect((await collect(till.desk, id, base, null)).status).toBe(400);

      const over = await collect(till.desk, id, {
        registerId: till.registerId,
        tenders: [{ tenderType: "manual_qris", amount: "700000.01" }]
      });
      expect(over.status).toBe(409);
      expect(over.body.error?.code).toBe("OVERPAYMENT");
      expect(over.body.error?.details).toMatchObject({
        outstanding: "700000.00"
      });
      // Cash above the balance is change, derived by the server.
      expect((await ledgerOf(booking.orderId)).length).toBe(1);
    });

    test("the card's service line and the balance are the order's and the ledger's, whatever the product's price becomes", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const code = await reservationNoOf(booking.reservation.id);
      await getHandlerAdminSql()`
        UPDATE awcms_commerce_products SET price = '1.00' WHERE id = ${till.fx.productId}
      `;
      const card = await lookup(till.desk, {
        reservationNo: code,
        phone: GUEST.phone
      });
      expect(card.body.data.serviceLine).toMatchObject({
        unitPrice: "500000.00",
        lineTotal: "1000000.00"
      });
      expect(card.body.data.settlement.balanceDue).toBe("700000.00");
      const paid = await collect(till.desk, booking.reservation.id, {
        registerId: till.registerId,
        tenders: [CASH("700000.00")]
      });
      expect(paid.status).toBe(200);
      expect(paid.body.data.settlement.outstanding).toBe("0.00");
    });

    test("idempotent: the same key and body replays the first answer, the same key with another body is a conflict, and a concurrent pair collects once", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const id = booking.reservation.id;
      const payload = {
        registerId: till.registerId,
        tenders: [CASH("200000.00")]
      };
      const key = nextKey();
      const first = await collect(till.desk, id, payload, key);
      expect(first.status).toBe(200);
      expect(first.body.data.replayed).toBe(false);
      const again = await collect(till.desk, id, payload, key);
      expect(again.status).toBe(200);
      expect(again.body.data.replayed).toBe(true);
      expect(again.body.data.payments).toEqual(first.body.data.payments);
      expect(
        (
          await collect(
            till.desk,
            id,
            { ...payload, tenders: [CASH("100000.00")] },
            key
          )
        ).status
      ).toBe(409);
      expect((await ledgerOf(booking.orderId)).length).toBe(2);

      // Two clerks, two keys, the whole remaining 500,000 each: one wins.
      const racers = await Promise.all([
        collect(till.desk, id, { ...payload, tenders: [CASH("500000.00")] }),
        collect(till.desk, id, { ...payload, tenders: [CASH("500000.00")] })
      ]);
      expect(racers.map((r) => r.status).sort()).toEqual([200, 409]);
      const settled = (await ledgerOf(booking.orderId)).reduce(
        (sum, leg) => sum + Number(leg.amount),
        0
      );
      expect(settled).toBe(1_000_000);
    });

    test("a replayed check-in is harmless: the second key finds the guest checked in, writes no second audit row, and the same key replays", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const id = booking.reservation.id;
      await arriveToday(id);
      expect(
        (
          await collect(till.desk, id, {
            registerId: till.registerId,
            tenders: [CASH("700000.00")]
          })
        ).status
      ).toBe(200);
      const key = nextKey();
      const first = await checkIn(
        till.desk,
        id,
        { registerId: till.registerId },
        key
      );
      expect(first.status).toBe(200);
      expect(first.body.data).toMatchObject({
        replayed: false,
        balanceDue: "0.00",
        registerSessionId: till.sessionId,
        reservation: { id, status: "checked_in" }
      });
      expect(await reservationStatus(id)).toBe("checked_in");

      const sameKey = await checkIn(
        till.desk,
        id,
        { registerId: till.registerId },
        key
      );
      expect(sameKey.status).toBe(200);
      expect(sameKey.body.data.replayed).toBe(true);
      const newKey = await checkIn(till.desk, id, {
        registerId: till.registerId
      });
      expect(newKey.status).toBe(200);
      expect(newKey.body.data.replayed).toBe(true);
      const otherBody = await checkIn(
        till.desk,
        id,
        { registerId: till.registerId },
        key
      );
      expect(otherBody.status).toBe(200);
      expect(
        (await auditRows(till.owner.tenantId, "commerce.booking_pos.check_in"))
          .length
      ).toBe(1);
    });

    test("the POS keeps no state: its source holds no write to an order, a link, a reservation or a ledger row except through the ordinary primitives", async () => {
      const { readFile } = await import("node:fs/promises");
      const source = await readFile(
        "src/modules/commerce/application/booking-pos.ts",
        "utf8"
      );
      // Strip comments, then: no statement that writes a table.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(code).not.toMatch(/\bUPDATE\s+awcms_/i);
      expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
      // Booking is moved only through its port.
      expect(code).toContain("ctx.port.checkIn(");
      expect(code).toContain("ctx.port.checkOut(");
      expect(code).toContain("recordPaymentAllocation(");
    });
  });

  // -------------------------------------------------------------------------
  describe("D19: check-in with an unpaid balance - both variants, default BLOCK", () => {
    test("default BLOCK: 409 BALANCE_NOT_SETTLED while a balance is owed, nothing written; collect, then check in and out", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const booking = await depositBooking(till);
      const id = booking.reservation.id;
      await arriveToday(id);
      const body = { registerId: till.registerId };

      const blocked = await checkIn(till.desk, id, body);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error?.code).toBe("BALANCE_NOT_SETTLED");
      expect(blocked.body.error?.details).toEqual({ outstanding: "700000.00" });
      expect(blocked.response.headers.get("cache-control")).toBe("no-store");
      expect(await reservationStatus(id)).toBe("confirmed");
      expect(
        await auditRows(till.owner.tenantId, "commerce.booking_pos.check_in")
      ).toEqual([]);

      // Check-out of a guest who is not in the house.
      const early = await checkOut(till.desk, id, body);
      expect(early.status).toBe(409);
      expect(early.body.error?.code).toBe("INVALID_STATE");

      expect(
        (
          await collect(till.desk, id, {
            ...body,
            tenders: [CASH("700000.00")]
          })
        ).status
      ).toBe(200);
      const card = await lookup(till.desk, {
        reservationNo: await reservationNoOf(id),
        phone: GUEST.phone
      });
      expect(card.body.data.actions).toMatchObject({
        canCollectBalance: false,
        canCheckIn: true,
        checkInBlockedReason: null
      });
      const inOk = await checkIn(till.desk, id, body);
      expect(inOk.status).toBe(200);
      expect(await reservationStatus(id)).toBe("checked_in");
      const out = await checkOut(till.desk, id, body);
      expect(out.status).toBe(200);
      expect(out.body.data.reservation.status).toBe("completed");
      expect(await reservationStatus(id)).toBe("completed");

      const ins = await auditRows(
        till.owner.tenantId,
        "commerce.booking_pos.check_in"
      );
      expect(ins).toHaveLength(1);
      expect(ins[0]!.attributes).toMatchObject({
        registerSessionId: till.sessionId,
        checkInRequiresSettlement: true,
        balanceWaived: false
      });
      expect(ins[0]!.actor_tenant_user_id).toBe(till.desk.tenantUserId);
      expect(
        await auditRows(till.owner.tenantId, "commerce.booking_pos.check_out")
      ).toHaveLength(1);
    });

    test("ALLOW: the tenant setting off lets the guest in with the balance visible and still collectable; the audit row says the balance was waived", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      await stepUp(till.owner);
      expect(
        (await putSettings(till.owner, { checkinRequiresSettlement: false }))
          .status
      ).toBe(200);
      const booking = await depositBooking(till);
      const id = booking.reservation.id;
      await arriveToday(id);
      const body = { registerId: till.registerId };

      const card = await lookup(till.desk, {
        reservationNo: await reservationNoOf(id),
        phone: GUEST.phone
      });
      expect(card.body.data.policy.checkInRequiresSettlement).toBe(false);
      expect(card.body.data.actions).toMatchObject({
        canCheckIn: true,
        checkInBlockedReason: null
      });

      const inOk = await checkIn(till.desk, id, body);
      expect(inOk.status).toBe(200);
      expect(inOk.body.data.balanceDue).toBe("700000.00");
      expect(await reservationStatus(id)).toBe("checked_in");
      const rows = await auditRows(
        till.owner.tenantId,
        "commerce.booking_pos.check_in"
      );
      expect(rows[0]!.attributes).toMatchObject({
        checkInRequiresSettlement: false,
        balanceWaived: true,
        balanceDue: "700000.00"
      });

      // The balance is still collectable in house, and check-out still works.
      const paid = await collect(till.desk, id, {
        ...body,
        tenders: [CASH("700000.00")]
      });
      expect(paid.status).toBe(200);
      expect((await checkOut(till.desk, id, body)).status).toBe(200);
    });

    test("CHECK_IN_TOO_EARLY is 409 and nothing changes", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      await stepUp(till.owner);
      expect(
        (await putSettings(till.owner, { checkinRequiresSettlement: false }))
          .status
      ).toBe(200);
      const booking = await depositBooking(till); // arrives in 61 days
      const early = await checkIn(till.desk, booking.reservation.id, {
        registerId: till.registerId
      });
      expect(early.status).toBe(409);
      expect(early.body.error?.code).toBe("CHECK_IN_TOO_EARLY");
      expect(await reservationStatus(booking.reservation.id)).toBe("confirmed");
      expect(
        await auditRows(till.owner.tenantId, "commerce.booking_pos.check_in")
      ).toEqual([]);
    });

    test("the setting: default true for a tenant that never saved one, round-trips, an absent key leaves it alone, a non-boolean is 400, a reset puts it back", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const read = async () =>
        (
          await invoke<Envelope<Record<string, any>>>(getStoreSettings, {
            path: "/api/v1/commerce/store-settings",
            headers: headers(owner)
          })
        ).body.data.checkinRequiresSettlement;
      expect(await read()).toBe(true);
      await stepUp(owner);
      expect(
        (await putSettings(owner, { checkinRequiresSettlement: false })).status
      ).toBe(200);
      expect(await read()).toBe(false);
      expect((await putSettings(owner, {})).status).toBe(200);
      expect(await read()).toBe(false);
      expect(
        (await putSettings(owner, { checkinRequiresSettlement: "no" })).status
      ).toBe(400);
      expect(
        (await putSettings(owner, { checkinRequiresSettlement: null })).status
      ).toBe(400);
      expect(
        (await putSettings(owner, { checkinRequiresSettlement: true })).status
      ).toBe(200);
      expect(await read()).toBe(true);
      await stepUp(owner);
      expect(
        (await putSettings(owner, { checkinRequiresSettlement: false })).status
      ).toBe(200);
      const reset = await invoke<Envelope>(deleteStoreSettings, {
        method: "DELETE",
        path: "/api/v1/commerce/store-settings",
        headers: headers(owner)
      });
      expect(reset.status).toBe(200);
      expect(await read()).toBe(true);
    });

    test("the policy flip is audited both ways (from, to, severity) and turning it OFF needs a fresh step-up: refused without one, nothing written (audit M1)", async () => {
      if (skipUnlessHandlerReady()) return;
      const owner = await bootstrapOwner();
      const policyRows = () =>
        auditRows(
          owner.tenantId,
          "commerce.booking_pos.check_in_policy_changed"
        );
      const storeRows = async () =>
        (
          await getHandlerAdminSql()`
            SELECT count(*)::int AS n FROM awcms_audit_events
            WHERE tenant_id = ${owner.tenantId} AND action = 'update'
              AND resource_type = 'store_settings'
          `
        )[0]!.n as number;
      const read = async () =>
        (
          await invoke<Envelope<Record<string, any>>>(getStoreSettings, {
            path: "/api/v1/commerce/store-settings",
            headers: headers(owner)
          })
        ).body.data.checkinRequiresSettlement;

      // The owner of a fresh tenant has no step-up: the loosening is refused.
      const before = await storeRows();
      const refused = await putSettings(owner, {
        checkinRequiresSettlement: false
      });
      expect(refused.status).toBe(403);
      expect(refused.body.error?.code).toBe("STEP_UP_REQUIRED");
      expect(await read()).toBe(true);
      expect(await policyRows()).toEqual([]);
      expect(await storeRows()).toBe(before);

      // A STALE step-up (older than the platform TTL) is no step-up either.
      await stepUp(owner, 3_600_000);
      expect(
        (await putSettings(owner, { checkinRequiresSettlement: false })).status
      ).toBe(403);
      expect(await read()).toBe(true);
      expect(await policyRows()).toEqual([]);

      // Not touching the policy (an absent key, or the value it already has)
      // needs no step-up and writes no policy row.
      expect((await putSettings(owner, {})).status).toBe(200);
      expect(
        (await putSettings(owner, { checkinRequiresSettlement: true })).status
      ).toBe(200);
      expect(await policyRows()).toEqual([]);

      // Fresh step-up: true -> false is accepted and audited as a warning.
      await stepUp(owner);
      expect(
        (await putSettings(owner, { checkinRequiresSettlement: false })).status
      ).toBe(200);
      expect(await read()).toBe(false);
      let rows = await policyRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.severity).toBe("warning");
      expect(rows[0]!.actor_tenant_user_id).toBe(owner.tenantUserId);
      expect(rows[0]!.attributes).toMatchObject({ from: true, to: false });
      expect(typeof rows[0]!.attributes.stepUpAt).toBe("string");

      // The same value again is not a change: no second row.
      expect(
        (await putSettings(owner, { checkinRequiresSettlement: false })).status
      ).toBe(200);
      expect(await policyRows()).toHaveLength(1);

      // false -> true tightens the control: no step-up needed, audited as info.
      await stepUp(owner, 3_600_000);
      expect(
        (await putSettings(owner, { checkinRequiresSettlement: true })).status
      ).toBe(200);
      expect(await read()).toBe(true);
      rows = await policyRows();
      expect(rows).toHaveLength(2);
      expect(rows[1]!.severity).toBe("info");
      expect(rows[1]!.attributes).toMatchObject({ from: false, to: true });
      expect(rows[1]!.attributes.stepUpAt).toBeUndefined();
    });

    test("states: an unknown or malformed id is the neutral 404; a cancelled reservation takes no balance and no check-in; a held one can be paid in full at the till and is then confirmed by the ordinary consumer", async () => {
      if (skipUnlessHandlerReady()) return;
      const till = await readyTill();
      const body = { registerId: till.registerId };
      for (const id of [UNKNOWN_ID, "not-a-uuid"]) {
        for (const response of [
          await checkIn(till.desk, id, body),
          await checkOut(till.desk, id, body),
          await collect(till.desk, id, { ...body, tenders: [CASH("1.00")] })
        ]) {
          expect(response.status).toBe(404);
          expect(response.body).toEqual(
            (await checkIn(till.desk, UNKNOWN_ID, body)).body
          );
        }
      }

      // Cancelled by staff: no balance, no check-in.
      const cancelled = await depositBooking(till);
      const cancel = await invoke<Envelope>(staffCancel, {
        method: "POST",
        path: `/api/v1/commerce/booking/reservations/${cancelled.reservation.id}/cancel`,
        headers: headers(till.owner, { "idempotency-key": nextKey() }),
        params: { id: cancelled.reservation.id },
        body: { reasonCode: "guest_request" }
      });
      expect(cancel.status).toBe(200);
      for (const response of [
        await checkIn(till.desk, cancelled.reservation.id, body),
        await collect(till.desk, cancelled.reservation.id, {
          ...body,
          tenders: [CASH("1.00")]
        })
      ]) {
        expect(response.status).toBe(409);
        expect(response.body.error?.code).toBe("INVALID_STATE");
      }

      // A held reservation (nothing paid) is paid in full at the till.
      const held = await invoke<
        Envelope<{ orderId: string; reservation: { id: string } }>
      >(staffCreate, {
        method: "POST",
        path: "/api/v1/commerce/booking/reservations",
        headers: headers(till.owner, { "idempotency-key": nextKey() }),
        body: bookingBody(till.fx, {
          stay: { checkInDate: dayFrom(10), checkOutDate: dayFrom(12) },
          guest: { name: "Dewi", phone: "081355556666" }
        })
      });
      expect(held.status).toBe(201);
      expect(await reservationStatus(held.body.data.reservation.id)).toBe(
        "held"
      );
      // A hold that has lapsed (the sweep has not run yet) takes no money.
      await tamperReservation(
        held.body.data.reservation.id,
        "hold_expires_at = now() - interval '1 minute'"
      );
      const lapsed = await collect(till.desk, held.body.data.reservation.id, {
        ...body,
        tenders: [CASH("1000000.00")]
      });
      expect(lapsed.status).toBe(409);
      expect(lapsed.body.error?.code).toBe("INVALID_STATE");
      expect(lapsed.body.error?.message).toContain("hold_expired");
      expect(await ledgerOf(held.body.data.orderId)).toEqual([]);
      await tamperReservation(
        held.body.data.reservation.id,
        "hold_expires_at = now() + interval '1 hour'"
      );
      const full = await collect(till.desk, held.body.data.reservation.id, {
        ...body,
        tenders: [CASH("1000000.00")]
      });
      expect(full.status).toBe(200);
      expect(full.body.data.settlement.paymentStatus).toBe("paid");
      await dispatchEvents(till.owner.tenantId);
      expect(await reservationStatus(held.body.data.reservation.id)).toBe(
        "confirmed"
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Small readers used above
// ---------------------------------------------------------------------------

async function reservationNoOf(reservationId: string): Promise<string> {
  return (
    (await getHandlerAdminSql()`
      SELECT reservation_no FROM awcms_booking_reservations WHERE id = ${reservationId}
    `) as { reservation_no: string }[]
  )[0]!.reservation_no;
}

/** A local calendar date `offset` days after the fixtures' base day (60 days from today). */
function dayFrom(offset: number): string {
  return new Date(Date.now() + (60 + offset) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
