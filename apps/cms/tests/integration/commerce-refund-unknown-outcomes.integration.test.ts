/**
 * Unknown refund outcomes: a gateway refund whose result the caller never
 * saw (issue #564, ADR-0033 D6). Real PostgreSQL through
 * `tests/integration/harness.ts`, two tenants under FORCE RLS, a deterministic
 * fake provider (`tests/support/fake-payment-gateway.ts`) and, for the wire
 * level, the REAL Midtrans adapter against a local `Bun.serve` stub. Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * What ADR-0033 promises is that "the provider receives the leg's id as its
 * idempotency key on every attempt, so a retry can never refund twice". That
 * is a statement about the PROVIDER. Midtrans's own documentation (Direct
 * Refund, "Duplicate refund ID") answers a repeated `refund_key` with
 * `406`, not with the original result, so after an ambiguous timeout the
 * retry does not "settle once": it ends in a retryable `failed` leg that an
 * operator must reconcile (offline settlement, with a stated reason). These
 * tests pin that behaviour and the invariant that holds either way: the
 * provider moves the money at most once, the ledger books it at most once,
 * and an unknown outcome is never booked as "refunded" and never retried
 * under a new key.
 *
 * Failure matrix (case -> test):
 *
 *   timeout/lost ack AFTER the provider refunded
 *       provider idempotent on the key ............ "F1"
 *       provider rejects a repeated key (406) ..... "F2" (+ offline settle)
 *   timeout BEFORE the provider acted ............. "F3"
 *   crash after the provider accepted, before finalize "F4"
 *   accepted-pending, then settled ................ "F5"
 *   two concurrent executions, key-rejecting provider "F6"
 *   a payment reversed by hand during the call ..... "F7" (no over-refund)
 *   cross-tenant / BOLA ........................... "F8"
 *   real adapter: 200 / 201 / 406 / 5xx / timeout ... "H4".."H7"
 *   KNOWN DEFECT: 202 "refund denied by the bank" is booked as refunded "K4"
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import {
  executeRefund,
  settleRefundOffline,
  type ExecuteRefundOutcome
} from "../../src/modules/commerce/application/refund-execution";
import {
  createReturn,
  type CreateReturnOutcome
} from "../../src/modules/commerce/application/return-directory";
import {
  fetchRefundForReturn,
  fetchReturn
} from "../../src/modules/commerce/application/return-records";
import { recordPaymentReversal } from "../../src/modules/commerce/application/payment-allocation-directory";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { createMidtransProvider } from "../../src/modules/commerce/infrastructure/midtrans-provider";
import type { PaymentGatewayProvider } from "../../src/modules/commerce/domain/payment-gateway-provider";
import type {
  CreateReturnInput,
  CreateReturnRefundInput
} from "../../src/modules/commerce/domain/returns";
import { FakePaymentGateway } from "../support/fake-payment-gateway";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;
/** Cases that reproduce a real defect: skipped by default, run with `RUN_KNOWN_DEFECTS=1`. */
const knownDefect = process.env.RUN_KNOWN_DEFECTS ? test : test.skip;

