/**
 * Loyalty program eligibility by CRM segment (Issue #361, ADR-0042 amendment,
 * PRD L1/S3, threat model C-28/C-29) - against a REAL migrated Postgres through
 * `tests/integration/harness.ts`. Gated on `DATABASE_URL`; skips cleanly
 * without one.
 *
 * Proves the properties only a database can:
 *
 *   - a member of the program's segment earns, a non-member does not, and the
 *     decision uses the customer's own facts at the order's `paid_at`;
 *   - the program records the segment id AND the pinned version, and a segment
 *     edited (or retired) after the earn leaves the explanation intact;
 *   - the `loyaltySegments` feature OFF is exactly today's behaviour;
 *   - walk-in, blocked and erased customers never earn through eligibility,
 *     even under a `NOT` rule;
 *   - the single-customer predicate agrees with the full evaluator for every
 *     customer, so the two cannot drift;
 *   - the recorded reference is tenant-safe (composite FK, resolver) and
 *     immutable once the program leaves draft;
 *   - a replay is idempotent, also after the customer left the segment.
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
import { earnPointsForPaidOrder } from "../../src/modules/commerce/application/loyalty-ledger";
import {
  activateLoyaltyProgram,
  createLoyaltyProgram,
  fetchLoyaltyProgram,
  resolveEligibilityReference,
  updateLoyaltyProgram
} from "../../src/modules/commerce/application/loyalty-program-directory";
import { decideProgramEligibility } from "../../src/modules/commerce/application/loyalty-eligibility";
import {
  createSegment,
  resolveSegmentRules,
  retireSegment,
  updateSegment
} from "../../src/modules/commerce/application/segment-directory";
import { listSegmentMembersPage } from "../../src/modules/commerce/application/segment-evaluator";
import { isCustomerSegmentMember } from "../../src/modules/commerce/application/segment-sql";
import {
  validateCreateSegmentInput,
  validateUpdateSegmentInput
} from "../../src/modules/commerce/domain/segment";
import type { LoyaltyProgramInput } from "../../src/modules/commerce/domain/loyalty-validation";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { listDomainEventConsumers } from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import type { DomainEventForHandler } from "../../src/modules/domain-event-runtime/domain/consumer-types";
import {
  assertRejected,
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "a1a1a1a1-0361-4a1a-8a1a-a1a1a1a1a1a1";
const TENANT_B = "b2b2b2b2-0361-4b2b-8b2b-b2b2b2b2b2b2";
const ACTOR = "c3c3c3c3-0361-4c3c-8c3c-c3c3c3c3c3c3";
const B_ACTOR = "f6f6f6f6-0361-4f6f-8f6f-f6f6f6f6f6f6";
const WALK_IN_PHONE = "+620000000000";
const DAY = 86_400_000;

const PROGRAM_START = new Date("2026-09-01T00:00:00.000Z");
const PAID_AT = new Date("2026-10-01T10:00:00.000Z");

const earnerConsumer = listDomainEventConsumers().find(
  (consumer) => consumer.name === "commerce.order_paid_loyalty_earner"
)!;

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
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
    VALUES (${tenantId}, 'person', 'Eligibility Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`elig-actor-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function setFeatures(
  tenantId: string,
  features: Record<string, boolean>
): Promise<void> {
  await inTenant(tenantId, async (tx) => {
    await updateModuleSettings(tx, tenantId, "commerce", { features }, ACTOR);
  });
}

const ALL_ON = { loyalty: true, segments: true, loyaltySegments: true };

type CustomerSeed = {
  name: string;
  phone: string;
  level?: number;
  status?: "active" | "blocked";
  erased?: boolean;
};

async function seedCustomer(
  tenantId: string,
  seed: CustomerSeed
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_customers
      (tenant_id, name, phone, level, status, deleted_at)
    VALUES (
      ${tenantId}, ${seed.name}, ${seed.phone}, ${seed.level ?? 1},
      ${seed.status ?? "active"},
      ${seed.erased ? new Date(PAID_AT.getTime() - DAY).toISOString() : null}::timestamptz
    )
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

let orderCounter = 0;

async function seedOrder(
  tenantId: string,
  customerId: string,
  options: { subtotal?: string; paidAt?: Date } = {}
): Promise<string> {
  orderCounter += 1;
  const subtotal = options.subtotal ?? "100000.00";
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, payment_status,
       shipping_method, subtotal, discount, total, paid_at)
    VALUES (${tenantId}, ${"ELG-" + orderCounter + "-" + Math.random().toString(36).slice(2, 7)},
       ${customerId}, 'paid', 'manual_qris', 'paid', 'self_pickup',
       ${subtotal}, '0.00', ${subtotal},
       ${(options.paidAt ?? PAID_AT).toISOString()}::timestamptz)
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

const leaf = (field: string, op: string, value?: unknown, extra = {}) => ({
  field,
  op,
  ...(value === undefined ? {} : { value }),
  ...extra
});

async function makeSegment(
  tenantId: string,
  rules: unknown,
  name: string
): Promise<{ id: string; latestVersion: number }> {
  const input = validateCreateSegmentInput({ name, rules });
  if (!input.valid) {
    throw new Error(`create refused: ${JSON.stringify(input.errors)}`);
  }
  const outcome = await inTenant(tenantId, (tx) =>
    createSegment(tx, tenantId, ACTOR, input.value)
  );
  if (outcome.kind !== "created") throw new Error(outcome.kind);
  return {
    id: outcome.segment.id,
    latestVersion: outcome.segment.latestVersion
  };
}

async function editSegment(
  tenantId: string,
  segmentId: string,
  baseVersion: number,
  rules: unknown
): Promise<number> {
  const update = validateUpdateSegmentInput({ baseVersion, rules });
  if (!update.valid) throw new Error("update refused");
  const outcome = await inTenant(tenantId, (tx) =>
    updateSegment(tx, tenantId, ACTOR, segmentId, update.value)
  );
  if (outcome.kind !== "updated") throw new Error(outcome.kind);
  if (outcome.newVersion === null) throw new Error("no new version");
  return outcome.newVersion;
}

const BASE_PROGRAM: LoyaltyProgramInput = {
  name: "Poin Segmen",
  earnUnitAmount: "10000.00",
  earnPointsPerUnit: 1,
  minOrderAmount: "0.00",
  maxPointsPerOrder: null,
  expiryDays: null,
  notes: null,
  eligibilitySegmentId: null,
  eligibilitySegmentVersion: null
};

/** Creates and activates a program version restricted to `segmentId` (pinned at its latest version now). */
async function activeProgramFor(
  tenantId: string,
  segmentId: string | null,
  version: number | null = null
): Promise<string> {
  return inTenant(tenantId, async (tx) => {
    let pinned: { segmentId: string; version: number } | null = null;
    if (segmentId !== null) {
      pinned = await resolveEligibilityReference(
        tx,
        tenantId,
        segmentId,
        version
      );
      if (!pinned) throw new Error("segment not resolvable");
    }
    const draft = await createLoyaltyProgram(tx, tenantId, ACTOR, {
      ...BASE_PROGRAM,
      eligibilitySegmentId: pinned?.segmentId ?? null,
      eligibilitySegmentVersion: pinned?.version ?? null
    });
    const result = await activateLoyaltyProgram(
      tx,
      tenantId,
      ACTOR,
      draft.id,
      PROGRAM_START
    );
    if (result.kind !== "activated") throw new Error("activation failed");
    return result.program.id;
  });
}

