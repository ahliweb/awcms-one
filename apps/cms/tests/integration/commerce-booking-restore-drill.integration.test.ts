/**
 * The booking adapter's post-restore reconciliation against a REAL migrated
 * PostgreSQL (Issue #396, epic #280 item 35 adapter half; threat controls C-09
 * and C-38, ADR-0045). The unit test (`tests/commerce-booking-restore-drill.test.ts`)
 * pins the verdict, the evidence line and the read-only shape with a fake client;
 * what only a database can prove is that the SQL finds exactly the drift it is
 * meant to find, with the runtime role, under RLS, and only that.
 *
 * Drift is produced the way a damaged restore would leave it: by writing around
 * the application as the schema owner (a reservation's reference cleared or
 * re-pointed with Booking's update guard switched off for the statement, a link
 * released behind the reservation's back, a table's FORCE RLS lost) and then
 * asking the reconciliation what it sees.
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
  type BookingReservationView
} from "../../src/modules/commerce/application/booking-hold-to-order";
import { createOfferingLink } from "../../src/modules/commerce/application/booking-offering-links";
import { saveBookingServiceTenantUserId } from "../../src/modules/commerce/application/booking-adapter-settings";
import {
  BOOKING_ADAPTER_RESTORE_TABLES,
  reconcileBookingRestoreForTenant,
  runBookingRestoreReconciliation
} from "../../src/modules/commerce/application/booking-restore-reconciliation";
import { recordOwnerPayment } from "../../src/modules/commerce/application/payment-recording";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import {
  evaluateBookingRestoreReport,
  type TenantRestoreReport
} from "../../src/modules/commerce/domain/booking-restore-drill";
import type {
  BookingRequestActor,
  BookingReservationRequest
} from "../../src/modules/commerce/domain/booking-hold-to-order";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
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

const TENANT_A = "39600000-0396-4000-8000-00000000000a";
const TENANT_B = "39600000-0396-4000-8000-00000000000b";
const STAFF = "39600000-0396-4000-8000-0000000000b1";
const STAFF_B = "39600000-0396-4000-8000-0000000000b3";
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
  for (const [id, label] of [[staffId, `${code}-staff`]] as [
    string,
    string
  ][]) {
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
      await saveBookingServiceTenantUserId(tx, tenantId, staffId, staffId);
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
const nextKey = () => `k396-${(keySeq += 1)}`;

async function book(
  fx: Fixture,
  req: Partial<BookingReservationRequest> = {}
): Promise<BookingReservationView> {
  const result = await inTenant((tx) =>
    (async () =>
      createBookingReservation(
        tx,
        {
          tenantId: TENANT_A,
          actor: STAFF_ACTOR,
          correlationId: crypto.randomUUID(),
          port: await composedBookingPort(),
          mediaPort: mediaLibraryPortAdapter
        },
        request(fx, req),
        nextKey()
      ))()
  );
  if (result.kind !== "created") {
    throw new Error(`expected created, got ${JSON.stringify(result)}`);
  }
  return result.view;
}

/** A booking on its own dates, so several fit one fixture. */
const stay = (from: number) => ({
  stay: { checkInDate: D(from), checkOutDate: D(from + 2) }
});

/** Test-only: run `fn` as the owner with Booking's reservation update guard off for the statement (a damaged restore is not stopped by it either). */
async function withReservationGuardOff(statements: string[]): Promise<void> {
  await getAdminSql().begin(async (tx) => {
    await tx.unsafe(
      "ALTER TABLE awcms_booking_reservations DISABLE TRIGGER awcms_booking_reservations_update_guard"
    );
    for (const statement of statements) await tx.unsafe(statement);
    await tx.unsafe(
      "ALTER TABLE awcms_booking_reservations ENABLE TRIGGER awcms_booking_reservations_update_guard"
    );
  });
}

