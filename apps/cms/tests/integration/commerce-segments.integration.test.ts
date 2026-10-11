/**
 * CRM segments against a real, migrated PostgreSQL under the least-privilege
 * RUNTIME role (Issue #360, ADR-0042; PRD S1/S2/S4 and outcome M7; threat model
 * controls C-25..C-29). WORLD 1 (see `harness.ts`): an ephemeral database with
 * the real `awcms_app` / `awcms_worker` roles, so every assertion is made
 * through a connection that RLS and the privilege grants actually bind. The
 * HTTP half (route wiring, ABAC, the feature toggle) is
 * `commerce-segments-routes.integration.test.ts`.
 *
 * What this file proves, each against live data:
 *   - every field of the closed vocabulary evaluates to the right customers,
 *     alone and combined with AND / OR / NOT, including windows and as-of;
 *   - the walk-in placeholder, blocked and erased customers are never members,
 *     even under NOT (C-28), and unpaid / cancelled / deleted orders are not
 *     revenue;
 *   - small groups are suppressed (C-27), member pages are keyset-stable;
 *   - versions are immutable at the database (C-29): an edit adds N+1, the app
 *     role cannot UPDATE or DELETE a version, delete keeps every version;
 *   - tenant isolation: another tenant's segments, versions and customers are
 *     invisible, and a write for another tenant is refused (RLS WITH CHECK);
 *   - evaluation is bounded (C-26): a statement over the timeout is the stable
 *     `too_expensive` outcome and leaves the transaction and the setting intact,
 *     and a second concurrent evaluation of the same actor is `busy`;
 *   - the M7 target: p95 preview <= 3 s on a tenant of 100,000 customers.
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
  listSegments,
  resolveSegmentRules,
  retireSegment,
  updateSegment
} from "../../src/modules/commerce/application/segment-directory";
import {
  exportSegmentMembers,
  listSegmentMembersPage,
  previewSegment,
  runBoundedEvaluation,
  type SegmentEvaluationContext
} from "../../src/modules/commerce/application/segment-evaluator";
import {
  validateCreateSegmentInput,
  validateUpdateSegmentInput
} from "../../src/modules/commerce/domain/segment";
import { validateSegmentRules } from "../../src/modules/commerce/domain/segment-rules";
import {
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

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const ACTOR = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const ACTOR_2 = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const B_ACTOR = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
const WALK_IN_PHONE = "+620000000000";
const DAY = 86_400_000;

/** The server clock every evaluation in this file runs at, unless a test says otherwise. */
const NOW = new Date("2026-10-11T03:00:00.000Z");
const ago = (days: number): string =>
  new Date(NOW.getTime() - days * DAY).toISOString();

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