async function ledgerFor(
  tenantId: string,
  customerId: string
): Promise<{ kind: string; points: number; program_id: string | null }[]> {
  return (await getAdminSql()`
    SELECT l.kind, l.points::int AS points, l.program_id
    FROM awcms_commerce_loyalty_ledger l
    JOIN awcms_commerce_loyalty_accounts a ON a.id = l.account_id
    WHERE l.tenant_id = ${tenantId} AND a.customer_id = ${customerId}
    ORDER BY l.account_seq
  `) as { kind: string; points: number; program_id: string | null }[];
}

const earn = (tenantId: string, orderId: string) =>
  inTenant(tenantId, (tx) => earnPointsForPaidOrder(tx, tenantId, orderId));

let eventCounter = 0;
function paidEvent(orderId: string): DomainEventForHandler {
  eventCounter += 1;
  return {
    id: `00000000-0361-4000-8000-${String(eventCounter).padStart(12, "0")}`,
    eventType: "awcms.commerce.order.paid",
    eventVersion: "1.0",
    aggregateType: "commerce.order",
    aggregateId: orderId,
    orderKey: `commerce.order:${orderId}`,
    correlationId: null,
    causationId: null,
    producerModule: "commerce",
    payload: { orderId },
    occurredAt: PAID_AT,
    recordedAt: PAID_AT
  };
}