const TENANT_A = "56400000-0564-4000-8000-0000000000fa";
const TENANT_B = "56400000-0564-4000-8000-0000000000fb";
const STAFF_A = "56400000-0564-4000-8000-0000000000c1";
const STAFF_B = "56400000-0564-4000-8000-0000000000c2";
const CUSTOMER = "56400000-0564-4000-8000-0000000000d1";
const KOPI = "56400000-0564-4000-8000-0000000000e1";
const NOW = new Date();
const PAID_AT = new Date(NOW.getTime() - 6 * 60 * 60_000);
const PROVIDER_REF = "MID-UO-1";

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(
  id: string,
  code: string,
  staffId: string
): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${id}, 'person', 'Refund Unknown Staff')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${id}, ${profile[0]!.id}, ${`ru-${code}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${staffId}, ${id}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
  await inTenant(id, (tx) =>
    updateModuleSettings(
      tx,
      id,
      "commerce",
      {
        features: {
          pos: true,
          inbox: true,
          campaigns: true,
          gateway: true,
          courier: true,
          register: false,
          documents: false,
          loyalty: false,
          storedValue: false,
          returns: true
        }
      },
      staffId
    )
  );
}

async function seedCatalog(tenantId: string, suffix: string): Promise<void> {
  const admin = getAdminSql();
  const productId = tenantId === TENANT_A ? KOPI : KOPI.replace(/1$/, "2");
  await admin`
    INSERT INTO awcms_commerce_products (id, tenant_id, sku, name, slug, price, stock)
    VALUES (${productId}, ${tenantId}, ${"SKU-" + suffix}, 'Kopi Arabika', ${"kopi-" + suffix}, 10000.00, 100)
  `;
  const customerId =
    tenantId === TENANT_A ? CUSTOMER : CUSTOMER.replace(/1$/, "2");
  await admin`
    INSERT INTO awcms_commerce_customers (id, tenant_id, name, phone)
    VALUES (${customerId}, ${tenantId}, 'Budi', ${"+62812345" + suffix.padStart(5, "0")})
  `;
}

let orderSeq = 0;

type SeededOrder = {
  id: string;
  items: { id: string }[];
  allocationId: string;
};

/** A paid 5 x 10,000 order (total 50,000) settled by ONE gateway payment. */
async function seedGatewayPaidOrder(
  tenantId: string,
  providerRef = PROVIDER_REF
): Promise<SeededOrder> {
  const admin = getAdminSql();
  orderSeq += 1;
  const code = `RU-${String(orderSeq).padStart(4, "0")}`;
  const productId = tenantId === TENANT_A ? KOPI : KOPI.replace(/1$/, "2");
  const customerId =
    tenantId === TENANT_A ? CUSTOMER : CUSTOMER.replace(/1$/, "2");
  const [order] = (await admin`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, payment_status,
       shipping_method, shipping_cost, subtotal, discount, voucher_discount, total, paid_at)
    VALUES (${tenantId}, ${code}, ${customerId}, 'paid', 'gateway', 'paid',
      'self_pickup', 0.00, 50000.00, 0.00, 0.00, 50000.00, ${PAID_AT})
    RETURNING id
  `) as { id: string }[];
  const [item] = (await admin`
    INSERT INTO awcms_commerce_order_items
      (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
    VALUES (${tenantId}, ${order!.id}, ${productId}, 'Kopi Arabika', 10000.00, 5, 50000.00)
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_commerce_order_events
      (tenant_id, order_id, from_status, to_status, actor, created_at)
    VALUES
      (${tenantId}, ${order!.id}, NULL, 'pending_payment', 'admin', ${new Date(PAID_AT.getTime() - 60_000)}),
      (${tenantId}, ${order!.id}, 'pending_payment', 'paid', 'admin', ${PAID_AT})
  `;
  const [allocation] = (await admin`
    INSERT INTO awcms_commerce_payment_allocations
      (tenant_id, order_id, kind, tender_type, amount, status, provider,
       provider_reference, source, source_key, actor_kind, settled_at, created_at)
    VALUES (${tenantId}, ${order!.id}, 'payment', 'gateway', 50000.00, 'succeeded',
      'midtrans', ${providerRef}, 'admin', ${`seed:${code}`}, 'system', now(), ${PAID_AT})
    RETURNING id
  `) as { id: string }[];
  return {
    id: order!.id,
    items: [{ id: item!.id }],
    allocationId: allocation!.id
  };
}

const ORIGINAL: CreateReturnRefundInput = {
  destination: "original_tender",
  shippingRefund: null,
  registerSessionId: null,
  storeCreditAccountId: null
};

/** Return 2 of 5: goods 20,000.00, no discount -> ONE gateway leg of 20,000.00. */
async function gatewayRefundLeg(tenantId = TENANT_A, staffId = STAFF_A) {
  const order = await seedGatewayPaidOrder(tenantId);
  const input: CreateReturnInput = {
    idempotencyKey: crypto.randomUUID(),
    kind: "return",
    lines: [
      {
        orderItemId: order.items[0]!.id,
        quantity: 2,
        reason: "defective" as never,
        disposition: "restock",
        note: null
      }
    ],
    note: null,
    refund: ORIGINAL,
    exchangeOrderId: null
  };
  const outcome: CreateReturnOutcome = await inTenant(tenantId, (tx) =>
    createReturn(tx, tenantId, staffId, order.id, input, NOW)
  );
  if (outcome.kind !== "created") {
    throw new Error(`expected a return, got ${JSON.stringify(outcome)}`);
  }
  const ret = outcome.body.return;
  return { order, ret, refund: ret.refunds[0]! };
}

function exec(
  returnId: string,
  refundId: string,
  provider: PaymentGatewayProvider | null,
  tenantId = TENANT_A,
  staffId = STAFF_A
): Promise<ExecuteRefundOutcome> {
  return executeRefund(
    getRuntimeSql(),
    tenantId,
    { returnId, refundId, actorTenantUserId: staffId, registerSessionId: null },
    { provider }
  );
}

async function reversals(orderId: string, tenantId = TENANT_A) {
  return (await getAdminSql()`
    SELECT amount::text AS amount, source, source_key
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND kind = 'reversal'
    ORDER BY entry_seq
  `) as { amount: string; source: string; source_key: string }[];
}

async function legRow(refundId: string) {
  const rows = (await getAdminSql()`
    SELECT status, attempts, failure_code, settled_via, offline_reason
    FROM awcms_commerce_refunds WHERE id = ${refundId}
  `) as {
    status: string;
    attempts: number;
    failure_code: string | null;
    settled_via: string | null;
    offline_reason: string | null;
  }[];
  return rows[0]!;
}

// ---------------------------------------------------------------------------

suite("commerce refund unknown outcomes (Issue #564)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    resetProviderCircuitBreakersForTests();
    await resetDatabase();
    await seedTenant(TENANT_A, "ru-a", STAFF_A);
    await seedTenant(TENANT_B, "ru-b", STAFF_B);
    await seedCatalog(TENANT_A, "1");
    await seedCatalog(TENANT_B, "2");
  }, 60000);

  describe("gateway refund with an unseen outcome", () => {
    test("F1 lost acknowledgement AFTER the provider refunded, provider idempotent on the key: the retry settles once and the provider refunded once", async () => {
      const gateway = new FakePaymentGateway().script("refund", "lost_ack");
      gateway.duplicateRefundKey = "replay_original";
      const { order, ret, refund } = await gatewayRefundLeg();

      const first = await exec(ret.id, refund.id, gateway);
      expect(first).toMatchObject({
        kind: "failed",
        failureCode: "PROVIDER_ERROR"
      });
      // Unknown outcome: money moved at the provider, nothing booked here.
      expect(gateway.refundedCents()).toBe(2000000n);
      expect(await reversals(order.id)).toEqual([]);
      expect((await legRow(refund.id)).status).toBe("failed");

      const second = await exec(ret.id, refund.id, gateway);
      expect(second.kind).toBe("settled");
      const third = await exec(ret.id, refund.id, gateway);
      expect(third.kind).toBe("already_settled");

      expect(gateway.refundedCents()).toBe(2000000n);
      expect(gateway.calls.refund).toHaveLength(2);
      expect(new Set(gateway.calls.refund.map((c) => c.refundKey))).toEqual(
        new Set([refund.id])
      );
      expect(await reversals(order.id)).toHaveLength(1);
      expect((await reversals(order.id))[0]!.amount).toBe("20000.00");
    });

    test("F2 the same, against a provider that rejects a repeated key (Midtrans 406): never booked as refunded, never retried under a new key, reconciled offline exactly once", async () => {
      const gateway = new FakePaymentGateway().script(
        "refund",
        "timeout_after"
      );
      const { order, ret, refund } = await gatewayRefundLeg();

      expect(await exec(ret.id, refund.id, gateway)).toMatchObject({
        kind: "failed",
        failureCode: "PROVIDER_ERROR"
      });
      // The retry is refused as a duplicate: the leg stays failed, retryable.
      expect(await exec(ret.id, refund.id, gateway)).toMatchObject({
        kind: "failed",
        failureCode: "MIDTRANS_406"
      });
      expect(await exec(ret.id, refund.id, gateway)).toMatchObject({
        kind: "failed",
        failureCode: "MIDTRANS_406"
      });
      expect(gateway.refundedCents()).toBe(2000000n);
      expect(await reversals(order.id)).toEqual([]);
      expect(new Set(gateway.calls.refund.map((c) => c.refundKey))).toEqual(
        new Set([refund.id])
      );
      expect((await legRow(refund.id)).attempts).toBe(3);

      // The operator confirms on the provider's dashboard that the money went
      // back and settles the leg, with a stated reason.
      const offline = await inTenant(TENANT_A, (tx) =>
        settleRefundOffline(tx, TENANT_A, {
          returnId: ret.id,
          refundId: refund.id,
          actorTenantUserId: STAFF_A,
          reason:
            "Confirmed refunded on the Midtrans dashboard after a timeout",
          now: NOW
        })
      );
      expect(offline.kind).toBe("settled");
      expect(await legRow(refund.id)).toMatchObject({
        status: "succeeded",
        settled_via: "offline"
      });
      // Nothing re-asks the provider, nothing is booked twice.
      const calls = gateway.calls.refund.length;
      expect((await exec(ret.id, refund.id, gateway)).kind).toBe(
        "already_settled"
      );
      expect(gateway.calls.refund).toHaveLength(calls);
      expect(await reversals(order.id)).toHaveLength(1);
      expect(gateway.refundedCents()).toBe(2000000n);
    });

    test("F3 a failure BEFORE the provider acted books nothing and the retry refunds once", async () => {
      const gateway = new FakePaymentGateway().script(
        "refund",
        "http429",
        "http500",
        "timeout_before"
      );
      const { order, ret, refund } = await gatewayRefundLeg();

      for (let i = 0; i < 3; i += 1) {
        expect((await exec(ret.id, refund.id, gateway)).kind).toBe("failed");
        expect(gateway.refundedCents()).toBe(0n);
        expect(await reversals(order.id)).toEqual([]);
      }
      expect((await exec(ret.id, refund.id, gateway)).kind).toBe("settled");
      expect(gateway.refundedCents()).toBe(2000000n);
      expect(await reversals(order.id)).toHaveLength(1);
      expect((await legRow(refund.id)).attempts).toBe(4);
    });

    test("F4 a crash after the provider accepted and before finalize (leg left 'processing'): the restart's retry settles once, and the original's late answer adds nothing", async () => {
      const gateway = new FakePaymentGateway();
      gateway.duplicateRefundKey = "replay_original";
      const { order, ret, refund } = await gatewayRefundLeg();

      // The first process: the provider has refunded, the answer never comes back.
      let release!: () => void;
      const stuck = new Promise<void>((resolve) => (release = resolve));
      const original = gateway.refund.bind(gateway);
      let first = true;
      gateway.refund = async (input) => {
        const result = await original(input);
        if (first) {
          first = false;
          await stuck; // the "crashed" process: finalize has not run
        }
        return result;
      };

      const crashed = exec(ret.id, refund.id, gateway);
      while (
        (await legRow(refund.id)).attempts < 1 ||
        gateway.refundedCents() === 0n
      ) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect((await legRow(refund.id)).status).toBe("processing");

      // The restart: the leg is `processing`, so it is simply executed again.
      const restarted = await exec(ret.id, refund.id, gateway);
      expect(restarted.kind).toBe("settled");

      release();
      expect((await crashed).kind).toBe("already_settled");
      expect(gateway.refundedCents()).toBe(2000000n);
      expect(await reversals(order.id)).toHaveLength(1);
      expect(new Set(gateway.calls.refund.map((c) => c.refundKey))).toEqual(
        new Set([refund.id])
      );
    });

    test("F5 'accepted, pending' keeps the leg processing and books nothing; settling later books once", async () => {
      const gateway = new FakePaymentGateway().script(
        "refund",
        "accepted_pending"
      );
      gateway.duplicateRefundKey = "replay_original";
      const { order, ret, refund } = await gatewayRefundLeg();

      expect((await exec(ret.id, refund.id, gateway)).kind).toBe("processing");
      expect(await reversals(order.id)).toEqual([]);
      expect((await legRow(refund.id)).status).toBe("processing");
      // The replayed answer is still "pending" for this fake: asking again is harmless.
      expect((await exec(ret.id, refund.id, gateway)).kind).toBe("processing");
      expect(gateway.refundedCents()).toBe(2000000n);
      expect(await reversals(order.id)).toEqual([]);

      // An operator confirms the settlement out of band.
      const offline = await inTenant(TENANT_A, (tx) =>
        settleRefundOffline(tx, TENANT_A, {
          returnId: ret.id,
          refundId: refund.id,
          actorTenantUserId: STAFF_A,
          reason: "Provider dashboard shows the refund as settled",
          now: NOW
        })
      );
      expect(offline.kind).toBe("settled");
      expect(await reversals(order.id)).toHaveLength(1);
    });

    test("F6 two concurrent executions against a key-rejecting provider: one settlement, one provider refund, one reversal", async () => {
      const gateway = new FakePaymentGateway();
      const { order, ret, refund } = await gatewayRefundLeg();
      const original = gateway.refund.bind(gateway);
      gateway.refund = async (input) => {
        await new Promise((r) => setTimeout(r, 50));
        return original(input);
      };

      const [a, b] = await Promise.all([
        exec(ret.id, refund.id, gateway),
        exec(ret.id, refund.id, gateway)
      ]);
      expect([a.kind, b.kind]).toContain("settled");
      // Whatever the loser was told, the persisted facts are single.
      expect(gateway.refundedCents()).toBe(2000000n);
      expect(await reversals(order.id)).toHaveLength(1);
      expect((await legRow(refund.id)).status).toBe("succeeded");
      const final = await inTenant(TENANT_A, (tx) =>
        fetchReturn(tx, TENANT_A, ret.id)
      );
      expect(final!.status).toBe("completed");
    });

    test("F7 a payment reversed by hand while the provider call is in flight: the ledger refuses the second reversal (no over-refund) and the leg says so", async () => {
      const gateway = new FakePaymentGateway();
      const { order, ret, refund } = await gatewayRefundLeg();
      gateway.onRefund = async () => {
        const manual = await inTenant(TENANT_A, (tx) =>
          recordPaymentReversal(tx, TENANT_A, {
            orderId: order.id,
            allocationId: order.allocationId,
            amount: null,
            note: "Refunded by hand",
            sourceKey: "manual-reversal-uo",
            actor: { kind: "tenant_user", tenantUserId: STAFF_A }
          })
        );
        expect(manual.kind).toBe("recorded");
      };

      const outcome = await exec(ret.id, refund.id, gateway);
      expect(outcome).toMatchObject({
        kind: "failed",
        failureCode: "PROVIDER_REFUNDED_LEDGER_REFUSED"
      });
      // One reversal (the manual one, of the whole payment) - never two.
      const booked = await reversals(order.id);
      expect(booked).toHaveLength(1);
      expect(booked[0]!.amount).toBe("50000.00");
      expect((await legRow(refund.id)).status).toBe("failed");
    });
  });

  describe("tenancy and object-level authorisation", () => {
    test("F8 tenant B can neither execute nor settle tenant A's refund leg, and the provider is never called", async () => {
      const gateway = new FakePaymentGateway();
      const { order, ret, refund } = await gatewayRefundLeg();

      // Tenant B's own context (returns enabled there): same neutral not_found.
      expect(
        (await exec(ret.id, refund.id, gateway, TENANT_B, STAFF_B)).kind
      ).toBe("not_found");
      const offline = await inTenant(TENANT_B, (tx) =>
        settleRefundOffline(tx, TENANT_B, {
          returnId: ret.id,
          refundId: refund.id,
          actorTenantUserId: STAFF_B,
          reason: "cross-tenant attempt",
          now: NOW
        })
      );
      expect(offline.kind).toBe("not_found");
      // Right tenant, wrong return id: also not_found.
      expect((await exec(crypto.randomUUID(), refund.id, gateway)).kind).toBe(
        "not_found"
      );
      expect(gateway.calls.refund).toHaveLength(0);
      expect(await reversals(order.id)).toEqual([]);
      expect((await legRow(refund.id)).status).toBe("pending");

      // FORCE RLS: B reads none of A's legs.
      const seen = await inTenant(TENANT_B, (tx) =>
        fetchRefundForReturn(tx, TENANT_B, ret.id, refund.id)
      );
      expect(seen).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// The real Midtrans adapter against a local stub (wire-level reality).
// ---------------------------------------------------------------------------

suite(
  "commerce refund unknown outcomes - the real Midtrans adapter (Issue #564)",
  () => {
    type Behaviour =
      | { kind: "business"; statusCode: string }
      | { kind: "http"; status: number }
      | { kind: "slow"; delayMs: number };

    let server: ReturnType<typeof Bun.serve>;
    let behaviour: Behaviour = { kind: "business", statusCode: "200" };
    /** What the stub "refunded", by refund_key; a repeated key answers 406 (Midtrans docs). */
    let refunded = new Map<string, number>();

    function adapter(timeoutMs = 150) {
      return createMidtransProvider({
        serverKey: "SB-Mid-server-test",
        isProduction: false,
        snapBaseUrl: `http://127.0.0.1:${server.port}`,
        statusBaseUrl: `http://127.0.0.1:${server.port}`,
        timeoutMs
      });
    }

    beforeAll(async () => {
      server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const body = (await request.json()) as {
            refund_key?: string;
            amount?: number;
          };
          const key = body.refund_key ?? "?";
          const mode = behaviour;
          if (mode.kind === "http")
            return new Response("{}", { status: mode.status });
          if (refunded.has(key)) {
            return Response.json({
              status_code: "406",
              status_message: "Duplicate refund ID"
            });
          }
          if (mode.kind === "slow") {
            refunded.set(key, body.amount ?? 0);
            await new Promise((r) => setTimeout(r, mode.delayMs));
            return Response.json({ status_code: "200", refund_key: key });
          }
          if (mode.statusCode === "200" || mode.statusCode === "201") {
            refunded.set(key, body.amount ?? 0);
          }
          return Response.json({
            status_code: mode.statusCode,
            status_message: "stub",
            refund_key: key
          });
        }
      });
      await setupIntegrationDatabase();
    }, 120000);

    afterAll(async () => {
      server.stop(true);
      await teardownIntegrationDatabase();
    }, 60000);

    beforeEach(async () => {
      resetProviderCircuitBreakersForTests();
      behaviour = { kind: "business", statusCode: "200" };
      refunded = new Map();
      await resetDatabase();
      await seedTenant(TENANT_A, "ru-a", STAFF_A);
      await seedCatalog(TENANT_A, "1");
    }, 60000);

    test("H4 200 settles once; 201 stays processing and books nothing", async () => {
      const a = await gatewayRefundLeg();
      expect((await exec(a.ret.id, a.refund.id, adapter())).kind).toBe(
        "settled"
      );
      expect(await reversals(a.order.id)).toHaveLength(1);

      behaviour = { kind: "business", statusCode: "201" };
      const b = await gatewayRefundLeg();
      expect((await exec(b.ret.id, b.refund.id, adapter())).kind).toBe(
        "processing"
      );
      expect(await reversals(b.order.id)).toEqual([]);
    });

    test("H5 a repeated refund_key (406 Duplicate refund ID) is a retryable failed leg with a short code, never a second refund", async () => {
      const leg = await gatewayRefundLeg();
      expect((await exec(leg.ret.id, leg.refund.id, adapter())).kind).toBe(
        "settled"
      );
      // Replaying the whole leg id against the provider directly: duplicate.
      const replay = await adapter().refund!({
        providerRef: PROVIDER_REF,
        amount: "20000.00",
        refundKey: leg.refund.id,
        reason: "again"
      });
      expect(replay).toMatchObject({
        status: "failed",
        failureCode: "MIDTRANS_406"
      });
      expect(refunded.size).toBe(1);
    });

    test("H6 HTTP 429 / 500 from the refund endpoint is PROVIDER_ERROR: nothing booked, the same key is reused", async () => {
      const leg = await gatewayRefundLeg();
      for (const status of [429, 500]) {
        behaviour = { kind: "http", status };
        expect(await exec(leg.ret.id, leg.refund.id, adapter())).toMatchObject({
          kind: "failed",
          failureCode: "PROVIDER_ERROR"
        });
      }
      expect(refunded.size).toBe(0);
      expect(await reversals(leg.order.id)).toEqual([]);
      behaviour = { kind: "business", statusCode: "200" };
      expect((await exec(leg.ret.id, leg.refund.id, adapter())).kind).toBe(
        "settled"
      );
      expect([...refunded.keys()]).toEqual([leg.refund.id]);
    });

    test("H7 a timeout that does not abort the remote call: the provider refunds AFTER the caller gave up, the retry meets 406, and the leg waits for an operator instead of refunding again", async () => {
      behaviour = { kind: "slow", delayMs: 400 };
      const leg = await gatewayRefundLeg();

      expect(await exec(leg.ret.id, leg.refund.id, adapter(100))).toMatchObject(
        {
          kind: "failed",
          failureCode: "PROVIDER_ERROR"
        }
      );
      expect(refunded.size).toBe(1); // timeout != no provider side effect
      await new Promise((r) => setTimeout(r, 450));

      expect(await exec(leg.ret.id, leg.refund.id, adapter())).toMatchObject({
        kind: "failed",
        failureCode: "MIDTRANS_406"
      });
      expect(refunded.size).toBe(1);
      expect(await reversals(leg.order.id)).toEqual([]);
      expect((await legRow(leg.refund.id)).status).toBe("failed");
    });

    describe("KNOWN DEFECT (reproduced, not fixed here)", () => {
      knownDefect(
        "K4 Midtrans direct refund answers 202 'Refund denied by the bank'; the adapter books any 2xx other than 201 as 'succeeded', so a refund the bank DENIED settles the leg and the ledger",
        async () => {
          behaviour = { kind: "business", statusCode: "202" };
          const leg = await gatewayRefundLeg();
          const outcome = await exec(leg.ret.id, leg.refund.id, adapter());
          expect(outcome.kind).not.toBe("settled");
          expect(await reversals(leg.order.id)).toEqual([]);
        }
      );
    });
  }
);
