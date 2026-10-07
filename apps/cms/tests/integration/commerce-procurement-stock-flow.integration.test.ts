/**
 * Procurement feeds commerce stock through the inventory ledger (Issue #283,
 * ADR-0038 addendum, ADR-0128) against a REAL migrated Postgres.
 *
 * Procurement is the CONSUMER here: documents are created, submitted, finalised
 * and reversed through its own application functions over the real ledger port,
 * and this file only proves what the integration promises:
 *
 *   - in `ledger` mode a receipt at the sales location raises the storefront
 *     count once the domain-event dispatcher runs, the quote can sell the new
 *     units, a reversal lowers it back, a receipt at ANOTHER location changes
 *     nothing, a warehouse -> sales transfer raises it, a supplier return lowers
 *     it and is refused by the ledger when it would go negative;
 *   - in `counter` mode a receipt does NOT touch commerce stock (the reason to
 *     cut over first) and reconciliation has nothing to report;
 *   - reconciliation's `orphans` finds receipts whose `commerce.*` reference
 *     names no live stock unit;
 *   - the SKU -> ledger-reference lookup returns the right refs.
 *
 * Gated on `DATABASE_URL`; skips cleanly without one.
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
import { commerceInventoryPort } from "../../src/modules/commerce/application/commerce-inventory";
import { runCommerceInventoryCutover } from "../../src/modules/commerce/application/commerce-inventory-cutover";
import { lookupInventoryItems } from "../../src/modules/commerce/application/commerce-inventory-items";
import { reconcileStockCache } from "../../src/modules/commerce/application/commerce-inventory-reconciliation";
import { createOrderFromCart } from "../../src/modules/commerce/application/order-directory";
import { createProduct } from "../../src/modules/commerce/application/product-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { inventoryLedgerPortAdapter } from "../../src/modules/inventory/application/inventory-ledger-port-adapter";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import {
  createDocument,
  submitDocument
} from "../../src/modules/procurement/application/procurement-document-directory";
import {
  finaliseDocument,
  reverseDocument,
  type PostingOutcome
} from "../../src/modules/procurement/application/procurement-posting";
import { createSupplier } from "../../src/modules/procurement/application/procurement-supplier-directory";
import type { CreateDocumentInput } from "../../src/modules/procurement/domain/procurement-validation";
import { postOpeningThroughInventory } from "../../scripts/commerce-inventory-cutover";
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

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a283";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b283";
const STAFF = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c283";
const LOC_SALES = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d283";
const LOC_WAREHOUSE = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e283";
const LOC_B = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f283";
const NOW = new Date("2026-10-05T10:00:00.000Z");
const ACTOR = { actorTenantUserId: STAFF, correlationId: "corr-283" };

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-PROC",
  name: "Kopi Susu",
  slug: "kopi-susu-proc",
  description: null,
  digitalNote: null,
  price: "10000.00",
  discountPercent: 0,
  stock: 0,
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
  allowDp: false,
  allowFreeShipping: true,
  variantAttributes: null,
  isFeatured: false,
  isRecommended: false
};

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

async function seedStaff(tenantId: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Procurement Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`proc-actor-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${STAFF}, ${tenantId}, ${identity[0]!.id})
  `;
}

async function seedLocation(
  tenantId: string,
  id: string,
  code: string
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_inventory_locations (id, tenant_id, code, name, status)
    VALUES (${id}, ${tenantId}, ${code}, ${code}, 'active')
  `;
}

async function enableStore(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Uji",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, STAFF, validated.value)
  );
}

let seq = 0;

async function seedProduct(
  tenantId: string,
  overrides: Partial<CreateProductInput> = {}
): Promise<string> {
  seq += 1;
  const product = await inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, STAFF, {
      ...BASE_PRODUCT,
      sku: `SKU-PROC-${seq}`,
      slug: `kopi-susu-proc-${seq}`,
      ...overrides
    })
  );
  await getAdminSql()`
    UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}
  `;
  return product.id;
}

async function seedVariant(
  tenantId: string,
  productId: string,
  value: string,
  sku: string | null = null
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_product_variants
      (tenant_id, product_id, name, value, stock, sku)
    VALUES (${tenantId}, ${productId}, 'Size', ${value}, 0, ${sku})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function variantStock(variantId: string): Promise<number> {
  const rows = (await getAdminSql()`
    SELECT stock FROM awcms_commerce_product_variants WHERE id = ${variantId}
  `) as { stock: number }[];
  return Number(rows[0]!.stock);
}

async function productStock(productId: string): Promise<number> {
  const rows = (await getAdminSql()`
    SELECT stock FROM awcms_commerce_products WHERE id = ${productId}
  `) as { stock: number }[];
  return Number(rows[0]!.stock);
}

async function ledgerOnHand(
  locationId: string,
  itemType: string,
  itemRef: string
): Promise<string> {
  return inTenant(TENANT_A, (tx) =>
    commerceInventoryPort().getOnHand(tx, TENANT_A, locationId, {
      itemType,
      itemRef,
      unitCode: "unit"
    })
  );
}

async function cutover(): Promise<void> {
  await inTenant(TENANT_A, async (tx) => {
    const result = await runCommerceInventoryCutover(
      tx,
      TENANT_A,
      LOC_SALES,
      postOpeningThroughInventory,
      "cutover-test"
    );
    expect(result.kind).toBe("completed");
  });
}

async function dispatch(): Promise<void> {
  const sql = workerRoleActivated ? getWorkerRoleSql() : getRuntimeSql();
  for (let pass = 0; pass < 3; pass += 1) {
    await dispatchDomainEventsForTenant(sql, TENANT_A, { limit: 100 });
  }
}

async function newSupplier(tenantId: string): Promise<string> {
  const result = await inTenant(tenantId, (tx) =>
    createSupplier(tx, tenantId, ACTOR, {
      vendorCode: "ACME",
      name: "Supplier ACME",
      status: "active",
      profileId: null,
      categories: [],
      tags: []
    })
  );
  if (result.outcome !== "ok") throw new Error("fixture: supplier");
  return result.supplier.id;
}

function line(itemType: string, itemRef: string, quantity: string) {
  return {
    itemType,
    itemRef,
    sku: `SKU-${itemRef.slice(0, 8)}`,
    itemName: `Item ${itemRef}`,
    unitCode: "unit",
    quantity,
    unitCost: "5000"
  };
}

type DocSpec = {
  mode: "receive" | "supplier_return" | "transfer";
  locationId: string;
  sourceLocationId?: string;
  lines: ReturnType<typeof line>[];
};

/** Create + submit + finalise through procurement's own functions. */
async function postDocument(
  supplierId: string,
  spec: DocSpec
): Promise<{ id: string; outcome: PostingOutcome }> {
  const input: CreateDocumentInput = {
    mode: spec.mode,
    supplierId: spec.mode === "transfer" ? null : supplierId,
    locationId: spec.locationId,
    sourceLocationId: spec.sourceLocationId ?? null,
    externalReference: null,
    documentDate: null,
    notes: null,
    currencyCode: "IDR",
    lines: spec.lines
  };

  return inTenant(TENANT_A, async (tx) => {
    const created = await createDocument(tx, TENANT_A, ACTOR, input);
    if (created.outcome !== "ok") {
      throw new Error(`fixture: create ${JSON.stringify(created)}`);
    }
    const id = created.document.id;
    const submitted = await submitDocument(tx, TENANT_A, id, ACTOR, NOW);
    if (submitted.outcome !== "ok") throw new Error("fixture: submit");
    const outcome = await finaliseDocument(
      tx,
      inventoryLedgerPortAdapter,
      TENANT_A,
      id,
      ACTOR
    );
    return { id, outcome };
  });
}

