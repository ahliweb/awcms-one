/**
 * Shared fixtures for the booking-commerce adapter's integration suites that
 * follow issue #381 (the reschedule and no-show suites of issue #382): a tenant
 * with the `booking` feature on and a service-account user, a stay product linked
 * to a one-unit room offering, a booked and paid reservation, and the small reads
 * the assertions use. World 1 of `harness.ts` (the `awcms_app` runtime pool and
 * the REAL composed `BookingPort`).
 *
 * Not a test file (no `.test.ts` suffix): `bun test` does not run it. A suite
 * calls {@link createAdapterFixtures} with its own tenant and user ids so two
 * suites never share a row.
 */
import { composedBookingPort } from "../../src/lib/composition/booking-port";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { saveBookingServiceTenantUserId } from "../../src/modules/commerce/application/booking-adapter-settings";
import {
  approvePolicy,
  createPolicyDraft,
  type PolicyRecord
} from "../../src/modules/commerce/application/booking-cancellation-policies";
import { createBookingReservation } from "../../src/modules/commerce/application/booking-hold-to-order";
import { createOfferingLink } from "../../src/modules/commerce/application/booking-offering-links";
import { recordOwnerPayment } from "../../src/modules/commerce/application/payment-recording";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import {
  type BookingRequestActor,
  type BookingReservationRequest
} from "../../src/modules/commerce/domain/booking-hold-to-order";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { getAdminSql, getRuntimeSql } from "./harness";

export const HOUR = 3_600_000;
export const PRICE = "500000.00";
export const GUEST_PHONE = "081311112222";

/** v1 of the standard policy: 100% from 7 days, 50% from 2 days, nothing closer. */
export const STANDARD_WINDOWS = [
  { minHoursBeforeStart: 168, refundablePercent: "100.00" },
  { minHoursBeforeStart: 48, refundablePercent: "50.00" }
];

export type AdapterFixtureConfig = {
  tenantA: string;
  tenantB: string;
  staff: string;
  manager: string;
  service: string;
  staffB: string;
  serviceB: string;
  /** Prefix of generated idempotency keys. */
  keyPrefix: string;
};

export type Fixture = {
  productId: string;
  offeringId: string;
  resourceId: string;
};

/** A local date `day` days after a point comfortably inside Booking's default horizon. */
export const D = (day: number): string =>
  new Date(Date.now() + (60 + day) * 86_400_000).toISOString().slice(0, 10);

