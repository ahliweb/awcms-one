/**
 * Booking cancellation, the refund quote, the refund decision and the refund
 * legs against a REAL migrated PostgreSQL (Issue #381, ADR-0045 D4/D6/D8/D9/G5,
 * threat controls C-10, C-11, C-32, C-37, C-40). World 1 of `harness.ts`: the
 * application functions are called with the `awcms_app` runtime pool and the
 * REAL composed `BookingPort`; the domain events are dispatched through the real
 * consumer registry. The wiring (permissions, step-up, the strict body schemas,
 * the persona table) is proved through the real route handlers in
 * `commerce-booking-cancellation-routes.integration.test.ts`.
 *
 * What only a database can prove:
 *
 *   - the quote and the decision: a window's share of what was PAID (not of the
 *     total), a zero refund creates a decision and no legs, an unpaid order is
 *     cancelled, a deposit-only booking refunds the share of the deposit;
 *   - the version applied is the one in force WHEN THE BOOKING WAS MADE: a later
 *     version never changes what the guest was promised, a booking made while no
 *     policy applied keeps `none`, and the product's policy beats the tenant
 *     default; across a reschedule chain the ORIGINAL arrival and the original
 *     booking's version apply (C-37);
 *   - the money: the legs are planned as `pending` rows of a return of kind
 *     `cancellation`, never above what each payment can still give back, also
 *     after a partial reversal and across two payments; the settled-path
 *     (`executeRefund`) settles them with the existing code; nothing is settled
 *     by the cancel itself;
 *   - the override: capped at the amount paid (`REFUND_EXCEEDS_PAID`), equal to
 *     the computed figure is not an override, evidence columns and the critical
 *     audit row, and the table's own CHECK stops what the application would not;
 *   - idempotency: replay returns the same decision and no second return, a
 *     conflicting payload is refused, a second key on a decided reservation is
 *     `INVALID_STATE`, and concurrent cancels produce a single decision;
 *   - the customer path: a stale acknowledged figure is `QUOTE_CHANGED` with
 *     nothing cancelled; the Booking cancelled event finds no active link and so
 *     raises no `cancelled_externally_paid` flag for our own cancel;
 *   - tenant isolation under RLS, and the append-only decision.
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
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { saveBookingServiceTenantUserId } from "../../src/modules/commerce/application/booking-adapter-settings";
import {
  cancelBookingReservation,
  computeCancellationQuote,
  fetchDecisionForLink,
  fetchDecisionForReservation,
  fetchDecisionReturn,
  type AuthorizedOverride,
  type CancelResult
} from "../../src/modules/commerce/application/booking-cancellation";
import {
  approvePolicy,
  createPolicyDraft,
  listPolicies,
  retirePolicy,
  type PolicyRecord
} from "../../src/modules/commerce/application/booking-cancellation-policies";
import { setProductDepositPolicy } from "../../src/modules/commerce/application/booking-deposit-policies";
import { createBookingReservation } from "../../src/modules/commerce/application/booking-hold-to-order";
import { createOfferingLink } from "../../src/modules/commerce/application/booking-offering-links";
import {
  fetchReservationLinkByReservationId,
  fetchReservationLinkForOrderCode
} from "../../src/modules/commerce/application/booking-reservation-links";
import { recordOwnerPayment } from "../../src/modules/commerce/application/payment-recording";
import { recordPaymentReversal } from "../../src/modules/commerce/application/payment-allocation-directory";
import { createReturn } from "../../src/modules/commerce/application/return-directory";
import { executeRefund } from "../../src/modules/commerce/application/refund-execution";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import {
  type BookingRequestActor,
  type BookingReservationRequest
} from "../../src/modules/commerce/domain/booking-hold-to-order";
import { validateCreateReturnInput } from "../../src/modules/commerce/domain/returns";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import {
  getAdminSql,
  getAppRoleSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "38100000-0381-4000-8000-00000000000a";
const TENANT_B = "38100000-0381-4000-8000-00000000000b";
const STAFF = "38100000-0381-4000-8000-0000000000b1";
const MANAGER = "38100000-0381-4000-8000-0000000000b2";
const SERVICE = "38100000-0381-4000-8000-0000000000b3";
const STAFF_B = "38100000-0381-4000-8000-0000000000b4";
const SERVICE_B = "38100000-0381-4000-8000-0000000000b5";
const PRICE = "500000.00";
const GUEST_PHONE = "081311112222";
const HOUR = 3_600_000;

/** v1 of the standard policy: 100% from 7 days, 50% from 2 days, nothing closer. */
const STANDARD_WINDOWS = [
  { minHoursBeforeStart: 168, refundablePercent: "100.00" },
  { minHoursBeforeStart: 48, refundablePercent: "50.00" }
];

