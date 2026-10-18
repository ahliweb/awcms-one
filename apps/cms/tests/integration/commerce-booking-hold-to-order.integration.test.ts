/**
 * Hold-to-order, the deposit-threshold confirm and the booking consumers against
 * a REAL migrated PostgreSQL (Issue #380, ADR-0045 G2/G3/G4/G5/G6/G7/G10/G11,
 * threat controls C-05, C-08, C-09, C-32, C-38). World 1 of `harness.ts`: the
 * application functions are called with the `awcms_app` runtime pool and the
 * REAL composed `BookingPort`, and the domain events are dispatched through the
 * real consumer registry.
 *
 * What only a database can prove:
 *
 *   - the hold, the order and the link are ONE transaction: the price is the
 *     product's (the client sends none, and a body that tries is refused), the
 *     order's `expires_at` is the hold's expiry, Booking's `externalRef` names
 *     the order, the stock counter is neither read nor moved, and a refusal
 *     (taken slot, unlinked offering, no service account) writes nothing;
 *   - idempotency: the same key and request returns the same order and link
 *     (`replayed`), the same key with another request is a conflict, and the key
 *     is namespaced by who asks;
 *   - the deposit policy sets `dp_amount` (policy row first, G10; M9: no row, no
 *     change) and `order.paid` at the threshold confirms the reservation;
 *   - the C-08 race table - payment first confirms; expiry first never cancels
 *     an order that holds money (attention `deposit_after_expiry`); a payment
 *     after the order closed is flagged, not lost;
 *   - each consumer replayed changes nothing, and a canceller refuses to cancel
 *     an order that holds money;
 *   - the guards: a linked product is unsellable on the ordinary path, a paid
 *     booking order is refused by the generic cancel and returns paths;
 *   - ownership: two customers of one tenant never see each other's reservation
 *     (C-32) and another tenant sees nothing (RLS);
 *   - the C-09 reconciliation finds exactly the disagreeing pairs.
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
import {
  fetchReservationLinkForOrderCode,
  fetchReservationLinkByReservationId
} from "../../src/modules/commerce/application/booking-reservation-links";
import {
  reconcileBookingOrders,
  readBookingReservationStatus
} from "../../src/modules/commerce/application/booking-reservation-reads";
import { BookingOrderUseAdapterError } from "../../src/modules/commerce/application/booking-order-guards";
import { buildCartQuote } from "../../src/modules/commerce/application/cart-quote-service";
import {
  cancelOrderByCustomer,
  createOrderFromCart,
  updateOrderStatusByAdmin
} from "../../src/modules/commerce/application/order-directory";
import { recordOwnerPayment } from "../../src/modules/commerce/application/payment-recording";
import { recordPaymentAllocation } from "../../src/modules/commerce/application/payment-allocation-directory";
import { createReturn } from "../../src/modules/commerce/application/return-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import {
  actorNamespace,
  validateBookingReservationRequest,
  type BookingRequestActor,
  type BookingReservationRequest
} from "../../src/modules/commerce/domain/booking-hold-to-order";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { listDomainEventConsumers } from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import {
  emitReaperExpiredEvents,
  expireDueHolds
} from "../../src/modules/booking/application/booking-hold-expiry";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import {
  getAdminSql,
  getRuntimeSql,
  getWorkerRoleSql,
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
  fn: (tx: Bun.TransactionSQL) => Promise<T>,
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
          booking: true
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

function guestActor(phoneKey = "guest-key-1"): BookingRequestActor {
  return { kind: "guest", phoneKey };
}

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

async function linkRow(reservationId: string) {
  const rows = (await getAdminSql()`
    SELECT * FROM awcms_commerce_booking_reservation_links
    WHERE reservation_id = ${reservationId}
  `) as Record<string, unknown>[];
  return rows[0]!;
}

async function counts(tenantId: string = TENANT_A) {
  const admin = getAdminSql();
  const one = async (sql: Promise<unknown>) =>
    ((await sql) as { n: number }[])[0]!.n;
  return {
    orders: await one(
      admin`SELECT count(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${tenantId}`
    ),
    links: await one(
      admin`SELECT count(*)::int AS n FROM awcms_commerce_booking_reservation_links WHERE tenant_id = ${tenantId}`
    ),
    reservations: await one(
      admin`SELECT count(*)::int AS n FROM awcms_booking_reservations WHERE tenant_id = ${tenantId}`
    )
  };
}

async function reservationRow(reservationId: string) {
  const rows = (await getAdminSql()`
    SELECT status, external_ref_type, external_ref, external_customer_ref, hold_expires_at
    FROM awcms_booking_reservations WHERE id = ${reservationId}
  `) as {
    status: string;
    external_ref_type: string | null;
    external_ref: string | null;
    external_customer_ref: string | null;
    hold_expires_at: Date | null;
  }[];
  return rows[0]!;
}

async function domainEvents(aggregateId: string, eventType?: string) {
  return (await getAdminSql()`
    SELECT event_type, payload FROM awcms_domain_events
    WHERE aggregate_id = ${aggregateId}
      AND (${eventType ?? null}::text IS NULL OR event_type = ${eventType ?? null})
    ORDER BY event_sequence
  `) as { event_type: string; payload: Record<string, unknown> }[];
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

/** Test-only: move a hold's expiry (the update guard forbids shortening; the database clock is the only clock). */
async function backdateHold(reservationId: string): Promise<void> {
  await getAdminSql().begin(async (tx) => {
    await tx.unsafe(
      "ALTER TABLE awcms_booking_reservations DISABLE TRIGGER awcms_booking_reservations_update_guard"
    );
    await tx.unsafe(
      `UPDATE awcms_booking_reservations SET hold_expires_at = clock_timestamp() - interval '2 seconds' WHERE id = '${reservationId}'`
    );
    await tx.unsafe(
      "ALTER TABLE awcms_booking_reservations ENABLE TRIGGER awcms_booking_reservations_update_guard"
    );
  });
}

