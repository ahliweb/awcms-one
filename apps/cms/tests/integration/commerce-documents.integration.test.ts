/**
 * Commerce document lifecycle integration (Issue #286, epic #281 and #280,
 * ADR-0029) - against a REAL migrated Postgres through
 * `tests/integration/harness.ts`, the same pattern `commerce-register-cash-up`
 * uses. Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * Covers exactly the properties only a real database can prove:
 *
 *   - document NUMBER allocation: N genuinely concurrent transactions get
 *     exactly 1..N (no duplicate, no gap); a transaction that allocates and then
 *     fails gives its number back; tenants, document types and years count
 *     independently; the counter row cannot be skipped, reset or deleted;
 *   - held sales: no stock is reserved, ownership (another cashier's cart is a
 *     neutral not-found unless the supervisor key is held), single-use resume,
 *     lazy expiry that persists and wipes the cart, idempotent replay;
 *   - quotations: exact totals, an immutable versioned snapshot (revise adds a
 *     version, never edits one; the DB refuses the edit), the status machine,
 *     expiry at accept time;
 *   - quotation -> order conversion: one order ever (two concurrent conversions
 *     serialise), provenance on both sides, a changed price rolls the order back
 *     unless accepted, no stock is touched on refusal;
 *   - work orders: the status machine and its append-only history, provenance
 *     from an accepted quotation, identical rejection of foreign references;
 *   - receipt / invoice documents: an immutable snapshot whose money equals the
 *     order's, one per (order, type), gapless numbers under concurrency,
 *     eligibility, tamper detection on render, reprint never mutates;
 *   - RLS cross-tenant isolation and tenant-safe composite foreign keys.
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
import { fetchCommerceFeatures } from "../../src/modules/commerce/application/commerce-feature-gate";
import { allocateDocumentNumber } from "../../src/modules/commerce/application/document-numbering";
import {
  fetchDocument,
  issueDocument,
  renderStoredDocument
} from "../../src/modules/commerce/application/document-directory";
import {
  discardHeldSale,
  holdSale,
  listHeldSales,
  resumeHeldSale
} from "../../src/modules/commerce/application/held-sale-directory";
import { IdempotencyPayloadMismatchError } from "../../src/modules/commerce/application/order-directory";
import {
  createPosOrder,
  PosCartChangedError
} from "../../src/modules/commerce/application/pos-directory";
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import {
  applyQuotationAction,
  convertQuotation,
  createQuotation,
  fetchQuotation,
  listQuotations,
  reviseQuotation
} from "../../src/modules/commerce/application/quotation-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import {
  createWorkOrder,
  fetchWorkOrder,
  updateWorkOrder
} from "../../src/modules/commerce/application/work-order-directory";
import {
  contentHash,
  formatDocumentNumber,
  validateConvertQuotationInput,
  validateCreateQuotationInput,
  validateCreateWorkOrderInput,
  validateHoldSaleInput,
  validateIssueDocumentInput,
  validateQuotationActionInput,
  validateReviseQuotationInput,
  validateWorkOrderUpdateInput,
  type DocumentSequenceType,
  type QuotationAction,
  type WorkOrderStatus
} from "../../src/modules/commerce/domain/documents";
import type { CreatePosOrderInput } from "../../src/modules/commerce/domain/pos-order-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
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
const CASHIER_1 = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const CASHIER_2 = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const B_CASHIER = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
const NOW = new Date("2026-10-03T03:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PHONE = "081234567890";

/** A Bun.SQL query is a lazy thenable; route it through a real Promise for `expect(...).rejects`. */
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
    VALUES (${tenantId}, 'person', 'Documents Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`doc-actor-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function enableSelfPickup(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko <Dokumen>",
    address: "Jl. Contoh 1",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, CASHIER_1, validated.value)
  );
}

async function configureDocuments(
  tenantId: string,
  documents: boolean
): Promise<void> {
  await inTenant(tenantId, (tx) =>
    updateModuleSettings(
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
          register: false,
          documents
        }
      },
      CASHIER_1
    )
  );
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-DOC",
  name: "Jasa Servis",
  slug: "jasa-servis-doc",
  description: null,
  digitalNote: null,
  price: "10000.00",
  discountPercent: 0,
  stock: 500,
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
  overrides: Partial<CreateProductInput> = {}
): Promise<string> {
  const product = await inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, CASHIER_1, { ...BASE_PRODUCT, ...overrides })
  );
  await inTenant(
    tenantId,
    (tx) =>
      tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
  );
  return product.id;
}

async function stockOf(tenantId: string, productId: string): Promise<number> {
  const rows = await inTenant(
    tenantId,
    (tx) =>
      tx`SELECT stock FROM awcms_commerce_products WHERE id = ${productId}`
  );
  return Number((rows[0] as { stock: number }).stock);
}

const keyOf = () => crypto.randomUUID();

async function hold(
  tenantId: string,
  productId: string,
  options: {
    actor?: string;
    now?: Date;
    ttlHours?: number;
    key?: string;
    quantity?: number;
  } = {}
) {
  const validated = validateHoldSaleInput(
    {
      label: "Meja 4",
      lines: [{ productId, variantId: null, quantity: options.quantity ?? 2 }],
      customer: { name: "Budi", phone: PHONE },
      notes: "tanpa gula",
      ttlHours: options.ttlHours
    },
    options.key ?? keyOf()
  );
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  return inTenant(tenantId, (tx) =>
    holdSale(
      tx,
      tenantId,
      options.actor ?? CASHIER_1,
      validated.value,
      options.now ?? NOW
    )
  );
}

async function holdOk(
  tenantId: string,
  productId: string,
  options: Parameters<typeof hold>[2] = {}
): Promise<string> {
  const outcome = await hold(tenantId, productId, options);
  if (outcome.kind !== "created") {
    throw new Error(`expected created, got ${outcome.kind}`);
  }
  return outcome.heldSale.id;
}

function decision(key: string = keyOf()) {
  const validated = validateQuotationActionInput({}, key);
  if (!validated.valid) throw new Error("bad key");
  return validated.value;
}

async function newQuotation(
  tenantId: string,
  productId: string,
  options: {
    actor?: string;
    now?: Date;
    validUntil?: Date;
    quantity?: number;
    key?: string;
  } = {}
) {
  const now = options.now ?? NOW;
  const validated = validateCreateQuotationInput(
    {
      customer: { name: "Pak Budi", phone: PHONE },
      lines: [{ productId, variantId: null, quantity: options.quantity ?? 2 }],
      validUntil: (
        options.validUntil ?? new Date(now.getTime() + 7 * DAY)
      ).toISOString(),
      notes: "servis rutin"
    },
    options.key ?? keyOf(),
    now
  );
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  return inTenant(tenantId, (tx) =>
    createQuotation(
      tx,
      tenantId,
      options.actor ?? CASHIER_1,
      mediaLibraryPortAdapter,
      validated.value,
      now
    )
  );
}

async function newQuotationOk(
  tenantId: string,
  productId: string,
  options: Parameters<typeof newQuotation>[2] = {}
) {
  const outcome = await newQuotation(tenantId, productId, options);
  if (outcome.kind !== "created") {
    throw new Error(`expected created, got ${outcome.kind}`);
  }
  return outcome.quotation;
}

