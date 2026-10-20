/**
 * Gateway deposit sessions and mixed tenders over time on one order (Issue
 * #379, ADR-0041, threat-model controls C-06 to C-08) - exercised against a
 * REAL migrated database through `tests/integration/harness.ts`. Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * The properties only a real database can prove:
 *
 *   - the server computes a deposit/balance session's expected amount under
 *     the order-row lock, the client supplies none, and a whole-total order can
 *     never obtain a deposit or balance session (M9: that path is unchanged);
 *   - C-07: a provider figure that differs from the session's expected amount
 *     is rejected in BOTH directions, by the webhook route's path and by the
 *     reconcile job's, recorded as `amount_mismatch`, audited, and credits
 *     nothing - while a later correct figure still settles;
 *   - a replayed webhook, a re-delivery under a new event key and the reconcile
 *     job racing the webhook credit a deposit exactly once;
 *   - the return page is not proof: a created session, a `pending` callback and
 *     an unattached event move no money and no order status;
 *   - a gateway deposit followed by a cash balance settles the order (and the
 *     reverse, and a gateway balance), mixed tenders over time on one ledger;
 *   - a cash payment that lands while a session is live ends `overpaid`, never
 *     lost or double counted (ADR-0041 D5.2);
 *   - the settlement view and the `order.settled` event say "deposit paid,
 *     balance due" and "fully settled" from the ledger alone;
 *   - loyalty points earn only at full settlement on a deposit order, once;
 *     a whole-total order still earns at `order.paid`;
 *   - a session's purpose and expected amount cannot be rewritten afterwards.
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
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import { createOrderFromCart } from "../../src/modules/commerce/application/order-directory";
import {
  createGatewaySession,
  type CreateGatewaySessionAuth
} from "../../src/modules/commerce/application/payment-gateway-directory";
import { applyVerifiedWebhookEvent } from "../../src/modules/commerce/application/payment-webhook-intake";
import { reconcilePendingSessionsForTenant } from "../../src/modules/commerce/application/payment-reconcile";
import { fetchOrderPaymentSummary } from "../../src/modules/commerce/application/payment-allocation-directory";
import { recordOwnerPayment } from "../../src/modules/commerce/application/payment-recording";
import { earnPointsForPaidOrder } from "../../src/modules/commerce/application/loyalty-ledger";
import {
  activateLoyaltyProgram,
  createLoyaltyProgram
} from "../../src/modules/commerce/application/loyalty-program-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { createLogPaymentGatewayProvider } from "../../src/modules/commerce/infrastructure/log-payment-gateway-provider";
import { listDomainEventConsumers } from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import type { DomainEventForHandler } from "../../src/modules/domain-event-runtime/domain/consumer-types";
import type { PaymentGatewayProvider } from "../../src/modules/commerce/domain/payment-gateway-provider";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import type { LoyaltyProgramInput } from "../../src/modules/commerce/domain/loyalty-validation";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
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

const TENANT_A = "37900000-0379-4000-8000-00000000000a";
const STAFF = "37900000-0379-4000-8000-0000000000b1";
const NOW = new Date();
const PHONE = "081311112222";
const AUTH: CreateGatewaySessionAuth = { kind: "phone", phone: PHONE };

const PROVIDER = createLogPaymentGatewayProvider({
  storefrontPublicUrl: "https://toko.example.com",
  now: () => NOW
});

const earnerConsumer = listDomainEventConsumers().find(
  (consumer) => consumer.name === "commerce.order_paid_loyalty_earner"
)!;

function inTenant<T>(fn: (tx: Bun.TransactionSQL) => Promise<T>): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), TENANT_A, fn);
}

async function seedTenant(): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${TENANT_A}, 'tenant-dep-a', 'Deposit A', 'Deposit A Legal', 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${TENANT_A}, 'person', 'Deposit Test Staff')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${TENANT_A}, ${profile[0]!.id}, 'deposit-staff@example.test', 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${STAFF}, ${TENANT_A}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function configureStore(): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Deposit",
    shipping: { selfPickup: true },
    payment: {
      manualQris: { active: true, mediaObjectId: null },
      gateway: { enabled: true },
      downPayment: { active: true, percent: 30 }
    }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant((tx) =>
    saveStoreSettings(tx, TENANT_A, STAFF, validated.value)
  );
}

async function enableLoyalty(): Promise<void> {
  await inTenant(async (tx) => {
    await updateModuleSettings(
      tx,
      TENANT_A,
      "commerce",
      {
        features: {
          pos: true,
          inbox: true,
          campaigns: true,
          gateway: true,
          courier: true,
          loyalty: true
        }
      },
      STAFF
    );
  });
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

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-DEP",
  name: "Paket Menginap",
  slug: "paket-menginap",
  description: null,
  digitalNote: null,
  price: "100000.00",
  discountPercent: 0,
  stock: 50,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 350,
  manualRating: null,
  manualSoldCount: 0,
  withInsurance: false,
  insuranceRequired: false,
  insuranceFee: null,
  promoBannerShow: false,
  promoBannerTitle: null,
  promoBannerSubtitle: null,
  promoBannerBadge: null,
  promoBannerIcon: null,
  promoBannerColor: null,
  sizeChartType: "none",
  sizeChartMediaId: null,
  sizeChartDetails: null,
  serviceForm: null,
  subscriptionPeriod: null,
  downloadLink: null,
  allowDp: true,
  allowFreeShipping: true,
  variantAttributes: null,
  isFeatured: false,
  isRecommended: false
};

let productId = "";

async function seedProduct(): Promise<void> {
  const product = await inTenant((tx) =>
    createProduct(tx, TENANT_A, STAFF, BASE_PRODUCT)
  );
  await inTenant(
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  productId = product.id;
}

async function placeOrder(method: "dp" | "gateway"): Promise<{
  orderCode: string;
  orderId: string;
}> {
  const input: CreateOrderInput = {
    idempotencyKey: crypto.randomUUID(),
    customer: { name: "Budi", phone: "0813-1111-2222", email: null },
    address: null,
    lines: [
      { productId, variantId: null, quantity: 1, serviceFormValues: null }
    ],
    shipping: { method: "self_pickup" },
    payment: { method },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null
  };
  const result = await inTenant((tx) =>
    createOrderFromCart(tx, TENANT_A, mediaLibraryPortAdapter, input, NOW)
  );
  if (result.kind !== "created") {
    throw new Error(`expected order creation, got ${JSON.stringify(result)}`);
  }
  const rows = (await inTenant(
    (tx) =>
      tx`SELECT id FROM awcms_commerce_orders WHERE order_code = ${result.order.orderCode}`
  )) as { id: string }[];
  return { orderCode: result.order.orderCode, orderId: rows[0]!.id };
}

function session(
  orderCode: string,
  purpose: "full" | "deposit" | "balance",
  provider: PaymentGatewayProvider = PROVIDER
) {
  return createGatewaySession(
    getRuntimeSql(),
    TENANT_A,
    orderCode,
    AUTH,
    provider,
    "log",
    purpose
  );
}

async function createdSession(
  orderCode: string,
  purpose: "full" | "deposit" | "balance"
) {
  const outcome = await session(orderCode, purpose);
  if (outcome.kind !== "created") {
    throw new Error(`expected created, got ${JSON.stringify(outcome)}`);
  }
  return outcome.session;
}

function webhook(
  providerRef: string,
  grossAmount: string | undefined,
  eventKey = `${providerRef}:200`,
  status: "paid" | "pending" | "expired" | "failed" = "paid"
) {
  return applyVerifiedWebhookEvent(getRuntimeSql(), TENANT_A, {
    provider: "log",
    eventKey,
    providerRef,
    status,
    grossAmount,
    payload: { fixture: status, gross_amount: grossAmount }
  });
}

async function summary(orderId: string) {
  const result = await inTenant((tx) =>
    fetchOrderPaymentSummary(tx, TENANT_A, orderId)
  );
  return result!;
}

async function orderRow(orderId: string) {
  const rows = (await inTenant(
    (tx) =>
      tx`SELECT status, payment_status FROM awcms_commerce_orders WHERE id = ${orderId}`
  )) as { status: string; payment_status: string }[];
  return rows[0]!;
}

async function legs(orderId: string) {
  return (await inTenant(
    (tx) => tx`
      SELECT kind, tender_type, amount, status, source, provider_reference
      FROM awcms_commerce_payment_allocations
      WHERE order_id = ${orderId}
      ORDER BY entry_seq
    `
  )) as {
    kind: string;
    tender_type: string;
    amount: string;
    status: string;
    source: string;
    provider_reference: string | null;
  }[];
}

async function events(orderId: string, eventType: string) {
  return (await getAdminSql()`
    SELECT id, event_type, payload
    FROM awcms_domain_events
    WHERE tenant_id = ${TENANT_A} AND aggregate_id = ${orderId} AND event_type = ${eventType}
    ORDER BY occurred_at, id
  `) as {
    id: string;
    event_type: string;
    payload: Record<string, unknown>;
  }[];
}

async function payCash(orderId: string, handed: string) {
  return inTenant((tx) =>
    recordOwnerPayment(tx, TENANT_A, STAFF, orderId, {
      idempotencyKey: crypto.randomUUID(),
      tenderType: "cash",
      amount: handed,
      reference: null,
      note: null
    })
  );
}

async function mismatchEvents(providerRef: string) {
  return (await inTenant(
    (tx) =>
      tx`SELECT outcome FROM awcms_commerce_payment_events WHERE provider_ref = ${providerRef} ORDER BY received_at`
  )) as { outcome: string }[];
}

suite("commerce gateway deposit sessions (Issue #379, ADR-0041)", () => {
  const previousGatewayEnv = process.env.COMMERCE_PAYMENT_GATEWAY;
  const previousPublicUrlEnv = process.env.COMMERCE_STOREFRONT_PUBLIC_URL;

  beforeAll(async () => {
    process.env.COMMERCE_PAYMENT_GATEWAY = "log";
    process.env.COMMERCE_STOREFRONT_PUBLIC_URL = "https://toko.example.com";
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
    if (previousGatewayEnv === undefined) {
      delete process.env.COMMERCE_PAYMENT_GATEWAY;
    } else {
      process.env.COMMERCE_PAYMENT_GATEWAY = previousGatewayEnv;
    }
    if (previousPublicUrlEnv === undefined) {
      delete process.env.COMMERCE_STOREFRONT_PUBLIC_URL;
    } else {
      process.env.COMMERCE_STOREFRONT_PUBLIC_URL = previousPublicUrlEnv;
    }
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
    await configureStore();
    await seedProduct();
  }, 30000);

  // -------------------------------------------------------------------------
  describe("session creation", () => {
    test("the server computes the deposit's expected amount; the provider is asked for exactly that", async () => {
      const { orderCode, orderId } = await placeOrder("dp");

      let sentGross: string | null = null;
      const spy: PaymentGatewayProvider = {
        ...PROVIDER,
        createSession: async (input) => {
          sentGross = input.grossAmount;
          return PROVIDER.createSession(input);
        }
      };
      const outcome = await session(orderCode, "deposit", spy);
      if (outcome.kind !== "created") throw new Error("expected created");

      expect(outcome.session.purpose).toBe("deposit");
      expect(outcome.session.expectedAmount).toBe("30000.00");
      expect(sentGross as string | null).toBe("30000.00");

      // The in-flight ledger leg carries the same figure and counts for nothing.
      const rows = await legs(orderId);
      expect(rows).toEqual([
        expect.objectContaining({
          tender_type: "gateway",
          status: "pending",
          source: "gateway_checkout"
        })
      ]);
      expect(String(rows[0]!.amount)).toBe("30000.00");
      expect((await summary(orderId)).settlement.settled).toBe("0.00");
    });

    test("a whole-total order cannot obtain a deposit or a balance session by any request (D3)", async () => {
      const { orderCode } = await placeOrder("gateway");
      for (const purpose of ["deposit", "balance"] as const) {
        const outcome = await session(orderCode, purpose);
        expect(outcome).toEqual({
          kind: "purpose_not_allowed",
          allowed: ["full"]
        });
      }
    });

    test("a deposit order refuses a full session (not applicable, as today) and a balance before the deposit is in", async () => {
      const { orderCode } = await placeOrder("dp");
      expect((await session(orderCode, "full")).kind).toBe("not_applicable");
      expect(await session(orderCode, "balance")).toEqual({
        kind: "purpose_not_allowed",
        allowed: ["deposit"]
      });
    });

    test("one live session per order: the same one comes back; a payment that made it stale blocks a new one", async () => {
      const { orderCode, orderId } = await placeOrder("dp");
      const first = await createdSession(orderCode, "deposit");

      const again = await session(orderCode, "deposit");
      expect(again.kind).toBe("reused");
      if (again.kind === "reused") {
        expect(again.session.providerRef).toBe(first.providerRef);
      }

      // A cashier takes part of the deposit while the session is live: its
      // expected amount is now stale, so no second session is created.
      await payCash(orderId, "10000.00");
      expect(await session(orderCode, "deposit")).toEqual({
        kind: "session_in_progress"
      });
    });

    test("two concurrent creates that both passed validation persist ONE live session (re-check under the order lock)", async () => {
      const { orderCode, orderId } = await placeOrder("dp");

      // Hold both provider calls open until both requests are past the validate
      // step, so neither sees a live session; give each a distinct providerRef
      // so the (provider, provider_ref) unique index cannot mask the race.
      let calls = 0;
      let release!: () => void;
      const bothInFlight = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racing: PaymentGatewayProvider = {
        ...PROVIDER,
        createSession: async (input) => {
          const n = ++calls;
          if (n === 2) release();
          await bothInFlight;
          const created = await PROVIDER.createSession(input);
          return { ...created, providerRef: `${created.providerRef}-race${n}` };
        }
      };

      const [a, b] = await Promise.all([
        session(orderCode, "deposit", racing),
        session(orderCode, "deposit", racing)
      ]);
      expect([a.kind, b.kind].sort()).toEqual(["created", "reused"]);

      const live = await inTenant(
        (tx) =>
          tx`SELECT id FROM awcms_commerce_payment_gateway_sessions
             WHERE order_id = ${orderId} AND status IN ('created', 'pending')`
      );
      expect(live).toHaveLength(1);
    });

    test("whole-total path unchanged: a full session carries the order total and refuses a part-paid order as before", async () => {
      const { orderCode, orderId } = await placeOrder("gateway");
      const created = await createdSession(orderCode, "full");
      expect(created.purpose).toBe("full");
      expect(created.expectedAmount).toBe("100000.00");
      expect(created.providerRef).toMatch(/^log:/);

      // Expire the live session so a second request reaches the settled check.
      await inTenant(
        (tx) =>
          tx`UPDATE awcms_commerce_payment_gateway_sessions SET status = 'expired' WHERE order_id = ${orderId}`
      );
      await payCash(orderId, "10000.00");
      expect(await session(orderCode, "full")).toEqual({
        kind: "partially_settled",
        outstanding: "90000.00"
      });
    });

    test("a purpose and expected amount cannot be rewritten after creation; the status still moves", async () => {
      const { orderCode } = await placeOrder("dp");
      const created = await createdSession(orderCode, "deposit");

      const admin = getAdminSql();
      await assertRejected(
        admin`UPDATE awcms_commerce_payment_gateway_sessions SET expected_amount = 1.00 WHERE id = ${created.id}`,
        "rewriting expected_amount"
      );
      await assertRejected(
        admin`UPDATE awcms_commerce_payment_gateway_sessions SET purpose = 'full' WHERE id = ${created.id}`,
        "rewriting purpose"
      );
      await assertRejected(
        admin`UPDATE awcms_commerce_payment_gateway_sessions SET provider_ref = 'other' WHERE id = ${created.id}`,
        "rewriting provider_ref"
      );
      await admin`UPDATE awcms_commerce_payment_gateway_sessions SET status = 'expired', last_checked_at = now() WHERE id = ${created.id}`;

      // A non-full session must carry an amount, and an amount is positive.
      await assertRejected(
        admin`
          INSERT INTO awcms_commerce_payment_gateway_sessions
            (tenant_id, order_id, provider, provider_ref, redirect_url, status, expires_at, purpose)
          SELECT tenant_id, order_id, 'log', 'x-no-amount', 'https://x', 'pending', now(), 'deposit'
          FROM awcms_commerce_payment_gateway_sessions WHERE id = ${created.id}
        `,
        "a deposit session without an expected amount"
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("C-07 - the amount guard against the session", () => {
    test("a mismatch is rejected in both directions and credits nothing; the correct figure still settles", async () => {
      const { orderCode, orderId } = await placeOrder("dp");
      const created = await createdSession(orderCode, "deposit");

      // Lower, higher, the whole total (the figure an ordinary order accepts),
      // and a one-cent drift: none of them credits the deposit session.
      for (const [index, reported] of [
        "29999.99",
        "30000.01",
        "100000.00",
        "1.00"
      ].entries()) {
        const result = await webhook(
          created.providerRef,
          reported,
          `${created.providerRef}:bad:${index}`
        );
        expect(result).toEqual({
          kind: "amount_mismatch",
          reported,
          expected: "30000.00"
        });
      }
      expect(await orderRow(orderId)).toEqual({
        status: "pending_payment",
        payment_status: "unpaid"
      });
      expect((await summary(orderId)).settlement.settled).toBe("0.00");
      expect((await legs(orderId)).map((leg) => leg.status)).toEqual([
        "pending"
      ]);
      expect(
        (await mismatchEvents(created.providerRef)).map((e) => e.outcome)
      ).toEqual(Array(4).fill("amount_mismatch"));

      const audit = (await inTenant(
        (tx) =>
          tx`SELECT count(*)::int AS count FROM awcms_audit_events WHERE tenant_id = ${TENANT_A} AND message LIKE '%REJECTED%' AND message LIKE '%expected deposit amount 30000.00%'`
      )) as { count: number }[];
      expect(audit[0]!.count).toBe(4);

      // The session was not moved by a mismatched "paid".
      const status = (await inTenant(
        (tx) =>
          tx`SELECT status FROM awcms_commerce_payment_gateway_sessions WHERE id = ${created.id}`
      )) as { status: string }[];
      expect(status[0]!.status).toBe("pending");

      const correct = await webhook(created.providerRef, "30000.00");
      expect(correct).toEqual({ kind: "applied", orderAffected: true });
      expect(await orderRow(orderId)).toEqual({
        status: "paid",
        payment_status: "dp_paid"
      });
    });

    test("the reconcile job runs the same guard: a wrong reported figure credits nothing, the right one settles", async () => {
      const { orderCode, orderId } = await placeOrder("dp");
      const created = await createdSession(orderCode, "deposit");
      await inTenant(
        (tx) =>
          tx`UPDATE awcms_commerce_payment_gateway_sessions SET created_at = created_at - interval '5 minutes' WHERE id = ${created.id}`
      );

      const answering = (gross: string): PaymentGatewayProvider => ({
        ...PROVIDER,
        fetchStatus: async () => ({
          status: "paid",
          raw: { gross_amount: gross }
        })
      });
      const later = new Date(NOW.getTime() + 3 * 60_000);

      const wrong = await reconcilePendingSessionsForTenant(
        getRuntimeSql(),
        TENANT_A,
        later,
        answering("100000.00"),
        "log"
      );
      expect(wrong.markedPaid).toBe(0);
      expect((await summary(orderId)).settlement.settled).toBe("0.00");
      expect((await orderRow(orderId)).status).toBe("pending_payment");
      expect(
        (await mismatchEvents(created.providerRef)).map((e) => e.outcome)
      ).toEqual(["amount_mismatch"]);

      const right = await reconcilePendingSessionsForTenant(
        getRuntimeSql(),
        TENANT_A,
        later,
        answering("30000.00"),
        "log"
      );
      expect(right.markedPaid).toBe(1);
      expect((await summary(orderId)).settlement.settled).toBe("30000.00");
    });

    test("a replayed webhook, a re-delivery under a new event key and the reconcile job racing it credit a deposit once", async () => {
      const { orderCode, orderId } = await placeOrder("dp");
      const created = await createdSession(orderCode, "deposit");

      expect(await webhook(created.providerRef, "30000.00")).toEqual({
        kind: "applied",
        orderAffected: true
      });
      // Same event key: a replay.
      expect(await webhook(created.providerRef, "30000.00")).toEqual({
        kind: "replay"
      });
      // A new event key for the same payment: found already succeeded.
      await webhook(created.providerRef, "30000.00", "another-event-key");
      // The reconcile job reaching the same session afterwards.
      await inTenant(
        (tx) =>
          tx`UPDATE awcms_commerce_payment_gateway_sessions SET status = 'pending', created_at = created_at - interval '5 minutes' WHERE id = ${created.id}`
      );
      await reconcilePendingSessionsForTenant(
        getRuntimeSql(),
        TENANT_A,
        new Date(NOW.getTime() + 3 * 60_000),
        {
          ...PROVIDER,
          fetchStatus: async () => ({
            status: "paid",
            raw: { gross_amount: "30000.00" }
          })
        },
        "log"
      );

      const succeeded = (await legs(orderId)).filter(
        (leg) => leg.status === "succeeded"
      );
      expect(succeeded).toHaveLength(1);
      expect(String(succeeded[0]!.amount)).toBe("30000.00");
      const view = (await summary(orderId)).settlement;
      expect(view.settled).toBe("30000.00");
      expect(view.paymentStatus).toBe("dp_paid");
      expect(await events(orderId, "awcms.commerce.order.paid")).toHaveLength(
        1
      );
    });

    test("a 'paid' that reports no amount never credits a deposit session (any real provider), while a whole-total session keeps its old behaviour", async () => {
      const { orderCode, orderId } = await placeOrder("dp");
      const created = await createGatewaySession(
        getRuntimeSql(),
        TENANT_A,
        orderCode,
        AUTH,
        PROVIDER,
        "midtrans",
        "deposit"
      );
      if (created.kind !== "created") throw new Error("expected created");

      const result = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        {
          provider: "midtrans",
          eventKey: `${created.session.providerRef}:no-amount`,
          providerRef: created.session.providerRef,
          status: "paid",
          payload: { fixture: "no gross_amount" }
        }
      );
      expect(result).toEqual({
        kind: "amount_mismatch",
        reported: "",
        expected: "30000.00"
      });
      expect((await summary(orderId)).settlement.settled).toBe("0.00");
      expect((await orderRow(orderId)).status).toBe("pending_payment");
    });

    test("the return page is not proof: a created session, a pending callback and an unattached event move no money and no status", async () => {
      const { orderCode, orderId } = await placeOrder("dp");
      const created = await createdSession(orderCode, "deposit");

      // The shopper "returns" - nothing in the platform treats the redirect as
      // a payment. A `pending` callback records and ignores.
      expect(
        await webhook(created.providerRef, "30000.00", "pending-1", "pending")
      ).toEqual({ kind: "applied", orderAffected: false });
      expect(
        (await mismatchEvents(created.providerRef)).map((e) => e.outcome)
      ).toEqual(["ignored"]);
      // An event naming a provider reference no session has is only recorded.
      expect(
        await webhook("log:no-such-order:1:1", "30000.00", "orphan-1")
      ).toEqual({ kind: "ignored" });

      expect(await orderRow(orderId)).toEqual({
        status: "pending_payment",
        payment_status: "unpaid"
      });
      expect((await summary(orderId)).settlement.settled).toBe("0.00");
      expect(await events(orderId, "awcms.commerce.order.paid")).toHaveLength(
        0
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("mixed tenders over time on one order", () => {
    test("a gateway deposit followed by a cash balance settles the order", async () => {
      const { orderCode, orderId } = await placeOrder("dp");
      const created = await createdSession(orderCode, "deposit");
      await webhook(created.providerRef, "30000.00");

      // Between deposit and balance (ADR-0041 D6): released, "dp_paid", and the
      // numbers a screen needs are derived from the ledger.
      const between = (await summary(orderId)).settlement;
      expect(await orderRow(orderId)).toEqual({
        status: "paid",
        payment_status: "dp_paid"
      });
      expect(between).toMatchObject({
        total: "100000.00",
        settled: "30000.00",
        deposit: "30000.00",
        balanceDue: "70000.00",
        outstanding: "70000.00",
        settledAt: null,
        paymentStatus: "dp_paid"
      });
      expect(
        await events(orderId, "awcms.commerce.order.settled")
      ).toHaveLength(0);

      // The cashier takes the balance in cash (more than owed: change).
      const paid = await payCash(orderId, "100000.00");
      expect(paid.kind).toBe("created");

      const after = (await summary(orderId)).settlement;
      expect(after).toMatchObject({
        settled: "100000.00",
        balanceDue: "0.00",
        outstanding: "0.00",
        overpaid: "0.00",
        paymentStatus: "paid"
      });
      expect(after.settledAt).not.toBeNull();
      expect(await orderRow(orderId)).toEqual({
        status: "paid",
        payment_status: "paid"
      });
      expect(
        (await legs(orderId)).map((leg) => [
          leg.tender_type,
          leg.status,
          String(leg.amount)
        ])
      ).toEqual([
        ["gateway", "succeeded", "30000.00"],
        ["cash", "succeeded", "70000.00"]
      ]);

      // One settled event, from the same ledger write, with the same instant.
      const settled = await events(orderId, "awcms.commerce.order.settled");
      expect(settled).toHaveLength(1);
      expect(settled[0]!.payload).toMatchObject({
        orderId,
        total: "100000.00",
        deposit: "30000.00"
      });
      expect(JSON.stringify(settled[0]!.payload)).not.toContain(PHONE);
      expect(
        new Date(String(settled[0]!.payload.settledAt)).toISOString()
      ).toBe(after.settledAt as string);
      // ... and it fans out to the loyalty earner as well as `order.paid`.
      const deliveries = (await getAdminSql()`
        SELECT consumer_name FROM awcms_domain_event_deliveries
        WHERE event_id = ${settled[0]!.id}
      `) as { consumer_name: string }[];
      expect(deliveries.map((d) => d.consumer_name)).toEqual([
        "commerce.order_paid_loyalty_earner"
      ]);
    });

    test("a gateway deposit followed by a gateway balance settles it too", async () => {
      const { orderCode, orderId } = await placeOrder("dp");
      const deposit = await createdSession(orderCode, "deposit");
      await webhook(deposit.providerRef, "30000.00");

      const balance = await createdSession(orderCode, "balance");
      expect(balance.purpose).toBe("balance");
      expect(balance.expectedAmount).toBe("70000.00");

      // The deposit's own figure is NOT what the balance session expects.
      expect(
        (await webhook(balance.providerRef, "30000.00", "wrong-balance")).kind
      ).toBe("amount_mismatch");
      expect((await summary(orderId)).settlement.settled).toBe("30000.00");

      expect(await webhook(balance.providerRef, "70000.00")).toEqual({
        kind: "applied",
        orderAffected: false
      });
      const view = (await summary(orderId)).settlement;
      expect(view).toMatchObject({
        settled: "100000.00",
        balanceDue: "0.00",
        paymentStatus: "paid"
      });
      expect(
        await events(orderId, "awcms.commerce.order.settled")
      ).toHaveLength(1);
      // No session is offered once nothing is owed.
      expect((await session(orderCode, "balance")).kind).toBe(
        "purpose_not_allowed"
      );
    });

    test("a cash deposit followed by a gateway balance settles it", async () => {
      const { orderCode, orderId } = await placeOrder("dp");
      await payCash(orderId, "30000.00");
      expect(await orderRow(orderId)).toEqual({
        status: "paid",
        payment_status: "dp_paid"
      });

      const balance = await createdSession(orderCode, "balance");
      expect(balance.expectedAmount).toBe("70000.00");
      await webhook(balance.providerRef, "70000.00");

      expect((await summary(orderId)).settlement).toMatchObject({
        settled: "100000.00",
        paymentStatus: "paid"
      });
    });

    test("cash that lands while a deposit session is live, then the webhook: recorded in full and surfaced as overpaid, never lost or double counted", async () => {
      const { orderCode, orderId } = await placeOrder("dp");
      const created = await createdSession(orderCode, "deposit");

      // The cashier takes the whole total in cash while the session is live.
      await payCash(orderId, "100000.00");
      expect(await orderRow(orderId)).toMatchObject({ payment_status: "paid" });

      // The deposit capture arrives afterwards.
      expect(await webhook(created.providerRef, "30000.00")).toEqual({
        kind: "applied",
        orderAffected: false
      });
      const view = (await summary(orderId)).settlement;
      expect(view).toMatchObject({
        settled: "130000.00",
        overpaid: "30000.00",
        balanceDue: "0.00",
        paymentStatus: "paid"
      });
      expect(
        (await legs(orderId)).filter((leg) => leg.status === "succeeded")
      ).toHaveLength(2);
      // The order settled once, at the cash leg; the late capture adds none.
      expect(
        await events(orderId, "awcms.commerce.order.settled")
      ).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe("whole-total orders are unchanged (M9)", () => {
    test("a whole-total gateway order settles at order.paid, fires no settled event and shows plain numbers", async () => {
      const { orderCode, orderId } = await placeOrder("gateway");
      const created = await createdSession(orderCode, "full");

      // A figure that is not the order total mismatches, exactly as before.
      expect(
        (await webhook(created.providerRef, "30000.00", "wrong")).kind
      ).toBe("amount_mismatch");
      expect(await orderRow(orderId)).toMatchObject({
        status: "pending_payment"
      });

      expect(await webhook(created.providerRef, "100000.00")).toEqual({
        kind: "applied",
        orderAffected: true
      });
      expect(await orderRow(orderId)).toEqual({
        status: "paid",
        payment_status: "paid"
      });
      const rows = await legs(orderId);
      expect(rows.map((r) => [r.status, String(r.amount)])).toEqual([
        ["succeeded", "100000.00"]
      ]);
      expect(await events(orderId, "awcms.commerce.order.paid")).toHaveLength(
        1
      );
      expect(
        await events(orderId, "awcms.commerce.order.settled")
      ).toHaveLength(0);
      const view = (await summary(orderId)).settlement;
      expect(view.deposit).toBe("100000.00");
      expect(view.balanceDue).toBe("0.00");
    });

    test("a session created before the deposit change (no expected amount) is still guarded by the order total", async () => {
      const { orderCode, orderId } = await placeOrder("gateway");
      const created = await createdSession(orderCode, "full");
      // Make it look like a row from before sql/1025.
      await getAdminSql().unsafe(
        `ALTER TABLE awcms_commerce_payment_gateway_sessions DISABLE TRIGGER awcms_commerce_payment_gateway_sessions_frozen`
      );
      await getAdminSql()`UPDATE awcms_commerce_payment_gateway_sessions SET expected_amount = NULL WHERE id = ${created.id}`;
      await getAdminSql().unsafe(
        `ALTER TABLE awcms_commerce_payment_gateway_sessions ENABLE TRIGGER awcms_commerce_payment_gateway_sessions_frozen`
      );

      expect(
        (await webhook(created.providerRef, "99999.99", "legacy-bad")).kind
      ).toBe("amount_mismatch");
      expect(await webhook(created.providerRef, "100000.00")).toEqual({
        kind: "applied",
        orderAffected: true
      });
      expect((await orderRow(orderId)).payment_status).toBe("paid");
    });
  });

  // -------------------------------------------------------------------------
  describe("loyalty earns only at full settlement on a deposit order (D7)", () => {
    function settledEvent(row: {
      id: string;
      payload: Record<string, unknown>;
    }): DomainEventForHandler {
      return {
        id: row.id,
        eventType: "awcms.commerce.order.settled",
        eventVersion: "1.0",
        aggregateType: "commerce.order",
        aggregateId: String(row.payload.orderId),
        orderKey: `commerce.order:${String(row.payload.orderId)}`,
        correlationId: null,
        causationId: null,
        producerModule: "commerce",
        payload: row.payload,
        occurredAt: NOW,
        recordedAt: NOW
      };
    }

    async function earnRows(orderId: string) {
      return (await getAdminSql()`
        SELECT points::int AS points, idempotency_key
        FROM awcms_commerce_loyalty_ledger
        WHERE tenant_id = ${TENANT_A} AND idempotency_key = ${`earn:order:${orderId}`}
      `) as { points: number; idempotency_key: string }[];
    }

    test("a deposit alone earns nothing; the balance earns once, on the total", async () => {
      await enableLoyalty();
      const { orderCode, orderId } = await placeOrder("dp");
      const created = await createdSession(orderCode, "deposit");
      await webhook(created.providerRef, "30000.00");

      // `order.paid` fired at the deposit: the earner skips, a replay too.
      const outcome = await inTenant((tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(outcome).toEqual({
        kind: "skipped",
        reason: "deposit_not_settled"
      });
      expect(await earnRows(orderId)).toHaveLength(0);

      await payCash(orderId, "70000.00");
      const settled = await events(orderId, "awcms.commerce.order.settled");
      expect(settled).toHaveLength(1);

      // The settled event reaches the earner through the real consumer.
      await inTenant((tx) =>
        earnerConsumer.handler(tx, settledEvent(settled[0]!), {
          tenantId: TENANT_A,
          correlationId: "test"
        })
      );
      const rows = await earnRows(orderId);
      expect(rows).toHaveLength(1);
      // floor(100000 / 10000): points on the whole total, not on the deposit.
      expect(rows[0]!.points).toBe(10);

      // However often either trigger is replayed, the order earns once.
      const replayed = await inTenant((tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId, undefined, "settled")
      );
      expect(replayed.kind).toBe("already_earned");
      const paidAgain = await inTenant((tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(paidAgain.kind).toBe("already_earned");
      expect(await earnRows(orderId)).toHaveLength(1);
    });

    test("a deposit order paid in one go earns at order.paid, and its settled event is a no-op replay", async () => {
      await enableLoyalty();
      const { orderId } = await placeOrder("dp");
      await payCash(orderId, "100000.00");

      const first = await inTenant((tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(first.kind).toBe("earned");
      const settled = await events(orderId, "awcms.commerce.order.settled");
      expect(settled).toHaveLength(1);
      const second = await inTenant((tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId, undefined, "settled")
      );
      expect(second.kind).toBe("already_earned");
      expect(await earnRows(orderId)).toHaveLength(1);
    });

    test("a whole-total order earns at order.paid exactly as before, and ignores a settlement trigger", async () => {
      await enableLoyalty();
      const { orderCode, orderId } = await placeOrder("gateway");
      const created = await createdSession(orderCode, "full");
      await webhook(created.providerRef, "100000.00");

      const outcome = await inTenant((tx) =>
        earnPointsForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(outcome.kind).toBe("earned");
      expect(await earnRows(orderId)).toHaveLength(1);
      expect(
        (
          await inTenant((tx) =>
            earnPointsForPaidOrder(tx, TENANT_A, orderId, undefined, "settled")
          )
        ).kind
      ).toBe("skipped");
    });
  });
});
