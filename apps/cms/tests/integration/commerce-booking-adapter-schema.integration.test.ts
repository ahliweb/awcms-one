/**
 * The booking-commerce adapter's seven tables against a real, migrated PostgreSQL
 * under the least-privilege RUNTIME role (Issue #378, ADR-0045; access matrix
 * section 9 evidence items 3 and 4). WORLD 1 (see `harness.ts`): an ephemeral
 * database with the real `awcms_app` / `awcms_worker` roles, so every assertion
 * is made through a connection that RLS and the privilege grants bind.
 *
 * What this file proves, each against live data:
 *   - RLS: a row of tenant B is invisible and unwritable with tenant A's
 *     context, on every table; and a composite FK refuses a link to another
 *     tenant's offering or reservation (the database itself, not the handler);
 *   - the frozen-column triggers refuse what they promise (identity columns, the
 *     one-way offering and reservation link statuses, the immutable cancellation
 *     policy and its windows, the append-only refund decision whose only
 *     writable column is `return_id`, set once);
 *   - `DELETE` is refused to `awcms_app` on every table, and granted to
 *     `awcms_worker` for the retention engine;
 *   - the money and override CHECKs: a final refund never exceeds what was paid,
 *     an override needs its reason, actor and step-up time together, one
 *     decision per reservation link;
 *   - the customer is DERIVED through the linked order and stored nowhere: no
 *     adapter column names a customer, and two customers of ONE tenant cannot
 *     read each other's links although RLS alone would allow it (so the handler
 *     condition is load-bearing - the second half of this test fails if the
 *     equality in `booking-reservation-links.ts` is removed).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { resetDatabaseCircuitBreakerForTests } from "../../src/lib/database/circuit-breaker";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import {
  fetchReservationLinkCustomer,
  fetchReservationLinkForCustomer,
  listActiveReservationLinksForCustomer
} from "../../src/modules/commerce/application/booking-reservation-links";
import {
  assertRejected,
  getAdminSql,
  getRuntimeSql,
  getWorkerRoleSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase,
  workerRoleActivated
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "37800000-0378-4000-8000-00000000000a";
const TENANT_B = "37800000-0378-4000-8000-00000000000b";

const ADAPTER_TABLES = [
  "awcms_commerce_booking_offering_links",
  "awcms_commerce_booking_reservation_links",
  "awcms_commerce_product_deposit_policies",
  "awcms_commerce_cancellation_policies",
  "awcms_commerce_cancellation_policy_windows",
  "awcms_commerce_booking_refund_decisions",
  "awcms_commerce_booking_offering_link_resources"
] as const;

// SQLSTATEs.
const UNIQUE = "23505";
const FOREIGN_KEY = "23503";
const CHECK = "23514";
const RESTRICT = "23001";
const PRIVILEGE = "42501";

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

/** Awaits a rejected query and asserts its SQLSTATE; resets the circuit breaker the failure counted against. */
async function rejectedWith(
  promise: PromiseLike<unknown>,
  sqlstate: string,
  what: string
): Promise<void> {
  const error = await assertRejected(Promise.resolve(promise), what);
  resetDatabaseCircuitBreakerForTests();
  expect(String((error as { errno?: unknown }).errno ?? error.message)).toBe(
    sqlstate
  );
}

type Seed = {
  staffA: string;
  staffB: string;
  customerA1: string;
  customerA2: string;
  customerB: string;
  svcA: string;
  svc2A: string;
  physicalA: string;
  svcB: string;
  offeringA: string;
  offering2A: string;
  offeringB: string;
  resA: string[];
  resB: string;
  orderA1: string;
  itemA1: string;
  orderA2: string;
  itemA2: string;
  orderB: string;
  itemB: string;
};

