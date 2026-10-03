/**
 * Loyalty & rewards ledger integration (Issue #289, ADR-0026) — against a REAL
 * migrated Postgres through `tests/integration/harness.ts`. Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * Covers the properties only a real database can prove:
 *
 *   - earn happens exactly once per order, however many times the order-paid
 *     event (or the function) is replayed, and only from server-side facts;
 *   - walk-in/sentinel customers, a disabled feature, a missing program, a
 *     cancelled order and a blocked customer never earn;
 *   - the program version effective at `paid_at` is the one stamped on the row;
 *   - concurrent redemptions serialise on the account lock and can NEVER
 *     overdraw; a same-key retry is a replay, a same-key different-points
 *     request is a conflict;
 *   - expiry is idempotent, handles a partly spent and a fully spent lot, and a
 *     redemption lazily expires due points first;
 *   - reversal is a compensating entry (never a delete), idempotent, never
 *     double-deducts what already lapsed, and may drive the balance negative;
 *   - the ledger is append-only below the application (REVOKE + trigger), and
 *     checked by sign, uniqueness and manual-adjustment CHECKs;
 *   - RLS: tenant B can neither see nor reference tenant A's loyalty rows;
 *   - the customer-facing read path is owner-scoped (BOLA);
 *   - reconcile reports drift and ledger breaks and repairs only the projection;
 *   - the summary adds up without double counting;
 *   - the worker role (the one that really runs the consumers and the expiry
 *     job) holds exactly the grants the code needs.
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
  adjustPoints,
  appendLedgerEntry,
  earnPointsForPaidOrder,
  expireDueLoyaltyPointsForTenant,
  fetchCustomerLoyaltyOverview,
  fetchLoyaltyAccountForCustomer,
  fetchLoyaltySummary,
  findOrCreateAccountLocked,
  listLedgerForAccount,
  listLoyaltyAccounts,
  LoyaltyIdempotencyConflictError,
  reconcileLoyaltyForTenant,
  redeemPoints,
  reverseEarnForCancelledOrder
} from "../../src/modules/commerce/application/loyalty-ledger";
import {
  activateLoyaltyProgram,
  createLoyaltyProgram,
  fetchEffectiveProgramAt,
  listLoyaltyPrograms,
  retireLoyaltyProgram,
  updateLoyaltyProgram
} from "../../src/modules/commerce/application/loyalty-program-directory";
import { fetchCommerceFeatures } from "../../src/modules/commerce/application/commerce-feature-gate";
import { POS_WALK_IN_CUSTOMER_SENTINEL_PHONE } from "../../src/modules/commerce/domain/phone-normalisation";
import {
  orderCancelledLoyaltyReverserConsumer,
  orderPaidLoyaltyEarnerConsumer
} from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import type { DomainEventForHandler } from "../../src/modules/domain-event-runtime/domain/consumer-types";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import type { LoyaltyProgramInput } from "../../src/modules/commerce/domain/loyalty-validation";
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

const TENANT_A = "aaaaaaaa-0289-4000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0289-4000-8000-000000000002";
const ACTOR = "cccccccc-0289-4000-8000-000000000003";

const DAY = 86_400_000;
const PAID_AT = new Date("2026-10-01T10:00:00.000Z");
const PROGRAM_START = new Date("2026-09-01T00:00:00.000Z");

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

async function enableLoyalty(tenantId: string, on = true): Promise<void> {
  await inTenant(tenantId, async (tx) => {
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
          loyalty: on
        }
      },
      ACTOR
    );
  });
}

async function seedCustomer(
  tenantId: string,
  phone: string,
  status = "active"
): Promise<string> {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone, status)
      VALUES (${tenantId}, 'Siti', ${phone}, ${status})
      RETURNING id
    `
  )) as { id: string }[];
  return rows[0]!.id;
}

let orderCounter = 0;

async function seedOrder(
  tenantId: string,
  customerId: string,
  options: {
    subtotal?: string;
    discount?: string;
    status?: string;
    paidAt?: Date;
  } = {}
): Promise<string> {
  orderCounter += 1;
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_commerce_orders
        (tenant_id, order_code, customer_id, status, payment_method, payment_status,
         shipping_method, subtotal, discount, total, paid_at)
      VALUES
        (${tenantId}, ${"LOY-" + orderCounter + "-" + Math.random().toString(36).slice(2, 7)},
         ${customerId}, ${options.status ?? "paid"}, 'manual_qris', 'paid', 'self_pickup',
         ${options.subtotal ?? "100000.00"}, ${options.discount ?? "0.00"},
         ${options.subtotal ?? "100000.00"}, ${options.paidAt ?? PAID_AT})
      RETURNING id
    `
  )) as { id: string }[];
  return rows[0]!.id;
}

const PROGRAM: LoyaltyProgramInput = {
  name: "Poin Setia",
  earnUnitAmount: "10000.00",
  earnPointsPerUnit: 1,
  minOrderAmount: "0.00",
  maxPointsPerOrder: null,
  expiryDays: null,
  notes: null
};

async function activeProgram(
  tenantId: string,
  overrides: Partial<LoyaltyProgramInput> = {},
  activateAt: Date = PROGRAM_START
): Promise<string> {
  return inTenant(tenantId, async (tx) => {
    const draft = await createLoyaltyProgram(tx, tenantId, ACTOR, {
      ...PROGRAM,
      ...overrides
    });
    const result = await activateLoyaltyProgram(
      tx,
      tenantId,
      ACTOR,
      draft.id,
      activateAt
    );
    if (result.kind !== "activated") throw new Error("activation failed");
    return result.program.id;
  });
}

type LedgerSummaryRow = {
  kind: string;
  points: number;
  account_seq: number;
  balance_after: number;
  expires_at: Date | null;
  program_id: string | null;
};

async function ledgerFor(
  tenantId: string,
  customerId: string
): Promise<LedgerSummaryRow[]> {
  const rows = (await getAdminSql()`
    SELECT l.kind, l.points::int AS points, l.account_seq::int AS account_seq,
      l.balance_after::int AS balance_after, l.expires_at, l.program_id
    FROM awcms_commerce_loyalty_ledger l
    JOIN awcms_commerce_loyalty_accounts a ON a.id = l.account_id
    WHERE l.tenant_id = ${tenantId} AND a.customer_id = ${customerId}
    ORDER BY l.account_seq
  `) as LedgerSummaryRow[];
  return rows;
}

async function balanceOf(
  tenantId: string,
  customerId: string
): Promise<number | null> {
  const account = await inTenant(tenantId, (tx) =>
    fetchLoyaltyAccountForCustomer(tx, tenantId, customerId)
  );
  return account ? account.balance : null;
}

let eventCounter = 0;
function fakeEvent(
  type: string,
  orderId: string,
  eventId?: string
): DomainEventForHandler {
  eventCounter += 1;
  return {
    id:
      eventId ??
      `00000000-0000-4000-8000-${String(eventCounter).padStart(12, "0")}`,
    eventType: type,
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

const PAID = "awcms.commerce.order.paid";
const CANCELLED = "awcms.commerce.order.cancelled";

async function runConsumer(
  consumer: typeof orderPaidLoyaltyEarnerConsumer,
  tenantId: string,
  event: DomainEventForHandler
): Promise<void> {
  await inTenant(tenantId, (tx) =>
    consumer.handler(tx, event, { tenantId, correlationId: "test" })
  );
}

suite("commerce loyalty ledger integration (Issue #289)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "LOYA");
    await seedTenant(TENANT_B, "LOYB");
    await enableLoyalty(TENANT_A);
  });

  // -------------------------------------------------------------------------
  describe("earn", () => {
    test("the feature defaults OFF for a tenant that never opened Features", async () => {
      const features = await inTenant(TENANT_B, (tx) =>
        fetchCommerceFeatures(tx, TENANT_B)
      );
      expect(features.loyalty).toBe(false);
    });

    test("an order-paid event earns floor(spend / unit) points, exactly once, however often it is replayed", async () => {
      const programId = await activeProgram(TENANT_A);
      const customerId = await seedCustomer(TENANT_A, "+6281200000001");
      const orderId = await seedOrder(TENANT_A, customerId, {
        subtotal: "125000.00",
        discount: "5000.00"
      });

      const event = fakeEvent(PAID, orderId);
      await runConsumer(orderPaidLoyaltyEarnerConsumer, TENANT_A, event);
      // The SAME event again (redelivery) and a DIFFERENT event for the same
      // order (a manual replay): both must be no-ops.
      await runConsumer(orderPaidLoyaltyEarnerConsumer, TENANT_A, event);
      await runConsumer(
        orderPaidLoyaltyEarnerConsumer,
        TENANT_A,
        fakeEvent(PAID, orderId)
      );

      const rows = await ledgerFor(TENANT_A, customerId);
      expect(rows).toHaveLength(1);
      // 125000 - 5000 = 120000 -> 12 whole units of 10000.
      expect(rows[0]).toMatchObject({
        kind: "earn",
        points: 12,
        account_seq: 1,
        balance_after: 12,
        program_id: programId
      });
      expect(await balanceOf(TENANT_A, customerId)).toBe(12);
    });

    test("calling the earn function directly twice reports already_earned and writes nothing", async () => {
      await activeProgram(TENANT_A);
      const customerId = await seedCustomer(TENANT_A, "+6281200000002");
      const orderId = await seedOrder(TENANT_A, customerId);

      const first = await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      const second = await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(first.kind).toBe("earned");
      expect(second.kind).toBe("already_earned");
      expect(await ledgerFor(TENANT_A, customerId)).toHaveLength(1);
    });

    test("concurrent earns of the same order still yield one row", async () => {
      await activeProgram(TENANT_A);
      const customerId = await seedCustomer(TENANT_A, "+6281200000003");
      const orderId = await seedOrder(TENANT_A, customerId);

      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          inTenant(TENANT_A, (tx) =>
            earnPointsForPaidOrder(tx, TENANT_A, orderId)
          )
        )
      );
      expect(results.filter((r) => r.kind === "earned")).toHaveLength(1);
      expect(await ledgerFor(TENANT_A, customerId)).toHaveLength(1);
    });

    test("the walk-in sentinel customer never earns", async () => {
      await activeProgram(TENANT_A);
      const walkIn = await seedCustomer(
        TENANT_A,
        POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
      );
      const orderId = await seedOrder(TENANT_A, walkIn);

      const outcome = await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(outcome).toEqual({ kind: "skipped", reason: "walk_in_customer" });
      expect(await balanceOf(TENANT_A, walkIn)).toBeNull();
    });

    test("a tenant with the feature off earns nothing — and enabling it later is not retroactive", async () => {
      await enableLoyalty(TENANT_A, false);
      await activeProgram(TENANT_A);
      const customerId = await seedCustomer(TENANT_A, "+6281200000004");
      const orderId = await seedOrder(TENANT_A, customerId);

      const off = await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(off).toEqual({ kind: "skipped", reason: "feature_disabled" });

      await enableLoyalty(TENANT_A, true);
      // The earlier order is NOT back-filled by the flag flipping; only a new
      // paid-event for it would, and none was published while it was off.
      expect(await balanceOf(TENANT_A, customerId)).toBeNull();
    });

    test("no program, a cancelled order, a blocked customer, below-minimum and a pre-program order all skip", async () => {
      const customerId = await seedCustomer(TENANT_A, "+6281200000005");
      const blocked = await seedCustomer(TENANT_A, "+6281200000006", "blocked");

      const noProgramOrder = await seedOrder(TENANT_A, customerId);
      expect(
        await inTenant(TENANT_A, (tx) =>
          earnPointsForPaidOrder(tx, TENANT_A, noProgramOrder)
        )
      ).toEqual({ kind: "skipped", reason: "no_effective_program" });

      await activeProgram(TENANT_A, { minOrderAmount: "50000.00" });

      const cancelled = await seedOrder(TENANT_A, customerId, {
        status: "cancelled"
      });
      expect(
        await inTenant(TENANT_A, (tx) =>
          earnPointsForPaidOrder(tx, TENANT_A, cancelled)
        )
      ).toEqual({ kind: "skipped", reason: "order_not_earnable" });

      const blockedOrder = await seedOrder(TENANT_A, blocked);
      expect(
        await inTenant(TENANT_A, (tx) =>
          earnPointsForPaidOrder(tx, TENANT_A, blockedOrder)
        )
      ).toEqual({ kind: "skipped", reason: "customer_unavailable" });

      const small = await seedOrder(TENANT_A, customerId, {
        subtotal: "40000.00"
      });
      expect(
        await inTenant(TENANT_A, (tx) =>
          earnPointsForPaidOrder(tx, TENANT_A, small)
        )
      ).toEqual({ kind: "skipped", reason: "zero_points" });

      const beforeProgram = await seedOrder(TENANT_A, customerId, {
        paidAt: new Date("2026-08-01T00:00:00.000Z")
      });
      expect(
        await inTenant(TENANT_A, (tx) =>
          earnPointsForPaidOrder(tx, TENANT_A, beforeProgram)
        )
      ).toEqual({ kind: "skipped", reason: "no_effective_program" });

      expect(await balanceOf(TENANT_A, customerId)).toBeNull();
    });

    test("an order paid under version 1 earns under version 1 even after version 2 is activated", async () => {
      const v1 = await activeProgram(TENANT_A, { earnPointsPerUnit: 1 });
      const customerId = await seedCustomer(TENANT_A, "+6281200000007");
      const orderUnderV1 = await seedOrder(TENANT_A, customerId, {
        paidAt: new Date("2026-09-10T00:00:00.000Z")
      });

      const v2 = await activeProgram(
        TENANT_A,
        { earnPointsPerUnit: 5 },
        new Date("2026-09-20T00:00:00.000Z")
      );
      const orderUnderV2 = await seedOrder(TENANT_A, customerId, {
        paidAt: new Date("2026-09-25T00:00:00.000Z")
      });

      // The v1 order's event is processed AFTER v2 went live.
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderUnderV1)
      );
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderUnderV2)
      );

      const rows = await ledgerFor(TENANT_A, customerId);
      expect(rows.map((r) => [r.points, r.program_id])).toEqual([
        [10, v1],
        [50, v2]
      ]);

      const programs = await inTenant(TENANT_A, (tx) =>
        listLoyaltyPrograms(tx, TENANT_A)
      );
      const retired = programs.find((p) => p.id === v1)!;
      const active = programs.find((p) => p.id === v2)!;
      expect(retired.status).toBe("retired");
      expect(retired.effectiveTo).toBe(active.effectiveFrom!);
      expect(active.effectiveTo).toBeNull();
    });

    test("points are exact integers for awkward money (cents, remainders)", async () => {
      await activeProgram(TENANT_A, {
        earnUnitAmount: "0.30",
        earnPointsPerUnit: 3
      });
      const customerId = await seedCustomer(TENANT_A, "+6281200000008");
      const orderId = await seedOrder(TENANT_A, customerId, {
        subtotal: "1.00",
        discount: "0.10"
      });
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      // 0.90 / 0.30 = exactly 3 units (a float 0.9/0.3 is 3.0000000000000004).
      expect((await ledgerFor(TENANT_A, customerId))[0]!.points).toBe(9);
    });

    test("the earn also works as the awcms_worker role (the dispatcher's real identity)", async () => {
      if (!workerRoleActivated) return;
      await activeProgram(TENANT_A, { expiryDays: 30 });
      const customerId = await seedCustomer(TENANT_A, "+6281200000009");
      const orderId = await seedOrder(TENANT_A, customerId);

      const outcome = await withTenantOrThrow(
        getWorkerRoleSql(),
        TENANT_A,
        (tx) => earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(outcome.kind).toBe("earned");

      const asOf = new Date(PAID_AT.getTime() + 31 * DAY);
      const expired = await expireDueLoyaltyPointsForTenant(
        getWorkerRoleSql(),
        TENANT_A,
        asOf
      );
      expect(expired.entriesWritten).toBe(1);

      // ...and the worker still cannot rewrite history.
      await assertRejected(
        withTenantOrThrow(
          getWorkerRoleSql(),
          TENANT_A,
          (tx) => tx`
          UPDATE awcms_commerce_loyalty_ledger SET points = 1
          WHERE tenant_id = ${TENANT_A}
        `
        ),
        "statement 1"
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("redeem", () => {
    async function fundedCustomer(points: number, phone: string) {
      const customerId = await seedCustomer(TENANT_A, phone);
      await inTenant(TENANT_A, (tx) =>
        adjustPoints(
          tx,
          TENANT_A,
          ACTOR,
          {
            customerId,
            points,
            reason: "seed",
            idempotencyKey: `seed-${phone}`
          },
          PAID_AT
        )
      );
      return customerId;
    }

    test("concurrent redemptions serialise on the account lock and can never overdraw", async () => {
      const customerId = await fundedCustomer(100, "+6281200001001");

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          inTenant(TENANT_A, (tx) =>
            redeemPoints(
              tx,
              TENANT_A,
              ACTOR,
              {
                customerId,
                points: 30,
                reason: null,
                idempotencyKey: `race-${index}`
              },
              PAID_AT
            )
          )
        )
      );

      expect(results.filter((r) => r.kind === "redeemed")).toHaveLength(3);
      expect(results.filter((r) => r.kind === "insufficient")).toHaveLength(5);
      expect(await balanceOf(TENANT_A, customerId)).toBe(10);

      const rows = await ledgerFor(TENANT_A, customerId);
      // seed + three redemptions, contiguous sequence, running balance exact.
      expect(rows.map((r) => r.account_seq)).toEqual([1, 2, 3, 4]);
      expect(rows.map((r) => r.balance_after)).toEqual([100, 70, 40, 10]);
      expect(rows.reduce((sum, r) => sum + r.points, 0)).toBe(10);
    });

    test("a same-key retry is a replay; same key with different points is a conflict", async () => {
      const customerId = await fundedCustomer(100, "+6281200001002");
      const input = {
        customerId,
        points: 40,
        reason: null,
        idempotencyKey: "retry-1"
      };

      const first = await inTenant(TENANT_A, (tx) =>
        redeemPoints(tx, TENANT_A, ACTOR, input, PAID_AT)
      );
      const second = await inTenant(TENANT_A, (tx) =>
        redeemPoints(tx, TENANT_A, ACTOR, input, PAID_AT)
      );
      expect(first.kind).toBe("redeemed");
      expect(second.kind).toBe("replayed");
      expect(await balanceOf(TENANT_A, customerId)).toBe(60);

      const conflict = await assertRejected(
        inTenant(TENANT_A, (tx) =>
          redeemPoints(tx, TENANT_A, ACTOR, { ...input, points: 41 }, PAID_AT)
        ),
        "the same Idempotency-Key with different points"
      );
      expect(conflict).toBeInstanceOf(LoyaltyIdempotencyConflictError);
      expect(await balanceOf(TENANT_A, customerId)).toBe(60);
    });

    test("two simultaneous requests with the SAME key redeem once", async () => {
      const customerId = await fundedCustomer(100, "+6281200001003");
      const input = {
        customerId,
        points: 40,
        reason: null,
        idempotencyKey: "same-key"
      };
      const settled = await Promise.allSettled([
        inTenant(TENANT_A, (tx) =>
          redeemPoints(tx, TENANT_A, ACTOR, input, PAID_AT)
        ),
        inTenant(TENANT_A, (tx) =>
          redeemPoints(tx, TENANT_A, ACTOR, input, PAID_AT)
        )
      ]);
      // One redeems; the other either replays or loses the idempotency race
      // (which the HTTP layer turns into the stored replay). Never two debits.
      expect(settled.some((r) => r.status === "fulfilled")).toBe(true);
      expect(await balanceOf(TENANT_A, customerId)).toBe(60);
      const redeems = (await ledgerFor(TENANT_A, customerId)).filter(
        (r) => r.kind === "redeem"
      );
      expect(redeems).toHaveLength(1);
    });

    test("an insufficient redemption writes nothing and a customer with no account is simply insufficient", async () => {
      const customerId = await fundedCustomer(10, "+6281200001004");
      const outcome = await inTenant(TENANT_A, (tx) =>
        redeemPoints(
          tx,
          TENANT_A,
          ACTOR,
          {
            customerId,
            points: 11,
            reason: null,
            idempotencyKey: "too-much"
          },
          PAID_AT
        )
      );
      expect(outcome).toEqual({
        kind: "insufficient",
        balance: 10,
        requested: 11
      });
      expect(await ledgerFor(TENANT_A, customerId)).toHaveLength(1);

      const stranger = await seedCustomer(TENANT_A, "+6281200001005");
      expect(
        await inTenant(TENANT_A, (tx) =>
          redeemPoints(
            tx,
            TENANT_A,
            ACTOR,
            {
              customerId: stranger,
              points: 1,
              reason: null,
              idempotencyKey: "none"
            },
            PAID_AT
          )
        )
      ).toEqual({ kind: "insufficient", balance: 0, requested: 1 });
    });

    test("an unknown or other-tenant customer id is customer_not_found", async () => {
      const otherTenantCustomer = await seedCustomer(
        TENANT_B,
        "+6281200001006"
      );
      for (const customerId of [
        otherTenantCustomer,
        "dddddddd-0289-4000-8000-00000000dead"
      ]) {
        expect(
          await inTenant(TENANT_A, (tx) =>
            redeemPoints(
              tx,
              TENANT_A,
              ACTOR,
              { customerId, points: 1, reason: null, idempotencyKey: "x" },
              PAID_AT
            )
          )
        ).toEqual({ kind: "customer_not_found" });
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("adjust", () => {
    test("a negative adjustment cannot take the balance below zero; a positive one opens the account; both are idempotent", async () => {
      const customerId = await seedCustomer(TENANT_A, "+6281200002001");

      const refused = await inTenant(TENANT_A, (tx) =>
        adjustPoints(
          tx,
          TENANT_A,
          ACTOR,
          { customerId, points: -5, reason: "oops", idempotencyKey: "a1" },
          PAID_AT
        )
      );
      expect(refused.kind).toBe("would_go_negative");

      const input = {
        customerId,
        points: 20,
        reason: "goodwill",
        idempotencyKey: "a2"
      };
      const first = await inTenant(TENANT_A, (tx) =>
        adjustPoints(tx, TENANT_A, ACTOR, input, PAID_AT)
      );
      const replay = await inTenant(TENANT_A, (tx) =>
        adjustPoints(tx, TENANT_A, ACTOR, input, PAID_AT)
      );
      expect(first.kind).toBe("adjusted");
      expect(replay.kind).toBe("replayed");
      expect(await balanceOf(TENANT_A, customerId)).toBe(20);

      const rows = (await getAdminSql()`
        SELECT actor_tenant_user_id, reason, source_type
        FROM awcms_commerce_loyalty_ledger WHERE tenant_id = ${TENANT_A}
      `) as {
        actor_tenant_user_id: string;
        reason: string;
        source_type: string;
      }[];
      expect(rows).toEqual([
        {
          actor_tenant_user_id: ACTOR,
          reason: "goodwill",
          source_type: "manual"
        }
      ]);
    });

    test("the database itself refuses an adjustment with no reason or no actor", async () => {
      const customerId = await seedCustomer(TENANT_A, "+6281200002002");
      const account = await inTenant(TENANT_A, (tx) =>
        findOrCreateAccountLocked(tx, TENANT_A, customerId)
      );
      await expect(
        getAdminSql()`
          INSERT INTO awcms_commerce_loyalty_ledger
            (tenant_id, account_id, account_seq, kind, points, balance_after,
             source_type, idempotency_key, actor_tenant_user_id, reason)
          VALUES (${TENANT_A}, ${account.id}, 1, 'adjustment', 5, 5,
                  'manual', 'no-reason', ${ACTOR}, '   ')
        `,
        "statement 2"
      );
      await assertRejected(
        getAdminSql()`
          INSERT INTO awcms_commerce_loyalty_ledger
            (tenant_id, account_id, account_seq, kind, points, balance_after,
             source_type, idempotency_key, reason)
          VALUES (${TENANT_A}, ${account.id}, 1, 'adjustment', 5, 5,
                  'manual', 'no-actor', 'because')
        `,
        "statement 3"
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("expiry", () => {
    test("expiry is idempotent: a lapsed lot expires once, a second run writes nothing", async () => {
      await activeProgram(TENANT_A, { expiryDays: 30 });
      const customerId = await seedCustomer(TENANT_A, "+6281200003001");
      const orderId = await seedOrder(TENANT_A, customerId);
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );

      const beforeDue = new Date(PAID_AT.getTime() + 29 * DAY);
      const early = await expireDueLoyaltyPointsForTenant(
        getRuntimeSql(),
        TENANT_A,
        beforeDue
      );
      expect(early.entriesWritten).toBe(0);

      const due = new Date(PAID_AT.getTime() + 31 * DAY);
      const first = await expireDueLoyaltyPointsForTenant(
        getRuntimeSql(),
        TENANT_A,
        due
      );
      const second = await expireDueLoyaltyPointsForTenant(
        getRuntimeSql(),
        TENANT_A,
        due
      );
      expect(first).toMatchObject({ accountsProcessed: 1, entriesWritten: 1 });
      expect(second).toMatchObject({ accountsProcessed: 0, entriesWritten: 0 });

      const rows = await ledgerFor(TENANT_A, customerId);
      expect(rows.map((r) => [r.kind, r.points, r.balance_after])).toEqual([
        ["earn", 10, 10],
        ["expire", -10, 0]
      ]);
      expect(await balanceOf(TENANT_A, customerId)).toBe(0);
    });

    test("only what is still unspent expires; a fully spent lot gets a zero marker, once", async () => {
      await activeProgram(TENANT_A, { expiryDays: 30 });
      const customerId = await seedCustomer(TENANT_A, "+6281200003002");
      const o1 = await seedOrder(TENANT_A, customerId); // 10 points
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, o1)
      );
      const o2 = await seedOrder(TENANT_A, customerId, {
        subtotal: "50000.00",
        paidAt: new Date(PAID_AT.getTime() + 1 * DAY)
      }); // 5 points
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, o2)
      );

      // Spend 12: 10 from the earlier-expiring lot, 2 from the second.
      await inTenant(TENANT_A, (tx) =>
        redeemPoints(
          tx,
          TENANT_A,
          ACTOR,
          {
            customerId,
            points: 12,
            reason: null,
            idempotencyKey: "spend-12"
          },
          new Date(PAID_AT.getTime() + 2 * DAY)
        )
      );

      const due = new Date(PAID_AT.getTime() + 40 * DAY);
      const run = await expireDueLoyaltyPointsForTenant(
        getRuntimeSql(),
        TENANT_A,
        due
      );
      expect(run.entriesWritten).toBe(2);
      expect(
        (await expireDueLoyaltyPointsForTenant(getRuntimeSql(), TENANT_A, due))
          .entriesWritten
      ).toBe(0);

      const expireRows = (await ledgerFor(TENANT_A, customerId)).filter(
        (r) => r.kind === "expire"
      );
      // Lot 1 (10) was fully spent -> a 0 marker; lot 2 had 3 left -> -3.
      expect(expireRows.map((r) => r.points).sort()).toEqual([-3, 0]);
      expect(await balanceOf(TENANT_A, customerId)).toBe(0);
    });

    test("a redemption lazily expires due lots first, so lapsed points can never be spent", async () => {
      await activeProgram(TENANT_A, { expiryDays: 30 });
      const customerId = await seedCustomer(TENANT_A, "+6281200003003");
      const orderId = await seedOrder(TENANT_A, customerId);
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );

      // Day 40; the expiry JOB has not run.
      const outcome = await inTenant(TENANT_A, (tx) =>
        redeemPoints(
          tx,
          TENANT_A,
          ACTOR,
          {
            customerId,
            points: 1,
            reason: null,
            idempotencyKey: "late"
          },
          new Date(PAID_AT.getTime() + 40 * DAY)
        )
      );
      expect(outcome).toEqual({
        kind: "insufficient",
        balance: 0,
        requested: 1
      });
      // The lazy expiry itself committed.
      expect(
        (await ledgerFor(TENANT_A, customerId)).map((r) => r.kind)
      ).toEqual(["earn", "expire"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("reversal", () => {
    test("a cancelled order's earn is compensated — never deleted — and the reversal is idempotent", async () => {
      await activeProgram(TENANT_A);
      const customerId = await seedCustomer(TENANT_A, "+6281200004001");
      const orderId = await seedOrder(TENANT_A, customerId);
      await runConsumer(
        orderPaidLoyaltyEarnerConsumer,
        TENANT_A,
        fakeEvent(PAID, orderId)
      );

      const cancel = fakeEvent(CANCELLED, orderId);
      await runConsumer(
        orderCancelledLoyaltyReverserConsumer,
        TENANT_A,
        cancel
      );
      await runConsumer(
        orderCancelledLoyaltyReverserConsumer,
        TENANT_A,
        cancel
      );
      await runConsumer(
        orderCancelledLoyaltyReverserConsumer,
        TENANT_A,
        fakeEvent(CANCELLED, orderId)
      );

      const rows = await ledgerFor(TENANT_A, customerId);
      expect(rows.map((r) => [r.kind, r.points, r.balance_after])).toEqual([
        ["earn", 10, 10],
        ["reversal", -10, 0]
      ]);
      expect(await balanceOf(TENANT_A, customerId)).toBe(0);
    });

    test("reversing an order that never earned writes nothing", async () => {
      const customerId = await seedCustomer(TENANT_A, "+6281200004002");
      const orderId = await seedOrder(TENANT_A, customerId);
      expect(
        await inTenant(TENANT_A, (tx) =>
          reverseEarnForCancelledOrder(tx, TENANT_A, orderId, PAID_AT)
        )
      ).toEqual({ kind: "no_earn" });
    });

    test("points already spent are clawed back, so the balance can go negative and blocks redemption", async () => {
      await activeProgram(TENANT_A);
      const customerId = await seedCustomer(TENANT_A, "+6281200004003");
      const orderId = await seedOrder(TENANT_A, customerId);
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      await inTenant(TENANT_A, (tx) =>
        redeemPoints(
          tx,
          TENANT_A,
          ACTOR,
          {
            customerId,
            points: 8,
            reason: null,
            idempotencyKey: "spent"
          },
          PAID_AT
        )
      );

      await inTenant(TENANT_A, (tx) =>
        reverseEarnForCancelledOrder(tx, TENANT_A, orderId, PAID_AT)
      );
      expect(await balanceOf(TENANT_A, customerId)).toBe(-8);

      const blocked = await inTenant(TENANT_A, (tx) =>
        redeemPoints(
          tx,
          TENANT_A,
          ACTOR,
          { customerId, points: 1, reason: null, idempotencyKey: "after" },
          PAID_AT
        )
      );
      expect(blocked.kind).toBe("insufficient");
    });

    test("points that already lapsed are not deducted a second time", async () => {
      await activeProgram(TENANT_A, { expiryDays: 30 });
      const customerId = await seedCustomer(TENANT_A, "+6281200004004");
      const orderId = await seedOrder(TENANT_A, customerId);
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      // 4 points spent, then the rest (6) lapse.
      await inTenant(TENANT_A, (tx) =>
        redeemPoints(
          tx,
          TENANT_A,
          ACTOR,
          { customerId, points: 4, reason: null, idempotencyKey: "four" },
          new Date(PAID_AT.getTime() + DAY)
        )
      );
      const afterExpiry = new Date(PAID_AT.getTime() + 40 * DAY);
      await expireDueLoyaltyPointsForTenant(
        getRuntimeSql(),
        TENANT_A,
        afterExpiry
      );
      expect(await balanceOf(TENANT_A, customerId)).toBe(0);

      // The order is cancelled after the lot expired: only the 4 that were
      // spent are clawed back (10 earned - 6 already gone).
      const outcome = await inTenant(TENANT_A, (tx) =>
        reverseEarnForCancelledOrder(tx, TENANT_A, orderId, afterExpiry)
      );
      expect(outcome.kind).toBe("reversed");
      expect(await balanceOf(TENANT_A, customerId)).toBe(-4);
    });
  });

  // -------------------------------------------------------------------------
  describe("program lifecycle", () => {
    test("versions are numbered per tenant; only a draft is editable; activation closes the open version", async () => {
      const result = await inTenant(TENANT_A, async (tx) => {
        const a = await createLoyaltyProgram(tx, TENANT_A, ACTOR, PROGRAM);
        const b = await createLoyaltyProgram(tx, TENANT_A, ACTOR, {
          ...PROGRAM,
          name: "Poin v2"
        });
        const edited = await updateLoyaltyProgram(tx, TENANT_A, ACTOR, a.id, {
          earnPointsPerUnit: 2
        });
        const activatedA = await activateLoyaltyProgram(
          tx,
          TENANT_A,
          ACTOR,
          a.id,
          PROGRAM_START
        );
        const editActive = await updateLoyaltyProgram(
          tx,
          TENANT_A,
          ACTOR,
          a.id,
          {
            earnPointsPerUnit: 9
          }
        );
        const activateTwice = await activateLoyaltyProgram(
          tx,
          TENANT_A,
          ACTOR,
          a.id,
          PROGRAM_START
        );
        const activatedB = await activateLoyaltyProgram(
          tx,
          TENANT_A,
          ACTOR,
          b.id,
          new Date(PROGRAM_START.getTime() + DAY)
        );
        const retireClosed = await retireLoyaltyProgram(
          tx,
          TENANT_A,
          ACTOR,
          a.id,
          PROGRAM_START
        );
        const retireOpen = await retireLoyaltyProgram(
          tx,
          TENANT_A,
          ACTOR,
          b.id,
          new Date(PROGRAM_START.getTime() + 2 * DAY)
        );
        return {
          versions: [a.version, b.version],
          edited,
          activatedA,
          editActive,
          activateTwice,
          activatedB,
          retireClosed,
          retireOpen
        };
      });

      expect(result.versions).toEqual([1, 2]);
      expect(result.edited.kind).toBe("updated");
      expect(result.activatedA.kind).toBe("activated");
      expect(result.editActive.kind).toBe("not_draft");
      expect(result.activateTwice.kind).toBe("not_draft");
      expect(result.activatedB).toMatchObject({
        kind: "activated",
        closedVersion: 1
      });
      expect(result.retireClosed.kind).toBe("not_active");
      expect(result.retireOpen.kind).toBe("retired");

      // After retirement nothing is in force.
      expect(
        await inTenant(TENANT_A, (tx) =>
          fetchEffectiveProgramAt(
            tx,
            TENANT_A,
            new Date(PROGRAM_START.getTime() + 10 * DAY)
          )
        )
      ).toBeNull();
    });

    test("two simultaneous activations leave exactly one open version", async () => {
      const [a, b] = await inTenant(TENANT_A, async (tx) => [
        await createLoyaltyProgram(tx, TENANT_A, ACTOR, PROGRAM),
        await createLoyaltyProgram(tx, TENANT_A, ACTOR, PROGRAM)
      ]);
      await Promise.all([
        inTenant(TENANT_A, (tx) =>
          activateLoyaltyProgram(tx, TENANT_A, ACTOR, a!.id, PROGRAM_START)
        ),
        inTenant(TENANT_A, (tx) =>
          activateLoyaltyProgram(tx, TENANT_A, ACTOR, b!.id, PROGRAM_START)
        )
      ]);
      const open = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_loyalty_programs
        WHERE tenant_id = ${TENANT_A} AND status = 'active' AND effective_to IS NULL
      `) as { n: number }[];
      expect(open[0]!.n).toBe(1);
    });

    test("two simultaneous creates get distinct version numbers", async () => {
      const created = await Promise.all(
        [1, 2, 3].map(() =>
          inTenant(TENANT_A, (tx) =>
            createLoyaltyProgram(tx, TENANT_A, ACTOR, PROGRAM)
          )
        )
      );
      expect(created.map((p) => p.version).sort()).toEqual([1, 2, 3]);
    });
  });

  // -------------------------------------------------------------------------
  describe("append-only and constraints, below the application", () => {
    async function oneEntry(): Promise<{ customerId: string }> {
      await activeProgram(TENANT_A);
      const customerId = await seedCustomer(TENANT_A, "+6281200005001");
      const orderId = await seedOrder(TENANT_A, customerId);
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      return { customerId };
    }

    test("the request-time role can neither UPDATE nor DELETE a ledger row", async () => {
      await oneEntry();
      await assertRejected(
        inTenant(
          TENANT_A,
          (tx) => tx`
          UPDATE awcms_commerce_loyalty_ledger SET points = 999
          WHERE tenant_id = ${TENANT_A}
        `
        ),
        "statement 4"
      );
      await assertRejected(
        inTenant(
          TENANT_A,
          (tx) => tx`
          DELETE FROM awcms_commerce_loyalty_ledger WHERE tenant_id = ${TENANT_A}
        `
        ),
        "statement 5"
      );
    });

    test("even a superuser UPDATE is rejected by the trigger", async () => {
      await oneEntry();
      const error = await assertRejected(
        getAdminSql()`
          UPDATE awcms_commerce_loyalty_ledger SET points = 999
          WHERE tenant_id = ${TENANT_A}
        `,
        "a superuser UPDATE of the ledger"
      );
      expect(String(error.message)).toMatch(/append-only/);
    });

    test("sign, source and uniqueness CHECKs hold", async () => {
      const { customerId } = await oneEntry();
      const account = (await getAdminSql()`
        SELECT id FROM awcms_commerce_loyalty_accounts
        WHERE tenant_id = ${TENANT_A} AND customer_id = ${customerId}
      `) as { id: string }[];
      const accountId = account[0]!.id;

      const insert = (
        kind: string,
        points: number,
        key: string,
        seq = 2
      ) => getAdminSql()`
        INSERT INTO awcms_commerce_loyalty_ledger
          (tenant_id, account_id, account_seq, kind, points, balance_after,
           source_type, idempotency_key)
        VALUES (${TENANT_A}, ${accountId}, ${seq}, ${kind}, ${points}, 0,
                'manual', ${key})
      `;
      // A redeem must be negative, an earn positive, a float cannot exist.
      await assertRejected(insert("redeem", 5, "k1"), "a positive redeem");
      await assertRejected(insert("earn", -5, "k2"), "a negative earn");
      // A reversal needs a target.
      await assertRejected(
        insert("reversal", -5, "k3"),
        "a reversal with no target"
      );
      // The per-tenant idempotency key is unique.
      await assertRejected(
        getAdminSql()`
          INSERT INTO awcms_commerce_loyalty_ledger
            (tenant_id, account_id, account_seq, kind, points, balance_after,
             source_type, source_id, idempotency_key)
          SELECT tenant_id, account_id, 99, kind, points, 0, source_type, source_id,
                 idempotency_key
          FROM awcms_commerce_loyalty_ledger WHERE tenant_id = ${TENANT_A}
        `,
        "statement 6"
      );
      // The per-account sequence is unique.
      await assertRejected(
        getAdminSql()`
          INSERT INTO awcms_commerce_loyalty_ledger
            (tenant_id, account_id, account_seq, kind, points, balance_after,
             source_type, idempotency_key, actor_tenant_user_id, reason)
          VALUES (${TENANT_A}, ${accountId}, 1, 'adjustment', 1, 0,
                  'manual', 'dup-seq', ${ACTOR}, 'r')
        `,
        "statement 7"
      );
    });

    test("one reversal per original entry, enforced by the database independently of the key", async () => {
      await activeProgram(TENANT_A);
      const customerId = await seedCustomer(TENANT_A, "+6281200005002");
      const orderId = await seedOrder(TENANT_A, customerId);
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      await inTenant(TENANT_A, (tx) =>
        reverseEarnForCancelledOrder(tx, TENANT_A, orderId, PAID_AT)
      );
      const rows = (await getAdminSql()`
        SELECT id, account_id FROM awcms_commerce_loyalty_ledger
        WHERE tenant_id = ${TENANT_A} AND kind = 'earn'
      `) as { id: string; account_id: string }[];
      await assertRejected(
        getAdminSql()`
          INSERT INTO awcms_commerce_loyalty_ledger
            (tenant_id, account_id, account_seq, kind, points, balance_after,
             source_type, source_id, idempotency_key, reverses_entry_id)
          VALUES (${TENANT_A}, ${rows[0]!.account_id}, 50, 'reversal', -1, 0,
                  'order', ${orderId}, 'second-reversal', ${rows[0]!.id})
        `,
        "statement 8"
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("tenant isolation (RLS) and tenant-safe references", () => {
    test("tenant B sees none of tenant A's programs, accounts or ledger rows, even by id", async () => {
      await activeProgram(TENANT_A);
      const customerId = await seedCustomer(TENANT_A, "+6281200006001");
      const orderId = await seedOrder(TENANT_A, customerId);
      await inTenant(TENANT_A, (tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      const account = await inTenant(TENANT_A, (tx) =>
        fetchLoyaltyAccountForCustomer(tx, TENANT_A, customerId)
      );

      const seenByB = await inTenant(TENANT_B, async (tx) => ({
        programs: await listLoyaltyPrograms(tx, TENANT_B),
        accounts: await listLoyaltyAccounts(tx, TENANT_B, {}, null),
        direct: await tx`
          SELECT count(*)::int AS n FROM awcms_commerce_loyalty_ledger
          WHERE account_id = ${account!.id}
        `,
        accountById: await fetchLoyaltyAccountForCustomer(
          tx,
          TENANT_B,
          customerId
        ),
        ledger: await listLedgerForAccount(tx, TENANT_B, account!.id, null)
      }));
      expect(seenByB.programs).toEqual([]);
      expect(seenByB.accounts.items).toEqual([]);
      expect((seenByB.direct as { n: number }[])[0]!.n).toBe(0);
      expect(seenByB.accountById).toBeNull();
      expect(seenByB.ledger.items).toEqual([]);
    });

    test("tenant B cannot append to tenant A's account — RLS and the composite foreign key both refuse", async () => {
      const customerId = await seedCustomer(TENANT_A, "+6281200006002");
      const accountA = await inTenant(TENANT_A, (tx) =>
        findOrCreateAccountLocked(tx, TENANT_A, customerId)
      );

      await assertRejected(
        inTenant(TENANT_B, (tx) =>
          appendLedgerEntry(
            tx,
            TENANT_B,
            { ...accountA },
            {
              kind: "adjustment",
              points: 5,
              sourceType: "manual",
              idempotencyKey: "cross-tenant",
              actorTenantUserId: ACTOR,
              reason: "attack"
            }
          )
        ),
        "statement 9"
      );

      // Nothing leaked into either tenant's ledger.
      const count = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_loyalty_ledger
      `) as { n: number }[];
      expect(count[0]!.n).toBe(0);
    });

    test("an account cannot reference another tenant's customer (composite FK)", async () => {
      const customerOfA = await seedCustomer(TENANT_A, "+6281200006003");
      await assertRejected(
        getAdminSql()`
          INSERT INTO awcms_commerce_loyalty_accounts (tenant_id, customer_id)
          VALUES (${TENANT_B}, ${customerOfA})
        `,
        "statement 10"
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("customer-facing read path is owner-scoped (BOLA)", () => {
    test("each customer's history contains only their own rows, whatever the other holds", async () => {
      await activeProgram(TENANT_A);
      const alice = await seedCustomer(TENANT_A, "+6281200007001");
      const bob = await seedCustomer(TENANT_A, "+6281200007002");
      const aliceOrder = await seedOrder(TENANT_A, alice, {
        subtotal: "30000.00"
      });
      const bobOrder = await seedOrder(TENANT_A, bob, { subtotal: "70000.00" });
      for (const orderId of [aliceOrder, bobOrder]) {
        await inTenant(TENANT_A, (tx) =>
          earnPointsForPaidOrder(tx, TENANT_A, orderId)
        );
      }

      // The storefront route calls `fetchCustomerLoyaltyOverview` with the
      // customer id of the VERIFIED session and nothing else — there is no
      // other identifier it accepts.
      async function history(customerId: string) {
        const overview = await inTenant(TENANT_A, (tx) =>
          fetchCustomerLoyaltyOverview(
            tx,
            TENANT_A,
            customerId,
            { cursor: null, limit: 20 },
            PAID_AT
          )
        );
        return { balance: overview.balance, items: overview.history.items };
      }

      const a = await history(alice);
      const b = await history(bob);
      expect(a.balance).toBe(3);
      expect(b.balance).toBe(7);
      expect(a.items.map((i) => i.points)).toEqual([3]);
      expect(b.items.map((i) => i.points)).toEqual([7]);
      expect(a.items.map((i) => i.id)).not.toContain(b.items[0]!.id);
    });

    test("the customer projection never carries the staff actor, the free-text reason or a source id", async () => {
      const customerId = await seedCustomer(TENANT_A, "+6281200007003");
      await inTenant(TENANT_A, (tx) =>
        adjustPoints(
          tx,
          TENANT_A,
          ACTOR,
          {
            customerId,
            points: 5,
            reason: "internal note: fraud suspected",
            idempotencyKey: "secret"
          },
          PAID_AT
        )
      );
      const item = await inTenant(TENANT_A, async (tx) => {
        const overview = await fetchCustomerLoyaltyOverview(
          tx,
          TENANT_A,
          customerId,
          { cursor: null, limit: 20 },
          PAID_AT
        );
        return overview.history.items[0]!;
      });
      expect(Object.keys(item).sort()).toEqual([
        "balanceAfter",
        "createdAt",
        "expiresAt",
        "id",
        "kind",
        "points"
      ]);
      expect(JSON.stringify(item)).not.toContain("fraud");
      expect(JSON.stringify(item)).not.toContain(ACTOR);
    });

    test("history pages are keyset-paginated with no row skipped or repeated", async () => {
      const customerId = await seedCustomer(TENANT_A, "+6281200007004");
      for (let i = 1; i <= 7; i += 1) {
        await inTenant(TENANT_A, (tx) =>
          adjustPoints(
            tx,
            TENANT_A,
            ACTOR,
            {
              customerId,
              points: i,
              reason: "step",
              idempotencyKey: `page-${i}`
            },
            PAID_AT
          )
        );
      }
      const seen: number[] = [];
      let cursor: { createdAt: string; id: string } | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await inTenant(TENANT_A, async (tx) => {
          const account = await fetchLoyaltyAccountForCustomer(
            tx,
            TENANT_A,
            customerId
          );
          return listLedgerForAccount(tx, TENANT_A, account!.id, cursor, 3);
        });
        seen.push(...page.items.map((i) => i.points));
        if (!page.nextCursor) break;
        const [createdAt, id] = Buffer.from(page.nextCursor, "base64url")
          .toString("utf8")
          .split("|");
        cursor = { createdAt: createdAt!, id: id! };
      }
      expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1]);
    });
  });

  // -------------------------------------------------------------------------
  describe("reconcile", () => {
    async function twoEntries(): Promise<string> {
      const customerId = await seedCustomer(TENANT_A, "+6281200008001");
      for (const [i, points] of [10, -3].entries()) {
        await inTenant(TENANT_A, async (tx) => {
          if (points > 0) {
            await adjustPoints(
              tx,
              TENANT_A,
              ACTOR,
              {
                customerId,
                points,
                reason: "seed",
                idempotencyKey: `rec-${i}`
              },
              PAID_AT
            );
          } else {
            await redeemPoints(
              tx,
              TENANT_A,
              ACTOR,
              {
                customerId,
                points: -points,
                reason: null,
                idempotencyKey: `rec-${i}`
              },
              PAID_AT
            );
          }
        });
      }
      return customerId;
    }

    test("a clean ledger reconciles clean", async () => {
      await twoEntries();
      const report = await inTenant(TENANT_A, (tx) =>
        reconcileLoyaltyForTenant(tx, TENANT_A, { repair: false })
      );
      expect(report).toEqual({
        accountsChecked: 1,
        drifted: [],
        ledgerBreaks: [],
        repaired: 0
      });
    });

    test("drift is detected read-only, then repaired by rewriting only the projection", async () => {
      const customerId = await twoEntries();
      // Corrupt the PROJECTION (as a bug or a manual SQL edit would).
      await getAdminSql()`
        UPDATE awcms_commerce_loyalty_accounts
        SET balance = balance + 5, version = version + 1
        WHERE tenant_id = ${TENANT_A}
      `;
      const ledgerBefore = await ledgerFor(TENANT_A, customerId);

      const detect = await inTenant(TENANT_A, (tx) =>
        reconcileLoyaltyForTenant(tx, TENANT_A, { repair: false })
      );
      expect(detect.drifted).toHaveLength(1);
      expect(detect.drifted[0]).toMatchObject({
        customerId,
        projectedBalance: 12,
        ledgerBalance: 7,
        projectedVersion: 3,
        ledgerVersion: 2
      });
      expect(detect.repaired).toBe(0);
      expect(await balanceOf(TENANT_A, customerId)).toBe(12);

      const repair = await inTenant(TENANT_A, (tx) =>
        reconcileLoyaltyForTenant(tx, TENANT_A, {
          repair: true,
          actorTenantUserId: ACTOR
        })
      );
      expect(repair.repaired).toBe(1);
      expect(await balanceOf(TENANT_A, customerId)).toBe(7);
      expect(await ledgerFor(TENANT_A, customerId)).toEqual(ledgerBefore);

      const after = await inTenant(TENANT_A, (tx) =>
        reconcileLoyaltyForTenant(tx, TENANT_A, { repair: true })
      );
      expect(after.drifted).toEqual([]);
      expect(after.repaired).toBe(0);

      const audits = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A}
          AND action = 'commerce.loyalty.projection_repaired'
      `) as { n: number }[];
      expect(audits[0]!.n).toBe(1);
    });

    test("a ledger row whose running balance_after is wrong is reported, and never auto-repaired", async () => {
      await twoEntries();
      const admin = getAdminSql();
      await admin`ALTER TABLE awcms_commerce_loyalty_ledger DISABLE TRIGGER awcms_commerce_loyalty_ledger_no_update`;
      try {
        await admin`
          UPDATE awcms_commerce_loyalty_ledger SET balance_after = balance_after + 1
          WHERE tenant_id = ${TENANT_A} AND account_seq = 2
        `;
      } finally {
        await admin`ALTER TABLE awcms_commerce_loyalty_ledger ENABLE TRIGGER awcms_commerce_loyalty_ledger_no_update`;
      }
      const report = await inTenant(TENANT_A, (tx) =>
        reconcileLoyaltyForTenant(tx, TENANT_A, { repair: true })
      );
      expect(report.ledgerBreaks).toHaveLength(1);
      expect(report.ledgerBreaks[0]!.badRows).toBe(1);
      expect(report.repaired).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("reporting summary", () => {
    test("earned/redeemed/expired/adjusted/reversed add up with no double counting", async () => {
      await activeProgram(TENANT_A, { expiryDays: 30 });
      const alice = await seedCustomer(TENANT_A, "+6281200009001");
      const bob = await seedCustomer(TENANT_A, "+6281200009002");

      const aliceOrder = await seedOrder(TENANT_A, alice); // 10 points
      const bobOrder = await seedOrder(TENANT_A, bob); // 10 points
      const cancelled = await seedOrder(TENANT_A, bob, {
        subtotal: "40000.00"
      }); // 4 points, later reversed
      for (const orderId of [aliceOrder, bobOrder, cancelled]) {
        await inTenant(TENANT_A, (tx) =>
          earnPointsForPaidOrder(tx, TENANT_A, orderId)
        );
      }
      await inTenant(TENANT_A, (tx) =>
        redeemPoints(
          tx,
          TENANT_A,
          ACTOR,
          { customerId: alice, points: 3, reason: null, idempotencyKey: "s1" },
          PAID_AT
        )
      );
      await inTenant(TENANT_A, (tx) =>
        adjustPoints(
          tx,
          TENANT_A,
          ACTOR,
          { customerId: bob, points: 6, reason: "bonus", idempotencyKey: "s2" },
          PAID_AT
        )
      );
      await inTenant(TENANT_A, (tx) =>
        reverseEarnForCancelledOrder(tx, TENANT_A, cancelled, PAID_AT)
      );
      // Everything earned under the 30-day program lapses by day 40; the +6
      // adjustment never expires.
      await expireDueLoyaltyPointsForTenant(
        getRuntimeSql(),
        TENANT_A,
        new Date(PAID_AT.getTime() + 40 * DAY)
      );

      const summary = await inTenant(TENANT_A, (tx) =>
        fetchLoyaltySummary(tx, TENANT_A, {})
      );
      expect(summary.period).toMatchObject({
        earned: 24,
        redeemed: 3,
        adjustmentsNet: 6,
        reversed: 4
      });
      // alice: 10 earned - 3 redeemed -> 7 lapse. bob: 10 lapse; the cancelled
      // 4 were reversed first so only 10 + (adjustment untouched) remain.
      expect(summary.period.expired).toBe(17);
      expect(summary.period.net).toBe(
        summary.period.earned -
          summary.period.redeemed -
          summary.period.expired +
          summary.period.adjustmentsNet -
          summary.period.reversed
      );
      // outstanding = Σ ledger = Σ projected balances = only the +6.
      expect(summary.outstanding).toBe(6);
      const projected = (await getAdminSql()`
        SELECT COALESCE(SUM(balance), 0)::int AS total
        FROM awcms_commerce_loyalty_accounts WHERE tenant_id = ${TENANT_A}
      `) as { total: number }[];
      expect(projected[0]!.total).toBe(summary.outstanding);
      expect(summary.period.net).toBe(summary.outstanding);
    });

    test("two disjoint windows sum to the all-time figures", async () => {
      const customerId = await seedCustomer(TENANT_A, "+6281200009003");
      const adjust = (points: number, key: string) =>
        inTenant(TENANT_A, (tx) =>
          adjustPoints(
            tx,
            TENANT_A,
            ACTOR,
            { customerId, points, reason: "w", idempotencyKey: key },
            PAID_AT
          )
        );
      await adjust(5, "w1");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const split = new Date();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await adjust(7, "w2");

      const [before, after, all] = await inTenant(TENANT_A, async (tx) => [
        await fetchLoyaltySummary(tx, TENANT_A, { to: split }),
        await fetchLoyaltySummary(tx, TENANT_A, { from: split }),
        await fetchLoyaltySummary(tx, TENANT_A, {})
      ]);
      expect(before!.period.adjustmentsNet).toBe(5);
      expect(after!.period.adjustmentsNet).toBe(7);
      expect(before!.period.adjustmentsNet + after!.period.adjustmentsNet).toBe(
        all!.period.adjustmentsNet
      );
      expect(before!.period.entries + after!.period.entries).toBe(
        all!.period.entries
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("domain events", () => {
    test("every ledger row publishes exactly one loyalty.entry_recorded event with no PII", async () => {
      const customerId = await seedCustomer(TENANT_A, "+6281200010001");
      await inTenant(TENANT_A, (tx) =>
        adjustPoints(
          tx,
          TENANT_A,
          ACTOR,
          {
            customerId,
            points: 9,
            reason: "private reason text",
            idempotencyKey: "ev-1"
          },
          PAID_AT
        )
      );
      const events = (await getAdminSql()`
        SELECT event_type, aggregate_type, payload
        FROM awcms_domain_events
        WHERE tenant_id = ${TENANT_A}
          AND event_type = 'awcms.commerce.loyalty.entry_recorded'
      `) as {
        event_type: string;
        aggregate_type: string;
        payload: Record<string, unknown>;
      }[];
      expect(events).toHaveLength(1);
      expect(events[0]!.aggregate_type).toBe("commerce.loyalty_account");
      expect(events[0]!.payload).toMatchObject({
        kind: "adjustment",
        points: 9,
        balanceAfter: 9,
        sourceType: "manual"
      });
      expect(JSON.stringify(events[0]!.payload)).not.toContain(
        "private reason"
      );
      expect(JSON.stringify(events[0]!.payload)).not.toContain("+62812");
    });
  });
});
