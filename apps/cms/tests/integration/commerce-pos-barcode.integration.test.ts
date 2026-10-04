/**
 * Barcode identity against a REAL, migrated PostgreSQL (Issue #292, epic #281,
 * ADR-0032). Runs as the non-superuser runtime role, so FORCE RLS is what
 * stands between two tenants and the assertions below are real:
 *
 *   - a code is unique per tenant, across products AND variants (the
 *     same-table indexes plus the cross-table trigger of `sql/975`), while two
 *     tenants may use the same code;
 *   - two concurrent writers of one new code cannot both win (the trigger's
 *     advisory lock);
 *   - lookup is tenant-scoped under RLS: another tenant's code, an unknown
 *     code and a soft-deleted row all answer `null` identically, and assigning
 *     a barcode to another tenant's product id finds nothing (BOLA);
 *   - restoring a soft-deleted row whose code was reused comes back
 *     un-barcoded instead of failing;
 *   - the lookup plan is an index probe on a large catalogue, not a scan;
 *   - the `barcode` feature defaults OFF and turns on through module settings.
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
  assignBarcode,
  DuplicateBarcodeError,
  listBarcodeCatalog,
  loadLabelRows,
  lookupBarcode
} from "../../src/modules/commerce/application/barcode-directory";
import { fetchCommerceFeatures } from "../../src/modules/commerce/application/commerce-feature-gate";
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
const ACTOR = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const EAN13 = "4006381333931";

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

async function seedActor(tenantId: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Barcode Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`barcode-actor-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${ACTOR}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedProduct(
  tenantId: string,
  sku: string,
  fields: {
    price?: string;
    discount?: number;
    stock?: number;
    status?: string;
  } = {}
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_products
      (tenant_id, sku, name, slug, price, discount_percent, stock, status)
    VALUES (${tenantId}, ${sku}, ${`Name ${sku}`}, ${`slug-${sku.toLowerCase()}`},
            ${fields.price ?? "10000.00"}, ${fields.discount ?? 0},
            ${fields.stock ?? 5}, ${fields.status ?? "active"})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function seedVariant(
  tenantId: string,
  productId: string,
  value: string,
  fields: { price?: string | null; stock?: number } = {}
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_product_variants
      (tenant_id, product_id, name, value, price, stock)
    VALUES (${tenantId}, ${productId}, 'Size', ${value}, ${fields.price ?? null}, ${fields.stock ?? 3})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

function assign(
  tenantId: string,
  target: { productId: string; variantId: string | null },
  code: string | null
) {
  return inTenant(tenantId, (tx) =>
    assignBarcode(tx, tenantId, ACTOR, target, code)
  );
}

suite("barcode identity integration (Issue #292)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-bc-a");
    await seedTenant(TENANT_B, "tenant-bc-b");
    await seedActor(TENANT_A);
  });

  test("the barcode feature defaults OFF and turns on through module settings", async () => {
    expect(
      (await inTenant(TENANT_A, (tx) => fetchCommerceFeatures(tx, TENANT_A)))
        .barcode
    ).toBe(false);
    await inTenant(TENANT_A, (tx) =>
      updateModuleSettings(
        tx,
        TENANT_A,
        "commerce",
        { features: { pos: true, barcode: true } },
        ACTOR
      )
    );
    expect(
      (await inTenant(TENANT_A, (tx) => fetchCommerceFeatures(tx, TENANT_A)))
        .barcode
    ).toBe(true);
  });

  test("a code is unique per tenant across products and variants", async () => {
    const p1 = await seedProduct(TENANT_A, "P1");
    const p2 = await seedProduct(TENANT_A, "P2");
    const v2 = await seedVariant(TENANT_A, p2, "M");

    const first = await assign(
      TENANT_A,
      { productId: p1, variantId: null },
      "ABC-1"
    );
    expect(first.kind).toBe("assigned");

    // Same table.
    await expect(
      assign(TENANT_A, { productId: p2, variantId: null }, "ABC-1")
    ).rejects.toBeInstanceOf(DuplicateBarcodeError);
    // Across tables: a variant cannot take a product's code...
    await expect(
      assign(TENANT_A, { productId: p2, variantId: v2 }, "ABC-1")
    ).rejects.toBeInstanceOf(DuplicateBarcodeError);
    // ...and a product cannot take a variant's code.
    expect(
      (await assign(TENANT_A, { productId: p2, variantId: v2 }, "VAR-1")).kind
    ).toBe("assigned");
    await expect(
      assign(TENANT_A, { productId: p1, variantId: null }, "VAR-1")
    ).rejects.toBeInstanceOf(DuplicateBarcodeError);

    // Re-saving the SAME code on the same row is not a collision with itself.
    expect(
      (await assign(TENANT_A, { productId: p1, variantId: null }, "ABC-1")).kind
    ).toBe("assigned");

    // Clearing frees the code.
    await assign(TENANT_A, { productId: p1, variantId: null }, null);
    expect(
      (await assign(TENANT_A, { productId: p2, variantId: null }, "ABC-1")).kind
    ).toBe("assigned");
  });

  test("two tenants may use the same code", async () => {
    const a = await seedProduct(TENANT_A, "PA");
    const b = await seedProduct(TENANT_B, "PB");
    expect(
      (await assign(TENANT_A, { productId: a, variantId: null }, EAN13)).kind
    ).toBe("assigned");
    expect(
      (await assign(TENANT_B, { productId: b, variantId: null }, EAN13)).kind
    ).toBe("assigned");
    expect(
      (await inTenant(TENANT_A, (tx) => lookupBarcode(tx, TENANT_A, EAN13)))
        ?.productId
    ).toBe(a);
    expect(
      (await inTenant(TENANT_B, (tx) => lookupBarcode(tx, TENANT_B, EAN13)))
        ?.productId
    ).toBe(b);
  });

  test("the database refuses a malformed code even when the application is bypassed", async () => {
    const p = await seedProduct(TENANT_A, "PX");
    for (const bad of ["has space", "tab\there", "café", "x".repeat(49), ""]) {
      await expect(
        (async () => {
          await getAdminSql()`UPDATE awcms_commerce_products SET barcode = ${bad} WHERE id = ${p}`;
        })()
      ).rejects.toThrow();
    }
  });

  test("two concurrent writers of one new code cannot both win", async () => {
    const p1 = await seedProduct(TENANT_A, "C1");
    const p2 = await seedProduct(TENANT_A, "C2");
    const v2 = await seedVariant(TENANT_A, p2, "L");
    for (let round = 0; round < 5; round += 1) {
      const code = `RACE-${round}`;
      const results = await Promise.allSettled([
        assign(TENANT_A, { productId: p1, variantId: null }, code),
        assign(TENANT_A, { productId: p2, variantId: v2 }, code)
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        DuplicateBarcodeError
      );
      await assign(TENANT_A, { productId: p1, variantId: null }, null);
      await assign(TENANT_A, { productId: p2, variantId: v2 }, null);
    }
  });

  test("lookup resolves a product, a variant, and says when a variant must be chosen", async () => {
    const plain = await seedProduct(TENANT_A, "PL", {
      price: "20000.00",
      discount: 10,
      stock: 4
    });
    const parent = await seedProduct(TENANT_A, "PV", { price: "30000.00" });
    const sized = await seedVariant(TENANT_A, parent, "XL", {
      price: "35000.00",
      stock: 2
    });
    const inherit = await seedVariant(TENANT_A, parent, "S", {
      price: null,
      stock: 1
    });
    await assign(TENANT_A, { productId: plain, variantId: null }, "PLAIN-1");
    await assign(TENANT_A, { productId: parent, variantId: null }, "PARENT-1");
    await assign(TENANT_A, { productId: parent, variantId: sized }, "SIZED-1");
    await assign(
      TENANT_A,
      { productId: parent, variantId: inherit },
      "INHERIT-1"
    );

    const found = await inTenant(TENANT_A, (tx) =>
      lookupBarcode(tx, TENANT_A, "PLAIN-1")
    );
    expect(found).toMatchObject({
      productId: plain,
      variantId: null,
      price: "18000.00", // 10% off, the same final price the POS search shows
      stock: 4,
      sellable: true,
      requiresVariant: false
    });

    const variant = await inTenant(TENANT_A, (tx) =>
      lookupBarcode(tx, TENANT_A, "SIZED-1")
    );
    expect(variant).toMatchObject({
      productId: parent,
      variantId: sized,
      price: "35000.00",
      sellable: true
    });
    expect(variant?.variantLabel).toBe("Size: XL");

    // A variant with no price of its own falls back to the product's final price.
    const fallback = await inTenant(TENANT_A, (tx) =>
      lookupBarcode(tx, TENANT_A, "INHERIT-1")
    );
    expect(fallback?.price).toBe("30000.00");

    // The bare parent of a variant product cannot be sold.
    const bare = await inTenant(TENANT_A, (tx) =>
      lookupBarcode(tx, TENANT_A, "PARENT-1")
    );
    expect(bare).toMatchObject({ requiresVariant: true, sellable: false });
  });

  test("a product that is out of stock or not active is found but not sellable", async () => {
    const out = await seedProduct(TENANT_A, "OUT", { stock: 0 });
    const draft = await seedProduct(TENANT_A, "DRF", { status: "draft" });
    await assign(TENANT_A, { productId: out, variantId: null }, "OUT-1");
    await assign(TENANT_A, { productId: draft, variantId: null }, "DRAFT-1");
    expect(
      (await inTenant(TENANT_A, (tx) => lookupBarcode(tx, TENANT_A, "OUT-1")))
        ?.sellable
    ).toBe(false);
    expect(
      (await inTenant(TENANT_A, (tx) => lookupBarcode(tx, TENANT_A, "DRAFT-1")))
        ?.sellable
    ).toBe(false);
  });

  test("lookup is tenant-scoped under RLS and answers unknown, foreign and deleted identically", async () => {
    const a = await seedProduct(TENANT_A, "RA");
    await assign(TENANT_A, { productId: a, variantId: null }, "A-ONLY");

    expect(
      await inTenant(TENANT_A, (tx) => lookupBarcode(tx, TENANT_A, "A-ONLY"))
    ).not.toBeNull();
    expect(
      await inTenant(TENANT_B, (tx) => lookupBarcode(tx, TENANT_B, "A-ONLY"))
    ).toBeNull();
    expect(
      await inTenant(TENANT_A, (tx) => lookupBarcode(tx, TENANT_A, "NOBODY"))
    ).toBeNull();

    // Even with the tenant filter removed from the SQL, RLS hides the row.
    const raw = await inTenant(
      TENANT_B,
      (tx) =>
        tx`SELECT count(*)::int AS n FROM awcms_commerce_products WHERE barcode = 'A-ONLY'`
    );
    expect((raw as { n: number }[])[0]!.n).toBe(0);

    // Soft-deleted: gone from lookup, and the code is free again.
    await getAdminSql()`UPDATE awcms_commerce_products SET deleted_at = now() WHERE id = ${a}`;
    expect(
      await inTenant(TENANT_A, (tx) => lookupBarcode(tx, TENANT_A, "A-ONLY"))
    ).toBeNull();
    const reuse = await seedProduct(TENANT_A, "RB");
    expect(
      (await assign(TENANT_A, { productId: reuse, variantId: null }, "A-ONLY"))
        .kind
    ).toBe("assigned");
  });

  test("assigning a barcode to another tenant's product (or a mismatched variant) finds nothing", async () => {
    const b = await seedProduct(TENANT_B, "FB");
    const a = await seedProduct(TENANT_A, "FA");
    const aOther = await seedProduct(TENANT_A, "FA2");
    const aVariant = await seedVariant(TENANT_A, aOther, "M");

    expect(
      await assign(TENANT_A, { productId: b, variantId: null }, "STEAL-1")
    ).toEqual({ kind: "not_found" });
    // A variant id paired with the wrong product id is not re-pointed either.
    expect(
      await assign(TENANT_A, { productId: a, variantId: aVariant }, "STEAL-2")
    ).toEqual({ kind: "not_found" });
    const rows =
      await getAdminSql()`SELECT barcode FROM awcms_commerce_products WHERE id = ${b}`;
    expect((rows as { barcode: string | null }[])[0]!.barcode).toBeNull();
  });

  test("restoring a soft-deleted row whose code was reused comes back un-barcoded", async () => {
    const original = await seedProduct(TENANT_A, "RS1");
    await assign(
      TENANT_A,
      { productId: original, variantId: null },
      "REUSED-1"
    );
    await getAdminSql()`UPDATE awcms_commerce_products SET deleted_at = now() WHERE id = ${original}`;
    const taker = await seedProduct(TENANT_A, "RS2");
    await assign(TENANT_A, { productId: taker, variantId: null }, "REUSED-1");

    await inTenant(
      TENANT_A,
      (tx) =>
        tx`UPDATE awcms_commerce_products SET deleted_at = NULL WHERE tenant_id = ${TENANT_A} AND id = ${original}`
    );
    const rows = (await getAdminSql()`
      SELECT id, barcode FROM awcms_commerce_products WHERE id IN (${original}, ${taker})
    `) as { id: string; barcode: string | null }[];
    expect(rows.find((r) => r.id === original)!.barcode).toBeNull();
    expect(rows.find((r) => r.id === taker)!.barcode).toBe("REUSED-1");
  });

  test("label rows keep the requested order, include rows without a barcode and drop foreign ids", async () => {
    const a1 = await seedProduct(TENANT_A, "LB1");
    const a2 = await seedProduct(TENANT_A, "LB2");
    const foreign = await seedProduct(TENANT_B, "LBF");
    await assign(TENANT_A, { productId: a1, variantId: null }, "LABEL-1");

    const rows = await inTenant(TENANT_A, (tx) =>
      loadLabelRows(tx, TENANT_A, [
        { productId: a2, variantId: null },
        { productId: foreign, variantId: null },
        { productId: a1, variantId: null }
      ])
    );
    expect(rows.map((r) => r.productId)).toEqual([a2, a1]);
    expect(rows[0]!.barcode).toBeNull();
    expect(rows[1]!.barcode).toBe("LABEL-1");
    expect(rows[1]!.symbology).toBe("code128");
  });

  test("the catalogue lists variants and variant-less products, filters, and pages", async () => {
    const parent = await seedProduct(TENANT_A, "CP");
    const v = await seedVariant(TENANT_A, parent, "M");
    const solo = await seedProduct(TENANT_A, "CS");
    await assign(TENANT_A, { productId: solo, variantId: null }, EAN13);

    const all = await inTenant(TENANT_A, (tx) =>
      listBarcodeCatalog(tx, TENANT_A)
    );
    expect(
      all.items.map((r) => `${r.productId}:${r.variantId ?? ""}`).sort()
    ).toEqual([`${parent}:${v}`, `${solo}:`].sort());
    const row = all.items.find((r) => r.productId === solo)!;
    expect(row.symbology).toBe("ean13");

    const withCode = await inTenant(TENANT_A, (tx) =>
      listBarcodeCatalog(tx, TENANT_A, { barcode: "with" })
    );
    expect(withCode.items.map((r) => r.productId)).toEqual([solo]);
    const without = await inTenant(TENANT_A, (tx) =>
      listBarcodeCatalog(tx, TENANT_A, { barcode: "without" })
    );
    expect(without.items.map((r) => r.variantId)).toEqual([v]);
    const byCode = await inTenant(TENANT_A, (tx) =>
      listBarcodeCatalog(tx, TENANT_A, { q: EAN13 })
    );
    expect(byCode.items.map((r) => r.productId)).toEqual([solo]);
    // A LIKE metacharacter in q is a literal.
    const wild = await inTenant(TENANT_A, (tx) =>
      listBarcodeCatalog(tx, TENANT_A, { q: "%" })
    );
    expect(wild.items).toHaveLength(0);
    // Another tenant sees none of it.
    const other = await inTenant(TENANT_B, (tx) =>
      listBarcodeCatalog(tx, TENANT_B)
    );
    expect(other.items).toHaveLength(0);
  });

  test("lookup on a large catalogue is an index probe, not a scan", async () => {
    await getAdminSql()`
      INSERT INTO awcms_commerce_products (tenant_id, sku, name, slug, price, barcode)
      SELECT ${TENANT_A}, 'BULK-' || g, 'Bulk ' || g, 'bulk-' || g, 1000, 'LOAD-' || lpad(g::text, 6, '0')
      FROM generate_series(1, 20000) AS g
    `;
    await getAdminSql()`ANALYZE awcms_commerce_products`;
    await getAdminSql()`ANALYZE awcms_commerce_product_variants`;

    const plan = (await inTenant(
      TENANT_A,
      (tx) => tx`
        EXPLAIN
        SELECT p.id FROM awcms_commerce_products p
        WHERE p.tenant_id = ${TENANT_A} AND p.barcode = ${"LOAD-012345"}
          AND p.deleted_at IS NULL
      `
    )) as Record<string, string>[];
    const text = plan.map((row) => Object.values(row)[0]).join("\n");
    expect(text).toContain("awcms_commerce_products_tenant_barcode_key");
    expect(text).not.toContain("Seq Scan");

    const found = await inTenant(TENANT_A, (tx) =>
      lookupBarcode(tx, TENANT_A, "LOAD-012345")
    );
    expect(found?.sku).toBe("BULK-12345");
  }, 60000);
});