function reverse(id: string): Promise<PostingOutcome> {
  return inTenant(TENANT_A, (tx) =>
    reverseDocument(
      tx,
      inventoryLedgerPortAdapter,
      TENANT_A,
      id,
      ACTOR,
      "wrong delivery"
    )
  );
}

function orderInput(
  productId: string,
  variantId: string | null,
  quantity: number
): CreateOrderInput {
  return {
    idempotencyKey: crypto.randomUUID(),
    customer: { name: "Siti", phone: "0812-3456-7890", email: null },
    address: null,
    lines: [{ productId, variantId, quantity, serviceFormValues: null }],
    shipping: { method: "self_pickup" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null
  };
}

suite("procurement -> commerce stock flow (Issue #283)", () => {
  let supplier = "";
  let productId = "";
  let variantId = "";

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
    await seedStaff(TENANT_A);
    await seedLocation(TENANT_A, LOC_SALES, "sales");
    await seedLocation(TENANT_A, LOC_WAREHOUSE, "warehouse");
    await seedLocation(TENANT_B, LOC_B, "sales-b");
    await enableStore(TENANT_A);
    supplier = await newSupplier(TENANT_A);
    productId = await seedProduct(TENANT_A);
    variantId = await seedVariant(TENANT_A, productId, "M", "SKU-PROC-M");
  }, 60000);

  const receiveAtSales = (quantity: string) =>
    postDocument(supplier, {
      mode: "receive",
      locationId: LOC_SALES,
      lines: [line("commerce.variant", variantId, quantity)]
    });

  describe("ledger mode", () => {
    test("a receipt at the sales location raises the cache, the quote can sell it, and a reversal lowers it back", async () => {
      await cutover();
      await dispatch();

      const refusedBefore = await inTenant(TENANT_A, (tx) =>
        createOrderFromCart(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          orderInput(productId, variantId, 1),
          NOW
        )
      );
      expect(refusedBefore.kind).toBe("cart_changed");

      const received = await receiveAtSales("12");
      expect(received.outcome.outcome).toBe("ok");
      expect(await variantStock(variantId)).toBe(0); // event-driven: not yet
      await dispatch();
      expect(await variantStock(variantId)).toBe(12);
      expect(await ledgerOnHand(LOC_SALES, "commerce.variant", variantId)).toBe(
        "12"
      );

      const sold = await inTenant(TENANT_A, (tx) =>
        createOrderFromCart(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          orderInput(productId, variantId, 5),
          NOW
        )
      );
      expect(sold.kind).toBe("created");
      expect(await variantStock(variantId)).toBe(7);
      expect(await ledgerOnHand(LOC_SALES, "commerce.variant", variantId)).toBe(
        "7"
      );

      // 5 of the 12 are sold: reversing the whole receipt would go negative.
      expect((await reverse(received.id)).outcome).toBe("ledger_refused");
      await dispatch();
      expect(await variantStock(variantId)).toBe(7);
    }, 120000);

    test("a reversal of an untouched receipt lowers the cache back to what it was", async () => {
      await cutover();
      await dispatch();
      const received = await receiveAtSales("9");
      await dispatch();
      expect(await variantStock(variantId)).toBe(9);

      expect((await reverse(received.id)).outcome).toBe("ok");
      await dispatch();
      expect(await variantStock(variantId)).toBe(0);
      expect(await ledgerOnHand(LOC_SALES, "commerce.variant", variantId)).toBe(
        "0"
      );
    }, 120000);

    test("a receipt for a product that has no variants is a commerce.product unit", async () => {
      const plain = await seedProduct(TENANT_A);
      await cutover();
      await dispatch();
      await postDocument(supplier, {
        mode: "receive",
        locationId: LOC_SALES,
        lines: [line("commerce.product", plain, "4")]
      });
      await dispatch();
      expect(await productStock(plain)).toBe(4);
    }, 120000);

    test("a receipt at a different location does not change the cache; a transfer into the sales location does", async () => {
      await cutover();
      await dispatch();

      await postDocument(supplier, {
        mode: "receive",
        locationId: LOC_WAREHOUSE,
        lines: [line("commerce.variant", variantId, "20")]
      });
      await dispatch();
      expect(await variantStock(variantId)).toBe(0);

      const transfer = await postDocument(supplier, {
        mode: "transfer",
        locationId: LOC_SALES,
        sourceLocationId: LOC_WAREHOUSE,
        lines: [line("commerce.variant", variantId, "8")]
      });
      expect(transfer.outcome.outcome).toBe("ok");
      await dispatch();
      expect(await variantStock(variantId)).toBe(8);
      expect(
        await ledgerOnHand(LOC_WAREHOUSE, "commerce.variant", variantId)
      ).toBe("12");

      const report = await inTenant(TENANT_A, (tx) =>
        reconcileStockCache(tx, TENANT_A, null, 500)
      );
      expect("drift" in report && report.drift).toEqual([]);
    }, 120000);

    test("a supplier return lowers the cache and is refused by the ledger when it would go negative", async () => {
      await cutover();
      await dispatch();
      await receiveAtSales("6");
      await dispatch();

      const back = await postDocument(supplier, {
        mode: "supplier_return",
        locationId: LOC_SALES,
        lines: [line("commerce.variant", variantId, "2")]
      });
      expect(back.outcome.outcome).toBe("ok");
      await dispatch();
      expect(await variantStock(variantId)).toBe(4);

      const tooMuch = await postDocument(supplier, {
        mode: "supplier_return",
        locationId: LOC_SALES,
        lines: [line("commerce.variant", variantId, "10")]
      });
      expect(tooMuch.outcome.outcome).toBe("ledger_refused");
      await dispatch();
      expect(await variantStock(variantId)).toBe(4);
      expect(await ledgerOnHand(LOC_SALES, "commerce.variant", variantId)).toBe(
        "4"
      );
    }, 120000);
  });

  describe("counter mode", () => {
    test("a procurement receipt does not touch commerce stock, and reconciliation reports nothing to reconcile", async () => {
      await getAdminSql()`
        UPDATE awcms_commerce_product_variants SET stock = 3 WHERE id = ${variantId}
      `;
      const received = await receiveAtSales("50");
      expect(received.outcome.outcome).toBe("ok");
      await dispatch();

      expect(await variantStock(variantId)).toBe(3);
      expect(await ledgerOnHand(LOC_SALES, "commerce.variant", variantId)).toBe(
        "50"
      );
      expect(
        await inTenant(TENANT_A, (tx) =>
          reconcileStockCache(tx, TENANT_A, null, 500)
        )
      ).toEqual({ kind: "not_ledger_mode" });
    }, 120000);
  });

  describe("orphan detection", () => {
    test("finds receipts naming no live stock unit, and nothing for a correct receipt", async () => {
      await cutover();
      await dispatch();
      await receiveAtSales("5"); // correct
      const ghost = crypto.randomUUID();
      await postDocument(supplier, {
        mode: "receive",
        locationId: LOC_SALES,
        lines: [
          line("commerce.variant", ghost, "3"),
          // the product HAS a variant: the wrong stock unit
          line("commerce.product", productId, "2"),
          line("commerce.widget", crypto.randomUUID(), "1")
        ]
      });
      // Another location is not looked at.
      await postDocument(supplier, {
        mode: "receive",
        locationId: LOC_WAREHOUSE,
        lines: [line("commerce.variant", crypto.randomUUID(), "9")]
      });
      await dispatch();

      const report = await inTenant(TENANT_A, (tx) =>
        reconcileStockCache(tx, TENANT_A, null, 500)
      );
      if ("kind" in report) throw new Error(report.kind);
      expect(report.drift).toEqual([]);
      expect(report.orphans?.truncated).toBe(false);
      const byRef = new Map(
        report.orphans!.items.map((item) => [item.itemRef, item])
      );
      expect(report.orphans!.items).toHaveLength(3);
      expect(byRef.get(ghost)).toMatchObject({
        itemType: "commerce.variant",
        onHand: "3",
        reason: "not_found"
      });
      expect(byRef.get(productId)).toMatchObject({
        reason: "product_has_variants",
        onHand: "2"
      });
      expect(
        report.orphans!.items.find((i) => i.itemType === "commerce.widget")
          ?.reason
      ).toBe("unknown_item_type");

      const next = await inTenant(TENANT_A, (tx) =>
        reconcileStockCache(tx, TENANT_A, "commerce.variant|" + variantId, 500)
      );
      expect("orphans" in next && next.orphans).toBeNull();
    }, 120000);

    test("a deleted variant becomes an orphan", async () => {
      await cutover();
      await receiveAtSales("5");
      await getAdminSql()`
        UPDATE awcms_commerce_product_variants SET deleted_at = now() WHERE id = ${variantId}
      `;
      const report = await inTenant(TENANT_A, (tx) =>
        reconcileStockCache(tx, TENANT_A, null, 500)
      );
      if ("kind" in report) throw new Error(report.kind);
      expect(report.orphans!.items.map((i) => i.reason)).toEqual(["not_found"]);
    }, 120000);
  });

  describe("the ledger-reference lookup", () => {
    async function lookup(tenantId: string, q: string | null, limit = 50) {
      const page = await inTenant(tenantId, (tx) =>
        lookupInventoryItems(tx, tenantId, q, null, limit)
      );
      if (page === "invalid_cursor") throw new Error("cursor");
      return page;
    }

    test("resolves a SKU to the variant ref, a plain product to a product ref, and hides variant-bearing products", async () => {
      const plain = await seedProduct(TENANT_A, { name: "Gula Aren" });

      const bySku = await lookup(TENANT_A, "sku-proc-m");
      expect(bySku.items).toEqual([
        {
          itemType: "commerce.variant",
          itemRef: variantId,
          sku: "SKU-PROC-M",
          name: "Kopi Susu",
          variantName: "M",
          unitCode: "unit"
        }
      ]);

      const byName = await lookup(TENANT_A, "gula");
      expect(byName.items).toEqual([
        expect.objectContaining({
          itemType: "commerce.product",
          itemRef: plain,
          variantName: null
        })
      ]);

      const all = await lookup(TENANT_A, null);
      expect(all.items.map((i) => i.itemRef).sort()).toEqual(
        [variantId, plain].sort()
      );
      // The variant-bearing product is not a stock unit.
      expect(all.items.some((i) => i.itemRef === productId)).toBe(false);
    }, 60000);

    test("treats LIKE wildcards literally and pages by keyset", async () => {
      expect((await lookup(TENANT_A, "%")).items).toEqual([]);
      await seedProduct(TENANT_A);
      await seedProduct(TENANT_A);
      const first = await lookup(TENANT_A, null, 2);
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await inTenant(TENANT_A, (tx) =>
        lookupInventoryItems(tx, TENANT_A, null, first.nextCursor, 2)
      );
      if (second === "invalid_cursor") throw new Error("cursor");
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const refs = [...first.items, ...second.items].map((i) => i.itemRef);
      expect(new Set(refs).size).toBe(3);
    }, 60000);

    test("is tenant-isolated", async () => {
      expect((await lookup(TENANT_B, null)).items).toEqual([]);
      expect((await lookup(TENANT_B, "SKU-PROC")).items).toEqual([]);
    }, 60000);
  });
});
