/**
 * `commerce` entitlement directory integration (Issue #267, IRMbyDUS) —
 * exercised against a REAL migrated database through
 * `tests/integration/harness.ts`, the way `commerce-orders` (#29) already
 * is. Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * Covers the properties only a real database can prove:
 *
 *   - `grantEntitlementsForPaidOrder` grants exactly one row per distinct
 *     product on a paid order;
 *   - the `commerce.order_paid_entitlement_grantor` consumer
 *     (`domain-event-runtime/infrastructure/consumer-registry.ts`) is
 *     idempotent: firing the SAME domain event through its own handler
 *     twice yields exactly one entitlement row per (order, product), never
 *     two (`applyConsumerEffectOnce` guarding the handler, `sql/936`'s
 *     unique index guarding the INSERT itself);
 *   - `verifyEntitlement` returns the active row for an entitled pair and
 *     `null` otherwise, and reflects a revoke on the very next call (no
 *     cache);
 *   - `revokeEntitlementByAdmin` flips status/`revoked_at` exactly once
 *     (`not_found`/`already_revoked` on the paths that must not double-fire);
 *   - `listEntitlementsForCustomer` is owner-scoped;
 *   - RLS: tenant B cannot see tenant A's entitlement row even with the
 *     right id.
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
  grantEntitlementsForPaidOrder,
  listEntitlementsForCustomer,
  revokeEntitlementByAdmin,
  verifyEntitlement
} from "../../src/modules/commerce/application/commerce-entitlement-directory";
import { orderPaidEntitlementGrantorConsumer } from "../../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import type { DomainEventForHandler } from "../../src/modules/domain-event-runtime/domain/consumer-types";
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

const NOW = new Date("2026-09-29T10:00:00.000Z");

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

async function seedCustomer(tenantId: string, phone: string): Promise<string> {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
      VALUES (${tenantId}, 'Siti', ${phone})
      RETURNING id
    `
  )) as { id: string }[];
  return rows[0]!.id;
}

async function seedProduct(tenantId: string, sku: string): Promise<string> {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_commerce_products
        (tenant_id, type, sku, name, slug, price, stock, status, min_purchase, weight_grams)
      VALUES
        (${tenantId}, 'digital', ${sku}, ${"Product " + sku}, ${sku.toLowerCase()}, '10000.00', 100, 'active', 1, 0)
      RETURNING id
    `
  )) as { id: string }[];
  return rows[0]!.id;
}

/** A `paid` order with one item per `productIds` entry — inserted directly (order-creation itself is Issue #29's own suite). */
async function seedPaidOrder(
  tenantId: string,
  customerId: string,
  productIds: string[]
): Promise<string> {
  return inTenant(tenantId, async (tx) => {
    const orderRows = (await tx`
      INSERT INTO awcms_commerce_orders
        (tenant_id, order_code, customer_id, status, payment_method, payment_status,
         shipping_method, subtotal, total, paid_at)
      VALUES
        (${tenantId}, ${"ORD-" + Math.random().toString(36).slice(2, 8)}, ${customerId},
         'paid', 'manual_qris', 'paid', 'self_pickup', '10000.00', '10000.00', ${NOW})
      RETURNING id
    `) as { id: string }[];
    const orderId = orderRows[0]!.id;

    for (const productId of productIds) {
      await tx`
        INSERT INTO awcms_commerce_order_items
          (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
        VALUES
          (${tenantId}, ${orderId}, ${productId}, 'Item', '10000.00', 1, '10000.00')
      `;
    }

    return orderId;
  });
}

