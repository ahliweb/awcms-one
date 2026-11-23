/**
 * Unknown gateway outcomes: session creation, status polling and webhook
 * settlement under injected provider failure (issue #564, ADR-0017 D1,
 * ADR-0025, ADR-0041). Real PostgreSQL through `tests/integration/harness.ts`,
 * two tenants under FORCE RLS, a deterministic fake provider
 * (`tests/support/fake-payment-gateway.ts`) and, for the wire-level cases, the
 * REAL Midtrans adapter against a local `Bun.serve` stub. Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * The invariant every case ends on: ZERO double financial effects - at most
 * one live provider session per order, at most one pending/succeeded ledger
 * leg per provider reference, an order released once - and an outcome the
 * caller cannot see ends in a state somebody can reconcile, never in a silent
 * second charge.
 *
 * Failure matrix (case -> test):
 *
 *   createSession   timeout BEFORE acceptance ........ "A1"
 *                   timeout AFTER acceptance / lost ack  "A2" (+ A2b retry)
 *                   429 / 5xx / malformed ............ "A3"
 *                   duplicate concurrent requests .... "A4", "A4b"
 *                   money lands while the call is in flight "A5"
 *                   real adapter: slow accept, 429, 5xx, malformed "H1".."H3"
 *   deposit/balance deposit lost ack, balance out of order "D1", "D2"
 *   webhook         late paid after expiry ........... "W1"
 *                   duplicate / reordered events ..... "W2", "W3", "W3b"
 *                   two sessions both paid ........... "W4"
 *                   amount mismatch then correct ..... "W5"
 *                   webhook racing reconcile ......... "W6"
 *   reconcile       fetchStatus failures ............. "R1"
 *   tenancy / BOLA  cross-tenant webhook, reconcile, session, ledger "T1".."T3"
 *   KNOWN DEFECT    provider-paid session expired unasked "K1"; paid session
 *                   regressed by a late 'pending' "K2", "K3" (skipped unless
 *                   RUN_KNOWN_DEFECTS=1)
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import { createOrderFromCart } from "../../src/modules/commerce/application/order-directory";
import {
  createGatewaySession,
  type CreateGatewaySessionAuth,
  type CreateGatewaySessionOutcome
} from "../../src/modules/commerce/application/payment-gateway-directory";
import { applyVerifiedWebhookEvent } from "../../src/modules/commerce/application/payment-webhook-intake";
import {
  reconcileOneOrderPaymentSession,
  reconcilePendingSessionsForTenant
} from "../../src/modules/commerce/application/payment-reconcile";
import { fetchOrderPaymentSummary } from "../../src/modules/commerce/application/payment-allocation-directory";
import { recordOwnerPayment } from "../../src/modules/commerce/application/payment-recording";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { createMidtransProvider } from "../../src/modules/commerce/infrastructure/midtrans-provider";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
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

const TENANT_A = "56400000-0564-4000-8000-00000000000a";
const TENANT_B = "56400000-0564-4000-8000-00000000000b";
const STAFF_A = "56400000-0564-4000-8000-0000000000a1";
const STAFF_B = "56400000-0564-4000-8000-0000000000b1";
const PHONE = "081311112222";
const OTHER_PHONE = "081399998888";
const AUTH: CreateGatewaySessionAuth = { kind: "phone", phone: PHONE };
const NOW = new Date();
/** Far enough ahead that every fake session (60 minutes) is past `expires_at`. */
const LATER = new Date(NOW.getTime() + 3 * 60 * 60_000);
const PROVIDER_KEY = "midtrans" as const;

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

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
    VALUES (${id}, 'person', 'Unknown Outcome Staff')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${id}, ${profile[0]!.id}, ${`uo-${code}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${staffId}, ${id}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
  const validated = validateStoreSettingsInput({
    storeName: `Toko ${code}`,
    shipping: { selfPickup: true },
    payment: {
      manualQris: { active: true, mediaObjectId: null },
      gateway: { enabled: true },
      downPayment: { active: true, percent: 30 }
    }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(id, (tx) =>
    saveStoreSettings(tx, id, staffId, validated.value)
  );
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-UO",
  name: "Mie Gacoan",
  slug: "mie-gacoan-uo",
  description: null,
  digitalNote: null,
  price: "10000.00",
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

const productIds = new Map<string, string>();

async function seedProduct(tenantId: string, staffId: string): Promise<void> {
  const product = await inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, staffId, BASE_PRODUCT)
  );
  await inTenant(
    tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  productIds.set(tenantId, product.id);
}

async function placeOrder(
  tenantId: string,
  method: "dp" | "gateway",
  phone = "0813-1111-2222"
): Promise<{ orderCode: string; orderId: string }> {
  const input: CreateOrderInput = {
    idempotencyKey: crypto.randomUUID(),
    customer: { name: "Budi", phone, email: null },
    address: null,
    lines: [
      {
        productId: productIds.get(tenantId)!,
        variantId: null,
        quantity: 1,
        serviceFormValues: null
      }
    ],
    shipping: { method: "self_pickup" },
    payment: { method },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null
  };
  const result = await inTenant(tenantId, (tx) =>
    createOrderFromCart(tx, tenantId, mediaLibraryPortAdapter, input, NOW)
  );
  if (result.kind !== "created") {
    throw new Error(`expected order creation, got ${JSON.stringify(result)}`);
  }
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT id FROM awcms_commerce_orders WHERE order_code = ${result.order.orderCode}`
  )) as { id: string }[];
  return { orderCode: result.order.orderCode, orderId: rows[0]!.id };
}

