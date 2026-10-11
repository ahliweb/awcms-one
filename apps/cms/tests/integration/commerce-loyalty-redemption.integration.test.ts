/**
 * Loyalty point redemption into checkout and the POS (Issue #363, ADR-0043,
 * threat-model controls C-30..C-33) against a REAL migrated Postgres through
 * `tests/integration/harness.ts`. Gated on `DATABASE_URL`; skips cleanly
 * without one.
 *
 * The properties only a real database can prove:
 *
 *   C-30  the debit and the discount line commit together or not at all; a
 *         replay returns the same order and debits once; the same key with a
 *         different request is a conflict; an overdraw is refused and writes
 *         nothing; two parallel redemptions of one balance - exactly one wins;
 *   C-31  the client sends only whole points: tampered figures are refused at
 *         validation, no point value set = unavailable (never a default), the
 *         cap and the goods bound hold, shipping and tax stay payable in
 *         money, and the discount is exactly points x rate (a CHECK, too);
 *   C-32  the account is the signed-in customer's own: another customer's
 *         balance is untouched, a guest cannot redeem, RLS isolates tenants;
 *   C-33  a cancelled / expired / refunded order gives the points back with a
 *         compensating row of its own identity, exactly once, even on replay;
 *         points and a deposit never share an order, in both directions;
 *   and the feature toggle defaults OFF and gates everything.
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
import {
  cancelOrderByCustomer,
  createOrderFromCart,
  expireOrdersForTenant,
  IdempotencyPayloadMismatchError,
  type CreateOrderOutcome
} from "../../src/modules/commerce/application/order-directory";
import {
  adjustPoints,
  earnPointsForPaidOrder,
  fetchLoyaltyAccountForCustomer,
  fetchLoyaltySummary,
  findOrCreateAccountLocked,
  LoyaltyIdempotencyConflictError,
  reconcileLoyaltyForTenant
} from "../../src/modules/commerce/application/loyalty-ledger";
import {
  activateLoyaltyProgram,
  createLoyaltyProgram
} from "../../src/modules/commerce/application/loyalty-program-directory";
import {
  clearRedemptionSettings,
  fetchRedemptionForOrder,
  fetchRedemptionSettings,
  fetchRedemptionTerms,
  restoreRedemptionForOrder,
  restoreRedemptionForRefund,
  saveRedemptionSettings
} from "../../src/modules/commerce/application/loyalty-redemption";
import {
  createPosOrder,
  PosLoyaltyRefusedError
} from "../../src/modules/commerce/application/pos-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import { LOYALTY_REDEMPTION_ERROR_CODES } from "../../src/modules/commerce/domain/loyalty-redemption";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import { validateCreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreatePosOrderInput } from "../../src/modules/commerce/domain/pos-order-validation";
import { validateCreatePosOrderInput } from "../../src/modules/commerce/domain/pos-order-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import {
  assertRejected,
  getAdminSql,
  getAppRoleSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "aaaaaaaa-0363-4000-8000-000000000001";
const TENANT_B = "bbbbbbbb-0363-4000-8000-000000000002";
const ACTOR = "cccccccc-0363-4000-8000-000000000003";

const NOW = new Date("2026-10-11T10:00:00.000Z");
const PHONE_SITI = "081234560001";
const PHONE_BUDI = "081234560002";

/** The error a promise rejects with (try/catch, never `expect().rejects` - see harness `assertRejected`'s note). */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject, but it resolved.");
}

function mustReject(promise: Promise<unknown>): Promise<Error> {
  return assertRejected(promise, "this statement");
}

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

async function setFeatures(
  tenantId: string,
  features: { loyalty: boolean; loyaltyRedemption: boolean }
): Promise<void> {
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
          ...features
        }
      },
      ACTOR
    );
  });
}

/** Self-pickup + a 15 000 alternative shipping + manual QRIS + 10 % tax + a 50 % down payment. */
async function configureStore(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Poin",
    shipping: {
      selfPickup: true,
      alternativeServices: [
        { id: "kurir-toko", name: "Kurir Toko", cost: "15000.00" }
      ]
    },
    payment: {
      manualQris: { active: true, mediaObjectId: null },
      tax: { active: true, percent: 10 },
      downPayment: { active: true, percent: 50 }
    }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, ACTOR, validated.value)
  );
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-POIN",
  name: "Kopi Poin",
  slug: "kopi-poin",
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
  allowDp: true,
  allowFreeShipping: false,
  variantAttributes: null,
  isFeatured: false,
  isRecommended: false
};

async function seedProduct(tenantId: string): Promise<string> {
  const product = await inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, ACTOR, BASE_PRODUCT)
  );
  await inTenant(
    tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  return product.id;
}

async function stockOf(tenantId: string, productId: string): Promise<number> {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT stock FROM awcms_commerce_products WHERE id = ${productId}`
  )) as { stock: number }[];
  return Number(rows[0]!.stock);
}

async function seedCustomer(
  tenantId: string,
  name: string,
  phone: string
): Promise<string> {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone, status)
      VALUES (${tenantId}, ${name}, ${phone}, 'active')
      RETURNING id
    `
  )) as { id: string }[];
  return rows[0]!.id;
}

/** Gives a customer `points` through the ledger's own manual-adjustment path. */
async function grantPoints(
  tenantId: string,
  customerId: string,
  points: number
): Promise<string> {
  return inTenant(tenantId, async (tx) => {
    const account = await findOrCreateAccountLocked(tx, tenantId, customerId);
    const outcome = await adjustPoints(
      tx,
      tenantId,
      ACTOR,
      {
        customerId,
        points,
        reason: "test grant",
        idempotencyKey: `grant-${customerId}-${points}-${Math.random()}`
      },
      NOW
    );
    expect(outcome.kind).toBe("adjusted");
    return account.id;
  });
}