async function countEntitlements(
  tenantId: string,
  orderId: string
): Promise<number> {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
      SELECT count(*)::int AS n FROM awcms_commerce_entitlements
      WHERE tenant_id = ${tenantId} AND source_order_id = ${orderId}
    `
  )) as { n: number }[];
  return rows[0]!.n;
}

function fakeOrderPaidEvent(
  orderId: string,
  eventId: string
): DomainEventForHandler {
  return {
    id: eventId,
    eventType: "awcms.commerce.order.paid",
    eventVersion: "1.0",
    aggregateType: "commerce.order",
    aggregateId: orderId,
    orderKey: `commerce.order:${orderId}`,
    correlationId: null,
    causationId: null,
    producerModule: "commerce",
    payload: {
      orderId,
      orderCode: "ORD-TEST",
      from: "pending_payment",
      to: "paid"
    },
    occurredAt: NOW,
    recordedAt: NOW
  };
}

suite(
  "commerce entitlement directory integration (Issue #267, IRMbyDUS)",
  () => {
    beforeAll(async () => {
      await setupIntegrationDatabase();
    }, 120000);

    afterAll(async () => {
      await teardownIntegrationDatabase();
    }, 60000);

    beforeEach(async () => {
      await resetDatabase();
      await seedTenant(TENANT_A, "TENA");
      await seedTenant(TENANT_B, "TENB");
    });

    test("grantEntitlementsForPaidOrder grants exactly one row per distinct product, and is a no-op if called again for the same order", async () => {
      const customerId = await seedCustomer(TENANT_A, "0812-0000-0001");
      const productA = await seedProduct(TENANT_A, "SKU-A");
      const productB = await seedProduct(TENANT_A, "SKU-B");
      const orderId = await seedPaidOrder(TENANT_A, customerId, [
        productA,
        productB
      ]);

      const firstPass = await inTenant(TENANT_A, (tx) =>
        grantEntitlementsForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(firstPass.length).toBe(2);
      expect(await countEntitlements(TENANT_A, orderId)).toBe(2);

      // Calling it again for the SAME order must not duplicate — the
      // `ON CONFLICT (tenant_id, source_order_id, product_id) DO NOTHING`
      // row-level guard (sql/936).
      const secondPass = await inTenant(TENANT_A, (tx) =>
        grantEntitlementsForPaidOrder(tx, TENANT_A, orderId)
      );
      expect(secondPass.length).toBe(0);
      expect(await countEntitlements(TENANT_A, orderId)).toBe(2);

      const entitlement = await inTenant(TENANT_A, (tx) =>
        verifyEntitlement(tx, TENANT_A, customerId, productA)
      );
      expect(entitlement?.status).toBe("active");
      expect(entitlement?.sourceOrderId).toBe(orderId);

      const audit = (await inTenant(
        TENANT_A,
        (tx) => tx`
        SELECT count(*)::int AS n FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'commerce.entitlement.granted'
      `
      )) as { n: number }[];
      expect(audit[0]!.n).toBe(2);
    });

    test("the order_paid_entitlement_grantor consumer is idempotent: firing the same event twice yields exactly one entitlement row per product", async () => {
      const customerId = await seedCustomer(TENANT_A, "0812-0000-0002");
      const productId = await seedProduct(TENANT_A, "SKU-C");
      const orderId = await seedPaidOrder(TENANT_A, customerId, [productId]);
      const event = fakeOrderPaidEvent(
        orderId,
        "99999999-9999-4999-8999-999999999999"
      );
      const ctx = { tenantId: TENANT_A, correlationId: "test-correlation" };

      await inTenant(TENANT_A, (tx) =>
        orderPaidEntitlementGrantorConsumer.handler(tx, event, ctx)
      );
      await inTenant(TENANT_A, (tx) =>
        orderPaidEntitlementGrantorConsumer.handler(tx, event, ctx)
      );

      expect(await countEntitlements(TENANT_A, orderId)).toBe(1);
    });

    test("verifyEntitlement is null for an unentitled pair, and revokeEntitlementByAdmin is reflected on the very next call (no cache)", async () => {
      const customerId = await seedCustomer(TENANT_A, "0812-0000-0003");
      const productId = await seedProduct(TENANT_A, "SKU-D");
      const otherProductId = await seedProduct(TENANT_A, "SKU-E");
      const orderId = await seedPaidOrder(TENANT_A, customerId, [productId]);

      await inTenant(TENANT_A, (tx) =>
        grantEntitlementsForPaidOrder(tx, TENANT_A, orderId)
      );

      expect(
        await inTenant(TENANT_A, (tx) =>
          verifyEntitlement(tx, TENANT_A, customerId, otherProductId)
        )
      ).toBeNull();

      const active = await inTenant(TENANT_A, (tx) =>
        verifyEntitlement(tx, TENANT_A, customerId, productId)
      );
      expect(active).not.toBeNull();

      const revoked = await inTenant(TENANT_A, (tx) =>
        revokeEntitlementByAdmin(tx, TENANT_A, active!.id, ACTOR)
      );
      expect(revoked.kind).toBe("revoked");

      expect(
        await inTenant(TENANT_A, (tx) =>
          verifyEntitlement(tx, TENANT_A, customerId, productId)
        )
      ).toBeNull();

      const secondRevoke = await inTenant(TENANT_A, (tx) =>
        revokeEntitlementByAdmin(tx, TENANT_A, active!.id, ACTOR)
      );
      expect(secondRevoke.kind).toBe("already_revoked");

      const notFound = await inTenant(TENANT_A, (tx) =>
        revokeEntitlementByAdmin(
          tx,
          TENANT_A,
          "44444444-4444-4444-4444-444444444444",
          ACTOR
        )
      );
      expect(notFound.kind).toBe("not_found");

      const audit = (await inTenant(
        TENANT_A,
        (tx) => tx`
        SELECT count(*)::int AS n FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'commerce.entitlement.revoked'
      `
      )) as { n: number }[];
      expect(audit[0]!.n).toBe(1);
    });

    test("listEntitlementsForCustomer is owner-scoped, and RLS hides tenant A's rows from tenant B", async () => {
      const customerId = await seedCustomer(TENANT_A, "0812-0000-0004");
      const otherCustomerId = await seedCustomer(TENANT_A, "0812-0000-0005");
      const productId = await seedProduct(TENANT_A, "SKU-F");

      const orderId = await seedPaidOrder(TENANT_A, customerId, [productId]);
      await seedPaidOrder(TENANT_A, otherCustomerId, [productId]);

      await inTenant(TENANT_A, (tx) =>
        grantEntitlementsForPaidOrder(tx, TENANT_A, orderId)
      );

      const page = await inTenant(TENANT_A, (tx) =>
        listEntitlementsForCustomer(tx, TENANT_A, customerId, null)
      );
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.ownerCustomerId).toBe(customerId);

      const entitlementId = page.items[0]!.id;
      const crossTenantRead = (await inTenant(
        TENANT_B,
        (tx) =>
          tx`SELECT id FROM awcms_commerce_entitlements WHERE id = ${entitlementId}`
      )) as { id: string }[];
      expect(crossTenantRead.length).toBe(0);
    });
  }
);