// ---------------------------------------------------------------------------
// Drivers and observers
// ---------------------------------------------------------------------------

function create(
  orderCode: string,
  provider: FakePaymentGateway | ReturnType<typeof createMidtransProvider>,
  purpose: "full" | "deposit" | "balance" = "full",
  tenantId = TENANT_A,
  auth: CreateGatewaySessionAuth = AUTH
): Promise<CreateGatewaySessionOutcome> {
  return createGatewaySession(
    getRuntimeSql(),
    tenantId,
    orderCode,
    auth,
    provider,
    PROVIDER_KEY,
    purpose
  );
}

async function createdSession(
  orderCode: string,
  provider: FakePaymentGateway,
  purpose: "full" | "deposit" | "balance" = "full"
) {
  const outcome = await create(orderCode, provider, purpose);
  if (outcome.kind !== "created") {
    throw new Error(`expected created, got ${JSON.stringify(outcome)}`);
  }
  return outcome.session;
}

function webhook(
  providerRef: string,
  status: "paid" | "pending" | "expired" | "failed",
  options: { grossAmount?: string; eventKey?: string; tenantId?: string } = {}
) {
  return applyVerifiedWebhookEvent(
    getRuntimeSql(),
    options.tenantId ?? TENANT_A,
    {
      provider: PROVIDER_KEY,
      eventKey: options.eventKey ?? `${providerRef}:${status}`,
      providerRef,
      status,
      grossAmount: options.grossAmount,
      payload: { fixture: status, gross_amount: options.grossAmount }
    }
  );
}

/** Age every session of the tenant past the reconcile age threshold. */
async function ageSessions(tenantId: string): Promise<void> {
  await inTenant(
    tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_payment_gateway_sessions
         SET created_at = created_at - interval '5 minutes'`
  );
}

function reconcile(
  gateway: FakePaymentGateway,
  now = new Date(NOW.getTime() + 5 * 60_000),
  tenantId = TENANT_A
) {
  return reconcilePendingSessionsForTenant(
    getRuntimeSql(),
    tenantId,
    now,
    gateway,
    PROVIDER_KEY,
    "uo-correlation"
  );
}

async function legs(orderId: string, tenantId = TENANT_A) {
  return (await inTenant(
    tenantId,
    (tx) => tx`
      SELECT kind, tender_type, amount::text AS amount, status, source, source_key, provider_reference
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
    source_key: string;
    provider_reference: string | null;
  }[];
}

async function sessionsOf(orderId: string, tenantId = TENANT_A) {
  return (await inTenant(
    tenantId,
    (tx) => tx`
      SELECT provider_ref, status, purpose, expected_amount::text AS expected_amount
      FROM awcms_commerce_payment_gateway_sessions
      WHERE order_id = ${orderId}
      ORDER BY created_at, provider_ref
    `
  )) as {
    provider_ref: string;
    status: string;
    purpose: string;
    expected_amount: string | null;
  }[];
}