/** The booking reaper, as the worker role, publishing `expired` events. */
async function sweepHolds(): Promise<void> {
  await getWorkerRoleSql().begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
    const outcome = await expireDueHolds(tx, TENANT_A);
    await emitReaperExpiredEvents(tx, TENANT_A, outcome, crypto.randomUUID());
  });
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

async function lateGatewayLeg(orderId: string, amount: string) {
  return inTenant((tx) =>
    recordPaymentAllocation(tx, TENANT_A, {
      orderId,
      tenderType: "gateway",
      amount,
      provider: "log",
      providerReference: `late-${orderId}`,
      source: "gateway_webhook",
      sourceKey: `late:${orderId}`,
      actor: { kind: "system" },
      enforceNoOverpayment: false,
      allowedOrderStatuses: null,
      release: null,
      releaseNote: ""
    })
  );
}

function consumer(name: string) {
  return listDomainEventConsumers().find((entry) => entry.name === name)!;
}

suite(
  "booking adapter: hold-to-order, confirm and consumers (Issue #380)",
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
    }, 60000);

    // -------------------------------------------------------------------------
    describe("hold-to-order (G2, G4)", () => {
      test("the price is the product's, the order expires with the hold, Booking names the order, the stock counter is untouched", async () => {
        const fx = await newFixture();
        const view = await created(fx);

        const order = await orderRow(view.orderId);
        expect(order.status).toBe("pending_payment");
        // 2 nights x the product price; the client could send none.
        expect(order.total).toBe("1000000.00");
        expect(order.payment_method).toBe("manual_qris");
        expect(order.dp_amount).toBeNull();

        const reservation = await reservationRow(view.reservationId);
        expect(reservation.status).toBe("held");
        expect(reservation.external_ref_type).toBe("commerce_order");
        expect(reservation.external_ref).toBe(view.orderId);
        // X7 / ADR-0045 D3-A: the customer never reaches Booking.
        expect(reservation.external_customer_ref).toBeNull();
        // The payment window and the claim end together.
        expect(order.expires_at.getTime()).toBe(
          reservation.hold_expires_at!.getTime()
        );

        const link = await linkRow(view.reservationId);
        expect(link.order_id).toBe(view.orderId);
        expect(link.status).toBe("active");
        expect(String(link.client_key).startsWith("bk1:staff:")).toBe(true);

        const stock = (await getAdminSql()`
        SELECT stock FROM awcms_commerce_products WHERE id = ${fx.productId}
      `) as { stock: number }[];
        expect(stock[0]!.stock).toBe(0);
        expect(view.settlement.total).toBe("1000000.00");
        expect(view.settlement.balanceDue).toBe("1000000.00");
      });

      test("a request that names a price, amount, deposit or customer is refused by the validator", () => {
        for (const field of [
          "price",
          "amount",
          "total",
          "deposit",
          "customerId",
          "orderId"
        ]) {
          const result = validateBookingReservationRequest({
            offeringId: crypto.randomUUID(),
            resourceId: crypto.randomUUID(),
            stay: { checkInDate: D(10), checkOutDate: D(12) },
            partySize: 1,
            payment: { method: "manual_qris" },
            [field]: "1.00"
          });
          expect(result.valid, field).toBe(false);
        }
      });

      test("a refusal writes nothing: a taken slot, an unlinked offering, no service account", async () => {
        const fx = await newFixture();
        await created(fx);
        const before = await counts();

        const taken = await book(fx);
        expect(taken).toEqual({
          kind: "refused",
          refusal: { code: "BOOKING", reason: "SLOT_UNAVAILABLE" }
        });

        const unlinked = await newFixture(TENANT_A, STAFF, { link: false });
        expect(await book(unlinked)).toEqual({
          kind: "refused",
          refusal: { code: "OFFERING_NOT_LINKED" }
        });

        // A guest call needs the tenant's service-account user (G3); staff do not.
        const other = await newFixture();
        await inTenant(async (tx) => {
          await tx`UPDATE awcms_commerce_store_settings SET booking_service_tenant_user_id = NULL WHERE tenant_id = ${TENANT_A}`;
        });
        expect(await book(other, { actor: guestActor() })).toEqual({
          kind: "refused",
          refusal: { code: "SERVICE_ACTOR_NOT_CONFIGURED" }
        });

        const after = await counts();
        // The two fixtures above added no order, link or reservation.
        expect(after).toEqual(before);
      });

      test("a nightly offering needs stay, a slot offering startsAt (QUANTITY_BASIS_MISMATCH)", async () => {
        const fx = await newFixture();
        const result = await book(fx, {
          req: { stay: null, startsAt: "2031-06-10T05:00:00Z" }
        });
        expect(result).toEqual({
          kind: "refused",
          refusal: { code: "QUANTITY_BASIS_MISMATCH" }
        });
      });

      test("a customer call books under the service account; an anonymous guest needs a configured one", async () => {
        const fx = await newFixture();
        const view = await created(fx, { actor: guestActor() });
        const rows = (await getAdminSql()`
        SELECT actor_user_id FROM awcms_booking_reservation_events
        WHERE reservation_id = ${view.reservationId} ORDER BY seq LIMIT 1
      `) as { actor_user_id: string | null }[];
        expect(rows[0]?.actor_user_id).toBe(STAFF);
      });
    });

    // -------------------------------------------------------------------------
    describe("idempotency (G5)", () => {
      test("the same key and request returns the same order and link; nothing is created twice", async () => {
        const fx = await newFixture();
        const key = nextKey();
        const first = await created(fx, { key });
        const before = await counts();

        const again = await book(fx, { key });
        expect(again.kind).toBe("replayed");
        if (again.kind !== "replayed") return;
        expect(again.view.orderId).toBe(first.orderId);
        expect(again.view.orderCode).toBe(first.orderCode);
        expect(again.view.reservationId).toBe(first.reservationId);
        expect(await counts()).toEqual(before);
      });

      test("the same key with another request is IDEMPOTENCY_CONFLICT and writes nothing", async () => {
        const fx = await newFixture();
        const key = nextKey();
        await created(fx, { key });
        const before = await counts();
        const conflict = await book(fx, {
          key,
          req: { stay: { checkInDate: D(20), checkOutDate: D(22) } }
        });
        expect(conflict).toEqual({
          kind: "refused",
          refusal: { code: "IDEMPOTENCY_CONFLICT" }
        });
        expect(await counts()).toEqual(before);
      });

      test("the key is namespaced by who asks: another actor with the same key is a separate hold, not a replay or a conflict", async () => {
        const fx = await newFixture(TENANT_A, STAFF, { capacity: 3 });
        const key = nextKey();
        const staff = await created(fx, { key });
        const guest = await created(fx, { key, actor: guestActor("g-1") });
        const customer = await created(fx, {
          key,
          actor: { kind: "customer", customerId: crypto.randomUUID() },
          accountCustomerId: undefined,
          req: { guest: { name: "Siti", phone: "081322223333", email: null } }
        });
        expect(
          new Set([staff.orderId, guest.orderId, customer.orderId]).size
        ).toBe(3);
        expect(actorNamespace({ kind: "guest", phoneKey: "g-1" })).toBe(
          "anon:g-1"
        );
        const keys = (await getAdminSql()`
        SELECT client_key FROM awcms_commerce_booking_reservation_links
        WHERE tenant_id = ${TENANT_A}
      `) as { client_key: string }[];
        expect(new Set(keys.map((row) => row.client_key)).size).toBe(3);
        for (const row of keys)
          expect(row.client_key.length).toBeLessThanOrEqual(300);
      });

      test("Booking's own idempotency key is derived from the link, never from the client's", async () => {
        const fx = await newFixture();
        const view = await created(fx, { key: "client-chosen-key" });
        const rows = (await getAdminSql()`
        SELECT idempotency_key AS key FROM awcms_idempotency_keys
        WHERE tenant_id = ${TENANT_A} AND idempotency_key LIKE 'commerce-booking-hold:%'
      `) as { key: string }[];
        expect(rows.map((row) => row.key)).toEqual([
          `commerce-booking-hold:${view.linkId}`
        ]);
      });
    });

    // -------------------------------------------------------------------------
    describe("the deposit policy and the threshold (G10, D16)", () => {
      test("a product with a policy gets dp_amount from it; one without keeps the legacy rule (M9)", async () => {
        const withPolicy = await newFixture(TENANT_A, STAFF, { capacity: 2 });
        await setDepositPolicy(withPolicy.productId, {
          kind: "percent",
          percent: "30.00"
        });
        const view = await created(withPolicy, {
          req: { paymentMethod: "dp" }
        });
        const order = await orderRow(view.orderId);
        expect(order.payment_method).toBe("dp");
        expect(order.dp_amount).toBe("300000.00");
        expect(view.settlement.deposit).toBe("300000.00");
        expect(view.settlement.balanceDue).toBe("1000000.00");

        // No policy and the store-wide rule off: 'dp' is simply unavailable.
        const noPolicy = await newFixture();
        expect(await book(noPolicy, { req: { paymentMethod: "dp" } })).toEqual({
          kind: "refused",
          refusal: { code: "PAYMENT_METHOD_UNAVAILABLE" }
        });
      });

      test("a fixed policy is per night; the deposit is snapshotted and later edits never touch the order", async () => {
        const fx = await newFixture();
        await setDepositPolicy(fx.productId, {
          kind: "fixed",
          fixedAmount: "150000.00"
        });
        const view = await created(fx, { req: { paymentMethod: "dp" } });
        expect((await orderRow(view.orderId)).dp_amount).toBe("300000.00");
        await setDepositPolicy(fx.productId, { kind: "full" });
        expect((await orderRow(view.orderId)).dp_amount).toBe("300000.00");
      });

      test("below the threshold nothing is confirmed; reaching it confirms the reservation; the balance changes nothing more", async () => {
        const fx = await newFixture();
        await setDepositPolicy(fx.productId, {
          kind: "percent",
          percent: "30.00"
        });
        const view = await created(fx, { req: { paymentMethod: "dp" } });

        await payCash(view.orderId, "100000.00");
        await dispatch();
        expect((await orderRow(view.orderId)).status).toBe("pending_payment");
        expect((await reservationRow(view.reservationId)).status).toBe("held");

        await payCash(view.orderId, "200000.00");
        await dispatch();
        expect((await orderRow(view.orderId)).status).toBe("paid");
        expect((await reservationRow(view.reservationId)).status).toBe(
          "confirmed"
        );

        await payCash(view.orderId, "700000.00");
        await dispatch();
        expect((await reservationRow(view.reservationId)).status).toBe(
          "confirmed"
        );
        expect((await linkRow(view.reservationId)).attention_reason).toBeNull();
      });

      test("a whole-total booking order confirms when it is paid in full", async () => {
        const fx = await newFixture();
        const view = await created(fx);
        await payCash(view.orderId, "500000.00");
        await dispatch();
        expect((await reservationRow(view.reservationId)).status).toBe("held");
        await payCash(view.orderId, "500000.00");
        await dispatch();
        expect((await reservationRow(view.reservationId)).status).toBe(
          "confirmed"
        );
      });
    });

    // -------------------------------------------------------------------------
    describe("the late-payment race (C-08)", () => {
      test("payment first: the confirm wins and the reaper never expires a confirmed reservation", async () => {
        const fx = await newFixture();
        const view = await created(fx);
        await payCash(view.orderId, "1000000.00");
        await dispatch();
        expect((await reservationRow(view.reservationId)).status).toBe(
          "confirmed"
        );
        await sweepHolds();
        await dispatch();
        expect((await reservationRow(view.reservationId)).status).toBe(
          "confirmed"
        );
        expect((await orderRow(view.orderId)).status).toBe("paid");
        expect((await linkRow(view.reservationId)).attention_reason).toBeNull();
      });

      test("expiry first, then a payment before the canceller ran: attention deposit_after_expiry, the order that holds money is NOT cancelled", async () => {
        const fx = await newFixture();
        const view = await created(fx);
        await backdateHold(view.reservationId);
        await sweepHolds(); // Booking: held -> expired, event published, not yet dispatched

        // The deposit lands in the gap: the order is still `pending_payment`.
        await payCash(view.orderId, "1000000.00");
        expect((await orderRow(view.orderId)).status).toBe("paid");

        await dispatch();

        expect((await reservationRow(view.reservationId)).status).toBe(
          "expired"
        );
        const order = await orderRow(view.orderId);
        expect(order.status).toBe("paid"); // never auto-cancelled
        const link = await linkRow(view.reservationId);
        expect(link.attention_reason).toBe("deposit_after_expiry");
        expect(link.attention_resolved_at).toBeNull();
        // Exactly one attention event, with no money or person in it.
        const raised = await domainEvents(
          view.orderId,
          "awcms.commerce.booking_reservation_link.attention_raised"
        );
        expect(raised).toHaveLength(1);
        expect(raised[0]!.payload).toEqual({
          orderId: view.orderId,
          reservationId: view.reservationId,
          reason: "deposit_after_expiry"
        });
      });

      test("expiry first and the canceller ran: the unpaid order closes; a payment that arrives after is flagged, not lost", async () => {
        const fx = await newFixture();
        const view = await created(fx);
        await backdateHold(view.reservationId);
        await sweepHolds();
        await dispatch();
        expect((await orderRow(view.orderId)).status).toBe("expired");
        expect((await linkRow(view.reservationId)).attention_reason).toBeNull();

        // A gateway callback after the order closed: the ledger records the money
        // (the provider captured it), the order stays closed, order.paid never fires.
        const leg = await lateGatewayLeg(view.orderId, "1000000.00");
        expect(leg.kind).toBe("recorded");
        await dispatch();

        expect((await orderRow(view.orderId)).status).toBe("expired");
        const link = await linkRow(view.reservationId);
        expect(link.attention_reason).toBe("deposit_after_expiry");
      });
    });

    // -------------------------------------------------------------------------
    describe("the consumers", () => {
      test("the expired canceller expires an unpaid order once; a replayed event changes nothing", async () => {
        const fx = await newFixture();
        const view = await created(fx);
        await backdateHold(view.reservationId);
        await sweepHolds();
        await dispatch();
        expect((await orderRow(view.orderId)).status).toBe("expired");
        const statusEvents = async () =>
          (await getAdminSql()`
          SELECT count(*)::int AS n FROM awcms_commerce_order_events
          WHERE order_id = ${view.orderId}
        `) as { n: number }[];
        const before = await statusEvents();

        // Re-deliver the very same Booking event to the consumer: the registry's
        // effect-once marker stops it; the handler itself is a no-op as well.
        const expired = (await getAdminSql()`
        SELECT id, event_type, event_version, aggregate_type, aggregate_id,
               order_key, correlation_id, causation_id, producer_module,
               payload, occurred_at, recorded_at
        FROM awcms_domain_events
        WHERE aggregate_id = ${view.reservationId}
          AND event_type = 'awcms.booking.reservation.expired'
      `) as Record<string, unknown>[];
        expect(expired).toHaveLength(1);
        const row = expired[0]!;
        const event = {
          id: row.id as string,
          eventType: row.event_type as string,
          eventVersion: row.event_version as string,
          aggregateType: row.aggregate_type as string,
          aggregateId: row.aggregate_id as string,
          orderKey: row.order_key as string,
          correlationId: row.correlation_id as string | null,
          causationId: row.causation_id as string | null,
          producerModule: row.producer_module as string,
          payload: row.payload as Record<string, unknown>,
          occurredAt: row.occurred_at as Date,
          recordedAt: row.recorded_at as Date
        };
        for (let i = 0; i < 2; i += 1) {
          await inTenant((tx) =>
            consumer("commerce.booking_expired_order_canceller").handler(
              tx,
              event,
              { tenantId: TENANT_A, correlationId: crypto.randomUUID() }
            )
          );
        }
        expect(await statusEvents()).toEqual(before);
        expect((await orderRow(view.orderId)).status).toBe("expired");
      });

      test("the confirmer replayed confirms once and flags nothing", async () => {
        const fx = await newFixture();
        const view = await created(fx);
        await payCash(view.orderId, "1000000.00");
        await dispatch();
        await dispatch();
        const history = (await getAdminSql()`
        SELECT kind FROM awcms_booking_reservation_events
        WHERE reservation_id = ${view.reservationId} ORDER BY seq
      `) as { kind: string }[];
        expect(history.filter((row) => row.kind === "confirmed")).toHaveLength(
          1
        );
        expect((await linkRow(view.reservationId)).attention_reason).toBeNull();
      });

      test("a cancel in Booking cancels the unpaid order; one that holds money is flagged cancelled_externally_paid and kept", async () => {
        const fx = await newFixture(TENANT_A, STAFF, { capacity: 2 });
        const unpaid = await created(fx);
        const paid = await created(fx, {
          req: { stay: { checkInDate: D(15), checkOutDate: D(16) } }
        });
        await payCash(paid.orderId, "500000.00");
        await dispatch();
        expect((await reservationRow(paid.reservationId)).status).toBe(
          "confirmed"
        );

        for (const reservationId of [
          unpaid.reservationId,
          paid.reservationId
        ]) {
          await inTenant(async (tx) =>
            (await composedBookingPort()).cancel(tx, {
              tenantId: TENANT_A,
              reservationId,
              idempotencyKey: `cancel-${reservationId}`,
              correlationId: crypto.randomUUID(),
              actorTenantUserId: STAFF,
              reasonCode: "guest_request"
            })
          );
        }
        await dispatch();

        expect((await orderRow(unpaid.orderId)).status).toBe("cancelled");
        expect((await orderRow(paid.orderId)).status).toBe("paid");
        expect((await linkRow(paid.reservationId)).attention_reason).toBe(
          "cancelled_externally_paid"
        );
        expect(
          (await linkRow(unpaid.reservationId)).attention_reason
        ).toBeNull();
      });

      test("an unpaid booking order cancelled through the generic admin path releases its hold (G11), and moves no stock", async () => {
        const fx = await newFixture();
        const view = await created(fx);
        await inTenant((tx) =>
          updateOrderStatusByAdmin(
            tx,
            TENANT_A,
            STAFF,
            view.orderId,
            "cancelled",
            "changed my mind"
          )
        );
        await dispatch();
        expect((await reservationRow(view.reservationId)).status).toBe(
          "cancelled"
        );
        const stock = (await getAdminSql()`
        SELECT stock FROM awcms_commerce_products WHERE id = ${fx.productId}
      `) as { stock: number }[];
        expect(stock[0]!.stock).toBe(0); // not restocked: it was never taken
        // The freed slot is bookable again.
        expect((await book(fx, { actor: guestActor("g-2") })).kind).toBe(
          "created"
        );
      });
    });

    // -------------------------------------------------------------------------
    describe("guards (ADR-0045 D1, G11)", () => {
      test("a linked product cannot be sold through the ordinary cart or order path", async () => {
        const fx = await newFixture();
        const quote = await inTenant((tx) =>
          buildCartQuote(tx, TENANT_A, mediaLibraryPortAdapter, {
            lines: [
              {
                productId: fx.productId,
                variantId: null,
                quantity: 1,
                serviceFormValues: null
              }
            ],
            shipping: null,
            voucherCode: null,
            insurance: false
          })
        );
        expect(quote.canCheckout).toBe(false);
        expect(quote.lines[0]!.status).toBe("unavailable");

        const outcome = await inTenant((tx) =>
          createOrderFromCart(tx, TENANT_A, mediaLibraryPortAdapter, {
            idempotencyKey: crypto.randomUUID(),
            customer: { name: "Budi", phone: GUEST_PHONE, email: null },
            address: null,
            lines: [
              {
                productId: fx.productId,
                variantId: null,
                quantity: 1,
                serviceFormValues: null
              }
            ],
            shipping: { method: "self_pickup" },
            payment: { method: "manual_qris" },
            voucherCode: null,
            insurance: false,
            notes: null,
            affiliateCode: null
          })
        );
        expect(outcome.kind).toBe("cart_changed");
      });

      test("unlinking makes the product an ordinary product again", async () => {
        const fx = await newFixture();
        await getAdminSql()`
        UPDATE awcms_commerce_booking_offering_links
        SET status = 'unlinked', unlinked_at = now() WHERE id = ${fx.offeringLinkId}
      `;
        await getAdminSql()`UPDATE awcms_commerce_products SET stock = 5 WHERE id = ${fx.productId}`;
        const quote = await inTenant((tx) =>
          buildCartQuote(tx, TENANT_A, mediaLibraryPortAdapter, {
            lines: [
              {
                productId: fx.productId,
                variantId: null,
                quantity: 1,
                serviceFormValues: null
              }
            ],
            shipping: null,
            voucherCode: null,
            insurance: false
          })
        );
        expect(quote.canCheckout).toBe(true);
      });

      test("a booking order that holds money is refused by the generic admin cancel, the customer cancel and the returns path", async () => {
        const fx = await newFixture();
        const view = await created(fx);
        await payCash(view.orderId, "1000000.00");
        await dispatch();

        await expect(
          inTenant((tx) =>
            updateOrderStatusByAdmin(
              tx,
              TENANT_A,
              STAFF,
              view.orderId,
              "cancelled",
              null
            )
          )
        ).rejects.toBeInstanceOf(BookingOrderUseAdapterError);
        expect((await orderRow(view.orderId)).status).toBe("paid");

        const phone = (
          (await getAdminSql()`
          SELECT phone FROM awcms_commerce_customers WHERE id = ${(await orderRow(view.orderId)).customer_id}
        `) as { phone: string }[]
        )[0]!.phone;
        await expect(
          inTenant((tx) =>
            cancelOrderByCustomer(
              tx,
              TENANT_A,
              mediaLibraryPortAdapter,
              view.orderCode,
              phone,
              null
            )
          )
        ).rejects.toThrow();

        const item = (await getAdminSql()`
        SELECT id FROM awcms_commerce_order_items WHERE order_id = ${view.orderId}
      `) as { id: string }[];
        const returned = await inTenant((tx) =>
          createReturn(
            tx,
            TENANT_A,
            STAFF,
            view.orderId,
            {
              idempotencyKey: crypto.randomUUID(),
              kind: "return",
              note: null,
              exchangeOrderId: null,
              lines: [
                {
                  orderItemId: item[0]!.id,
                  quantity: 1,
                  reason: "other",
                  disposition: "restock",
                  note: null
                }
              ],
              refund: null
            } as never,
            new Date()
          )
        );
        expect(returned.kind).toBe("booking_order");
      });
    });

    // -------------------------------------------------------------------------
    describe("reads and ownership (C-05, C-32)", () => {
      test("two customers of one tenant never see each other's reservation; another tenant sees nothing", async () => {
        const fx = await newFixture(TENANT_A, STAFF, { capacity: 2 });
        const first = await created(fx, {
          actor: guestActor("a"),
          req: { guest: { name: "Ani", phone: "081311110001", email: null } }
        });
        const second = await created(fx, {
          actor: guestActor("b"),
          req: { guest: { name: "Bimo", phone: "081311110002", email: null } }
        });
        const customerOf = async (orderId: string) =>
          (await orderRow(orderId)).customer_id;
        const firstCustomer = await customerOf(first.orderId);
        const secondCustomer = await customerOf(second.orderId);
        expect(firstCustomer).not.toBe(secondCustomer);

        const read = (
          orderCode: string,
          identity: Parameters<typeof fetchReservationLinkForOrderCode>[3],
          tenantId: string = TENANT_A
        ) =>
          inTenant(
            (tx) =>
              fetchReservationLinkForOrderCode(
                tx,
                tenantId,
                orderCode,
                identity
              ),
            tenantId
          );

        expect(
          (
            await read(first.orderCode, {
              kind: "customer",
              customerId: firstCustomer
            })
          )?.orderId
        ).toBe(first.orderId);
        // Another customer of the same tenant, and the unknown code, are one null.
        expect(
          await read(first.orderCode, {
            kind: "customer",
            customerId: secondCustomer
          })
        ).toBeNull();
        expect(
          await read("NO-SUCH-CODE", {
            kind: "customer",
            customerId: firstCustomer
          })
        ).toBeNull();
        // The order's phone is the other credential, and only the owner's works.
        expect(
          (
            await read(first.orderCode, {
              kind: "phone",
              phone: "+6281311110001"
            })
          )?.orderId
        ).toBe(first.orderId);
        expect(
          await read(first.orderCode, {
            kind: "phone",
            phone: "+6281311110002"
          })
        ).toBeNull();
        // Another tenant: RLS hides the row.
        expect(
          await read(
            first.orderCode,
            { kind: "customer", customerId: firstCustomer },
            TENANT_B
          )
        ).toBeNull();
        expect(
          await inTenant(
            (tx) =>
              fetchReservationLinkByReservationId(
                tx,
                TENANT_B,
                first.reservationId
              ),
            TENANT_B
          )
        ).toBeNull();
        expect(
          await inTenant(
            (tx) =>
              readBookingReservationStatus(tx, TENANT_B, first.reservationId),
            TENANT_B
          )
        ).toBeNull();
      });
    });

    // -------------------------------------------------------------------------
    describe("reconciliation (C-09)", () => {
      test("it lists exactly the pairs where the ledger and the reservation disagree", async () => {
        const fx = await newFixture(TENANT_A, STAFF, { capacity: 4 });
        const clean = await created(fx); // held + unpaid: fine
        const paidConfirmed = await created(fx, {
          req: { stay: { checkInDate: D(14), checkOutDate: D(15) } }
        });
        await payCash(paidConfirmed.orderId, "500000.00");
        await dispatch(); // confirmed + paid: fine

        // paid_without_confirm: money in, the confirm never happened (the
        // consumer paused, say) - simulated by paying then NOT dispatching.
        const paidHeld = await created(fx, {
          req: { stay: { checkInDate: D(16), checkOutDate: D(17) } }
        });
        await payCash(paidHeld.orderId, "500000.00");

        // confirmed_without_deposit: staff confirmed it in Booking's own screen.
        const confirmedUnpaid = await created(fx, {
          req: { stay: { checkInDate: D(18), checkOutDate: D(19) } }
        });
        await inTenant(async (tx) =>
          (await composedBookingPort()).confirm(tx, {
            tenantId: TENANT_A,
            reservationId: confirmedUnpaid.reservationId,
            idempotencyKey: "manual-confirm",
            correlationId: crypto.randomUUID(),
            actorTenantUserId: STAFF
          })
        );

        const report = await inTenant((tx) =>
          reconcileBookingOrders(tx, TENANT_A)
        );
        const byOrder = Object.fromEntries(
          report.items.map((item) => [item.orderId, item.kind])
        );
        expect(byOrder).toEqual({
          [paidHeld.orderId]: "paid_without_confirm",
          [confirmedUnpaid.orderId]: "confirmed_without_deposit"
        });
        expect(report.truncated).toBe(false);
        expect(byOrder[clean.orderId]).toBeUndefined();
        expect(byOrder[paidConfirmed.orderId]).toBeUndefined();

        // Another tenant's report is empty (RLS).
        expect(
          (
            await inTenant(
              (tx) => reconcileBookingOrders(tx, TENANT_B),
              TENANT_B
            )
          ).items
        ).toEqual([]);
      });
    });
  }
);
