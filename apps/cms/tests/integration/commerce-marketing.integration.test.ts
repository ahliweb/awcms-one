/**
 * `commerce` marketing-surface integration (Issue #26, awcms-one epic #21) —
 * the public read models the storefront builds against, exercised against a
 * REAL migrated database through `tests/integration/harness.ts`, as
 * `commerce-catalog.integration.test.ts` (Issue #23) already does for the
 * catalog. Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * What only a real database can prove here, and why each case exists:
 *
 *   - every public read model returns ONLY the public subset — the
 *     store-settings projection is the one that matters most (bank accounts,
 *     QRIS media id), and the SQL side of it (the row is fetched, the
 *     projection runs in application code) is what this guards;
 *   - the flash-sale window and the voucher window are evaluated against
 *     `now()`-shaped inputs the routes pass in, on rows the migrations
 *     actually created — a `CHECK` or a partial index the unit tests cannot
 *     see is exercised here;
 *   - the single-active-popup invariant is a PARTIAL UNIQUE INDEX
 *     (`sql/909`), so it can only be proven by a second insert;
 *   - the store-settings "reset" path stamps `deleted_at` (`sql/910`) and
 *     every reader then answers with the defaults;
 *   - RLS: tenant B sees none of tenant A's marketing rows.
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
  createFlashSale,
  createFlashSaleProduct,
  listActiveFlashSalesPublic,
  tickFlashSalesForTenant
} from "../../src/modules/commerce/application/flash-sale-directory";
import {
  createVoucher,
  listPublicVouchers,
  validateVoucherCode
} from "../../src/modules/commerce/application/voucher-directory";
import {
  createSlider,
  listActiveSlidersPublic
} from "../../src/modules/commerce/application/slider-directory";
import {
  createTestimonial,
  listActiveTestimonialsPublic
} from "../../src/modules/commerce/application/testimonial-directory";
import {
  createPopup,
  fetchActivePopupPublic,
  PopupAlreadyActiveError
} from "../../src/modules/commerce/application/popup-directory";
import {
  fetchStoreSettings,
  resetStoreSettings,
  saveStoreSettings,
  toPublicRecord
} from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
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

const NOW = new Date("2026-09-16T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

async function seedTenant(id: string, code: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

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
      'marketing.jpg', ${`https://media.test/${id}.jpg`}, 'image/jpeg', 'verified', ${ACTOR}
    )
  `;
  return id;
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-FS",
  name: "Mie Gacoan",
  slug: "mie-gacoan-jw13",
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
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

suite("commerce marketing integration (Issue #26)", () => {
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

  describe("flash sales", () => {
    test("the public read model derives status from the window, joins the product, and never returns an ended or draft sale", async () => {
      const product = await inTenant(TENANT_A, (tx) =>
        createProduct(tx, TENANT_A, ACTOR, BASE_PRODUCT)
      );
      await inTenant(
        TENANT_A,
        (tx) =>
          tx`UPDATE awcms_commerce_products SET status = 'active' WHERE id = ${product.id}`
      );

      const active = await inTenant(TENANT_A, (tx) =>
        createFlashSale(tx, TENANT_A, ACTOR, {
          name: "Flash Sale Jumat",
          slug: "flash-sale-jumat",
          startsAt: new Date(NOW.getTime() - HOUR),
          endsAt: new Date(NOW.getTime() + HOUR),
          status: "scheduled"
        })
      );
      await inTenant(TENANT_A, (tx) =>
        createFlashSale(tx, TENANT_A, ACTOR, {
          name: "Segera",
          slug: "segera",
          startsAt: new Date(NOW.getTime() + HOUR),
          endsAt: new Date(NOW.getTime() + 2 * HOUR),
          status: "scheduled"
        })
      );
      await inTenant(TENANT_A, (tx) =>
        createFlashSale(tx, TENANT_A, ACTOR, {
          name: "Sudah lewat",
          slug: "sudah-lewat",
          startsAt: new Date(NOW.getTime() - 3 * HOUR),
          endsAt: new Date(NOW.getTime() - 2 * HOUR),
          status: "scheduled"
        })
      );
      await inTenant(TENANT_A, (tx) =>
        createFlashSale(tx, TENANT_A, ACTOR, {
          name: "Draf",
          slug: "draf",
          startsAt: new Date(NOW.getTime() - HOUR),
          endsAt: new Date(NOW.getTime() + HOUR),
          status: "draft"
        })
      );

      const row = await inTenant(TENANT_A, (tx) =>
        createFlashSaleProduct(tx, TENANT_A, ACTOR, active.id, {
          productId: product.id,
          variantId: null,
          salePrice: "8500.00",
          quota: 50,
          sortOrder: 1
        })
      );
      expect(row).not.toBeNull();

      const publicSales = await inTenant(TENANT_A, (tx) =>
        listActiveFlashSalesPublic(tx, TENANT_A, mediaLibraryPortAdapter, NOW)
      );

      expect(publicSales.map((sale) => [sale.slug, sale.status])).toEqual([
        ["flash-sale-jumat", "active"],
        ["segera", "scheduled"]
      ]);

      const entry = publicSales[0]!.products[0]!;
      expect(entry.salePrice).toBe("8500.00");
      expect(entry.originalPrice).toBe("10000.00");
      expect(entry.product.slug).toBe("mie-gacoan-jw13");
      expect(entry.product.name).toBe("Mie Gacoan");
    });

    test("the tick persists the derived status and reports transitions once", async () => {
      await inTenant(TENANT_A, (tx) =>
        createFlashSale(tx, TENANT_A, ACTOR, {
          name: "Tick",
          slug: "tick",
          startsAt: new Date(NOW.getTime() - HOUR),
          endsAt: new Date(NOW.getTime() + HOUR),
          status: "scheduled"
        })
      );

      const first = await tickFlashSalesForTenant(
        getRuntimeSql(),
        TENANT_A,
        NOW
      );
      expect(first.startedCount).toBe(1);
      expect(first.endedCount).toBe(0);

      const again = await tickFlashSalesForTenant(
        getRuntimeSql(),
        TENANT_A,
        NOW
      );
      expect(again.startedCount).toBe(0);
      expect(again.endedCount).toBe(0);

      const later = await tickFlashSalesForTenant(
        getRuntimeSql(),
        TENANT_A,
        new Date(NOW.getTime() + 2 * HOUR)
      );
      expect(later.endedCount).toBe(1);

      const rows = await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT status FROM awcms_commerce_flash_sales WHERE slug = 'tick'`
      );
      expect((rows as { status: string }[])[0]?.status).toBe("ended");
    });
  });

  describe("vouchers", () => {
    test("the public list carries only public, in-window vouchers with quota; validate evaluates against the row", async () => {
      const make = (input: Partial<Parameters<typeof createVoucher>[3]>) =>
        inTenant(TENANT_A, (tx) =>
          createVoucher(tx, TENANT_A, ACTOR, {
            code: "HEMAT10",
            name: "Hemat 10%",
            description: null,
            type: "percentage",
            value: "10.00",
            minOrder: "50000.00",
            maxDiscount: "20000.00",
            quota: 0,
            isPublic: true,
            startsAt: new Date(NOW.getTime() - HOUR),
            endsAt: new Date(NOW.getTime() + HOUR),
            ...input
          })
        );

      await make({});
      await make({ code: "RAHASIA", isPublic: false });
      await make({
        code: "NANTI",
        startsAt: new Date(NOW.getTime() + HOUR),
        endsAt: new Date(NOW.getTime() + 2 * HOUR)
      });

      const publicList = await inTenant(TENANT_A, (tx) =>
        listPublicVouchers(tx, TENANT_A, NOW)
      );
      expect(publicList.map((voucher) => voucher.code)).toEqual(["HEMAT10"]);

      const ok = await inTenant(TENANT_A, (tx) =>
        validateVoucherCode(
          tx,
          TENANT_A,
          "hemat10",
          "120000.00",
          "15000.00",
          NOW
        )
      );
      expect(ok.valid).toBe(true);
      if (ok.valid) expect(ok.discount).toBe("12000.00");

      const tooSmall = await inTenant(TENANT_A, (tx) =>
        validateVoucherCode(tx, TENANT_A, "HEMAT10", "10000.00", "0.00", NOW)
      );
      expect(tooSmall).toEqual({ valid: false, reason: "min_order" });

      const unknown = await inTenant(TENANT_A, (tx) =>
        validateVoucherCode(tx, TENANT_A, "TIDAKADA", "120000.00", "0.00", NOW)
      );
      expect(unknown).toEqual({ valid: false, reason: "not_found" });

      // A private voucher is not advertised, but it still WORKS when typed.
      const secret = await inTenant(TENANT_A, (tx) =>
        validateVoucherCode(tx, TENANT_A, "RAHASIA", "120000.00", "0.00", NOW)
      );
      expect(secret.valid).toBe(true);
    });
  });

  describe("sliders, testimonials, popup", () => {
    test("public read models resolve media through the port and honour is_active + window", async () => {
      const mediaId = await seedVerifiedMediaObject(TENANT_A);

      await inTenant(TENANT_A, (tx) =>
        createSlider(
          tx,
          TENANT_A,
          ACTOR,
          {
            title: "Promo",
            subtitle: null,
            mediaObjectId: mediaId,
            linkUrl: "/flash-sale",
            buttonText: "Lihat",
            sortOrder: 2,
            isActive: true,
            startsAt: null,
            endsAt: null
          },
          mediaLibraryPortAdapter
        )
      );
      await inTenant(TENANT_A, (tx) =>
        createSlider(
          tx,
          TENANT_A,
          ACTOR,
          {
            title: "Nonaktif",
            subtitle: null,
            mediaObjectId: mediaId,
            linkUrl: null,
            buttonText: null,
            sortOrder: 1,
            isActive: false,
            startsAt: null,
            endsAt: null
          },
          mediaLibraryPortAdapter
        )
      );

      const sliders = await inTenant(TENANT_A, (tx) =>
        listActiveSlidersPublic(tx, TENANT_A, mediaLibraryPortAdapter, NOW)
      );
      expect(sliders.map((slider) => slider.title)).toEqual(["Promo"]);
      expect(sliders[0]!.image.url).toBe(`https://media.test/${mediaId}.jpg`);

      await inTenant(TENANT_A, (tx) =>
        createTestimonial(tx, TENANT_A, ACTOR, {
          authorName: "Siti",
          authorRole: "Pelanggan",
          body: "Mantap",
          rating: 5,
          avatarMediaObjectId: null,
          isActive: true,
          sortOrder: 1
        })
      );
      const testimonials = await inTenant(TENANT_A, (tx) =>
        listActiveTestimonialsPublic(tx, TENANT_A, mediaLibraryPortAdapter)
      );
      expect(testimonials.map((item) => item.authorName)).toEqual(["Siti"]);
      expect(testimonials[0]!.avatar).toBeNull();

      await inTenant(TENANT_A, (tx) =>
        createPopup(tx, TENANT_A, ACTOR, {
          title: "Promo Spesial",
          body: null,
          mediaObjectId: null,
          linkUrl: "/flash-sale",
          buttonText: "Lihat promo",
          frequency: "once_per_day",
          isActive: true,
          startsAt: null,
          endsAt: null
        })
      );
      const popup = await inTenant(TENANT_A, (tx) =>
        fetchActivePopupPublic(tx, TENANT_A, mediaLibraryPortAdapter, NOW)
      );
      expect(popup?.title).toBe("Promo Spesial");
      expect(popup?.frequency).toBe("once_per_day");
    });

    test("at most one ACTIVE popup per tenant — the partial unique index refuses a second", async () => {
      const make = () =>
        inTenant(TENANT_A, (tx) =>
          createPopup(tx, TENANT_A, ACTOR, {
            title: "Satu",
            body: null,
            mediaObjectId: null,
            linkUrl: null,
            buttonText: null,
            frequency: "always",
            isActive: true,
            startsAt: null,
            endsAt: null
          })
        );

      await make();
      await expect(make()).rejects.toBeInstanceOf(PopupAlreadyActiveError);
    });
  });

  describe("store settings", () => {
    test("save → public projection strips secrets; reset stamps deleted_at and every reader answers with the defaults", async () => {
      const validated = validateStoreSettingsInput({
        storeName: "BjekMart",
        payment: {
          manualBank: {
            active: true,
            accounts: [
              {
                bankName: "BCA",
                accountNumber: "1234567890",
                accountHolder: "PT Borneojek"
              }
            ]
          },
          manualQris: { active: true, mediaObjectId: null }
        }
      });
      expect(validated.valid).toBe(true);
      if (!validated.valid) return;

      const saved = await inTenant(TENANT_A, (tx) =>
        saveStoreSettings(tx, TENANT_A, ACTOR, validated.value)
      );
      expect(saved.payment.manualBank.accounts[0]?.accountNumber).toBe(
        "1234567890"
      );

      const publicRecord = await inTenant(TENANT_A, (tx) =>
        toPublicRecord(tx, TENANT_A, saved, mediaLibraryPortAdapter)
      );
      const serialised = JSON.stringify(publicRecord);
      expect(serialised).not.toContain("1234567890");
      expect(serialised).not.toContain("PT Borneojek");
      expect(publicRecord.payment.manualBank).toEqual({
        active: true,
        banks: [{ bankName: "BCA" }]
      });

      const reset = await inTenant(TENANT_A, (tx) =>
        resetStoreSettings(tx, TENANT_A, ACTOR)
      );
      expect(reset).toBe(true);
      const again = await inTenant(TENANT_A, (tx) =>
        resetStoreSettings(tx, TENANT_A, ACTOR)
      );
      expect(again).toBe(false);

      const afterReset = await inTenant(TENANT_A, (tx) =>
        fetchStoreSettings(tx, TENANT_A)
      );
      expect(afterReset.payment.manualBank.accounts).toEqual([]);
      expect(afterReset.storeName).toBe("tenant-a Name");

      const stamped = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT deleted_at FROM awcms_commerce_store_settings WHERE tenant_id = ${TENANT_A}`
      )) as { deleted_at: Date | null }[];
      expect(stamped[0]?.deleted_at).not.toBeNull();

      // A PUT after a reset clears the stamp rather than inserting a second row.
      const resaved = await inTenant(TENANT_A, (tx) =>
        saveStoreSettings(tx, TENANT_A, ACTOR, validated.value)
      );
      expect(resaved.storeName).toBe("BjekMart");
      const rows = (await inTenant(
        TENANT_A,
        (tx) =>
          tx`SELECT count(*)::int AS n, bool_and(deleted_at IS NULL) AS live FROM awcms_commerce_store_settings WHERE tenant_id = ${TENANT_A}`
      )) as { n: number; live: boolean }[];
      expect(rows[0]).toEqual({ n: 1, live: true });
    });
  });

  describe("RLS", () => {
    test("tenant B reads none of tenant A's marketing rows", async () => {
      await inTenant(TENANT_A, (tx) =>
        createVoucher(tx, TENANT_A, ACTOR, {
          code: "A-ONLY",
          name: "A",
          description: null,
          type: "nominal",
          value: "1000.00",
          minOrder: "0.00",
          maxDiscount: null,
          quota: 0,
          isPublic: true,
          startsAt: new Date(NOW.getTime() - HOUR),
          endsAt: new Date(NOW.getTime() + HOUR)
        })
      );
      await inTenant(TENANT_A, (tx) =>
        createTestimonial(tx, TENANT_A, ACTOR, {
          authorName: "A",
          authorRole: null,
          body: "A",
          rating: 5,
          avatarMediaObjectId: null,
          isActive: true,
          sortOrder: 0
        })
      );

      const vouchersB = await inTenant(TENANT_B, (tx) =>
        listPublicVouchers(tx, TENANT_B, NOW)
      );
      const testimonialsB = await inTenant(TENANT_B, (tx) =>
        listActiveTestimonialsPublic(tx, TENANT_B, mediaLibraryPortAdapter)
      );
      const validateB = await inTenant(TENANT_B, (tx) =>
        validateVoucherCode(tx, TENANT_B, "A-ONLY", "100000.00", "0.00", NOW)
      );

      expect(vouchersB).toEqual([]);
      expect(testimonialsB).toEqual([]);
      expect(validateB).toEqual({ valid: false, reason: "not_found" });
    });
  });
});
