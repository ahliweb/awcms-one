/**
 * Payment-allocation ledger integration (Issue #285, epic #281, ADR-0025) —
 * against a REAL migrated Postgres through `tests/integration/harness.ts`,
 * the same pattern `commerce-pos`/`commerce-payment-webhook` use. Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * Covers exactly the properties only a real database can prove:
 *
 *   - split exact settlement: partial -> final tender moves the order to
 *     `paid` exactly once; overpayment is refused for every tender except
 *     cash change; change is computed under the order-row lock;
 *   - idempotency: replay / conflict / another actor / another order, plus the
 *     ledger's own `source_key` guard (accepted confirmation, webhook replay);
 *   - GENUINELY concurrent final allocations (two transactions, two pooled
 *     connections) can never over-settle, and concurrent reversals can never
 *     reverse more than was paid;
 *   - reversals are compensating rows that never move the lifecycle;
 *   - the append-only guarantees (trigger + REVOKE DELETE), RLS cross-tenant
 *     isolation, tenant-safe composite FKs and BOLA (an id of another order /
 *     tenant is the same 404);
 *   - the existing flows write the ledger: accepted manual-transfer
 *     confirmation, the Midtrans-shaped webhook (pending leg -> succeeded,
 *     replay-safe) and the reconcile job, POS single/multi tender and a due
 *     balance;
 *   - the one-time backfill (`sql/943`) is deterministic and idempotent;
 *   - the tender-mix and outstanding-balance reports.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
import {
  createOrderFromCart,
  createPaymentConfirmation,
  expireOrderBySystem,
  IdempotencyPayloadMismatchError,
  listExpirableOrderIds,
  PaymentNotSettledError,
  reviewPaymentConfirmation,
  updateOrderStatusByAdmin
} from "../../src/modules/commerce/application/order-directory";
import {
  createGatewaySession,
  type CreateGatewaySessionAuth
} from "../../src/modules/commerce/application/payment-gateway-directory";
import { applyVerifiedWebhookEvent } from "../../src/modules/commerce/application/payment-webhook-intake";
import { reconcilePendingSessionsForTenant } from "../../src/modules/commerce/application/payment-reconcile";
import {
  AllocationSourceKeyConflictError,
  fetchOrderPaymentSummary,
  listAllocationsForOrder,
  listOutstandingBalances,
  listTenderMix,
  ReversalExceedsPaymentError
} from "../../src/modules/commerce/application/payment-allocation-directory";
import {
  recordOwnerPayment,
  recordOwnerReversal
} from "../../src/modules/commerce/application/payment-recording";
import {
  createPosOrder,
  listPosOrders,
  PosDueRequiresCustomerError
} from "../../src/modules/commerce/application/pos-directory";
import { createLogPaymentGatewayProvider } from "../../src/modules/commerce/infrastructure/log-payment-gateway-provider";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import {
  InsufficientTenderError,
  type CreatePosOrderInput
} from "../../src/modules/commerce/domain/pos-order-validation";
import {
  OverpaymentError,
  type RecordPaymentInput,
  type RecordReversalInput
} from "../../src/modules/commerce/domain/payment-allocation";
import { normalizePhoneNumber } from "../../src/modules/commerce/domain/phone-normalisation";
import { resolveSalesReportDay } from "../../src/modules/commerce/domain/sales-report-deltas";
import { SALES_REPORT_TIME_ZONE } from "../../src/modules/commerce/domain/sales-report-deltas";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
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

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const STAFF_1 = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const STAFF_2 = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const NOW = new Date();

const LOG_PROVIDER = createLogPaymentGatewayProvider({
  storefrontPublicUrl: "https://toko.example.com",
  now: () => NOW
});

/**
 * `expect(query).rejects` needs a real Promise; a `Bun.SQL` query is a lazy
 * thenable that is only executed when awaited, so route it through one.
 */