let seed: Seed;
let orderSeq = 0;

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedTenantUser(tenantId: string, tag: string): Promise<string> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', ${`Actor ${tag}`})
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`${tag}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  const user = (await admin`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identity[0]!.id})
    RETURNING id
  `) as { id: string }[];
  return user[0]!.id;
}

async function seedCustomer(
  tenantId: string,
  name: string,
  phone: string
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
    VALUES (${tenantId}, ${name}, ${phone})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function seedProduct(
  tenantId: string,
  sku: string,
  type: string
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${tenantId}, ${type}, ${sku}, ${sku}, ${sku.toLowerCase()}, '500000.00', 100, 'active')
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function seedStayOffering(
  tenantId: string,
  code: string,
  confirmationMode = "hold_then_confirm"
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, confirmation_mode)
    VALUES (${tenantId}, ${code}, 'Night', 'stay', 1, 30, ${confirmationMode})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function seedReservation(tenantId: string): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_booking_reservations
      (tenant_id, status, starts_at, ends_at, hold_expires_at)
    VALUES (
      ${tenantId}, 'held', '2026-11-01T03:00:00Z'::timestamptz,
      '2026-11-02T03:00:00Z'::timestamptz, clock_timestamp() + interval '15 minutes'
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function seedOrder(
  tenantId: string,
  customerId: string,
  productId: string
): Promise<{ orderId: string; itemId: string }> {
  orderSeq += 1;
  const admin = getAdminSql();
  const order = (await admin`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method,
       payment_status, shipping_method, subtotal, total)
    VALUES (${tenantId}, ${`BK378-${orderSeq}`}, ${customerId}, 'pending_payment',
      'manual_bank', 'unpaid', 'self_pickup', '500000.00', '500000.00')
    RETURNING id
  `) as { id: string }[];
  const item = (await admin`
    INSERT INTO awcms_commerce_order_items
      (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
    VALUES (${tenantId}, ${order[0]!.id}, ${productId}, 'Night', '500000.00', 1, '500000.00')
    RETURNING id
  `) as { id: string }[];
  return { orderId: order[0]!.id, itemId: item[0]!.id };
}

async function seedAll(): Promise<Seed> {
  await seedTenant(TENANT_A, "bk378-a");
  await seedTenant(TENANT_B, "bk378-b");
  const staffA = await seedTenantUser(TENANT_A, "staff-a");
  const staffB = await seedTenantUser(TENANT_B, "staff-b");
  const customerA1 = await seedCustomer(TENANT_A, "Ani Satu", "+6281300000001");
  const customerA2 = await seedCustomer(TENANT_A, "Budi Dua", "+6281300000002");
  const customerB = await seedCustomer(
    TENANT_B,
    "Citra Tiga",
    "+6281300000003"
  );
  const svcA = await seedProduct(TENANT_A, "SVC-A", "service");
  const svc2A = await seedProduct(TENANT_A, "SVC-A2", "service");
  const physicalA = await seedProduct(TENANT_A, "PHY-A", "physical");
  const svcB = await seedProduct(TENANT_B, "SVC-B", "service");
  const offeringA = await seedStayOffering(TENANT_A, "stay-a");
  const offering2A = await seedStayOffering(TENANT_A, "stay-a2");
  const offeringB = await seedStayOffering(TENANT_B, "stay-b");
  const resA = [
    await seedReservation(TENANT_A),
    await seedReservation(TENANT_A),
    await seedReservation(TENANT_A),
    await seedReservation(TENANT_A)
  ];
  const resB = await seedReservation(TENANT_B);
  const a1 = await seedOrder(TENANT_A, customerA1, svcA);
  const a2 = await seedOrder(TENANT_A, customerA2, svcA);
  const b = await seedOrder(TENANT_B, customerB, svcB);
  return {
    staffA,
    staffB,
    customerA1,
    customerA2,
    customerB,
    svcA,
    svc2A,
    physicalA,
    svcB,
    offeringA,
    offering2A,
    offeringB,
    resA,
    resB,
    orderA1: a1.orderId,
    itemA1: a1.itemId,
    orderA2: a2.orderId,
    itemA2: a2.itemId,
    orderB: b.orderId,
    itemB: b.itemId
  };
}

let linkSeq = 0;

function insertOfferingLink(
  tx: Bun.SQL,
  tenantId: string,
  offeringId: string,
  productId: string,
  basis = "nights"
): Promise<{ id: string }[]> {
  return tx`
    INSERT INTO awcms_commerce_booking_offering_links
      (tenant_id, offering_id, product_id, quantity_basis)
    VALUES (${tenantId}, ${offeringId}, ${productId}, ${basis})
    RETURNING id
  ` as Promise<{ id: string }[]>;
}

function insertReservationLink(
  tx: Bun.SQL,
  tenantId: string,
  args: {
    orderId: string;
    itemId: string;
    reservationId: string;
    offeringLinkId: string;
    clientKey?: string;
    supersedes?: string | null;
  }
): Promise<{ id: string }[]> {
  linkSeq += 1;
  return tx`
    INSERT INTO awcms_commerce_booking_reservation_links
      (tenant_id, order_id, order_item_id, reservation_id, offering_link_id,
       supersedes_link_id, client_key, request_hash)
    VALUES (${tenantId}, ${args.orderId}, ${args.itemId}, ${args.reservationId},
      ${args.offeringLinkId}, ${args.supersedes ?? null},
      ${args.clientKey ?? `ck-${linkSeq}`}, ${"h".repeat(64)})
    RETURNING id
  ` as Promise<{ id: string }[]>;
}

suite("booking adapter tables (Issue #378)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  });
  afterAll(async () => {
    await teardownIntegrationDatabase();
  });
  beforeEach(async () => {
    await resetDatabase();
    resetDatabaseCircuitBreakerForTests();
    seed = await seedAll();
  });

  test("every adapter table has an id primary key, RLS enabled and FORCED, and no customer, contact, price or name column", async () => {
    const admin = getAdminSql();
    for (const table of ADAPTER_TABLES) {
      const rls = (await admin`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ${table} AND relkind = 'r'
      `) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
      expect(rls[0], table).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true
      });
      const columns = (await admin`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}
      `) as { column_name: string }[];
      const names = columns.map((c) => c.column_name);
      expect(names, table).toContain("id");
      expect(names, table).toContain("tenant_id");
      // Finding X7: the customer is derived through the order, never stored.
      for (const forbidden of [
        "customer_id",
        "customer_ref",
        "customer_name",
        "name",
        "phone",
        "email",
        "price",
        "total",
        "balance",
        "payment_status"
      ]) {
        expect(names, `${table}.${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test("a tenant-B row is invisible and unwritable with tenant-A context, on the link tables", async () => {
    // A tenant-B offering link and reservation link, seeded in B's own context.
    const bLink = await inTenant(TENANT_B, (tx) =>
      insertOfferingLink(tx, TENANT_B, seed.offeringB, seed.svcB)
    );
    await inTenant(TENANT_B, (tx) =>
      insertReservationLink(tx, TENANT_B, {
        orderId: seed.orderB,
        itemId: seed.itemB,
        reservationId: seed.resB,
        offeringLinkId: bLink[0]!.id
      })
    );

    const seenFromA = await inTenant(TENANT_A, async (tx) => ({
      offeringLinks: (
        await tx`SELECT id FROM awcms_commerce_booking_offering_links`
      ).length,
      reservationLinks: (
        await tx`SELECT id FROM awcms_commerce_booking_reservation_links`
      ).length
    }));
    expect(seenFromA).toEqual({ offeringLinks: 0, reservationLinks: 0 });

    // A's context cannot write a row stamped with B's tenant id: the guard
    // trigger cannot even see B's product (RLS), and the policy's WITH CHECK is
    // the second line. Either way the write is refused.
    const error = await assertRejected(
      Promise.resolve(
        inTenant(TENANT_A, (tx) =>
          insertOfferingLink(tx, TENANT_B, seed.offeringB, seed.svcB)
        )
      ),
      "an offering link for another tenant"
    );
    resetDatabaseCircuitBreakerForTests();
    expect([PRIVILEGE, CHECK]).toContain(
      String((error as { errno?: unknown }).errno)
    );
  });

  test("composite FKs refuse a link to another tenant's offering, product, reservation or order (the database itself, with RLS out of the way)", async () => {
    // Through the OWNER connection, which RLS does not bind: only the composite
    // (tenant_id, id) foreign keys can refuse these.
    const admin = getAdminSql();
    await rejectedWith(
      insertOfferingLink(admin, TENANT_A, seed.offeringB, seed.svcA),
      FOREIGN_KEY,
      "an offering of another tenant"
    );
    // A product of another tenant is refused by the guard trigger first (its
    // lookup is tenant-scoped); the composite FK is the line behind it.
    await rejectedWith(
      insertOfferingLink(admin, TENANT_A, seed.offeringA, seed.svcB),
      CHECK,
      "a product of another tenant"
    );
    const link = await insertOfferingLink(
      admin,
      TENANT_A,
      seed.offeringA,
      seed.svcA
    );
    await rejectedWith(
      insertReservationLink(admin, TENANT_A, {
        orderId: seed.orderA1,
        itemId: seed.itemA1,
        reservationId: seed.resB,
        offeringLinkId: link[0]!.id
      }),
      FOREIGN_KEY,
      "a reservation of another tenant"
    );
    await rejectedWith(
      insertReservationLink(admin, TENANT_A, {
        orderId: seed.orderB,
        itemId: seed.itemB,
        reservationId: seed.resA[0]!,
        offeringLinkId: link[0]!.id
      }),
      CHECK,
      "an order of another tenant (the guard trigger's tenant-scoped line lookup refuses it before the composite FK)"
    );
  });

  test("offering link: one active link per offering and per product, a service product only, frozen identity, one-way unlink, no delete", async () => {
    const first = await inTenant(TENANT_A, (tx) =>
      insertOfferingLink(tx, TENANT_A, seed.offeringA, seed.svcA)
    );

    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertOfferingLink(tx, TENANT_A, seed.offeringA, seed.svc2A)
      ),
      UNIQUE,
      "a second active link for one offering"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertOfferingLink(tx, TENANT_A, seed.offering2A, seed.svcA)
      ),
      UNIQUE,
      "a second active link for one product"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertOfferingLink(tx, TENANT_A, seed.offering2A, seed.physicalA)
      ),
      CHECK,
      "a physical product"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertOfferingLink(tx, TENANT_A, seed.offering2A, seed.svc2A, "weekly")
      ),
      CHECK,
      "an unknown quantity basis"
    );

    // Identity columns are frozen.
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_booking_offering_links
        SET product_id = ${seed.svc2A} WHERE id = ${first[0]!.id}
      `
      ),
      RESTRICT,
      "re-pointing a link at another product"
    );
    // An 'unlinked' status without its time (and the reverse) breaks the shape CHECK.
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_booking_offering_links
        SET status = 'unlinked' WHERE id = ${first[0]!.id}
      `
      ),
      CHECK,
      "unlinking without unlinked_at"
    );

    await inTenant(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_booking_offering_links
      SET status = 'unlinked', unlinked_at = now(), updated_at = now()
      WHERE id = ${first[0]!.id}
    `
    );
    // The slot is free again for the offering and the product.
    await inTenant(TENANT_A, (tx) =>
      insertOfferingLink(tx, TENANT_A, seed.offeringA, seed.svcA)
    );
    // An unlinked link stays unlinked.
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_booking_offering_links
        SET status = 'active', unlinked_at = NULL WHERE id = ${first[0]!.id}
      `
      ),
      RESTRICT,
      "re-activating an unlinked link"
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        DELETE FROM awcms_commerce_booking_offering_links WHERE id = ${first[0]!.id}
      `
      ),
      PRIVILEGE,
      "deleting a link as awcms_app"
    );
  });

  test("offering link resources (Issue #437): RLS, composite FKs to the tenant's own Booking resource and link, written once with an active link, no UPDATE or DELETE for the app role", async () => {
    const admin = getAdminSql();
    const newResource = async (tenantId: string, code: string) => {
      const rows = (await admin`
        INSERT INTO awcms_booking_resources
          (tenant_id, code, name, kind, capacity, timezone, booking_mode,
           stay_check_in_time, stay_check_out_time)
        VALUES (${tenantId}, ${code}, ${code}, 'room', 1, 'Asia/Pontianak',
                'stay', '14:00'::time, '12:00'::time)
        RETURNING id
      `) as { id: string }[];
      return rows[0]!.id;
    };
    const bind = (
      tx: Bun.SQL,
      tenantId: string,
      linkId: string,
      resourceId: string,
      order = 0
    ) =>
      tx`
        INSERT INTO awcms_commerce_booking_offering_link_resources
          (tenant_id, offering_link_id, resource_id, sort_order)
        VALUES (${tenantId}, ${linkId}, ${resourceId}, ${order})
        RETURNING id
      ` as Promise<{ id: string }[]>;

    const resA1 = await newResource(TENANT_A, "ra1");
    const resA2 = await newResource(TENANT_A, "ra2");
    const resB = await newResource(TENANT_B, "rb1");
    const linkA = await inTenant(TENANT_A, (tx) =>
      insertOfferingLink(tx, TENANT_A, seed.offeringA, seed.svcA)
    );
    const linkB = await inTenant(TENANT_B, (tx) =>
      insertOfferingLink(tx, TENANT_B, seed.offeringB, seed.svcB)
    );

    const first = await inTenant(TENANT_A, (tx) =>
      bind(tx, TENANT_A, linkA[0]!.id, resA1, 0)
    );
    await inTenant(TENANT_A, (tx) =>
      bind(tx, TENANT_A, linkA[0]!.id, resA2, 1)
    );
    await inTenant(TENANT_B, (tx) => bind(tx, TENANT_B, linkB[0]!.id, resB));

    // A resource is bound to a link once.
    await rejectedWith(
      inTenant(TENANT_A, (tx) => bind(tx, TENANT_A, linkA[0]!.id, resA1, 2)),
      UNIQUE,
      "the same resource bound twice to one link"
    );
    // Tenant B's rows are invisible from A, and A cannot write a B-stamped row.
    const seenFromA = await inTenant(
      TENANT_A,
      (tx) => tx`SELECT id FROM awcms_commerce_booking_offering_link_resources`
    );
    expect(seenFromA).toHaveLength(2);
    const crossTenant = await assertRejected(
      Promise.resolve(
        inTenant(TENANT_A, (tx) => bind(tx, TENANT_B, linkB[0]!.id, resB))
      ),
      "a binding stamped with another tenant"
    );
    resetDatabaseCircuitBreakerForTests();
    expect([PRIVILEGE, CHECK, FOREIGN_KEY, RESTRICT]).toContain(
      String((crossTenant as { errno?: unknown }).errno)
    );

    // The composite FKs, with RLS out of the way: another tenant's resource and
    // another tenant's link are refused by the database itself.
    await rejectedWith(
      bind(admin, TENANT_A, linkA[0]!.id, resB),
      FOREIGN_KEY,
      "another tenant's Booking resource"
    );
    await rejectedWith(
      bind(admin, TENANT_A, linkB[0]!.id, resA1),
      RESTRICT,
      "another tenant's offering link (the guard trigger's tenant-scoped lookup refuses it before the composite FK)"
    );

    // Written once: no UPDATE, no DELETE for the app role; the trigger refuses an UPDATE for anyone.
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_booking_offering_link_resources
        SET sort_order = 9 WHERE id = ${first[0]!.id}
      `
      ),
      PRIVILEGE,
      "updating a binding as awcms_app"
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        DELETE FROM awcms_commerce_booking_offering_link_resources
        WHERE id = ${first[0]!.id}
      `
      ),
      PRIVILEGE,
      "deleting a binding as awcms_app"
    );
    await rejectedWith(
      admin`
        UPDATE awcms_commerce_booking_offering_link_resources
        SET sort_order = 9 WHERE id = ${first[0]!.id}
      `,
      RESTRICT,
      "updating a binding as the owner (the guard trigger)"
    );

    // An unlinked link takes no new binding, and keeps the ones it has.
    await inTenant(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_booking_offering_links
      SET status = 'unlinked', unlinked_at = now(), updated_at = now()
      WHERE id = ${linkA[0]!.id}
    `
    );
    const resA3 = await newResource(TENANT_A, "ra3");
    await rejectedWith(
      inTenant(TENANT_A, (tx) => bind(tx, TENANT_A, linkA[0]!.id, resA3)),
      RESTRICT,
      "binding a resource to an unlinked link"
    );
    const kept = await inTenant(
      TENANT_A,
      (tx) =>
        tx`SELECT resource_id FROM awcms_commerce_booking_offering_link_resources
           WHERE offering_link_id = ${linkA[0]!.id} ORDER BY sort_order`
    );
    expect(kept.map((row: { resource_id: string }) => row.resource_id)).toEqual(
      [resA1, resA2]
    );
  });

  test("reservation link: idempotent client key, one active link per reservation and per line, line must belong to the order, frozen facts, one-way status", async () => {
    const offeringLink = await inTenant(TENANT_A, (tx) =>
      insertOfferingLink(tx, TENANT_A, seed.offeringA, seed.svcA)
    );
    const base = {
      orderId: seed.orderA1,
      itemId: seed.itemA1,
      offeringLinkId: offeringLink[0]!.id
    };
    const link = await inTenant(TENANT_A, (tx) =>
      insertReservationLink(tx, TENANT_A, {
        ...base,
        reservationId: seed.resA[0]!,
        clientKey: "key-1"
      })
    );

    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertReservationLink(tx, TENANT_A, {
          ...base,
          reservationId: seed.resA[1]!,
          clientKey: "key-1"
        })
      ),
      UNIQUE,
      "a repeated client key"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertReservationLink(tx, TENANT_A, {
          orderId: seed.orderA2,
          itemId: seed.itemA2,
          reservationId: seed.resA[0]!,
          offeringLinkId: offeringLink[0]!.id
        })
      ),
      UNIQUE,
      "a second active link for one reservation"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertReservationLink(tx, TENANT_A, {
          ...base,
          reservationId: seed.resA[1]!
        })
      ),
      UNIQUE,
      "a second active link for one order line"
    );
    // The line of order A2 does not belong to order A1.
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertReservationLink(tx, TENANT_A, {
          orderId: seed.orderA1,
          itemId: seed.itemA2,
          reservationId: seed.resA[1]!,
          offeringLinkId: offeringLink[0]!.id
        })
      ),
      CHECK,
      "an order line of another order"
    );

    // Frozen facts: the order, the reservation, the key and the request hash.
    const frozen: Record<string, string> = {
      order_id: `'${seed.orderA2}'::uuid`,
      reservation_id: `'${seed.resA[2]!}'::uuid`,
      client_key: "'other-key'",
      request_hash: "'other-hash'"
    };
    for (const [column, value] of Object.entries(frozen)) {
      await rejectedWith(
        inTenant(TENANT_A, (tx) =>
          tx.unsafe(
            `UPDATE awcms_commerce_booking_reservation_links SET ${column} = ${value}
             WHERE id = '${link[0]!.id}'`
          )
        ),
        RESTRICT,
        `rewriting ${column}`
      );
    }

    // A reschedule: the new link supersedes the old one, in one transaction.
    await inTenant(TENANT_A, async (tx) => {
      await tx`
        UPDATE awcms_commerce_booking_reservation_links
        SET status = 'superseded', updated_at = now() WHERE id = ${link[0]!.id}
      `;
      await insertReservationLink(tx, TENANT_A, {
        ...base,
        reservationId: seed.resA[1]!,
        supersedes: link[0]!.id
      });
    });
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_booking_reservation_links
        SET status = 'active' WHERE id = ${link[0]!.id}
      `
      ),
      RESTRICT,
      "reviving a superseded link"
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        DELETE FROM awcms_commerce_booking_reservation_links WHERE id = ${link[0]!.id}
      `
      ),
      PRIVILEGE,
      "deleting a reservation link as awcms_app"
    );
  });

  test("reservation link attention flag: closed codes only, raised once, resolved once, a new one only after resolution", async () => {
    const offeringLink = await inTenant(TENANT_A, (tx) =>
      insertOfferingLink(tx, TENANT_A, seed.offeringA, seed.svcA)
    );
    const link = await inTenant(TENANT_A, (tx) =>
      insertReservationLink(tx, TENANT_A, {
        orderId: seed.orderA1,
        itemId: seed.itemA1,
        reservationId: seed.resA[0]!,
        offeringLinkId: offeringLink[0]!.id
      })
    );
    const id = link[0]!.id;

    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_booking_reservation_links
        SET attention_reason = 'because', attention_at = now() WHERE id = ${id}
      `
      ),
      CHECK,
      "an unknown attention code"
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_booking_reservation_links
        SET attention_reason = 'confirm_failed' WHERE id = ${id}
      `
      ),
      CHECK,
      "a reason without its time"
    );
    // Every code of the G7 superset is admitted (one at a time, resolving between).
    for (const reason of [
      "deposit_after_expiry",
      "confirm_failed",
      "rescheduled_externally",
      "cancelled_externally_paid"
    ]) {
      await inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_booking_reservation_links
        SET attention_reason = ${reason}, attention_at = clock_timestamp(),
            attention_resolved_at = NULL, updated_at = now()
        WHERE id = ${id}
      `
      );
      // An open flag cannot be replaced by another one...
      await rejectedWith(
        inTenant(
          TENANT_A,
          (tx) => tx`
          UPDATE awcms_commerce_booking_reservation_links
          SET attention_reason = ${reason === "confirm_failed" ? "deposit_after_expiry" : "confirm_failed"},
              attention_at = clock_timestamp()
          WHERE id = ${id}
        `
        ),
        RESTRICT,
        "replacing an open attention flag"
      );
      // ...it is resolved, which keeps the reason.
      await inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_booking_reservation_links
        SET attention_resolved_at = clock_timestamp() WHERE id = ${id}
      `
      );
    }
    const final = (await getAdminSql()`
      SELECT attention_reason, attention_resolved_at IS NOT NULL AS resolved
      FROM awcms_commerce_booking_reservation_links WHERE id = ${id}
    `) as { attention_reason: string; resolved: boolean }[];
    expect(final[0]).toEqual({
      attention_reason: "cancelled_externally_paid",
      resolved: true
    });
  });

  test("deposit policy: a percent xor a fixed amount, one active per product, retirement freezes the row, no delete", async () => {
    const insert = (
      tx: Bun.SQL,
      kind: string,
      percent: string | null,
      fixed: string | null
    ) =>
      tx`
        INSERT INTO awcms_commerce_product_deposit_policies
          (tenant_id, product_id, kind, percent, fixed_amount)
        VALUES (${TENANT_A}, ${seed.svcA}, ${kind}, ${percent}, ${fixed})
        RETURNING id
      ` as Promise<{ id: string }[]>;

    await rejectedWith(
      inTenant(TENANT_A, (tx) => insert(tx, "percent", null, null)),
      CHECK,
      "a percent policy without a percent"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) => insert(tx, "percent", "30", "10000")),
      CHECK,
      "both a percent and a fixed amount"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) => insert(tx, "percent", "0", null)),
      CHECK,
      "a zero percent"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) => insert(tx, "percent", "100.01", null)),
      CHECK,
      "over one hundred percent"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) => insert(tx, "fixed", null, "0")),
      CHECK,
      "a zero fixed amount"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) => insert(tx, "weekly", "10", null)),
      CHECK,
      "an unknown kind"
    );

    const policy = await inTenant(TENANT_A, (tx) =>
      insert(tx, "percent", "30", null)
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) => insert(tx, "fixed", null, "100000")),
      UNIQUE,
      "a second active policy for one product"
    );
    // An active policy can be edited in place; its product is frozen.
    await inTenant(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_product_deposit_policies
      SET kind = 'fixed', percent = NULL, fixed_amount = '150000.00', updated_at = now()
      WHERE id = ${policy[0]!.id}
    `
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_product_deposit_policies
        SET product_id = ${seed.svc2A} WHERE id = ${policy[0]!.id}
      `
      ),
      RESTRICT,
      "moving a policy to another product"
    );
    await inTenant(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_product_deposit_policies
      SET retired_at = now() WHERE id = ${policy[0]!.id}
    `
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_product_deposit_policies
        SET fixed_amount = '1.00' WHERE id = ${policy[0]!.id}
      `
      ),
      RESTRICT,
      "editing a retired policy"
    );
    // A retirement frees the product for a new policy.
    await inTenant(TENANT_A, (tx) => insert(tx, "percent", "50", null));
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        DELETE FROM awcms_commerce_product_deposit_policies WHERE id = ${policy[0]!.id}
      `
      ),
      PRIVILEGE,
      "deleting a deposit policy as awcms_app"
    );
  });

  test("cancellation policy: draft, then active, then retired; windows frozen with the policy; non-increasing refund shares; one active per product and one default", async () => {
    const newPolicy = (
      tx: Bun.SQL,
      productId: string | null,
      version: number,
      status = "draft"
    ) =>
      tx`
        INSERT INTO awcms_commerce_cancellation_policies
          (tenant_id, product_id, version, status, activated_at)
        VALUES (${TENANT_A}, ${productId}, ${version}, ${status},
          ${status === "draft" ? null : new Date()})
        RETURNING id
      ` as Promise<{ id: string }[]>;
    const addWindow = (
      tx: Bun.SQL,
      policyId: string,
      hours: number,
      percent: string
    ) =>
      tx`
        INSERT INTO awcms_commerce_cancellation_policy_windows
          (tenant_id, policy_id, min_hours_before_start, refundable_percent)
        VALUES (${TENANT_A}, ${policyId}, ${hours}, ${percent})
        RETURNING id
      ` as Promise<{ id: string }[]>;

    // A policy is created as a draft.
    await rejectedWith(
      inTenant(TENANT_A, (tx) => newPolicy(tx, seed.svcA, 1, "active")),
      RESTRICT,
      "a policy created active"
    );

    const draft = await inTenant(TENANT_A, (tx) => newPolicy(tx, seed.svcA, 1));
    // Version numbers are unique per product - and per tenant for the default.
    await rejectedWith(
      inTenant(TENANT_A, (tx) => newPolicy(tx, seed.svcA, 1)),
      UNIQUE,
      "a repeated product version"
    );
    const defaultDraft = await inTenant(TENANT_A, (tx) =>
      newPolicy(tx, null, 1)
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) => newPolicy(tx, null, 1)),
      UNIQUE,
      "a repeated default version (NULL product ids)"
    );

    // Windows are added while a draft; a window refund must be 0..100 and hours >= 0.
    await inTenant(TENANT_A, async (tx) => {
      await addWindow(tx, draft[0]!.id, 168, "100");
      await addWindow(tx, draft[0]!.id, 48, "50");
      await addWindow(tx, draft[0]!.id, 0, "0");
    });
    await rejectedWith(
      inTenant(TENANT_A, (tx) => addWindow(tx, draft[0]!.id, 48, "40")),
      UNIQUE,
      "two windows with the same notice"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) => addWindow(tx, draft[0]!.id, -1, "40")),
      CHECK,
      "negative hours"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) => addWindow(tx, draft[0]!.id, 12, "101")),
      CHECK,
      "over one hundred percent"
    );

    // A non-monotonic policy cannot be activated: more notice must not refund less.
    await inTenant(TENANT_A, async (tx) => {
      await addWindow(tx, defaultDraft[0]!.id, 72, "20");
      await addWindow(tx, defaultDraft[0]!.id, 24, "80");
    });
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_cancellation_policies
        SET status = 'active', activated_at = now() WHERE id = ${defaultDraft[0]!.id}
      `
      ),
      CHECK,
      "activating a policy whose refund share grows as notice shrinks"
    );

    // The monotonic one activates; its windows are then frozen.
    await inTenant(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_cancellation_policies
      SET status = 'active', activated_at = now() WHERE id = ${draft[0]!.id}
    `
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) => addWindow(tx, draft[0]!.id, 12, "10")),
      RESTRICT,
      "a window added to an active policy"
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_cancellation_policy_windows
        SET refundable_percent = 100 WHERE policy_id = ${draft[0]!.id}
      `
      ),
      PRIVILEGE,
      "updating a window as awcms_app"
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_cancellation_policies
        SET no_show_retention = 'retain_all' WHERE id = ${draft[0]!.id}
      `
      ),
      RESTRICT,
      "editing the rules of an active policy"
    );

    // One active policy per product: a v2 draft cannot go active beside v1.
    const v2 = await inTenant(TENANT_A, (tx) => newPolicy(tx, seed.svcA, 2));
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_cancellation_policies
        SET status = 'active', activated_at = now() WHERE id = ${v2[0]!.id}
      `
      ),
      UNIQUE,
      "two active policies for one product"
    );
    // Retire v1 first, then v2 activates; a retired policy never comes back.
    await inTenant(TENANT_A, async (tx) => {
      await tx`
        UPDATE awcms_commerce_cancellation_policies
        SET status = 'retired', retired_at = now() WHERE id = ${draft[0]!.id}
      `;
      await tx`
        UPDATE awcms_commerce_cancellation_policies
        SET status = 'active', activated_at = now() WHERE id = ${v2[0]!.id}
      `;
    });
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_cancellation_policies
        SET status = 'active', retired_at = NULL WHERE id = ${draft[0]!.id}
      `
      ),
      RESTRICT,
      "reviving a retired policy"
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        DELETE FROM awcms_commerce_cancellation_policies WHERE id = ${draft[0]!.id}
      `
      ),
      PRIVILEGE,
      "deleting a cancellation policy as awcms_app"
    );
  });

  async function newLink(
    reservationIndex = 0,
    orderId = seed.orderA1,
    itemId = seed.itemA1
  ): Promise<string> {
    const offeringLink = await inTenant(TENANT_A, async (tx) => {
      const existing = (await tx`
        SELECT id FROM awcms_commerce_booking_offering_links
        WHERE offering_id = ${seed.offeringA} AND status = 'active'
      `) as { id: string }[];
      return existing[0]
        ? existing
        : insertOfferingLink(tx, TENANT_A, seed.offeringA, seed.svcA);
    });
    const link = await inTenant(TENANT_A, (tx) =>
      insertReservationLink(tx, TENANT_A, {
        orderId,
        itemId,
        reservationId: seed.resA[reservationIndex]!,
        offeringLinkId: offeringLink[0]!.id
      })
    );
    return link[0]!.id;
  }

  function insertDecision(
    tx: Bun.SQL,
    linkId: string,
    overrides: Record<string, unknown> = {}
  ): Promise<{ id: string }[]> {
    const v = {
      trigger_kind: "staff_cancel",
      actor_kind: "staff",
      actor_tenant_user_id: seed.staffA,
      policy_id: null,
      policy_source: "none",
      hours_before_start: 30,
      refundable_percent: "0",
      amount_paid: "100000.00",
      computed_refund: "0",
      final_refund: "0",
      override_reason: null,
      override_actor_tenant_user_id: null,
      override_stepup_at: null,
      source_key: `booking-cancel:${linkId}`,
      ...overrides
    } as Record<string, string | number | Date | null>;
    return tx`
      INSERT INTO awcms_commerce_booking_refund_decisions
        (tenant_id, order_id, reservation_link_id, trigger_kind, actor_kind,
         actor_tenant_user_id, policy_id, policy_source, hours_before_start,
         refundable_percent, amount_paid, computed_refund, final_refund,
         override_reason, override_actor_tenant_user_id, override_stepup_at, source_key)
      VALUES (${TENANT_A}, ${seed.orderA1}, ${linkId}, ${v.trigger_kind},
        ${v.actor_kind}, ${v.actor_tenant_user_id}, ${v.policy_id}, ${v.policy_source},
        ${v.hours_before_start}, ${v.refundable_percent}, ${v.amount_paid},
        ${v.computed_refund}, ${v.final_refund}, ${v.override_reason},
        ${v.override_actor_tenant_user_id}, ${v.override_stepup_at}, ${v.source_key})
      RETURNING id
    ` as Promise<{ id: string }[]>;
  }

  test("refund decision: never above the amount paid, the override needs its reason + actor + step-up together, one decision per link", async () => {
    const linkId = await newLink();
    // No policy applied: the computed refund is 0; a manager raises it.
    const override = {
      final_refund: "60000.00",
      computed_refund: "0",
      refundable_percent: "0",
      policy_source: "none"
    };

    // 'none' means refundable_percent 0 (nothing was computed from a policy).
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertDecision(tx, linkId, { refundable_percent: "50" })
      ),
      CHECK,
      "policy_source none with a non-zero share"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertDecision(tx, linkId, {
          computed_refund: "100000.01",
          final_refund: "100000.01"
        })
      ),
      CHECK,
      "a computed refund above the amount paid"
    );
    // An override above what was paid is refused whoever approves it (C-10).
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertDecision(tx, linkId, {
          final_refund: "100000.01",
          override_reason: "Goodwill for a double charge.",
          override_actor_tenant_user_id: seed.staffA,
          override_stepup_at: new Date()
        })
      ),
      CHECK,
      "a final refund above the amount paid"
    );
    // final <> computed without the override evidence, and the evidence without a change.
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertDecision(tx, linkId, {
          final_refund: "10000.00"
        })
      ),
      CHECK,
      "a changed amount without an override reason"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertDecision(tx, linkId, {
          override_reason: "Nothing actually changed here.",
          override_actor_tenant_user_id: seed.staffA,
          override_stepup_at: new Date()
        })
      ),
      CHECK,
      "override evidence on an unchanged amount"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertDecision(tx, linkId, {
          ...override,
          override_reason: "short",
          override_actor_tenant_user_id: seed.staffA,
          override_stepup_at: new Date()
        })
      ),
      CHECK,
      "an override reason under ten characters"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertDecision(tx, linkId, {
          ...override,
          override_reason: "Manager approved a goodwill amount.",
          override_actor_tenant_user_id: null,
          override_stepup_at: new Date()
        })
      ),
      CHECK,
      "an override with no approver"
    );
    // A customer cancel carries no staff id; a staff cancel must carry one.
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertDecision(tx, linkId, {
          actor_kind: "customer",
          actor_tenant_user_id: seed.staffA
        })
      ),
      CHECK,
      "a customer decision naming a staff member"
    );
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertDecision(tx, linkId, { actor_tenant_user_id: null })
      ),
      CHECK,
      "a staff decision with no staff member"
    );

    // A valid override.
    const decision = await inTenant(TENANT_A, (tx) =>
      insertDecision(tx, linkId, {
        ...override,
        override_reason: "Manager approved a goodwill amount.",
        override_actor_tenant_user_id: seed.staffA,
        override_stepup_at: new Date()
      })
    );
    expect(decision).toHaveLength(1);

    // A replay finds the same decision: one per reservation link, one per source key.
    await rejectedWith(
      inTenant(TENANT_A, (tx) =>
        insertDecision(tx, linkId, { source_key: "another-key" })
      ),
      UNIQUE,
      "a second decision for one reservation link"
    );
  });

  test("refund decision is append-only: every column frozen but return_id, which is set once; no delete for the app role", async () => {
    const linkId = await newLink();
    const decision = await inTenant(TENANT_A, (tx) =>
      insertDecision(tx, linkId)
    );
    const id = decision[0]!.id;

    // The app role holds UPDATE on return_id only.
    for (const column of [
      "final_refund",
      "computed_refund",
      "amount_paid",
      "source_key"
    ]) {
      await rejectedWith(
        inTenant(TENANT_A, (tx) =>
          tx.unsafe(
            `UPDATE awcms_commerce_booking_refund_decisions SET ${column} = ${column} WHERE id = '${id}'`
          )
        ),
        PRIVILEGE,
        `app role updating ${column}`
      );
    }
    // The trigger is the second line: it stops a role that does hold UPDATE.
    await rejectedWith(
      getAdminSql()`
        UPDATE awcms_commerce_booking_refund_decisions
        SET final_refund = 0, computed_refund = 0, amount_paid = 99 WHERE id = ${id}
      `,
      RESTRICT,
      "the trigger refusing an owner-role rewrite"
    );

    // return_id is set once.
    const admin = getAdminSql();
    const returns = (await admin`
      INSERT INTO awcms_commerce_returns
        (tenant_id, order_id, kind, status, goods_gross, discount_share,
         shipping_refund, refund_total, source_key, actor_tenant_user_id)
      VALUES (${TENANT_A}, ${seed.orderA1}, 'return', 'open', 0, 0, 0, 0,
        'ret-378-1', ${seed.staffA}),
        (${TENANT_A}, ${seed.orderA1}, 'return', 'open', 0, 0, 0, 0,
        'ret-378-2', ${seed.staffA})
      RETURNING id
    `) as { id: string }[];
    await inTenant(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_booking_refund_decisions
      SET return_id = ${returns[0]!.id} WHERE id = ${id}
    `
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_booking_refund_decisions
        SET return_id = ${returns[1]!.id} WHERE id = ${id}
      `
      ),
      RESTRICT,
      "re-pointing the return"
    );
    await rejectedWith(
      inTenant(
        TENANT_A,
        (tx) => tx`
        DELETE FROM awcms_commerce_booking_refund_decisions WHERE id = ${id}
      `
      ),
      PRIVILEGE,
      "deleting a decision as awcms_app"
    );

    // Tenant isolation of the decision table.
    const fromB = await inTenant(
      TENANT_B,
      (tx) => tx`SELECT id FROM awcms_commerce_booking_refund_decisions`
    );
    expect(fromB).toHaveLength(0);
  });

  test("awcms_worker holds SELECT and DELETE (for the retention engine) on every adapter table, and no INSERT or UPDATE", async () => {
    if (!workerRoleActivated) {
      console.warn("[skip] awcms_worker is not activated in this database.");
      return;
    }
    const admin = getAdminSql();
    for (const table of ADAPTER_TABLES) {
      const grants = (await admin`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'awcms_worker' AND table_name = ${table}
      `) as { privilege_type: string }[];
      const held = grants.map((g) => g.privilege_type).sort();
      expect(held, table).toEqual(["DELETE", "SELECT"]);
    }
    // And it can actually purge a row the engine would select (a cursor-shaped delete).
    const linkId = await newLink();
    const decision = await inTenant(TENANT_A, (tx) =>
      insertDecision(tx, linkId)
    );
    const worker = getWorkerRoleSql();
    const deleted = await withTenantOrThrow(
      worker,
      TENANT_A,
      (tx) => tx`
      DELETE FROM awcms_commerce_booking_refund_decisions
      WHERE id = ${decision[0]!.id} RETURNING id
    `
    );
    expect(deleted).toHaveLength(1);
  });

  test("the customer of a reservation is derived through the order: two customers of one tenant cannot read each other's links", async () => {
    const offeringLink = await inTenant(TENANT_A, (tx) =>
      insertOfferingLink(tx, TENANT_A, seed.offeringA, seed.svcA)
    );
    const linkOne = await inTenant(TENANT_A, (tx) =>
      insertReservationLink(tx, TENANT_A, {
        orderId: seed.orderA1,
        itemId: seed.itemA1,
        reservationId: seed.resA[0]!,
        offeringLinkId: offeringLink[0]!.id
      })
    );
    const linkTwo = await inTenant(TENANT_A, (tx) =>
      insertReservationLink(tx, TENANT_A, {
        orderId: seed.orderA2,
        itemId: seed.itemA2,
        reservationId: seed.resA[1]!,
        offeringLinkId: offeringLink[0]!.id
      })
    );

    // RLS ALONE lets the tenant's own context see both customers' links: it
    // knows no customer. That is why the handler's equality is load-bearing.
    const rlsView = await inTenant(
      TENANT_A,
      (tx) => tx`SELECT id FROM awcms_commerce_booking_reservation_links`
    );
    expect(rlsView).toHaveLength(2);

    const mine = await inTenant(TENANT_A, (tx) =>
      listActiveReservationLinksForCustomer(tx, TENANT_A, seed.customerA1)
    );
    expect(mine.map((l) => l.id)).toEqual([linkOne[0]!.id]);
    const theirs = await inTenant(TENANT_A, (tx) =>
      listActiveReservationLinksForCustomer(tx, TENANT_A, seed.customerA2)
    );
    expect(theirs.map((l) => l.id)).toEqual([linkTwo[0]!.id]);

    // By id: another customer's link is indistinguishable from an unknown id.
    const own = await inTenant(TENANT_A, (tx) =>
      fetchReservationLinkForCustomer(
        tx,
        TENANT_A,
        seed.customerA1,
        linkOne[0]!.id
      )
    );
    expect(own?.reservationId).toBe(seed.resA[0]!);
    const foreign = await inTenant(TENANT_A, (tx) =>
      fetchReservationLinkForCustomer(
        tx,
        TENANT_A,
        seed.customerA1,
        linkTwo[0]!.id
      )
    );
    const unknown = await inTenant(TENANT_A, (tx) =>
      fetchReservationLinkForCustomer(
        tx,
        TENANT_A,
        seed.customerA1,
        "00000000-0000-4000-8000-0000000000aa"
      )
    );
    expect(foreign).toBeNull();
    expect(unknown).toBeNull();
    // A customer of tenant B never reaches tenant A's links either.
    const crossTenant = await inTenant(TENANT_B, (tx) =>
      fetchReservationLinkForCustomer(
        tx,
        TENANT_B,
        seed.customerB,
        linkOne[0]!.id
      )
    );
    expect(crossTenant).toBeNull();

    // The reverse derivation: reservation -> active link -> the order's customer.
    const owner = await inTenant(TENANT_A, (tx) =>
      fetchReservationLinkCustomer(tx, TENANT_A, seed.resA[0]!)
    );
    expect(owner).toEqual({
      linkId: linkOne[0]!.id,
      orderId: seed.orderA1,
      customerId: seed.customerA1
    });
    // A reservation with no link has no derivable customer.
    const unlinked = await inTenant(TENANT_A, (tx) =>
      fetchReservationLinkCustomer(tx, TENANT_A, seed.resA[3]!)
    );
    expect(unlinked).toBeNull();

    // Once superseded or released, the link no longer names the customer.
    await inTenant(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_booking_reservation_links
      SET status = 'released', updated_at = now() WHERE id = ${linkOne[0]!.id}
    `
    );
    expect(
      await inTenant(TENANT_A, (tx) =>
        fetchReservationLinkCustomer(tx, TENANT_A, seed.resA[0]!)
      )
    ).toBeNull();
    expect(
      await inTenant(TENANT_A, (tx) =>
        listActiveReservationLinksForCustomer(tx, TENANT_A, seed.customerA1)
      )
    ).toHaveLength(0);
  });
});
