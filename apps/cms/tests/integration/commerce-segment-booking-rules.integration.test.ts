/**
 * Booking-derived CRM segment rules (rule schema 2) against a real, migrated
 * PostgreSQL under the least-privilege RUNTIME role (Issue #390, ADR-0052;
 * epic #280 item 7, second half; threat model F8, controls C-25..C-29). WORLD 1
 * (see `harness.ts`). The HTTP half (feature, permission) is
 * `commerce-segment-booking-rules-routes.integration.test.ts`.
 *
 * What this file proves, each against live data:
 *   - every booking-derived field evaluates to the right customers, alone and
 *     inside AND / OR / NOT with the order fields, including windows and as-of;
 *   - the customer comes from the ORDER the link points to: a reservation with
 *     no link, a superseded link, an unpaid booking, a deleted order and a
 *     `staff_cancel` are in nobody's facts;
 *   - a blocked or erased customer is never a member, even under NOT (C-28);
 *   - the single-customer evaluator (loyalty earn, #361) equals the list;
 *   - tenant isolation: another tenant's links, reservations and decisions are
 *     invisible, and an explicit tenant mismatch matches nobody;
 *   - old rules are unchanged (C-29): a version of schema 1 keeps evaluating to
 *     the same people once schema 2 exists, refuses a booking field, and the
 *     column cannot be changed by the application role;
 *   - the M7 target (p95 preview <= 3 s on 100,000 customers) holds with the
 *     booking rules, measured at the end of the file.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import {
  createSegment,
  fetchSegment,
  resolveSegmentRules,
  updateSegment
} from "../../src/modules/commerce/application/segment-directory";
import {
  listSegmentMembersPage,
  previewSegment,
  type SegmentEvaluationContext
} from "../../src/modules/commerce/application/segment-evaluator";
import { isCustomerSegmentMember } from "../../src/modules/commerce/application/segment-sql";
import {
  validateCreateSegmentInput,
  validateUpdateSegmentInput,
  type CreateSegmentInput
} from "../../src/modules/commerce/domain/segment";
import { validateSegmentRules } from "../../src/modules/commerce/domain/segment-rules";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const ACTOR = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const DAY = 86_400_000;

/** The server clock every evaluation in this file runs at, unless a test says otherwise. */
const NOW = new Date("2026-10-11T03:00:00.000Z");
const ago = (days: number): string =>
  new Date(NOW.getTime() - days * DAY).toISOString();

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedTenantUser(tenantId: string, id: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Booking Segment Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`bseg-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedCustomer(
  tenantId: string,
  name: string,
  phone: string,
  opts: { blocked?: boolean; erased?: boolean } = {}
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_customers
      (tenant_id, name, phone, level, status, created_at, deleted_at)
    VALUES (
      ${tenantId}, ${name}, ${phone}, 1,
      ${opts.blocked ? "blocked" : "active"},
      ${ago(500)}::timestamptz,
      ${opts.erased ? ago(1) : null}::timestamptz
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

/** One tenant's shared booking scaffolding: a service product, a stay offering and the offering link. */
type Scaffold = {
  tenantId: string;
  productId: string;
  offeringLinkId: string;
  staffUserId: string;
};

let scaffoldSeq = 0;

async function seedScaffold(tenantId: string): Promise<Scaffold> {
  scaffoldSeq += 1;
  const admin = getAdminSql();
  const staffUserId = crypto.randomUUID();
  await seedTenantUser(tenantId, staffUserId);
  const product = (await admin`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${tenantId}, 'service', ${`SVC-${scaffoldSeq}`}, 'Night',
      ${`night-${scaffoldSeq}`}, '500000.00', 100, 'active')
    RETURNING id
  `) as { id: string }[];
  const offering = (await admin`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, confirmation_mode)
    VALUES (${tenantId}, ${`stay-${scaffoldSeq}`}, 'Night', 'stay', 1, 30, 'hold_then_confirm')
    RETURNING id
  `) as { id: string }[];
  const offeringLink = (await admin`
    INSERT INTO awcms_commerce_booking_offering_links
      (tenant_id, offering_id, product_id, quantity_basis)
    VALUES (${tenantId}, ${offering[0]!.id}, ${product[0]!.id}, 'nights')
    RETURNING id
  `) as { id: string }[];
  return {
    tenantId,
    productId: product[0]!.id,
    offeringLinkId: offeringLink[0]!.id,
    staffUserId
  };
}

type BookingSeed = {
  /** The Booking status the reservation ends in. */
  status: "confirmed" | "checked_in" | "completed" | "cancelled" | "no_show";
  /** Days before NOW the stay starts; negative = in the future. */
  arrivalDaysAgo: number;
  nights?: number;
  /** Days before NOW the order was paid; null = the order is unpaid. */
  paidDaysAgo: number | null;
  linkStatus?: "active" | "released" | "superseded";
  orderDeleted?: boolean;
  decision?: {
    kind: "customer_cancel" | "staff_cancel" | "no_show";
    daysAgo: number;
  };
  /** Do not create a link at all (a staff-only reservation). */
  unlinked?: boolean;
};

let orderSeq = 0;

/** Seeds one order, its line, a Booking reservation, the link and (optionally) the decision. Returns the reservation id. */
async function seedBooking(
  scaffold: Scaffold,
  customerId: string,
  seed: BookingSeed
): Promise<{ reservationId: string; orderId: string; linkId: string | null }> {
  orderSeq += 1;
  const admin = getAdminSql();
  const { tenantId } = scaffold;
  const paidAt = seed.paidDaysAgo === null ? null : ago(seed.paidDaysAgo);
  const order = (await admin`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method,
       payment_status, shipping_method, subtotal, total, paid_at, deleted_at)
    VALUES (
      ${tenantId}, ${`BKS-${orderSeq}`}, ${customerId},
      ${paidAt ? "completed" : "pending_payment"}, 'manual_bank',
      ${paidAt ? "paid" : "unpaid"}, 'self_pickup', '500000.00', '500000.00',
      ${paidAt}::timestamptz, ${seed.orderDeleted ? ago(1) : null}::timestamptz
    )
    RETURNING id
  `) as { id: string }[];
  const orderId = order[0]!.id;
  const item = (await admin`
    INSERT INTO awcms_commerce_order_items
      (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
    VALUES (${tenantId}, ${orderId}, ${scaffold.productId}, 'Night', '500000.00', 1, '500000.00')
    RETURNING id
  `) as { id: string }[];

  const starts = ago(seed.arrivalDaysAgo);
  const ends = new Date(
    Date.parse(starts) + (seed.nights ?? 2) * DAY
  ).toISOString();
  const reservation = (await admin`
    INSERT INTO awcms_booking_reservations (tenant_id, status, starts_at, ends_at)
    VALUES (${tenantId}, 'confirmed', ${starts}::timestamptz, ${ends}::timestamptz)
    RETURNING id
  `) as { id: string }[];
  const reservationId = reservation[0]!.id;
  // The reservation state machine (sql/180) allows only legal transitions.
  const path: Record<BookingSeed["status"], string[]> = {
    confirmed: [],
    checked_in: ["checked_in"],
    completed: ["checked_in", "completed"],
    cancelled: ["cancelled"],
    no_show: ["no_show"]
  };
  for (const step of path[seed.status]) {
    await admin`
      UPDATE awcms_booking_reservations SET status = ${step}
      WHERE id = ${reservationId}
    `;
  }

  if (seed.unlinked) return { reservationId, orderId, linkId: null };

  const link = (await admin`
    INSERT INTO awcms_commerce_booking_reservation_links
      (tenant_id, order_id, order_item_id, reservation_id, offering_link_id,
       client_key, request_hash)
    VALUES (${tenantId}, ${orderId}, ${item[0]!.id}, ${reservationId},
      ${scaffold.offeringLinkId}, ${`ck-${orderSeq}`}, ${"h".repeat(64)})
    RETURNING id
  `) as { id: string }[];
  const linkId = link[0]!.id;
  if (seed.linkStatus && seed.linkStatus !== "active") {
    await admin`
      UPDATE awcms_commerce_booking_reservation_links
      SET status = ${seed.linkStatus} WHERE id = ${linkId}
    `;
  }
  if (seed.decision) {
    const staff = seed.decision.kind === "staff_cancel";
    await admin`
      INSERT INTO awcms_commerce_booking_refund_decisions
        (tenant_id, order_id, reservation_link_id, trigger_kind, actor_kind,
         actor_tenant_user_id, policy_source, hours_before_start,
         refundable_percent, amount_paid, computed_refund, final_refund,
         retained_amount, source_key, created_at)
      VALUES (
        ${tenantId}, ${orderId}, ${linkId}, ${seed.decision.kind},
        ${staff ? "staff" : seed.decision.kind === "no_show" ? "system" : "customer"},
        ${staff ? scaffold.staffUserId : null}, 'none', 24, 0, '500000.00',
        '0.00', '0.00',
        ${seed.decision.kind === "no_show" ? "0.00" : null},
        ${`dec-${orderSeq}`}, ${ago(seed.decision.daysAgo)}::timestamptz
      )
    `;
  }
  return { reservationId, orderId, linkId };
}

async function seedPlainOrder(
  tenantId: string,
  customerId: string,
  paidDaysAgo: number
): Promise<void> {
  orderSeq += 1;
  await getAdminSql()`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method,
       payment_status, shipping_method, subtotal, total, paid_at)
    VALUES (${tenantId}, ${`BKP-${orderSeq}`}, ${customerId}, 'completed',
      'manual_bank', 'paid', 'self_pickup', '1000.00', '1000.00',
      ${ago(paidDaysAgo)}::timestamptz)
  `;
}

function rules(raw: unknown) {
  const result = validateSegmentRules(raw);
  if (!result.valid) {
    throw new Error(`rules refused: ${JSON.stringify(result.errors)}`);
  }
  return { node: result.node, stats: result.stats };
}

function ctx(tenantId = TENANT_A, now: Date = NOW): SegmentEvaluationContext {
  return { tenantId, actorTenantUserId: ACTOR, now };
}

async function namesOf(
  raw: unknown,
  tenantId = TENANT_A,
  now: Date = NOW
): Promise<string[]> {
  const outcome = await inTenant(tenantId, (tx) =>
    listSegmentMembersPage(tx, ctx(tenantId, now), rules(raw), null, 100)
  );
  if (outcome.kind !== "ok") throw new Error(`evaluation: ${outcome.kind}`);
  return outcome.page.items.map((m) => m.name).sort();
}

const leaf = (field: string, op: string, value?: unknown, extra = {}) => ({
  field,
  op,
  ...(value === undefined ? {} : { value }),
  ...extra
});

type World = {
  ids: Record<string, string>;
  scaffoldA: Scaffold;
  scaffoldB: Scaffold;
};

/**
 * Names say what the customer is for. The arrival and payment days are chosen
 * so every window assertion below falls well inside or outside its boundary.
 */
async function seedWorld(): Promise<World> {
  const scaffoldA = await seedScaffold(TENANT_A);
  const scaffoldB = await seedScaffold(TENANT_B);
  const ids: Record<string, string> = {};
  const c = async (name: string, i: number, opts = {}) => {
    ids[name] = await seedCustomer(TENANT_A, name, `+62812000000${i}`, opts);
    return ids[name]!;
  };

  const alice = await c("Alice", 1);
  await seedBooking(scaffoldA, alice, {
    status: "completed",
    arrivalDaysAgo: 400,
    paidDaysAgo: 410
  });
  await seedBooking(scaffoldA, alice, {
    status: "checked_in",
    arrivalDaysAgo: 30,
    paidDaysAgo: 40
  });
  await seedBooking(scaffoldA, alice, {
    status: "confirmed",
    arrivalDaysAgo: -20,
    paidDaysAgo: 5
  });

  const bob = await c("Bob", 2);
  await seedBooking(scaffoldA, bob, {
    status: "cancelled",
    arrivalDaysAgo: -30,
    paidDaysAgo: 70,
    linkStatus: "released",
    decision: { kind: "customer_cancel", daysAgo: 60 }
  });
  await seedBooking(scaffoldA, bob, {
    status: "no_show",
    arrivalDaysAgo: 21,
    paidDaysAgo: 50,
    linkStatus: "released",
    decision: { kind: "no_show", daysAgo: 20 }
  });
  await seedBooking(scaffoldA, bob, {
    status: "completed",
    arrivalDaysAgo: 200,
    paidDaysAgo: 210
  });

  // Carol: a reschedule. The old reservation is `rescheduled` (superseded by
  // the new one) with a `superseded` link; the new reservation is the live
  // booking. One booking, not two.
  const carol = await c("Carol", 3);
  const replacement = await seedBooking(scaffoldA, carol, {
    status: "confirmed",
    arrivalDaysAgo: -10,
    paidDaysAgo: 15
  });
  const moved = await seedBooking(scaffoldA, carol, {
    status: "confirmed",
    arrivalDaysAgo: -5,
    paidDaysAgo: 15,
    linkStatus: "superseded"
  });
  await getAdminSql()`
    UPDATE awcms_booking_reservations
    SET status = 'rescheduled', superseded_by_id = ${replacement.reservationId}
    WHERE id = ${moved.reservationId}
  `;

  const dave = await c("Dave", 4);
  await seedPlainOrder(TENANT_A, dave, 10);

  // Erin: only a decision made by STAFF - never counted against a customer.
  const erin = await c("Erin", 5);
  await seedBooking(scaffoldA, erin, {
    status: "cancelled",
    arrivalDaysAgo: -15,
    paidDaysAgo: 30,
    linkStatus: "released",
    decision: { kind: "staff_cancel", daysAgo: 25 }
  });

  // Frank: a confirmed booking whose order is UNPAID (not a booking), and a
  // checked-in stay on an unpaid order (the guest did arrive).
  const frank = await c("Frank", 6);
  await seedBooking(scaffoldA, frank, {
    status: "confirmed",
    arrivalDaysAgo: -3,
    paidDaysAgo: null
  });
  await seedBooking(scaffoldA, frank, {
    status: "checked_in",
    arrivalDaysAgo: 5,
    paidDaysAgo: null
  });

  // Gina: everything on a deleted order, and a reservation with no link.
  const gina = await c("Gina", 7);
  await seedBooking(scaffoldA, gina, {
    status: "completed",
    arrivalDaysAgo: 40,
    paidDaysAgo: 45,
    orderDeleted: true
  });
  await seedBooking(scaffoldA, gina, {
    status: "completed",
    arrivalDaysAgo: 41,
    paidDaysAgo: 46,
    unlinked: true
  });

  // Never members, whatever the rule says (C-28).
  const hana = await c("Hana", 8, { blocked: true });
  const iris = await c("Iris", 9, { erased: true });
  for (const who of [hana, iris]) {
    await seedBooking(scaffoldA, who, {
      status: "completed",
      arrivalDaysAgo: 100,
      paidDaysAgo: 110
    });
  }

  // Another tenant with a very booking-heavy customer.
  const bea = await seedCustomer(TENANT_B, "Bea", "+628130000001");
  for (let n = 0; n < 4; n += 1) {
    await seedBooking(scaffoldB, bea, {
      status: "completed",
      arrivalDaysAgo: 20 + n,
      paidDaysAgo: 30 + n,
      decision: undefined
    });
  }
  await seedBooking(scaffoldB, bea, {
    status: "no_show",
    arrivalDaysAgo: 10,
    paidDaysAgo: 15,
    linkStatus: "released",
    decision: { kind: "no_show", daysAgo: 9 }
  });
  ids.Bea = bea;
  return { ids, scaffoldA, scaffoldB };
}

function createInput(raw: unknown, name: string): CreateSegmentInput {
  const result = validateCreateSegmentInput({ name, rules: raw });
  if (!result.valid) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

suite("booking-derived CRM segment rules (Issue #390, ADR-0052)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  describe("correctness", () => {
    let world: World;

    beforeEach(async () => {
      await resetDatabase();
      await seedTenant(TENANT_A, "tenant-bseg-a");
      await seedTenant(TENANT_B, "tenant-bseg-b");
      await seedTenantUser(TENANT_A, ACTOR);
      world = await seedWorld();
    }, 60000);

    test("booking_count: standing, paid bookings per reservation - a cancellation, a no-show, a moved stay, an unpaid hold and a deleted order are not bookings", async () => {
      expect(await namesOf(leaf("booking_count", "gte", 1))).toEqual([
        "Alice",
        "Bob",
        "Carol"
      ]);
      expect(await namesOf(leaf("booking_count", "gte", 2))).toEqual(["Alice"]);
      expect(await namesOf(leaf("booking_count", "eq", 3))).toEqual(["Alice"]);
      expect(await namesOf(leaf("booking_count", "eq", 0))).toEqual([
        "Dave",
        "Erin",
        "Frank",
        "Gina"
      ]);
      // Windows are the order's paid_at: Alice 40d and 5d, Carol 15d; Bob's
      // standing booking was paid 210d ago.
      expect(
        await namesOf(leaf("booking_count", "gte", 1, { windowDays: 90 }))
      ).toEqual(["Alice", "Carol"]);
      expect(
        await namesOf(leaf("booking_count", "gte", 1, { windowDays: 7 }))
      ).toEqual(["Alice"]);
      expect(
        await namesOf(leaf("booking_count", "gte", 2, { windowDays: 90 }))
      ).toEqual(["Alice"]);
    });

    test("stay_count and last_stay_date: the guest arrived (checked in or completed), counted on the arrival instant", async () => {
      expect(await namesOf(leaf("stay_count", "gte", 1))).toEqual([
        "Alice",
        "Bob",
        "Frank"
      ]);
      expect(await namesOf(leaf("stay_count", "gte", 2))).toEqual(["Alice"]);
      expect(
        await namesOf(leaf("stay_count", "gte", 1, { windowDays: 90 }))
      ).toEqual(["Alice", "Frank"]);
      expect(
        await namesOf(leaf("stay_count", "gte", 1, { windowDays: 10 }))
      ).toEqual(["Frank"]);
      // Alice 30d, Bob 200d, Frank 5d.
      expect(
        await namesOf(leaf("last_stay_date", "before", { daysAgo: 100 }))
      ).toEqual(["Bob"]);
      expect(
        await namesOf(leaf("last_stay_date", "after", { daysAgo: 100 }))
      ).toEqual(["Alice", "Frank"]);
      expect(await namesOf(leaf("last_stay_date", "never"))).toEqual([
        "Carol",
        "Dave",
        "Erin",
        "Gina"
      ]);
      expect(await namesOf(leaf("last_stay_date", "before", ago(100)))).toEqual(
        ["Bob"]
      );
    });

    test("no_show_count and cancellation_count read the adapter's decisions: a staff cancellation is never the customer's", async () => {
      expect(await namesOf(leaf("no_show_count", "gte", 1))).toEqual(["Bob"]);
      expect(
        await namesOf(leaf("no_show_count", "gte", 1, { windowDays: 30 }))
      ).toEqual(["Bob"]);
      expect(
        await namesOf(leaf("no_show_count", "gte", 1, { windowDays: 10 }))
      ).toEqual([]);
      expect(await namesOf(leaf("cancellation_count", "gte", 1))).toEqual([
        "Bob"
      ]);
      expect(
        await namesOf(leaf("cancellation_count", "gte", 1, { windowDays: 90 }))
      ).toEqual(["Bob"]);
      expect(
        await namesOf(leaf("cancellation_count", "gte", 1, { windowDays: 30 }))
      ).toEqual([]);
      // Erin has only a staff_cancel: zero cancellations, and zero no-shows.
      const zero = await namesOf(leaf("cancellation_count", "eq", 0));
      expect(zero).toContain("Erin");
      expect(zero).not.toContain("Bob");
    });

    test("AND / OR / NOT combine booking and order facts, and a window is shared across both families", async () => {
      expect(
        await namesOf({
          and: [leaf("stay_count", "gte", 1), leaf("order_count", "gte", 3)]
        })
      ).toEqual(["Alice", "Bob"]);
      expect(
        await namesOf({
          or: [
            leaf("no_show_count", "gte", 1),
            leaf("last_stay_date", "after", { daysAgo: 10 })
          ]
        })
      ).toEqual(["Bob", "Frank"]);
      // NOT: lapsed - stayed once but not within 100 days.
      expect(
        await namesOf({
          and: [
            leaf("stay_count", "gte", 1),
            { not: leaf("stay_count", "gte", 1, { windowDays: 100 }) }
          ]
        })
      ).toEqual(["Bob"]);
      expect(
        await namesOf({
          and: [
            leaf("stay_count", "gte", 1),
            { not: leaf("booking_count", "gte", 1, { windowDays: 100 }) }
          ]
        })
      ).toEqual(["Bob", "Frank"]);
      expect(
        await namesOf({
          and: [
            leaf("order_count", "gte", 1, { windowDays: 90 }),
            leaf("booking_count", "gte", 1, { windowDays: 90 }),
            leaf("no_show_count", "eq", 0, { windowDays: 90 })
          ]
        })
      ).toEqual(["Alice", "Carol"]);
    });

    test("a blocked and an erased customer with bookings are never members, even under NOT (C-28)", async () => {
      const stayed = await namesOf(leaf("stay_count", "gte", 1));
      expect(stayed).not.toContain("Hana");
      expect(stayed).not.toContain("Iris");
      const notStayed = await namesOf({ not: leaf("stay_count", "gte", 1) });
      expect(notStayed).not.toContain("Hana");
      expect(notStayed).not.toContain("Iris");
      expect(notStayed).toEqual(["Carol", "Dave", "Erin", "Gina"]);
    });

    test("the as-of cuts instants but statuses are read as they are now", async () => {
      const earlier = new Date(NOW.getTime() - 100 * DAY);
      // At that instant only the bookings paid before it count (Alice 410d,
      // Bob 210d), and only stays that had started (Alice 400d, Bob 200d).
      expect(
        await namesOf(leaf("booking_count", "gte", 1), TENANT_A, earlier)
      ).toEqual(["Alice", "Bob"]);
      expect(
        await namesOf(leaf("stay_count", "gte", 1), TENANT_A, earlier)
      ).toEqual(["Alice", "Bob"]);
      // Frank's stay (5d ago) had not started at that instant.
      expect(
        await namesOf(leaf("last_stay_date", "never"), TENANT_A, earlier)
      ).toContain("Frank");
      // No-show recorded 20d ago is after the earlier as-of.
      expect(
        await namesOf(leaf("no_show_count", "gte", 1), TENANT_A, earlier)
      ).toEqual([]);
    });

    test("the single-customer evaluator (loyalty earn, #361) equals membership in the full list for every shape and customer", async () => {
      const shapes = [
        leaf("booking_count", "gte", 1),
        leaf("booking_count", "gte", 1, { windowDays: 90 }),
        leaf("stay_count", "eq", 0),
        leaf("last_stay_date", "never"),
        leaf("last_stay_date", "before", { daysAgo: 100 }),
        leaf("no_show_count", "gte", 1, { windowDays: 30 }),
        leaf("cancellation_count", "gte", 1),
        {
          and: [
            leaf("stay_count", "gte", 1),
            { not: leaf("no_show_count", "gte", 1) }
          ]
        },
        {
          or: [
            leaf("cancellation_count", "gte", 1),
            leaf("booking_count", "gte", 3),
            leaf("order_count", "eq", 0)
          ]
        }
      ];
      const everyone = [
        "Alice",
        "Bob",
        "Carol",
        "Dave",
        "Erin",
        "Frank",
        "Gina",
        "Hana",
        "Iris"
      ];
      for (const raw of shapes) {
        const listed = await namesOf(raw);
        const parsed = rules(raw);
        for (const name of everyone) {
          const member = await inTenant(TENANT_A, (tx) =>
            isCustomerSegmentMember(tx, {
              tenantId: TENANT_A,
              node: parsed.node,
              stats: parsed.stats,
              asOf: NOW.toISOString(),
              customerId: world.ids[name]!
            })
          );
          expect(member, `${JSON.stringify(raw)} / ${name}`).toBe(
            listed.includes(name)
          );
        }
      }
    });

    test("the preview counts the same people and withholds a group under five (C-27)", async () => {
      const outcome = await inTenant(TENANT_A, (tx) =>
        previewSegment(tx, ctx(), rules(leaf("stay_count", "gte", 1)), {
          includeSample: true
        })
      );
      if (outcome.kind !== "ok") throw new Error(outcome.kind);
      // Three people: a small group, so no number.
      expect(outcome.preview.count).toEqual({
        suppressed: true,
        count: null,
        label: "fewer_than_5"
      });
      expect(outcome.preview.sample?.map((m) => m.name).sort()).toEqual([
        "Alice",
        "Bob",
        "Frank"
      ]);
    });
  });

  describe("tenant isolation (RLS)", () => {
    beforeEach(async () => {
      await resetDatabase();
      await seedTenant(TENANT_A, "tenant-bseg-a");
      await seedTenant(TENANT_B, "tenant-bseg-b");
      await seedTenantUser(TENANT_A, ACTOR);
      await seedWorld();
    }, 60000);

    test("each tenant sees only its own bookings through the same rule", async () => {
      expect(await namesOf(leaf("stay_count", "gte", 4), TENANT_B)).toEqual([
        "Bea"
      ]);
      expect(await namesOf(leaf("stay_count", "gte", 4), TENANT_A)).toEqual([]);
      expect(await namesOf(leaf("no_show_count", "gte", 1), TENANT_B)).toEqual([
        "Bea"
      ]);
      expect(await namesOf(leaf("no_show_count", "gte", 1), TENANT_A)).toEqual([
        "Bob"
      ]);
    });

    test("a tenant context that disagrees with the tenant id in the query matches nobody - RLS and the explicit predicate both bind", async () => {
      const parsed = rules(leaf("stay_count", "gte", 1));
      const crossed = await inTenant(TENANT_B, (tx) =>
        isCustomerSegmentMember(tx, {
          tenantId: TENANT_A,
          node: parsed.node,
          stats: parsed.stats,
          asOf: NOW.toISOString(),
          customerId: crypto.randomUUID()
        })
      );
      expect(crossed).toBe(false);
      const outcome = await inTenant(TENANT_B, (tx) =>
        listSegmentMembersPage(
          tx,
          { tenantId: TENANT_A, actorTenantUserId: ACTOR, now: NOW },
          parsed,
          null,
          100
        )
      );
      if (outcome.kind !== "ok") throw new Error(outcome.kind);
      expect(outcome.page.items).toEqual([]);
    });

    test("the booking tables the scan reads are tenant-scoped for the runtime role", async () => {
      for (const [tenant, table] of [
        [TENANT_A, "awcms_commerce_booking_reservation_links"],
        [TENANT_A, "awcms_booking_reservations"],
        [TENANT_A, "awcms_commerce_booking_refund_decisions"],
        [TENANT_B, "awcms_commerce_booking_reservation_links"],
        [TENANT_B, "awcms_booking_reservations"],
        [TENANT_B, "awcms_commerce_booking_refund_decisions"]
      ] as const) {
        const other = tenant === TENANT_A ? TENANT_B : TENANT_A;
        const visible = await inTenant(tenant, async (tx) => {
          const rows = (await tx.unsafe(
            `SELECT count(*)::int AS total, count(*) FILTER (WHERE tenant_id = '${other}')::int AS foreign_rows FROM ${table}`
          )) as { total: number; foreign_rows: number }[];
          return rows[0]!;
        });
        expect(visible.total, `${tenant}/${table}`).toBeGreaterThan(0);
        expect(visible.foreign_rows, `${tenant}/${table}`).toBe(0);
      }
    });
  });

  describe("old rules are unchanged (C-29)", () => {
    beforeEach(async () => {
      await resetDatabase();
      await seedTenant(TENANT_A, "tenant-bseg-a");
      await seedTenant(TENANT_B, "tenant-bseg-b");
      await seedTenantUser(TENANT_A, ACTOR);
      await seedWorld();
    }, 60000);

    const v1Rules = {
      and: [
        leaf("order_count", "gte", 1, { windowDays: 90 }),
        { not: leaf("last_order_date", "before", { daysAgo: 100 }) }
      ]
    };

    test("a version written under schema 1 keeps its schema, evaluates to the same people once schema 2 exists, and the new version is schema 2", async () => {
      // A schema-1 version, exactly as it was written before this change.
      const created = await inTenant(TENANT_A, (tx) =>
        createSegment(tx, TENANT_A, ACTOR, {
          ...createInput(v1Rules, "Legacy"),
          ruleSchemaVersion: 1
        })
      );
      if (created.kind !== "created") throw new Error(created.kind);
      const segmentId = created.segment.id;
      expect(created.segment.versions[0]!.ruleSchemaVersion).toBe(1);

      const before = await namesOf(v1Rules);

      // Edit: version 2 uses a booking field, so it is written under schema 2.
      const bookingRule = {
        and: [v1Rules, leaf("stay_count", "gte", 1)]
      };
      const update = validateUpdateSegmentInput({
        baseVersion: 1,
        rules: bookingRule
      });
      if (!update.valid) throw new Error(JSON.stringify(update.errors));
      const updated = await inTenant(TENANT_A, (tx) =>
        updateSegment(tx, TENANT_A, ACTOR, segmentId, update.value)
      );
      if (updated.kind !== "updated") throw new Error(updated.kind);
      const versions = updated.segment.versions;
      expect(versions.map((v) => [v.version, v.ruleSchemaVersion])).toEqual([
        [2, 2],
        [1, 1]
      ]);

      // Version 1 resolves under schema 1 and evaluates to exactly what it did.
      const one = await inTenant(TENANT_A, (tx) =>
        resolveSegmentRules(tx, TENANT_A, segmentId, 1)
      );
      expect(one?.ruleSchemaVersion).toBe(1);
      const afterOne = await inTenant(TENANT_A, (tx) =>
        listSegmentMembersPage(
          tx,
          ctx(),
          { node: one!.node, stats: one!.stats },
          null,
          100
        )
      );
      if (afterOne.kind !== "ok") throw new Error(afterOne.kind);
      expect(afterOne.page.items.map((m) => m.name).sort()).toEqual(before);

      // Version 2 is the booking rule, a strict narrowing of version 1.
      const two = await inTenant(TENANT_A, (tx) =>
        resolveSegmentRules(tx, TENANT_A, segmentId, 2)
      );
      expect(two?.ruleSchemaVersion).toBe(2);
      const narrowed = await namesOf(bookingRule);
      for (const name of narrowed) expect(before).toContain(name);
      expect(narrowed.length).toBeLessThanOrEqual(before.length);
    });

    test("rows that existed before the column read as schema 1", async () => {
      const admin = getAdminSql();
      const head = (await admin`
        INSERT INTO awcms_commerce_segments
          (tenant_id, name, latest_version, created_by_tenant_user_id)
        VALUES (${TENANT_A}, 'Pre-existing', 1, ${ACTOR})
        RETURNING id
      `) as { id: string }[];
      // Inserted WITHOUT the column, as every pre-sql/1060 writer did.
      await admin`
        INSERT INTO awcms_commerce_segment_versions
          (tenant_id, segment_id, version, rules, node_count, depth,
           created_by_tenant_user_id)
        VALUES (${TENANT_A}, ${head[0]!.id}, 1,
          ${leaf("level", "eq", 1)}::jsonb, 1, 0, ${ACTOR})
      `;
      const resolved = await inTenant(TENANT_A, (tx) =>
        resolveSegmentRules(tx, TENANT_A, head[0]!.id, 1)
      );
      expect(resolved?.ruleSchemaVersion).toBe(1);
    });

    test("a schema-1 version holding a booking field (written around the application) fails closed instead of being evaluated", async () => {
      const admin = getAdminSql();
      const head = (await admin`
        INSERT INTO awcms_commerce_segments
          (tenant_id, name, latest_version, created_by_tenant_user_id)
        VALUES (${TENANT_A}, 'Forged', 1, ${ACTOR})
        RETURNING id
      `) as { id: string }[];
      await admin`
        INSERT INTO awcms_commerce_segment_versions
          (tenant_id, segment_id, version, rule_schema_version, rules,
           node_count, depth, created_by_tenant_user_id)
        VALUES (${TENANT_A}, ${head[0]!.id}, 1, 1,
          ${leaf("stay_count", "gte", 1)}::jsonb, 1, 0, ${ACTOR})
      `;
      await expect(
        inTenant(TENANT_A, (tx) =>
          resolveSegmentRules(tx, TENANT_A, head[0]!.id, 1)
        )
      ).rejects.toThrow("no longer validates");
    });

    test("the schema of a stored version cannot be changed by the application role, and a nonsensical value is refused", async () => {
      const created = await inTenant(TENANT_A, (tx) =>
        createSegment(tx, TENANT_A, ACTOR, createInput(v1Rules, "Immutable"))
      );
      if (created.kind !== "created") throw new Error(created.kind);
      const id = created.segment.id;
      await expect(
        inTenant(TENANT_A, async (tx) => {
          await tx`
            UPDATE awcms_commerce_segment_versions
            SET rule_schema_version = 1 WHERE segment_id = ${id}
          `;
        })
      ).rejects.toThrow();
      await expect(
        getAdminSql()`
          UPDATE awcms_commerce_segment_versions
          SET rule_schema_version = 1 WHERE segment_id = ${id}
        `
      ).rejects.toThrow();
      await expect(
        getAdminSql()`
          INSERT INTO awcms_commerce_segment_versions
            (tenant_id, segment_id, version, rule_schema_version, rules,
             node_count, depth, created_by_tenant_user_id)
          VALUES (${TENANT_A}, ${id}, 9, 0, '{"field":"level","op":"eq","value":1}'::jsonb,
            1, 0, ${ACTOR})
        `
      ).rejects.toThrow();
      const detail = await inTenant(TENANT_A, (tx) =>
        fetchSegment(tx, TENANT_A, id)
      );
      expect(detail?.versions[0]!.ruleSchemaVersion).toBe(2);
    });
  });

  describe("PRD outcome M7: p95 preview <= 3 s on 100,000 customers, with the booking rules", () => {
    beforeEach(async () => {
      await resetDatabase();
      await seedTenant(TENANT_A, "tenant-bseg-a");
      await seedTenantUser(TENANT_A, ACTOR);
    }, 60000);

    test("previews of booking-derived, mixed-family and windowed rules over a 100,000-customer tenant stay inside the target", async () => {
      const scaffold = await seedScaffold(TENANT_A);
      const admin = getAdminSql();
      await admin`
        INSERT INTO awcms_commerce_customers
          (tenant_id, name, phone, email, level, created_at)
        SELECT ${TENANT_A}, 'Perf ' || g, '+62877' || lpad(g::text, 9, '0'),
          CASE WHEN g % 3 = 0 THEN 'perf' || g || '@example.com' END,
          1 + (g % 4), now() - (g % 700) * interval '1 day'
        FROM generate_series(1, 100000) g
      `;
      // ~2.5 paid orders per customer on average, spread over two years (the
      // same order world as the v1 M7 test, so the booking scans are added to
      // an unchanged baseline).
      await admin`
        INSERT INTO awcms_commerce_orders
          (tenant_id, order_code, customer_id, status, payment_method,
           payment_status, shipping_method, subtotal, total, paid_at)
        SELECT ${TENANT_A}, 'PERF-' || row_number() OVER (), c.id, 'completed',
          'manual_bank', 'paid', 'self_pickup', 10000 + (n * 7919) % 90000,
          10000 + (n * 7919) % 90000,
          now() - ((n * 37) % 720) * interval '1 day'
        FROM (SELECT id, row_number() OVER () AS rn FROM awcms_commerce_customers
              WHERE tenant_id = ${TENANT_A}) c
        CROSS JOIN generate_series(1, 5) n
        WHERE (c.rn + n) % 2 = 0
      `;
      await admin`
        INSERT INTO awcms_commerce_customer_accounts
          (tenant_id, customer_id, email_normalized, history_from)
        SELECT tenant_id, id, email, now() - interval '300 days'
        FROM awcms_commerce_customers
        WHERE tenant_id = ${TENANT_A} AND email IS NOT NULL
      `;
      await admin`
        INSERT INTO awcms_commerce_loyalty_accounts (tenant_id, customer_id, balance)
        SELECT tenant_id, id, (extract(epoch FROM created_at)::bigint % 1000)
        FROM awcms_commerce_customers
        WHERE tenant_id = ${TENANT_A} AND level IN (2, 3)
      `;

      // Bookings: 60% of the customers have one or two (about 90,000 stays on
      // 90,000 further orders), spread over the status mix a real tenant has.
      await admin`
        CREATE TEMP TABLE bk AS
        SELECT c.id AS customer_id, c.rn, n,
          'BKPERF-' || c.rn || '-' || n AS order_code,
          gen_random_uuid() AS reservation_id,
          gen_random_uuid() AS order_id,
          gen_random_uuid() AS item_id,
          gen_random_uuid() AS link_id,
          CASE (c.rn + n) % 6
            WHEN 0 THEN 'completed' WHEN 1 THEN 'checked_in'
            WHEN 2 THEN 'confirmed' WHEN 3 THEN 'cancelled'
            WHEN 4 THEN 'no_show' ELSE 'completed' END AS final_status,
          ((c.rn * 37 + n * 11) % 700) - 30 AS arrival_days_ago
        FROM (SELECT id, row_number() OVER () AS rn FROM awcms_commerce_customers
              WHERE tenant_id = ${TENANT_A}) c
        CROSS JOIN generate_series(1, 2) n
        WHERE c.rn % 5 < 3 AND (n = 1 OR c.rn % 2 = 0)
      `;
      await admin`
        INSERT INTO awcms_commerce_orders
          (id, tenant_id, order_code, customer_id, status, payment_method,
           payment_status, shipping_method, subtotal, total, paid_at)
        SELECT order_id, ${TENANT_A}, order_code, customer_id, 'completed',
          'manual_bank', 'paid', 'self_pickup', '500000.00', '500000.00',
          now() - (arrival_days_ago + 10) * interval '1 day'
        FROM bk
      `;
      await admin`
        INSERT INTO awcms_commerce_order_items
          (id, tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
        SELECT item_id, ${TENANT_A}, order_id, ${scaffold.productId}, 'Night',
          '500000.00', 1, '500000.00'
        FROM bk
      `;
      await admin`
        INSERT INTO awcms_booking_reservations (id, tenant_id, status, starts_at, ends_at)
        SELECT reservation_id, ${TENANT_A}, 'confirmed',
          now() - arrival_days_ago * interval '1 day',
          now() - arrival_days_ago * interval '1 day' + interval '2 days'
        FROM bk
      `;
      // Bulk load only: the state machine's per-row UPDATE guard is switched
      // off while the final statuses are set in one statement, then back on.
      await admin`ALTER TABLE awcms_booking_reservations DISABLE TRIGGER awcms_booking_reservations_update_guard`;
      await admin`
        UPDATE awcms_booking_reservations r SET status = bk.final_status
        FROM bk WHERE r.id = bk.reservation_id AND bk.final_status <> 'confirmed'
      `;
      await admin`ALTER TABLE awcms_booking_reservations ENABLE TRIGGER awcms_booking_reservations_update_guard`;
      await admin`
        INSERT INTO awcms_commerce_booking_reservation_links
          (id, tenant_id, order_id, order_item_id, reservation_id,
           offering_link_id, client_key, request_hash, status)
        SELECT link_id, ${TENANT_A}, order_id, item_id, reservation_id,
          ${scaffold.offeringLinkId}, 'ck-' || link_id, ${"h".repeat(64)},
          'active'
        FROM bk
      `;
      await admin`
        UPDATE awcms_commerce_booking_reservation_links l SET status = 'released'
        FROM bk WHERE l.id = bk.link_id AND bk.final_status IN ('cancelled', 'no_show')
      `;
      await admin`
        INSERT INTO awcms_commerce_booking_refund_decisions
          (tenant_id, order_id, reservation_link_id, trigger_kind, actor_kind,
           policy_source, hours_before_start, refundable_percent, amount_paid,
           computed_refund, final_refund, retained_amount, source_key, created_at)
        SELECT ${TENANT_A}, order_id, link_id,
          CASE final_status WHEN 'no_show' THEN 'no_show' ELSE 'customer_cancel' END,
          CASE final_status WHEN 'no_show' THEN 'system' ELSE 'customer' END,
          'none', 24, 0, '500000.00', '0.00', '0.00',
          CASE final_status WHEN 'no_show' THEN 0.00 END,
          'perf-' || link_id,
          now() - greatest(arrival_days_ago - 1, 0) * interval '1 day'
        FROM bk WHERE final_status IN ('cancelled', 'no_show')
      `;
      for (const table of [
        "awcms_commerce_customers",
        "awcms_commerce_orders",
        "awcms_commerce_customer_accounts",
        "awcms_commerce_loyalty_accounts",
        "awcms_booking_reservations",
        "awcms_commerce_booking_reservation_links",
        "awcms_commerce_booking_refund_decisions"
      ]) {
        await admin.unsafe(`ANALYZE ${table}`);
      }
      const totals = (await admin`
        SELECT
          (SELECT count(*)::int FROM awcms_commerce_customers) AS customers,
          (SELECT count(*)::int FROM awcms_commerce_orders) AS orders,
          (SELECT count(*)::int FROM awcms_commerce_booking_reservation_links) AS links,
          (SELECT count(*)::int FROM awcms_commerce_booking_refund_decisions) AS decisions
      `) as Record<string, number>[];

      const heavy = [
        // 0: one broad booking-derived rule.
        leaf("stay_count", "gte", 1),
        // 1: windowed bookings, minus a decision-derived exclusion (both scans).
        {
          and: [
            leaf("booking_count", "gte", 1, { windowDays: 365 }),
            { not: leaf("no_show_count", "gte", 1) }
          ]
        },
        // 2: order facts + booking facts, a stay window and a recency bound.
        {
          and: [
            leaf("order_count", "gte", 2),
            leaf("stay_count", "gte", 1, { windowDays: 180 }),
            leaf("last_stay_date", "after", { daysAgo: 365 }),
            { not: leaf("cancellation_count", "gte", 1) }
          ]
        },
        // 3: OR across both booking scans and the customer row.
        {
          and: [
            leaf("level", "in", [1, 2]),
            {
              or: [
                leaf("no_show_count", "gte", 1),
                leaf("cancellation_count", "gte", 1),
                leaf("last_stay_date", "never")
              ]
            }
          ]
        },
        // 4: every family at once - account, loyalty, order facts, both booking scans, three windows.
        {
          and: [
            leaf("has_account", "eq", true),
            leaf("loyalty_balance", "gte", 100),
            leaf("paid_spend", "gt", "50000.00", { windowDays: 365 }),
            leaf("booking_count", "gte", 1, { windowDays: 90 }),
            leaf("stay_count", "gte", 1, { windowDays: 180 }),
            leaf("no_show_count", "eq", 0, { windowDays: 365 })
          ]
        },
        // 5: a schema 1 control, which must not pay for the booking scans.
        {
          and: [
            leaf("order_count", "gte", 1, { windowDays: 90 }),
            leaf("paid_spend", "gte", "30000.00", { windowDays: 365 }),
            { not: leaf("last_order_date", "before", { daysAgo: 100 }) }
          ]
        }
      ];

      const perRule: number[][] = heavy.map(() => []);
      const timings: number[] = [];
      let counts: number[] = [];
      for (let round = 0; round < 4; round += 1) {
        counts = [];
        for (let index = 0; index < heavy.length; index += 1) {
          const started = performance.now();
          const outcome = await inTenant(TENANT_A, (tx) =>
            previewSegment(tx, ctx(), rules(heavy[index]), {
              includeSample: true
            })
          );
          const elapsed = performance.now() - started;
          timings.push(elapsed);
          perRule[index]!.push(elapsed);
          if (outcome.kind !== "ok") {
            throw new Error(
              `perf: ${outcome.kind} on rule ${index} (round ${round}) after ${Math.round(elapsed)} ms`
            );
          }
          counts.push(outcome.preview.count.count ?? -1);
        }
      }
      timings.sort((a, b) => a - b);
      const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!;
      const median = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
      console.log(
        `[M7/booking] ${totals[0]!.customers} customers, ${totals[0]!.orders} orders, ${totals[0]!.links} booking links, ${totals[0]!.decisions} decisions: ${timings.length} previews, p50 ${Math.round(median(timings))} ms, p95 ${Math.round(p95)} ms, max ${Math.round(timings[timings.length - 1]!)} ms; per rule median ms ${perRule.map((values) => Math.round(median(values))).join("/")}; counts ${counts.join("/")}`
      );
      expect(p95).toBeLessThanOrEqual(3000);
      // The measurements are of work, not of an empty scan.
      expect(counts[0]).toBeGreaterThan(10000);
      expect(counts[1]).toBeGreaterThan(1000);
      expect(counts[3]).toBeGreaterThan(1000);
    }, 280000);
  });
});