async function orderRow(orderId: string, tenantId = TENANT_A) {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT status, payment_status FROM awcms_commerce_orders WHERE id = ${orderId}`
  )) as { status: string; payment_status: string }[];
  return rows[0]!;
}

async function transitionsTo(orderId: string, toStatus: string) {
  const rows = (await inTenant(
    TENANT_A,
    (tx) =>
      tx`SELECT count(*)::int AS n FROM awcms_commerce_order_events
         WHERE order_id = ${orderId} AND to_status = ${toStatus}`
  )) as { n: number }[];
  return rows[0]!.n;
}

async function summary(orderId: string) {
  const result = await inTenant(TENANT_A, (tx) =>
    fetchOrderPaymentSummary(tx, TENANT_A, orderId)
  );
  return result!.settlement;
}

function succeededCredits(
  ledger: Awaited<ReturnType<typeof legs>>
): typeof ledger {
  return ledger.filter((l) => l.kind === "payment" && l.status === "succeeded");
}

async function payCash(orderId: string, amount: string) {
  return inTenant(TENANT_A, (tx) =>
    recordOwnerPayment(tx, TENANT_A, STAFF_A, orderId, {
      idempotencyKey: crypto.randomUUID(),
      tenderType: "cash",
      amount,
      reference: null,
      note: null
    })
  );
}

// ---------------------------------------------------------------------------

/** `gateway` is only an offered payment method while a provider is configured; the tests pass their own provider objects, this just opens the method. */
const savedEnv = {
  gateway: process.env.COMMERCE_PAYMENT_GATEWAY,
  url: process.env.COMMERCE_STOREFRONT_PUBLIC_URL
};
function configureGatewayEnv(): void {
  process.env.COMMERCE_PAYMENT_GATEWAY = "log";
  process.env.COMMERCE_STOREFRONT_PUBLIC_URL = "https://toko.example.com";
}
function restoreGatewayEnv(): void {
  for (const [key, value] of [
    ["COMMERCE_PAYMENT_GATEWAY", savedEnv.gateway],
    ["COMMERCE_STOREFRONT_PUBLIC_URL", savedEnv.url]
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

suite("commerce payment unknown outcomes (Issue #564)", () => {
  beforeAll(async () => {
    configureGatewayEnv();
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
    restoreGatewayEnv();
  }, 60000);

  beforeEach(async () => {
    resetProviderCircuitBreakersForTests();
    await resetDatabase();
    await seedTenant(TENANT_A, "uo-a", STAFF_A);
    await seedTenant(TENANT_B, "uo-b", STAFF_B);
    await seedProduct(TENANT_A, STAFF_A);
    await seedProduct(TENANT_B, STAFF_B);
  }, 60000);

  // =========================================================================
  describe("createSession under failure", () => {
    test("A1 a timeout BEFORE the provider accepted leaves no trace, and the retry creates exactly one session", async () => {
      const gateway = new FakePaymentGateway().script(
        "createSession",
        "timeout_before"
      );
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");

      expect((await create(orderCode, gateway)).kind).toBe(
        "gateway_unavailable"
      );
      expect(gateway.sessions.size).toBe(0);
      expect(await sessionsOf(orderId)).toEqual([]);
      expect(await legs(orderId)).toEqual([]);

      const retry = await create(orderCode, gateway);
      expect(retry.kind).toBe("created");
      expect(gateway.sessions.size).toBe(1);
      expect(await sessionsOf(orderId)).toHaveLength(1);
      expect(await legs(orderId)).toHaveLength(1);
      expect((await legs(orderId))[0]).toMatchObject({
        status: "pending",
        amount: "10000.00"
      });
    });

    test("A2 a lost acknowledgement AFTER the provider created the session: nothing persisted, no second provider session, no ledger leg", async () => {
      const gateway = new FakePaymentGateway().script(
        "createSession",
        "lost_ack"
      );
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");

      expect((await create(orderCode, gateway)).kind).toBe(
        "gateway_unavailable"
      );
      // The unknown outcome: the provider holds a session this deployment
      // never learned of. Nothing was credited and nothing was stored.
      expect([...gateway.sessions.keys()]).toEqual([`${orderCode}-1`]);
      expect(await sessionsOf(orderId)).toEqual([]);
      expect(await legs(orderId)).toEqual([]);
      expect((await orderRow(orderId)).status).toBe("pending_payment");

      // A provider that rejects a repeated order_id (Midtrans Snap): the retry
      // is refused, still no second provider session, still nothing stored.
      expect((await create(orderCode, gateway)).kind).toBe(
        "gateway_unavailable"
      );
      expect(gateway.sessions.size).toBe(1);
      expect(gateway.calls.createSession.map((c) => c.attempt)).toEqual([1, 1]);
      expect(await sessionsOf(orderId)).toEqual([]);
      expect(await legs(orderId)).toEqual([]);
    });

    test("A2b the same retry against a provider that is idempotent on order_id converges on one session and one pending leg", async () => {
      const gateway = new FakePaymentGateway().script(
        "createSession",
        "lost_ack"
      );
      gateway.duplicateOrderId = "reuse";
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");

      expect((await create(orderCode, gateway)).kind).toBe(
        "gateway_unavailable"
      );
      const retry = await create(orderCode, gateway);
      expect(retry.kind).toBe("created");
      expect(gateway.sessions.size).toBe(1);
      expect(await sessionsOf(orderId)).toHaveLength(1);
      expect(await legs(orderId)).toHaveLength(1);
      // And a third call reuses the stored session without touching the provider.
      const calls = gateway.calls.createSession.length;
      expect((await create(orderCode, gateway)).kind).toBe("reused");
      expect(gateway.calls.createSession).toHaveLength(calls);
    });

    test.todo(
      "A2c LIVENESS: after a lost acknowledgement against a provider that rejects a repeated order_id, the order can never obtain a session (attempt is derived from stored rows, so it never advances) - needs an operator-visible 'unknown session' state or a provider status lookup before retry"
    );

    for (const fault of ["http429", "http500", "malformed"] as const) {
      test(`A3 ${fault}: gateway_unavailable, nothing persisted; a malformed answer after acceptance still leaves no leg; the retry works`, async () => {
        const gateway = new FakePaymentGateway().script("createSession", fault);
        gateway.duplicateOrderId = "reuse";
        const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");

        expect((await create(orderCode, gateway)).kind).toBe(
          "gateway_unavailable"
        );
        expect(await sessionsOf(orderId)).toEqual([]);
        expect(await legs(orderId)).toEqual([]);

        expect((await create(orderCode, gateway)).kind).toBe("created");
        expect(await sessionsOf(orderId)).toHaveLength(1);
        expect(succeededCredits(await legs(orderId))).toHaveLength(0);
        expect(await legs(orderId)).toHaveLength(1);
      });
    }

    test("A4 duplicate concurrent requests (both pass validation, both call the provider): one live session, one pending leg", async () => {
      for (const duplicateOrderId of ["reuse", "reject"] as const) {
        await resetDatabase();
        await seedTenant(TENANT_A, "uo-a", STAFF_A);
        await seedProduct(TENANT_A, STAFF_A);
        const gateway = new FakePaymentGateway();
        gateway.duplicateOrderId = duplicateOrderId;
        let entered = 0;
        gateway.onCreateSession = async () => {
          entered += 1;
          // Hold both calls inside the provider until both have been validated.
          while (entered < 2) await new Promise((r) => setTimeout(r, 5));
        };
        const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");

        const outcomes = await Promise.all([
          create(orderCode, gateway),
          create(orderCode, gateway)
        ]);
        expect(gateway.calls.createSession).toHaveLength(2);
        // Whatever each caller was told, the ledger and the session table say one.
        expect(outcomes.map((o) => o.kind)).toContain("created");
        const live = (await sessionsOf(orderId)).filter((s) =>
          ["created", "pending"].includes(s.status)
        );
        expect(live).toHaveLength(1);
        expect(await legs(orderId)).toHaveLength(1);
        expect(succeededCredits(await legs(orderId))).toHaveLength(0);
        // Both fake sessions had the same provider order_id (the attempt did not advance).
        expect(gateway.sessions.size).toBe(1);
      }
    });

    test("A4b the same race against a provider that mints a fresh reference per call (no unique-key collision to save us): the order-level guard keeps one live session and one pending leg", async () => {
      const gateway = new FakePaymentGateway();
      gateway.distinctRefPerCall = true;
      let entered = 0;
      gateway.onCreateSession = async () => {
        entered += 1;
        while (entered < 2) await new Promise((r) => setTimeout(r, 5));
      };
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");

      const outcomes = await Promise.all([
        create(orderCode, gateway),
        create(orderCode, gateway)
      ]);
      expect(gateway.calls.createSession).toHaveLength(2);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(["created", "reused"]);
      // The loser's provider session is orphaned (never used, never credited).
      expect(gateway.sessions.size).toBe(2);
      expect(await sessionsOf(orderId)).toHaveLength(1);
      expect(await legs(orderId)).toHaveLength(1);
      expect(succeededCredits(await legs(orderId))).toHaveLength(0);
    });

    test("A5 money that lands while the provider call is in flight: nothing is inserted, the ledger holds only the cash", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      gateway.onCreateSession = async () => {
        const paid = await payCash(orderId, "2000.00");
        expect(paid.kind).toBe("created");
      };

      const outcome = await create(orderCode, gateway);
      expect(outcome.kind).toBe("partially_settled");
      // The provider-side session is orphaned and never used.
      expect(gateway.sessions.size).toBe(1);
      expect(await sessionsOf(orderId)).toEqual([]);
      const ledger = await legs(orderId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        tender_type: "cash",
        amount: "2000.00"
      });
      // And a fresh request is refused before the provider is called at all.
      const calls = gateway.calls.createSession.length;
      expect((await create(orderCode, gateway)).kind).toBe("partially_settled");
      expect(gateway.calls.createSession).toHaveLength(calls);
    });
  });

  // =========================================================================
  describe("deposit and balance sessions under failure", () => {
    test("D1 a deposit session with a lost acknowledgement credits nothing; the deposit then settles once at the server's amount", async () => {
      const gateway = new FakePaymentGateway().script(
        "createSession",
        "lost_ack"
      );
      gateway.duplicateOrderId = "reuse";
      const { orderCode, orderId } = await placeOrder(TENANT_A, "dp");

      expect((await create(orderCode, gateway, "deposit")).kind).toBe(
        "gateway_unavailable"
      );
      expect(await legs(orderId)).toEqual([]);
      const session = await createdSession(orderCode, gateway, "deposit");
      expect(session.expectedAmount).toBe("3000.00");
      expect(gateway.sessions.size).toBe(1);

      expect(
        (await webhook(session.providerRef, "paid", { grossAmount: "3000.00" }))
          .kind
      ).toBe("applied");
      expect(succeededCredits(await legs(orderId))).toHaveLength(1);
      const settled = await summary(orderId);
      expect(settled.settled).toBe("3000.00");
      expect(settled.outstanding).toBe("7000.00");
      // The deposit is the release threshold (ADR-0041): the order is released once.
      expect((await orderRow(orderId)).status).toBe("paid");
      expect(await transitionsTo(orderId, "paid")).toBe(1);
    });

    test("D2 a balance session cannot start before the deposit is in, and the provider is never called for it; the order is released exactly once at full settlement", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "dp");

      const early = await create(orderCode, gateway, "balance");
      expect(early.kind).toBe("purpose_not_allowed");
      expect(gateway.calls.createSession).toHaveLength(0);

      const deposit = await createdSession(orderCode, gateway, "deposit");
      await webhook(deposit.providerRef, "paid", { grossAmount: "3000.00" });
      // A second deposit is refused (one deposit per order).
      expect((await create(orderCode, gateway, "deposit")).kind).toBe(
        "purpose_not_allowed"
      );

      const balance = await createdSession(orderCode, gateway, "balance");
      expect(balance.expectedAmount).toBe("7000.00");
      // A paid event for the balance replayed under three different event keys.
      await webhook(balance.providerRef, "paid", { grossAmount: "7000.00" });
      await webhook(balance.providerRef, "paid", {
        grossAmount: "7000.00",
        eventKey: `${balance.providerRef}:paid:again`
      });
      await webhook(balance.providerRef, "paid", {
        grossAmount: "7000.00",
        eventKey: `${balance.providerRef}:paid:third`
      });

      const credits = succeededCredits(await legs(orderId));
      expect(credits.map((c) => c.amount).sort()).toEqual([
        "3000.00",
        "7000.00"
      ]);
      expect((await orderRow(orderId)).status).toBe("paid");
      expect(await transitionsTo(orderId, "paid")).toBe(1);
    });
  });

  // =========================================================================
  describe("webhook settlement under duplication, reordering and lateness", () => {
    test("W1 a paid webhook AFTER the session and order expired: the money is recorded once as a late leg, the order is left expired, replays add nothing", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      const session = await createdSession(orderCode, gateway);

      // The reconcile tick past expires_at expires the session and the order
      // without asking the provider (see K1).
      await ageSessions(TENANT_A);
      const tick = await reconcile(gateway, LATER);
      expect(tick.expiredSessions).toBe(1);
      expect(tick.expiredOrders).toBeGreaterThanOrEqual(1);
      expect((await orderRow(orderId)).status).toBe("expired");
      expect((await legs(orderId)).map((l) => l.status)).toEqual(["failed"]);

      const late = await webhook(session.providerRef, "paid", {
        grossAmount: "10000.00"
      });
      expect(late.kind).toBe("applied");
      const afterLate = await legs(orderId);
      expect(afterLate.map((l) => l.status).sort()).toEqual([
        "failed",
        "succeeded"
      ]);
      expect(succeededCredits(afterLate)).toHaveLength(1);
      expect(succeededCredits(afterLate)[0]!.source_key).toBe(
        `gateway:${PROVIDER_KEY}:${session.providerRef}:late`
      );
      // The order does not come back to life; the received money is on the
      // ledger for an operator (overpaid against an order that is not payable).
      expect((await orderRow(orderId)).status).toBe("expired");
      expect((await summary(orderId)).settled).toBe("10000.00");
      expect(await transitionsTo(orderId, "paid")).toBe(0);

      // Replay (same event key) and a re-delivery under a new key: no new leg.
      expect(
        (
          await webhook(session.providerRef, "paid", {
            grossAmount: "10000.00"
          })
        ).kind
      ).toBe("replay");
      await webhook(session.providerRef, "paid", {
        grossAmount: "10000.00",
        eventKey: `${session.providerRef}:paid:redelivered`
      });
      expect(await legs(orderId)).toHaveLength(2);
      expect(succeededCredits(await legs(orderId))).toHaveLength(1);
    });

    test("W2 duplicate and reordered events on a paid order: 'expired' and 'pending' arriving after 'paid' move no money and do not un-pay the order", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      const session = await createdSession(orderCode, gateway);

      await webhook(session.providerRef, "paid", { grossAmount: "10000.00" });
      expect((await orderRow(orderId)).status).toBe("paid");

      await webhook(session.providerRef, "expired");
      await webhook(session.providerRef, "pending");
      await webhook(session.providerRef, "paid", {
        grossAmount: "10000.00",
        eventKey: `${session.providerRef}:paid:dup`
      });

      expect((await orderRow(orderId)).status).toBe("paid");
      const ledger = await legs(orderId);
      expect(succeededCredits(ledger)).toHaveLength(1);
      expect(ledger.filter((l) => l.status === "failed")).toHaveLength(0);
      expect(ledger).toHaveLength(1);
      expect(await transitionsTo(orderId, "paid")).toBe(1);
    });

    test("W3 a late 'pending' after 'paid' moves no money and does not un-pay the order", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      const session = await createdSession(orderCode, gateway);
      await webhook(session.providerRef, "paid", { grossAmount: "10000.00" });
      await webhook(session.providerRef, "pending");

      expect(succeededCredits(await legs(orderId))).toHaveLength(1);
      expect(
        (await legs(orderId)).filter((l) => l.status !== "succeeded")
      ).toEqual([]);
      expect((await orderRow(orderId)).status).toBe("paid");
      expect(await transitionsTo(orderId, "paid")).toBe(1);
    });

    test("W3b after a late 'pending' regressed a paid deposit session, the next reconcile tick heals it with no second credit", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "dp");
      const deposit = await createdSession(orderCode, gateway, "deposit");
      gateway.setProviderStatus(deposit.providerRef, "paid");
      await webhook(deposit.providerRef, "paid", { grossAmount: "3000.00" });
      await webhook(deposit.providerRef, "pending");

      await ageSessions(TENANT_A);
      await reconcile(gateway);
      expect((await sessionsOf(orderId))[0]!.status).toBe("paid");
      expect(
        succeededCredits(await legs(orderId)).map((c) => c.amount)
      ).toEqual(["3000.00"]);
      expect((await create(orderCode, gateway, "balance")).kind).toBe(
        "created"
      );
    });

    test("W4 two sessions for one order both end up paid (a late first, a second): both are on the ledger, the order is released once, the excess is overpaid", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      const first = await createdSession(orderCode, gateway);
      // The first session ends (failed) without the order expiring, so the shopper may try again.
      await webhook(first.providerRef, "failed");
      const second = await createdSession(orderCode, gateway);
      expect(second.providerRef).not.toBe(first.providerRef);

      await webhook(second.providerRef, "paid", { grossAmount: "10000.00" });
      expect((await orderRow(orderId)).status).toBe("paid");
      // The provider then reports the FIRST session paid after all.
      await webhook(first.providerRef, "paid", { grossAmount: "10000.00" });

      const credits = succeededCredits(await legs(orderId));
      expect(credits).toHaveLength(2);
      expect(new Set(credits.map((c) => c.provider_reference)).size).toBe(2);
      expect(await transitionsTo(orderId, "paid")).toBe(1);
      const view = await summary(orderId);
      expect(view.settled).toBe("20000.00");
      expect(view.overpaid).toBe("10000.00");
    });

    test("W5 amount mismatch: neither the webhook nor reconcile credits it; the correct figure then settles exactly once", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      const session = await createdSession(orderCode, gateway);

      expect(
        (await webhook(session.providerRef, "paid", { grossAmount: "1.00" }))
          .kind
      ).toBe("amount_mismatch");
      gateway.setProviderStatus(session.providerRef, "paid", "9999.00");
      await ageSessions(TENANT_A);
      const wrong = await reconcile(gateway);
      expect(wrong.markedPaid).toBe(0);
      expect(succeededCredits(await legs(orderId))).toHaveLength(0);
      expect((await orderRow(orderId)).status).toBe("pending_payment");

      gateway.setProviderStatus(session.providerRef, "paid", "10000.00");
      const right = await reconcile(gateway);
      expect(right.markedPaid).toBe(1);
      // A webhook for the same payment arrives afterwards: still one credit.
      await webhook(session.providerRef, "paid", {
        grossAmount: "10000.00",
        eventKey: `${session.providerRef}:paid:after`
      });
      expect(succeededCredits(await legs(orderId))).toHaveLength(1);
      expect(await transitionsTo(orderId, "paid")).toBe(1);
    });

    test("W6 a webhook racing the reconcile tick credits the payment once", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      const session = await createdSession(orderCode, gateway);
      gateway.setProviderStatus(session.providerRef, "paid");
      await ageSessions(TENANT_A);

      await Promise.all([
        webhook(session.providerRef, "paid", { grossAmount: "10000.00" }),
        reconcile(gateway)
      ]);
      expect(succeededCredits(await legs(orderId))).toHaveLength(1);
      expect((await legs(orderId)).length).toBe(1);
      expect(await transitionsTo(orderId, "paid")).toBe(1);
    });
  });

  // =========================================================================
  describe("reconcile polling under failure", () => {
    test("R1 fetchStatus 429/5xx/timeout/malformed leave the session pending and credit nothing; the next tick settles it once", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      const session = await createdSession(orderCode, gateway);
      gateway.setProviderStatus(session.providerRef, "paid");
      gateway.script(
        "fetchStatus",
        "http429",
        "http500",
        "timeout_before",
        "malformed"
      );
      await ageSessions(TENANT_A);

      for (let i = 0; i < 4; i += 1) {
        const tick = await reconcile(gateway);
        expect(tick.fetchFailures).toBe(1);
        expect(tick.markedPaid).toBe(0);
        expect((await sessionsOf(orderId))[0]!.status).toBe("pending");
        expect(succeededCredits(await legs(orderId))).toHaveLength(0);
      }
      const ok = await reconcile(gateway);
      expect(ok.markedPaid).toBe(1);
      // A further tick finds nothing pending: no second credit.
      const again = await reconcile(gateway);
      expect(again.checked).toBe(0);
      expect(succeededCredits(await legs(orderId))).toHaveLength(1);
    });

    test("R2 the admin 'check status' path on a failing provider reports pending and changes nothing", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      const session = await createdSession(orderCode, gateway);
      gateway.setProviderStatus(session.providerRef, "paid");
      gateway.script("fetchStatus", "http500");

      const failed = await reconcileOneOrderPaymentSession(
        getRuntimeSql(),
        TENANT_A,
        orderId,
        gateway,
        PROVIDER_KEY
      );
      expect(failed).toEqual({ outcome: "checked", status: "pending" });
      expect(succeededCredits(await legs(orderId))).toHaveLength(0);
      const ok = await reconcileOneOrderPaymentSession(
        getRuntimeSql(),
        TENANT_A,
        orderId,
        gateway,
        PROVIDER_KEY
      );
      expect(ok.status).toBe("paid");
      expect(succeededCredits(await legs(orderId))).toHaveLength(1);
    });
  });

  // =========================================================================
  describe("tenancy and object-level authorisation", () => {
    test("T1 tenant B can neither settle, poll nor see tenant A's session", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      const session = await createdSession(orderCode, gateway);
      gateway.setProviderStatus(session.providerRef, "paid");

      // Tenant B's context, tenant A's provider reference.
      const crossWebhook = await webhook(session.providerRef, "paid", {
        grossAmount: "10000.00",
        tenantId: TENANT_B
      });
      expect(crossWebhook).toEqual({ kind: "ignored" });

      await ageSessions(TENANT_A);
      const crossTick = await reconcile(gateway, undefined, TENANT_B);
      expect(crossTick.checked).toBe(0);
      expect(gateway.calls.fetchStatus).toHaveLength(0);
      expect(
        await reconcileOneOrderPaymentSession(
          getRuntimeSql(),
          TENANT_B,
          orderId,
          gateway,
          PROVIDER_KEY
        )
      ).toEqual({ outcome: "no_session" });

      expect(succeededCredits(await legs(orderId))).toHaveLength(0);
      expect((await orderRow(orderId)).status).toBe("pending_payment");
      // FORCE RLS: B reads none of A's rows and cannot write one for A.
      const seen = (await inTenant(
        TENANT_B,
        (tx) =>
          tx`SELECT count(*)::int AS n FROM awcms_commerce_payment_allocations`
      )) as { n: number }[];
      expect(seen[0]!.n).toBe(0);
      let rejected = false;
      try {
        await inTenant(
          TENANT_B,
          (tx) => tx`
            INSERT INTO awcms_commerce_payment_allocations
              (tenant_id, order_id, kind, tender_type, amount, status, provider,
               provider_reference, source, source_key, actor_kind, settled_at)
            VALUES (${TENANT_A}, ${orderId}, 'payment', 'gateway', 10000.00, 'succeeded',
              ${PROVIDER_KEY}, ${session.providerRef}, 'gateway_webhook', 'planted', 'system', now())
          `
        );
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(succeededCredits(await legs(orderId))).toHaveLength(0);
    });

    test("T2 a session cannot be created for another tenant's order, or for another customer's order in the same tenant; the provider is never called", async () => {
      const gateway = new FakePaymentGateway();
      const { orderCode } = await placeOrder(TENANT_A, "gateway");
      const before = gateway.calls.createSession.length;

      expect((await create(orderCode, gateway, "full", TENANT_B)).kind).toBe(
        "not_found"
      );
      expect(
        (
          await create(orderCode, gateway, "full", TENANT_A, {
            kind: "phone",
            phone: OTHER_PHONE
          })
        ).kind
      ).toBe("not_found");
      expect(gateway.calls.createSession).toHaveLength(before);
    });

    test("T3 a tenant-B order's references stay separate: the same provider order code in two tenants never merges ledgers", async () => {
      const gateway = new FakePaymentGateway();
      const a = await placeOrder(TENANT_A, "gateway");
      const b = await placeOrder(TENANT_B, "gateway");
      const sessionA = await createdSession(a.orderCode, gateway);
      const outcomeB = await create(b.orderCode, gateway, "full", TENANT_B);
      expect(outcomeB.kind).toBe("created");

      await webhook(sessionA.providerRef, "paid", { grossAmount: "10000.00" });
      expect(succeededCredits(await legs(a.orderId))).toHaveLength(1);
      expect(succeededCredits(await legs(b.orderId, TENANT_B))).toHaveLength(0);
      expect((await orderRow(b.orderId, TENANT_B)).status).toBe(
        "pending_payment"
      );
    });
  });

  // =========================================================================
  describe("KNOWN DEFECT (reproduced, not fixed here)", () => {
    knownDefect(
      "K2 a late 'pending' event after 'paid' regresses the paid session row to 'pending' (no financial effect, but the session looks live again)",
      async () => {
        const gateway = new FakePaymentGateway();
        const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
        const session = await createdSession(orderCode, gateway);
        await webhook(session.providerRef, "paid", { grossAmount: "10000.00" });
        await webhook(session.providerRef, "pending");
        expect((await sessionsOf(orderId))[0]!.status).toBe("paid");
      }
    );

    knownDefect(
      "K3 the same regression on a deposit order blocks the balance session (session_in_progress) until the reconcile tick heals the row",
      async () => {
        const gateway = new FakePaymentGateway();
        const { orderCode } = await placeOrder(TENANT_A, "dp");
        const deposit = await createdSession(orderCode, gateway, "deposit");
        await webhook(deposit.providerRef, "paid", { grossAmount: "3000.00" });
        await webhook(deposit.providerRef, "pending");
        expect((await create(orderCode, gateway, "balance")).kind).toBe(
          "created"
        );
      }
    );

    knownDefect(
      "K1 a session the provider has PAID is expired by the reconcile tick without asking the provider, and is never polled again: with a lost webhook the money has no ledger fact",
      async () => {
        const gateway = new FakePaymentGateway();
        const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
        const session = await createdSession(orderCode, gateway);
        // The shopper paid at the provider in the last minute; the webhook was lost.
        gateway.setProviderStatus(session.providerRef, "paid", "10000.00");

        await ageSessions(TENANT_A);
        await reconcile(gateway, LATER); // step 1: expires session + order unconditionally
        await reconcile(gateway, LATER); // the session is no longer 'pending': never polled

        // What must hold: the captured money ends up on the ledger (or in a
        // state an operator is told about). Today it ends up nowhere.
        expect(gateway.calls.fetchStatus).toContain(session.providerRef);
        expect(succeededCredits(await legs(orderId))).toHaveLength(1);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// The real Midtrans adapter against a local stub (wire-level reality).
// ---------------------------------------------------------------------------

suite(
  "commerce payment unknown outcomes - the real Midtrans adapter (Issue #564)",
  () => {
    type Behaviour =
      | { kind: "ok" }
      | { kind: "slow_accept"; delayMs: number }
      | { kind: "status"; status: number }
      | { kind: "malformed" };

    let server: ReturnType<typeof Bun.serve>;
    let behaviour: Behaviour = { kind: "ok" };
    let accepted: string[] = [];

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
            transaction_details?: { order_id?: string };
          };
          const orderId = body.transaction_details?.order_id ?? "?";
          const mode = behaviour;
          if (mode.kind === "status") {
            return new Response("{}", { status: mode.status });
          }
          if (mode.kind === "slow_accept") {
            // The provider ACCEPTS (records the session) and answers late.
            accepted.push(orderId);
            await new Promise((r) => setTimeout(r, mode.delayMs));
            return Response.json({
              token: "tok",
              redirect_url: "https://pay.example.test/x"
            });
          }
          accepted.push(orderId);
          if (mode.kind === "malformed") {
            return new Response("<html>not json", { status: 200 });
          }
          return Response.json({
            token: "tok",
            redirect_url: "https://pay.example.test/x"
          });
        }
      });
      configureGatewayEnv();
      await setupIntegrationDatabase();
    }, 120000);

    afterAll(async () => {
      server.stop(true);
      await teardownIntegrationDatabase();
      restoreGatewayEnv();
    }, 60000);

    beforeEach(async () => {
      resetProviderCircuitBreakersForTests();
      behaviour = { kind: "ok" };
      accepted = [];
      await resetDatabase();
      await seedTenant(TENANT_A, "uo-a", STAFF_A);
      await seedProduct(TENANT_A, STAFF_A);
    }, 60000);

    afterEach(() => {
      behaviour = { kind: "ok" };
    });

    test("H1 a timeout does not abort the remote call: the provider accepted AFTER the caller gave up, and the caller stored nothing", async () => {
      behaviour = { kind: "slow_accept", delayMs: 400 };
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");

      const outcome = await create(orderCode, adapter(100));
      expect(outcome.kind).toBe("gateway_unavailable");
      // timeout != no provider side effect: the stub recorded the session.
      expect(accepted).toEqual([`${orderCode}-1`]);
      expect(await sessionsOf(orderId)).toEqual([]);
      expect(await legs(orderId)).toEqual([]);
      await new Promise((r) => setTimeout(r, 450));
      expect(accepted).toEqual([`${orderCode}-1`]);
    });

    for (const status of [429, 500, 503]) {
      test(`H2 HTTP ${status} from the provider: gateway_unavailable, nothing persisted`, async () => {
        behaviour = { kind: "status", status };
        const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
        expect((await create(orderCode, adapter())).kind).toBe(
          "gateway_unavailable"
        );
        expect(await sessionsOf(orderId)).toEqual([]);
        expect(await legs(orderId)).toEqual([]);
      });
    }

    test("H3 a malformed 200 body after the provider recorded the session: gateway_unavailable, nothing persisted", async () => {
      behaviour = { kind: "malformed" };
      const { orderCode, orderId } = await placeOrder(TENANT_A, "gateway");
      expect((await create(orderCode, adapter())).kind).toBe(
        "gateway_unavailable"
      );
      expect(accepted).toEqual([`${orderCode}-1`]);
      expect(await sessionsOf(orderId)).toEqual([]);
      expect(await legs(orderId)).toEqual([]);
    });
  }
);
