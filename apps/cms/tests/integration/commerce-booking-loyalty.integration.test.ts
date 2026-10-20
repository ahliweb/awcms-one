/**
 * Loyalty earn for booking-originated orders (Issue #384, ADR-0041 D7, ADR-0045,
 * ADR-0026 D5, ADR-0033 D9, threat control C-33) against a REAL migrated
 * PostgreSQL. World 1 of `harness.ts`.
 *
 * #379 already gates the earner on full settlement for any deposit order; this
 * file PROVES that it holds for an order born from a Booking hold (the #380
 * hold-to-order path, the deposit policy setting `dp_amount`), through the real
 * domain-event dispatch:
 *
 *   - a deposit alone earns nothing; the balance earns once, on the whole total;
 *   - a replay of `order.paid` / `order.settled` earns once (key `earn:order:<id>`);
 *   - a booking order paid in full at once earns once;
 *   - a refund reverses by a compensating row (`reversal:refund:<id>`, ADR-0033
 *     D9) and a replay of it writes nothing;
 *   - points and a deposit never combine (Q8, C-33): the request cannot carry
 *     points, and the database refuses a points discount on a deposit order.
 *
 * The booking `cancellation` return kind is #381's; the refund here is the
 * existing leg-settlement path (the generic returns path refuses a paid
 * booking order until #381 builds the adapter's cancel).
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
import {
  createBookingReservation,
  type HoldToOrderResult
} from "../../src/modules/commerce/application/booking-hold-to-order";
import { createOfferingLink } from "../../src/modules/commerce/application/booking-offering-links";
import { setProductDepositPolicy } from "../../src/modules/commerce/application/booking-deposit-policies";
import { saveBookingServiceTenantUserId } from "../../src/modules/commerce/application/booking-adapter-settings";
import { recordOwnerPayment } from "../../src/modules/commerce/application/payment-recording";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import {
  validateBookingReservationRequest,
  type BookingRequestActor,
  type BookingReservationRequest
} from "../../src/modules/commerce/domain/booking-hold-to-order";
import { earnPointsForPaidOrder } from "../../src/modules/commerce/application/loyalty-ledger";
import {
  activateLoyaltyProgram,
  createLoyaltyProgram
} from "../../src/modules/commerce/application/loyalty-program-directory";
import { settleRefundLeg } from "../../src/modules/commerce/application/refund-settlement";
import type { LoyaltyProgramInput } from "../../src/modules/commerce/domain/loyalty-validation";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "38000000-0380-4000-8000-00000000000a";
const TENANT_B = "38000000-0380-4000-8000-00000000000b";
const STAFF = "38000000-0380-4000-8000-0000000000b1";
const STAFF_2 = "38000000-0380-4000-8000-0000000000b2";
const STAFF_B = "38000000-0380-4000-8000-0000000000b3";
const PRICE = "500000.00";
const GUEST_PHONE = "081311112222";

function inTenant<T>(
  fn: (tx: Bun.SQL) => Promise<T>,
  tenantId: string = TENANT_A
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(
  tenantId: string,
  code: string,
  staffId: string
): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${tenantId}, ${code}, ${code}, ${`${code} Legal`}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
  for (const [id, label] of [
    [staffId, `${code}-staff`],
    ...(tenantId === TENANT_A ? [[STAFF_2, `${code}-staff-2`]] : [])
  ] as [string, string][]) {
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
  withServiceActor = true
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
          booking: true,
          loyalty: true
        }
      },
      staffId
    );
    if (withServiceActor) {
      await saveBookingServiceTenantUserId(tx, tenantId, staffId);
    }
  }, tenantId);
}

type Fixture = {
  productId: string;
  offeringId: string;
  resourceId: string;
  offeringLinkId: string;
};

let fixtureSeq = 0;

/** A service product (stock deliberately 0), a stay resource with one unit, a hold-then-confirm stay offering, and the active link. */
async function newFixture(
  tenantId: string = TENANT_A,
  staffId: string = STAFF,
  options: { link?: boolean; capacity?: number } = {}
): Promise<Fixture> {
  fixtureSeq += 1;
  const code = `f${fixtureSeq}`;
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
    VALUES (${tenantId}, ${code}, ${`Room ${code}`}, 'room', ${options.capacity ?? 1},
            'Asia/Pontianak', 'stay', '14:00'::time, '12:00'::time)
    RETURNING id
  `) as { id: string }[];
  for (let ordinal = 1; ordinal <= (options.capacity ?? 1); ordinal += 1) {
    await admin`
      INSERT INTO awcms_booking_resource_units (tenant_id, resource_id, ordinal)
      VALUES (${tenantId}, ${resource[0]!.id}, ${ordinal})
    `;
  }
  const offering = (await admin`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, max_party, confirmation_mode)
    VALUES (${tenantId}, ${`night-${code}`}, 'Night', 'stay', 1, 30, 4, 'hold_then_confirm')
    RETURNING id
  `) as { id: string }[];

  let offeringLinkId = "";
  if (options.link !== false) {
    const linked = await inTenant(
      (tx) =>
        createOfferingLink(
          tx,
          tenantId,
          staffId,
          {
            offeringId: offering[0]!.id,
            productId: product[0]!.id,
            quantityBasis: "nights"
          },
          `link-${code}`
        ),
      tenantId
    );
    if (linked.kind === "refused") {
      throw new Error(`link refused: ${linked.refusal}`);
    }
    offeringLinkId = linked.link.id;
  }
  return {
    productId: product[0]!.id,
    offeringId: offering[0]!.id,
    resourceId: resource[0]!.id,
    offeringLinkId
  };
}

/** A local date `day` days after a point comfortably inside Booking's default horizon (nights are calendar dates, ADR-0135). */
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

let keySeq = 0;
const nextKey = () => `k380-${(keySeq += 1)}`;

async function book(
  fx: Fixture,
  options: {
    actor?: BookingRequestActor;
    req?: Partial<BookingReservationRequest>;
    key?: string;
    tenantId?: string;
    accountCustomerId?: string;
  } = {}
): Promise<HoldToOrderResult> {
  const tenantId = options.tenantId ?? TENANT_A;
  return inTenant(
    async (tx) =>
      createBookingReservation(
        tx,
        {
          tenantId,
          actor: options.actor ?? STAFF_ACTOR,
          accountCustomerId: options.accountCustomerId,
          correlationId: crypto.randomUUID(),
          port: await composedBookingPort(),
          mediaPort: mediaLibraryPortAdapter
        },
        request(fx, options.req),
        options.key ?? nextKey()
      ),
    tenantId
  );
}

async function created(fx: Fixture, options: Parameters<typeof book>[1] = {}) {
  const result = await book(fx, options);
  if (result.kind !== "created") {
    throw new Error(`expected created, got ${JSON.stringify(result)}`);
  }
  return result.view;
}

async function orderRow(orderId: string) {
  const rows = (await getAdminSql()`
    SELECT id, status, payment_method, payment_status, total, dp_amount,
           expires_at, customer_id, order_code
    FROM awcms_commerce_orders WHERE id = ${orderId}
  `) as {
    id: string;
    status: string;
    payment_method: string;
    payment_status: string;
    total: string;
    dp_amount: string | null;
    expires_at: Date;
    customer_id: string;
    order_code: string;
  }[];
  return rows[0]!;
}

async function dispatch(tenantId: string = TENANT_A): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) {
    await dispatchDomainEventsForTenant(getRuntimeSql(), tenantId, {
      limit: 200
    });
  }
}

function payCash(orderId: string, amount: string, key = crypto.randomUUID()) {
  return inTenant((tx) =>
    recordOwnerPayment(tx, TENANT_A, STAFF, orderId, {
      idempotencyKey: key,
      tenderType: "manual_qris",
      amount,
      reference: null,
      note: null
    })
  );
}

async function setDepositPolicy(
  productId: string,
  input: Parameters<typeof setProductDepositPolicy>[4]
) {
  const result = await inTenant((tx) =>
    setProductDepositPolicy(tx, TENANT_A, STAFF, productId, input)
  );
  if (result.kind === "product_not_found") throw new Error("no product");
}

async function enableLoyaltyProgram(): Promise<void> {
  const program: LoyaltyProgramInput = {
    name: "Poin Setia",
    earnUnitAmount: "10000.00",
    earnPointsPerUnit: 1,
    minOrderAmount: "0.00",
    maxPointsPerOrder: null,
    expiryDays: null,
    notes: null,
    eligibilitySegmentId: null,
    eligibilitySegmentVersion: null
  };
  await inTenant(async (tx) => {
    const draft = await createLoyaltyProgram(tx, TENANT_A, STAFF, program);
    const result = await activateLoyaltyProgram(
      tx,
      TENANT_A,
      STAFF,
      draft.id,
      new Date("2026-01-01T00:00:00.000Z")
    );
    if (result.kind !== "activated") throw new Error("activation failed");
  });
}

async function ledgerRows(orderId: string) {
  return (await getAdminSql()`
    SELECT kind, points::int AS points, idempotency_key, source_type, reverses_entry_id
    FROM awcms_commerce_loyalty_ledger
    WHERE tenant_id = ${TENANT_A} AND source_id = ${orderId}
    ORDER BY created_at, id
  `) as {
    kind: string;
    points: number;
    idempotency_key: string;
    source_type: string;
    reverses_entry_id: string | null;
  }[];
}

const earnsOf = async (orderId: string) =>
  (await ledgerRows(orderId)).filter((row) => row.kind === "earn");

/** Raw return + refund leg against the order's payment (the generic returns path refuses a booking order until #381). */
async function rawRefundLeg(orderId: string, amount: string): Promise<string> {
  const admin = getAdminSql();
  const allocation = (await admin`
    SELECT id FROM awcms_commerce_payment_allocations
    WHERE order_id = ${orderId} AND kind = 'payment' AND status = 'succeeded'
    ORDER BY amount DESC LIMIT 1
  `) as { id: string }[];
  const ret = (await admin`
    INSERT INTO awcms_commerce_returns
      (tenant_id, order_id, source_key, actor_tenant_user_id, goods_gross, refund_total)
    VALUES (${TENANT_A}, ${orderId}, ${`raw:${crypto.randomUUID()}`}, ${STAFF}, ${amount}, ${amount})
    RETURNING id
  `) as { id: string }[];
  const refund = (await admin`
    INSERT INTO awcms_commerce_refunds
      (tenant_id, return_id, order_id, allocation_id, tender_type, amount, source_key, actor_tenant_user_id)
    VALUES (${TENANT_A}, ${ret[0]!.id}, ${orderId}, ${allocation[0]!.id}, 'manual_qris',
            ${amount}, ${`raw:leg:${crypto.randomUUID()}`}, ${STAFF})
    RETURNING id
  `) as { id: string }[];
  return refund[0]!.id;
}

function settle(refundId: string) {
  return inTenant((tx) =>
    settleRefundLeg(tx, TENANT_A, {
      refundId,
      actorTenantUserId: STAFF,
      via: "auto",
      now: new Date()
    })
  );
}

suite(
  "booking orders earn loyalty points at full settlement (Issue #384)",
  () => {
    beforeAll(async () => {
      await setupIntegrationDatabase();
    }, 120000);

    afterAll(async () => {
      await teardownIntegrationDatabase();
    }, 60000);

    beforeEach(async () => {
      await resetDatabase();
      await seedTenant(TENANT_A, "tenant-bk-a", STAFF);
      await seedTenant(TENANT_B, "tenant-bk-b", STAFF_B);
      await configureTenant(TENANT_A, STAFF);
      await configureTenant(TENANT_B, STAFF_B);
      await enableLoyaltyProgram();
    }, 60000);

    async function depositBooking() {
      const fx = await newFixture();
      await setDepositPolicy(fx.productId, {
        kind: "percent",
        percent: "30.00"
      });
      return created(fx, { req: { paymentMethod: "dp" } });
    }

    test("a deposit alone earns nothing; the balance earns once, on the whole total", async () => {
      const view = await depositBooking();
      expect((await orderRow(view.orderId)).dp_amount).toBe("300000.00");

      await payCash(view.orderId, "300000.00");
      await dispatch();
      expect((await orderRow(view.orderId)).status).toBe("paid");
      expect(await earnsOf(view.orderId)).toHaveLength(0);

      await payCash(view.orderId, "700000.00");
      await dispatch();
      const earns = await earnsOf(view.orderId);
      expect(earns).toHaveLength(1);
      // floor(1,000,000 / 10,000): on the whole total, not on the deposit.
      expect(earns[0]!.points).toBe(100);
      expect(earns[0]!.idempotency_key).toBe(`earn:order:${view.orderId}`);
    });

    test("replaying order.paid and order.settled earns once", async () => {
      const view = await depositBooking();
      await payCash(view.orderId, "300000.00");
      await payCash(view.orderId, "700000.00");
      await dispatch();
      expect(await earnsOf(view.orderId)).toHaveLength(1);

      for (const trigger of ["paid", "settled"] as const) {
        const outcome = await inTenant((tx) =>
          earnPointsForPaidOrder(tx, TENANT_A, view.orderId, undefined, trigger)
        );
        expect(outcome.kind).toBe("already_earned");
      }
      await dispatch();
      expect(await earnsOf(view.orderId)).toHaveLength(1);
    });

    test("a booking order paid in full in one go earns once, at order.paid", async () => {
      const fx = await newFixture();
      const view = await created(fx);
      await payCash(view.orderId, "1000000.00");
      await dispatch();
      const earns = await earnsOf(view.orderId);
      expect(earns).toHaveLength(1);
      expect(earns[0]!.points).toBe(100);
    });

    test("a refund reverses the earn by a compensating row; a replay writes nothing", async () => {
      const view = await depositBooking();
      await payCash(view.orderId, "300000.00");
      await payCash(view.orderId, "700000.00");
      await dispatch();
      const [earn] = await earnsOf(view.orderId);

      const refundId = await rawRefundLeg(view.orderId, "500000.00");
      const first = await settle(refundId);
      expect(first.kind).toBe("settled");
      const reversal = (await getAdminSql()`
      SELECT kind, points::int AS points, source_type, reverses_entry_id, idempotency_key
      FROM awcms_commerce_loyalty_ledger
      WHERE tenant_id = ${TENANT_A} AND kind = 'reversal'
    `) as {
        points: number;
        source_type: string;
        reverses_entry_id: string;
        idempotency_key: string;
      }[];
      expect(reversal).toHaveLength(1);
      // Half the total refunded -> half the 100 points, as a NEW row.
      expect(reversal[0]!.points).toBe(-50);
      expect(reversal[0]!.source_type).toBe("refund");
      expect(reversal[0]!.idempotency_key).toBe(`reversal:refund:${refundId}`);
      expect(reversal[0]!.reverses_entry_id).toBeTruthy();
      // The earn row itself is untouched (append-only ledger).
      expect(await earnsOf(view.orderId)).toEqual([earn!]);

      const again = await settle(refundId);
      expect(again.kind).toBe("already_settled");
      const count = (await getAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_loyalty_ledger
      WHERE tenant_id = ${TENANT_A} AND kind = 'reversal'
    `) as { n: number }[];
      expect(count[0]!.n).toBe(1);
    });

    test("points and a deposit never combine (Q8, C-33): the request cannot carry points, and the database refuses a points discount on a deposit order", async () => {
      const fx = await newFixture();
      await setDepositPolicy(fx.productId, {
        kind: "percent",
        percent: "30.00"
      });
      const withPoints = validateBookingReservationRequest({
        offeringId: fx.offeringId,
        resourceId: fx.resourceId,
        stay: { checkInDate: D(10), checkOutDate: D(12) },
        partySize: 1,
        payment: { method: "dp" },
        loyaltyRedemption: { points: 100 }
      });
      if (withPoints.valid) {
        // Unknown keys are not read: whatever it parses to has no points field.
        expect(JSON.stringify(withPoints.value)).not.toContain("loyalty");
      }

      const view = await created(fx, { req: { paymentMethod: "dp" } });
      expect((await orderRow(view.orderId)).dp_amount).not.toBeNull();
      let refused = false;
      try {
        await getAdminSql()`
        UPDATE awcms_commerce_orders SET loyalty_discount = 10.00
        WHERE id = ${view.orderId}
      `;
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    });
  }
);