export function createAdapterFixtures(config: AdapterFixtureConfig) {
  const { tenantA, tenantB, staff, manager } = config;
  let fixtureSeq = 0;
  let keySeq = 0;
  const nextKey = (): string => `${config.keyPrefix}-${(keySeq += 1)}`;

  function inTenant<T>(
    fn: (tx: Bun.TransactionSQL) => Promise<T>,
    tenantId: string = tenantA
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
    serviceId: string | null,
    payment: Record<string, unknown> = {
      manualQris: { active: true, mediaObjectId: null }
    }
  ): Promise<void> {
    const validated = validateStoreSettingsInput({
      storeName: "Villa",
      shipping: { selfPickup: true },
      payment
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
        await saveBookingServiceTenantUserId(
          tx,
          tenantId,
          serviceId,
          serviceId
        );
      }
    }, tenantId);
  }

  async function newFixture(
    tenantId: string = tenantA,
    staffId: string = staff,
    options: { maxNights?: number; price?: string } = {}
  ): Promise<Fixture> {
    fixtureSeq += 1;
    const code = `${config.keyPrefix}${fixtureSeq}`;
    const admin = getAdminSql();
    const product = (await admin`
      INSERT INTO awcms_commerce_products
        (tenant_id, type, sku, name, slug, price, stock, status)
      VALUES (${tenantId}, 'service', ${`SKU-${code}`}, ${`Kamar ${code}`}, ${`kamar-${code}`}, ${options.price ?? PRICE}, 0, 'active')
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
      VALUES (${tenantId}, ${`night-${code}`}, 'Night', 'stay', 1, ${options.maxNights ?? 30}, 4, 'hold_then_confirm')
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

  /**
   * A TIME-SLOT service: a slot resource open all day every day, a one-hour
   * offering (15-minute step) linked to a service product sold per booking
   * (`quantityBasis = "booking"`, one unit).
   */
  async function newSlotFixture(
    tenantId: string = tenantA,
    staffId: string = staff
  ): Promise<Fixture> {
    fixtureSeq += 1;
    const code = `${config.keyPrefix}s${fixtureSeq}`;
    const admin = getAdminSql();
    const product = (await admin`
      INSERT INTO awcms_commerce_products
        (tenant_id, type, sku, name, slug, price, stock, status)
      VALUES (${tenantId}, 'service', ${`SKU-${code}`}, ${`Sesi ${code}`}, ${`sesi-${code}`}, ${PRICE}, 0, 'active')
      RETURNING id
    `) as { id: string }[];
    const resource = (await admin`
      INSERT INTO awcms_booking_resources
        (tenant_id, code, name, kind, capacity, timezone, booking_mode)
      VALUES (${tenantId}, ${code}, ${`Studio ${code}`}, 'room', 1,
              'Asia/Pontianak', 'slot')
      RETURNING id
    `) as { id: string }[];
    await admin`
      INSERT INTO awcms_booking_resource_units (tenant_id, resource_id, ordinal)
      VALUES (${tenantId}, ${resource[0]!.id}, 1)
    `;
    const day = [{ from: "00:00", to: "24:00" }];
    await admin`
      INSERT INTO awcms_booking_schedules
        (tenant_id, resource_id, timezone, effective_from, rules)
      VALUES (${tenantId}, ${resource[0]!.id}, 'Asia/Pontianak', '2020-01-01',
              ${{ weekly: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day } }}::jsonb)
    `;
    const offering = (await admin`
      INSERT INTO awcms_booking_service_offerings
        (tenant_id, code, name, granularity, duration_seconds, setup_seconds,
         cleanup_seconds, slot_step_seconds, max_party, confirmation_mode)
      VALUES (${tenantId}, ${`hour-${code}`}, 'Hour', 'time', 3600, 0, 0, 900,
              4, 'hold_then_confirm')
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
            quantityBasis: "booking",
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

  /** A quarter-hour-aligned UTC instant `day` days after a point inside Booking's default horizon. */
  function slotAt(day: number, hourUtc = 5): string {
    const base = new Date(Date.now() + (60 + day) * 86_400_000);
    base.setUTCHours(hourUtc, 0, 0, 0);
    return base.toISOString().replace(".000Z", "Z");
  }

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

  async function book(
    fx: Fixture,
    options: {
      req?: Partial<BookingReservationRequest>;
      tenantId?: string;
      staffId?: string;
    } = {}
  ) {
    const tenantId = options.tenantId ?? tenantA;
    const actor: BookingRequestActor = {
      kind: "staff",
      tenantUserId: options.staffId ?? staff
    };
    const result = await inTenant(
      async (tx) =>
        createBookingReservation(
          tx,
          {
            tenantId,
            actor,
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
    tenantId: string = tenantA,
    staffId: string = staff
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

  async function dispatch(tenantId: string = tenantA): Promise<void> {
    for (let pass = 0; pass < 4; pass += 1) {
      await dispatchDomainEventsForTenant(getRuntimeSql(), tenantId, {
        limit: 200
      });
    }
  }

  /** A booked stay, paid in full, and confirmed by the real consumer: a reservation that can be rescheduled. */
  async function bookedAndPaid(
    fx: Fixture,
    options: { nights?: number; startDay?: number; amount?: string } = {}
  ) {
    const nights = options.nights ?? 2;
    const start = options.startDay ?? 10;
    const view = await book(fx, {
      req: { stay: { checkInDate: D(start), checkOutDate: D(start + nights) } }
    });
    await pay(
      view.orderId,
      options.amount ?? (Number(PRICE.slice(0, -3)) * nights).toFixed(2)
    );
    await dispatch();
    return view;
  }

  async function startsAtOf(
    reservationId: string,
    tenantId: string = tenantA
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

  async function orderStatus(orderId: string): Promise<string> {
    const rows = (await getAdminSql()`
      SELECT status FROM awcms_commerce_orders WHERE id = ${orderId}
    `) as { status: string }[];
    return rows[0]!.status;
  }

  async function policy(
    productId: string | null,
    windows = STANDARD_WINDOWS,
    options: {
      basis?: "whole_stay" | "per_night";
      retention?: "retain_deposit" | "retain_all" | "refund_per_windows";
      tenantId?: string;
      author?: string;
      approver?: string;
    } = {}
  ): Promise<PolicyRecord> {
    const tenantId = options.tenantId ?? tenantA;
    const draft = await inTenant(
      (tx) =>
        createPolicyDraft(
          tx,
          tenantId,
          options.author ?? staff,
          {
            productId,
            refundBasis: options.basis ?? "whole_stay",
            noShowRetention: options.retention ?? "retain_deposit",
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
          options.approver ?? manager,
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

  async function auditActions(
    resourceId: string,
    tenantId: string = tenantA
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

  async function attemptSql(
    query: PromiseLike<unknown>
  ): Promise<string | null> {
    try {
      await query;
      return null;
    } catch (error) {
      return (error as { message?: string }).message ?? String(error);
    }
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

  /**
   * Edits Booking's reservation row the way no application path can: its update
   * guard (`awcms_booking_reservations_update_guard`) refuses a column outside a
   * transition's allowed set, so the guard is switched off for the one statement,
   * as the table's owner, and always switched back on. `setClause` is test-authored
   * SQL, never input.
   */
  async function tamperReservation(
    reservationId: string,
    setClause: string
  ): Promise<void> {
    const admin = getAdminSql();
    await admin.unsafe(
      "ALTER TABLE awcms_booking_reservations DISABLE TRIGGER awcms_booking_reservations_update_guard"
    );
    try {
      await admin.unsafe(
        `UPDATE awcms_booking_reservations SET ${setClause} WHERE id = '${reservationId}'`
      );
    } finally {
      await admin.unsafe(
        "ALTER TABLE awcms_booking_reservations ENABLE TRIGGER awcms_booking_reservations_update_guard"
      );
    }
  }

  /**
   * Moves a reservation's arrival into the PAST (Booking refuses to hold one
   * there): the no-show tests need a booking whose arrival plus the grace has
   * elapsed. Only the reservation row moves - the allocations stay - which is all
   * `markNoShow` and `get` read.
   */
  async function arrivedHoursAgo(
    reservationId: string,
    hoursAgo: number
  ): Promise<void> {
    await tamperReservation(
      reservationId,
      `starts_at = now() - make_interval(hours => ${Math.trunc(hoursAgo)}),
       ends_at = now() - make_interval(hours => ${Math.trunc(hoursAgo)}) + interval '2 days'`
    );
  }

  return {
    config,
    tenantA,
    tenantB,
    inTenant,
    seedTenant,
    configureTenant,
    newFixture,
    newSlotFixture,
    slotAt,
    request,
    book,
    pay,
    dispatch,
    bookedAndPaid,
    startsAtOf,
    reservationStatus,
    orderStatus,
    policy,
    auditActions,
    attemptSql,
    legsOf,
    arrivedHoursAgo,
    tamperReservation,
    nextKey
  };
}

export type AdapterFixtures = ReturnType<typeof createAdapterFixtures>;