/** A Bun.SQL query is a lazy thenable; route it through a real Promise for `expect(...).rejects`. */
async function attempt(query: PromiseLike<unknown>): Promise<void> {
  await query;
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
    VALUES (${tenantId}, 'person', 'Segment Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`seg-actor-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

type CustomerSeed = {
  name: string;
  phone: string;
  level?: number;
  email?: string | null;
  status?: "active" | "blocked";
  createdDaysAgo?: number;
  erased?: boolean;
};

async function seedCustomer(
  tenantId: string,
  seed: CustomerSeed
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_customers
      (tenant_id, name, phone, email, level, status, created_at, deleted_at)
    VALUES (
      ${tenantId}, ${seed.name}, ${seed.phone}, ${seed.email ?? null},
      ${seed.level ?? 1}, ${seed.status ?? "active"},
      ${ago(seed.createdDaysAgo ?? 400)}::timestamptz,
      ${seed.erased ? ago(1) : null}::timestamptz
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

let orderSeq = 0;

type OrderSeed = {
  total: string;
  paidDaysAgo?: number;
  /** Paid after the evaluation's as-of (in the future). */
  paidInFutureDays?: number;
  status?: string;
  paymentStatus?: string;
  deleted?: boolean;
};

async function seedOrder(
  tenantId: string,
  customerId: string,
  seed: OrderSeed
): Promise<void> {
  orderSeq += 1;
  const paidAt =
    seed.paidInFutureDays !== undefined
      ? new Date(NOW.getTime() + seed.paidInFutureDays * DAY).toISOString()
      : seed.paidDaysAgo !== undefined
        ? ago(seed.paidDaysAgo)
        : null;
  await getAdminSql()`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method,
       payment_status, shipping_method, subtotal, total, paid_at, deleted_at,
       cancelled_at)
    VALUES (
      ${tenantId}, ${`SEG-${orderSeq}`}, ${customerId},
      ${seed.status ?? (paidAt ? "completed" : "pending_payment")},
      'manual_bank', ${seed.paymentStatus ?? (paidAt ? "paid" : "unpaid")},
      'self_pickup', ${seed.total}, ${seed.total}, ${paidAt}::timestamptz,
      ${seed.deleted ? ago(1) : null}::timestamptz,
      ${seed.status === "cancelled" ? ago(1) : null}::timestamptz
    )
  `;
}

async function seedLoyalty(
  tenantId: string,
  customerId: string,
  balance: number
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_commerce_loyalty_accounts (tenant_id, customer_id, balance)
    VALUES (${tenantId}, ${customerId}, ${balance})
  `;
}

async function seedAccount(
  tenantId: string,
  customerId: string,
  email: string
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_commerce_customer_accounts
      (tenant_id, customer_id, email_normalized, history_from)
    VALUES (${tenantId}, ${customerId}, ${email}, ${ago(300)}::timestamptz)
  `;
}

function rules(raw: unknown) {
  const result = validateSegmentRules(raw);
  if (!result.valid) {
    throw new Error(`rules refused: ${JSON.stringify(result.errors)}`);
  }
  return { node: result.node, stats: result.stats };
}

function ctx(
  tenantId = TENANT_A,
  actor = ACTOR,
  now: Date = NOW
): SegmentEvaluationContext {
  return { tenantId, actorTenantUserId: actor, now };
}

/** The names a rule matches, via the member page (the only path that shows people). */
async function namesOf(
  raw: unknown,
  tenantId = TENANT_A,
  now: Date = NOW
): Promise<string[]> {
  const outcome = await inTenant(tenantId, (tx) =>
    listSegmentMembersPage(tx, ctx(tenantId, ACTOR, now), rules(raw), null, 100)
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

/**
 * The shared world. Names say what the customer is for; the three rows at the
 * top must NEVER be a member whatever the rule says (C-28).
 */
async function seedWorld(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  ids.walkIn = await seedCustomer(TENANT_A, {
    name: "Walk-in",
    phone: WALK_IN_PHONE,
    level: 1
  });
  await seedOrder(TENANT_A, ids.walkIn, { total: "10000.00", paidDaysAgo: 1 });
  ids.blocked = await seedCustomer(TENANT_A, {
    name: "Blocked",
    phone: "+6281000000001",
    level: 1,
    status: "blocked"
  });
  ids.erased = await seedCustomer(TENANT_A, {
    name: "Erased",
    phone: "+6281000000002",
    level: 1,
    erased: true
  });

  ids.alice = await seedCustomer(TENANT_A, {
    name: "Alice",
    phone: "+6281000000011",
    level: 1,
    email: "alice@example.com",
    createdDaysAgo: 500
  });
  await seedAccount(TENANT_A, ids.alice, "alice@example.com");
  await seedLoyalty(TENANT_A, ids.alice, 500);
  await seedOrder(TENANT_A, ids.alice, { total: "100000.00", paidDaysAgo: 20 });
  await seedOrder(TENANT_A, ids.alice, {
    total: "100000.00",
    paidDaysAgo: 100
  });
  await seedOrder(TENANT_A, ids.alice, {
    total: "100000.00",
    paidDaysAgo: 400
  });

  ids.bob = await seedCustomer(TENANT_A, {
    name: "Bob",
    phone: "+6281000000012",
    level: 2,
    createdDaysAgo: 60
  });
  await seedOrder(TENANT_A, ids.bob, { total: "50000.00", paidDaysAgo: 10 });

  ids.carol = await seedCustomer(TENANT_A, {
    name: "Carol",
    phone: "+6281000000013",
    level: 2,
    email: "carol@example.com",
    createdDaysAgo: 200
  });
  await seedAccount(TENANT_A, ids.carol, "carol@example.com");
  await seedLoyalty(TENANT_A, ids.carol, 50);

  ids.dan = await seedCustomer(TENANT_A, {
    name: "Dan",
    phone: "+6281000000014",
    level: 3,
    createdDaysAgo: 300
  });
  await seedOrder(TENANT_A, ids.dan, { total: "70000.00", paidDaysAgo: 200 });
  await seedOrder(TENANT_A, ids.dan, { total: "70000.00", paidDaysAgo: 150 });
  // None of these is revenue: cancelled, expired, unpaid, soft-deleted.
  await seedOrder(TENANT_A, ids.dan, {
    total: "999999.00",
    paidDaysAgo: 5,
    status: "cancelled"
  });
  await seedOrder(TENANT_A, ids.dan, {
    total: "999999.00",
    paidDaysAgo: 5,
    status: "expired"
  });
  await seedOrder(TENANT_A, ids.dan, { total: "999999.00" });
  await seedOrder(TENANT_A, ids.dan, {
    total: "999999.00",
    paidDaysAgo: 5,
    deleted: true
  });

  ids.erin = await seedCustomer(TENANT_A, {
    name: "Erin",
    phone: "+6281000000015",
    level: 4,
    createdDaysAgo: 30
  });
  await seedOrder(TENANT_A, ids.erin, {
    total: "1000000.00",
    paidDaysAgo: 2
  });
  // Paid AFTER the as-of: invisible at NOW, so Erin has one order only.
  await seedOrder(TENANT_A, ids.erin, {
    total: "5000000.00",
    paidInFutureDays: 3
  });
  return ids;
}

function createInput(raw: unknown, name = "Seg") {
  const result = validateCreateSegmentInput({ name, rules: raw });
  if (!result.valid) {
    throw new Error(`create refused: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

async function makeSegment(
  tenantId: string,
  raw: unknown,
  name = "Seg",
  actor = ACTOR
) {
  const outcome = await inTenant(tenantId, (tx) =>
    createSegment(tx, tenantId, actor, createInput(raw, name))
  );
  if (outcome.kind !== "created") throw new Error(`create: ${outcome.kind}`);
  return outcome.segment;
}

suite(
  "CRM segments under the least-privilege runtime role (Issue #360)",
  () => {
    beforeAll(async () => {
      await setupIntegrationDatabase();
    }, 120000);

    afterAll(async () => {
      await teardownIntegrationDatabase();
    }, 60000);

    beforeEach(async () => {
      await resetDatabase();
      await seedTenant(TENANT_A, "tenant-seg-a");
      await seedTenant(TENANT_B, "tenant-seg-b");
      for (const id of [ACTOR, ACTOR_2]) await seedTenantUser(TENANT_A, id);
      await seedTenantUser(TENANT_B, B_ACTOR);
    }, 30000);

    describe("evaluation of the closed vocabulary (S2)", () => {
      test("the walk-in placeholder, a blocked customer and an erased customer are never members, whatever the rule (C-28)", async () => {
        await seedWorld();
        // `level in [1..4]` matches everyone the evaluator will let through.
        const everyone = await namesOf(leaf("level", "in", [1, 2, 3, 4]));
        expect(everyone).toEqual(["Alice", "Bob", "Carol", "Dan", "Erin"]);
        // NOT cannot resurrect them: the eligibility predicate runs before the rule.
        const notLevelFive = await namesOf({ not: leaf("level", "eq", 4) });
        expect(notLevelFive).toEqual(["Alice", "Bob", "Carol", "Dan"]);
        for (const hidden of ["Walk-in", "Blocked", "Erased"]) {
          expect(everyone).not.toContain(hidden);
          expect(notLevelFive).not.toContain(hidden);
        }
        const noOrders = await namesOf(leaf("order_count", "eq", 0));
        expect(noOrders).toEqual(["Carol"]);
      });

      test("price level, account, e-mail and customer-since", async () => {
        await seedWorld();
        expect(await namesOf(leaf("level", "eq", 2))).toEqual(["Bob", "Carol"]);
        expect(await namesOf(leaf("level", "in", [3, 4]))).toEqual([
          "Dan",
          "Erin"
        ]);
        expect(await namesOf(leaf("has_account", "eq", true))).toEqual([
          "Alice",
          "Carol"
        ]);
        expect(await namesOf(leaf("has_account", "eq", false))).toEqual([
          "Bob",
          "Dan",
          "Erin"
        ]);
        expect(await namesOf(leaf("has_email", "eq", true))).toEqual([
          "Alice",
          "Carol"
        ]);
        expect(await namesOf(leaf("has_email", "eq", false))).toEqual([
          "Bob",
          "Dan",
          "Erin"
        ]);
        expect(
          await namesOf(leaf("customer_since", "before", { daysAgo: 365 }))
        ).toEqual(["Alice"]);
        expect(
          await namesOf(leaf("customer_since", "after", { daysAgo: 100 }))
        ).toEqual(["Bob", "Erin"]);
        expect(
          await namesOf(leaf("customer_since", "before", ago(250)))
        ).toEqual(["Alice", "Dan"]);
      });

      test("order count and paid spend count only paid, live, non-cancelled orders, within the window and as-of", async () => {
        await seedWorld();
        expect(await namesOf(leaf("order_count", "gte", 3))).toEqual(["Alice"]);
        expect(await namesOf(leaf("order_count", "eq", 2))).toEqual(["Dan"]);
        expect(await namesOf(leaf("order_count", "eq", 1))).toEqual([
          "Bob",
          "Erin"
        ]);
        // Windows: Alice has one order in 30 days, Bob one, Erin one, Dan none.
        expect(
          await namesOf(leaf("order_count", "gte", 1, { windowDays: 30 }))
        ).toEqual(["Alice", "Bob", "Erin"]);
        expect(
          await namesOf(leaf("order_count", "gte", 2, { windowDays: 120 }))
        ).toEqual(["Alice"]);
        expect(
          await namesOf(leaf("order_count", "eq", 0, { windowDays: 30 }))
        ).toEqual(["Carol", "Dan"]);

        expect(await namesOf(leaf("paid_spend", "gte", "300000.00"))).toEqual([
          "Alice",
          "Erin"
        ]);
        // Erin's 5,000,000.00 order is paid after the as-of: not counted at NOW.
        expect(await namesOf(leaf("paid_spend", "gte", "2000000.00"))).toEqual(
          []
        );
        expect(await namesOf(leaf("paid_spend", "lt", "60000.00"))).toEqual([
          "Bob",
          "Carol"
        ]);
        expect(
          await namesOf(
            leaf("paid_spend", "gte", "100000.00", { windowDays: 30 })
          )
        ).toEqual(["Alice", "Erin"]);
        // The cancelled / expired / unpaid / deleted 999,999.00 orders are not revenue.
        expect(await namesOf(leaf("paid_spend", "gt", "140000.00"))).toEqual([
          "Alice",
          "Erin"
        ]);
      });

      test("first and last paid order dates, relative and absolute, and 'never'", async () => {
        await seedWorld();
        expect(
          await namesOf(leaf("last_order_date", "before", { daysAgo: 60 }))
        ).toEqual(["Dan"]);
        expect(
          await namesOf(leaf("last_order_date", "after", { daysAgo: 30 }))
        ).toEqual(["Alice", "Bob", "Erin"]);
        expect(await namesOf(leaf("last_order_date", "never"))).toEqual([
          "Carol"
        ]);
        expect(
          await namesOf(leaf("first_order_date", "after", { daysAgo: 365 }))
        ).toEqual(["Bob", "Dan", "Erin"]);
        expect(
          await namesOf(leaf("first_order_date", "before", ago(380)))
        ).toEqual(["Alice"]);
        // Absent history is "not before", so NOT(before) keeps the customer who never ordered.
        expect(
          await namesOf({
            not: leaf("last_order_date", "before", { daysAgo: 60 })
          })
        ).toEqual(["Alice", "Bob", "Carol", "Erin"]);
      });

      test("loyalty balance range (no account counts as zero)", async () => {
        await seedWorld();
        expect(await namesOf(leaf("loyalty_balance", "gte", 100))).toEqual([
          "Alice"
        ]);
        expect(await namesOf(leaf("loyalty_balance", "gt", 0))).toEqual([
          "Alice",
          "Carol"
        ]);
        expect(await namesOf(leaf("loyalty_balance", "eq", 0))).toEqual([
          "Bob",
          "Dan",
          "Erin"
        ]);
        expect(await namesOf(leaf("loyalty_balance", "lt", 100))).toEqual([
          "Bob",
          "Carol",
          "Dan",
          "Erin"
        ]);
      });

      test("AND, OR and NOT combine, nested to the bound", async () => {
        await seedWorld();
        expect(
          await namesOf({
            and: [leaf("level", "in", [1, 2]), leaf("has_account", "eq", true)]
          })
        ).toEqual(["Alice", "Carol"]);
        expect(
          await namesOf({
            or: [leaf("level", "eq", 4), leaf("loyalty_balance", "gte", 500)]
          })
        ).toEqual(["Alice", "Erin"]);
        expect(
          await namesOf({
            and: [
              { not: leaf("has_account", "eq", true) },
              { or: [leaf("level", "eq", 2), leaf("order_count", "eq", 2)] }
            ]
          })
        ).toEqual(["Bob", "Dan"]);
        expect(
          await namesOf({
            not: {
              or: [
                leaf("level", "eq", 1),
                { not: leaf("order_count", "gte", 1) }
              ]
            }
          })
        ).toEqual(["Bob", "Dan", "Erin"]);
      });

      test("the same rule at the same as-of gives the same result, and an earlier as-of changes it (C-25 server as-of)", async () => {
        await seedWorld();
        const rule = leaf("order_count", "gte", 1, { windowDays: 30 });
        const first = await namesOf(rule);
        expect(await namesOf(rule)).toEqual(first);
        // 15 days earlier: only orders paid by then count and the window is
        // measured from there. Bob's (10 days ago) and Erin's (2) are not yet
        // paid; Alice's (20 days ago) is 5 days old.
        const earlier = new Date(NOW.getTime() - 15 * DAY);
        expect(await namesOf(rule, TENANT_A, earlier)).toEqual(["Alice"]);
      });

      test("an unused relation is not joined: a customer-only rule matches without any order data at all", async () => {
        await seedCustomer(TENANT_A, {
          name: "Solo",
          phone: "+6281000000099",
          level: 3
        });
        expect(await namesOf(leaf("level", "eq", 3))).toEqual(["Solo"]);
      });
    });

    describe("counts, samples, pages and exports (C-27)", () => {
      test("a count under five is withheld and reported as 'fewer than 5'; five or more is a number", async () => {
        await seedWorld();
        const small = await inTenant(TENANT_A, (tx) =>
          previewSegment(tx, ctx(), rules(leaf("level", "eq", 2)), {
            includeSample: false
          })
        );
        expect(small.kind === "ok" && small.preview.count).toEqual({
          suppressed: true,
          count: null,
          label: "fewer_than_5"
        });
        expect(small.kind === "ok" && small.preview.sample).toBeNull();
        expect(small.kind === "ok" && small.preview.asOf).toBe(
          NOW.toISOString()
        );

        const everyone = await inTenant(TENANT_A, (tx) =>
          previewSegment(tx, ctx(), rules(leaf("level", "in", [1, 2, 3, 4])), {
            includeSample: true
          })
        );
        expect(everyone.kind === "ok" && everyone.preview.count).toEqual({
          suppressed: false,
          count: 5
        });
        expect(everyone.kind === "ok" && everyone.preview.sample?.length).toBe(
          5
        );
      });

      test("the sample is bounded, ordered and masked", async () => {
        await getAdminSql()`
        INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email, level)
        SELECT ${TENANT_A}, 'Bulk ' || g, '+62811' || lpad(g::text, 8, '0'),
          'bulk' || g || '@example.com', 1
        FROM generate_series(1, 40) g
      `;
        const outcome = await inTenant(TENANT_A, (tx) =>
          previewSegment(tx, ctx(), rules(leaf("level", "eq", 1)), {
            includeSample: true
          })
        );
        if (outcome.kind !== "ok") throw new Error(outcome.kind);
        expect(outcome.preview.count).toEqual({ suppressed: false, count: 40 });
        const sample = outcome.preview.sample!;
        expect(sample).toHaveLength(10);
        const ids = sample.map((m) => m.id);
        expect([...ids].sort()).toEqual(ids);
        for (const member of sample) {
          expect(member.phoneMasked).toContain("•");
          expect(member.emailMasked).toContain("•••@example.com");
        }
      });

      test("members are keyset-paged with no gap and no duplicate, and the last page has no cursor", async () => {
        await getAdminSql()`
        INSERT INTO awcms_commerce_customers (tenant_id, name, phone, level)
        SELECT ${TENANT_A}, 'P ' || g, '+62822' || lpad(g::text, 8, '0'), 1
        FROM generate_series(1, 120) g
      `;
        const seen: string[] = [];
        let after: string | null = null;
        let pages = 0;
        for (;;) {
          const cursor: string | null = after;
          const outcome: Awaited<ReturnType<typeof listSegmentMembersPage>> =
            await inTenant(TENANT_A, (tx) =>
              listSegmentMembersPage(
                tx,
                ctx(),
                rules(leaf("level", "eq", 1)),
                cursor,
                50
              )
            );
          if (outcome.kind !== "ok") throw new Error(outcome.kind);
          pages += 1;
          seen.push(...outcome.page.items.map((m) => m.id));
          if (!outcome.page.hasMore) break;
          after = outcome.page.lastId;
        }
        expect(pages).toBe(3);
        expect(seen).toHaveLength(120);
        expect(new Set(seen).size).toBe(120);
        expect([...seen].sort()).toEqual(seen);
      });

      test("an export is bounded and says so when it was cut", async () => {
        await getAdminSql()`
        INSERT INTO awcms_commerce_customers (tenant_id, name, phone, level)
        SELECT ${TENANT_A}, 'E ' || g, '+62833' || lpad(g::text, 8, '0'), 1
        FROM generate_series(1, 25) g
      `;
        const cut = await inTenant(TENANT_A, (tx) =>
          exportSegmentMembers(tx, ctx(), rules(leaf("level", "eq", 1)), 10)
        );
        expect(cut.kind === "ok" && cut.members).toHaveLength(10);
        expect(cut.kind === "ok" && cut.truncated).toBe(true);
        const whole = await inTenant(TENANT_A, (tx) =>
          exportSegmentMembers(tx, ctx(), rules(leaf("level", "eq", 1)), 100)
        );
        expect(whole.kind === "ok" && whole.members).toHaveLength(25);
        expect(whole.kind === "ok" && whole.truncated).toBe(false);
      });
    });

    describe("immutable versions (S1, C-29)", () => {
      test("create is version 1; an edit adds version 2 and version 1 is untouched; the stale base is a conflict", async () => {
        const created = await makeSegment(
          TENANT_A,
          leaf("level", "eq", 1),
          "VIPs"
        );
        expect(created.latestVersion).toBe(1);
        expect(created.versions.map((v) => v.version)).toEqual([1]);
        const v1Rules = created.versions[0]!.rules;

        const update = validateUpdateSegmentInput({
          baseVersion: 1,
          rules: leaf("level", "eq", 4)
        });
        if (!update.valid) throw new Error("update refused");
        const edited = await inTenant(TENANT_A, (tx) =>
          updateSegment(tx, TENANT_A, ACTOR, created.id, update.value)
        );
        expect(edited.kind === "updated" && edited.newVersion).toBe(2);
        const detail = await inTenant(TENANT_A, (tx) =>
          fetchSegment(tx, TENANT_A, created.id)
        );
        expect(detail?.latestVersion).toBe(2);
        expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
        expect(detail?.versions[1]!.rules).toEqual(v1Rules);

        // The same stale edit again (a double submit / a stale tab) is a conflict, not a version 3.
        const stale = await inTenant(TENANT_A, (tx) =>
          updateSegment(tx, TENANT_A, ACTOR, created.id, update.value)
        );
        expect(stale).toEqual({ kind: "version_conflict", latestVersion: 2 });
        const after = await inTenant(TENANT_A, (tx) =>
          fetchSegment(tx, TENANT_A, created.id)
        );
        expect(after?.versions).toHaveLength(2);
      });

      test("a rename does not add a version; a duplicate name (any case) is refused; a retired name is free again", async () => {
        const a = await makeSegment(TENANT_A, leaf("level", "eq", 1), "Alpha");
        await makeSegment(TENANT_A, leaf("level", "eq", 2), "Beta");
        const rename = validateUpdateSegmentInput({
          baseVersion: 1,
          name: "Gamma"
        });
        if (!rename.valid) throw new Error("refused");
        const renamed = await inTenant(TENANT_A, (tx) =>
          updateSegment(tx, TENANT_A, ACTOR, a.id, rename.value)
        );
        expect(renamed.kind === "updated" && renamed.newVersion).toBeNull();
        expect(
          renamed.kind === "updated" && renamed.segment.latestVersion
        ).toBe(1);

        const dup = await inTenant(TENANT_A, (tx) =>
          createSegment(
            tx,
            TENANT_A,
            ACTOR,
            createInput(leaf("level", "eq", 3), "BETA")
          )
        );
        expect(dup).toEqual({ kind: "name_taken" });
        // The failed insert must not have poisoned the transaction or left a head behind.
        const list = await inTenant(TENANT_A, (tx) =>
          listSegments(tx, TENANT_A, null, true)
        );
        expect(list.items.map((s) => s.name).sort()).toEqual(["Beta", "Gamma"]);

        const toTaken = validateUpdateSegmentInput({
          baseVersion: 1,
          name: "beta"
        });
        if (!toTaken.valid) throw new Error("refused");
        expect(
          await inTenant(TENANT_A, (tx) =>
            updateSegment(tx, TENANT_A, ACTOR, a.id, toTaken.value)
          )
        ).toEqual({ kind: "name_taken" });

        await inTenant(TENANT_A, (tx) =>
          retireSegment(tx, TENANT_A, ACTOR, a.id)
        );
        const reuse = await inTenant(TENANT_A, (tx) =>
          createSegment(
            tx,
            TENANT_A,
            ACTOR,
            createInput(leaf("level", "eq", 3), "Gamma")
          )
        );
        expect(reuse.kind).toBe("created");
      });

      test("delete retires the head and KEEPS every version: a past consumer's (segment, version) still resolves and evaluates", async () => {
        await seedWorld();
        const created = await makeSegment(
          TENANT_A,
          leaf("level", "eq", 2),
          "Mid"
        );
        const v2 = validateUpdateSegmentInput({
          baseVersion: 1,
          rules: leaf("level", "eq", 4)
        });
        if (!v2.valid) throw new Error("refused");
        await inTenant(TENANT_A, (tx) =>
          updateSegment(tx, TENANT_A, ACTOR, created.id, v2.value)
        );

        const retired = await inTenant(TENANT_A, (tx) =>
          retireSegment(tx, TENANT_A, ACTOR, created.id)
        );
        expect(retired.kind === "retired" && retired.segment.status).toBe(
          "retired"
        );
        expect(
          await inTenant(TENANT_A, (tx) =>
            retireSegment(tx, TENANT_A, ACTOR, created.id)
          )
        ).toEqual({ kind: "already_retired" });

        const edit = validateUpdateSegmentInput({ baseVersion: 2, name: "x" });
        if (!edit.valid) throw new Error("refused");
        expect(
          await inTenant(TENANT_A, (tx) =>
            updateSegment(tx, TENANT_A, ACTOR, created.id, edit.value)
          )
        ).toEqual({ kind: "retired" });

        const live = await inTenant(TENANT_A, (tx) =>
          listSegments(tx, TENANT_A, null, false)
        );
        expect(live.items).toEqual([]);
        const all = await inTenant(TENANT_A, (tx) =>
          listSegments(tx, TENANT_A, null, true)
        );
        expect(all.items).toHaveLength(1);

        const versionRows = (await getAdminSql()`
        SELECT version FROM awcms_commerce_segment_versions
        WHERE segment_id = ${created.id} ORDER BY version
      `) as { version: number }[];
        expect(versionRows.map((r) => r.version)).toEqual([1, 2]);

        // Version 1 (what a past campaign recorded) still explains its audience.
        const old = await inTenant(TENANT_A, (tx) =>
          resolveSegmentRules(tx, TENANT_A, created.id, 1)
        );
        expect(old?.version).toBe(1);
        const members = await inTenant(TENANT_A, (tx) =>
          listSegmentMembersPage(
            tx,
            ctx(),
            { node: old!.node, stats: old!.stats },
            null,
            50
          )
        );
        expect(
          members.kind === "ok" && members.page.items.map((m) => m.name).sort()
        ).toEqual(["Bob", "Carol"]);
        expect(
          await inTenant(TENANT_A, (tx) =>
            resolveSegmentRules(tx, TENANT_A, created.id, 9)
          )
        ).toBeNull();
      });

      test("the database refuses to change or delete a version, and the app role cannot even try", async () => {
        const created = await makeSegment(
          TENANT_A,
          leaf("level", "eq", 1),
          "Locked"
        );
        // The trigger stops even a role that holds UPDATE (the superuser here).
        await expect(
          attempt(
            getAdminSql()`UPDATE awcms_commerce_segment_versions SET depth = 3 WHERE segment_id = ${created.id}`
          )
        ).rejects.toThrow(/immutable/);
        // The runtime role holds no UPDATE or DELETE at all.
        await expect(
          inTenant(TENANT_A, (tx) =>
            attempt(
              tx`UPDATE awcms_commerce_segment_versions SET depth = 3 WHERE segment_id = ${created.id}`
            )
          )
        ).rejects.toThrow(/permission denied/);
        await expect(
          inTenant(TENANT_A, (tx) =>
            attempt(
              tx`DELETE FROM awcms_commerce_segment_versions WHERE segment_id = ${created.id}`
            )
          )
        ).rejects.toThrow(/permission denied/);
        await expect(
          inTenant(TENANT_A, (tx) =>
            attempt(
              tx`DELETE FROM awcms_commerce_segments WHERE id = ${created.id}`
            )
          )
        ).rejects.toThrow(/permission denied/);
        // The head's version counter only moves forward and identity is frozen.
        await expect(
          inTenant(TENANT_A, (tx) =>
            attempt(
              tx`UPDATE awcms_commerce_segments SET latest_version = 0 WHERE id = ${created.id}`
            )
          )
        ).rejects.toThrow(/latest_version|check/i);
        await expect(
          inTenant(TENANT_A, (tx) =>
            attempt(
              tx`UPDATE awcms_commerce_segments SET created_by_tenant_user_id = ${ACTOR_2} WHERE id = ${created.id}`
            )
          )
        ).rejects.toThrow(/frozen/);
        const still = await inTenant(TENANT_A, (tx) =>
          fetchSegment(tx, TENANT_A, created.id)
        );
        expect(still?.versions).toHaveLength(1);
      });

      test("a stored rule that no longer validates is never evaluated: resolve fails closed", async () => {
        const created = await makeSegment(
          TENANT_A,
          leaf("level", "eq", 1),
          "Tamper"
        );
        // A version written around the validator (superuser) with a field outside the vocabulary.
        await getAdminSql()`
        INSERT INTO awcms_commerce_segment_versions
          (tenant_id, segment_id, version, rules, node_count, depth, created_by_tenant_user_id)
        VALUES (${TENANT_A}, ${created.id}, 2,
          ${{ field: "tenant_id", op: "eq", value: 1 }}::jsonb, 1, 0, ${ACTOR})
      `;
        await expect(
          inTenant(TENANT_A, (tx) =>
            resolveSegmentRules(tx, TENANT_A, created.id, 2)
          )
        ).rejects.toThrow(/no longer validates/);
      });

      test("every mutation is audited with the actor and the version, and never a rule value or a customer", async () => {
        const created = await makeSegment(
          TENANT_A,
          leaf("level", "eq", 1),
          "Audited"
        );
        const v2 = validateUpdateSegmentInput({
          baseVersion: 1,
          rules: leaf("level", "eq", 2)
        });
        if (!v2.valid) throw new Error("refused");
        await inTenant(TENANT_A, (tx) =>
          updateSegment(tx, TENANT_A, ACTOR, created.id, v2.value)
        );
        await inTenant(TENANT_A, (tx) =>
          retireSegment(tx, TENANT_A, ACTOR, created.id)
        );
        const rows = (await getAdminSql()`
        SELECT action, severity, actor_tenant_user_id::text AS actor, attributes
        FROM awcms_audit_events
        WHERE resource_type = 'commerce_segment' AND resource_id = ${created.id}
        ORDER BY created_at, action
      `) as {
          action: string;
          severity: string;
          actor: string;
          attributes: Record<string, unknown>;
        }[];
        expect(rows.map((r) => r.action).sort()).toEqual([
          "commerce.segment.created",
          "commerce.segment.deleted",
          "commerce.segment.version_created"
        ]);
        expect(rows.every((r) => r.actor === ACTOR)).toBe(true);
        const versionRow = rows.find(
          (r) => r.action === "commerce.segment.version_created"
        )!;
        expect(versionRow.attributes).toMatchObject({
          version: 2,
          previousVersion: 1
        });
        expect(JSON.stringify(rows)).not.toContain("level");
      });
    });

    describe("tenant isolation (RLS)", () => {
      test("tenant B sees none of tenant A's segments, versions or customers, and cannot write a row for A", async () => {
        await seedWorld();
        const aSeg = await makeSegment(
          TENANT_A,
          leaf("level", "in", [1, 2, 3, 4]),
          "A only"
        );
        await seedCustomer(TENANT_B, {
          name: "B-One",
          phone: "+6281999000001",
          level: 2
        });

        expect(
          (
            await inTenant(TENANT_B, (tx) =>
              listSegments(tx, TENANT_B, null, true)
            )
          ).items
        ).toEqual([]);
        expect(
          await inTenant(TENANT_B, (tx) => fetchSegment(tx, TENANT_B, aSeg.id))
        ).toBeNull();
        expect(
          await inTenant(TENANT_B, (tx) =>
            resolveSegmentRules(tx, TENANT_B, aSeg.id, 1)
          )
        ).toBeNull();
        // Asking B's context to edit or retire A's segment is "not found", indistinguishable from an unknown id.
        const edit = validateUpdateSegmentInput({
          baseVersion: 1,
          name: "hijack"
        });
        if (!edit.valid) throw new Error("refused");
        expect(
          await inTenant(TENANT_B, (tx) =>
            updateSegment(tx, TENANT_B, B_ACTOR, aSeg.id, edit.value)
          )
        ).toEqual({
          kind: "not_found"
        });
        expect(
          await inTenant(TENANT_B, (tx) =>
            retireSegment(tx, TENANT_B, B_ACTOR, aSeg.id)
          )
        ).toEqual({
          kind: "not_found"
        });

        // Evaluation in B's context only ever counts B's customers, even for the widest rule.
        expect(
          await namesOf(leaf("level", "in", [1, 2, 3, 4]), TENANT_B)
        ).toEqual(["B-One"]);
        // Passing A's tenant id to the SQL while connected as B yields nothing: RLS binds, not the predicate alone.
        const forged = await inTenant(TENANT_B, (tx) =>
          listSegmentMembersPage(
            tx,
            ctx(TENANT_A, B_ACTOR),
            rules(leaf("level", "in", [1, 2, 3, 4])),
            null,
            100
          )
        );
        expect(forged.kind === "ok" && forged.page.items).toEqual([]);

        await expect(
          inTenant(TENANT_B, (tx) =>
            attempt(tx`
            INSERT INTO awcms_commerce_segments (tenant_id, name, created_by_tenant_user_id)
            VALUES (${TENANT_A}, 'smuggled', ${B_ACTOR})
          `)
          )
        ).rejects.toThrow(/row-level security/);

        // A is untouched.
        const intact = await inTenant(TENANT_A, (tx) =>
          fetchSegment(tx, TENANT_A, aSeg.id)
        );
        expect(intact?.status).toBe("active");
        expect(intact?.name).toBe("A only");
      });

      test("a version cannot point at another tenant's segment even through a credential that skips RLS (composite FK)", async () => {
        const aSeg = await makeSegment(TENANT_A, leaf("level", "eq", 1), "Fk");
        await expect(
          attempt(getAdminSql()`
          INSERT INTO awcms_commerce_segment_versions
            (tenant_id, segment_id, version, rules, node_count, depth, created_by_tenant_user_id)
          VALUES (${TENANT_B}, ${aSeg.id}, 9, '{"field":"level","op":"eq","value":1}'::jsonb, 1, 0, ${B_ACTOR})
        `)
        ).rejects.toThrow(/foreign key/i);
      });

      test("the retention worker may SELECT and DELETE the segment tables but never UPDATE them", async () => {
        if (!workerRoleActivated) return;
        const seg = await makeSegment(
          TENANT_A,
          leaf("level", "eq", 1),
          "Worker"
        );
        const worker = getWorkerRoleSql();
        const rows = (await withTenantOrThrow(
          worker,
          TENANT_A,
          (tx) =>
            tx`SELECT id FROM awcms_commerce_segments WHERE id = ${seg.id}`
        )) as { id: string }[];
        expect(rows).toHaveLength(1);
        await expect(
          withTenantOrThrow(worker, TENANT_A, (tx) =>
            attempt(
              tx`UPDATE awcms_commerce_segments SET name = 'x' WHERE id = ${seg.id}`
            )
          )
        ).rejects.toThrow(/permission denied/);
        await expect(
          withTenantOrThrow(worker, TENANT_A, (tx) =>
            attempt(
              tx`UPDATE awcms_commerce_segment_versions SET depth = 1 WHERE segment_id = ${seg.id}`
            )
          )
        ).rejects.toThrow(/permission denied/);
      });
    });

    describe("bounded evaluation (C-26)", () => {
      test("a statement over the timeout is the stable 'too_expensive' outcome; the transaction and the setting survive", async () => {
        const result = await inTenant(TENANT_A, async (tx) => {
          const before =
            (await tx`SELECT current_setting('statement_timeout') AS v`) as {
              v: string;
            }[];
          const outcome = await runBoundedEvaluation(
            tx,
            ctx(),
            async (db) => {
              await db`SELECT pg_sleep(2)`;
              return "never";
            },
            { statementTimeoutMs: 100 }
          );
          // The tenant transaction is still usable and the timeout is restored.
          const after =
            (await tx`SELECT current_setting('statement_timeout') AS v, 1 AS one`) as {
              v: string;
              one: number;
            }[];
          return { before: before[0]!.v, outcome, after: after[0]! };
        });
        expect(result.outcome).toEqual({ kind: "too_expensive" });
        expect(result.after.one).toBe(1);
        expect(result.after.v).toBe(result.before);
      });

      test("a successful evaluation restores the statement timeout and reports the server as-of", async () => {
        const result = await inTenant(TENANT_A, async (tx) => {
          const before =
            (await tx`SELECT current_setting('statement_timeout') AS v`) as {
              v: string;
            }[];
          const outcome = await runBoundedEvaluation(
            tx,
            ctx(),
            async (db, asOf) => {
              const inside =
                (await db`SELECT current_setting('statement_timeout') AS v`) as {
                  v: string;
                }[];
              return { inside: inside[0]!.v, asOf };
            }
          );
          const after =
            (await tx`SELECT current_setting('statement_timeout') AS v`) as {
              v: string;
            }[];
          return { before: before[0]!.v, outcome, after: after[0]!.v };
        });
        if (result.outcome.kind !== "ok") throw new Error(result.outcome.kind);
        expect(result.outcome.value.inside).toBe("5s");
        expect(result.outcome.value.asOf).toBe(NOW.toISOString());
        expect(result.after).toBe(result.before);
      });

      test("a second concurrent evaluation by the same actor is 'busy'; a different actor takes the tenant's second slot; a third is 'busy'", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let held!: () => void;
        const holding = new Promise<void>((resolve) => {
          held = resolve;
        });
        // Connection 1 takes the actor's slot and the tenant's first slot, and keeps them.
        const first = inTenant(TENANT_A, async (tx) => {
          const outcome = await runBoundedEvaluation(
            tx,
            ctx(TENANT_A, ACTOR),
            async () => {
              held();
              await gate;
              return "first";
            }
          );
          return outcome.kind;
        });
        await holding;

        const sameActor = await inTenant(TENANT_A, (tx) =>
          runBoundedEvaluation(tx, ctx(TENANT_A, ACTOR), async () => "second")
        );
        expect(sameActor).toEqual({ kind: "busy" });

        // A different actor takes the tenant's second slot and runs; while it is held a third is busy.
        let release2!: () => void;
        const gate2 = new Promise<void>((resolve) => {
          release2 = resolve;
        });
        let held2!: () => void;
        const holding2 = new Promise<void>((resolve) => {
          held2 = resolve;
        });
        const second = inTenant(TENANT_A, async (tx) => {
          const outcome = await runBoundedEvaluation(
            tx,
            ctx(TENANT_A, ACTOR_2),
            async () => {
              held2();
              await gate2;
              return "second";
            }
          );
          return outcome.kind;
        });
        await holding2;
        const third = await inTenant(TENANT_A, (tx) =>
          runBoundedEvaluation(
            tx,
            ctx(TENANT_A, "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5"),
            async () => "third"
          )
        );
        expect(third).toEqual({ kind: "busy" });

        // Another tenant is unaffected by tenant A's slots.
        const other = await inTenant(TENANT_B, (tx) =>
          runBoundedEvaluation(tx, ctx(TENANT_B, B_ACTOR), async () => "b")
        );
        expect(other.kind).toBe("ok");

        release();
        release2();
        expect(await first).toBe("ok");
        expect(await second).toBe("ok");
        // Slots are released with the transaction: the same actor can evaluate again.
        const again = await inTenant(TENANT_A, (tx) =>
          runBoundedEvaluation(tx, ctx(TENANT_A, ACTOR), async () => "again")
        );
        expect(again.kind).toBe("ok");
      });
    });

    describe("PRD outcome M7: p95 preview <= 3 s on 100,000 customers", () => {
      test("previews of broad, windowed and multi-fact rules over a 100,000-customer tenant stay inside the target", async () => {
        const admin = getAdminSql();
        await admin`
        INSERT INTO awcms_commerce_customers
          (tenant_id, name, phone, email, level, created_at)
        SELECT ${TENANT_A}, 'Perf ' || g, '+62877' || lpad(g::text, 9, '0'),
          CASE WHEN g % 3 = 0 THEN 'perf' || g || '@example.com' END,
          1 + (g % 4), now() - (g % 700) * interval '1 day'
        FROM generate_series(1, 100000) g
      `;
        // ~2.5 paid orders per customer on average, spread over two years.
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
        await admin`ANALYZE awcms_commerce_customers`;
        await admin`ANALYZE awcms_commerce_orders`;
        await admin`ANALYZE awcms_commerce_customer_accounts`;
        await admin`ANALYZE awcms_commerce_loyalty_accounts`;

        const heavy = [
          leaf("level", "in", [1, 2]),
          leaf("order_count", "gte", 2),
          {
            and: [
              leaf("order_count", "gte", 1, { windowDays: 90 }),
              leaf("paid_spend", "gte", "30000.00", { windowDays: 365 }),
              { not: leaf("last_order_date", "before", { daysAgo: 100 }) }
            ]
          },
          {
            and: [
              leaf("has_account", "eq", true),
              leaf("loyalty_balance", "gte", 100),
              {
                or: [
                  leaf("paid_spend", "gt", "50000.00"),
                  leaf("first_order_date", "after", { daysAgo: 365 }),
                  leaf("customer_since", "before", { daysAgo: 400 })
                ]
              }
            ]
          },
          {
            and: [
              leaf("order_count", "gte", 1, { windowDays: 90 }),
              leaf("order_count", "gte", 2, { windowDays: 200 }),
              leaf("paid_spend", "gt", "1000.00", { windowDays: 365 }),
              { not: leaf("last_order_date", "never") }
            ]
          }
        ];

        const timings: number[] = [];
        let counts: number[] = [];
        for (let round = 0; round < 4; round += 1) {
          counts = [];
          for (const raw of heavy) {
            const started = performance.now();
            const outcome = await inTenant(TENANT_A, (tx) =>
              previewSegment(tx, ctx(), rules(raw), { includeSample: true })
            );
            timings.push(performance.now() - started);
            if (outcome.kind !== "ok") throw new Error(`perf: ${outcome.kind}`);
            counts.push(outcome.preview.count.count ?? -1);
          }
        }
        timings.sort((a, b) => a - b);
        const p95 = timings[Math.ceil(timings.length * 0.95) - 1]!;
        console.log(
          `[M7] 100,000 customers: ${timings.length} previews, p50 ${Math.round(timings[Math.floor(timings.length / 2)]!)} ms, p95 ${Math.round(p95)} ms, max ${Math.round(timings[timings.length - 1]!)} ms; counts ${counts.join("/")}`
        );
        expect(p95).toBeLessThanOrEqual(3000);
        // The broad rules matched real populations, so the timings measured work, not an empty scan.
        expect(counts[0]).toBeGreaterThan(40000);
        expect(counts[1]).toBeGreaterThan(1000);
        // The windowed, multi-fact rules matched real populations too.
        expect(counts[2]).toBeGreaterThan(1000);
        expect(counts[4]).toBeGreaterThan(1000);
      }, 280000);
    });
  }
);
