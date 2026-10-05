/**
 * Commerce tax adapter (Issue #293, ADR-0039) against a REAL migrated Postgres
 * through `tests/integration/harness.ts`. Gated on `DATABASE_URL`; skips cleanly
 * without one.
 *
 * Covers what only a database can prove:
 *   - flat mode (the default) is unchanged: the legacy figure, no snapshot;
 *   - the cut-over: dry-run writes nothing; commit publishes the `store-default`
 *     version and flips the mode; a parity mismatch REFUSES and leaves no trace;
 *   - engine mode: a storefront order and a POS sale each create exactly one
 *     snapshot, store its id, and carry the snapshot's tax; a replay creates no
 *     second one; the engine's figure equals the flat figure for the same cart;
 *   - a rule version published AFTER the order never changes the order's tax;
 *   - a return reverses exactly the returned units from the ORIGINAL snapshot,
 *     the rest on cancellation; the worker role can reverse an expiry;
 *   - exempt-category lines; RLS isolation (and the composite FK);
 *   - a client-supplied tax amount is ignored (the order is repriced server-side).
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
  cancelOrderByCustomer,
  createOrderFromCart,
  expireOrdersForTenant
} from "../../src/modules/commerce/application/order-directory";
import { createPosOrder } from "../../src/modules/commerce/application/pos-directory";
import { createReturn } from "../../src/modules/commerce/application/return-directory";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import {
  fetchTaxAdapterConfig,
  finaliseOrderTax,
  setTaxAdapterConfig
} from "../../src/modules/commerce/application/tax-adapter-directory";
import {
  runTaxCutoverForTenant,
  runTaxRollbackForTenant
} from "../../src/modules/commerce/application/tax-cutover";
import type { CreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import type { CreatePosOrderInput } from "../../src/modules/commerce/domain/pos-order-validation";
import type { CreateReturnInput } from "../../src/modules/commerce/domain/returns";
import { validateCreateOrderInput } from "../../src/modules/commerce/domain/order-request-validation";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import { updateModuleSettings } from "../../src/modules/module-management/application/module-settings";
import {
  createDraftVersion,
  publishRuleVersion
} from "../../src/modules/tax/application/tax-rule-version-directory";
import {
  getSnapshot,
  listSnapshots
} from "../../src/modules/tax/application/tax-snapshot-directory";
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

const TENANT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a293";
const TENANT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b293";
const STAFF = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c293";

/** The real clock: the version is published against the database's own date. */
const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;

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

async function seedStaff(tenantId: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Tax Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`tax-actor-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${STAFF}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function configureStore(
  tenantId: string,
  tax: { active: boolean; percent: number }
): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Pajak",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null }, tax }
  });

  if (!validated.valid) throw new Error(JSON.stringify(validated.errors));
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, STAFF, validated.value)
  );
  await inTenant(tenantId, (tx) =>
    updateModuleSettings(
      tx,
      tenantId,
      "commerce",
      {
        features: {
          pos: true,
          inbox: false,
          campaigns: false,
          gateway: false,
          courier: false,
          register: false,
          documents: false,
          loyalty: false,
          storedValue: false,
          returns: true
        }
      },
      STAFF
    )
  );
}

async function seedProduct(
  tenantId: string,
  sku: string,
  price: string,
  taxCategoryCode: string | null = null
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_products
      (tenant_id, sku, name, slug, price, stock, status, tax_category_code)
    VALUES (${tenantId}, ${sku}, ${sku}, ${sku.toLowerCase()}, ${price}, 100, 'active', ${taxCategoryCode})
    RETURNING id
  `) as { id: string }[];

  return rows[0]!.id;
}

let keySeq = 0;
const key = (): string =>
  `00000000-0000-4000-8000-${String(++keySeq).padStart(12, "0")}`;