async function attempt(query: PromiseLike<unknown>): Promise<void> {
  await query;
}

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(id: string, code: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedTenantUser(
  tenantId: string,
  actorId: string
): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Payments Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`pay-actor-${actorId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${actorId}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function enableSelfPickupQrisGateway(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Uji Pembayaran",
    shipping: { selfPickup: true },
    payment: {
      manualQris: { active: true, mediaObjectId: null },
      gateway: { enabled: true }
    }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, STAFF_1, validated.value)
  );
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-PAY",
  name: "Kopi Susu",
  slug: "kopi-susu-pay",
  description: null,
  digitalNote: null,
  price: "10000.00",
  discountPercent: 0,
  stock: 100,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 250,
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
  allowDp: false,
  allowFreeShipping: true,
  variantAttributes: null,
  isFeatured: false,
  isRecommended: false
};

async function seedActiveProduct(
  tenantId: string,
  sku = "SKU-PAY"
): Promise<string> {
  const product = await inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, STAFF_1, {
      ...BASE_PRODUCT,
      sku,
      slug: `${sku}-slug`
    })
  );
  await inTenant(
    tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  return product.id;
}

const CUSTOMER_PHONE = "0813-1111-2222";

/** A storefront order (total 10000.00 per unit) — returns `{ id, code }`. */
async function createStorefrontOrder(
  tenantId: string,
  productId: string,
  method: "manual_qris" | "gateway" = "manual_qris",
  quantity = 1
): Promise<{ id: string; code: string }> {
  const input: CreateOrderInput = {
    idempotencyKey: crypto.randomUUID(),
    customer: { name: "Budi", phone: CUSTOMER_PHONE, email: null },
    address: null,
    lines: [{ productId, variantId: null, quantity, serviceFormValues: null }],
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
    throw new Error(`expected an order, got ${JSON.stringify(result)}`);
  }
  const code = result.order.orderCode;
  const rows = (await getAdminSql()`
    SELECT id FROM awcms_commerce_orders WHERE tenant_id = ${tenantId} AND order_code = ${code}
  `) as { id: string }[];
  return { id: rows[0]!.id, code };
}

function recordInput(
  overrides: Partial<RecordPaymentInput> = {}
): RecordPaymentInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    tenderType: "manual_bank_transfer",
    amount: "10000.00",
    reference: null,
    note: null,
    ...overrides
  };
}

function reversalInput(
  overrides: Partial<RecordReversalInput> = {}
): RecordReversalInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    amount: null,
    note: "customer returned the goods",
    ...overrides
  };
}

async function pay(
  tenantId: string,
  orderId: string,
  input: RecordPaymentInput,
  actor = STAFF_1
) {
  return inTenant(tenantId, (tx) =>
    recordOwnerPayment(tx, tenantId, actor, orderId, input)
  );
}

async function reverse(
  tenantId: string,
  orderId: string,
  paymentId: string,
  input: RecordReversalInput,
  actor = STAFF_1
) {
  return inTenant(tenantId, (tx) =>
    recordOwnerReversal(tx, tenantId, actor, orderId, paymentId, input)
  );
}

async function orderRow(
  tenantId: string,
  orderId: string
): Promise<{
  status: string;
  payment_status: string;
  paid_at: Date | null;
  expires_at: Date | null;
}> {
  const rows = (await getAdminSql()`
    SELECT status, payment_status, paid_at, expires_at
    FROM awcms_commerce_orders WHERE tenant_id = ${tenantId} AND id = ${orderId}
  `) as {
    status: string;
    payment_status: string;
    paid_at: Date | null;
    expires_at: Date | null;
  }[];
  return rows[0]!;
}

async function countRows(
  table: string,
  where: string,
  ...values: unknown[]
): Promise<number> {
  const rows = (await getAdminSql().unsafe(
    `SELECT count(*)::int AS count FROM ${table} WHERE ${where}`,
    values as never[]
  )) as { count: number }[];
  return rows[0]!.count;
}

async function paidTransitions(orderId: string): Promise<number> {
  return countRows(
    "awcms_commerce_order_events",
    "order_id = $1 AND to_status = 'paid'",
    orderId
  );
}

async function domainEventCount(
  tenantId: string,
  eventType: string
): Promise<number> {
  return countRows(
    "awcms_domain_events",
    "tenant_id = $1 AND event_type = $2",
    tenantId,
    eventType
  );
}

suite("commerce payment-allocation ledger (Issue #285)", () => {
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
    await seedTenant(TENANT_A, "tenant-pay-a");
    await seedTenant(TENANT_B, "tenant-pay-b");
    await enableSelfPickupQrisGateway(TENANT_A);
    await enableSelfPickupQrisGateway(TENANT_B);
    await seedTenantUser(TENANT_A, STAFF_1);
    await seedTenantUser(TENANT_A, STAFF_2);
    await seedTenantUser(TENANT_B, STAFF_1.replace(/^c/, "e"));
  }, 30000);

  // -------------------------------------------------------------------------
  // Split exact settlement / over- and underpayment
  // -------------------------------------------------------------------------

  describe("recording tenders", () => {
    test("split tender settles exactly: partial leaves the order awaiting payment, the final leg releases it to paid exactly once", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);

      const first = await pay(
        TENANT_A,
        order.id,
        recordInput({ tenderType: "manual_bank_transfer", amount: "4000.00" })
      );
      expect(first.kind).toBe("created");
      if (first.kind !== "created") return;
      expect(first.body.settlement).toMatchObject({
        total: "10000.00",
        paid: "4000.00",
        outstanding: "6000.00",
        paymentStatus: "partially_paid"
      });
      expect(await orderRow(TENANT_A, order.id)).toMatchObject({
        status: "pending_payment",
        payment_status: "partially_paid"
      });
      expect(await paidTransitions(order.id)).toBe(0);

      const second = await pay(
        TENANT_A,
        order.id,
        recordInput({ tenderType: "manual_qris", amount: "6000.00" })
      );
      expect(second.kind).toBe("created");
      if (second.kind !== "created") return;
      expect(second.body.settlement).toMatchObject({
        paid: "10000.00",
        outstanding: "0.00",
        paymentStatus: "paid"
      });

      const row = await orderRow(TENANT_A, order.id);
      expect(row.status).toBe("paid");
      expect(row.payment_status).toBe("paid");
      expect(row.paid_at).not.toBeNull();
      expect(await paidTransitions(order.id)).toBe(1);

      // The ledger, the audit trail and the events all say so.
      const ledger = await inTenant(TENANT_A, (tx) =>
        listAllocationsForOrder(tx, TENANT_A, order.id)
      );
      expect(ledger.map((leg) => [leg.tenderType, leg.amount])).toEqual([
        ["manual_bank_transfer", "4000.00"],
        ["manual_qris", "6000.00"]
      ]);
      expect(
        await domainEventCount(TENANT_A, "awcms.commerce.payment.recorded")
      ).toBe(2);
      expect(
        await countRows(
          "awcms_audit_events",
          "tenant_id = $1 AND action = 'payment.record'",
          TENANT_A
        )
      ).toBe(2);
    });

    test("a non-cash overpayment is refused and writes nothing", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);

      let caught: unknown;
      try {
        await pay(
          TENANT_A,
          order.id,
          recordInput({ tenderType: "manual_qris", amount: "10000.01" })
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OverpaymentError);
      expect((caught as OverpaymentError).outstanding).toBe("10000.00");
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          order.id
        )
      ).toBe(0);
    });

    test("a cash leg may exceed the balance only as change, computed from the cash leg alone", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);

      await pay(
        TENANT_A,
        order.id,
        recordInput({ tenderType: "manual_qris", amount: "7000.00" })
      );
      // 3000.00 left; the customer hands over 5000.00 -> 3000.00 applied, 2000.00 change.
      const cash = await pay(
        TENANT_A,
        order.id,
        recordInput({ tenderType: "cash", amount: "5000.00" })
      );
      expect(cash.kind).toBe("created");
      if (cash.kind !== "created") return;
      expect(cash.body.payment).toMatchObject({
        tenderType: "cash",
        amount: "3000.00",
        tenderedAmount: "5000.00",
        changeAmount: "2000.00"
      });
      expect(cash.body.settlement.paymentStatus).toBe("paid");
      expect(await orderRow(TENANT_A, order.id)).toMatchObject({
        status: "paid"
      });
    });

    test("cash against an order with nothing left to pay would only manufacture change — refused", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      await pay(TENANT_A, order.id, recordInput({ amount: "10000.00" }));

      await expect(
        pay(
          TENANT_A,
          order.id,
          recordInput({ tenderType: "cash", amount: "500.00" })
        )
      ).rejects.toBeInstanceOf(OverpaymentError);
    });

    test("a cancelled or expired order cannot receive a payment", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      await inTenant(TENANT_A, (tx) =>
        updateOrderStatusByAdmin(
          tx,
          TENANT_A,
          STAFF_1,
          order.id,
          "cancelled",
          null
        )
      );
      const outcome = await pay(TENANT_A, order.id, recordInput());
      expect(outcome).toEqual({
        kind: "order_not_payable",
        orderStatus: "cancelled"
      });
    });

    test("a manual -> paid status override on an order with NO ledger leg records one full-amount manual leg, audits it, releases the order, and replays safely", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);

      const updated = await inTenant(TENANT_A, (tx) =>
        updateOrderStatusByAdmin(
          tx,
          TENANT_A,
          STAFF_1,
          order.id,
          "paid",
          "cash on pickup"
        )
      );
      expect(updated).toBe(true);
      expect((await orderRow(TENANT_A, order.id)).status).toBe("paid");
      expect((await orderRow(TENANT_A, order.id)).payment_status).toBe("paid");

      const legs = await inTenant(TENANT_A, (tx) =>
        listAllocationsForOrder(tx, TENANT_A, order.id)
      );
      expect(legs).toHaveLength(1);
      expect(legs[0]).toMatchObject({
        kind: "payment",
        status: "succeeded",
        amount: "10000.00",
        tenderType: "manual_qris",
        source: "admin",
        actorKind: "tenant_user",
        actorTenantUserId: STAFF_1
      });
      expect(
        await countRows(
          "awcms_audit_events",
          "tenant_id = $1 AND resource_id = $2 AND action = 'payment.record'",
          TENANT_A,
          legs[0]!.id
        )
      ).toBe(1);
      expect(await paidTransitions(order.id)).toBe(1);

      // A replay finds the order already paid: the status machine refuses it
      // and no second leg is ever written.
      await expect(
        inTenant(TENANT_A, (tx) =>
          updateOrderStatusByAdmin(
            tx,
            TENANT_A,
            STAFF_1,
            order.id,
            "paid",
            null
          )
        )
      ).rejects.toBeInstanceOf(Error);
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          order.id
        )
      ).toBe(1);
    });

    test("a manual -> paid override on an order that HAS legs but is not settled is refused with the outstanding amount, and writes nothing", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      await pay(TENANT_A, order.id, recordInput({ amount: "4000.00" }));

      let caught: unknown;
      try {
        await inTenant(TENANT_A, (tx) =>
          updateOrderStatusByAdmin(
            tx,
            TENANT_A,
            STAFF_1,
            order.id,
            "paid",
            null
          )
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PaymentNotSettledError);
      expect((caught as PaymentNotSettledError).outstanding).toBe("6000.00");
      expect((await orderRow(TENANT_A, order.id)).status).toBe(
        "pending_payment"
      );
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          order.id
        )
      ).toBe(1);
    });

    test("a down-payment order is released at its down payment, stays dp_paid, and settles fully on the top-up", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      await getAdminSql()`
        UPDATE awcms_commerce_orders
        SET payment_method = 'dp', dp_amount = '3000.00'
        WHERE id = ${order.id}
      `;

      const dp = await pay(
        TENANT_A,
        order.id,
        recordInput({ amount: "3000.00" })
      );
      expect(dp.kind).toBe("created");
      expect(await orderRow(TENANT_A, order.id)).toMatchObject({
        status: "paid",
        payment_status: "dp_paid"
      });

      await pay(TENANT_A, order.id, recordInput({ amount: "7000.00" }));
      expect(await orderRow(TENANT_A, order.id)).toMatchObject({
        status: "paid",
        payment_status: "paid"
      });
      // The lifecycle moved to paid ONCE (the top-up is not a second transition).
      expect(await paidTransitions(order.id)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe("idempotency", () => {
    test("the same key + the same payload replays the stored 201 and writes one row", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const input = recordInput({ amount: "2500.00" });

      const first = await pay(TENANT_A, order.id, input);
      const replay = await pay(TENANT_A, order.id, input);
      expect(first.kind).toBe("created");
      expect(replay.kind).toBe("replayed");
      if (first.kind !== "created" || replay.kind !== "replayed") return;
      expect(replay.body.payment.id).toBe(first.body.payment.id);
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          order.id
        )
      ).toBe(1);
    });

    test("the same key with a different payload, another actor, or another order is a conflict", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const other = await createStorefrontOrder(TENANT_A, productId);
      const input = recordInput({ amount: "2500.00" });
      await pay(TENANT_A, order.id, input);

      await expect(
        pay(TENANT_A, order.id, { ...input, amount: "2600.00" })
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
      await expect(
        pay(TENANT_A, order.id, input, STAFF_2)
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
      await expect(pay(TENANT_A, other.id, input)).rejects.toBeInstanceOf(
        IdempotencyPayloadMismatchError
      );
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "tenant_id = $1",
          TENANT_A
        )
      ).toBe(1);
    });

    test("with the idempotency store forgotten, the same key aimed at another order is an AllocationSourceKeyConflictError (route: 409 IDEMPOTENCY_CONFLICT)", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const other = await createStorefrontOrder(TENANT_A, productId);
      const input = recordInput({ amount: "2500.00" });
      await pay(TENANT_A, order.id, input);
      await getAdminSql()`DELETE FROM awcms_idempotency_keys WHERE tenant_id = ${TENANT_A}`;

      await expect(pay(TENANT_A, other.id, input)).rejects.toBeInstanceOf(
        AllocationSourceKeyConflictError
      );

      // Same for a reversal key reused against another order's payment.
      const first = await pay(
        TENANT_A,
        order.id,
        recordInput({ amount: "3000.00" })
      );
      if (first.kind !== "created") throw new Error("expected created");
      const rev = reversalInput({ amount: "1000.00" });
      await reverse(TENANT_A, order.id, first.body.payment.id, rev);
      await getAdminSql()`DELETE FROM awcms_idempotency_keys WHERE tenant_id = ${TENANT_A}`;
      const otherPay = await pay(
        TENANT_A,
        other.id,
        recordInput({ amount: "3000.00" })
      );
      if (otherPay.kind !== "created") throw new Error("expected created");
      await expect(
        reverse(TENANT_A, other.id, otherPay.body.payment.id, rev)
      ).rejects.toBeInstanceOf(AllocationSourceKeyConflictError);
    });

    test("with the idempotency store forgotten, a reused key with a different amount or tender is a conflict, never a silent replay of the old row", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const input = recordInput({ amount: "2500.00" });
      await pay(TENANT_A, order.id, input);
      await getAdminSql()`DELETE FROM awcms_idempotency_keys WHERE tenant_id = ${TENANT_A}`;

      await expect(
        pay(TENANT_A, order.id, { ...input, amount: "2600.00" })
      ).rejects.toBeInstanceOf(AllocationSourceKeyConflictError);
      await expect(
        pay(TENANT_A, order.id, { ...input, tenderType: "manual_qris" })
      ).rejects.toBeInstanceOf(AllocationSourceKeyConflictError);
      // The identical request is still a clean replay.
      expect((await pay(TENANT_A, order.id, input)).kind).toBe("replayed");

      // A reversal replayed with a different amount.
      const first = await pay(
        TENANT_A,
        order.id,
        recordInput({ amount: "3000.00" })
      );
      if (first.kind !== "created") throw new Error("expected created");
      const rev = reversalInput({ amount: "1000.00" });
      await reverse(TENANT_A, order.id, first.body.payment.id, rev);
      await getAdminSql()`DELETE FROM awcms_idempotency_keys WHERE tenant_id = ${TENANT_A}`;
      await expect(
        reverse(TENANT_A, order.id, first.body.payment.id, {
          ...rev,
          amount: "1500.00"
        })
      ).rejects.toBeInstanceOf(AllocationSourceKeyConflictError);
      expect(
        (await reverse(TENANT_A, order.id, first.body.payment.id, rev)).kind
      ).toBe("replayed");
    });

    test("a POS sale whose key collides with an existing ledger leg of another order is an AllocationSourceKeyConflictError", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const key = crypto.randomUUID();
      const posInput = (): CreatePosOrderInput => ({
        idempotencyKey: key,
        customer: { name: null, phone: null },
        lines: [{ productId, variantId: null, quantity: 1 }],
        payment: null,
        tenders: [{ tenderType: "cash", amount: "10000.00", reference: null }],
        allowDue: false,
        notes: null
      });
      const ring = () =>
        inTenant(TENANT_A, (tx) =>
          createPosOrder(
            tx,
            TENANT_A,
            STAFF_1,
            mediaLibraryPortAdapter,
            posInput(),
            NOW
          )
        );
      expect((await ring()).kind).toBe("created");
      await getAdminSql()`DELETE FROM awcms_idempotency_keys WHERE tenant_id = ${TENANT_A}`;
      await expect(ring()).rejects.toBeInstanceOf(
        AllocationSourceKeyConflictError
      );
    });

    test("the ledger's own source_key is a second guard even when the idempotency store forgets", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const input = recordInput({ amount: "2500.00" });
      await pay(TENANT_A, order.id, input);

      // Lose the store row (an aged-out key reused by a retry).
      await getAdminSql()`DELETE FROM awcms_idempotency_keys WHERE tenant_id = ${TENANT_A}`;

      const again = await pay(TENANT_A, order.id, input);
      expect(again.kind).toBe("replayed");
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          order.id
        )
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency — genuinely concurrent transactions
  // -------------------------------------------------------------------------

  describe("concurrency", () => {
    test("two concurrent FINAL allocations can never over-settle: exactly one wins, the loser is an overpayment", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      await pay(TENANT_A, order.id, recordInput({ amount: "4000.00" }));

      // Two separate transactions on two pooled connections, both asking to
      // settle the same remaining 6000.00.
      const results = await Promise.allSettled([
        pay(
          TENANT_A,
          order.id,
          recordInput({ tenderType: "manual_qris", amount: "6000.00" })
        ),
        pay(
          TENANT_A,
          order.id,
          recordInput({ tenderType: "manual_bank_transfer", amount: "6000.00" })
        )
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        OverpaymentError
      );

      const summary = await inTenant(TENANT_A, (tx) =>
        fetchOrderPaymentSummary(tx, TENANT_A, order.id)
      );
      expect(summary!.settlement).toMatchObject({
        paid: "10000.00",
        outstanding: "0.00",
        overpaid: "0.00",
        paymentStatus: "paid"
      });
      expect(await paidTransitions(order.id)).toBe(1);
    });

    test("many concurrent small payments sum to the total and release the order exactly once", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          pay(TENANT_A, order.id, recordInput({ amount: "2000.00" }))
        )
      );
      // 6 x 2000 = 12000 > 10000: exactly five fit.
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      expect(
        results
          .filter((r) => r.status === "rejected")
          .every(
            (r) =>
              (r as PromiseRejectedResult).reason instanceof OverpaymentError
          )
      ).toBe(true);
      expect(await paidTransitions(order.id)).toBe(1);
      expect((await orderRow(TENANT_A, order.id)).payment_status).toBe("paid");
    });

    test("concurrent reversals can never reverse more than was paid", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const paid = await pay(
        TENANT_A,
        order.id,
        recordInput({ amount: "10000.00" })
      );
      if (paid.kind !== "created") throw new Error("setup");

      const results = await Promise.allSettled([
        reverse(
          TENANT_A,
          order.id,
          paid.body.payment.id,
          reversalInput({ amount: "6000.00" })
        ),
        reverse(
          TENANT_A,
          order.id,
          paid.body.payment.id,
          reversalInput({ amount: "6000.00" })
        )
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(
        (r) => r.status === "rejected"
      ) as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ReversalExceedsPaymentError);
      expect((rejected.reason as ReversalExceedsPaymentError).reversible).toBe(
        "4000.00"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Reversals
  // -------------------------------------------------------------------------

  describe("reversals", () => {
    test("compensating rows lower settlement and payment status but never move the order lifecycle", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const paid = await pay(
        TENANT_A,
        order.id,
        recordInput({ amount: "10000.00" })
      );
      if (paid.kind !== "created") throw new Error("setup");
      const paymentId = paid.body.payment.id;

      const partial = await reverse(
        TENANT_A,
        order.id,
        paymentId,
        reversalInput({ amount: "3000.00" })
      );
      expect(partial.kind).toBe("created");
      if (partial.kind !== "created") return;
      expect(partial.body.payment).toMatchObject({
        kind: "reversal",
        reversesAllocationId: paymentId,
        tenderType: "manual_bank_transfer",
        amount: "3000.00"
      });
      expect(partial.body.settlement).toMatchObject({
        paid: "10000.00",
        reversed: "3000.00",
        settled: "7000.00",
        outstanding: "3000.00",
        paymentStatus: "partially_paid"
      });
      // The lifecycle stays paid: money going back is a human decision about fulfilment.
      expect((await orderRow(TENANT_A, order.id)).status).toBe("paid");

      // Default amount = everything still reversible.
      const rest = await reverse(
        TENANT_A,
        order.id,
        paymentId,
        reversalInput()
      );
      expect(rest.kind).toBe("created");
      if (rest.kind !== "created") return;
      expect(rest.body.payment.amount).toBe("7000.00");
      expect(rest.body.settlement.paymentStatus).toBe("refunded");

      const again = await reverse(
        TENANT_A,
        order.id,
        paymentId,
        reversalInput()
      );
      expect(again).toEqual({
        kind: "not_reversible",
        reason: "fully_reversed"
      });
      expect(
        await domainEventCount(TENANT_A, "awcms.commerce.payment.reversed")
      ).toBe(2);
    });

    test("a reversal cannot exceed the payment, and a reversal cannot be reversed", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const paid = await pay(
        TENANT_A,
        order.id,
        recordInput({ amount: "10000.00" })
      );
      if (paid.kind !== "created") throw new Error("setup");

      await expect(
        reverse(
          TENANT_A,
          order.id,
          paid.body.payment.id,
          reversalInput({ amount: "10000.01" })
        )
      ).rejects.toBeInstanceOf(ReversalExceedsPaymentError);

      const done = await reverse(
        TENANT_A,
        order.id,
        paid.body.payment.id,
        reversalInput({ amount: "1.00" })
      );
      if (done.kind !== "created") throw new Error("setup");
      expect(
        await reverse(TENANT_A, order.id, done.body.payment.id, reversalInput())
      ).toEqual({ kind: "not_reversible", reason: "not_a_payment" });
    });

    test("reversal idempotency: replay returns the same row, a different payload is a conflict", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const paid = await pay(
        TENANT_A,
        order.id,
        recordInput({ amount: "10000.00" })
      );
      if (paid.kind !== "created") throw new Error("setup");

      const input = reversalInput({ amount: "2000.00" });
      const first = await reverse(
        TENANT_A,
        order.id,
        paid.body.payment.id,
        input
      );
      const replay = await reverse(
        TENANT_A,
        order.id,
        paid.body.payment.id,
        input
      );
      expect(first.kind).toBe("created");
      expect(replay.kind).toBe("replayed");
      await expect(
        reverse(TENANT_A, order.id, paid.body.payment.id, {
          ...input,
          amount: "2100.00"
        })
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1 AND kind = 'reversal'",
          order.id
        )
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Security: append-only, RLS, tenant-safe references, BOLA
  // -------------------------------------------------------------------------

  describe("security", () => {
    test("the ledger is append-only for the runtime role: no DELETE, no amount edit; a pending leg may only resolve", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const paid = await pay(
        TENANT_A,
        order.id,
        recordInput({ amount: "1000.00" })
      );
      if (paid.kind !== "created") throw new Error("setup");

      await expect(
        inTenant(
          TENANT_A,
          (tx) =>
            tx`DELETE FROM awcms_commerce_payment_allocations WHERE id = ${paid.body.payment.id}`
        )
      ).rejects.toThrow();
      await expect(
        inTenant(
          TENANT_A,
          (tx) =>
            tx`UPDATE awcms_commerce_payment_allocations SET amount = '9.00' WHERE id = ${paid.body.payment.id}`
        )
      ).rejects.toThrow(/append-only/);
      // A succeeded leg cannot be flipped to failed to "undo" it.
      await expect(
        inTenant(
          TENANT_A,
          (tx) =>
            tx`UPDATE awcms_commerce_payment_allocations SET status = 'failed' WHERE id = ${paid.body.payment.id}`
        )
      ).rejects.toThrow(/append-only/);

      // A pending gateway leg may resolve — and only that column pair may change.
      await getAdminSql()`
        INSERT INTO awcms_commerce_payment_allocations
          (tenant_id, order_id, kind, tender_type, amount, status, provider, provider_reference,
           source, source_key, actor_kind)
        VALUES (${TENANT_A}, ${order.id}, 'payment', 'gateway', '500.00', 'pending', 'log', 'ref-x',
           'gateway_checkout', 'gateway:log:ref-x', 'system')
      `;
      await expect(
        inTenant(
          TENANT_A,
          (tx) =>
            tx`UPDATE awcms_commerce_payment_allocations SET amount = '1.00' WHERE source_key = 'gateway:log:ref-x'`
        )
      ).rejects.toThrow(/append-only/);
      await inTenant(
        TENANT_A,
        (tx) =>
          tx`UPDATE awcms_commerce_payment_allocations SET status = 'failed', settled_at = now() WHERE source_key = 'gateway:log:ref-x'`
      );
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "source_key = 'gateway:log:ref-x' AND status = 'failed'"
        )
      ).toBe(1);
    });

    test("RLS: another tenant sees no ledger rows, and cannot insert a row for tenant A", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      await pay(TENANT_A, order.id, recordInput({ amount: "1000.00" }));

      const seenByB = await inTenant(
        TENANT_B,
        (tx) => tx`SELECT id FROM awcms_commerce_payment_allocations`
      );
      expect(seenByB).toHaveLength(0);

      // WITH CHECK: tenant B's context cannot write a row stamped tenant A.
      await expect(
        inTenant(
          TENANT_B,
          (tx) =>
            tx`INSERT INTO awcms_commerce_payment_allocations
              (tenant_id, order_id, kind, tender_type, amount, source, source_key, actor_kind, settled_at)
             VALUES (${TENANT_A}, ${order.id}, 'payment', 'cash', '1.00', 'admin', 'x-rls', 'system', now())`
        )
      ).rejects.toThrow(/row-level security/i);
    });

    test("tenant-safe composite FK: a row of tenant B cannot point at tenant A's order or payment, even bypassing RLS", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const paid = await pay(
        TENANT_A,
        order.id,
        recordInput({ amount: "1000.00" })
      );
      if (paid.kind !== "created") throw new Error("setup");

      await expect(
        attempt(getAdminSql()`
          INSERT INTO awcms_commerce_payment_allocations
            (tenant_id, order_id, kind, tender_type, amount, source, source_key, actor_kind, settled_at)
          VALUES (${TENANT_B}, ${order.id}, 'payment', 'cash', '1.00', 'admin', 'x-fk', 'system', now())`)
      ).rejects.toThrow(/foreign key/i);

      const orderB = await createStorefrontOrder(
        TENANT_B,
        await seedActiveProduct(TENANT_B, "SKU-B")
      );
      await expect(
        attempt(getAdminSql()`
          INSERT INTO awcms_commerce_payment_allocations
            (tenant_id, order_id, kind, reverses_allocation_id, tender_type, amount, source, source_key, actor_kind, settled_at)
          VALUES (${TENANT_B}, ${orderB.id}, 'reversal', ${paid.body.payment.id}, 'cash', '1.00', 'admin', 'x-fk2', 'system', now())`)
      ).rejects.toThrow(/foreign key/i);
    });

    test("BOLA: another tenant's order, an unknown order and a payment of a different order are all the same not-found", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order1 = await createStorefrontOrder(TENANT_A, productId);
      const order2 = await createStorefrontOrder(TENANT_A, productId);
      const paid = await pay(
        TENANT_A,
        order1.id,
        recordInput({ amount: "1000.00" })
      );
      if (paid.kind !== "created") throw new Error("setup");

      // Tenant B acting on tenant A's order id.
      expect(await pay(TENANT_B, order1.id, recordInput())).toEqual({
        kind: "order_not_found"
      });
      expect(
        await reverse(
          TENANT_B,
          order1.id,
          paid.body.payment.id,
          reversalInput()
        )
      ).toEqual({ kind: "not_found" });
      expect(
        await inTenant(TENANT_B, (tx) =>
          fetchOrderPaymentSummary(tx, TENANT_B, order1.id)
        )
      ).toBeNull();

      // A payment of order 1 addressed through order 2's path.
      expect(
        await reverse(
          TENANT_A,
          order2.id,
          paid.body.payment.id,
          reversalInput()
        )
      ).toEqual({ kind: "not_found" });
      // An unknown order id.
      expect(
        await pay(
          TENANT_A,
          "00000000-0000-4000-8000-000000000000",
          recordInput()
        )
      ).toEqual({ kind: "order_not_found" });
    });
  });

  // -------------------------------------------------------------------------
  // Existing flows write the ledger
  // -------------------------------------------------------------------------

  describe("manual-transfer confirmations", () => {
    const phone = (): string => {
      const result = normalizePhoneNumber(CUSTOMER_PHONE);
      if (!result.valid) throw new Error("fixture phone");
      return result.value;
    };

    async function submitConfirmation(
      orderCode: string,
      amount: string
    ): Promise<string> {
      await inTenant(TENANT_A, (tx) =>
        createPaymentConfirmation(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          orderCode,
          phone(),
          {
            method: "manual_qris",
            amount,
            bankName: null,
            accountName: null,
            transferredAt: null,
            proofMediaObjectId: null
          }
        )
      );
      const rows = (await getAdminSql()`
        SELECT id FROM awcms_commerce_payment_confirmations
        WHERE tenant_id = ${TENANT_A} AND status = 'submitted'
        ORDER BY created_at DESC LIMIT 1
      `) as { id: string }[];
      return rows[0]!.id;
    }

    test("accepting a confirmation for the full amount records a ledger leg and releases the order", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const confirmationId = await submitConfirmation(order.code, "10000.00");

      const accepted = await inTenant(TENANT_A, (tx) =>
        reviewPaymentConfirmation(
          tx,
          TENANT_A,
          STAFF_1,
          order.id,
          confirmationId,
          "accepted"
        )
      );
      expect(accepted).toBe(true);

      const ledger = await inTenant(TENANT_A, (tx) =>
        listAllocationsForOrder(tx, TENANT_A, order.id)
      );
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        tenderType: "manual_qris",
        amount: "10000.00",
        source: "storefront_manual",
        actorKind: "tenant_user",
        actorTenantUserId: STAFF_1
      });
      expect(await orderRow(TENANT_A, order.id)).toMatchObject({
        status: "paid",
        payment_status: "paid"
      });

      // Reviewing it again is a no-op (the confirmation is no longer `submitted`).
      expect(
        await inTenant(TENANT_A, (tx) =>
          reviewPaymentConfirmation(
            tx,
            TENANT_A,
            STAFF_1,
            order.id,
            confirmationId,
            "accepted"
          )
        )
      ).toBe(false);
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          order.id
        )
      ).toBe(1);
    });

    test("a confirmation for LESS than the total no longer flips the order to paid — the balance is explicit; the top-up completes it", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);

      const first = await submitConfirmation(order.code, "4000.00");
      await inTenant(TENANT_A, (tx) =>
        reviewPaymentConfirmation(
          tx,
          TENANT_A,
          STAFF_1,
          order.id,
          first,
          "accepted"
        )
      );
      expect(await orderRow(TENANT_A, order.id)).toMatchObject({
        status: "pending_payment",
        payment_status: "partially_paid"
      });

      const second = await submitConfirmation(order.code, "6000.00");
      await inTenant(TENANT_A, (tx) =>
        reviewPaymentConfirmation(
          tx,
          TENANT_A,
          STAFF_1,
          order.id,
          second,
          "accepted"
        )
      );
      expect(await orderRow(TENANT_A, order.id)).toMatchObject({
        status: "paid",
        payment_status: "paid"
      });
    });

    test("an accepted amount above what is owed is capped (and the cap is written on the row), never a reason to refuse the acceptance", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const confirmationId = await submitConfirmation(order.code, "12000.00");

      await inTenant(TENANT_A, (tx) =>
        reviewPaymentConfirmation(
          tx,
          TENANT_A,
          STAFF_1,
          order.id,
          confirmationId,
          "accepted"
        )
      );
      const ledger = await inTenant(TENANT_A, (tx) =>
        listAllocationsForOrder(tx, TENANT_A, order.id)
      );
      expect(ledger[0]!.amount).toBe("10000.00");
      expect(ledger[0]!.note).toContain("12000.00");
    });

    test("rejecting a confirmation writes no ledger row", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const confirmationId = await submitConfirmation(order.code, "10000.00");
      await inTenant(TENANT_A, (tx) =>
        reviewPaymentConfirmation(
          tx,
          TENANT_A,
          STAFF_1,
          order.id,
          confirmationId,
          "rejected"
        )
      );
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          order.id
        )
      ).toBe(0);
      expect((await orderRow(TENANT_A, order.id)).status).toBe(
        "pending_payment"
      );
    });
  });

  describe("gateway webhook and reconcile", () => {
    async function liveSession(
      orderCode: string
    ): Promise<{ id: string; providerRef: string }> {
      const auth: CreateGatewaySessionAuth = {
        kind: "phone",
        phone: "081311112222"
      };
      const outcome = await createGatewaySession(
        getRuntimeSql(),
        TENANT_A,
        orderCode,
        auth,
        LOG_PROVIDER,
        "log"
      );
      if (outcome.kind !== "created") {
        throw new Error(`expected a session, got ${JSON.stringify(outcome)}`);
      }
      return outcome.session;
    }

    function paidEvent(providerRef: string, eventKey: string, gross?: string) {
      return {
        provider: "log",
        eventKey,
        providerRef,
        status: "paid" as const,
        ...(gross ? { grossAmount: gross } : {}),
        payload: { fixture: "paid" }
      };
    }

    test("session creation opens a PENDING leg that counts for nothing; the verified webhook resolves it to succeeded and releases the order", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId, "gateway");
      const session = await liveSession(order.code);

      const pending = await inTenant(TENANT_A, (tx) =>
        listAllocationsForOrder(tx, TENANT_A, order.id)
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        tenderType: "gateway",
        status: "pending",
        amount: "10000.00",
        provider: "log",
        providerReference: session.providerRef,
        settledAt: null
      });
      const beforeSummary = await inTenant(TENANT_A, (tx) =>
        fetchOrderPaymentSummary(tx, TENANT_A, order.id)
      );
      expect(beforeSummary!.settlement).toMatchObject({
        paid: "0.00",
        outstanding: "10000.00",
        paymentStatus: "unpaid"
      });
      expect(
        await domainEventCount(TENANT_A, "awcms.commerce.payment.recorded")
      ).toBe(0);

      const result = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        paidEvent(session.providerRef, `${session.providerRef}:200`, "10000.00")
      );
      expect(result).toEqual({ kind: "applied", orderAffected: true });

      const after = await inTenant(TENANT_A, (tx) =>
        listAllocationsForOrder(tx, TENANT_A, order.id)
      );
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        status: "succeeded",
        amount: "10000.00"
      });
      expect(after[0]!.settledAt).not.toBeNull();
      expect(await orderRow(TENANT_A, order.id)).toMatchObject({
        status: "paid",
        payment_status: "paid"
      });
      expect(
        await domainEventCount(TENANT_A, "awcms.commerce.payment.recorded")
      ).toBe(1);
    });

    test("webhook replays never double-allocate — the same event key AND a re-delivery under a new event key", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId, "gateway");
      const session = await liveSession(order.code);

      await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        paidEvent(session.providerRef, `${session.providerRef}:200`)
      );
      const replay = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        paidEvent(session.providerRef, `${session.providerRef}:200`)
      );
      expect(replay).toEqual({ kind: "replay" });

      // The provider re-sends the same payment under a fresh event key.
      const second = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        paidEvent(session.providerRef, `${session.providerRef}:200-b`)
      );
      expect(second.kind).toBe("applied");

      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          order.id
        )
      ).toBe(1);
      expect(await paidTransitions(order.id)).toBe(1);
      expect(
        await domainEventCount(TENANT_A, "awcms.commerce.payment.recorded")
      ).toBe(1);
    });

    test("two genuinely concurrent deliveries of the same payment record it once", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId, "gateway");
      const session = await liveSession(order.code);

      await Promise.all([
        applyVerifiedWebhookEvent(
          getRuntimeSql(),
          TENANT_A,
          paidEvent(session.providerRef, "evt-concurrent-1")
        ),
        applyVerifiedWebhookEvent(
          getRuntimeSql(),
          TENANT_A,
          paidEvent(session.providerRef, "evt-concurrent-2")
        )
      ]);
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1 AND status = 'succeeded'",
          order.id
        )
      ).toBe(1);
      expect(await paidTransitions(order.id)).toBe(1);
    });

    test("an amount-mismatched webhook leaves the leg pending and the order unpaid", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId, "gateway");
      const session = await liveSession(order.code);

      const result = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        paidEvent(session.providerRef, `${session.providerRef}:200`, "1.00")
      );
      expect(result.kind).toBe("amount_mismatch");
      const ledger = await inTenant(TENANT_A, (tx) =>
        listAllocationsForOrder(tx, TENANT_A, order.id)
      );
      expect(ledger[0]).toMatchObject({ status: "pending" });
      expect((await orderRow(TENANT_A, order.id)).status).toBe(
        "pending_payment"
      );
    });

    test("a session that fails or expires resolves its pending leg to failed", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId, "gateway");
      const session = await liveSession(order.code);

      await applyVerifiedWebhookEvent(getRuntimeSql(), TENANT_A, {
        provider: "log",
        eventKey: `${session.providerRef}:failed`,
        providerRef: session.providerRef,
        status: "failed",
        payload: { fixture: "failed" }
      });
      const ledger = await inTenant(TENANT_A, (tx) =>
        listAllocationsForOrder(tx, TENANT_A, order.id)
      );
      expect(ledger[0]).toMatchObject({ status: "failed" });
      expect(ledger[0]!.settledAt).not.toBeNull();
    });

    test("money the provider captured for an order that was meanwhile cancelled is recorded (not dropped); the order is left alone", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId, "gateway");
      const session = await liveSession(order.code);
      await inTenant(TENANT_A, (tx) =>
        updateOrderStatusByAdmin(
          tx,
          TENANT_A,
          STAFF_1,
          order.id,
          "cancelled",
          null
        )
      );

      const result = await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        paidEvent(session.providerRef, `${session.providerRef}:200`)
      );
      expect(result).toEqual({ kind: "applied", orderAffected: false });
      expect((await orderRow(TENANT_A, order.id)).status).toBe("cancelled");
      const ledger = await inTenant(TENANT_A, (tx) =>
        listAllocationsForOrder(tx, TENANT_A, order.id)
      );
      expect(ledger[0]).toMatchObject({
        status: "succeeded",
        amount: "10000.00"
      });
    });

    test("the reconcile job resolves the pending leg too, and a later webhook for the same payment adds nothing", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId, "gateway");
      const session = await liveSession(order.code);
      await getAdminSql()`
        UPDATE awcms_commerce_payment_gateway_sessions
        SET created_at = created_at - interval '5 minutes'
        WHERE id = ${session.id}
      `;
      const later = new Date(NOW.getTime() + 3 * 60_000);
      const reconcileProvider = createLogPaymentGatewayProvider({
        storefrontPublicUrl: "https://toko.example.com",
        now: () => later
      });
      const result = await reconcilePendingSessionsForTenant(
        getRuntimeSql(),
        TENANT_A,
        later,
        reconcileProvider,
        "log",
        "corr-285"
      );
      expect(result.markedPaid).toBe(1);

      const ledger = await inTenant(TENANT_A, (tx) =>
        listAllocationsForOrder(tx, TENANT_A, order.id)
      );
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        status: "succeeded",
        source: "gateway_checkout"
      });

      await applyVerifiedWebhookEvent(
        getRuntimeSql(),
        TENANT_A,
        paidEvent(session.providerRef, `${session.providerRef}:200`)
      );
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          order.id
        )
      ).toBe(1);
      expect(await paidTransitions(order.id)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // POS
  // -------------------------------------------------------------------------

  describe("partially settled orders (gateway sessions and expiry)", () => {
    test("a gateway session is refused for an order that already holds received money, and a settled-then-fully-reversed order may use one again", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId, "gateway");
      const auth: CreateGatewaySessionAuth = {
        kind: "phone",
        phone: "081311112222"
      };
      const open = () =>
        createGatewaySession(
          getRuntimeSql(),
          TENANT_A,
          order.code,
          auth,
          LOG_PROVIDER,
          "log"
        );
      const paid = await pay(
        TENANT_A,
        order.id,
        recordInput({ amount: "4000.00" })
      );
      if (paid.kind !== "created") throw new Error("expected created");

      expect(await open()).toEqual({
        kind: "partially_settled",
        outstanding: "6000.00"
      });
      expect(
        await countRows(
          "awcms_commerce_payment_gateway_sessions",
          "order_id = $1",
          order.id
        )
      ).toBe(0);

      await reverse(TENANT_A, order.id, paid.body.payment.id, reversalInput());
      expect((await open()).kind).toBe("created");
    });

    test("an existing live session is not handed back once money has been received", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId, "gateway");
      const auth: CreateGatewaySessionAuth = {
        kind: "phone",
        phone: "081311112222"
      };
      const open = () =>
        createGatewaySession(
          getRuntimeSql(),
          TENANT_A,
          order.code,
          auth,
          LOG_PROVIDER,
          "log"
        );
      expect((await open()).kind).toBe("created");
      await pay(TENANT_A, order.id, recordInput({ amount: "4000.00" }));
      expect((await open()).kind).toBe("partially_settled");
    });

    test("the expiry job never expires (or restocks) an order that holds received money; an untouched expired order still expires", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const stockOf = async (): Promise<number> => {
        const rows = (await getAdminSql()`
          SELECT stock FROM awcms_commerce_products WHERE id = ${productId}
        `) as { stock: number }[];
        return Number(rows[0]!.stock);
      };
      const part = await createStorefrontOrder(TENANT_A, productId);
      const untouched = await createStorefrontOrder(TENANT_A, productId);
      await pay(TENANT_A, part.id, recordInput({ amount: "4000.00" }));
      await getAdminSql()`
        UPDATE awcms_commerce_orders SET expires_at = now() - interval '1 hour'
        WHERE id IN (${part.id}, ${untouched.id})
      `;
      const stockBefore = await stockOf();

      const ids = await inTenant(TENANT_A, (tx) =>
        listExpirableOrderIds(tx, TENANT_A, new Date())
      );
      expect(ids).toEqual([untouched.id]);

      // Even called directly (a stale scan), the system expiry skips it.
      await inTenant(TENANT_A, (tx) =>
        expireOrderBySystem(tx, TENANT_A, part.id)
      );
      expect((await orderRow(TENANT_A, part.id)).status).toBe(
        "pending_payment"
      );
      expect(await stockOf()).toBe(stockBefore);

      await inTenant(TENANT_A, (tx) =>
        expireOrderBySystem(tx, TENANT_A, untouched.id)
      );
      expect((await orderRow(TENANT_A, untouched.id)).status).toBe("expired");
      expect(await stockOf()).toBe(stockBefore + 1);

      // It stays on the outstanding-balances report.
      const report = await inTenant(TENANT_A, (tx) =>
        listOutstandingBalances(tx, TENANT_A, { channel: null, limit: 50 })
      );
      expect(JSON.stringify(report)).toContain(part.id);
    });
  });

  describe("POS tenders", () => {
    function posInput(
      productId: string,
      overrides: Partial<CreatePosOrderInput> = {}
    ): CreatePosOrderInput {
      return {
        idempotencyKey: crypto.randomUUID(),
        customer: { name: null, phone: null },
        lines: [{ productId, variantId: null, quantity: 3 }], // 30000.00
        payment: null,
        tenders: [{ tenderType: "cash", amount: "30000.00", reference: null }],
        allowDue: false,
        notes: null,
        ...overrides
      };
    }

    function ring(input: CreatePosOrderInput) {
      return inTenant(TENANT_A, (tx) =>
        createPosOrder(
          tx,
          TENANT_A,
          STAFF_1,
          mediaLibraryPortAdapter,
          input,
          NOW
        )
      );
    }

    async function stockOf(productId: string): Promise<number> {
      const rows = (await getAdminSql()`
        SELECT stock FROM awcms_commerce_products WHERE id = ${productId}
      `) as { stock: number }[];
      return Number(rows[0]!.stock);
    }

    test("QRIS + cash split: cash applies to what the QRIS left, change comes from the cash leg only, the order is paid", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const outcome = await ring(
        posInput(productId, {
          tenders: [
            {
              tenderType: "manual_qris",
              amount: "20000.00",
              reference: "RRN-77"
            },
            { tenderType: "cash", amount: "15000.00", reference: null }
          ]
        })
      );
      expect(outcome.kind).toBe("created");
      if (outcome.kind !== "created") return;
      const order = outcome.order;
      expect(order.status).toBe("paid");
      expect(order.change).toBe("5000.00");
      expect(order.amountTendered).toBe("15000.00");
      expect(order.settlement).toMatchObject({
        total: "30000.00",
        paid: "30000.00",
        outstanding: "0.00",
        paymentStatus: "paid"
      });
      expect(
        order.payments!.map((p) => [
          p.tenderType,
          p.amount,
          p.tenderedAmount,
          p.changeAmount
        ])
      ).toEqual([
        ["manual_qris", "20000.00", null, null],
        ["cash", "10000.00", "15000.00", "5000.00"]
      ]);
      expect(order.payments![0]!.providerReference).toBe("RRN-77");
      expect(await paidTransitions(order.id)).toBe(1);
    });

    test("the LEGACY single-tender payload still works, adapted to exactly one ledger leg", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const cash = await ring(
        posInput(productId, {
          payment: { method: "cash", amountTendered: "50000.00" },
          tenders: null
        })
      );
      if (cash.kind !== "created") throw new Error("setup");
      expect(cash.order.change).toBe("20000.00");
      expect(cash.order.payments).toHaveLength(1);
      expect(cash.order.payments![0]).toMatchObject({
        tenderType: "cash",
        amount: "30000.00",
        tenderedAmount: "50000.00",
        changeAmount: "20000.00"
      });

      const qris = await ring(
        posInput(productId, {
          payment: { method: "manual_qris", amountTendered: null },
          tenders: null
        })
      );
      if (qris.kind !== "created") throw new Error("setup");
      expect(qris.order.change).toBeNull();
      expect(qris.order.amountTendered).toBeNull();
      expect(qris.order.payments![0]).toMatchObject({
        tenderType: "manual_qris",
        amount: "30000.00"
      });
      expect(qris.order.status).toBe("paid");
    });

    test("a shortfall behind a non-cash tender is not hidden by cash; overpaying non-cash is refused; nothing is written either way", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const stockBefore = await stockOf(productId);

      await expect(
        ring(
          posInput(productId, {
            tenders: [
              {
                tenderType: "manual_qris",
                amount: "10000.00",
                reference: null
              },
              { tenderType: "cash", amount: "15000.00", reference: null }
            ]
          })
        )
      ).rejects.toBeInstanceOf(InsufficientTenderError);

      await expect(
        ring(
          posInput(productId, {
            tenders: [
              { tenderType: "manual_qris", amount: "30000.01", reference: null }
            ]
          })
        )
      ).rejects.toBeInstanceOf(OverpaymentError);

      expect(await stockOf(productId)).toBe(stockBefore);
      expect(
        await countRows(
          "awcms_commerce_orders",
          "tenant_id = $1 AND channel = 'pos'",
          TENANT_A
        )
      ).toBe(0);
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "tenant_id = $1",
          TENANT_A
        )
      ).toBe(0);
    });

    test("a due balance is explicit: the sale stays awaiting payment with the outstanding amount, never expires, and later payments settle it", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const outcome = await ring(
        posInput(productId, {
          customer: { name: "Siti", phone: "0812-3456-7890" },
          tenders: [
            { tenderType: "cash", amount: "10000.00", reference: null }
          ],
          allowDue: true
        })
      );
      if (outcome.kind !== "created") throw new Error("setup");
      const order = outcome.order;
      expect(order.status).toBe("pending_payment");
      expect(order.settlement).toMatchObject({
        paid: "10000.00",
        outstanding: "20000.00",
        paymentStatus: "partially_paid"
      });
      expect(await stockOf(productId)).toBe(97);
      expect((await orderRow(TENANT_A, order.id)).expires_at).toBeNull();

      // POS history carries the explicit outstanding amount.
      const history = await inTenant(TENANT_A, (tx) =>
        listPosOrders(tx, TENANT_A, null)
      );
      expect(history.items[0]).toMatchObject({
        id: order.id,
        outstanding: "20000.00",
        paymentStatus: "partially_paid"
      });

      // The outstanding-balance report lists it.
      const report = await inTenant(TENANT_A, (tx) =>
        listOutstandingBalances(tx, TENANT_A, { channel: "pos", limit: 10 })
      );
      expect(report.count).toBe(1);
      expect(report.totalOutstanding).toBe("20000.00");
      expect(report.items[0]).toMatchObject({
        orderId: order.id,
        outstanding: "20000.00"
      });

      // Settling the rest releases it.
      const rest = await pay(
        TENANT_A,
        order.id,
        recordInput({ tenderType: "cash", amount: "25000.00" })
      );
      if (rest.kind !== "created") throw new Error("setup");
      expect(rest.body.payment).toMatchObject({
        amount: "20000.00",
        tenderedAmount: "25000.00",
        changeAmount: "5000.00"
      });
      expect(await orderRow(TENANT_A, order.id)).toMatchObject({
        status: "paid",
        payment_status: "paid"
      });
    });

    test("a sale entirely on account (allowDue, no tenders) is unpaid; a due sale for the walk-in customer is refused", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const onAccount = await ring(
        posInput(productId, {
          customer: { name: "Siti", phone: "0812-3456-7890" },
          tenders: [],
          allowDue: true
        })
      );
      if (onAccount.kind !== "created") throw new Error("setup");
      expect(onAccount.order.settlement).toMatchObject({
        paid: "0.00",
        outstanding: "30000.00",
        paymentStatus: "unpaid"
      });
      expect(onAccount.order.payments).toEqual([]);

      await expect(
        ring(posInput(productId, { tenders: [], allowDue: true }))
      ).rejects.toBeInstanceOf(PosDueRequiresCustomerError);
    });

    test("a multi-tender sale is idempotent: replay returns the same receipt and writes one set of legs; a different tender list under the key conflicts", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const input = posInput(productId, {
        tenders: [
          {
            tenderType: "manual_bank_transfer",
            amount: "10000.00",
            reference: null
          },
          { tenderType: "cash", amount: "20000.00", reference: null }
        ]
      });
      const first = await ring(input);
      const replay = await ring(input);
      expect(first.kind).toBe("created");
      expect(replay.kind).toBe("replayed");
      if (first.kind !== "created" || replay.kind !== "replayed") return;
      expect(replay.order.id).toBe(first.order.id);
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          first.order.id
        )
      ).toBe(2);

      await expect(
        ring({
          ...input,
          tenders: [{ tenderType: "cash", amount: "30000.00", reference: null }]
        })
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    });
  });

  // -------------------------------------------------------------------------
  // Backfill (sql/943)
  // -------------------------------------------------------------------------

  describe("backfill", () => {
    const backfillSql = readFileSync(
      join(
        import.meta.dir,
        "../../sql/943_awcms_commerce_payment_allocations_backfill.sql"
      ),
      "utf8"
    );

    async function legacyOrder(options: {
      code: string;
      method: string;
      status: string;
      paymentStatus: string;
      total: string;
      dpAmount?: string | null;
      paidAt?: string | null;
    }): Promise<string> {
      const admin = getAdminSql();
      const customer = (await admin`
        INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
        VALUES (${TENANT_A}, 'Legacy', ${"+62899" + options.code.replace(/\D/g, "").padStart(7, "0")})
        RETURNING id
      `) as { id: string }[];
      const rows = (await admin`
        INSERT INTO awcms_commerce_orders (
          tenant_id, order_code, customer_id, status, payment_method, payment_status,
          shipping_method, subtotal, total, dp_amount, paid_at, created_at
        )
        VALUES (
          ${TENANT_A}, ${options.code}, ${customer[0]!.id}, ${options.status}, ${options.method},
          ${options.paymentStatus}, 'self_pickup', ${options.total}, ${options.total},
          ${options.dpAmount ?? null}, ${options.paidAt ?? null}, '2026-01-01T00:00:00Z'
        )
        RETURNING id
      `) as { id: string }[];
      return rows[0]!.id;
    }

    test("every already-paid order gets exactly one deterministic backfill leg; unpaid/zero-total orders get none; a re-run changes nothing", async () => {
      const cash = await legacyOrder({
        code: "LEG-0001",
        method: "cash",
        status: "completed",
        paymentStatus: "paid",
        total: "25000.00",
        paidAt: "2026-01-05T03:00:00Z"
      });
      const gateway = await legacyOrder({
        code: "LEG-0002",
        method: "gateway",
        status: "paid",
        paymentStatus: "paid",
        total: "10000.00",
        paidAt: "2026-01-06T04:00:00Z"
      });
      await getAdminSql()`
        UPDATE awcms_commerce_orders SET gateway_provider = 'midtrans', gateway_ref = 'LEG-0002-1' WHERE id = ${gateway}
      `;
      const dp = await legacyOrder({
        code: "LEG-0003",
        method: "dp",
        status: "processing",
        paymentStatus: "paid",
        total: "100000.00",
        dpAmount: "30000.00",
        paidAt: "2026-01-07T05:00:00Z"
      });
      const unpaid = await legacyOrder({
        code: "LEG-0004",
        method: "manual_qris",
        status: "pending_payment",
        paymentStatus: "unpaid",
        total: "5000.00"
      });
      const free = await legacyOrder({
        code: "LEG-0005",
        method: "manual_bank",
        status: "paid",
        paymentStatus: "paid",
        total: "0.00",
        paidAt: "2026-01-08T00:00:00Z"
      });

      await getAdminSql().unsafe(backfillSql);

      const legs = (await getAdminSql()`
        SELECT order_id, tender_type, amount, provider, provider_reference, source, actor_kind,
               status, created_at, source_key
        FROM awcms_commerce_payment_allocations
        WHERE tenant_id = ${TENANT_A}
        ORDER BY source_key
      `) as {
        order_id: string;
        tender_type: string;
        amount: string;
        provider: string | null;
        provider_reference: string | null;
        source: string;
        actor_kind: string;
        status: string;
        created_at: Date;
        source_key: string;
      }[];
      expect(legs).toHaveLength(3);
      const byOrder = new Map(legs.map((leg) => [leg.order_id, leg]));
      expect(byOrder.get(unpaid)).toBeUndefined();
      expect(byOrder.get(free)).toBeUndefined();

      expect(byOrder.get(cash)).toMatchObject({
        tender_type: "cash",
        source: "backfill",
        actor_kind: "system",
        status: "succeeded",
        source_key: `backfill:${cash}`
      });
      expect(String(byOrder.get(cash)!.amount)).toBe("25000.00");
      // The money arrived when the order was paid, not "now".
      expect(byOrder.get(cash)!.created_at.toISOString()).toBe(
        "2026-01-05T03:00:00.000Z"
      );

      expect(byOrder.get(gateway)).toMatchObject({
        tender_type: "gateway",
        provider: "midtrans",
        provider_reference: "LEG-0002-1"
      });

      // A down-payment order "paid" on its down payment: the ledger says so, and
      // the cached status is corrected to dp_paid rather than claiming it is paid in full.
      expect(String(byOrder.get(dp)!.amount)).toBe("30000.00");
      expect(
        (
          (await getAdminSql()`SELECT payment_status FROM awcms_commerce_orders WHERE id = ${dp}`) as {
            payment_status: string;
          }[]
        )[0]!.payment_status
      ).toBe("dp_paid");
      expect(
        (
          (await getAdminSql()`SELECT payment_status FROM awcms_commerce_orders WHERE id = ${cash}`) as {
            payment_status: string;
          }[]
        )[0]!.payment_status
      ).toBe("paid");

      // Idempotent: a second run adds nothing and rewrites nothing.
      await getAdminSql().unsafe(backfillSql);
      const again = (await getAdminSql()`
        SELECT count(*)::int AS count FROM awcms_commerce_payment_allocations WHERE tenant_id = ${TENANT_A}
      `) as { count: number }[];
      expect(again[0]!.count).toBe(3);

      // The backfilled ledger reads back as the truth the orders claimed.
      const summary = await inTenant(TENANT_A, (tx) =>
        fetchOrderPaymentSummary(tx, TENANT_A, cash)
      );
      expect(summary!.settlement).toMatchObject({
        paid: "25000.00",
        outstanding: "0.00",
        paymentStatus: "paid"
      });
      // And never announced as a payment event (history is not news).
      expect(
        await domainEventCount(TENANT_A, "awcms.commerce.payment.recorded")
      ).toBe(0);
    });

    test("an order that already has a real ledger row is never backfilled on top of it", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      await pay(TENANT_A, order.id, recordInput({ amount: "10000.00" }));
      await getAdminSql().unsafe(backfillSql);
      expect(
        await countRows(
          "awcms_commerce_payment_allocations",
          "order_id = $1",
          order.id
        )
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  describe("reporting", () => {
    test("tender mix reads straight off the ledger: payments, reversals and net per tender, range-bounded, succeeded legs only", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await createStorefrontOrder(TENANT_A, productId);
      const cash = await pay(
        TENANT_A,
        order.id,
        recordInput({ tenderType: "cash", amount: "4000.00" })
      );
      await pay(
        TENANT_A,
        order.id,
        recordInput({ tenderType: "manual_qris", amount: "6000.00" })
      );
      if (cash.kind !== "created") throw new Error("setup");
      await reverse(
        TENANT_A,
        order.id,
        cash.body.payment.id,
        reversalInput({ amount: "1000.00" })
      );
      // A pending gateway leg must not show up.
      await getAdminSql()`
        INSERT INTO awcms_commerce_payment_allocations
          (tenant_id, order_id, kind, tender_type, amount, status, provider, provider_reference,
           source, source_key, actor_kind)
        VALUES (${TENANT_A}, ${order.id}, 'payment', 'gateway', '777.00', 'pending', 'log', 'r',
           'gateway_checkout', 'gateway:log:r', 'system')
      `;

      const today = resolveSalesReportDay(new Date());
      const report = await inTenant(TENANT_A, (tx) =>
        listTenderMix(
          tx,
          TENANT_A,
          { from: today, to: today },
          SALES_REPORT_TIME_ZONE
        )
      );
      expect(report.items).toEqual([
        {
          tenderType: "cash",
          paymentCount: 1,
          payments: "4000.00",
          reversalCount: 1,
          reversals: "1000.00",
          net: "3000.00"
        },
        {
          tenderType: "manual_qris",
          paymentCount: 1,
          payments: "6000.00",
          reversalCount: 0,
          reversals: "0.00",
          net: "6000.00"
        }
      ]);
      expect(report).toMatchObject({
        totalPayments: "10000.00",
        totalReversals: "1000.00",
        totalNet: "9000.00"
      });

      // A range that excludes today is empty, and tenant B sees nothing.
      const past = await inTenant(TENANT_A, (tx) =>
        listTenderMix(
          tx,
          TENANT_A,
          { from: "2020-01-01", to: "2020-01-31" },
          SALES_REPORT_TIME_ZONE
        )
      );
      expect(past.items).toEqual([]);
      expect(past.totalNet).toBe("0.00");
      const other = await inTenant(TENANT_B, (tx) =>
        listTenderMix(
          tx,
          TENANT_B,
          { from: today, to: today },
          SALES_REPORT_TIME_ZONE
        )
      );
      expect(other.items).toEqual([]);
    });

    test("outstanding balances list only orders that still owe money, re-derived from the ledger, with exact totals", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const partial = await createStorefrontOrder(TENANT_A, productId);
      const settled = await createStorefrontOrder(TENANT_A, productId);
      const untouched = await createStorefrontOrder(
        TENANT_A,
        productId,
        "manual_qris",
        2
      );
      const cancelled = await createStorefrontOrder(TENANT_A, productId);

      await pay(TENANT_A, partial.id, recordInput({ amount: "2500.50" }));
      await pay(TENANT_A, settled.id, recordInput({ amount: "10000.00" }));
      await inTenant(TENANT_A, (tx) =>
        updateOrderStatusByAdmin(
          tx,
          TENANT_A,
          STAFF_1,
          cancelled.id,
          "cancelled",
          null
        )
      );

      const report = await inTenant(TENANT_A, (tx) =>
        listOutstandingBalances(tx, TENANT_A, { channel: null, limit: 10 })
      );
      expect(report.count).toBe(2);
      // 20000.00 (untouched) + 7499.50 (partial)
      expect(report.totalOutstanding).toBe("27499.50");
      expect(report.items.map((row) => [row.orderId, row.outstanding])).toEqual(
        [
          [untouched.id, "20000.00"],
          [partial.id, "7499.50"]
        ]
      );
      expect(report.truncated).toBe(false);

      const limited = await inTenant(TENANT_A, (tx) =>
        listOutstandingBalances(tx, TENANT_A, { channel: null, limit: 1 })
      );
      expect(limited.items).toHaveLength(1);
      expect(limited.truncated).toBe(true);
      expect(limited.count).toBe(2);
      expect(limited.totalOutstanding).toBe("27499.50");

      // Another tenant sees none of it.
      const other = await inTenant(TENANT_B, (tx) =>
        listOutstandingBalances(tx, TENANT_B, { channel: null, limit: 10 })
      );
      expect(other).toMatchObject({ count: 0, totalOutstanding: "0.00" });
    });
  });
});