async function act(
  tenantId: string,
  quotationId: string,
  action: QuotationAction,
  options: { actor?: string; now?: Date; key?: string } = {}
) {
  return inTenant(tenantId, (tx) =>
    applyQuotationAction(
      tx,
      tenantId,
      options.actor ?? CASHIER_1,
      quotationId,
      action,
      decision(options.key),
      options.now ?? NOW
    )
  );
}

async function acceptedQuotation(
  tenantId: string,
  productId: string,
  options: Parameters<typeof newQuotation>[2] = {}
) {
  const quotation = await newQuotationOk(tenantId, productId, options);
  expect((await act(tenantId, quotation.id, "send", options)).kind).toBe(
    "done"
  );
  expect((await act(tenantId, quotation.id, "accept", options)).kind).toBe(
    "done"
  );
  return quotation;
}

function convertInput(
  options: { acceptPriceChange?: boolean; key?: string } = {}
) {
  const validated = validateConvertQuotationInput(
    { acceptPriceChange: options.acceptPriceChange ?? false },
    options.key ?? keyOf()
  );
  if (!validated.valid) throw new Error("bad convert input");
  return validated.value;
}

async function convert(
  tenantId: string,
  quotationId: string,
  options: {
    actor?: string;
    acceptPriceChange?: boolean;
    key?: string;
    now?: Date;
  } = {}
) {
  return inTenant(tenantId, (tx) =>
    convertQuotation(
      tx,
      tenantId,
      options.actor ?? CASHIER_1,
      mediaLibraryPortAdapter,
      quotationId,
      convertInput(options),
      options.now ?? NOW
    )
  );
}

function posInput(
  productId: string,
  overrides: Partial<CreatePosOrderInput> = {}
): CreatePosOrderInput {
  return {
    idempotencyKey: keyOf(),
    customer: { name: "Siti", phone: PHONE },
    lines: [{ productId, variantId: null, quantity: 2 }],
    payment: { method: "cash", amountTendered: "50000.00" },
    tenders: null,
    allowDue: false,
    registerId: null,
    notes: null,
    ...overrides
  };
}

/** A fully paid POS order (2 x 10000.00 = 20000.00). */
async function paidOrder(tenantId: string, productId: string) {
  const outcome = await inTenant(tenantId, (tx) =>
    createPosOrder(
      tx,
      tenantId,
      CASHIER_1,
      mediaLibraryPortAdapter,
      posInput(productId),
      NOW
    )
  );
  if (outcome.kind !== "created") throw new Error("order not created");
  return outcome.order;
}

/** An order with the whole total still due. */
async function dueOrder(tenantId: string, productId: string) {
  const outcome = await inTenant(tenantId, (tx) =>
    createPosOrder(
      tx,
      tenantId,
      CASHIER_1,
      mediaLibraryPortAdapter,
      posInput(productId, { payment: null, tenders: [], allowDue: true }),
      NOW
    )
  );
  if (outcome.kind !== "created") throw new Error("order not created");
  return outcome.order;
}

function issueInput(
  orderId: string,
  docType: "receipt" | "invoice",
  key: string = keyOf()
) {
  const validated = validateIssueDocumentInput({ orderId, docType }, key);
  if (!validated.valid) throw new Error("bad issue input");
  return validated.value;
}

async function issue(
  tenantId: string,
  orderId: string,
  docType: "receipt" | "invoice",
  options: { key?: string; now?: Date; actor?: string } = {}
) {
  return inTenant(tenantId, (tx) =>
    issueDocument(
      tx,
      tenantId,
      options.actor ?? CASHIER_1,
      mediaLibraryPortAdapter,
      issueInput(orderId, docType, options.key),
      options.now ?? NOW
    )
  );
}

async function issueOk(
  tenantId: string,
  orderId: string,
  docType: "receipt" | "invoice",
  options: Parameters<typeof issue>[3] = {}
) {
  const outcome = await issue(tenantId, orderId, docType, options);
  if (outcome.kind !== "issued") {
    throw new Error(`expected issued, got ${outcome.kind}`);
  }
  return outcome;
}

async function newWorkOrder(
  tenantId: string,
  overrides: Record<string, unknown> = {},
  key: string = keyOf()
) {
  const validated = validateCreateWorkOrderInput(
    { title: "Servis AC", priority: "high", ...overrides },
    key
  );
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  return inTenant(tenantId, (tx) =>
    createWorkOrder(tx, tenantId, CASHIER_1, validated.value, NOW)
  );
}

async function newWorkOrderOk(
  tenantId: string,
  overrides: Record<string, unknown> = {}
) {
  const outcome = await newWorkOrder(tenantId, overrides);
  if (outcome.kind !== "created") {
    throw new Error(`expected created, got ${outcome.kind}`);
  }
  return outcome.workOrder;
}

async function moveWorkOrder(
  tenantId: string,
  workOrderId: string,
  body: Record<string, unknown>,
  key: string = keyOf()
) {
  const validated = validateWorkOrderUpdateInput(body, key);
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  return inTenant(tenantId, (tx) =>
    updateWorkOrder(tx, tenantId, CASHIER_1, workOrderId, validated.value, NOW)
  );
}