function inTenant<T>(
  fn: (tx: Bun.TransactionSQL) => Promise<T>,
  tenantId: string = TENANT_A
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(
  tenantId: string,
  code: string,
  users: [string, string][]
): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${tenantId}, ${code}, ${code}, ${`${code} Legal`}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
  for (const [id, label] of users) {
    const profile = (await admin`
      INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
      VALUES (${tenantId}, 'person', ${label})
      RETURNING id
    `) as { id: string }[];
    const identity = (await admin`
      INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
      VALUES (${tenantId}, ${profile[0]!.id}, ${`${label}@example.test`}, 'x')
      RETURNING id
    `) as { id: string }[];
    await admin`
      INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
      VALUES (${id}, ${tenantId}, ${identity[0]!.id})
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

async function configureTenant(
  tenantId: string,
  staffId: string,
  serviceId: string | null
): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Villa",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(async (tx) => {
    await saveStoreSettings(tx, tenantId, staffId, validated.value);
    await updateModuleSettings(
      tx,
      tenantId,
      "commerce",
      {
        features: {
          pos: true,
          inbox: true,
          campaigns: true,
          gateway: true,
          courier: true,
          returns: true,
          booking: true
        }
      },
      staffId
    );
    if (serviceId) {
      await saveBookingServiceTenantUserId(tx, tenantId, serviceId);
    }
  }, tenantId);
}

type Fixture = {
  productId: string;
  offeringId: string;
  resourceId: string;
};

let fixtureSeq = 0;

async function newFixture(
  tenantId: string = TENANT_A,
  staffId: string = STAFF
): Promise<Fixture> {
  fixtureSeq += 1;
  const code = `c${fixtureSeq}`;
  const admin = getAdminSql();
  const product = (await admin`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${tenantId}, 'service', ${`SKU-${code}`}, ${`Kamar ${code}`}, ${`kamar-${code}`}, ${PRICE}, 0, 'active')
    RETURNING id
  `) as { id: string }[];
  const resource = (await admin`
    INSERT INTO awcms_booking_resources
      (tenant_id, code, name, kind, capacity, timezone, booking_mode,
       stay_check_in_time, stay_check_out_time)
    VALUES (${tenantId}, ${code}, ${`Room ${code}`}, 'room', 1,
            'Asia/Pontianak', 'stay', '14:00'::time, '12:00'::time)
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_booking_resource_units (tenant_id, resource_id, ordinal)
    VALUES (${tenantId}, ${resource[0]!.id}, 1)
  `;
  const offering = (await admin`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, max_party, confirmation_mode)
    VALUES (${tenantId}, ${`night-${code}`}, 'Night', 'stay', 1, 30, 4, 'hold_then_confirm')
    RETURNING id
  `) as { id: string }[];
  const linked = await inTenant(
    (tx) =>
      createOfferingLink(
        tx,
        tenantId,
        staffId,
        {
          offeringId: offering[0]!.id,
          productId: product[0]!.id,
          quantityBasis: "nights",
          resourceIds: []
        },
        `link-${code}`
      ),
    tenantId
  );
  if (linked.kind === "refused") {
    throw new Error(`link refused: ${linked.refusal}`);
  }
  return {
    productId: product[0]!.id,
    offeringId: offering[0]!.id,
    resourceId: resource[0]!.id
  };
}

/** A local date `day` days after a point comfortably inside Booking's default horizon. */
const D = (day: number): string =>
  new Date(Date.now() + (60 + day) * 86_400_000).toISOString().slice(0, 10);

function request(
  fx: Fixture,
  overrides: Partial<BookingReservationRequest> = {}
): BookingReservationRequest {
  return {
    offeringId: fx.offeringId,
    resourceId: fx.resourceId,
    startsAt: null,
    stay: { checkInDate: D(10), checkOutDate: D(12) },
    partySize: 2,
    guest: { name: "Budi", phone: GUEST_PHONE, email: null },
    paymentMethod: "manual_qris",
    notes: null,
    ...overrides
  };
}

const STAFF_ACTOR: BookingRequestActor = { kind: "staff", tenantUserId: STAFF };
const guestActor = (phoneKey = "guest-key-1"): BookingRequestActor => ({
  kind: "guest",
  phoneKey
});

let keySeq = 0;
const nextKey = () => `k381-${(keySeq += 1)}`;

async function book(
  fx: Fixture,
  options: {
    req?: Partial<BookingReservationRequest>;
    tenantId?: string;
    staffId?: string;
  } = {}
) {
  const tenantId = options.tenantId ?? TENANT_A;
  const result = await inTenant(
    async (tx) =>
      createBookingReservation(
        tx,
        {
          tenantId,
          actor: {
            kind: "staff",
            tenantUserId: options.staffId ?? STAFF
          },
          correlationId: crypto.randomUUID(),
          port: await composedBookingPort(),
          mediaPort: mediaLibraryPortAdapter
        },
        request(fx, options.req),
        nextKey()
      ),
    tenantId
  );
  if (result.kind !== "created") {
    throw new Error(`expected created, got ${JSON.stringify(result)}`);
  }
  return result.view;
}

function pay(
  orderId: string,
  amount: string,
  tenantId: string = TENANT_A,
  staffId: string = STAFF
) {
  return inTenant(
    (tx) =>
      recordOwnerPayment(tx, tenantId, staffId, orderId, {
        idempotencyKey: crypto.randomUUID(),
        tenderType: "manual_qris",
        amount,
        reference: null,
        note: null
      }),
    tenantId
  );
}

async function dispatch(tenantId: string = TENANT_A): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await dispatchDomainEventsForTenant(getRuntimeSql(), tenantId, {
      limit: 200
    });
  }
}

async function startsAtOf(
  reservationId: string,
  tenantId: string = TENANT_A
): Promise<number> {
  const port = await composedBookingPort();
  const got = await inTenant(
    (tx) => port.get(tx, { tenantId, reservationId }),
    tenantId
  );
  if (!got.ok) throw new Error(`reservation ${reservationId} not readable`);
  return Date.parse(got.reservation.startsAt);
}

async function reservationStatus(reservationId: string): Promise<string> {
  const rows = (await getAdminSql()`
    SELECT status FROM awcms_booking_reservations WHERE id = ${reservationId}
  `) as { status: string }[];
  return rows[0]!.status;
}

async function linkOf(reservationId: string) {
  const rows = (await getAdminSql()`
    SELECT * FROM awcms_commerce_booking_reservation_links
    WHERE reservation_id = ${reservationId}
    ORDER BY created_at DESC
  `) as Record<string, unknown>[];
  return rows[0]!;
}

async function orderStatus(orderId: string): Promise<string> {
  const rows = (await getAdminSql()`
    SELECT status FROM awcms_commerce_orders WHERE id = ${orderId}
  `) as { status: string }[];
  return rows[0]!.status;
}

/**
 * Cancels `reservationId` as `actor` at `hoursBefore` hours before the ORIGINAL
 * arrival (the clock is injected; production uses the server clock).
 */
async function cancel(
  reservationId: string,
  options: {
    actor?: BookingRequestActor;
    key?: string;
    hoursBefore?: number;
    ack?: string | null;
    override?: AuthorizedOverride | null;
    reasonCode?: string;
    tenantId?: string;
    rootReservationId?: string;
  } = {}
): Promise<CancelResult> {
  const tenantId = options.tenantId ?? TENANT_A;
  const hoursBefore = options.hoursBefore ?? 200;
  const startsAt = await startsAtOf(
    options.rootReservationId ?? reservationId,
    tenantId
  );
  const now = new Date(startsAt - hoursBefore * HOUR);
  const actor = options.actor ?? STAFF_ACTOR;
  return inTenant(async (tx) => {
    const link = await fetchReservationLinkByReservationId(
      tx,
      tenantId,
      reservationId
    );
    if (!link) throw new Error("no link");
    return cancelBookingReservation(
      tx,
      {
        tenantId,
        actor,
        correlationId: crypto.randomUUID(),
        port: await composedBookingPort(),
        now
      },
      {
        link,
        idempotencyKey: options.key ?? nextKey(),
        reasonCode: options.reasonCode ?? "guest_request",
        acknowledgedRefund:
          options.ack !== undefined
            ? options.ack
            : actor.kind === "staff"
              ? null
              : "0.00",
        override: options.override ?? null
      }
    );
  }, tenantId);
}

async function cancelled(
  reservationId: string,
  options: Parameters<typeof cancel>[1] = {}
) {
  const result = await cancel(reservationId, options);
  if (result.kind === "refused") {
    throw new Error(`expected cancelled, got ${JSON.stringify(result)}`);
  }
  return result;
}

function override(
  finalRefund: string,
  overrides: Partial<AuthorizedOverride> = {}
): AuthorizedOverride {
  return {
    authorizedBy: "refund_override_permission_and_step_up",
    finalRefund,
    reason: "Owner approved a goodwill refund after a complaint",
    actorTenantUserId: MANAGER,
    stepUpAt: new Date(),
    ...overrides
  };
}

async function policy(
  productId: string | null,
  windows = STANDARD_WINDOWS,
  options: {
    basis?: "whole_stay" | "per_night";
    tenantId?: string;
    author?: string;
    approver?: string;
  } = {}
): Promise<PolicyRecord> {
  const tenantId = options.tenantId ?? TENANT_A;
  const draft = await inTenant(
    (tx) =>
      createPolicyDraft(
        tx,
        tenantId,
        options.author ?? STAFF,
        {
          productId,
          refundBasis: options.basis ?? "whole_stay",
          noShowRetention: "retain_deposit",
          windows
        },
        nextKey()
      ),
    tenantId
  );
  if (draft.kind === "refused") throw new Error("draft refused");
  const activated = await inTenant(
    (tx) =>
      approvePolicy(
        tx,
        tenantId,
        options.approver ?? MANAGER,
        draft.policy.id,
        nextKey()
      ),
    tenantId
  );
  if (activated.kind !== "activated") {
    throw new Error(`approve returned ${activated.kind}`);
  }
  return activated.policy;
}

async function decisionRows(tenantId: string = TENANT_A) {
  return (await getAdminSql()`
    SELECT * FROM awcms_commerce_booking_refund_decisions
    WHERE tenant_id = ${tenantId} ORDER BY created_at
  `) as Record<string, unknown>[];
}

async function legsOf(returnId: string) {
  return (await getAdminSql()`
    SELECT id, allocation_id, tender_type, amount, status, source_key, actor_tenant_user_id
    FROM awcms_commerce_refunds WHERE return_id = ${returnId} ORDER BY source_key
  `) as {
    id: string;
    allocation_id: string;
    tender_type: string;
    amount: string;
    status: string;
    source_key: string;
    actor_tenant_user_id: string;
  }[];
}

async function auditActions(
  resourceId: string,
  tenantId: string = TENANT_A
): Promise<
  { action: string; severity: string; attributes: Record<string, unknown> }[]
> {
  return (await getAdminSql()`
    SELECT action, severity, attributes FROM awcms_audit_events
    WHERE tenant_id = ${tenantId} AND resource_id = ${resourceId}
    ORDER BY created_at, id
  `) as {
    action: string;
    severity: string;
    attributes: Record<string, unknown>;
  }[];
}

async function attemptSql(query: PromiseLike<unknown>): Promise<string | null> {
  try {
    await query;
    return null;
  } catch (error) {
    return (error as { message?: string }).message ?? String(error);
  }
}

suite("booking cancellation, refund quote and refund legs (Issue #381)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-ca-a", [
      [STAFF, "ca-staff"],
      [MANAGER, "ca-manager"],
      [SERVICE, "ca-service"]
    ]);
    await seedTenant(TENANT_B, "tenant-ca-b", [
      [STAFF_B, "cb-staff"],
      [SERVICE_B, "cb-service"]
    ]);
    await configureTenant(TENANT_A, STAFF, SERVICE);
    await configureTenant(TENANT_B, STAFF_B, SERVICE_B);
  }, 60000);

  // ---------------------------------------------------------------------------
  describe("the quote and the decision", () => {
    test("a window's share of what was PAID: 100% from 7 days, 50% from 2 days, nothing closer", async () => {
      const fx = await newFixture();
      await policy(fx.productId);

      const full = await book(fx);
      await pay(full.orderId, "1000000.00");
      const a = await cancelled(full.reservationId, { hoursBefore: 200 });
      expect(a.decision).toMatchObject({
        policySource: "product",
        policyVersion: 1,
        hoursBeforeStart: 200,
        refundablePercent: "100.00",
        amountPaid: "1000000.00",
        computedRefund: "1000000.00",
        finalRefund: "1000000.00",
        overridden: false
      });

      const fx2 = await newFixture();
      await policy(fx2.productId);
      const half = await book(fx2);
      await pay(half.orderId, "1000000.00");
      const b = await cancelled(half.reservationId, { hoursBefore: 100 });
      expect(b.decision).toMatchObject({
        hoursBeforeStart: 100,
        refundablePercent: "50.00",
        computedRefund: "500000.00",
        finalRefund: "500000.00"
      });

      const fx3 = await newFixture();
      await policy(fx3.productId);
      const none = await book(fx3);
      await pay(none.orderId, "1000000.00");
      const c = await cancelled(none.reservationId, { hoursBefore: 10 });
      expect(c.decision).toMatchObject({
        refundablePercent: "0.00",
        computedRefund: "0.00",
        finalRefund: "0.00",
        returnId: null
      });
    });

    test("the exact window boundary: one hour either side of 48 hours", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const link = (await inTenant((tx) =>
        fetchReservationLinkByReservationId(tx, TENANT_A, view.reservationId)
      ))!;
      const port = await composedBookingPort();
      const startsAt = await startsAtOf(view.reservationId);
      const quoteAt = async (hours: number) => {
        const outcome = await inTenant((tx) =>
          computeCancellationQuote(tx, TENANT_A, link, port, {
            now: new Date(startsAt - hours * HOUR),
            staff: true
          })
        );
        if (!outcome.ok) throw new Error("quote refused");
        return outcome.value.quote;
      };
      expect((await quoteAt(48)).computedRefund).toBe("500000.00");
      expect((await quoteAt(47)).computedRefund).toBe("0.00");
      // 47 hours and 59 minutes is 47 whole hours, floored.
      const nearly = await inTenant((tx) =>
        computeCancellationQuote(tx, TENANT_A, link, port, {
          now: new Date(startsAt - 48 * HOUR + 60_000),
          staff: true
        })
      );
      expect(nearly.ok && nearly.value.quote.hoursBeforeStart).toBe(47);
      expect((await quoteAt(168)).computedRefund).toBe("1000000.00");
      expect((await quoteAt(167)).computedRefund).toBe("500000.00");
    });

    test("a start in the past refunds nothing and the quote says so", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const result = await cancelled(view.reservationId, { hoursBefore: -5 });
      expect(result.decision).toMatchObject({
        hoursBeforeStart: -5,
        refundablePercent: "0.00",
        computedRefund: "0.00",
        finalRefund: "0.00"
      });
    });

    test("deposit-only: the share of the deposit paid, not of the total", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      await inTenant((tx) =>
        setProductDepositPolicy(tx, TENANT_A, STAFF, fx.productId, {
          kind: "percent",
          percent: "30.00"
        })
      );
      const view = await book(fx, { req: { paymentMethod: "dp" } });
      await pay(view.orderId, "300000.00");
      const result = await cancelled(view.reservationId, { hoursBefore: 100 });
      expect(result.decision).toMatchObject({
        amountPaid: "300000.00",
        computedRefund: "150000.00",
        finalRefund: "150000.00"
      });
      const legs = await legsOf(result.decision.returnId!);
      expect(legs.map((leg) => leg.amount)).toEqual(["150000.00"]);
    });

    test("zero paid: a decision row with no return, no legs, and the unpaid order is cancelled", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      expect(await orderStatus(view.orderId)).toBe("pending_payment");
      const result = await cancelled(view.reservationId, { hoursBefore: 200 });
      expect(result.decision).toMatchObject({
        amountPaid: "0.00",
        computedRefund: "0.00",
        finalRefund: "0.00",
        returnId: null
      });
      expect(await orderStatus(view.orderId)).toBe("cancelled");
      expect(await reservationStatus(view.reservationId)).toBe("cancelled");
      const returns = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_returns WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      expect(returns[0]!.n).toBe(0);
    });

    test("no policy at all: refund 0 with policy_source none and the decision still records why", async () => {
      const fx = await newFixture();
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const result = await cancelled(view.reservationId, { hoursBefore: 1000 });
      expect(result.decision).toMatchObject({
        policySource: "none",
        policyId: null,
        policyVersion: null,
        refundablePercent: "0.00",
        amountPaid: "1000000.00",
        computedRefund: "0.00",
        finalRefund: "0.00"
      });
      // The money stays on the order as ordinary settled revenue; the order is not edited.
      expect(await orderStatus(view.orderId)).toBe("paid");
    });

    test("a per-night policy judges each night by the notice before its own start", async () => {
      const fx = await newFixture();
      await policy(
        fx.productId,
        [
          { minHoursBeforeStart: 72, refundablePercent: "100.00" },
          { minHoursBeforeStart: 24, refundablePercent: "50.00" }
        ],
        { basis: "per_night" }
      );
      const view = await book(fx, {
        req: { stay: { checkInDate: D(10), checkOutDate: D(13) } }
      });
      await pay(view.orderId, "1500000.00");
      // 3 nights, 500,000 each; 30h before arrival: night 1 (30h) 50%, night 2 (54h) 50%, night 3 (78h) 100%.
      const result = await cancelled(view.reservationId, { hoursBefore: 30 });
      expect(result.decision.computedRefund).toBe("1000000.00");
      expect(result.decision.refundablePercent).toBe("66.67");
    });

    test("the quote is a read: it writes nothing and a decided reservation is INVALID_STATE", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const port = await composedBookingPort();
      const link = (await inTenant((tx) =>
        fetchReservationLinkByReservationId(tx, TENANT_A, view.reservationId)
      ))!;
      const before = await decisionRows();
      const quote = await inTenant((tx) =>
        computeCancellationQuote(tx, TENANT_A, link, port, {
          now: new Date(),
          staff: false
        })
      );
      expect(quote.ok).toBe(true);
      expect(await decisionRows()).toEqual(before);
      expect(await reservationStatus(view.reservationId)).toBe("held");

      await cancelled(view.reservationId);
      const after = await inTenant((tx) =>
        fetchReservationLinkByReservationId(tx, TENANT_A, view.reservationId)
      );
      const again = await inTenant((tx) =>
        computeCancellationQuote(tx, TENANT_A, after!, port, {
          now: new Date(),
          staff: true
        })
      );
      expect(again).toEqual({
        ok: false,
        refusal: { code: "INVALID_STATE", reason: "released" }
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe("the version applied is the one in force when the booking was made (C-37)", () => {
    test("a later version never changes what the guest was promised", async () => {
      const fx = await newFixture();
      const v1 = await policy(fx.productId);
      const early = await book(fx);
      await pay(early.orderId, "1000000.00");

      // v2 refunds nothing at all; it retires v1.
      const v2 = await policy(fx.productId, [
        { minHoursBeforeStart: 0, refundablePercent: "0.00" }
      ]);
      expect(v2.version).toBe(2);

      const fx2 = await newFixture();
      // A booking made AFTER v2 would be judged by v2 - a second product with v2 first.
      const v1b = await policy(fx2.productId);
      const first = await book(fx2);
      await pay(first.orderId, "1000000.00");
      await policy(fx2.productId, [
        { minHoursBeforeStart: 0, refundablePercent: "0.00" }
      ]);

      const a = await cancelled(first.reservationId, { hoursBefore: 200 });
      expect(a.decision.policyId).toBe(v1b.id);
      expect(a.decision.policyVersion).toBe(1);
      expect(a.decision.computedRefund).toBe("1000000.00");

      // The booking made while v1 of the first product was in force.
      const b = await cancelled(early.reservationId, { hoursBefore: 200 });
      expect(b.decision.policyId).toBe(v1.id);
      expect(b.decision.computedRefund).toBe("1000000.00");

      // A new booking made after v2 is judged by v2.
      const late = await book(fx);
      await pay(late.orderId, "1000000.00");
      const c = await cancelled(late.reservationId, { hoursBefore: 200 });
      expect(c.decision.policyVersion).toBe(2);
      expect(c.decision.computedRefund).toBe("0.00");
    });

    test("a booking made while no policy applied keeps 'none' even when a policy is activated later", async () => {
      const fx = await newFixture();
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      await policy(fx.productId);
      const result = await cancelled(view.reservationId, { hoursBefore: 500 });
      expect(result.decision).toMatchObject({
        policySource: "none",
        computedRefund: "0.00"
      });
    });

    test("the product's policy beats the tenant default; with no product policy the default applies", async () => {
      const fxDefault = await newFixture();
      const fxOwn = await newFixture();
      const tenantDefault = await policy(null, [
        { minHoursBeforeStart: 0, refundablePercent: "20.00" }
      ]);
      const own = await policy(fxOwn.productId, [
        { minHoursBeforeStart: 0, refundablePercent: "80.00" }
      ]);
      const a = await book(fxDefault);
      const b = await book(fxOwn);
      await pay(a.orderId, "1000000.00");
      await pay(b.orderId, "1000000.00");
      const ra = await cancelled(a.reservationId, { hoursBefore: 10 });
      const rb = await cancelled(b.reservationId, { hoursBefore: 10 });
      expect(ra.decision).toMatchObject({
        policySource: "tenant_default",
        policyId: tenantDefault.id,
        computedRefund: "200000.00"
      });
      expect(rb.decision).toMatchObject({
        policySource: "product",
        policyId: own.id,
        computedRefund: "800000.00"
      });
    });

    test("across a reschedule chain the ORIGINAL arrival and the original booking's version apply", async () => {
      const fx = await newFixture();
      const v1 = await policy(fx.productId);
      const original = await book(fx);
      await pay(original.orderId, "1000000.00");
      await dispatch();
      // Move the stay a month later (the port's own reschedule), then relink as #382 will.
      const port = await composedBookingPort();
      const moved = await inTenant(async (tx) =>
        port.reschedule(tx, {
          tenantId: TENANT_A,
          reservationId: original.reservationId,
          stay: { checkInDate: D(40), checkOutDate: D(42) },
          idempotencyKey: "resched-1",
          correlationId: crypto.randomUUID(),
          actorTenantUserId: STAFF
        })
      );
      if (!moved.ok) throw new Error(`reschedule refused: ${moved.reason}`);
      const oldLink = await linkOf(original.reservationId);
      const admin = getAdminSql();
      await admin`
        UPDATE awcms_commerce_booking_reservation_links
        SET status = 'superseded' WHERE id = ${oldLink.id as string}
      `;
      const newLinkId = crypto.randomUUID();
      await admin`
        INSERT INTO awcms_commerce_booking_reservation_links
          (id, tenant_id, order_id, order_item_id, reservation_id, offering_link_id,
           supersedes_link_id, client_key, request_hash)
        VALUES (${newLinkId}, ${TENANT_A}, ${oldLink.order_id as string},
                ${oldLink.order_item_id as string}, ${moved.reservationId},
                ${oldLink.offering_link_id as string}, ${oldLink.id as string},
                ${`chain-${newLinkId}`}, 'h')
      `;
      // A new, generous version is activated after the original booking.
      await policy(fx.productId, [
        { minHoursBeforeStart: 0, refundablePercent: "100.00" }
      ]);

      // 100 hours before the ORIGINAL arrival (the moved stay is a month away):
      // the original window (50%) applies, not the new reservation's far-future 100%.
      const result = await cancelled(moved.reservationId, {
        hoursBefore: 100,
        rootReservationId: original.reservationId
      });
      expect(result.decision.policyId).toBe(v1.id);
      expect(result.decision.hoursBeforeStart).toBe(100);
      expect(result.decision.computedRefund).toBe("500000.00");
    });
  });

  // ---------------------------------------------------------------------------
  describe("the refund legs (ADR-0033 through the existing tables)", () => {
    test("the legs are a return of kind cancellation with ONE line, pending, under the service account, and nothing is settled", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const result = await cancelled(view.reservationId, { hoursBefore: 100 });
      const returnId = result.decision.returnId!;

      const returns = (await getAdminSql()`
        SELECT kind, status, goods_gross, discount_share, shipping_refund,
               tax_refund, refund_total, actor_tenant_user_id
        FROM awcms_commerce_returns WHERE id = ${returnId}
      `) as Record<string, string>[];
      expect(returns[0]).toMatchObject({
        kind: "cancellation",
        status: "open",
        goods_gross: "500000.00",
        refund_total: "500000.00",
        actor_tenant_user_id: SERVICE
      });
      // No shipping and no separate tax share: refund_total IS the final refund.
      expect(Number(returns[0]!.discount_share)).toBe(0);
      expect(Number(returns[0]!.shipping_refund)).toBe(0);
      expect(Number(returns[0]!.tax_refund)).toBe(0);
      const lines = (await getAdminSql()`
        SELECT reason, disposition, stock_effect, refund_amount
        FROM awcms_commerce_return_lines WHERE return_id = ${returnId}
      `) as Record<string, unknown>[];
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        reason: "booking_cancelled",
        disposition: "not_applicable",
        stock_effect: 0,
        refund_amount: "500000.00"
      });
      const legs = await legsOf(returnId);
      expect(legs).toHaveLength(1);
      expect(legs[0]).toMatchObject({
        amount: "500000.00",
        status: "pending",
        tender_type: "manual_qris",
        actor_tenant_user_id: SERVICE
      });
      // Nothing was settled by the cancel: no reversal in the payment ledger.
      const reversals = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_payment_allocations
        WHERE tenant_id = ${TENANT_A} AND kind = 'reversal'
      `) as { n: number }[];
      expect(reversals[0]!.n).toBe(0);
      // The decision names the return once.
      expect((await decisionRows())[0]!.return_id).toBe(returnId);
      // The order is not edited; the return announced itself on the order stream.
      expect(await orderStatus(view.orderId)).toBe("paid");
      const events = (await getAdminSql()`
        SELECT to_status FROM awcms_commerce_order_events
        WHERE order_id = ${view.orderId} AND return_id = ${returnId}
      `) as { to_status: string }[];
      expect(events.map((e) => e.to_status)).toEqual(["returned"]);
    });

    test("the existing execute path settles a pending leg (ledger reversal, return completed) - the cancel itself never does", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const result = await cancelled(view.reservationId, { hoursBefore: 100 });
      const returnId = result.decision.returnId!;
      const leg = (await legsOf(returnId))[0]!;

      const outcome = await executeRefund(
        getRuntimeSql(),
        TENANT_A,
        {
          returnId,
          refundId: leg.id,
          actorTenantUserId: MANAGER,
          registerSessionId: null
        },
        { provider: null }
      );
      expect(outcome.kind).toBe("settled");
      const settled = (await legsOf(returnId))[0]!;
      expect(settled.status).toBe("succeeded");
      const carried = await inTenant((tx) =>
        fetchDecisionReturn(tx, TENANT_A, result.decision)
      );
      expect(carried?.status).toBe("completed");
    });

    test("legs never exceed what each payment can give back: two payments, newest first, summing to the final refund", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "400000.00");
      await pay(view.orderId, "600000.00");
      const result = await cancelled(view.reservationId, { hoursBefore: 200 });
      expect(result.decision.finalRefund).toBe("1000000.00");
      const legs = await legsOf(result.decision.returnId!);
      expect(legs.map((leg) => leg.amount).sort()).toEqual([
        "400000.00",
        "600000.00"
      ]);
      const total = legs.reduce((sum, leg) => sum + Number(leg.amount), 0);
      expect(total).toBe(1_000_000);
      // Each leg is within its own payment.
      const payments = (await getAdminSql()`
        SELECT id, amount FROM awcms_commerce_payment_allocations
        WHERE tenant_id = ${TENANT_A} AND order_id = ${view.orderId} AND kind = 'payment'
      `) as { id: string; amount: string }[];
      for (const leg of legs) {
        const source = payments.find((p) => p.id === leg.allocation_id)!;
        expect(Number(leg.amount)).toBeLessThanOrEqual(Number(source.amount));
      }
    });

    test("after a partial reversal the ceiling is what is LEFT: amount paid is net, the legs fit inside it", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const payment = (await getAdminSql()`
        SELECT id FROM awcms_commerce_payment_allocations
        WHERE tenant_id = ${TENANT_A} AND order_id = ${view.orderId} AND kind = 'payment'
      `) as { id: string }[];
      await inTenant((tx) =>
        recordPaymentReversal(tx, TENANT_A, {
          orderId: view.orderId,
          allocationId: payment[0]!.id,
          amount: "300000.00",
          note: "goodwill",
          sourceKey: "test-reversal-1",
          actor: { kind: "tenant_user", tenantUserId: STAFF }
        })
      );
      const result = await cancelled(view.reservationId, { hoursBefore: 100 });
      expect(result.decision).toMatchObject({
        amountPaid: "700000.00",
        computedRefund: "350000.00",
        finalRefund: "350000.00"
      });
      // A full-refund override can reach 700,000, never 1,000,000.
      const fx2 = await newFixture();
      await policy(fx2.productId);
      const view2 = await book(fx2);
      await pay(view2.orderId, "1000000.00");
      const payment2 = (await getAdminSql()`
        SELECT id FROM awcms_commerce_payment_allocations
        WHERE tenant_id = ${TENANT_A} AND order_id = ${view2.orderId} AND kind = 'payment'
      `) as { id: string }[];
      await inTenant((tx) =>
        recordPaymentReversal(tx, TENANT_A, {
          orderId: view2.orderId,
          allocationId: payment2[0]!.id,
          amount: "300000.00",
          note: "goodwill",
          sourceKey: "test-reversal-2",
          actor: { kind: "tenant_user", tenantUserId: STAFF }
        })
      );
      const tooMuch = await cancel(view2.reservationId, {
        hoursBefore: 100,
        override: override("1000000.00")
      });
      expect(tooMuch).toEqual({
        kind: "refused",
        refusal: { code: "REFUND_EXCEEDS_PAID", amountPaid: "700000.00" }
      });
      expect(await reservationStatus(view2.reservationId)).toBe("held");
      const exactly = await cancelled(view2.reservationId, {
        hoursBefore: 100,
        override: override("700000.00")
      });
      expect(exactly.decision.finalRefund).toBe("700000.00");
    });

    test("the database refuses a leg above its payment and a decision above the amount paid, whoever writes", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const result = await cancelled(view.reservationId, { hoursBefore: 100 });
      const returnId = result.decision.returnId!;
      const leg = (await legsOf(returnId))[0]!;
      // The payment can still give back 500,000 (the leg promises the other half).
      const overLeg = await attemptSql(
        getAdminSql()`
          INSERT INTO awcms_commerce_refunds
            (tenant_id, return_id, order_id, allocation_id, tender_type, amount, status, source_key, actor_tenant_user_id)
          VALUES (${TENANT_A}, ${returnId}, ${view.orderId}, ${leg.allocation_id},
                  'manual_qris', 500000.01, 'pending', 'over-1', ${SERVICE})
        `
      );
      expect(overLeg).not.toBeNull();
      // final_refund above amount_paid: the table's last line of defence.
      const fx2 = await newFixture();
      const view2 = await book(fx2);
      const link = await linkOf(view2.reservationId);
      const overDecision = await attemptSql(
        getAdminSql()`
          INSERT INTO awcms_commerce_booking_refund_decisions
            (tenant_id, order_id, reservation_link_id, trigger_kind, actor_kind,
             actor_tenant_user_id, policy_source, hours_before_start,
             refundable_percent, amount_paid, computed_refund, final_refund,
             override_reason, override_actor_tenant_user_id, override_stepup_at, source_key)
          VALUES (${TENANT_A}, ${view2.orderId}, ${link.id as string}, 'staff_cancel', 'staff',
                  ${STAFF}, 'none', 5, 0, 100.00, 0, 100.01,
                  'a reason that is long enough', ${MANAGER}, now(), 'x-over')
        `
      );
      expect(overDecision).not.toBeNull();
      expect(await decisionRows()).toHaveLength(1);
    });

    test("the cancellation return and its line are not reachable through the generic returns validation", () => {
      const result = validateCreateReturnInput(
        {
          kind: "cancellation",
          lines: [
            {
              orderItemId: "11111111-1111-4111-8111-111111111111",
              quantity: 1,
              reason: "booking_cancelled",
              disposition: "not_applicable"
            }
          ]
        },
        "key-1"
      );
      expect(result.valid).toBe(false);
    });

    test("the generic returns path still refuses a paid booking order (BOOKING_ORDER_USE_ADAPTER)", async () => {
      const fx = await newFixture();
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const item = (await getAdminSql()`
        SELECT id FROM awcms_commerce_order_items WHERE order_id = ${view.orderId}
      `) as { id: string }[];
      const outcome = await inTenant((tx) =>
        createReturn(
          tx,
          TENANT_A,
          STAFF,
          view.orderId,
          {
            idempotencyKey: "ret-1",
            kind: "return",
            note: null,
            exchangeOrderId: null,
            lines: [
              {
                orderItemId: item[0]!.id,
                quantity: 1,
                reason: "other",
                disposition: "quarantine",
                note: null
              }
            ],
            refund: null
          },
          new Date()
        )
      );
      expect(outcome.kind).toBe("booking_order");
    });
  });

  // ---------------------------------------------------------------------------
  describe("the override (Q10, C-40)", () => {
    test("an override changes the amount, never above what was paid, and records its evidence", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const stepUpAt = new Date();
      const result = await cancelled(view.reservationId, {
        hoursBefore: 10, // computed: 0
        override: override("750000.00", { stepUpAt })
      });
      expect(result.decision).toMatchObject({
        computedRefund: "0.00",
        finalRefund: "750000.00",
        overridden: true,
        triggerKind: "staff_cancel",
        actorKind: "staff"
      });
      const row = (await decisionRows())[0]!;
      expect(row.override_reason).toBe(
        "Owner approved a goodwill refund after a complaint"
      );
      expect(row.override_actor_tenant_user_id).toBe(MANAGER);
      expect(row.actor_tenant_user_id).toBe(STAFF);
      expect(new Date(row.override_stepup_at as string).getTime()).toBe(
        stepUpAt.getTime()
      );
      const legs = await legsOf(result.decision.returnId!);
      expect(legs.map((leg) => leg.amount)).toEqual(["750000.00"]);
    });

    test("above the amount paid is REFUND_EXCEEDS_PAID and nothing is cancelled or written", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "600000.00");
      const refused = await cancel(view.reservationId, {
        hoursBefore: 200,
        override: override("600000.01")
      });
      expect(refused).toEqual({
        kind: "refused",
        refusal: { code: "REFUND_EXCEEDS_PAID", amountPaid: "600000.00" }
      });
      expect(await reservationStatus(view.reservationId)).toBe("held");
      expect((await linkOf(view.reservationId)).status).toBe("active");
      expect(await decisionRows()).toHaveLength(0);
      // The cap itself is allowed.
      const ok = await cancelled(view.reservationId, {
        hoursBefore: 10,
        override: override("600000.00")
      });
      expect(ok.decision.finalRefund).toBe("600000.00");
    });

    test("an override equal to the computed refund is not an override", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const refused = await cancel(view.reservationId, {
        hoursBefore: 100,
        override: override("500000.00")
      });
      expect(refused).toEqual({
        kind: "refused",
        refusal: { code: "OVERRIDE_NOT_A_CHANGE", computedRefund: "500000.00" }
      });
      expect(await decisionRows()).toHaveLength(0);
    });

    test("the override writes exactly one CRITICAL audit event naming the actor and both figures, and no reason text", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      await cancelled(view.reservationId, {
        hoursBefore: 10,
        override: override("250000.00")
      });
      const link = await linkOf(view.reservationId);
      const events = await auditActions(link.id as string);
      const overridden = events.filter(
        (event) =>
          event.action === "commerce.booking_refund_decision.overridden"
      );
      expect(overridden).toHaveLength(1);
      expect(overridden[0]!.severity).toBe("critical");
      expect(overridden[0]!.attributes).toMatchObject({
        computedRefund: "0.00",
        finalRefund: "250000.00",
        amountPaid: "1000000.00"
      });
      expect(JSON.stringify(overridden[0]!.attributes)).not.toContain(
        "goodwill"
      );
      const actor = (await getAdminSql()`
        SELECT actor_tenant_user_id FROM awcms_audit_events
        WHERE resource_id = ${link.id as string}
          AND action = 'commerce.booking_refund_decision.overridden'
      `) as { actor_tenant_user_id: string }[];
      expect(actor[0]!.actor_tenant_user_id).toBe(MANAGER);
      // A plain cancel writes no override event.
      const fx2 = await newFixture();
      await policy(fx2.productId);
      const plain = await book(fx2);
      await pay(plain.orderId, "1000000.00");
      await cancelled(plain.reservationId, { hoursBefore: 100 });
      const plainLink = await linkOf(plain.reservationId);
      expect(
        (await auditActions(plainLink.id as string))
          .map((e) => e.action)
          .filter((action) => action.startsWith("commerce.booking_"))
          .sort()
      ).toEqual([
        "commerce.booking_refund_decision.recorded",
        "commerce.booking_reservation.cancelled"
      ]);
    });

    test("the table stores an override only with a complete evidence set, and only the staff reason lengths", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const link = await linkOf(view.reservationId);
      const insert = (
        finalRefund: string,
        reason: string | null,
        overrider: string | null,
        stepUp: string | null,
        sourceKey: string
      ) =>
        attemptSql(
          getAdminSql().unsafe(
            `INSERT INTO awcms_commerce_booking_refund_decisions
               (tenant_id, order_id, reservation_link_id, trigger_kind, actor_kind,
                actor_tenant_user_id, policy_source, hours_before_start,
                refundable_percent, amount_paid, computed_refund, final_refund,
                override_reason, override_actor_tenant_user_id, override_stepup_at, source_key)
             VALUES ('${TENANT_A}', '${view.orderId}', '${link.id as string}', 'staff_cancel', 'staff',
                     '${STAFF}', 'none', 5, 0, 1000000.00, 0, ${finalRefund},
                     ${reason === null ? "NULL" : `'${reason}'`},
                     ${overrider === null ? "NULL" : `'${overrider}'`},
                     ${stepUp === null ? "NULL" : `'${stepUp}'`}, '${sourceKey}')`
          )
        );
      // final differs from computed with no reason / actor / step-up: refused.
      expect(await insert("10.00", null, null, null, "a1")).not.toBeNull();
      expect(
        await insert("10.00", "long enough reason", MANAGER, null, "a2")
      ).not.toBeNull();
      expect(
        await insert("10.00", "short", MANAGER, new Date().toISOString(), "a3")
      ).not.toBeNull();
      // A reason on an amount that was NOT changed is refused too.
      expect(
        await insert(
          "0.00",
          "long enough reason",
          MANAGER,
          new Date().toISOString(),
          "a4"
        )
      ).not.toBeNull();
      expect(await decisionRows()).toHaveLength(0);
      expect(
        await insert(
          "10.00",
          "long enough reason",
          MANAGER,
          new Date().toISOString(),
          "a5"
        )
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe("idempotency and concurrency (G5, C-10)", () => {
    test("the same key and request replays the same decision and writes nothing more", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const first = await cancelled(view.reservationId, {
        key: "dup-key",
        hoursBefore: 100
      });
      expect(first.kind).toBe("cancelled");
      const again = await cancelled(view.reservationId, {
        key: "dup-key",
        hoursBefore: 100
      });
      expect(again.kind).toBe("replayed");
      expect(again.decision).toEqual(first.decision);
      expect(await decisionRows()).toHaveLength(1);
      const returns = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_returns WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      expect(returns[0]!.n).toBe(1);
      expect(await legsOf(first.decision.returnId!)).toHaveLength(1);
    });

    test("the same key with a different request is IDEMPOTENCY_CONFLICT; another key on a decided reservation is INVALID_STATE", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      await cancelled(view.reservationId, {
        key: "k-a",
        hoursBefore: 100,
        reasonCode: "guest_request"
      });
      const conflict = await cancel(view.reservationId, {
        key: "k-a",
        hoursBefore: 100,
        reasonCode: "another_reason"
      });
      expect(conflict).toEqual({
        kind: "refused",
        refusal: { code: "IDEMPOTENCY_CONFLICT" }
      });
      const decided = await cancel(view.reservationId, {
        key: "k-b",
        hoursBefore: 100
      });
      expect(decided).toEqual({
        kind: "refused",
        refusal: { code: "INVALID_STATE", reason: "released" }
      });
      expect(await decisionRows()).toHaveLength(1);
    });

    test("the key is namespaced by who asks: another actor's identical key is a different request", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const first = await cancelled(view.reservationId, {
        key: "shared",
        hoursBefore: 100
      });
      // A guest presenting the same raw key does not replay the staff's decision.
      const guest = await cancel(view.reservationId, {
        key: "shared",
        actor: guestActor(),
        ack: "500000.00",
        hoursBefore: 100
      });
      expect(guest.kind).toBe("refused");
      expect(guest).toEqual({
        kind: "refused",
        refusal: { code: "INVALID_STATE", reason: "released" }
      });
      expect(first.kind).toBe("cancelled");
    });

    test("concurrent cancels with DIFFERENT keys produce a single decision and a single return", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          cancel(view.reservationId, { key: `race-${i}`, hoursBefore: 100 })
        )
      );
      const winners = outcomes.filter(
        (outcome) => outcome.kind === "cancelled"
      );
      expect(winners).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.kind === "refused") {
          expect(outcome.refusal).toEqual({
            code: "INVALID_STATE",
            reason: "released"
          });
        }
      }
      expect(await decisionRows()).toHaveLength(1);
      const returns = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_returns WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      expect(returns[0]!.n).toBe(1);
      const legs = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_refunds WHERE tenant_id = ${TENANT_A}
      `) as { n: number }[];
      expect(legs[0]!.n).toBe(1);
    });

    test("concurrent cancels with the SAME key produce one decision; the others replay it", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () =>
          cancel(view.reservationId, { key: "same-race", hoursBefore: 100 })
        )
      );
      expect(outcomes.filter((o) => o.kind === "cancelled")).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === "replayed")).toHaveLength(3);
      const decisions = new Set(
        outcomes.map((o) => (o.kind === "refused" ? "x" : o.decision.id))
      );
      expect(decisions.size).toBe(1);
      expect(await decisionRows()).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe("the customer path", () => {
    test("a stale acknowledged figure is QUOTE_CHANGED with the new figure and nothing cancelled", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const stale = await cancel(view.reservationId, {
        actor: guestActor(),
        ack: "1000000.00",
        hoursBefore: 100
      });
      expect(stale).toEqual({
        kind: "refused",
        refusal: { code: "QUOTE_CHANGED", computedRefund: "500000.00" }
      });
      expect(await reservationStatus(view.reservationId)).toBe("held");
      expect((await linkOf(view.reservationId)).status).toBe("active");
      expect(await decisionRows()).toHaveLength(0);

      const good = await cancelled(view.reservationId, {
        actor: guestActor(),
        ack: "500000.00",
        hoursBefore: 100
      });
      expect(good.decision).toMatchObject({
        triggerKind: "customer_cancel",
        actorKind: "customer",
        finalRefund: "500000.00"
      });
      const row = (await decisionRows())[0]!;
      // X7: a customer is never stored on the decision.
      expect(row.actor_tenant_user_id).toBeNull();
      expect(row.override_reason).toBeNull();
      // The legs run under the service account, not a person.
      const legs = await legsOf(good.decision.returnId!);
      expect(legs[0]!.actor_tenant_user_id).toBe(SERVICE);
    });

    test("the audit entry of a customer cancel names no person: actor kind system, initiated by customer", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      await cancelled(view.reservationId, {
        actor: guestActor(),
        ack: "500000.00",
        hoursBefore: 100
      });
      const link = await linkOf(view.reservationId);
      const rows = (await getAdminSql()`
        SELECT actor_tenant_user_id, attributes FROM awcms_audit_events
        WHERE resource_id = ${link.id as string}
          AND action = 'commerce.booking_reservation.cancelled'
      `) as {
        actor_tenant_user_id: string | null;
        attributes: Record<string, unknown>;
      }[];
      expect(rows[0]!.actor_tenant_user_id).toBeNull();
      expect(rows[0]!.attributes).toMatchObject({
        actorKind: "system",
        initiatedBy: "customer"
      });
    });

    test("without a service account a customer cancel is refused before anything is written; a staff cancel of an unpaid order still works", async () => {
      await resetDatabase();
      await seedTenant(TENANT_A, "tenant-ca-a", [
        [STAFF, "ca-staff"],
        [MANAGER, "ca-manager"],
        [SERVICE, "ca-service"]
      ]);
      await configureTenant(TENANT_A, STAFF, null);
      // Linking needs the service account; set it, book, then clear it.
      await inTenant((tx) =>
        saveBookingServiceTenantUserId(tx, TENANT_A, SERVICE)
      );
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      await inTenant((tx) =>
        saveBookingServiceTenantUserId(tx, TENANT_A, null)
      );
      const refused = await cancel(view.reservationId, {
        actor: guestActor(),
        ack: "500000.00",
        hoursBefore: 100
      });
      expect(refused).toEqual({
        kind: "refused",
        refusal: { code: "SERVICE_ACTOR_NOT_CONFIGURED" }
      });
      // Staff, with a refund to plan: the legs need the system actor too.
      const staffPaid = await cancel(view.reservationId, { hoursBefore: 100 });
      expect(staffPaid).toEqual({
        kind: "refused",
        refusal: { code: "SERVICE_ACTOR_NOT_CONFIGURED" }
      });
      expect(await reservationStatus(view.reservationId)).toBe("held");
      expect(await decisionRows()).toHaveLength(0);
    });

    test("ownership is part of the query: another customer's code or a wrong phone finds no link (C-32)", async () => {
      const fx = await newFixture();
      const view = await book(fx);
      const find = (
        identity: Parameters<typeof fetchReservationLinkForOrderCode>[3]
      ) =>
        inTenant((tx) =>
          fetchReservationLinkForOrderCode(
            tx,
            TENANT_A,
            view.orderCode,
            identity
          )
        );
      expect(
        await find({ kind: "phone", phone: "+6281311112222" })
      ).not.toBeNull();
      expect(await find({ kind: "phone", phone: "+6281399990000" })).toBeNull();
      expect(
        await find({
          kind: "customer",
          customerId: "00000000-0000-4000-8000-000000000999"
        })
      ).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe("Booking, the order and the consumers", () => {
    test("Booking's cancelled event finds no active link: our own cancel raises no attention flag", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      await dispatch();
      expect(await reservationStatus(view.reservationId)).toBe("confirmed");
      await cancelled(view.reservationId, { hoursBefore: 100 });
      expect(await reservationStatus(view.reservationId)).toBe("cancelled");
      await dispatch();
      const link = await linkOf(view.reservationId);
      expect(link.status).toBe("released");
      expect(link.attention_reason).toBeNull();
      // The order is not cancelled by the event either: money stays as revenue.
      expect(await orderStatus(view.orderId)).toBe("paid");
    });

    test("the decision event carries ids, the policy source and amounts - never a person or the reason", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const result = await cancelled(view.reservationId, {
        hoursBefore: 10,
        override: override("100000.00")
      });
      const events = (await getAdminSql()`
        SELECT event_type, aggregate_id, payload FROM awcms_domain_events
        WHERE aggregate_id = ${view.orderId}
          AND event_type = 'awcms.commerce.booking_refund.decided'
      `) as { event_type: string; payload: Record<string, unknown> }[];
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({
        decisionId: result.decision.id,
        orderId: view.orderId,
        reservationId: view.reservationId,
        triggerKind: "staff_cancel",
        policySource: "product",
        amountPaid: "1000000.00",
        computedRefund: "0.00",
        finalRefund: "100000.00",
        overridden: true
      });
    });

    test("a reservation Booking cancelled outside the adapter, with money behind it, is settled by STAFF through the same decision; a guest cannot", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      await dispatch();
      // A staff member cancels in Booking's own screen.
      const port = await composedBookingPort();
      await inTenant((tx) =>
        port.cancel(tx, {
          tenantId: TENANT_A,
          reservationId: view.reservationId,
          idempotencyKey: "external-cancel",
          correlationId: crypto.randomUUID(),
          actorTenantUserId: STAFF,
          reasonCode: "external"
        })
      );
      await dispatch();
      const flagged = await linkOf(view.reservationId);
      expect(flagged.attention_reason).toBe("cancelled_externally_paid");

      const guest = await cancel(view.reservationId, {
        actor: guestActor(),
        ack: "0.00",
        hoursBefore: 100
      });
      expect(guest).toEqual({
        kind: "refused",
        refusal: { code: "INVALID_STATE", reason: "cancelled" }
      });
      const staff = await cancelled(view.reservationId, {
        hoursBefore: 100,
        override: override("1000000.00")
      });
      expect(staff.decision.finalRefund).toBe("1000000.00");
      const after = await linkOf(view.reservationId);
      expect(after.status).toBe("released");
      // The operator-queue item is resolved by the decision.
      expect(after.attention_resolved_at).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe("policy versions", () => {
    test("a draft is not in force; approving it retires the previous version and records the approver; the history stays", async () => {
      const fx = await newFixture();
      const draft = await inTenant((tx) =>
        createPolicyDraft(
          tx,
          TENANT_A,
          STAFF,
          {
            productId: fx.productId,
            refundBasis: "whole_stay",
            noShowRetention: "retain_deposit",
            windows: STANDARD_WINDOWS
          },
          nextKey()
        )
      );
      if (draft.kind === "refused") throw new Error("refused");
      expect(draft.policy).toMatchObject({
        version: 1,
        status: "draft",
        createdByTenantUserId: STAFF,
        approvedByTenantUserId: null,
        activatedAt: null
      });
      // A draft decides nothing.
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const v1 = await policy(fx.productId);
      expect(v1.version).toBe(2);
      expect(v1).toMatchObject({
        status: "active",
        createdByTenantUserId: STAFF,
        approvedByTenantUserId: MANAGER
      });
      const v2 = await policy(fx.productId, [
        { minHoursBeforeStart: 0, refundablePercent: "10.00" }
      ]);
      const list = await inTenant((tx) =>
        listPolicies(tx, TENANT_A, { kind: "product", productId: fx.productId })
      );
      expect(list.map((p) => [p.version, p.status])).toEqual([
        [3, "active"],
        [1, "draft"],
        [2, "retired"]
      ]);
      expect(list[0]!.id).toBe(v2.id);
      expect(list[2]!.retiredAt).not.toBeNull();
      // The booking made before any version was active keeps 'none'.
      const result = await cancelled(view.reservationId, { hoursBefore: 500 });
      expect(result.decision.policySource).toBe("none");
    });

    test("approving a version that is not a draft, and approving twice, are refused or replayed - never a second activation", async () => {
      const fx = await newFixture();
      const v1 = await policy(fx.productId);
      const again = await inTenant((tx) =>
        approvePolicy(tx, TENANT_A, MANAGER, v1.id, nextKey())
      );
      expect(again).toEqual({ kind: "not_a_draft", status: "active" });
      const unknown = await inTenant((tx) =>
        approvePolicy(
          tx,
          TENANT_A,
          MANAGER,
          "00000000-0000-4000-8000-000000000999",
          nextKey()
        )
      );
      expect(unknown).toEqual({ kind: "not_found" });
      // Replay: the same key and the same request is the original answer.
      const draft = await inTenant((tx) =>
        createPolicyDraft(
          tx,
          TENANT_A,
          STAFF,
          {
            productId: fx.productId,
            refundBasis: "whole_stay",
            noShowRetention: "retain_deposit",
            windows: [{ minHoursBeforeStart: 0, refundablePercent: "5.00" }]
          },
          "draft-key"
        )
      );
      if (draft.kind === "refused") throw new Error("refused");
      const first = await inTenant((tx) =>
        approvePolicy(tx, TENANT_A, MANAGER, draft.policy.id, "approve-key")
      );
      const replay = await inTenant((tx) =>
        approvePolicy(tx, TENANT_A, MANAGER, draft.policy.id, "approve-key")
      );
      expect(first.kind).toBe("activated");
      expect(replay.kind).toBe("replayed");
      const actives = await inTenant((tx) =>
        listPolicies(
          tx,
          TENANT_A,
          { kind: "product", productId: fx.productId },
          "active"
        )
      );
      expect(actives).toHaveLength(1);
    });

    test("retiring the active version falls back to the tenant default, then to none", async () => {
      const fx = await newFixture();
      await policy(null, [
        { minHoursBeforeStart: 0, refundablePercent: "20.00" }
      ]);
      const own = await policy(fx.productId, [
        { minHoursBeforeStart: 0, refundablePercent: "90.00" }
      ]);
      const retired = await inTenant((tx) =>
        retirePolicy(tx, TENANT_A, MANAGER, own.id, nextKey())
      );
      expect(retired.kind).toBe("retired");
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const result = await cancelled(view.reservationId, { hoursBefore: 10 });
      expect(result.decision).toMatchObject({
        policySource: "tenant_default",
        computedRefund: "200000.00"
      });
      const notActive = await inTenant((tx) =>
        retirePolicy(tx, TENANT_A, MANAGER, own.id, nextKey())
      );
      expect(notActive).toEqual({ kind: "not_active", status: "retired" });
    });

    test("the database freezes an approved version, its windows and its author", async () => {
      const fx = await newFixture();
      const v1 = await policy(fx.productId);
      const admin = getAdminSql();
      expect(
        await attemptSql(
          admin`UPDATE awcms_commerce_cancellation_policies SET refund_basis = 'per_night' WHERE id = ${v1.id}`
        )
      ).not.toBeNull();
      expect(
        await attemptSql(
          admin`UPDATE awcms_commerce_cancellation_policies SET approved_by_tenant_user_id = ${STAFF} WHERE id = ${v1.id}`
        )
      ).not.toBeNull();
      expect(
        await attemptSql(
          admin`UPDATE awcms_commerce_cancellation_policies SET created_by_tenant_user_id = ${MANAGER} WHERE id = ${v1.id}`
        )
      ).not.toBeNull();
      expect(
        await attemptSql(
          admin`UPDATE awcms_commerce_cancellation_policy_windows SET refundable_percent = 99 WHERE policy_id = ${v1.id}`
        )
      ).not.toBeNull();
      expect(
        await attemptSql(
          admin`INSERT INTO awcms_commerce_cancellation_policy_windows (tenant_id, policy_id, min_hours_before_start, refundable_percent) VALUES (${TENANT_A}, ${v1.id}, 1, 1)`
        )
      ).not.toBeNull();
      // The runtime role cannot delete a version or a window at all.
      const app = getAppRoleSql();
      const deleted = await attemptSql(
        app.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
          await tx`DELETE FROM awcms_commerce_cancellation_policies WHERE id = ${v1.id}`;
        })
      );
      expect(deleted).not.toBeNull();
    });

    test("a draft whose notice windows grow as notice shrinks cannot be activated (the database trigger is the second line)", async () => {
      const fx = await newFixture();
      const admin = getAdminSql();
      const inserted = (await admin`
        INSERT INTO awcms_commerce_cancellation_policies (tenant_id, product_id, version, created_by_tenant_user_id)
        VALUES (${TENANT_A}, ${fx.productId}, 1, ${STAFF}) RETURNING id
      `) as { id: string }[];
      await admin`
        INSERT INTO awcms_commerce_cancellation_policy_windows (tenant_id, policy_id, min_hours_before_start, refundable_percent)
        VALUES (${TENANT_A}, ${inserted[0]!.id}, 100, 10), (${TENANT_A}, ${inserted[0]!.id}, 10, 50)
      `;
      const outcome = await inTenant((tx) =>
        approvePolicy(tx, TENANT_A, MANAGER, inserted[0]!.id, nextKey())
      );
      expect(outcome).toEqual({ kind: "windows_not_monotone" });
    });
  });

  // ---------------------------------------------------------------------------
  describe("tenant isolation (RLS)", () => {
    test("tenant B sees none of tenant A's policies, decisions or links and cannot cancel A's reservation", async () => {
      const fx = await newFixture();
      const v1 = await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const decided = await cancelled(view.reservationId, { hoursBefore: 100 });

      expect(
        await inTenant(
          (tx) => listPolicies(tx, TENANT_B, { kind: "all" }),
          TENANT_B
        )
      ).toEqual([]);
      expect(
        await inTenant(
          (tx) =>
            fetchDecisionForLink(
              tx,
              TENANT_B,
              decided.decision.reservationLinkId
            ),
          TENANT_B
        )
      ).toBeNull();
      expect(
        await inTenant(
          (tx) => fetchDecisionForReservation(tx, TENANT_B, view.reservationId),
          TENANT_B
        )
      ).toBeNull();
      // Under tenant B's context, A's rows are invisible even when asked for by id.
      const raw = (await inTenant(
        (tx) =>
          tx`SELECT count(*)::int AS n FROM awcms_commerce_booking_refund_decisions`,
        TENANT_B
      )) as { n: number }[];
      expect(raw[0]!.n).toBe(0);
      const rawPolicies = (await inTenant(
        (tx) =>
          tx`SELECT count(*)::int AS n FROM awcms_commerce_cancellation_policies WHERE id = ${v1.id}`,
        TENANT_B
      )) as { n: number }[];
      expect(rawPolicies[0]!.n).toBe(0);
      // And a write into A's data under B's context is refused by RLS.
      const crossWrite = await attemptSql(
        inTenant(
          (tx) => tx`
            INSERT INTO awcms_commerce_cancellation_policies (tenant_id, version)
            VALUES (${TENANT_A}, 9)`,
          TENANT_B
        )
      );
      expect(crossWrite).not.toBeNull();

      // Cancelling A's link with B's context cannot even lock A's order.
      const linkA = await inTenant((tx) =>
        fetchReservationLinkByReservationId(tx, TENANT_A, view.reservationId)
      );
      const fresh = await newFixture();
      const second = await book(fresh);
      const link2 = await inTenant((tx) =>
        fetchReservationLinkByReservationId(tx, TENANT_A, second.reservationId)
      );
      const crossCancel = await inTenant(
        async (tx) =>
          cancelBookingReservation(
            tx,
            {
              tenantId: TENANT_B,
              actor: { kind: "staff", tenantUserId: STAFF_B },
              correlationId: crypto.randomUUID(),
              port: await composedBookingPort()
            },
            {
              link: link2!,
              idempotencyKey: "cross-1",
              reasonCode: "guest_request",
              acknowledgedRefund: null,
              override: null
            }
          ),
        TENANT_B
      );
      expect(crossCancel).toEqual({
        kind: "refused",
        refusal: { code: "RESERVATION_NOT_FOUND" }
      });
      expect(linkA).not.toBeNull();
      expect(await reservationStatus(second.reservationId)).toBe("held");
    });

    test("tenant B's policy never applies to tenant A's booking", async () => {
      const fxA = await newFixture();
      const fxB = await newFixture(TENANT_B, STAFF_B);
      await policy(fxB.productId, STANDARD_WINDOWS, {
        tenantId: TENANT_B,
        author: STAFF_B,
        approver: STAFF_B
      });
      await policy(null, STANDARD_WINDOWS, {
        tenantId: TENANT_B,
        author: STAFF_B,
        approver: STAFF_B
      });
      const view = await book(fxA);
      await pay(view.orderId, "1000000.00");
      const result = await cancelled(view.reservationId, { hoursBefore: 500 });
      expect(result.decision.policySource).toBe("none");
    });

    test("the decision is append-only: no update of any column but the one-time return link, no delete", async () => {
      const fx = await newFixture();
      await policy(fx.productId);
      const view = await book(fx);
      await pay(view.orderId, "1000000.00");
      const decided = await cancelled(view.reservationId, { hoursBefore: 100 });
      const admin = getAdminSql();
      expect(
        await attemptSql(
          admin`UPDATE awcms_commerce_booking_refund_decisions SET final_refund = 1 WHERE id = ${decided.decision.id}`
        )
      ).not.toBeNull();
      expect(
        await attemptSql(
          admin`UPDATE awcms_commerce_booking_refund_decisions SET return_id = NULL WHERE id = ${decided.decision.id}`
        )
      ).not.toBeNull();
      const app = getAppRoleSql();
      expect(
        await attemptSql(
          app.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
            await tx`DELETE FROM awcms_commerce_booking_refund_decisions WHERE id = ${decided.decision.id}`;
          })
        )
      ).not.toBeNull();
      // One decision per reservation link, mechanically.
      const link = await linkOf(view.reservationId);
      expect(
        await attemptSql(
          admin`
            INSERT INTO awcms_commerce_booking_refund_decisions
              (tenant_id, order_id, reservation_link_id, trigger_kind, actor_kind, policy_source,
               hours_before_start, refundable_percent, amount_paid, computed_refund, final_refund, source_key)
            VALUES (${TENANT_A}, ${view.orderId}, ${link.id as string}, 'customer_cancel', 'customer',
                    'none', 1, 0, 0, 0, 0, 'second-decision')`
        )
      ).not.toBeNull();
    });
  });
});