async function balanceOf(
  tenantId: string,
  customerId: string
): Promise<number> {
  const account = await inTenant(tenantId, (tx) =>
    fetchLoyaltyAccountForCustomer(tx, tenantId, customerId)
  );
  return account?.balance ?? 0;
}

async function ledgerRows(
  tenantId: string,
  customerId: string
): Promise<
  {
    kind: string;
    points: number;
    source_type: string;
    source_id: string | null;
    idempotency_key: string;
    expires_at: Date | null;
  }[]
> {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
      SELECT l.kind, l.points::int AS points, l.source_type, l.source_id,
             l.idempotency_key, l.expires_at
      FROM awcms_commerce_loyalty_ledger l
      JOIN awcms_commerce_loyalty_accounts a
        ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = ${tenantId} AND a.customer_id = ${customerId}
      ORDER BY l.account_seq ASC
    `
  )) as {
    kind: string;
    points: number;
    source_type: string;
    source_id: string | null;
    idempotency_key: string;
    expires_at: Date | null;
  }[];
  return rows;
}

async function countOrders(tenantId: string): Promise<number> {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT count(*)::int AS n FROM awcms_commerce_orders WHERE tenant_id = ${tenantId}`
  )) as { n: number }[];
  return rows[0]!.n;
}

function orderInput(
  productId: string,
  overrides: Partial<CreateOrderInput> = {}
): CreateOrderInput {
  return {
    idempotencyKey: "11111111-2222-4333-8444-555555555555",
    customer: { name: "Siti", phone: PHONE_SITI, email: null },
    address: null,
    lines: [
      { productId, variantId: null, quantity: 2, serviceFormValues: null }
    ],
    shipping: { method: "self_pickup" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null,
    loyaltyRedemption: null,
    ...overrides
  };
}

function place(
  tenantId: string,
  input: CreateOrderInput,
  accountCustomerId: string | undefined
): Promise<CreateOrderOutcome> {
  return inTenant(tenantId, (tx) =>
    createOrderFromCart(
      tx,
      tenantId,
      mediaLibraryPortAdapter,
      input,
      NOW,
      undefined,
      accountCustomerId
    )
  );
}

function refusalCode(outcome: CreateOrderOutcome): string | null {
  return outcome.kind === "loyalty_refused" ? outcome.refusal.code : null;
}

async function setPointValue(
  tenantId: string,
  rupiahPerPoint: number,
  maxGoodsPercent: number | null = null
): Promise<void> {
  await inTenant(tenantId, (tx) =>
    saveRedemptionSettings(tx, tenantId, ACTOR, {
      rupiahPerPoint,
      maxGoodsPercent
    })
  );
}

let siti = "";
let budi = "";
let productId = "";

suite("loyalty redemption integration (Issue #363)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-a");
    await seedTenant(TENANT_B, "tenant-b");
    await setFeatures(TENANT_A, { loyalty: true, loyaltyRedemption: true });
    await configureStore(TENANT_A);
    productId = await seedProduct(TENANT_A);
    siti = await seedCustomer(TENANT_A, "Siti", "+6281234560001");
    budi = await seedCustomer(TENANT_A, "Budi", "+6281234560002");
    await setPointValue(TENANT_A, 2);
    await grantPoints(TENANT_A, siti, 20000);
  }, 60000);

  // -------------------------------------------------------------------------
  // C-30: atomicity, replay, conflict, overdraw, concurrency
  // -------------------------------------------------------------------------

  test("a redemption writes the debit and the discount line together: total = goods + tax - discount, one redeem row, one redemption record", async () => {
    const outcome = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 5000 } }),
      siti
    );
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;

    // goods 2 x 10 000 = 20 000, tax 10 % = 2 000, points 5 000 x Rp 2 = 10 000.
    expect(outcome.order.subtotal).toBe("20000.00");
    expect(outcome.order.tax).toBe("2000.00");
    expect(outcome.order.loyaltyDiscount).toBe("10000.00");
    expect(outcome.order.loyaltyPointsRedeemed).toBe(5000);
    expect(outcome.order.total).toBe("12000.00");

    const rows = await ledgerRows(TENANT_A, siti);
    const redeem = rows.filter((row) => row.kind === "redeem");
    expect(redeem).toHaveLength(1);
    expect(redeem[0]!.points).toBe(-5000);
    expect(redeem[0]!.source_type).toBe("redemption");
    expect(redeem[0]!.idempotency_key).toMatch(
      /^redeem:[0-9a-f-]{36}:order:11111111-2222-4333-8444-555555555555$/
    );
    expect(await balanceOf(TENANT_A, siti)).toBe(15000);

    const detail = await inTenant(TENANT_A, async (tx) => {
      const orderRows = (await tx`
        SELECT id, total, loyalty_discount FROM awcms_commerce_orders
        WHERE order_code = ${outcome.order.orderCode}
      `) as { id: string; total: string; loyalty_discount: string }[];
      return {
        order: orderRows[0]!,
        redemption: await fetchRedemptionForOrder(
          tx,
          TENANT_A,
          orderRows[0]!.id
        )
      };
    });
    expect(detail.redemption).not.toBeNull();
    expect(detail.redemption!.points).toBe(5000);
    expect(detail.redemption!.rupiahPerPoint).toBe(2);
    expect(detail.redemption!.discount).toBe("10000.00");
    expect(detail.redemption!.goodsBasis).toBe("20000.00");
    expect(detail.redemption!.channel).toBe("storefront");
    expect(detail.redemption!.ledgerEntryId).toBeTruthy();
    expect(Number(detail.order.loyalty_discount)).toBe(10000);
  }, 30000);

  test("replay: the same key and request returns the SAME order and debits once", async () => {
    const input = orderInput(productId, {
      loyaltyRedemption: { points: 5000 }
    });
    const first = await place(TENANT_A, input, siti);
    const second = await place(TENANT_A, input, siti);
    expect(first.kind).toBe("created");
    expect(second.kind).toBe("replayed");
    if (first.kind !== "created" || second.kind !== "replayed") return;
    expect(second.order.orderCode).toBe(first.order.orderCode);
    expect(second.order.loyaltyDiscount).toBe("10000.00");

    expect(
      (await ledgerRows(TENANT_A, siti)).filter((r) => r.kind === "redeem")
    ).toHaveLength(1);
    expect(await balanceOf(TENANT_A, siti)).toBe(15000);
    expect(await countOrders(TENANT_A)).toBe(1);
    expect(await stockOf(TENANT_A, productId)).toBe(98);
  }, 30000);

  test("key conflict: the same idempotency key with a DIFFERENT points figure is refused and changes nothing", async () => {
    const first = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 5000 } }),
      siti
    );
    expect(first.kind).toBe("created");

    expect(
      await caught(
        place(
          TENANT_A,
          orderInput(productId, { loyaltyRedemption: { points: 5001 } }),
          siti
        )
      )
    ).toBeInstanceOf(IdempotencyPayloadMismatchError);
    // ... and dropping the redemption altogether is also a different request.
    expect(
      await caught(
        place(
          TENANT_A,
          orderInput(productId, { loyaltyRedemption: null }),
          siti
        )
      )
    ).toBeInstanceOf(IdempotencyPayloadMismatchError);

    expect(await balanceOf(TENANT_A, siti)).toBe(15000);
    expect(await countOrders(TENANT_A)).toBe(1);
  }, 30000);

  test("a ledger key already used by a different amount is a hard conflict at the ledger, not just at the idempotency store", async () => {
    await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 5000 } }),
      siti
    );
    // Pre-write the key a second order would use, with a different amount, to
    // prove the database constraint is what stands underneath the handler.
    expect(
      await caught(
        inTenant(TENANT_A, async (tx) => {
          const account = await findOrCreateAccountLocked(tx, TENANT_A, siti);
          const { appendLedgerEntry } =
            await import("../../src/modules/commerce/application/loyalty-ledger");
          await appendLedgerEntry(tx, TENANT_A, account, {
            kind: "redeem",
            points: -1,
            sourceType: "redemption",
            idempotencyKey: `redeem:${account.id}:order:11111111-2222-4333-8444-555555555555`
          });
        })
      )
    ).toBeInstanceOf(LoyaltyIdempotencyConflictError);
  }, 30000);

  test("overdraw: more points than the balance is refused whole, nothing is written, the key can retry after a top-up", async () => {
    await setPointValue(TENANT_A, 1);
    const overdraw = orderInput(productId, {
      loyaltyRedemption: { points: 20001 }
    });
    // 20 001 points x Rp 1 = Rp 20 001 > the Rp 20 000 of goods, so use a
    // smaller basket price point: refuse on the BALANCE by draining first.
    await inTenant(TENANT_A, async (tx) => {
      await adjustPoints(
        tx,
        TENANT_A,
        ACTOR,
        {
          customerId: siti,
          points: -19950,
          reason: "drain",
          idempotencyKey: "drain-1"
        },
        NOW
      );
    });
    expect(await balanceOf(TENANT_A, siti)).toBe(50);

    const refused = await place(
      TENANT_A,
      { ...overdraw, loyaltyRedemption: { points: 51 } },
      siti
    );
    expect(refusalCode(refused)).toBe("INSUFFICIENT_POINTS");
    if (refused.kind === "loyalty_refused") {
      expect(refused.refusal).toMatchObject({ balance: 50, requested: 51 });
    }
    expect(await countOrders(TENANT_A)).toBe(0);
    expect(await stockOf(TENANT_A, productId)).toBe(100);
    expect(
      (await ledgerRows(TENANT_A, siti)).filter((r) => r.kind === "redeem")
    ).toHaveLength(0);

    // Top up; the SAME key now succeeds because the refusal was not recorded.
    await grantPoints(TENANT_A, siti, 1000);
    const retried = await place(
      TENANT_A,
      { ...overdraw, loyaltyRedemption: { points: 51 } },
      siti
    );
    expect(retried.kind).toBe("created");
  }, 30000);

  test("two parallel redemptions of one balance: exactly one wins, the other is refused, the balance never goes negative", async () => {
    await setPointValue(TENANT_A, 1);
    await inTenant(TENANT_A, async (tx) => {
      await adjustPoints(
        tx,
        TENANT_A,
        ACTOR,
        {
          customerId: siti,
          points: -10000,
          reason: "set balance to 10 000",
          idempotencyKey: "drain-parallel"
        },
        NOW
      );
    });
    expect(await balanceOf(TENANT_A, siti)).toBe(10000);

    // Each wants 7 000 of the 10 000 - together they would overdraw.
    const [one, two] = await Promise.all([
      place(
        TENANT_A,
        orderInput(productId, {
          idempotencyKey: "aaaaaaaa-0000-4000-8000-000000000001",
          loyaltyRedemption: { points: 7000 }
        }),
        siti
      ),
      place(
        TENANT_A,
        orderInput(productId, {
          idempotencyKey: "aaaaaaaa-0000-4000-8000-000000000002",
          loyaltyRedemption: { points: 7000 }
        }),
        siti
      )
    ]);
    const created = [one, two].filter((o) => o.kind === "created");
    const refused = [one, two].filter((o) => o.kind === "loyalty_refused");
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refusalCode(refused[0]!)).toBe("INSUFFICIENT_POINTS");

    expect(await balanceOf(TENANT_A, siti)).toBe(3000);
    expect(await countOrders(TENANT_A)).toBe(1);
    const report = await inTenant(TENANT_A, (tx) =>
      reconcileLoyaltyForTenant(tx, TENANT_A, { repair: false })
    );
    expect(report.drifted).toHaveLength(0);
    expect(report.ledgerBreaks).toHaveLength(0);
  }, 60000);

  // -------------------------------------------------------------------------
  // C-31: server-authoritative pricing
  // -------------------------------------------------------------------------

  test("tamper: the client may send ONLY whole points - any discount, rate, total or account figure is a validation error", () => {
    const base = {
      idempotencyKey: "tamper-1",
      customer: { name: "Siti", phone: "081234560001", email: null },
      lines: [{ productId: "p", variantId: null, quantity: 1 }],
      shipping: { method: "self_pickup" },
      payment: { method: "manual_qris" }
    };
    for (const extra of [
      { discount: "99999.00" },
      { rate: 100000 },
      { rupiahPerPoint: 100000 },
      { total: "1.00" },
      { amount: "5000.00" },
      { accountId: "cccccccc-0363-4000-8000-000000000003" },
      { customerId: "cccccccc-0363-4000-8000-000000000003" }
    ]) {
      const result = validateCreateOrderInput({
        ...base,
        loyaltyRedemption: { points: 10, ...extra }
      });
      expect(result.valid).toBe(false);
    }
    for (const points of [0, -5, 1.5, "10", null, Number.NaN, 1e15]) {
      const result = validateCreateOrderInput({
        ...base,
        loyaltyRedemption: { points }
      });
      expect(result.valid).toBe(false);
    }
    expect(
      validateCreateOrderInput({ ...base, loyaltyRedemption: { points: 10 } })
        .valid
    ).toBe(true);
    // The POS validator applies the same rule.
    const pos = validateCreatePosOrderInput(
      {
        customer: { phone: "081234560001" },
        lines: [
          { productId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", quantity: 1 }
        ],
        tenders: [{ tenderType: "cash", amount: "1000.00" }],
        loyaltyRedemption: { points: 10, discount: "1.00" }
      },
      "tamper-pos"
    );
    expect(pos.valid).toBe(false);
  });

  test("no point value set: redemption is unavailable - there is no default rate", async () => {
    await inTenant(TENANT_A, (tx) =>
      clearRedemptionSettings(tx, TENANT_A, ACTOR)
    );
    expect(
      await inTenant(TENANT_A, (tx) => fetchRedemptionSettings(tx, TENANT_A))
    ).toBeNull();
    expect(
      await inTenant(TENANT_A, (tx) => fetchRedemptionTerms(tx, TENANT_A))
    ).toBeNull();

    const outcome = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 100 } }),
      siti
    );
    expect(refusalCode(outcome)).toBe("LOYALTY_REDEMPTION_UNAVAILABLE");
    expect(await countOrders(TENANT_A)).toBe(0);
    expect(await balanceOf(TENANT_A, siti)).toBe(20000);
  }, 30000);

  test("toggle off: with loyaltyRedemption (or loyalty) off the same order is refused and the terms vanish; an order without points is unaffected", async () => {
    await setFeatures(TENANT_A, { loyalty: true, loyaltyRedemption: false });
    expect(
      await inTenant(TENANT_A, (tx) => fetchRedemptionTerms(tx, TENANT_A))
    ).toBeNull();
    expect(
      refusalCode(
        await place(
          TENANT_A,
          orderInput(productId, { loyaltyRedemption: { points: 100 } }),
          siti
        )
      )
    ).toBe("LOYALTY_REDEMPTION_UNAVAILABLE");

    await setFeatures(TENANT_A, { loyalty: false, loyaltyRedemption: true });
    expect(
      refusalCode(
        await place(
          TENANT_A,
          orderInput(productId, { loyaltyRedemption: { points: 100 } }),
          siti
        )
      )
    ).toBe("LOYALTY_REDEMPTION_UNAVAILABLE");

    const plain = await place(TENANT_A, orderInput(productId), siti);
    expect(plain.kind).toBe("created");
    if (plain.kind === "created") {
      expect(plain.order.loyaltyDiscount).toBe("0.00");
      expect(plain.order.total).toBe("22000.00");
    }
  }, 30000);

  test("the cap bounds the share of the goods payable in points: at the cap passes, one point over is refused with the largest number that fits", async () => {
    await setPointValue(TENANT_A, 1, 50);
    // goods 20 000, 50 % cap = 10 000 = 10 000 points at Rp 1.
    const over = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 10001 } }),
      siti
    );
    expect(refusalCode(over)).toBe("LOYALTY_REDEMPTION_EXCEEDS_LIMIT");
    if (over.kind === "loyalty_refused") {
      expect(over.refusal).toMatchObject({ reason: "cap", maxPoints: 10000 });
    }
    expect(await countOrders(TENANT_A)).toBe(0);

    const at = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 10000 } }),
      siti
    );
    expect(at.kind).toBe("created");
    if (at.kind === "created") {
      expect(at.order.loyaltyDiscount).toBe("10000.00");
      expect(at.order.total).toBe("12000.00");
    }
  }, 30000);

  test("shipping and tax are never payable in points: the discount stops at the goods, and the rest is still due in money", async () => {
    await setPointValue(TENANT_A, 1);
    // goods 20 000 + shipping 15 000 + tax 2 000 (10 % of the goods) = 37 000.
    const base = orderInput(productId, {
      shipping: { method: "alternative", serviceId: "kurir-toko" },
      address: {
        recipientName: "Siti",
        phone: "081234560001",
        provinceCode: "62",
        provinceName: "Kalimantan Tengah",
        cityCode: "62.01",
        cityName: "Kotawaringin Barat",
        districtCode: "62.01.01",
        districtName: "Arut Selatan",
        postalCode: "74111",
        street: "Jl. Uji 1",
        latitude: null,
        longitude: null,
        notes: null
      }
    });

    const tooMany = await place(
      TENANT_A,
      { ...base, loyaltyRedemption: { points: 20001 } },
      siti
    );
    expect(refusalCode(tooMany)).toBe("LOYALTY_REDEMPTION_EXCEEDS_LIMIT");
    if (tooMany.kind === "loyalty_refused") {
      expect(tooMany.refusal).toMatchObject({
        reason: "goods",
        maxPoints: 20000
      });
    }

    const allGoods = await place(
      TENANT_A,
      { ...base, loyaltyRedemption: { points: 20000 } },
      siti
    );
    expect(allGoods.kind).toBe("created");
    if (allGoods.kind !== "created") return;
    expect(allGoods.order.loyaltyDiscount).toBe("20000.00");
    expect(allGoods.order.shippingCost).toBe("15000.00");
    expect(allGoods.order.tax).toBe("2000.00");
    // The goods are free; shipping and tax remain payable in money.
    expect(allGoods.order.total).toBe("17000.00");
  }, 30000);

  test("points that cover the whole bill release the order as paid at once (nothing is left to collect, and no Rp 0 payment can be recorded)", async () => {
    // No tax and self-pickup: the goods are the whole bill.
    const validated = validateStoreSettingsInput({
      storeName: "Toko Poin",
      shipping: { selfPickup: true },
      payment: {
        manualQris: { active: true, mediaObjectId: null },
        tax: { active: false, percent: 0 }
      }
    });
    if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
    await inTenant(TENANT_A, (tx) =>
      saveStoreSettings(tx, TENANT_A, ACTOR, validated.value)
    );
    await setPointValue(TENANT_A, 1);

    const outcome = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 20000 } }),
      siti
    );
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    expect(outcome.order.total).toBe("0.00");
    expect(outcome.order.loyaltyDiscount).toBe("20000.00");
    expect(outcome.order.status).toBe("paid");
    expect(outcome.order.paymentStatus).toBe("paid");
    expect(await balanceOf(TENANT_A, siti)).toBe(0);

    // A fully points-paid order is not expired out from under the customer.
    const result = await expireOrdersForTenant(
      getRuntimeSql(),
      TENANT_A,
      new Date(NOW.getTime() + 72 * 3600 * 1000)
    );
    expect(result.expiredCount).toBe(0);
    expect(await balanceOf(TENANT_A, siti)).toBe(0);
  }, 30000);

  test("rounding cannot mint value: the stored discount is exactly points x rate, and the database refuses any other figure", async () => {
    const outcome = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 3333 } }),
      siti
    );
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    expect(outcome.order.loyaltyDiscount).toBe("6666.00");

    await mustReject(
      getAdminSql()`
        UPDATE awcms_commerce_loyalty_redemptions
        SET discount = 6666.01
        WHERE tenant_id = ${TENANT_A}
      `
    );
    await mustReject(
      getAdminSql()`
        INSERT INTO awcms_commerce_loyalty_redemptions
          (tenant_id, order_id, account_id, ledger_entry_id, channel, points,
           rupiah_per_point, goods_basis, discount)
        SELECT tenant_id, order_id, account_id, ledger_entry_id, 'pos', 10, 2, 1000.00, 21.00
        FROM awcms_commerce_loyalty_redemptions WHERE tenant_id = ${TENANT_A}
      `
    );
  }, 30000);

  // -------------------------------------------------------------------------
  // Q8: points and a refundable deposit never share an order
  // -------------------------------------------------------------------------

  test("a down-payment order refuses points with a stable code, and the database refuses the combination on a stored order", async () => {
    const dp = await place(
      TENANT_A,
      orderInput(productId, {
        payment: { method: "dp" },
        loyaltyRedemption: { points: 100 }
      }),
      siti
    );
    expect(refusalCode(dp)).toBe(
      LOYALTY_REDEMPTION_ERROR_CODES.depositConflict
    );
    expect(await countOrders(TENANT_A)).toBe(0);

    // A deposit order WITHOUT points is fine ...
    const plainDp = await place(
      TENANT_A,
      orderInput(productId, {
        idempotencyKey: "dddddddd-0000-4000-8000-000000000001",
        payment: { method: "dp" }
      }),
      siti
    );
    expect(plainDp.kind).toBe("created");
    // ... and cannot be given a points discount afterwards (both directions).
    await mustReject(
      getAdminSql()`
        UPDATE awcms_commerce_orders SET loyalty_discount = 10.00
        WHERE tenant_id = ${TENANT_A}
      `
    );
  }, 30000);

  // -------------------------------------------------------------------------
  // C-32: ownership
  // -------------------------------------------------------------------------

  test("the account is the signed-in customer's own: another customer's balance is untouched, and a guest cannot redeem", async () => {
    // Budi (no points) signs in and tries to spend: refused on HIS balance.
    const budiOutcome = await place(
      TENANT_A,
      orderInput(productId, {
        customer: { name: "Budi", phone: PHONE_BUDI, email: null },
        loyaltyRedemption: { points: 100 }
      }),
      budi
    );
    expect(refusalCode(budiOutcome)).toBe("INSUFFICIENT_POINTS");
    expect(await balanceOf(TENANT_A, siti)).toBe(20000);

    // Budi types SITI's phone at checkout: identity still comes from the
    // session, so it is still Budi's (empty) balance that is consulted.
    const spoof = await place(
      TENANT_A,
      orderInput(productId, {
        customer: { name: "Siti", phone: PHONE_SITI, email: null },
        loyaltyRedemption: { points: 100 }
      }),
      budi
    );
    expect(refusalCode(spoof)).toBe("INSUFFICIENT_POINTS");
    expect(await balanceOf(TENANT_A, siti)).toBe(20000);

    // A guest (no bearer) cannot redeem at all, even with Siti's phone.
    const guest = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 100 } }),
      undefined
    );
    expect(refusalCode(guest)).toBe(
      LOYALTY_REDEMPTION_ERROR_CODES.requiresAccount
    );
    expect(await balanceOf(TENANT_A, siti)).toBe(20000);
    expect(await countOrders(TENANT_A)).toBe(0);
  }, 30000);

  test("RLS: another tenant sees none of this tenant's redemption rows or point value, and its own redemption is unavailable", async () => {
    const outcome = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 1000 } }),
      siti
    );
    expect(outcome.kind).toBe("created");

    const seenByB = await inTenant(TENANT_B, async (tx) => ({
      redemptions:
        (await tx`SELECT count(*)::int AS n FROM awcms_commerce_loyalty_redemptions`) as {
          n: number;
        }[],
      settings:
        (await tx`SELECT count(*)::int AS n FROM awcms_commerce_loyalty_redemption_settings`) as {
          n: number;
        }[],
      terms: await fetchRedemptionTerms(tx, TENANT_B)
    }));
    expect(seenByB.redemptions[0]!.n).toBe(0);
    expect(seenByB.settings[0]!.n).toBe(0);
    expect(seenByB.terms).toBeNull();

    // Tenant B cannot forge a redemption pointing at tenant A's order.
    await mustReject(
      inTenant(TENANT_B, async (tx) => {
        await tx`
          INSERT INTO awcms_commerce_loyalty_redemptions
            (tenant_id, order_id, account_id, ledger_entry_id, channel, points,
             rupiah_per_point, goods_basis, discount)
          SELECT ${TENANT_B}::uuid, order_id, account_id, ledger_entry_id, 'pos', 1, 1, 100.00, 1.00
          FROM awcms_commerce_loyalty_redemptions
        `;
      })
    ).catch(() => undefined);
    const stillOne = (await getAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_loyalty_redemptions
    `) as { n: number }[];
    expect(stillOne[0]!.n).toBe(1);
  }, 30000);

  test("the redemption record is write-once: the request role can neither update nor delete it", async () => {
    await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 1000 } }),
      siti
    );
    const app = getAppRoleSql();
    await mustReject(
      withTenantOrThrow(
        app,
        TENANT_A,
        (tx) =>
          tx`UPDATE awcms_commerce_loyalty_redemptions SET points = 1 WHERE tenant_id = ${TENANT_A}`
      )
    );
    await mustReject(
      withTenantOrThrow(
        app,
        TENANT_A,
        (tx) =>
          tx`DELETE FROM awcms_commerce_loyalty_redemptions WHERE tenant_id = ${TENANT_A}`
      )
    );
    // Even a privileged role cannot edit it: the trigger refuses every UPDATE.
    await mustReject(
      getAdminSql()`UPDATE awcms_commerce_loyalty_redemptions SET points = 1`
    );
  }, 30000);

  // -------------------------------------------------------------------------
  // C-33: restoring points
  // -------------------------------------------------------------------------

  test("cancelling an order restores the points EXACTLY once, as a compensating row with the order's own identity - and a replay restores nothing more", async () => {
    const created = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 5000 } }),
      siti
    );
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    expect(await balanceOf(TENANT_A, siti)).toBe(15000);

    const cancelled = await inTenant(TENANT_A, (tx) =>
      cancelOrderByCustomer(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        created.order.orderCode,
        "+6281234560001",
        "changed my mind"
      )
    );
    expect(cancelled?.status).toBe("cancelled");
    expect(await balanceOf(TENANT_A, siti)).toBe(20000);

    const rows = await ledgerRows(TENANT_A, siti);
    const restores = rows.filter((row) => row.kind === "restore");
    expect(restores).toHaveLength(1);
    expect(restores[0]!.points).toBe(5000);
    expect(restores[0]!.source_type).toBe("order");
    expect(restores[0]!.idempotency_key).toMatch(/^restore:order:/);
    // The original debit is untouched: history is never edited.
    expect(rows.filter((row) => row.kind === "redeem")).toHaveLength(1);

    // Replaying the restore (a retried job, a re-run handler) writes nothing.
    const orderId = (
      (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT id FROM awcms_commerce_orders WHERE order_code = ${created.order.orderCode}`
      )) as { id: string }[]
    )[0]!.id;
    const replay = await inTenant(TENANT_A, (tx) =>
      restoreRedemptionForOrder(tx, TENANT_A, orderId)
    );
    expect(replay.kind).toBe("already_restored");
    expect(await balanceOf(TENANT_A, siti)).toBe(20000);

    const summary = await inTenant(TENANT_A, (tx) =>
      fetchLoyaltySummary(tx, TENANT_A, {})
    );
    expect(summary.period.restored).toBe(5000);
    expect(summary.outstanding).toBe(20000);
    const report = await inTenant(TENANT_A, (tx) =>
      reconcileLoyaltyForTenant(tx, TENANT_A, { repair: false })
    );
    expect(report.drifted).toHaveLength(0);
    expect(report.ledgerBreaks).toHaveLength(0);
  }, 30000);

  test("an order that expires unpaid gives its points back too (the job runs as the worker role)", async () => {
    const created = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 5000 } }),
      siti
    );
    expect(created.kind).toBe("created");
    expect(await balanceOf(TENANT_A, siti)).toBe(15000);

    // Pass the order's expiry (default 24 h) and run the expiry job as the
    // WORKER role, exactly as production does.
    const { workerRoleActivated, getWorkerRoleSql } = await import("./harness");
    // The harness activates the worker role in every database it builds; if it
    // ever did not, this test would silently stop proving the worker's grants.
    expect(workerRoleActivated).toBe(true);
    const sql = getWorkerRoleSql();
    const result = await expireOrdersForTenant(
      sql,
      TENANT_A,
      new Date(NOW.getTime() + 48 * 3600 * 1000)
    );
    expect(result.expiredCount).toBe(1);
    expect(await balanceOf(TENANT_A, siti)).toBe(20000);
    expect(
      (await ledgerRows(TENANT_A, siti)).filter((r) => r.kind === "restore")
    ).toHaveLength(1);
  }, 30000);

  test("restored points are a new lot that lapses no later than the soonest-expiring lot the redemption consumed (redeem-and-cancel cannot make lapsing points permanent)", async () => {
    // An expiring lot of 1 000 points (expires 5 days after NOW) AND the
    // permanent 20 000 granted in setup. The redemption consumes earliest
    // expiry first, i.e. the expiring lot, so the restore inherits its expiry.
    await inTenant(TENANT_A, async (tx) => {
      const program = await createLoyaltyProgram(tx, TENANT_A, ACTOR, {
        name: "Poin",
        earnUnitAmount: "1000.00",
        earnPointsPerUnit: 1,
        minOrderAmount: "0.00",
        maxPointsPerOrder: null,
        expiryDays: 5,
        notes: null,
        eligibilitySegmentId: null,
        eligibilitySegmentVersion: null
      });
      await activateLoyaltyProgram(
        tx,
        TENANT_A,
        ACTOR,
        program.id,
        new Date("2026-09-01T00:00:00.000Z")
      );
    });
    const earnOrder = (
      (await getAdminSql()`
        INSERT INTO awcms_commerce_orders
          (tenant_id, order_code, customer_id, status, payment_method, payment_status,
           shipping_method, subtotal, discount, total, paid_at)
        VALUES (${TENANT_A}, 'EARN-1', ${siti}, 'paid', 'manual_qris', 'paid', 'self_pickup',
                1000.00, 0.00, 1000.00, ${new Date(NOW.getTime())})
        RETURNING id
      `) as { id: string }[]
    )[0]!.id;
    await inTenant(TENANT_A, (tx) =>
      earnPointsForPaidOrder(tx, TENANT_A, earnOrder)
    );
    const lots = (await ledgerRows(TENANT_A, siti)).filter(
      (row) => row.kind === "earn"
    );
    expect(lots).toHaveLength(1);
    expect(lots[0]!.expires_at).not.toBeNull();

    // Redeem 1 000 points: the expiring lot is consumed first.
    const created = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 1000 } }),
      siti
    );
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    await inTenant(TENANT_A, (tx) =>
      cancelOrderByCustomer(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        created.order.orderCode,
        "+6281234560001",
        null
      )
    );
    const restore = (await ledgerRows(TENANT_A, siti)).find(
      (row) => row.kind === "restore"
    );
    expect(restore).toBeDefined();
    expect(restore!.expires_at).not.toBeNull();
    expect(restore!.expires_at!.getTime()).toBe(lots[0]!.expires_at!.getTime());
  }, 60000);

  test("a refund gives back the share of the points the money refunded represents; partial refunds add up, a replay restores nothing, and the rest comes back on cancellation", async () => {
    const created = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 5000 } }),
      siti
    );
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    const orderId = (
      (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT id FROM awcms_commerce_orders WHERE order_code = ${created.order.orderCode}`
      )) as { id: string }[]
    )[0]!.id;
    // Cash paid is the order total, 12 000.00 = 1 200 000 cents.
    const total = 1_200_000n;
    const refund = (
      refundId: string,
      cumulative: bigint
    ): ReturnType<typeof restoreRedemptionForRefund> =>
      inTenant(TENANT_A, (tx) =>
        restoreRedemptionForRefund(tx, TENANT_A, {
          orderId,
          refundId,
          cumulativeRefundedCents: cumulative,
          orderTotalCents: total
        })
      );

    // Refund a quarter of the money -> a quarter of the points.
    const first = await refund(
      "11111111-aaaa-4aaa-8aaa-000000000001",
      300_000n
    );
    expect(first.kind).toBe("restored");
    if (first.kind === "restored") {
      expect(first.entry.points).toBe(1250);
      expect(first.entry.sourceType).toBe("refund");
    }
    // The same refund again restores nothing more.
    expect(
      (await refund("11111111-aaaa-4aaa-8aaa-000000000001", 300_000n)).kind
    ).toBe("already_restored");
    // A second refund brings the cumulative to half: another quarter.
    const second = await refund(
      "11111111-aaaa-4aaa-8aaa-000000000002",
      600_000n
    );
    expect(second.kind).toBe("restored");
    if (second.kind === "restored") expect(second.entry.points).toBe(1250);
    expect(await balanceOf(TENANT_A, siti)).toBe(15000 + 2500);

    // Cancelling afterwards returns only what is left (5000 - 2500).
    const orderCode = created.order.orderCode;
    await inTenant(TENANT_A, (tx) =>
      cancelOrderByCustomer(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderCode,
        "+6281234560001",
        null
      )
    );
    expect(await balanceOf(TENANT_A, siti)).toBe(20000);
    const restores = (await ledgerRows(TENANT_A, siti)).filter(
      (row) => row.kind === "restore"
    );
    expect(restores.map((row) => row.points)).toEqual([1250, 1250, 2500]);
    const report = await inTenant(TENANT_A, (tx) =>
      reconcileLoyaltyForTenant(tx, TENANT_A, { repair: false })
    );
    expect(report.drifted).toHaveLength(0);
    expect(report.ledgerBreaks).toHaveLength(0);
  }, 60000);

  test("the ledger itself refuses a malformed restore: negative points, or no redeem to point at", async () => {
    const account = await grantPoints(TENANT_A, budi, 10);
    await mustReject(
      getAdminSql()`
        INSERT INTO awcms_commerce_loyalty_ledger
          (tenant_id, account_id, account_seq, kind, points, balance_after,
           source_type, source_id, idempotency_key, reverses_entry_id)
        SELECT ${TENANT_A}, ${account}, 99, 'restore', -5, 5, 'order', gen_random_uuid(),
               'bad-restore-1', id
        FROM awcms_commerce_loyalty_ledger WHERE account_id = ${account} LIMIT 1
      `
    );
    await mustReject(
      getAdminSql()`
        INSERT INTO awcms_commerce_loyalty_ledger
          (tenant_id, account_id, account_seq, kind, points, balance_after,
           source_type, source_id, idempotency_key)
        VALUES (${TENANT_A}, ${account}, 99, 'restore', 5, 15, 'order', gen_random_uuid(), 'bad-restore-2')
      `
    );
  }, 30000);

  // -------------------------------------------------------------------------
  // Earn interplay and the counter
  // -------------------------------------------------------------------------

  test("points are not rewarded again: the earn base excludes the points discount", async () => {
    await inTenant(TENANT_A, async (tx) => {
      const program = await createLoyaltyProgram(tx, TENANT_A, ACTOR, {
        name: "Poin",
        earnUnitAmount: "1000.00",
        earnPointsPerUnit: 1,
        minOrderAmount: "0.00",
        maxPointsPerOrder: null,
        expiryDays: null,
        notes: null,
        eligibilitySegmentId: null,
        eligibilitySegmentVersion: null
      });
      await activateLoyaltyProgram(
        tx,
        TENANT_A,
        ACTOR,
        program.id,
        new Date("2026-09-01T00:00:00.000Z")
      );
    });
    const created = await place(
      TENANT_A,
      orderInput(productId, { loyaltyRedemption: { points: 5000 } }),
      siti
    );
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    const orderId = (
      (await getAdminSql()`
        UPDATE awcms_commerce_orders
        SET status = 'paid', payment_status = 'paid', paid_at = ${NOW}
        WHERE order_code = ${created.order.orderCode}
        RETURNING id
      `) as { id: string }[]
    )[0]!.id;
    const earned = await inTenant(TENANT_A, (tx) =>
      earnPointsForPaidOrder(tx, TENANT_A, orderId)
    );
    expect(earned.kind).toBe("earned");
    // Goods 20 000 less the 10 000 paid for in points = 10 000 -> 10 points, not 20.
    if (earned.kind === "earned") expect(earned.entry.points).toBe(10);
  }, 30000);

  test("POS: the sale's own customer (by phone) is the account; the tenders cover the total NET of the points discount; a walk-in sale cannot redeem; the debit and the discount commit together", async () => {
    const posInput = (
      overrides: Partial<CreatePosOrderInput> = {}
    ): CreatePosOrderInput => ({
      idempotencyKey: "pppppppp-0000-4000-8000-000000000001",
      customer: { name: null, phone: PHONE_SITI },
      lines: [{ productId, variantId: null, quantity: 2 }],
      payment: null,
      // goods 20 000 + 10 % tax = 22 000; 5 000 points x Rp 2 = 10 000 off -> 12 000 due.
      tenders: [{ tenderType: "cash", amount: "12000.00", reference: null }],
      allowDue: false,
      loyaltyRedemption: { points: 5000 },
      notes: null,
      ...overrides
    });

    // Walk-in (no phone): no account to spend from.
    expect(
      await caught(
        inTenant(TENANT_A, (tx) =>
          createPosOrder(
            tx,
            TENANT_A,
            ACTOR,
            mediaLibraryPortAdapter,
            posInput({ customer: { name: null, phone: null } }),
            NOW
          )
        )
      )
    ).toBeInstanceOf(PosLoyaltyRefusedError);

    const sale = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        ACTOR,
        mediaLibraryPortAdapter,
        posInput(),
        NOW
      )
    );
    expect(sale.kind).toBe("created");
    if (sale.kind !== "created") return;
    expect(sale.order.loyaltyDiscount).toBe("10000.00");
    expect(sale.order.loyaltyPointsRedeemed).toBe(5000);
    expect(sale.order.total).toBe("12000.00");
    expect(sale.order.status).toBe("paid");
    expect(await balanceOf(TENANT_A, siti)).toBe(15000);

    const redeem = (await ledgerRows(TENANT_A, siti)).filter(
      (row) => row.kind === "redeem"
    );
    expect(redeem).toHaveLength(1);
    expect(redeem[0]!.idempotency_key).toMatch(
      /^redeem:[0-9a-f-]{36}:pos:pppppppp-0000-4000-8000-000000000001$/
    );
    const record = await inTenant(TENANT_A, async (tx) => {
      const rows = (await tx`
        SELECT id FROM awcms_commerce_orders WHERE order_code = ${sale.order.orderCode}
      `) as { id: string }[];
      return fetchRedemptionForOrder(tx, TENANT_A, rows[0]!.id);
    });
    expect(record?.channel).toBe("pos");

    // Replay: same key and request -> the same sale, still one debit.
    const replay = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        ACTOR,
        mediaLibraryPortAdapter,
        posInput(),
        NOW
      )
    );
    expect(replay.kind).toBe("replayed");
    expect(await balanceOf(TENANT_A, siti)).toBe(15000);

    // Same key, different points -> a conflict.
    expect(
      await caught(
        inTenant(TENANT_A, (tx) =>
          createPosOrder(
            tx,
            TENANT_A,
            ACTOR,
            mediaLibraryPortAdapter,
            posInput({ loyaltyRedemption: { points: 4000 } }),
            NOW
          )
        )
      )
    ).toBeInstanceOf(IdempotencyPayloadMismatchError);

    // A different customer's balance is not reachable by typing her phone as
    // someone else: Budi has no points, so redeeming under his phone is refused.
    expect(
      await caught(
        inTenant(TENANT_A, (tx) =>
          createPosOrder(
            tx,
            TENANT_A,
            ACTOR,
            mediaLibraryPortAdapter,
            posInput({
              idempotencyKey: "pppppppp-0000-4000-8000-000000000002",
              customer: { name: null, phone: PHONE_BUDI }
            }),
            NOW
          )
        )
      )
    ).toBeInstanceOf(PosLoyaltyRefusedError);
    expect(await balanceOf(TENANT_A, siti)).toBe(15000);
  }, 60000);
});