suite("commerce document lifecycle integration (Issue #286)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-doc-a");
    await seedTenant(TENANT_B, "tenant-doc-b");
    for (const id of [CASHIER_1, CASHIER_2]) {
      await seedTenantUser(TENANT_A, id);
    }
    await seedTenantUser(TENANT_B, B_CASHIER);
    await enableSelfPickup(TENANT_A);
    await enableSelfPickup(TENANT_B);
    await configureDocuments(TENANT_A, true);
  }, 30000);

  // -------------------------------------------------------------------------
  // The feature flag
  // -------------------------------------------------------------------------
  describe("feature flag", () => {
    test("`documents` defaults OFF for a tenant that never opened Features", async () => {
      const features = await inTenant(TENANT_B, (tx) =>
        fetchCommerceFeatures(tx, TENANT_B)
      );
      expect(features.documents).toBe(false);
      expect(features.pos).toBe(true);
      const turnedOn = await inTenant(TENANT_A, (tx) =>
        fetchCommerceFeatures(tx, TENANT_A)
      );
      expect(turnedOn.documents).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Numbering
  // -------------------------------------------------------------------------
  describe("document numbering", () => {
    async function allocateIn(
      tenantId: string,
      type: DocumentSequenceType,
      now: Date = NOW
    ) {
      return inTenant(tenantId, (tx) =>
        allocateDocumentNumber(tx, tenantId, type, now)
      );
    }

    test("a sequence starts at 1 and counts per tenant, per type and per year", async () => {
      expect((await allocateIn(TENANT_A, "invoice")).number).toBe(
        "INV-2026-000001"
      );
      expect((await allocateIn(TENANT_A, "invoice")).number).toBe(
        "INV-2026-000002"
      );
      expect((await allocateIn(TENANT_A, "receipt")).number).toBe(
        "RCP-2026-000001"
      );
      expect((await allocateIn(TENANT_B, "invoice")).number).toBe(
        "INV-2026-000001"
      );
      const nextYear = new Date("2027-01-01T00:00:00.000Z");
      expect((await allocateIn(TENANT_A, "invoice", nextYear)).number).toBe(
        "INV-2027-000001"
      );
      expect(formatDocumentNumber("work_order", "2026", 7)).toBe(
        "WO-2026-000007"
      );
    });

    test("25 genuinely concurrent allocations receive exactly 1..25 - no duplicate, no gap", async () => {
      const results = await Promise.all(
        Array.from({ length: 25 }, () => allocateIn(TENANT_A, "quotation"))
      );
      const counters = results
        .map((entry) => entry.counter)
        .sort((a, b) => a - b);
      expect(counters).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      expect(new Set(results.map((entry) => entry.number)).size).toBe(25);
    });

    test("a transaction that allocates and then fails hands its number back: no gap", async () => {
      expect((await allocateIn(TENANT_A, "receipt")).counter).toBe(1);
      await expect(
        inTenant(TENANT_A, async (tx) => {
          const taken = await allocateDocumentNumber(
            tx,
            TENANT_A,
            "receipt",
            NOW
          );
          expect(taken.counter).toBe(2);
          throw new Error("boom after allocation");
        })
      ).rejects.toThrow("boom after allocation");
      expect((await allocateIn(TENANT_A, "receipt")).counter).toBe(2);
    });

    test("the counter row cannot be skipped, rewound or deleted", async () => {
      await allocateIn(TENANT_A, "invoice");
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`UPDATE awcms_commerce_document_sequences SET last_number = last_number + 5`
          )
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`UPDATE awcms_commerce_document_sequences SET last_number = 0`
          )
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) => tx`DELETE FROM awcms_commerce_document_sequences`
          )
        )
      ).rejects.toThrow();
      expect((await allocateIn(TENANT_A, "invoice")).counter).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Held sales
  // -------------------------------------------------------------------------
  describe("held sales", () => {
    test("holding reserves NO stock and stores lines only (no price)", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const before = await stockOf(TENANT_A, productId);
      const id = await holdOk(TENANT_A, productId);
      expect(await stockOf(TENANT_A, productId)).toBe(before);

      const rows = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT cart, line_count, status FROM awcms_commerce_held_sales WHERE id = ${id}`
      )) as {
        cart: Record<string, unknown>;
        line_count: number;
        status: string;
      }[];
      expect(rows[0]!.status).toBe("held");
      expect(Number(rows[0]!.line_count)).toBe(1);
      expect(JSON.stringify(rows[0]!.cart)).not.toContain("price");
    });

    test("hold is idempotent: the same key replays, a different payload is a mismatch", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const key = keyOf();
      const first = await hold(TENANT_A, productId, { key });
      const second = await hold(TENANT_A, productId, { key });
      expect(first.kind).toBe("created");
      expect(second.kind).toBe("replayed");
      if (first.kind !== "created" || second.kind !== "replayed") return;
      expect(second.heldSale.id).toBe(first.heldSale.id);
      const count = (await inTenant(
        TENANT_A,
        (tx) => tx`SELECT count(*)::int AS n FROM awcms_commerce_held_sales`
      )) as { n: number }[];
      expect(count[0]!.n).toBe(1);
      await expect(
        hold(TENANT_A, productId, { key, quantity: 9 })
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    });

    test("ownership: another cashier gets a neutral not_found; the supervisor key lets them through", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const id = await holdOk(TENANT_A, productId, { actor: CASHIER_1 });

      const denied = await inTenant(TENANT_A, (tx) =>
        resumeHeldSale(
          tx,
          TENANT_A,
          CASHIER_2,
          async () => false,
          id,
          decision(),
          NOW
        )
      );
      expect(denied.kind).toBe("not_found");
      // ... and it is still held afterwards.
      const still = await inTenant(TENANT_A, (tx) =>
        listHeldSales(
          tx,
          TENANT_A,
          { actorTenantUserId: CASHIER_1, all: false },
          null,
          "held",
          NOW
        )
      );
      expect(still.items.map((item) => item.id)).toEqual([id]);

      // The listing is owner-scoped unless the caller may see all.
      const otherView = await inTenant(TENANT_A, (tx) =>
        listHeldSales(
          tx,
          TENANT_A,
          { actorTenantUserId: CASHIER_2, all: false },
          null,
          null,
          NOW
        )
      );
      expect(otherView.items).toHaveLength(0);
      const supervisorView = await inTenant(TENANT_A, (tx) =>
        listHeldSales(
          tx,
          TENANT_A,
          { actorTenantUserId: CASHIER_2, all: true },
          null,
          null,
          NOW
        )
      );
      expect(supervisorView.items).toHaveLength(1);

      let asked = 0;
      const allowed = await inTenant(TENANT_A, (tx) =>
        resumeHeldSale(
          tx,
          TENANT_A,
          CASHIER_2,
          async () => {
            asked += 1;
            return true;
          },
          id,
          decision(),
          NOW
        )
      );
      expect(allowed.kind).toBe("done");
      expect(asked).toBe(1);
    });

    test("the supervisor check is NOT consulted for the owner's own cart", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const id = await holdOk(TENANT_A, productId);
      let asked = 0;
      const outcome = await inTenant(TENANT_A, (tx) =>
        resumeHeldSale(
          tx,
          TENANT_A,
          CASHIER_1,
          async () => {
            asked += 1;
            return false;
          },
          id,
          decision(),
          NOW
        )
      );
      expect(outcome.kind).toBe("done");
      expect(asked).toBe(0);
    });

    test("resume is single-use: it returns the lines once, wipes the stored cart, and replays on the same key", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const id = await holdOk(TENANT_A, productId);
      const key = keyOf();
      const first = await inTenant(TENANT_A, (tx) =>
        resumeHeldSale(
          tx,
          TENANT_A,
          CASHIER_1,
          async () => false,
          id,
          decision(key),
          NOW
        )
      );
      expect(first.kind).toBe("done");
      if (first.kind !== "done") return;
      const resumed = first.heldSale as {
        cart: {
          lines: {
            productId: string;
            variantId: string | null;
            quantity: number;
          }[];
          customer: { phone: string } | null;
        };
      };
      expect(resumed.cart.lines).toEqual([
        { productId, variantId: null, quantity: 2 }
      ]);
      expect(resumed.cart.customer?.phone).toBe(PHONE);

      const wiped = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT cart, status FROM awcms_commerce_held_sales WHERE id = ${id}`
      )) as { cart: Record<string, unknown>; status: string }[];
      expect(wiped[0]!.status).toBe("resumed");
      expect(Object.keys(wiped[0]!.cart)).toHaveLength(0);

      const replay = await inTenant(TENANT_A, (tx) =>
        resumeHeldSale(
          tx,
          TENANT_A,
          CASHIER_1,
          async () => false,
          id,
          decision(key),
          NOW
        )
      );
      expect(replay.kind).toBe("replayed");
      const second = await inTenant(TENANT_A, (tx) =>
        resumeHeldSale(
          tx,
          TENANT_A,
          CASHIER_1,
          async () => false,
          id,
          decision(),
          NOW
        )
      );
      expect(second).toEqual({ kind: "not_held", status: "resumed" });
    });

    test("expiry: past its time a held sale reads expired, cannot be resumed, and the first touch persists it", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const id = await holdOk(TENANT_A, productId, { ttlHours: 1 });
      const later = new Date(NOW.getTime() + 2 * HOUR);

      const listed = await inTenant(TENANT_A, (tx) =>
        listHeldSales(
          tx,
          TENANT_A,
          { actorTenantUserId: CASHIER_1, all: false },
          null,
          null,
          later
        )
      );
      expect(listed.items[0]!.status).toBe("expired");
      const heldFilter = await inTenant(TENANT_A, (tx) =>
        listHeldSales(
          tx,
          TENANT_A,
          { actorTenantUserId: CASHIER_1, all: false },
          null,
          "held",
          later
        )
      );
      expect(heldFilter.items).toHaveLength(0);

      const outcome = await inTenant(TENANT_A, (tx) =>
        resumeHeldSale(
          tx,
          TENANT_A,
          CASHIER_1,
          async () => false,
          id,
          decision(),
          later
        )
      );
      expect(outcome.kind).toBe("expired");
      const stored = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT status, cart FROM awcms_commerce_held_sales WHERE id = ${id}`
      )) as { status: string; cart: Record<string, unknown> }[];
      expect(stored[0]!.status).toBe("expired");
      expect(Object.keys(stored[0]!.cart)).toHaveLength(0);
    });

    test("discard wipes the cart; a closed held sale cannot be edited by the database", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const id = await holdOk(TENANT_A, productId);
      const outcome = await inTenant(TENANT_A, (tx) =>
        discardHeldSale(
          tx,
          TENANT_A,
          CASHIER_1,
          async () => false,
          id,
          decision(),
          NOW
        )
      );
      expect(outcome.kind).toBe("done");
      await expect(
        attempt(
          getAdminSql()`UPDATE awcms_commerce_held_sales SET status = 'held' WHERE id = ${id}`
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) => tx`DELETE FROM awcms_commerce_held_sales WHERE id = ${id}`
          )
        )
      ).rejects.toThrow();
    });

    test("a cashier may park at most 50 active carts", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      for (let i = 0; i < 50; i += 1) {
        await holdOk(TENANT_A, productId);
      }
      const over = await hold(TENANT_A, productId);
      expect(over).toEqual({ kind: "limit_reached", limit: 50 });
      // ... another cashier's allowance is separate.
      expect((await hold(TENANT_A, productId, { actor: CASHIER_2 })).kind).toBe(
        "created"
      );
    }, 60000);

    test("an unknown register is refused before anything is written", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const validated = validateHoldSaleInput(
        {
          lines: [{ productId, quantity: 1 }],
          registerId: "00000000-0000-4000-8000-000000000000"
        },
        keyOf()
      );
      if (!validated.valid) throw new Error("invalid");
      const outcome = await inTenant(TENANT_A, (tx) =>
        holdSale(tx, TENANT_A, CASHIER_1, validated.value, NOW)
      );
      expect(outcome.kind).toBe("register_not_found");
    });
  });

  // -------------------------------------------------------------------------
  // Quotations
  // -------------------------------------------------------------------------
  describe("quotations", () => {
    test("a quotation freezes an exactly priced version with a verifiable hash and a gapless number", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const stockBefore = await stockOf(TENANT_A, productId);
      const first = await newQuotationOk(TENANT_A, productId, { quantity: 3 });
      const second = await newQuotationOk(TENANT_A, productId);
      expect(first.number).toBe("QUO-2026-000001");
      expect(second.number).toBe("QUO-2026-000002");
      expect(first.status).toBe("draft");
      expect(first.total).toBe("30000.00");
      expect(first.versions).toHaveLength(1);
      const version = first.versions[0]!;
      expect(version.subtotal).toBe("30000.00");
      expect(version.lines[0]).toMatchObject({
        productId,
        quantity: 3,
        unitPrice: "10000.00",
        lineTotal: "30000.00"
      });
      expect(version.customer).toMatchObject({ name: "Pak Budi" });
      expect(version.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // The hash is a function of the stored content, and nothing else.
      expect(
        contentHash({
          version: 1,
          validUntil: version.validUntil,
          customer: version.customer,
          notes: version.notes,
          lines: version.lines,
          subtotal: version.subtotal,
          discount: version.discount,
          tax: version.tax,
          total: version.total,
          pricingContext: version.pricingContext
        })
      ).toBe(version.contentHash);
      // An offer reserves nothing.
      expect(await stockOf(TENANT_A, productId)).toBe(stockBefore);
    });

    test("create is idempotent: same key replays one quotation, a different payload is a mismatch", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const key = keyOf();
      const first = await newQuotation(TENANT_A, productId, { key });
      const second = await newQuotation(TENANT_A, productId, { key });
      expect(first.kind).toBe("created");
      expect(second.kind).toBe("replayed");
      const count = (await inTenant(
        TENANT_A,
        (tx) => tx`SELECT count(*)::int AS n FROM awcms_commerce_quotations`
      )) as { n: number }[];
      expect(count[0]!.n).toBe(1);
      await expect(
        newQuotation(TENANT_A, productId, { key, quantity: 7 })
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    });

    test("an invalid phone is refused and consumes no number", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const validated = validateCreateQuotationInput(
        {
          customer: { name: "X", phone: "12" },
          lines: [{ productId, quantity: 1 }]
        },
        keyOf(),
        NOW
      );
      if (!validated.valid) throw new Error("invalid");
      const outcome = await inTenant(TENANT_A, (tx) =>
        createQuotation(
          tx,
          TENANT_A,
          CASHIER_1,
          mediaLibraryPortAdapter,
          validated.value,
          NOW
        )
      );
      expect(outcome.kind).toBe("invalid_phone");
      expect((await newQuotationOk(TENANT_A, productId)).number).toBe(
        "QUO-2026-000001"
      );
    });

    test("an unpriceable cart throws before a number is taken (no gap)", async () => {
      const productId = await seedActiveProduct(TENANT_A, { stock: 1 });
      await expect(
        newQuotation(TENANT_A, productId, { quantity: 5 })
      ).rejects.toThrow();
      expect(
        (await newQuotationOk(TENANT_A, productId, { quantity: 1 })).number
      ).toBe("QUO-2026-000001");
    });

    test("revising adds a version and never edits an earlier one; the database refuses the edit", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const original = await newQuotationOk(TENANT_A, productId);
      await act(TENANT_A, original.id, "send");

      const validated = validateReviseQuotationInput(
        {
          lines: [{ productId, quantity: 5 }],
          validUntil: new Date(NOW.getTime() + 10 * DAY).toISOString()
        },
        keyOf(),
        NOW
      );
      if (!validated.valid) throw new Error("invalid");
      const revised = await inTenant(TENANT_A, (tx) =>
        reviseQuotation(
          tx,
          TENANT_A,
          CASHIER_1,
          mediaLibraryPortAdapter,
          original.id,
          validated.value,
          NOW
        )
      );
      expect(revised.kind).toBe("created");
      if (revised.kind !== "created") return;
      expect(revised.quotation.currentVersion).toBe(2);
      expect(revised.quotation.status).toBe("draft");
      expect(revised.quotation.total).toBe("50000.00");
      expect(revised.quotation.versions).toHaveLength(2);
      // Version 1 is exactly what it was.
      expect(revised.quotation.versions[0]).toEqual(original.versions[0]!);
      // The customer carried over to the new version.
      expect(revised.quotation.versions[1]!.customer).toEqual(
        original.versions[0]!.customer
      );

      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`UPDATE awcms_commerce_quotation_versions SET total = 1 WHERE version = 1`
          )
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          getAdminSql()`UPDATE awcms_commerce_quotation_versions SET total = 1 WHERE version = 1`
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) => tx`DELETE FROM awcms_commerce_quotation_versions`
          )
        )
      ).rejects.toThrow();
    });

    test("the status machine: draft -> sent -> accepted pins the version; illegal moves are refused", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const quotation = await newQuotationOk(TENANT_A, productId);

      expect((await act(TENANT_A, quotation.id, "accept")).kind).toBe(
        "illegal"
      );
      expect((await act(TENANT_A, quotation.id, "send")).kind).toBe("done");
      expect((await act(TENANT_A, quotation.id, "send")).kind).toBe("illegal");
      const accepted = await act(TENANT_A, quotation.id, "accept");
      expect(accepted.kind).toBe("done");
      if (accepted.kind !== "done") return;
      expect(accepted.quotation.status).toBe("accepted");
      expect(accepted.quotation.acceptedVersion).toBe(1);

      // An accepted quotation is no longer revisable and cannot be rejected.
      const validated = validateReviseQuotationInput(
        { lines: [{ productId, quantity: 1 }] },
        keyOf(),
        NOW
      );
      if (!validated.valid) throw new Error("invalid");
      const revise = await inTenant(TENANT_A, (tx) =>
        reviseQuotation(
          tx,
          TENANT_A,
          CASHIER_1,
          mediaLibraryPortAdapter,
          quotation.id,
          validated.value,
          NOW
        )
      );
      expect(revise).toEqual({ kind: "not_revisable", status: "accepted" });
      expect((await act(TENANT_A, quotation.id, "reject")).kind).toBe(
        "illegal"
      );
      expect((await act(TENANT_A, quotation.id, "cancel")).kind).toBe("done");
      // The database mirrors the machine for a writer that skips the app.
      await expect(
        attempt(
          getAdminSql()`UPDATE awcms_commerce_quotations SET status = 'sent' WHERE id = ${quotation.id}`
        )
      ).rejects.toThrow();
    });

    test("expiry: an offer past its validity reads expired, cannot be accepted, and may be revised", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const quotation = await newQuotationOk(TENANT_A, productId, {
        validUntil: new Date(NOW.getTime() + DAY)
      });
      await act(TENANT_A, quotation.id, "send");
      const later = new Date(NOW.getTime() + 2 * DAY);

      const read = await inTenant(TENANT_A, (tx) =>
        fetchQuotation(tx, TENANT_A, quotation.id, later)
      );
      expect(read!.status).toBe("expired");
      const filtered = await inTenant(TENANT_A, (tx) =>
        listQuotations(tx, TENANT_A, null, { status: "expired" }, later)
      );
      expect(filtered.items.map((item) => item.id)).toEqual([quotation.id]);
      const stillSent = await inTenant(TENANT_A, (tx) =>
        listQuotations(tx, TENANT_A, null, { status: "sent" }, later)
      );
      expect(stillSent.items).toHaveLength(0);

      const accept = await act(TENANT_A, quotation.id, "accept", {
        now: later
      });
      expect(accept.kind).toBe("expired");
      const stored = await inTenant(TENANT_A, (tx) =>
        fetchQuotation(tx, TENANT_A, quotation.id, later)
      );
      expect(stored!.status).toBe("expired");

      const validated = validateReviseQuotationInput(
        {
          lines: [{ productId, quantity: 1 }],
          validUntil: new Date(later.getTime() + 5 * DAY).toISOString()
        },
        keyOf(),
        later
      );
      if (!validated.valid) throw new Error("invalid");
      const revise = await inTenant(TENANT_A, (tx) =>
        reviseQuotation(
          tx,
          TENANT_A,
          CASHIER_1,
          mediaLibraryPortAdapter,
          quotation.id,
          validated.value,
          later
        )
      );
      expect(revise.kind).toBe("created");
      if (revise.kind !== "created") return;
      expect(revise.quotation.status).toBe("draft");
      expect(revise.quotation.currentVersion).toBe(2);
    });

    test("every action is idempotent on its key", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const quotation = await newQuotationOk(TENANT_A, productId);
      const key = keyOf();
      expect((await act(TENANT_A, quotation.id, "send", { key })).kind).toBe(
        "done"
      );
      expect((await act(TENANT_A, quotation.id, "send", { key })).kind).toBe(
        "replayed"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Conversion
  // -------------------------------------------------------------------------
  describe("quotation -> order conversion", () => {
    test("an accepted quotation becomes ONE order with the balance due, with provenance on both sides", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const quotation = await acceptedQuotation(TENANT_A, productId);
      const stockBefore = await stockOf(TENANT_A, productId);

      const outcome = await convert(TENANT_A, quotation.id);
      expect(outcome.kind).toBe("converted");
      if (outcome.kind !== "converted") return;
      expect(outcome.result.alreadyConverted).toBe(false);
      expect(outcome.result.order.total).toBe("20000.00");
      expect(outcome.result.order.status).toBe("pending_payment");
      expect(outcome.result.quotation.status).toBe("converted");
      expect(outcome.result.quotation.convertedOrderId).toBe(
        outcome.result.order.id
      );
      // The order path decremented stock exactly like any sale.
      expect(await stockOf(TENANT_A, productId)).toBe(stockBefore - 2);

      const orders = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT channel, payment_status, total, notes FROM awcms_commerce_orders WHERE id = ${outcome.result.order.id}`
      )) as {
        channel: string;
        payment_status: string;
        total: string;
        notes: string;
      }[];
      expect(orders[0]!.channel).toBe("pos");
      expect(orders[0]!.payment_status).toBe("unpaid");
      expect(orders[0]!.notes).toContain(quotation.number);

      // No second money authority: the ledger is empty - payment is taken later.
      const legs = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT count(*)::int AS n FROM awcms_commerce_payment_allocations WHERE order_id = ${outcome.result.order.id}`
      )) as { n: number }[];
      expect(legs[0]!.n).toBe(0);
    });

    test("converting again - any key, any caller - returns the same order and writes nothing", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const quotation = await acceptedQuotation(TENANT_A, productId);
      const first = await convert(TENANT_A, quotation.id);
      expect(first.kind).toBe("converted");
      if (first.kind !== "converted") return;
      const stockAfter = await stockOf(TENANT_A, productId);

      const again = await convert(TENANT_A, quotation.id, { actor: CASHIER_2 });
      expect(again.kind).toBe("replayed");
      if (again.kind !== "replayed") return;
      expect(again.result.order.id).toBe(first.result.order.id);
      expect(again.result.alreadyConverted).toBe(true);
      expect(await stockOf(TENANT_A, productId)).toBe(stockAfter);
      const count = (await inTenant(
        TENANT_A,
        (tx) => tx`SELECT count(*)::int AS n FROM awcms_commerce_orders`
      )) as { n: number }[];
      expect(count[0]!.n).toBe(1);
    });

    test("two concurrent conversions create exactly one order", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const quotation = await acceptedQuotation(TENANT_A, productId);
      const [a, b] = await Promise.all([
        convert(TENANT_A, quotation.id),
        convert(TENANT_A, quotation.id, { actor: CASHIER_2 })
      ]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(["converted", "replayed"]);
      const orderIds = [a, b].map((outcome) =>
        outcome.kind === "converted" || outcome.kind === "replayed"
          ? outcome.result.order.id
          : ""
      );
      expect(orderIds[0]).toBe(orderIds[1]);
      const count = (await inTenant(
        TENANT_A,
        (tx) => tx`SELECT count(*)::int AS n FROM awcms_commerce_orders`
      )) as { n: number }[];
      expect(count[0]!.n).toBe(1);
      expect(await stockOf(TENANT_A, productId)).toBe(498);
    });

    test("only an ACCEPTED quotation converts", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const draft = await newQuotationOk(TENANT_A, productId);
      expect(await convert(TENANT_A, draft.id)).toEqual({
        kind: "not_accepted",
        status: "draft"
      });
      expect(
        await convert(TENANT_A, "00000000-0000-4000-8000-000000000000")
      ).toEqual({
        kind: "not_found"
      });
    });

    test("a changed price rolls the order back and tells the caller both totals; acceptPriceChange accepts it", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const quotation = await acceptedQuotation(TENANT_A, productId);
      const stockBefore = await stockOf(TENANT_A, productId);
      await inTenant(
        TENANT_A,
        (tx) =>
          tx`UPDATE awcms_commerce_products SET price = '12500.00' WHERE id = ${productId}`
      );

      const refused = await convert(TENANT_A, quotation.id);
      expect(refused).toEqual({
        kind: "price_changed",
        quotedTotal: "20000.00",
        currentTotal: "25000.00"
      });
      // Nothing of the refused order survived: no order, no stock moved, still accepted.
      const orders = (await inTenant(
        TENANT_A,
        (tx) => tx`SELECT count(*)::int AS n FROM awcms_commerce_orders`
      )) as { n: number }[];
      expect(orders[0]!.n).toBe(0);
      expect(await stockOf(TENANT_A, productId)).toBe(stockBefore);
      expect(
        (await inTenant(TENANT_A, (tx) =>
          fetchQuotation(tx, TENANT_A, quotation.id, NOW)
        ))!.status
      ).toBe("accepted");

      const accepted = await convert(TENANT_A, quotation.id, {
        acceptPriceChange: true
      });
      expect(accepted.kind).toBe("converted");
      if (accepted.kind !== "converted") return;
      expect(accepted.result.order.total).toBe("25000.00");
      // The quote itself still says what was offered.
      expect(accepted.result.quotation.versions[0]!.total).toBe("20000.00");
    });

    test("insufficient stock refuses the conversion (CART_CHANGED) and leaves the quotation accepted", async () => {
      const productId = await seedActiveProduct(TENANT_A, { stock: 3 });
      const quotation = await acceptedQuotation(TENANT_A, productId, {
        quantity: 2
      });
      await inTenant(
        TENANT_A,
        (tx) =>
          tx`UPDATE awcms_commerce_products SET stock = 1 WHERE id = ${productId}`
      );
      await expect(convert(TENANT_A, quotation.id)).rejects.toBeInstanceOf(
        PosCartChangedError
      );
      expect(
        (await inTenant(TENANT_A, (tx) =>
          fetchQuotation(tx, TENANT_A, quotation.id, NOW)
        ))!.status
      ).toBe("accepted");
    });
  });

  // -------------------------------------------------------------------------
  // Work orders
  // -------------------------------------------------------------------------
  describe("work orders", () => {
    test("created from an accepted quotation, the ACCEPTED version is its provenance", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const quotation = await acceptedQuotation(TENANT_A, productId);
      const workOrder = await newWorkOrderOk(TENANT_A, {
        quotationId: quotation.id
      });
      expect(workOrder.number).toBe("WO-2026-000001");
      expect(workOrder.status).toBe("received");
      expect(workOrder.quotationId).toBe(quotation.id);
      expect(workOrder.quotationVersion).toBe(1);
      expect(workOrder.customerId).toBe(quotation.customerId);
      expect(workOrder.events).toHaveLength(1);
      expect(workOrder.events[0]).toMatchObject({
        fromStatus: null,
        toStatus: "received"
      });
    });

    test("a quotation that was never accepted cannot back a work order", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const draft = await newQuotationOk(TENANT_A, productId);
      const outcome = await newWorkOrder(TENANT_A, { quotationId: draft.id });
      expect(outcome).toEqual({
        kind: "quotation_not_accepted",
        status: "draft"
      });
      // ... and consumed no work-order number.
      expect((await newWorkOrderOk(TENANT_A)).number).toBe("WO-2026-000001");
    });

    test("unknown and other-tenant references are rejected identically", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await paidOrder(TENANT_A, productId);
      const bProduct = await seedActiveProduct(TENANT_B, {
        sku: "SKU-B",
        slug: "b-slug"
      });
      const bOrder = await paidOrder(TENANT_B, bProduct);
      const unknown = await newWorkOrder(TENANT_A, {
        orderId: "00000000-0000-4000-8000-000000000000"
      });
      const foreign = await newWorkOrder(TENANT_A, { orderId: bOrder.id });
      expect(unknown).toEqual({
        kind: "reference_not_found",
        field: "orderId"
      });
      expect(foreign).toEqual(unknown);
      const own = await newWorkOrder(TENANT_A, { orderId: order.id });
      expect(own.kind).toBe("created");
    });

    test("the lifecycle walks the legal edges, writes history, and closes", async () => {
      const workOrder = await newWorkOrderOk(TENANT_A);
      const path: WorkOrderStatus[] = [
        "scheduled",
        "in_progress",
        "on_hold",
        "in_progress",
        "ready",
        "completed"
      ];
      for (const status of path) {
        const outcome = await moveWorkOrder(TENANT_A, workOrder.id, {
          status,
          note: `to ${status}`
        });
        expect(outcome.kind).toBe("done");
      }
      const final = (await inTenant(TENANT_A, (tx) =>
        fetchWorkOrder(tx, TENANT_A, workOrder.id)
      ))!;
      expect(final.status).toBe("completed");
      expect(final.completedAt).not.toBeNull();
      expect(final.events.map((event) => event.toStatus)).toEqual([
        "received",
        ...path
      ]);
      // A completed work order accepts nothing.
      expect(
        await moveWorkOrder(TENANT_A, workOrder.id, { status: "in_progress" })
      ).toEqual({
        kind: "closed",
        status: "completed"
      });
      expect(
        await moveWorkOrder(TENANT_A, workOrder.id, { priority: "low" })
      ).toEqual({ kind: "closed", status: "completed" });
    });

    test("an illegal edge is refused by the app and by the database", async () => {
      const workOrder = await newWorkOrderOk(TENANT_A);
      expect(
        await moveWorkOrder(TENANT_A, workOrder.id, { status: "completed" })
      ).toEqual({
        kind: "illegal_transition",
        from: "received",
        to: "completed"
      });
      await expect(
        attempt(
          getAdminSql()`UPDATE awcms_commerce_work_orders SET status = 'completed', completed_at = now() WHERE id = ${workOrder.id}`
        )
      ).rejects.toThrow();
      // The history is append-only.
      await expect(
        attempt(
          getAdminSql()`UPDATE awcms_commerce_work_order_events SET note = 'x'`
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) => tx`DELETE FROM awcms_commerce_work_order_events`
          )
        )
      ).rejects.toThrow();
    });

    test("reassignment and rescheduling do not touch the status or add history", async () => {
      const workOrder = await newWorkOrderOk(TENANT_A);
      const due = new Date(NOW.getTime() + 3 * DAY).toISOString();
      const outcome = await moveWorkOrder(TENANT_A, workOrder.id, {
        assigneeTenantUserId: CASHIER_2,
        dueAt: due
      });
      expect(outcome.kind).toBe("done");
      if (outcome.kind !== "done") return;
      expect(outcome.workOrder.status).toBe("received");
      expect(outcome.workOrder.assigneeTenantUserId).toBe(CASHIER_2);
      expect(outcome.workOrder.dueAt).toBe(due);
      expect(outcome.workOrder.events).toHaveLength(1);
    });

    test("update is idempotent on its key", async () => {
      const workOrder = await newWorkOrderOk(TENANT_A);
      const key = keyOf();
      expect(
        (
          await moveWorkOrder(
            TENANT_A,
            workOrder.id,
            { status: "scheduled" },
            key
          )
        ).kind
      ).toBe("done");
      expect(
        (
          await moveWorkOrder(
            TENANT_A,
            workOrder.id,
            { status: "scheduled" },
            key
          )
        ).kind
      ).toBe("replayed");
    });

    test("work-order numbers are gapless under concurrency", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => newWorkOrder(TENANT_A))
      );
      const numbers = results
        .map((entry) =>
          entry.kind === "created" ? entry.workOrder.number : ""
        )
        .sort();
      expect(numbers).toEqual(
        Array.from({ length: 12 }, (_, i) =>
          formatDocumentNumber("work_order", "2026", i + 1)
        )
      );
    });
  });

  // -------------------------------------------------------------------------
  // Receipt / invoice documents
  // -------------------------------------------------------------------------
  describe("receipt and invoice documents", () => {
    test("an invoice and a receipt are immutable numbered snapshots whose money equals the order's", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await paidOrder(TENANT_A, productId);
      const invoice = await issueOk(TENANT_A, order.id, "invoice");
      const receipt = await issueOk(TENANT_A, order.id, "receipt");
      expect(invoice.alreadyIssued).toBe(false);
      expect(invoice.document.number).toBe("INV-2026-000001");
      expect(receipt.document.number).toBe("RCP-2026-000001");

      const document = invoice.document;
      expect(document.total).toBe(order.total);
      expect(document.subtotal).toBe(order.subtotal);
      expect(document.tax).toBe(order.tax);
      expect(document.total).toBe("20000.00");
      expect(document.snapshot.seller.name).toBe("Toko <Dokumen>");
      expect(document.snapshot.order.orderCode).toBe(order.orderCode);
      expect(document.snapshot.lines[0]).toMatchObject({
        quantity: 2,
        unitPrice: "10000.00",
        lineTotal: "20000.00"
      });
      expect(document.snapshot.payments.map((payment) => payment.kind)).toEqual(
        ["payment"]
      );
      expect(document.snapshot.settlement).toEqual({
        paid: "20000.00",
        reversed: "0.00",
        outstanding: "0.00"
      });
      expect(contentHash(document.snapshot)).toBe(document.contentHash);
      expect(document.sourceType).toBe("order");
      expect(document.sourceVersion).toBe(1);
    });

    test("issuing again returns the first document and consumes no number", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const orderA = await paidOrder(TENANT_A, productId);
      const orderB = await paidOrder(TENANT_A, productId);
      const first = await issueOk(TENANT_A, orderA.id, "invoice");
      const again = await issueOk(TENANT_A, orderA.id, "invoice");
      expect(again.alreadyIssued).toBe(true);
      expect(again.document.id).toBe(first.document.id);
      // The next order's invoice is number 2, not 3.
      expect(
        (await issueOk(TENANT_A, orderB.id, "invoice")).document.number
      ).toBe("INV-2026-000002");
      // Same key replays.
      const key = keyOf();
      await issueOk(TENANT_A, orderB.id, "receipt", { key });
      const replay = await issue(TENANT_A, orderB.id, "receipt", { key });
      expect(replay.kind).toBe("replayed");
    });

    test("two concurrent issues of the SAME document yield one row and no skipped number", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await paidOrder(TENANT_A, productId);
      const [a, b] = await Promise.all([
        issue(TENANT_A, order.id, "invoice"),
        issue(TENANT_A, order.id, "invoice")
      ]);
      expect(a.kind).toBe("issued");
      expect(b.kind).toBe("issued");
      if (a.kind !== "issued" || b.kind !== "issued") return;
      expect(a.document.id).toBe(b.document.id);
      expect([a.alreadyIssued, b.alreadyIssued].sort()).toEqual([false, true]);
      const other = await paidOrder(TENANT_A, productId);
      expect(
        (await issueOk(TENANT_A, other.id, "invoice")).document.number
      ).toBe("INV-2026-000002");
    });

    test("ten concurrent issues for ten orders get invoice numbers 1..10 - none duplicated, none skipped", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const orders = [];
      for (let i = 0; i < 10; i += 1)
        orders.push(await paidOrder(TENANT_A, productId));
      const outcomes = await Promise.all(
        orders.map((order) => issue(TENANT_A, order.id, "invoice"))
      );
      const numbers = outcomes
        .map((outcome) =>
          outcome.kind === "issued" ? outcome.document.number : ""
        )
        .sort();
      expect(numbers).toEqual(
        Array.from({ length: 10 }, (_, i) =>
          formatDocumentNumber("invoice", "2026", i + 1)
        )
      );
    }, 60000);

    test("eligibility: a receipt needs a paid order; an invoice needs one that took effect", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const due = await dueOrder(TENANT_A, productId);
      expect(await issue(TENANT_A, due.id, "receipt")).toEqual({
        kind: "not_eligible",
        reason: "ORDER_NOT_PAID"
      });
      // An invoice may precede payment.
      const invoice = await issueOk(TENANT_A, due.id, "invoice");
      expect(invoice.document.snapshot.settlement.outstanding).toBe("20000.00");

      const paid = await paidOrder(TENANT_A, productId);
      await getAdminSql()`UPDATE awcms_commerce_orders SET status = 'cancelled', cancelled_at = now() WHERE id = ${paid.id}`;
      expect(await issue(TENANT_A, paid.id, "invoice")).toEqual({
        kind: "not_eligible",
        reason: "ORDER_NOT_FINAL"
      });
      expect(
        await issue(TENANT_A, "00000000-0000-4000-8000-000000000000", "invoice")
      ).toEqual({ kind: "order_not_found" });
      // Refusals consumed no number.
      const next = await paidOrder(TENANT_A, productId);
      expect(
        (await issueOk(TENANT_A, next.id, "invoice")).document.number
      ).toBe("INV-2026-000002");
    });

    test("a document cannot be updated or deleted, by the app role or by anyone", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await paidOrder(TENANT_A, productId);
      const { document } = await issueOk(TENANT_A, order.id, "invoice");
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`UPDATE awcms_commerce_documents SET total = '1.00' WHERE id = ${document.id}`
          )
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          inTenant(
            TENANT_A,
            (tx) =>
              tx`DELETE FROM awcms_commerce_documents WHERE id = ${document.id}`
          )
        )
      ).rejects.toThrow();
      await expect(
        attempt(
          getAdminSql()`UPDATE awcms_commerce_documents SET number = 'INV-2026-999999' WHERE id = ${document.id}`
        )
      ).rejects.toThrow();
    });

    test("the database refuses a document whose money differs from its order's", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await paidOrder(TENANT_A, productId);
      await expect(
        attempt(getAdminSql()`
          INSERT INTO awcms_commerce_documents (
            tenant_id, doc_type, number, source_id, subtotal, discount, shipping_cost,
            insurance_fee, tax, total, snapshot, content_hash, issued_by_tenant_user_id
          )
          VALUES (
            ${TENANT_A}, 'invoice', 'INV-2026-424242', ${order.id}, '20000.00', '0.00', '0.00',
            '0.00', '0.00', '19999.00', '{}'::jsonb, ${"a".repeat(64)}, ${CASHIER_1}
          )
        `)
      ).rejects.toThrow();
    });

    test("reprinting never mutates the row; the render is audited", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await paidOrder(TENANT_A, productId);
      const { document } = await issueOk(TENANT_A, order.id, "receipt");
      const before = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT * FROM awcms_commerce_documents WHERE id = ${document.id}`
      )) as Record<string, unknown>[];

      for (const format of ["json", "text", "html"] as const) {
        const outcome = await inTenant(TENANT_A, (tx) =>
          renderStoredDocument(
            tx,
            TENANT_A,
            CASHIER_1,
            document.id,
            format,
            "id"
          )
        );
        expect(outcome.kind).toBe("rendered");
        if (outcome.kind !== "rendered") continue;
        if (format === "html") {
          expect(outcome.body).toContain("<!doctype html>");
          // The store name carried angle brackets: they are escaped, never raw.
          expect(outcome.body).toContain("Toko &lt;Dokumen&gt;");
          expect(outcome.body).not.toContain("Toko <Dokumen>");
          expect(outcome.body).not.toContain("<script");
        }
        if (format === "text") expect(outcome.body).toContain(document.number);
      }

      const after = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT * FROM awcms_commerce_documents WHERE id = ${document.id}`
      )) as Record<string, unknown>[];
      expect(after).toEqual(before);

      const audits = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'document.render' AND resource_id = ${document.id}
      `) as { n: number }[];
      expect(audits[0]!.n).toBe(3);
    });

    test("a snapshot that no longer matches its hash is refused, not printed", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const order = await paidOrder(TENANT_A, productId);
      const { document } = await issueOk(TENANT_A, order.id, "invoice");
      const admin = getAdminSql();
      await admin`ALTER TABLE awcms_commerce_documents DISABLE TRIGGER awcms_commerce_documents_append_only`;
      try {
        await admin`
          UPDATE awcms_commerce_documents
          SET snapshot = jsonb_set(snapshot, '{totals,total}', '"1.00"')
          WHERE id = ${document.id}
        `;
      } finally {
        await admin`ALTER TABLE awcms_commerce_documents ENABLE TRIGGER awcms_commerce_documents_append_only`;
      }
      const outcome = await inTenant(TENANT_A, (tx) =>
        renderStoredDocument(tx, TENANT_A, CASHIER_1, document.id, "html", "id")
      );
      expect(outcome).toEqual({ kind: "integrity_failure" });
    });
  });

  // -------------------------------------------------------------------------
  // RLS and tenant-safe references
  // -------------------------------------------------------------------------
  describe("tenant isolation", () => {
    test("another tenant sees none of the rows, and cannot write one for this tenant", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      await holdOk(TENANT_A, productId);
      const quotation = await acceptedQuotation(TENANT_A, productId);
      const workOrder = await newWorkOrderOk(TENANT_A);
      const order = await paidOrder(TENANT_A, productId);
      const { document } = await issueOk(TENANT_A, order.id, "invoice");

      for (const table of [
        "awcms_commerce_document_sequences",
        "awcms_commerce_held_sales",
        "awcms_commerce_quotations",
        "awcms_commerce_quotation_versions",
        "awcms_commerce_work_orders",
        "awcms_commerce_work_order_events",
        "awcms_commerce_documents"
      ]) {
        const own = (await inTenant(TENANT_A, (tx) =>
          tx.unsafe(`SELECT count(*)::int AS n FROM ${table}`)
        )) as { n: number }[];
        const foreign = (await inTenant(TENANT_B, (tx) =>
          tx.unsafe(`SELECT count(*)::int AS n FROM ${table}`)
        )) as { n: number }[];
        expect(own[0]!.n).toBeGreaterThan(0);
        expect(foreign[0]!.n).toBe(0);
      }

      // Directory reads for tenant B resolve to nothing, not to tenant A's rows.
      expect(
        await inTenant(TENANT_B, (tx) =>
          fetchQuotation(tx, TENANT_B, quotation.id, NOW)
        )
      ).toBeNull();
      expect(
        await inTenant(TENANT_B, (tx) =>
          fetchWorkOrder(tx, TENANT_B, workOrder.id)
        )
      ).toBeNull();
      expect(
        await inTenant(TENANT_B, (tx) =>
          fetchDocument(tx, TENANT_B, document.id)
        )
      ).toBeNull();
      expect(await issue(TENANT_B, order.id, "invoice")).toEqual({
        kind: "order_not_found"
      });
      expect(await act(TENANT_B, quotation.id, "cancel")).toEqual({
        kind: "not_found"
      });
      expect(
        await moveWorkOrder(TENANT_B, workOrder.id, { status: "scheduled" })
      ).toEqual({
        kind: "not_found"
      });
      expect(await convert(TENANT_B, quotation.id)).toEqual({
        kind: "not_found"
      });

      // WITH CHECK: tenant B's context cannot insert a row labelled tenant A.
      await expect(
        attempt(
          inTenant(
            TENANT_B,
            (tx) => tx`
              INSERT INTO awcms_commerce_held_sales (tenant_id, owner_tenant_user_id, cart, line_count, expires_at)
              VALUES (${TENANT_A}, ${B_CASHIER}, '{"lines":[]}'::jsonb, 1, now() + interval '1 hour')
            `
          )
        )
      ).rejects.toThrow();
    });

    test("composite foreign keys keep a row from pointing across tenants, even past RLS", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const quotation = await acceptedQuotation(TENANT_A, productId);
      const order = await paidOrder(TENANT_A, productId);
      const admin = getAdminSql();
      // A tenant-B work order cannot name tenant A's order or quotation version.
      await expect(
        attempt(admin`
          INSERT INTO awcms_commerce_work_orders (tenant_id, number, title, order_id, created_by_tenant_user_id)
          VALUES (${TENANT_B}, 'WO-2026-900001', 'x', ${order.id}, ${B_CASHIER})
        `)
      ).rejects.toThrow();
      await expect(
        attempt(admin`
          INSERT INTO awcms_commerce_work_orders (
            tenant_id, number, title, quotation_id, quotation_version, created_by_tenant_user_id
          )
          VALUES (${TENANT_B}, 'WO-2026-900002', 'x', ${quotation.id}, 1, ${B_CASHIER})
        `)
      ).rejects.toThrow();
      // ... nor can a tenant-B quotation reference tenant A's customer.
      await expect(
        attempt(admin`
          INSERT INTO awcms_commerce_quotations (tenant_id, number, customer_id, created_by_tenant_user_id)
          VALUES (${TENANT_B}, 'QUO-2026-900001', ${quotation.customerId}, ${B_CASHIER})
        `)
      ).rejects.toThrow();
    });
  });
});
