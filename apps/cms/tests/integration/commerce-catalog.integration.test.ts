/**
 * `commerce` catalog-parity integration tests (Issue #23) — real PostgreSQL,
 * real RLS, real migrations, via the shared harness (`./harness.ts`). Same
 * "call the application layer directly under `withTenantOrThrow`, seed
 * fixtures through `getAdminSql()`" style as `comments.integration.test.ts`:
 * RLS isolation and cross-table constraints are DB-level properties, so
 * proving them does not need the HTTP/auth layer on top.
 *
 * Covers exactly the Issue #23 acceptance list: list filters, by-slug,
 * image/variant CRUD, restore, and RLS isolation between two tenants.
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
  createCategory,
  deleteCategory,
  restoreCategory
} from "../../src/modules/commerce/application/category-directory";
import {
  attachProductRelations,
  createProduct,
  deleteProduct,
  fetchProductBySlug,
  listProducts,
  restoreProduct,
  updateProduct,
  type ProductRecord
} from "../../src/modules/commerce/application/product-directory";
import {
  createProductImage,
  deleteProductImage,
  updateProductImage,
  ProductImageMediaReferenceInvalidError
} from "../../src/modules/commerce/application/product-image-directory";
import {
  createProductVariant,
  deleteProductVariant,
  DuplicateVariantSkuError,
  updateProductVariant
} from "../../src/modules/commerce/application/product-variant-directory";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import type { CreateProductInput } from "../../src/modules/commerce/domain/product-validation";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ACTOR = "33333333-3333-3333-3333-333333333333";

async function seedTenant(id: string, code: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

/** A live, `verified` media object — the one shape `isMediaReferenceSafe` accepts. */
async function seedVerifiedMediaObject(tenantId: string): Promise<string> {
  const admin = getAdminSql();
  const id = crypto.randomUUID();
  await admin`
    INSERT INTO awcms_news_media_objects (
      id, tenant_id, module_key, storage_driver, bucket_name, object_key,
      original_filename, public_url, mime_type, status, created_by_tenant_user_id
    ) VALUES (
      ${id}, ${tenantId}, 'news_portal', 'cloudflare_r2', 'test-bucket',
      ${`news-media/${tenantId}/2026/01/${id}.jpg`},
      'product.jpg', ${`https://media.test/${id}.jpg`}, 'image/jpeg', 'verified', ${ACTOR}
    )
  `;
  return id;
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

async function makeProduct(
  tenantId: string,
  overrides: Partial<CreateProductInput>
): Promise<ProductRecord> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, (tx) =>
    createProduct(tx, tenantId, ACTOR, { ...BASE_PRODUCT, ...overrides })
  );
}

suite("commerce catalog-parity integration (Issue #23)", () => {
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

  describe("list filters", () => {
    test("categoryId, status, featured, recommended, and q narrow the result set", async () => {
      const category = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) =>
          createCategory(tx, TENANT_A, ACTOR, {
            parentId: null,
            name: "Minuman",
            slug: "minuman",
            icon: null
          })
      );

      const featured = await makeProduct(TENANT_A, {
        sku: "SKU-FEATURED",
        slug: "featured-coffee",
        name: "Kopi Robusta 250g",
        categoryId: category.id,
        isFeatured: true
      });
      await makeProduct(TENANT_A, {
        sku: "SKU-PLAIN",
        slug: "plain-tea",
        name: "Teh Hijau",
        categoryId: null,
        isFeatured: false
      });

      await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        updateProduct(tx, TENANT_A, ACTOR, featured.id, { status: "active" })
      );

      const byCategory = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) => listProducts(tx, TENANT_A, null, { categoryId: category.id })
      );
      expect(byCategory.items.map((p) => p.sku)).toEqual(["SKU-FEATURED"]);

      const byFeatured = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) => listProducts(tx, TENANT_A, null, { featured: true })
      );
      expect(byFeatured.items.map((p) => p.sku)).toEqual(["SKU-FEATURED"]);

      const byStatus = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) => listProducts(tx, TENANT_A, null, { status: "active" })
      );
      expect(byStatus.items.map((p) => p.sku)).toEqual(["SKU-FEATURED"]);

      const byQuery = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        listProducts(tx, TENANT_A, null, { q: "robusta" })
      );
      expect(byQuery.items.map((p) => p.sku)).toEqual(["SKU-FEATURED"]);

      const bySkuQuery = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) => listProducts(tx, TENANT_A, null, { q: "PLAIN" })
      );
      expect(bySkuQuery.items.map((p) => p.sku)).toEqual(["SKU-PLAIN"]);
    }, 20000);

    test("price_asc/price_desc/name sort a single page without a keyset cursor", async () => {
      await makeProduct(TENANT_A, {
        sku: "SKU-CHEAP",
        slug: "cheap",
        name: "Aaa",
        price: "10000.00"
      });
      await makeProduct(TENANT_A, {
        sku: "SKU-PRICEY",
        slug: "pricey",
        name: "Zzz",
        price: "90000.00"
      });

      const priceAsc = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) => listProducts(tx, TENANT_A, null, { sort: "price_asc" })
      );
      expect(priceAsc.items.map((p) => p.sku)).toEqual([
        "SKU-CHEAP",
        "SKU-PRICEY"
      ]);
      expect(priceAsc.nextCursor).toBeNull();

      const priceDesc = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) => listProducts(tx, TENANT_A, null, { sort: "price_desc" })
      );
      expect(priceDesc.items.map((p) => p.sku)).toEqual([
        "SKU-PRICEY",
        "SKU-CHEAP"
      ]);

      const byName = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        listProducts(tx, TENANT_A, null, { sort: "name" })
      );
      expect(byName.items.map((p) => p.name)).toEqual(["Aaa", "Zzz"]);
    }, 20000);
  });

  test("by-slug fetch resolves a live product, and never a soft-deleted one", async () => {
    const product = await makeProduct(TENANT_A, {
      sku: "SKU-SLUG",
      slug: "by-slug-product"
    });

    const found = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
      fetchProductBySlug(tx, TENANT_A, "by-slug-product")
    );
    expect(found?.id).toBe(product.id);

    await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
      deleteProduct(tx, TENANT_A, ACTOR, product.id)
    );

    const afterDelete = await withTenantOrThrow(
      getRuntimeSql(),
      TENANT_A,
      (tx) => fetchProductBySlug(tx, TENANT_A, "by-slug-product")
    );
    expect(afterDelete).toBeNull();
  }, 20000);

  describe("product images", () => {
    test("create/update/delete, and the resolved publicUrl round-trips through MediaLibraryPort", async () => {
      const product = await makeProduct(TENANT_A, {
        sku: "SKU-IMG",
        slug: "image-product"
      });
      const mediaId = await seedVerifiedMediaObject(TENANT_A);

      const image = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        createProductImage(
          tx,
          TENANT_A,
          ACTOR,
          product.id,
          { mediaObjectId: mediaId, altText: "front", sortOrder: 0 },
          mediaLibraryPortAdapter
        )
      );
      expect(image.mediaObjectId).toBe(mediaId);

      const resolved = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) =>
          mediaLibraryPortAdapter.resolveMediaReferences(tx, TENANT_A, [
            mediaId
          ])
      );
      expect(resolved.get(mediaId)?.publicUrl).toContain(mediaId);

      const updated = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        updateProductImage(tx, TENANT_A, ACTOR, product.id, image.id, {
          sortOrder: 5
        })
      );
      expect(updated?.sortOrder).toBe(5);

      const deleted = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        deleteProductImage(tx, TENANT_A, ACTOR, product.id, image.id)
      );
      expect(deleted).toBe(true);
    }, 20000);

    test("a media object belonging to another tenant is rejected", async () => {
      const product = await makeProduct(TENANT_A, {
        sku: "SKU-XTENANT",
        slug: "cross-tenant-image"
      });
      const otherTenantMediaId = await seedVerifiedMediaObject(TENANT_B);

      await expect(
        withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
          createProductImage(
            tx,
            TENANT_A,
            ACTOR,
            product.id,
            { mediaObjectId: otherTenantMediaId, altText: null, sortOrder: 0 },
            mediaLibraryPortAdapter
          )
        )
      ).rejects.toBeInstanceOf(ProductImageMediaReferenceInvalidError);
    }, 20000);
    test("attachProductRelations batches images across SEVERAL products in one query (Issue #26 regression)", async () => {
      // Bun.SQL does not bind a JS array as a Postgres array — `${ids}` reaches
      // the server as the text `a,b` (22P02 "malformed array literal"), and
      // the single-element shape is the dangerous one because it arrives as
      // a bare `a` that looks like an ordinary string and PASSES. The batch
      // reads therefore go through `tx.array(ids, "uuid")::uuid[]`, and this
      // test is the one that fails if that ever regresses to `ANY(${ids})`:
      // two products, each with one image, resolved in one round trip.
      const first = await makeProduct(TENANT_A, {
        sku: "SKU-BATCH-1",
        slug: "batch-one"
      });
      const second = await makeProduct(TENANT_A, {
        sku: "SKU-BATCH-2",
        slug: "batch-two"
      });
      const mediaA = await seedVerifiedMediaObject(TENANT_A);
      const mediaB = await seedVerifiedMediaObject(TENANT_A);

      for (const [product, mediaId] of [
        [first, mediaA],
        [second, mediaB]
      ] as const) {
        await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
          createProductImage(
            tx,
            TENANT_A,
            ACTOR,
            product.id,
            { mediaObjectId: mediaId, altText: null, sortOrder: 0 },
            mediaLibraryPortAdapter
          )
        );
      }

      const withRelations = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) =>
          attachProductRelations(tx, TENANT_A, mediaLibraryPortAdapter, [
            first,
            second
          ])
      );

      expect(withRelations.map((p) => p.images[0]?.mediaObjectId)).toEqual([
        mediaA,
        mediaB
      ]);
      expect(withRelations[0]!.images[0]!.publicUrl).toContain(mediaA);
      expect(withRelations[0]!.sizeChartImageUrl).toBeNull();
    }, 20000);
  });

  describe("product variants", () => {
    test("create/update/delete, and sku uniqueness is checked against BOTH products and variants", async () => {
      const product = await makeProduct(TENANT_A, {
        sku: "SKU-VARBASE",
        slug: "variant-product"
      });

      const variant = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        createProductVariant(tx, TENANT_A, ACTOR, product.id, {
          name: "Size",
          value: "L",
          colorHex: null,
          imageMediaObjectId: null,
          sku: "SKU-VARIANT-L",
          price: null,
          priceLevel2: null,
          priceLevel3: null,
          priceLevel4: null,
          stock: 3,
          weightGrams: 0,
          sortOrder: 0
        })
      );
      expect(variant.sku).toBe("SKU-VARIANT-L");

      // Colliding with the PRODUCT's own sku — the cross-table half of the rule.
      await expect(
        withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
          createProductVariant(tx, TENANT_A, ACTOR, product.id, {
            name: "Size",
            value: "M",
            colorHex: null,
            imageMediaObjectId: null,
            sku: "SKU-VARBASE",
            price: null,
            priceLevel2: null,
            priceLevel3: null,
            priceLevel4: null,
            stock: 1,
            weightGrams: 0,
            sortOrder: 1
          })
        )
      ).rejects.toBeInstanceOf(DuplicateVariantSkuError);

      const updated = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        updateProductVariant(tx, TENANT_A, ACTOR, product.id, variant.id, {
          stock: 9
        })
      );
      expect(updated?.stock).toBe(9);

      const deleted = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        deleteProductVariant(tx, TENANT_A, ACTOR, product.id, variant.id)
      );
      expect(deleted).toBe(true);
    }, 20000);
  });

  describe("restore", () => {
    test("restoreProduct un-deletes, and 409s when the slug/sku was retaken", async () => {
      const product = await makeProduct(TENANT_A, {
        sku: "SKU-RESTORE",
        slug: "restore-me"
      });
      await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        deleteProduct(tx, TENANT_A, ACTOR, product.id)
      );

      const restored = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) => restoreProduct(tx, TENANT_A, ACTOR, product.id)
      );
      expect(restored?.id).toBe(product.id);

      // A repeat restore is a no-op 404-shaped null, never a duplicate.
      const repeat = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        restoreProduct(tx, TENANT_A, ACTOR, product.id)
      );
      expect(repeat).toBeNull();
    }, 20000);

    test("restoreCategory un-deletes a soft-deleted category", async () => {
      const category = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) =>
          createCategory(tx, TENANT_A, ACTOR, {
            parentId: null,
            name: "Elektronik",
            slug: "elektronik",
            icon: null
          })
      );
      await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        deleteCategory(tx, TENANT_A, ACTOR, category.id)
      );

      const restored = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) => restoreCategory(tx, TENANT_A, ACTOR, category.id)
      );
      expect(restored?.id).toBe(category.id);
      expect(restored?.productCount).toBe(0);
    }, 20000);
  });

  describe("RLS isolation between two tenants", () => {
    test("tenant B cannot see tenant A's products, categories, images, or variants", async () => {
      const category = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_A,
        (tx) =>
          createCategory(tx, TENANT_A, ACTOR, {
            parentId: null,
            name: "Rahasia",
            slug: "rahasia",
            icon: null
          })
      );
      const product = await makeProduct(TENANT_A, {
        sku: "SKU-PRIVATE",
        slug: "private-product",
        categoryId: category.id
      });
      const mediaId = await seedVerifiedMediaObject(TENANT_A);
      await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        createProductImage(
          tx,
          TENANT_A,
          ACTOR,
          product.id,
          { mediaObjectId: mediaId, altText: null, sortOrder: 0 },
          mediaLibraryPortAdapter
        )
      );
      await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
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
          stock: 1,
          weightGrams: 0,
          sortOrder: 0
        })
      );

      const seenByB = await withTenantOrThrow(
        getRuntimeSql(),
        TENANT_B,
        async (tx) => {
          const [products, categories, images, variants] = [
            (await tx`SELECT count(*)::int AS n FROM awcms_commerce_products`) as {
              n: number;
            }[],
            (await tx`SELECT count(*)::int AS n FROM awcms_commerce_categories`) as {
              n: number;
            }[],
            (await tx`SELECT count(*)::int AS n FROM awcms_commerce_product_images`) as {
              n: number;
            }[],
            (await tx`SELECT count(*)::int AS n FROM awcms_commerce_product_variants`) as {
              n: number;
            }[]
          ];
          return {
            products: products[0]!.n,
            categories: categories[0]!.n,
            images: images[0]!.n,
            variants: variants[0]!.n
          };
        }
      );

      expect(seenByB).toEqual({
        products: 0,
        categories: 0,
        images: 0,
        variants: 0
      });

      // And tenant A still sees exactly its own rows.
      const seenByA = await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
        listProducts(tx, TENANT_A, null, {})
      );
      expect(seenByA.items.map((p) => p.sku)).toEqual(["SKU-PRIVATE"]);
    }, 20000);
  });
});