async function reconcile(tenantId: string = TENANT_A) {
  const report = await runBookingRestoreReconciliation(getRuntimeSql(), {
    tenantId
  });
  return { report, tenant: report.tenants[0]! as TenantRestoreReport };
}

const kindsOf = (tenant: TenantRestoreReport) =>
  tenant.references.items.map((item) => item.kind).sort();

suite("booking adapter: post-restore reconciliation (Issue #396)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-rd-a", STAFF);
    await seedTenant(TENANT_B, "tenant-rd-b", STAFF_B);
    await configureTenant(TENANT_A, STAFF);
    await configureTenant(TENANT_B, STAFF_B);
  }, 60000);

  test("a database with no booking reconciles clean, and --require-links calls it empty", async () => {
    const { report, tenant } = await reconcile();
    expect(report.structure).toEqual([]);
    expect(tenant.counts.reservationLinks).toBe(0);
    expect(evaluateBookingRestoreReport(report).status).toBe("pass");
    expect(
      evaluateBookingRestoreReport(report, { requireLinks: true }).status
    ).toBe("empty");
  });

  test("two bookings reconcile with zero drift, and the counts say what was checked", async () => {
    const fx = await newFixture();
    await book(fx, stay(10));
    await book(fx, stay(20));
    const { report, tenant } = await reconcile();
    expect(report.structure).toEqual([]);
    expect(tenant.counts).toMatchObject({
      offeringLinks: 1,
      reservationLinks: 2,
      activeReservationLinks: 2,
      refundDecisions: 0
    });
    expect(tenant.references.items).toEqual([]);
    expect(tenant.ledger.items).toEqual([]);
    expect(tenant.decisions.items).toEqual([]);
    const verdict = evaluateBookingRestoreReport(report, {
      requireLinks: true
    });
    expect(verdict.status).toBe("pass");
    expect(verdict.driftTotal).toBe(0);
  });

  test("C-38: a reservation that lost its reference to the order is back_reference_missing", async () => {
    const fx = await newFixture();
    const kept = await book(fx, stay(10));
    const view = await book(fx, stay(20));
    await withReservationGuardOff([
      `UPDATE awcms_booking_reservations SET external_ref_type = NULL, external_ref = NULL WHERE id = '${view.reservationId}'`
    ]);
    const { report, tenant } = await reconcile();
    expect(kindsOf(tenant)).toEqual(["back_reference_missing"]);
    expect(tenant.references.items[0]).toMatchObject({
      reservationId: view.reservationId,
      orderId: view.orderId
    });
    expect(tenant.references.items[0]!.reservationId).not.toBe(
      kept.reservationId
    );
    expect(evaluateBookingRestoreReport(report).status).toBe("drift");
  });

  test("C-38: a reservation pointing at another order is back_reference_mismatch", async () => {
    const fx = await newFixture();
    await book(fx, stay(10));
    const second = await book(fx, stay(20));
    await withReservationGuardOff([
      `UPDATE awcms_booking_reservations SET external_ref = '${crypto.randomUUID()}' WHERE id = '${second.reservationId}'`
    ]);
    const { tenant } = await reconcile();
    expect(kindsOf(tenant)).toEqual(["back_reference_mismatch"]);
    expect(tenant.references.items[0]).toMatchObject({
      reservationId: second.reservationId,
      orderId: second.orderId
    });
  });

  test("C-38: an order named by two live reservations is order_multiple_references, and the lost unique index is named", async () => {
    const fx = await newFixture();
    const first = await book(fx, stay(10));
    const second = await book(fx, stay(20));
    // Booking's partial unique index makes two live references to one order impossible
    // while it exists; a restore that lost it is what leaves them possible.
    const dropIndex = "DROP INDEX awcms_booking_reservations_external_ref_key";
    const createIndex =
      "CREATE UNIQUE INDEX awcms_booking_reservations_external_ref_key ON awcms_booking_reservations (tenant_id, external_ref_type, external_ref) WHERE external_ref IS NOT NULL AND status IN ('held', 'confirmed', 'checked_in')";
    await getAdminSql().unsafe(dropIndex);
    try {
      await withReservationGuardOff([
        `UPDATE awcms_booking_reservations SET external_ref = '${first.orderId}' WHERE id = '${second.reservationId}'`
      ]);
      const { report, tenant } = await reconcile();
      expect(report.structure).toEqual([
        {
          kind: "index_missing",
          object: "awcms_booking_reservations_external_ref_key"
        }
      ]);
      expect(kindsOf(tenant)).toEqual([
        "back_reference_mismatch",
        "order_multiple_references"
      ]);
      const multiple = tenant.references.items.find(
        (item) => item.kind === "order_multiple_references"
      )!;
      expect(multiple).toMatchObject({
        orderId: first.orderId,
        liveReferences: 2
      });
    } finally {
      await withReservationGuardOff([
        `UPDATE awcms_booking_reservations SET external_ref = '${second.orderId}' WHERE id = '${second.reservationId}'`
      ]);
      await getAdminSql().unsafe(createIndex);
    }
    expect((await reconcile()).report.structure).toEqual([]);
  });

  test("C-38: a live reservation whose link was released behind its back is orphan_back_reference", async () => {
    const fx = await newFixture();
    const view = await book(fx, stay(10));
    await getAdminSql()`
      UPDATE awcms_commerce_booking_reservation_links
      SET status = 'released', updated_at = now()
      WHERE reservation_id = ${view.reservationId}
    `;
    const { tenant } = await reconcile();
    expect(kindsOf(tenant)).toEqual(["orphan_back_reference"]);
    expect(tenant.references.items[0]).toMatchObject({
      reservationId: view.reservationId,
      orderId: view.orderId,
      orderExists: true
    });
  });

  test("C-09: an unflagged paid-without-confirm is drift; with an open attention flag it is acknowledged", async () => {
    const fx = await newFixture();
    const view = await book(fx, {
      stay: { checkInDate: D(10), checkOutDate: D(11) }
    });
    // The deposit arrives; nothing dispatched the confirm, so the reservation is still held.
    await inTenant((tx) =>
      recordOwnerPayment(tx, TENANT_A, STAFF, view.orderId, {
        idempotencyKey: crypto.randomUUID(),
        tenderType: "manual_qris",
        amount: PRICE,
        reference: null,
        note: null
      })
    );
    const first = await reconcile();
    expect(first.tenant.ledger.items.map((item) => item.kind)).toEqual([
      "paid_without_confirm"
    ]);
    expect(first.tenant.ledgerAcknowledged).toBe(0);
    expect(evaluateBookingRestoreReport(first.report).status).toBe("drift");

    await getAdminSql()`
      UPDATE awcms_commerce_booking_reservation_links
      SET attention_reason = 'confirm_failed', attention_at = now(), updated_at = now()
      WHERE reservation_id = ${view.reservationId}
    `;
    const second = await reconcile();
    expect(second.tenant.ledger.items).toEqual([]);
    expect(second.tenant.ledgerAcknowledged).toBe(1);
    expect(second.tenant.counts.openAttention).toBe(1);
    expect(evaluateBookingRestoreReport(second.report).status).toBe("pass");
  });

  test("decisions: one that belongs to another order than its link is decision_order_mismatch; one awaiting its return is only counted", async () => {
    const fx = await newFixture();
    const first = await book(fx, stay(10));
    const second = await book(fx, stay(20));
    const link = (await getAdminSql()`
      SELECT id FROM awcms_commerce_booking_reservation_links
      WHERE reservation_id = ${first.reservationId}
    `) as { id: string }[];
    const otherLink = (await getAdminSql()`
      SELECT id FROM awcms_commerce_booking_reservation_links
      WHERE reservation_id = ${second.reservationId}
    `) as { id: string }[];
    const insertDecision = (
      orderId: string,
      linkId: string,
      sourceKey: string,
      refund: string
    ) => getAdminSql()`
      INSERT INTO awcms_commerce_booking_refund_decisions
        (tenant_id, order_id, reservation_link_id, trigger_kind, actor_kind,
         policy_source, hours_before_start, refundable_percent, amount_paid,
         computed_refund, final_refund, source_key)
      VALUES (${TENANT_A}, ${orderId}, ${linkId}, 'staff_cancel', 'system',
              'none', 48, 0, ${PRICE}, ${refund}, ${refund}, ${sourceKey})
    `;
    // Healthy shape, money to refund, no return yet: transient.
    await insertDecision(
      first.orderId,
      link[0]!.id,
      "booking-cancel:a",
      "100000.00"
    );
    const awaiting = await reconcile();
    expect(awaiting.tenant.decisions.items).toEqual([]);
    expect(awaiting.tenant.counts).toMatchObject({
      refundDecisions: 1,
      decisionsAwaitingLegs: 1
    });
    expect(evaluateBookingRestoreReport(awaiting.report).status).toBe("pass");

    // The second link's decision names the FIRST order.
    await insertDecision(
      first.orderId,
      otherLink[0]!.id,
      "booking-cancel:b",
      "0.00"
    );
    const mismatch = await reconcile();
    expect(mismatch.tenant.decisions.items.map((item) => item.kind)).toEqual([
      "decision_order_mismatch"
    ]);
    expect(evaluateBookingRestoreReport(mismatch.report).driftByKind).toEqual({
      "decision:decision_order_mismatch": 1
    });
  });

  test("structure: a table that lost FORCE ROW LEVEL SECURITY is named", async () => {
    const table = BOOKING_ADAPTER_RESTORE_TABLES[1];
    await getAdminSql().unsafe(
      `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`
    );
    try {
      const { report } = await reconcile();
      expect(report.structure).toEqual([
        { kind: "rls_not_forced", object: table }
      ]);
      expect(evaluateBookingRestoreReport(report).status).toBe("drift");
    } finally {
      await getAdminSql().unsafe(
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`
      );
    }
    expect((await reconcile()).report.structure).toEqual([]);
  });

  test("tenant scope: another tenant's drift is never reported, and tenant B is clean", async () => {
    const fx = await newFixture();
    const view = await book(fx, stay(10));
    await withReservationGuardOff([
      `UPDATE awcms_booking_reservations SET external_ref_type = NULL, external_ref = NULL WHERE id = '${view.reservationId}'`
    ]);
    expect(kindsOf((await reconcile(TENANT_A)).tenant)).toEqual([
      "back_reference_missing"
    ]);
    const other = (await reconcile(TENANT_B)).tenant;
    expect(other.references.items).toEqual([]);
    expect(other.counts.reservationLinks).toBe(0);

    // Without a tenant the drill covers every active tenant, one pass each.
    const all = await runBookingRestoreReconciliation(getRuntimeSql());
    expect(all.tenants.map((entry) => entry.tenantId).sort()).toEqual(
      [TENANT_A, TENANT_B].sort()
    );
  });

  test("read-only: the drill's transaction refuses a write, so it cannot change what it judges", async () => {
    const fx = await newFixture();
    await book(fx, stay(10));
    const before = (await getAdminSql()`
      SELECT count(*)::int AS n, max(updated_at) AS touched
      FROM awcms_commerce_booking_reservation_links
    `) as { n: number; touched: Date }[];
    await expect(
      inTenant(async (tx) => {
        await reconcileBookingRestoreForTenant(tx, TENANT_A);
        await tx`UPDATE awcms_commerce_booking_reservation_links SET updated_at = now() WHERE tenant_id = ${TENANT_A}`;
      })
    ).rejects.toThrow(/read-only/i);
    const after = (await getAdminSql()`
      SELECT count(*)::int AS n, max(updated_at) AS touched
      FROM awcms_commerce_booking_reservation_links
    `) as { n: number; touched: Date }[];
    expect(after[0]).toEqual(before[0]!);
  });
});
