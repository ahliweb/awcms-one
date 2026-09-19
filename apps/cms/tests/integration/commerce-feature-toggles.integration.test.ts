/**
 * Feature toggles + tiered pricing integration (Issue #118, epic #33 C9,
 * contract #106 D10, ADR-0016 D6) — against a REAL migrated Postgres through
 * `tests/integration/harness.ts`, the same pattern `commerce-orders`/
 * `commerce-campaigns` already use. Gated on `DATABASE_URL`; skips cleanly
 * without one.
 *
 * Covers exactly the properties only a real database can prove:
 *   - a level-2 customer's quote uses `price_level_2`, and the order created
 *     from that same account matches (quote and order never disagree);
 *   - an anonymous quote (no account) uses the ordinary retail price;
 *   - a disabled feature answers `409 FEATURE_DISABLED` for an owner-route
 *     helper and the neutral "not usable" outcome for a public one;
 *   - `PATCH .../modules/commerce/settings` round-trips through
 *     `updateModuleSettings` and is audited.
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
  createOrderFromCart,
  fetchOrderForTracking
} from "../../src/modules/commerce/application/order-directory";
import { buildCartQuote } from "../../src/modules/commerce/application/cart-quote-service";
import { saveStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { validateStoreSettingsInput } from "../../src/modules/commerce/domain/store-settings-validation";
import {
  fetchCommerceFeatures,
  requireCommerceFeatureForOwnerRoute
} from "../../src/modules/commerce/application/commerce-feature-gate";
import {
  fetchModuleSettingsView,
  updateModuleSettings
} from "../../src/modules/module-management/application/module-settings";
import { recordAuditEvent } from "../../src/modules/logging/application/audit-log";
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

const TENANT_A = "44444444-4444-4444-4444-444444444444";
const ACTOR = "55555555-5555-5555-5555-555555555555";

const NOW = new Date("2026-09-19T10:00:00.000Z");

async function seedTenant(id: string, code: string): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.SQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function enableSelfPickupAndQris(tenantId: string): Promise<void> {
  const validated = validateStoreSettingsInput({
    storeName: "Toko Uji",
    shipping: { selfPickup: true },
    payment: { manualQris: { active: true, mediaObjectId: null } }
  });
  if (!validated.valid) {
    throw new Error(JSON.stringify(validated.errors));
  }
  await inTenant(tenantId, (tx) =>
    saveStoreSettings(tx, tenantId, ACTOR, validated.value)
  );
}

const BASE_PRODUCT: CreateProductInput = {
  categoryId: null,
  type: "physical",
  sku: "SKU-TIER",
  name: "Mie Gacoan",
  slug: "mie-gacoan-tier",
  description: null,
  digitalNote: null,
  price: "10000.00",
  discountPercent: 0,
  stock: 50,
  label: null,
  labelColor: null,
  priceLevel2: "9000.00",
  priceLevel3: "8000.00",
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

async function seedActiveProduct(tenantId: string): Promise<string> {
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

/** A level-2 customer row, created directly (no bearer/OTP flow needed for this test — `createOrderFromCart`'s `accountCustomerId` parameter is exactly the seam a route reaches after `requireCustomerSession` already succeeded). */
async function seedLevel2Customer(tenantId: string): Promise<string> {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email, level, status)
      VALUES (${tenantId}, 'Budi', '+6281234567891', null, 2, 'active')
      RETURNING id
    `
  )) as { id: string }[];
  return rows[0]!.id;
}

function orderInput(
  productId: string,
  overrides: Partial<CreateOrderInput> = {}
): CreateOrderInput {
  return {
    idempotencyKey: "11111111-2222-4333-8444-666666666666",
    customer: { name: "Budi", phone: "0812-3456-7891", email: null },
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
    ...overrides
  };
}

suite(
  "commerce feature toggles + tiered pricing integration (Issue #118)",
  () => {
    beforeAll(async () => {
      await setupIntegrationDatabase();
    }, 120000);

    afterAll(async () => {
      await teardownIntegrationDatabase();
    }, 60000);

    beforeEach(async () => {
      await resetDatabase();
      await seedTenant(TENANT_A, "tenant-tier");
      await enableSelfPickupAndQris(TENANT_A);
    }, 30000);

    test("a level-2 customer's quote uses price_level_2, and the order created from the same account matches", async () => {
      const productId = await seedActiveProduct(TENANT_A);
      const customerId = await seedLevel2Customer(TENANT_A);

      const quote = await inTenant(TENANT_A, (tx) =>
        buildCartQuote(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          {
            lines: [
              {
                productId,
                variantId: null,
                quantity: 2,
                serviceFormValues: null
              }
            ],
            shipping: { method: "self_pickup" },
            voucherCode: null,
            insurance: false,
            customerLevel: 2
          },
          NOW
        )
      );
      expect(quote.lines[0]!.unitPrice).toBe("9000.00");
      expect(quote.subtotal).toBe("18000.00");

      const created = await inTenant(TENANT_A, (tx) =>
        createOrderFromCart(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          orderInput(productId),
          NOW,
          undefined,
          customerId
        )
      );
      expect(created.kind).toBe("created");
      if (created.kind !== "created") return;

      // The order's own total must agree with the level-2 quote above —
      // never the anonymous/level-1 price for the same two units.
      expect(created.order.subtotal).toBe("18000.00");
      expect(created.order.total).toBe("18000.00");

      const tracked = await inTenant(TENANT_A, (tx) =>
        fetchOrderForTracking(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          created.order.orderCode,
          "+6281234567891"
        )
      );
      expect(tracked?.subtotal).toBe("18000.00");
    });

    test("an anonymous quote (no account) uses the ordinary retail price", async () => {
      const productId = await seedActiveProduct(TENANT_A);

      const quote = await inTenant(TENANT_A, (tx) =>
        buildCartQuote(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          {
            lines: [
              {
                productId,
                variantId: null,
                quantity: 2,
                serviceFormValues: null
              }
            ],
            shipping: { method: "self_pickup" },
            voucherCode: null,
            insurance: false
          },
          NOW
        )
      );
      expect(quote.lines[0]!.unitPrice).toBe("10000.00");
      expect(quote.subtotal).toBe("20000.00");
    });

    test("a disabled feature answers 409 FEATURE_DISABLED for an owner route, and fetchCommerceFeatures reflects it for a public route's own check", async () => {
      // Default: campaigns enabled, no settings row saved yet.
      const beforeGate = await inTenant(TENANT_A, (tx) =>
        requireCommerceFeatureForOwnerRoute(tx, TENANT_A, "campaigns")
      );
      expect(beforeGate).toBeNull();

      await inTenant(TENANT_A, (tx) =>
        updateModuleSettings(
          tx,
          TENANT_A,
          "commerce",
          { features: { campaigns: false } },
          ACTOR
        )
      );

      const afterGate = await inTenant(TENANT_A, (tx) =>
        requireCommerceFeatureForOwnerRoute(tx, TENANT_A, "campaigns")
      );
      expect(afterGate).not.toBeNull();
      expect(afterGate?.status).toBe(409);
      const body = (await afterGate?.json()) as {
        error: { code: string };
      };
      expect(body.error.code).toBe("FEATURE_DISABLED");

      // A DIFFERENT feature (inbox) must still read enabled — the shallow
      // top-level merge/resolveCommerceFeatures split means one disabled flag
      // never drags the others down.
      const features = await inTenant(TENANT_A, (tx) =>
        fetchCommerceFeatures(tx, TENANT_A)
      );
      expect(features.campaigns).toBe(false);
      expect(features.inbox).toBe(true);
    });

    test("settings PATCH round trip + audit", async () => {
      const before = await inTenant(TENANT_A, (tx) =>
        fetchModuleSettingsView(tx, TENANT_A, "commerce")
      );
      expect(before?.effective.features).toMatchObject({
        pos: true,
        inbox: true,
        campaigns: true,
        gateway: true,
        courier: true
      });

      // Mirrors `PATCH /api/v1/tenant/modules/{moduleKey}/settings`'s own two
      // calls (`updateModuleSettings` then `recordAuditEvent` with the safe
      // diff) — exercised directly here since this test targets the
      // application layer, not the HTTP route.
      const result = await inTenant(TENANT_A, async (tx) => {
        const outcome = await updateModuleSettings(
          tx,
          TENANT_A,
          "commerce",
          {
            features: {
              pos: true,
              inbox: false,
              campaigns: true,
              gateway: true,
              courier: true
            }
          },
          ACTOR
        );
        if (outcome.outcome === "applied") {
          await recordAuditEvent(tx, {
            tenantId: TENANT_A,
            actorTenantUserId: ACTOR,
            moduleKey: "module_management",
            action: "settings_updated",
            resourceType: "module_settings",
            resourceId: "commerce",
            severity: "info",
            message: "Module settings updated for commerce.",
            attributes: { diff: outcome.diff }
          });
        }
        return outcome;
      });
      expect(result.outcome).toBe("applied");

      const after = await inTenant(TENANT_A, (tx) =>
        fetchModuleSettingsView(tx, TENANT_A, "commerce")
      );
      expect(after?.effective.features).toMatchObject({ inbox: false });

      const auditRows = (await inTenant(
        TENANT_A,
        (tx) => tx`
        SELECT action, message FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND module_key = 'module_management'
          AND action = 'settings_updated'
        ORDER BY created_at ASC
      `
      )) as { action: string; message: string }[];
      expect(auditRows.length).toBe(1);
      expect(auditRows[0]?.message).toContain("commerce");
    });
  }
);