suite("loyalty eligibility by segment (Issue #361)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "ELGA");
    await seedTenant(TENANT_B, "ELGB");
    await seedTenantUser(TENANT_A, ACTOR);
    await seedTenantUser(TENANT_B, B_ACTOR);
    await setFeatures(TENANT_A, ALL_ON);
  }, 30000);

  describe("who earns", () => {
    test("a member of the program's segment earns; a non-member does not; the ledger row names the program", async () => {
      const gold = await makeSegment(TENANT_A, leaf("level", "eq", 2), "Gold");
      const programId = await activeProgramFor(TENANT_A, gold.id);
      const member = await seedCustomer(TENANT_A, {
        name: "Member",
        phone: "+6281300000001",
        level: 2
      });
      const outsider = await seedCustomer(TENANT_A, {
        name: "Outsider",
        phone: "+6281300000002",
        level: 1
      });
      const memberOrder = await seedOrder(TENANT_A, member);
      const outsiderOrder = await seedOrder(TENANT_A, outsider);

      expect((await earn(TENANT_A, memberOrder)).kind).toBe("earned");
      expect(await earn(TENANT_A, outsiderOrder)).toEqual({
        kind: "skipped",
        reason: "not_in_segment"
      });

      expect(await ledgerFor(TENANT_A, member)).toEqual([
        { kind: "earn", points: 10, program_id: programId }
      ]);
      expect(await ledgerFor(TENANT_A, outsider)).toHaveLength(0);
    });

    test("an unrestricted program still pays everyone (today's behaviour)", async () => {
      await activeProgramFor(TENANT_A, null);
      const customer = await seedCustomer(TENANT_A, {
        name: "Anyone",
        phone: "+6281300000003",
        level: 3
      });
      const order = await seedOrder(TENANT_A, customer);
      expect((await earn(TENANT_A, order)).kind).toBe("earned");
    });

    test("with the loyaltySegments feature OFF the restriction is not applied: exactly today's behaviour", async () => {
      const gold = await makeSegment(TENANT_A, leaf("level", "eq", 2), "Gold");
      await activeProgramFor(TENANT_A, gold.id);
      await setFeatures(TENANT_A, { loyalty: true, segments: true });
      const outsider = await seedCustomer(TENANT_A, {
        name: "Outsider",
        phone: "+6281300000004",
        level: 1
      });
      const order = await seedOrder(TENANT_A, outsider);
      expect((await earn(TENANT_A, order)).kind).toBe("earned");

      // ...and turning it back on applies it to the NEXT order (no back-fill, no claw-back).
      await setFeatures(TENANT_A, ALL_ON);
      const next = await seedOrder(TENANT_A, outsider);
      expect(await earn(TENANT_A, next)).toEqual({
        kind: "skipped",
        reason: "not_in_segment"
      });
      expect(await ledgerFor(TENANT_A, outsider)).toHaveLength(1);
    });

    test("the segment feature being off does not turn a recorded restriction into 'everyone'", async () => {
      const gold = await makeSegment(TENANT_A, leaf("level", "eq", 2), "Gold");
      await activeProgramFor(TENANT_A, gold.id);
      // `segments` is the authoring feature; `loyaltySegments` is what applies the restriction.
      await setFeatures(TENANT_A, { loyalty: true, loyaltySegments: true });
      const outsider = await seedCustomer(TENANT_A, {
        name: "Outsider",
        phone: "+6281300000005",
        level: 1
      });
      const order = await seedOrder(TENANT_A, outsider);
      expect(await earn(TENANT_A, order)).toEqual({
        kind: "skipped",
        reason: "not_in_segment"
      });
    });

    test("walk-in, blocked and erased customers never earn through eligibility, even under a NOT rule that would match everyone", async () => {
      const everyone = await makeSegment(
        TENANT_A,
        { not: leaf("level", "eq", 4) },
        "Everyone but 4"
      );
      await activeProgramFor(TENANT_A, everyone.id);
      const walkIn = await seedCustomer(TENANT_A, {
        name: "Walk-in",
        phone: WALK_IN_PHONE
      });
      const blocked = await seedCustomer(TENANT_A, {
        name: "Blocked",
        phone: "+6281300000006",
        status: "blocked"
      });
      const erased = await seedCustomer(TENANT_A, {
        name: "Erased",
        phone: "+6281300000007",
        erased: true
      });
      const regular = await seedCustomer(TENANT_A, {
        name: "Regular",
        phone: "+6281300000008"
      });

      for (const id of [walkIn, blocked, erased]) {
        const order = await seedOrder(TENANT_A, id);
        const outcome = await earn(TENANT_A, order);
        expect(outcome.kind).toBe("skipped");
        expect(await ledgerFor(TENANT_A, id)).toHaveLength(0);
      }
      expect(
        (await earn(TENANT_A, await seedOrder(TENANT_A, regular))).kind
      ).toBe("earned");

      // The predicate itself (not only the earn's earlier guards) excludes them.
      const resolved = await inTenant(TENANT_A, (tx) =>
        resolveSegmentRules(tx, TENANT_A, everyone.id, null)
      );
      for (const [id, expected] of [
        [walkIn, false],
        [blocked, false],
        [erased, false],
        [regular, true]
      ] as const) {
        expect(
          await inTenant(TENANT_A, (tx) =>
            isCustomerSegmentMember(tx, {
              tenantId: TENANT_A,
              node: resolved!.node,
              stats: resolved!.stats,
              asOf: PAID_AT.toISOString(),
              customerId: id
            })
          )
        ).toBe(expected);
      }
    });

    test("the decision uses the order history as of the order's paid_at, not as of the replay", async () => {
      // 'two paid orders or more' - the first order's earn is evaluated when it
      // is the customer's only paid order, however late the consumer runs.
      const regulars = await makeSegment(
        TENANT_A,
        leaf("order_count", "gte", 2),
        "Regulars"
      );
      await activeProgramFor(TENANT_A, regulars.id);
      const customer = await seedCustomer(TENANT_A, {
        name: "Repeat",
        phone: "+6281300000009"
      });
      const first = await seedOrder(TENANT_A, customer, {
        paidAt: new Date("2026-10-01T10:00:00.000Z")
      });
      const second = await seedOrder(TENANT_A, customer, {
        paidAt: new Date("2026-10-05T10:00:00.000Z")
      });

      // Both orders exist by the time the consumer runs, yet the first is still
      // judged at its own paid_at (one paid order: not a member).
      expect(await earn(TENANT_A, first)).toEqual({
        kind: "skipped",
        reason: "not_in_segment"
      });
      expect((await earn(TENANT_A, second)).kind).toBe("earned");
    });
  });

  describe("the recorded reference (C-29)", () => {
    test("the program stores the segment id and the pinned version, and an edit of the segment moves neither the program nor a later earn", async () => {
      const seg = await makeSegment(TENANT_A, leaf("level", "eq", 1), "Tier");
      const programId = await activeProgramFor(TENANT_A, seg.id);
      const customer = await seedCustomer(TENANT_A, {
        name: "Level One",
        phone: "+6281300000010",
        level: 1
      });
      const firstOrder = await seedOrder(TENANT_A, customer);
      expect((await earn(TENANT_A, firstOrder)).kind).toBe("earned");

      // The segment is edited to a rule this customer no longer satisfies.
      const v2 = await editSegment(TENANT_A, seg.id, 1, leaf("level", "eq", 4));
      expect(v2).toBe(2);

      const program = await inTenant(TENANT_A, (tx) =>
        fetchLoyaltyProgram(tx, TENANT_A, programId)
      );
      expect(program?.eligibilitySegmentId).toBe(seg.id);
      expect(program?.eligibilitySegmentVersion).toBe(1);

      // The past is explainable: version 1's rules are intact...
      const v1 = await inTenant(TENANT_A, (tx) =>
        resolveSegmentRules(tx, TENANT_A, seg.id, 1)
      );
      expect(v1?.version).toBe(1);
      // ...and the program still decides with version 1, not the new head.
      const secondOrder = await seedOrder(TENANT_A, customer);
      expect((await earn(TENANT_A, secondOrder)).kind).toBe("earned");
      const decision = await inTenant(TENANT_A, (tx) =>
        decideProgramEligibility(tx, TENANT_A, program!, customer, PAID_AT)
      );
      expect(decision).toEqual({
        kind: "member",
        segmentId: seg.id,
        segmentVersion: 1
      });
    });

    test("omitting the version pins the segment's LATEST version at save time", async () => {
      const seg = await makeSegment(TENANT_A, leaf("level", "eq", 1), "Tier");
      await editSegment(TENANT_A, seg.id, 1, leaf("level", "eq", 2));
      const programId = await activeProgramFor(TENANT_A, seg.id);
      const program = await inTenant(TENANT_A, (tx) =>
        fetchLoyaltyProgram(tx, TENANT_A, programId)
      );
      expect(program?.eligibilitySegmentVersion).toBe(2);
    });

    test("retiring the segment keeps the program working and explainable, but a retired segment cannot be chosen for a new restriction", async () => {
      const seg = await makeSegment(TENANT_A, leaf("level", "eq", 2), "Gold");
      await activeProgramFor(TENANT_A, seg.id);
      await inTenant(TENANT_A, (tx) =>
        retireSegment(tx, TENANT_A, ACTOR, seg.id)
      );

      const member = await seedCustomer(TENANT_A, {
        name: "Member",
        phone: "+6281300000011",
        level: 2
      });
      expect(
        (await earn(TENANT_A, await seedOrder(TENANT_A, member))).kind
      ).toBe("earned");
      expect(
        await inTenant(TENANT_A, (tx) =>
          resolveEligibilityReference(tx, TENANT_A, seg.id, null)
        )
      ).toBeNull();
    });

    test("an unknown version, an unknown segment and another tenant's segment resolve to the same null", async () => {
      const seg = await makeSegment(TENANT_A, leaf("level", "eq", 2), "Gold");
      const foreign = await makeSegment(
        TENANT_B,
        leaf("level", "eq", 2),
        "Gold"
      );
      const lookups = await inTenant(TENANT_A, async (tx) => [
        await resolveEligibilityReference(tx, TENANT_A, seg.id, 7),
        await resolveEligibilityReference(
          tx,
          TENANT_A,
          "00000000-0000-4000-8000-000000000999",
          null
        ),
        await resolveEligibilityReference(tx, TENANT_A, foreign.id, null)
      ]);
      expect(lookups).toEqual([null, null, null]);
    });

    test("the program's draft can change or clear the restriction; once active it is immutable below the application (trigger)", async () => {
      const seg = await makeSegment(TENANT_A, leaf("level", "eq", 2), "Gold");
      const other = await makeSegment(
        TENANT_A,
        leaf("level", "eq", 3),
        "Silver"
      );

      const draft = await inTenant(TENANT_A, async (tx) => {
        const created = await createLoyaltyProgram(tx, TENANT_A, ACTOR, {
          ...BASE_PROGRAM,
          eligibilitySegmentId: seg.id,
          eligibilitySegmentVersion: 1
        });
        const cleared = await updateLoyaltyProgram(
          tx,
          TENANT_A,
          ACTOR,
          created.id,
          { eligibilitySegmentId: null, eligibilitySegmentVersion: null }
        );
        expect(
          cleared.kind === "updated" && cleared.program.eligibilitySegmentId
        ).toBeNull();
        const repointed = await updateLoyaltyProgram(
          tx,
          TENANT_A,
          ACTOR,
          created.id,
          { eligibilitySegmentId: other.id, eligibilitySegmentVersion: 1 }
        );
        expect(
          repointed.kind === "updated" && repointed.program.eligibilitySegmentId
        ).toBe(other.id);
        return created;
      });
      await inTenant(TENANT_A, (tx) =>
        activateLoyaltyProgram(tx, TENANT_A, ACTOR, draft.id, PROGRAM_START)
      );

      const error = await assertRejected(
        Promise.resolve(
          getAdminSql()`
            UPDATE awcms_commerce_loyalty_programs
            SET eligibility_segment_id = NULL, eligibility_segment_version = NULL
            WHERE id = ${draft.id}
          `
        ),
        "changing the restriction of an active program"
      );
      expect(String(error.message)).toContain("immutable");
    });

    test("the schema refuses a half-set pair and a reference to another tenant's segment version", async () => {
      const foreign = await makeSegment(
        TENANT_B,
        leaf("level", "eq", 2),
        "Gold"
      );
      const half = await assertRejected(
        Promise.resolve(
          getAdminSql()`
            INSERT INTO awcms_commerce_loyalty_programs
              (tenant_id, version, name, earn_unit_amount, earn_points_per_unit,
               eligibility_segment_id)
            VALUES (${TENANT_A}, 1, 'half', 10000, 1, ${foreign.id})
          `
        ),
        "a program with a segment id but no version"
      );
      expect(String(half.message)).toContain("eligibility_pair_check");

      const crossTenant = await assertRejected(
        Promise.resolve(
          getAdminSql()`
            INSERT INTO awcms_commerce_loyalty_programs
              (tenant_id, version, name, earn_unit_amount, earn_points_per_unit,
               eligibility_segment_id, eligibility_segment_version)
            VALUES (${TENANT_A}, 1, 'cross', 10000, 1, ${foreign.id}, 1)
          `
        ),
        "a program pointing at another tenant's segment"
      );
      expect(String(crossTenant.message)).toContain("eligibility_segment_fk");
    });

    test("creating a restricted program is audited with the segment id and version", async () => {
      const seg = await makeSegment(TENANT_A, leaf("level", "eq", 2), "Gold");
      const programId = await activeProgramFor(TENANT_A, seg.id);
      const rows = (await getAdminSql()`
        SELECT attributes FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A}
          AND action = 'commerce.loyalty.program_created'
          AND resource_id = ${programId}
      `) as { attributes: Record<string, unknown> | string }[];
      expect(rows).toHaveLength(1);
      const attributes =
        typeof rows[0]!.attributes === "string"
          ? (JSON.parse(rows[0]!.attributes) as Record<string, unknown>)
          : rows[0]!.attributes;
      expect(attributes.eligibilitySegmentId).toBe(seg.id);
      expect(attributes.eligibilitySegmentVersion).toBe(1);
    });
  });

  describe("replay and the consumer", () => {
    test("the earner consumer is idempotent for a restricted program, and a replay after the customer left the segment is already_earned, not a false skip", async () => {
      const gold = await makeSegment(TENANT_A, leaf("level", "eq", 2), "Gold");
      await activeProgramFor(TENANT_A, gold.id);
      const customer = await seedCustomer(TENANT_A, {
        name: "Member",
        phone: "+6281300000012",
        level: 2
      });
      const order = await seedOrder(TENANT_A, customer);
      const event = paidEvent(order);
      for (const delivery of [event, event, paidEvent(order)]) {
        await inTenant(TENANT_A, (tx) =>
          earnerConsumer.handler(tx, delivery, {
            tenantId: TENANT_A,
            correlationId: "test"
          })
        );
      }
      expect(await ledgerFor(TENANT_A, customer)).toHaveLength(1);

      // The customer's price level changes; the same order replays.
      await getAdminSql()`
        UPDATE awcms_commerce_customers SET level = 1
        WHERE tenant_id = ${TENANT_A} AND id = ${customer}
      `;
      expect((await earn(TENANT_A, order)).kind).toBe("already_earned");
      expect(await ledgerFor(TENANT_A, customer)).toHaveLength(1);
    });

    test("an ineligible order replayed many times writes nothing and never throws", async () => {
      const gold = await makeSegment(TENANT_A, leaf("level", "eq", 2), "Gold");
      await activeProgramFor(TENANT_A, gold.id);
      const outsider = await seedCustomer(TENANT_A, {
        name: "Outsider",
        phone: "+6281300000013",
        level: 1
      });
      const order = await seedOrder(TENANT_A, outsider);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await inTenant(TENANT_A, (tx) =>
          earnerConsumer.handler(tx, paidEvent(order), {
            tenantId: TENANT_A,
            correlationId: "test"
          })
        );
      }
      expect(await ledgerFor(TENANT_A, outsider)).toHaveLength(0);
    });
  });

  describe("tenant isolation", () => {
    test("tenant B's earns are untouched by tenant A's restriction, and a restricted program in A never reads B's customers", async () => {
      const gold = await makeSegment(TENANT_A, leaf("level", "eq", 2), "Gold");
      await activeProgramFor(TENANT_A, gold.id);
      await setFeatures(TENANT_B, ALL_ON);
      await activeProgramFor(TENANT_B, null);

      const bCustomer = await seedCustomer(TENANT_B, {
        name: "B Level One",
        phone: "+6281300000014",
        level: 1
      });
      expect(
        (await earn(TENANT_B, await seedOrder(TENANT_B, bCustomer))).kind
      ).toBe("earned");

      // Asking tenant A's predicate about tenant B's customer is simply false.
      const resolved = await inTenant(TENANT_A, (tx) =>
        resolveSegmentRules(tx, TENANT_A, gold.id, null)
      );
      const bLevelTwo = await seedCustomer(TENANT_B, {
        name: "B Level Two",
        phone: "+6281300000015",
        level: 2
      });
      expect(
        await inTenant(TENANT_A, (tx) =>
          isCustomerSegmentMember(tx, {
            tenantId: TENANT_A,
            node: resolved!.node,
            stats: resolved!.stats,
            asOf: PAID_AT.toISOString(),
            customerId: bLevelTwo
          })
        )
      ).toBe(false);
    });
  });

  describe("the single-customer predicate agrees with the full evaluator", () => {
    test("for every rule shape and every customer, membership is identical", async () => {
      const asOf = new Date("2026-10-11T03:00:00.000Z");
      const ago = (days: number) => new Date(asOf.getTime() - days * DAY);

      const people = {
        a: await seedCustomer(TENANT_A, {
          name: "A",
          phone: "+6281300000021",
          level: 1
        }),
        b: await seedCustomer(TENANT_A, {
          name: "B",
          phone: "+6281300000022",
          level: 2
        }),
        c: await seedCustomer(TENANT_A, {
          name: "C",
          phone: "+6281300000023",
          level: 3
        }),
        d: await seedCustomer(TENANT_A, {
          name: "D",
          phone: "+6281300000024",
          level: 2
        }),
        walkIn: await seedCustomer(TENANT_A, {
          name: "W",
          phone: WALK_IN_PHONE
        }),
        blocked: await seedCustomer(TENANT_A, {
          name: "X",
          phone: "+6281300000025",
          status: "blocked"
        })
      };
      await seedOrder(TENANT_A, people.a, {
        subtotal: "2000000.00",
        paidAt: ago(3)
      });
      await seedOrder(TENANT_A, people.a, {
        subtotal: "500000.00",
        paidAt: ago(40)
      });
      await seedOrder(TENANT_A, people.b, {
        subtotal: "300000.00",
        paidAt: ago(20)
      });
      await seedOrder(TENANT_A, people.c, {
        subtotal: "900000.00",
        paidAt: ago(200)
      });
      await seedOrder(TENANT_A, people.blocked, {
        subtotal: "900000.00",
        paidAt: ago(2)
      });
      // Paid after the as-of: invisible to both evaluations.
      await seedOrder(TENANT_A, people.d, {
        subtotal: "9000000.00",
        paidAt: new Date(asOf.getTime() + 2 * DAY)
      });
      // Loyalty balance and an account for the 'loyalty_balance' / 'has_account' leaves.
      await setFeatures(TENANT_A, ALL_ON);
      await activeProgramFor(TENANT_A, null);
      await earn(
        TENANT_A,
        await seedOrder(TENANT_A, people.b, {
          subtotal: "100000.00",
          paidAt: ago(1)
        })
      );

      const rules: unknown[] = [
        leaf("level", "in", [1, 3]),
        { not: leaf("level", "eq", 2) },
        leaf("order_count", "gte", 1),
        leaf("order_count", "gte", 2, { windowDays: 90 }),
        leaf("paid_spend", "gte", "1000000.00", { windowDays: 30 }),
        {
          and: [
            leaf("paid_spend", "gt", "100000.00"),
            { or: [leaf("level", "eq", 2), leaf("order_count", "eq", 2)] }
          ]
        },
        leaf("last_order_date", "before", { daysAgo: 30 }),
        leaf("last_order_date", "never"),
        leaf("first_order_date", "after", { daysAgo: 60 }),
        leaf("loyalty_balance", "gt", 0),
        leaf("has_account", "eq", false)
      ];

      for (const [index, rule] of rules.entries()) {
        const seg = await makeSegment(TENANT_A, rule, `Rule ${index}`);
        const resolved = await inTenant(TENANT_A, (tx) =>
          resolveSegmentRules(tx, TENANT_A, seg.id, null)
        );
        const page = await inTenant(TENANT_A, (tx) =>
          listSegmentMembersPage(
            tx,
            { tenantId: TENANT_A, actorTenantUserId: ACTOR, now: asOf },
            { node: resolved!.node, stats: resolved!.stats },
            null,
            100
          )
        );
        if (page.kind !== "ok") throw new Error(page.kind);
        const members = new Set(page.page.items.map((item) => item.id));
        for (const id of Object.values(people)) {
          const single = await inTenant(TENANT_A, (tx) =>
            isCustomerSegmentMember(tx, {
              tenantId: TENANT_A,
              node: resolved!.node,
              stats: resolved!.stats,
              asOf: asOf.toISOString(),
              customerId: id
            })
          );
          expect({ rule: index, id, single }).toEqual({
            rule: index,
            id,
            single: members.has(id)
          });
        }
      }
    }, 60000);
  });
});