function storefrontInput(
  lines: { productId: string; quantity: number }[],
  overrides: Partial<CreateOrderInput> = {}
): CreateOrderInput {
  return {
    idempotencyKey: key(),
    customer: { name: "Siti", phone: "0812-3456-7890", email: null },
    address: null,
    lines: lines.map((line) => ({
      productId: line.productId,
      variantId: null,
      quantity: line.quantity,
      serviceFormValues: null
    })),
    shipping: { method: "self_pickup" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null,
    affiliateCode: null,
    ...overrides
  };
}

function posInput(
  lines: { productId: string; quantity: number }[]
): CreatePosOrderInput {
  return {
    idempotencyKey: key(),
    customer: { name: null, phone: null },
    lines: lines.map((line) => ({
      productId: line.productId,
      variantId: null,
      quantity: line.quantity
    })),
    payment: { method: "cash", amountTendered: "1000000.00" },
    tenders: null,
    allowDue: false,
    notes: null,
    registerId: null
  } as CreatePosOrderInput;
}

async function placeStorefront(
  tenantId: string,
  lines: { productId: string; quantity: number }[],
  now: Date = NOW,
  overrides: Partial<CreateOrderInput> = {}
) {
  const outcome = await inTenant(tenantId, (tx) =>
    createOrderFromCart(
      tx,
      tenantId,
      mediaLibraryPortAdapter,
      storefrontInput(lines, overrides),
      now
    )
  );

  if (outcome.kind !== "created" && outcome.kind !== "replayed") {
    throw new Error(`order not placed: ${outcome.kind}`);
  }

  return { ...outcome.order, id: await orderIdOf(outcome.order.orderCode) };
}

async function orderIdOf(orderCode: string): Promise<string> {
  const rows = (await getAdminSql()`
    SELECT id FROM awcms_commerce_orders WHERE order_code = ${orderCode}
  `) as { id: string }[];

  return rows[0]!.id;
}

async function orderRow(tenantId: string, orderId: string) {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
      SELECT id, tax, total, tax_snapshot_id, status
      FROM awcms_commerce_orders WHERE id = ${orderId}
    `
  )) as {
    id: string;
    tax: string;
    total: string;
    tax_snapshot_id: string | null;
    status: string;
  }[];

  return rows[0]!;
}

async function snapshotsOf(tenantId: string, kind?: "sale" | "reversal") {
  return inTenant(
    tenantId,
    async (tx) =>
      (await listSnapshots(tx, tenantId, kind ? { kind } : {})).snapshots
  );
}

async function cutOver(tenantId: string, sample?: number) {
  return inTenant(tenantId, (tx) =>
    runTaxCutoverForTenant(tx, tenantId, { commit: true, sample })
  );
}

function returnInput(
  lines: { item: string; qty: number }[]
): CreateReturnInput {
  return {
    idempotencyKey: key(),
    kind: "return",
    lines: lines.map((line) => ({
      orderItemId: line.item,
      quantity: line.qty,
      reason: "defective" as never,
      disposition: "restock" as const,
      note: null
    })),
    note: null,
    refund: null,
    exchangeOrderId: null
  };
}

async function itemIds(orderId: string): Promise<string[]> {
  const rows = (await getAdminSql()`
    SELECT id FROM awcms_commerce_order_items WHERE order_id = ${orderId}
    ORDER BY created_at, id
  `) as { id: string }[];

  return rows.map((row) => row.id);
}

suite("commerce tax adapter integration (Issue #293)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-tax-a");
    await seedTenant(TENANT_B, "tenant-tax-b");
    await seedStaff(TENANT_A);
    await configureStore(TENANT_A, { active: true, percent: 11 });
  }, 30000);

  test("flat mode is the default and is unchanged: the legacy figure, no snapshot", async () => {
    const product = await seedProduct(TENANT_A, "FLAT-1", "10000.00");

    expect(
      await inTenant(TENANT_A, (tx) => fetchTaxAdapterConfig(tx, TENANT_A))
    ).toEqual({
      mode: "flat",
      profileCode: "store-default"
    });

    const order = await placeStorefront(TENANT_A, [
      { productId: product, quantity: 3 }
    ]);

    // 3 x 10,000 = 30,000; 11 % = 3,300.00 — exactly the pre-#293 arithmetic.
    expect(order.tax).toBe("3300.00");
    expect(order.total).toBe("33300.00");
    expect((await orderRow(TENANT_A, order.id)).tax_snapshot_id).toBeNull();
    expect(await snapshotsOf(TENANT_A)).toHaveLength(0);
  });

  test("the cut-over: a dry run writes nothing; a commit publishes the version and flips the mode; a second run is a no-op", async () => {
    const product = await seedProduct(TENANT_A, "CUT-1", "12345.00");

    await placeStorefront(TENANT_A, [{ productId: product, quantity: 2 }]);
    await placeStorefront(TENANT_A, [{ productId: product, quantity: 7 }]);

    const dry = await inTenant(TENANT_A, (tx) =>
      runTaxCutoverForTenant(tx, TENANT_A, { commit: false })
    );

    expect(dry.status).toBe("would_cut_over");
    expect(dry.parity).toMatchObject({ checked: 2, mismatchCount: 0 });
    expect(
      (
        await getAdminSql()`SELECT count(*)::int AS n FROM awcms_tax_rule_versions`
      )[0].n
    ).toBe(0);
    expect(
      (await inTenant(TENANT_A, (tx) => fetchTaxAdapterConfig(tx, TENANT_A)))
        .mode
    ).toBe("flat");

    const done = await cutOver(TENANT_A);

    expect(done.status).toBe("cut_over");
    expect(done.version.source).toBe("created");

    const versions = (await getAdminSql()`
      SELECT profile_code, version_no, status, pricing_mode, rounding_mode,
             rounding_scale, rounding_level, definition
      FROM awcms_tax_rule_versions WHERE tenant_id = ${TENANT_A}
    `) as {
      profile_code: string;
      version_no: number;
      status: string;
      pricing_mode: string;
      rounding_mode: string;
      rounding_scale: number;
      rounding_level: string;
      definition: {
        rules: {
          categoryCode: string | null;
          treatment: string;
          components: { rate: string }[];
        }[];
      };
    }[];

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      profile_code: "store-default",
      version_no: 1,
      status: "published",
      pricing_mode: "exclusive",
      rounding_mode: "half_up",
      rounding_scale: 2,
      rounding_level: "document"
    });
    expect(versions[0]!.definition.rules[0]).toMatchObject({
      categoryCode: null,
      treatment: "taxable"
    });
    expect(versions[0]!.definition.rules[0]!.components[0]!.rate).toBe("11");
    expect(
      (await inTenant(TENANT_A, (tx) => fetchTaxAdapterConfig(tx, TENANT_A)))
        .mode
    ).toBe("engine");

    const audit = (await getAdminSql()`
      SELECT action FROM awcms_audit_events
      WHERE tenant_id = ${TENANT_A} AND action IN ('tax_mode.update', 'tax.rule_version.publish')
    `) as { action: string }[];

    expect(audit.map((row) => row.action).sort()).toEqual([
      "tax.rule_version.publish",
      "tax_mode.update"
    ]);

    expect((await cutOver(TENANT_A)).status).toBe("already_engine");
  });

  test("a parity mismatch REFUSES the flip and leaves nothing behind", async () => {
    const product = await seedProduct(TENANT_A, "REF-1", "10000.00");
    const order = await placeStorefront(TENANT_A, [
      { productId: product, quantity: 1 }
    ]);

    // The legacy figure drifts from "11 % of the base" — e.g. a rate changed since.
    await getAdminSql()`UPDATE awcms_commerce_orders SET tax = 1000.00 WHERE id = ${order.id}`;

    const refused = await cutOver(TENANT_A);

    expect(refused.status).toBe("refused_parity");
    expect(refused.parity.mismatches[0]).toMatchObject({
      storedTax: "1000.00",
      engineTax: "1100.00"
    });
    expect(
      (
        await getAdminSql()`SELECT count(*)::int AS n FROM awcms_tax_rule_versions`
      )[0].n
    ).toBe(0);
    expect(
      (await inTenant(TENANT_A, (tx) => fetchTaxAdapterConfig(tx, TENANT_A)))
        .mode
    ).toBe("flat");

    // Narrowing the sample to orders the engine agrees with lets it through.
    await getAdminSql()`UPDATE awcms_commerce_orders SET tax = 1100.00 WHERE id = ${order.id}`;
    expect((await cutOver(TENANT_A)).status).toBe("cut_over");
  });

  test("engine mode: a storefront order creates exactly one snapshot, stores its id, carries its tax, and a replay adds none", async () => {
    const product = await seedProduct(TENANT_A, "ENG-1", "10000.00");
    const flatEquivalent = await placeStorefront(TENANT_A, [
      { productId: product, quantity: 3 }
    ]);

    expect((await cutOver(TENANT_A)).status).toBe("cut_over");

    const input = storefrontInput([{ productId: product, quantity: 3 }]);
    const first = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(tx, TENANT_A, mediaLibraryPortAdapter, input, NOW)
    );

    expect(first.kind).toBe("created");
    if (first.kind !== "created") return;
    const firstId = await orderIdOf(first.order.orderCode);

    // Same cart, same percentage: the engine's figure IS the flat figure.
    expect(first.order.tax).toBe(flatEquivalent.tax);
    expect(first.order.total).toBe(flatEquivalent.total);

    const row = await orderRow(TENANT_A, firstId);

    expect(row.tax_snapshot_id).not.toBeNull();

    const sales = await snapshotsOf(TENANT_A, "sale");

    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({
      id: row.tax_snapshot_id,
      documentType: "order",
      documentId: firstId,
      taxTotal: "3300.00",
      netTotal: "30000.00",
      profileCode: "store-default"
    });

    // The same request key replays the stored order: still one snapshot.
    const replay = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(tx, TENANT_A, mediaLibraryPortAdapter, input, NOW)
    );

    expect(replay.kind).toBe("replayed");
    expect(await snapshotsOf(TENANT_A, "sale")).toHaveLength(1);

    // Finalising the same order again (as a retry would) replays the snapshot.
    const detail = await inTenant(TENANT_A, (tx) =>
      getSnapshot(tx, TENANT_A, row.tax_snapshot_id!)
    );

    expect(detail!.lines[0]!.lineRef).toBe((await itemIds(firstId))[0]!);
    await inTenant(TENANT_A, (tx) =>
      finaliseOrderTax(tx, TENANT_A, {
        orderId: firstId,
        items: [{ orderItemId: detail!.lines[0]!.lineRef, productId: product }],
        quote: {
          tax: { mode: "engine", engine: {}, amount: "3300.00" },
          discount: "0.00",
          lines: [
            {
              productId: product,
              quantity: 3,
              unitPrice: "10000.00",
              lineTotal: "30000.00"
            }
          ]
        } as never,
        now: NOW,
        actorTenantUserId: null
      })
    );
    expect(await snapshotsOf(TENANT_A, "sale")).toHaveLength(1);
  });

  test("engine mode: a POS sale creates exactly one snapshot and stores its id", async () => {
    const product = await seedProduct(TENANT_A, "POS-1", "15000.00");

    await cutOver(TENANT_A);

    const outcome = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        STAFF,
        mediaLibraryPortAdapter,
        posInput([{ productId: product, quantity: 2 }]),
        NOW
      )
    );

    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") return;
    expect(outcome.order.tax).toBe("3300.00");
    expect(outcome.order.total).toBe("33300.00");

    const posId = await orderIdOf(outcome.order.orderCode);
    const row = await orderRow(TENANT_A, posId);
    const sales = await snapshotsOf(TENANT_A, "sale");

    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({
      id: row.tax_snapshot_id,
      documentType: "order",
      documentId: posId
    });
  });

  test("a rule version published AFTER the order never changes that order's tax", async () => {
    const product = await seedProduct(TENANT_A, "HIST-1", "10000.00");

    await cutOver(TENANT_A);

    const before = await placeStorefront(TENANT_A, [
      { productId: product, quantity: 1 }
    ]);
    const rowBefore = await orderRow(TENANT_A, before.id);

    // A new rate (5 %) takes effect TOMORROW.
    const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);

    await inTenant(TENANT_A, async (tx) => {
      const draft = await createDraftVersion(tx, TENANT_A, STAFF, {
        profileCode: "store-default",
        name: "Lower rate",
        jurisdictionCode: "store",
        countryCode: null,
        regionCode: null,
        currencyCode: "IDR",
        pricingMode: "exclusive",
        roundingMode: "half_up",
        roundingScale: 2,
        roundingLevel: "document",
        effectiveFrom: tomorrow,
        notes: null,
        definition: {
          categories: [],
          rules: [
            {
              categoryCode: null,
              treatment: "taxable",
              components: [
                { code: "tax", name: "Tax", rate: "5", basis: "net" }
              ]
            }
          ]
        }
      });
      const published = await publishRuleVersion(tx, TENANT_A, STAFF, draft.id);

      expect(published.kind).toBe("published");
    });

    const after = await orderRow(TENANT_A, before.id);
    const snapshot = await inTenant(TENANT_A, (tx) =>
      getSnapshot(tx, TENANT_A, rowBefore.tax_snapshot_id!)
    );

    expect(after.tax).toBe(rowBefore.tax);
    expect(snapshot!.taxTotal).toBe("1100.00");
    expect(snapshot!.versionNo).toBe(1);

    // An order on the new rule's own day uses it.
    const nextDay = await placeStorefront(
      TENANT_A,
      [{ productId: product, quantity: 1 }],
      new Date(Date.now() + DAY)
    );

    expect(nextDay.tax).toBe("500.00");
    expect(
      (await snapshotsOf(TENANT_A, "sale"))
        .map((entry) => entry.versionNo)
        .sort()
    ).toEqual([1, 2]);
  });

  test("a return reverses exactly the returned units from the ORIGINAL snapshot; cancelling reverses the rest", async () => {
    const product = await seedProduct(TENANT_A, "RET-1", "10000.00");

    await cutOver(TENANT_A);

    const sale = await inTenant(TENANT_A, (tx) =>
      createPosOrder(
        tx,
        TENANT_A,
        STAFF,
        mediaLibraryPortAdapter,
        posInput([{ productId: product, quantity: 4 }]),
        NOW
      )
    );

    if (sale.kind !== "created") throw new Error("sale not created");

    const saleId = await orderIdOf(sale.order.orderCode);
    const [item] = await itemIds(saleId);
    const original = (await orderRow(TENANT_A, saleId)).tax_snapshot_id!;

    // 4 x 10,000 = 40,000 -> tax 4,400.00. Return 1 of 4 units: 1,100.00 back.
    const first = await inTenant(TENANT_A, (tx) =>
      createReturn(
        tx,
        TENANT_A,
        STAFF,
        saleId,
        returnInput([{ item: item!, qty: 1 }]),
        NOW
      )
    );

    expect(first.kind).toBe("created");

    // A rule change must not touch the reversal: it comes from the snapshot.
    const reversals = await snapshotsOf(TENANT_A, "reversal");

    expect(reversals).toHaveLength(1);
    expect(reversals[0]).toMatchObject({
      originalSnapshotId: original,
      documentType: "order",
      taxTotal: "-1100.00",
      netTotal: "-10000.00"
    });
    expect(reversals[0]!.documentId).toStartWith("return:");

    // Returning the remaining 3 units takes the exact remainder: 3,300.00.
    const second = await inTenant(TENANT_A, (tx) =>
      createReturn(
        tx,
        TENANT_A,
        STAFF,
        saleId,
        returnInput([{ item: item!, qty: 3 }]),
        NOW
      )
    );

    expect(second.kind).toBe("created");

    const total = (await snapshotsOf(TENANT_A, "reversal")).reduce(
      (sum, entry) => sum + Number(entry.taxTotal),
      0
    );

    expect(total).toBe(-4400);
  });

  test("cancelling an engine order reverses its whole tax; an expiry run by the WORKER role does too", async () => {
    const product = await seedProduct(TENANT_A, "CAN-1", "10000.00");

    await cutOver(TENANT_A);

    const cancelled = await placeStorefront(TENANT_A, [
      { productId: product, quantity: 2 }
    ]);
    const orderCode = cancelled.orderCode;
    const cancel = await inTenant(TENANT_A, (tx) =>
      cancelOrderByCustomer(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        orderCode,
        "+6281234567890",
        null
      )
    );

    expect(cancel).not.toBeNull();

    const reversalsAfterCancel = await snapshotsOf(TENANT_A, "reversal");

    expect(reversalsAfterCancel).toHaveLength(1);
    expect(reversalsAfterCancel[0]).toMatchObject({
      reason: "order_cancelled",
      originalSnapshotId: (await orderRow(TENANT_A, cancelled.id))
        .tax_snapshot_id,
      taxTotal: "-2200.00"
    });

    if (!workerRoleActivated) return;

    const abandoned = await placeStorefront(TENANT_A, [
      { productId: product, quantity: 1 }
    ]);
    const result = await expireOrdersForTenant(
      getWorkerRoleSql(),
      TENANT_A,
      new Date(Date.now() + 25 * 60 * 60 * 1000)
    );

    expect(result.expiredCount).toBeGreaterThanOrEqual(1);

    const reversals = (await snapshotsOf(TENANT_A, "reversal")).filter(
      (entry) => entry.reason === "order_expired"
    );

    expect(reversals.length).toBeGreaterThanOrEqual(1);
    expect(reversals.some((entry) => entry.taxTotal === "-1100.00")).toBe(true);
    expect(abandoned.id).toBeTruthy();
  });

  test("an exempt category carries no tax", async () => {
    const standard = await seedProduct(TENANT_A, "CAT-STD", "10000.00");
    const staple = await seedProduct(TENANT_A, "CAT-STP", "20000.00", "staple");

    await cutOver(TENANT_A);
    // Publish a successor that exempts the `staple` category, effective today+1.
    const tomorrow = new Date(Date.now() + DAY);

    await inTenant(TENANT_A, async (tx) => {
      const draft = await createDraftVersion(tx, TENANT_A, STAFF, {
        profileCode: "store-default",
        name: "With staples exempt",
        jurisdictionCode: "store",
        countryCode: null,
        regionCode: null,
        currencyCode: "IDR",
        pricingMode: "exclusive",
        roundingMode: "half_up",
        roundingScale: 2,
        roundingLevel: "document",
        effectiveFrom: tomorrow.toISOString().slice(0, 10),
        notes: null,
        definition: {
          categories: [{ code: "staple", name: "Staples" }],
          rules: [
            {
              categoryCode: null,
              treatment: "taxable",
              components: [
                { code: "tax", name: "Tax", rate: "11", basis: "net" }
              ]
            },
            { categoryCode: "staple", treatment: "exempt", components: [] }
          ]
        }
      });

      expect(
        (await publishRuleVersion(tx, TENANT_A, STAFF, draft.id)).kind
      ).toBe("published");
    });

    const order = await placeStorefront(
      TENANT_A,
      [
        { productId: standard, quantity: 1 },
        { productId: staple, quantity: 1 }
      ],
      tomorrow
    );

    // Only the 10,000 standard line is taxed: 1,100.00.
    expect(order.tax).toBe("1100.00");
    expect(order.total).toBe("31100.00");
  });

  test("RLS: another tenant sees no snapshot, and an order cannot cite a foreign tenant's snapshot", async () => {
    const product = await seedProduct(TENANT_A, "RLS-1", "10000.00");

    await cutOver(TENANT_A);

    const order = await placeStorefront(TENANT_A, [
      { productId: product, quantity: 1 }
    ]);
    const snapshotId = (await orderRow(TENANT_A, order.id)).tax_snapshot_id!;

    expect(await snapshotsOf(TENANT_B)).toHaveLength(0);
    expect(
      await inTenant(TENANT_B, (tx) => getSnapshot(tx, TENANT_B, snapshotId))
    ).toBeNull();

    // Tenant B's own order pointing at tenant A's snapshot: the composite FK refuses.
    await getAdminSql()`
      INSERT INTO awcms_commerce_customers (id, tenant_id, name, phone)
      VALUES ('d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d293', ${TENANT_B}, 'B', '+6281234567293')
    `;
    let refused: unknown = null;

    try {
      await getAdminSql()`
        INSERT INTO awcms_commerce_orders
          (tenant_id, order_code, customer_id, payment_method, shipping_method,
           subtotal, total, tax_snapshot_id)
        VALUES (${TENANT_B}, 'B-1', 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d293', 'manual_bank',
          'self_pickup', 1.00, 1.00, ${snapshotId})
      `;
    } catch (error) {
      refused = error;
    }

    expect(
      String((refused as { constraint?: string } | null)?.constraint)
    ).toBe("awcms_commerce_orders_tax_snapshot_fk");
  });

  test("a client-supplied tax amount is ignored: the order is repriced by the server", async () => {
    const product = await seedProduct(TENANT_A, "CLI-1", "10000.00");

    await cutOver(TENANT_A);

    const validated = validateCreateOrderInput({
      ...storefrontInput([{ productId: product, quantity: 1 }]),
      tax: "0.00",
      taxAmount: "0",
      total: "10000.00"
    });

    expect(validated.valid).toBe(true);
    if (!validated.valid) return;
    expect(Object.keys(validated.value)).not.toContain("tax");
    expect(Object.keys(validated.value)).not.toContain("taxAmount");

    const order = await inTenant(TENANT_A, (tx) =>
      createOrderFromCart(
        tx,
        TENANT_A,
        mediaLibraryPortAdapter,
        validated.value,
        NOW
      )
    );

    expect(order.kind).toBe("created");
    if (order.kind !== "created") return;
    expect(order.order.tax).toBe("1100.00");
    expect(order.order.total).toBe("11100.00");
  });

  test("rollback sets the mode back to flat (audited); engine-mode history keeps its snapshot", async () => {
    const product = await seedProduct(TENANT_A, "RB-1", "10000.00");

    await cutOver(TENANT_A);

    const order = await placeStorefront(TENANT_A, [
      { productId: product, quantity: 1 }
    ]);
    const rolled = await inTenant(TENANT_A, (tx) =>
      runTaxRollbackForTenant(tx, TENANT_A, { commit: true })
    );

    expect(rolled.status).toBe("rolled_back");
    expect(
      (await inTenant(TENANT_A, (tx) => fetchTaxAdapterConfig(tx, TENANT_A)))
        .mode
    ).toBe("flat");
    expect((await orderRow(TENANT_A, order.id)).tax_snapshot_id).not.toBeNull();

    const next = await placeStorefront(TENANT_A, [
      { productId: product, quantity: 1 }
    ]);

    expect(next.tax).toBe("1100.00");
    expect((await orderRow(TENANT_A, next.id)).tax_snapshot_id).toBeNull();
    expect(
      (
        await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'tax_mode.update'
      `
      )[0].n
    ).toBe(2);
  });

  test("a settings RESET keeps an engine tenant on the engine (the mode is not stamped for purge)", async () => {
    await cutOver(TENANT_A);

    const { resetStoreSettings } =
      await import("../../src/modules/commerce/application/store-settings-directory");

    await inTenant(TENANT_A, (tx) => resetStoreSettings(tx, TENANT_A, STAFF));

    expect(
      (await inTenant(TENANT_A, (tx) => fetchTaxAdapterConfig(tx, TENANT_A)))
        .mode
    ).toBe("engine");
    expect(
      (
        await getAdminSql()`
        SELECT deleted_at FROM awcms_commerce_store_settings WHERE tenant_id = ${TENANT_A}
      `
      )[0].deleted_at
    ).toBeNull();
    await inTenant(TENANT_A, (tx) =>
      setTaxAdapterConfig(
        tx,
        TENANT_A,
        null,
        { mode: "engine", profileCode: "store-default" },
        {}
      )
    );
  });
});
