/**
 * `practice_irm` practice-session directory integration (Issue #270) —
 * exercised against a REAL migrated database
 * (`tests/integration/harness.ts`), the same pattern
 * `commerce-entitlement-directory.integration.test.ts` already established.
 * Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * Covers the properties only a real database can prove:
 *
 *   - entitlement-gate enforcement: every function (create/read/list/
 *     update/complete) answers `forbidden` for a customer without an
 *     active entitlement for `productId`, and stops answering `forbidden`
 *     the moment one is granted — no code path bypasses the check;
 *   - the `intensity`/`post_intensity` CHECK constraint rejects out-of-range
 *     values at the DATABASE, independent of the application-level
 *     `isValidIntensityValue` guard;
 *   - CRUD correctness: create (draft), update (save-draft), complete
 *     (draft -> completed), immutability of a completed session;
 *   - `listPracticeSessionsForCustomer` is owner-scoped, and RLS hides
 *     tenant A's rows from tenant B even with the right id.
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
  completePracticeSession,
  createPracticeSession,
  getPracticeSessionForCustomer,
  listPracticeSessionsForCustomer,
  updatePracticeSession
} from "../../src/modules/practice-irm/application/practice-session-directory";
import {
  assertRejected,
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

async function seedOrder(
  tenantId: string,
  customerId: string
): Promise<string> {
  const rows = (await inTenant(
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_commerce_orders
        (tenant_id, order_code, customer_id, status, payment_method, payment_status,
         shipping_method, subtotal, total, paid_at)
      VALUES
        (${tenantId}, ${"ORD-" + Math.random().toString(36).slice(2, 8)}, ${customerId},
         'paid', 'manual_qris', 'paid', 'self_pickup', '10000.00', '10000.00', ${NOW})
      RETURNING id
    `
  )) as { id: string }[];
  return rows[0]!.id;
}

/** Grants an active entitlement directly — this suite tests the entitlement
 * GATE, not the grant path (already covered by
 * `commerce-entitlement-directory.integration.test.ts`). */
async function seedEntitlement(
  tenantId: string,
  customerId: string,
  productId: string,
  orderId: string
): Promise<void> {
  await inTenant(
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_commerce_entitlements
        (tenant_id, owner_customer_id, product_id, source_order_id, status)
      VALUES (${tenantId}, ${customerId}, ${productId}, ${orderId}, 'active')
    `
  );
}

suite("practice-session directory integration (Issue #270)", () => {
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

  test("every function refuses with forbidden for a customer with no active entitlement", async () => {
    const customerId = await seedCustomer(TENANT_A, "0811-0000-0001");
    const productId = await seedProduct(TENANT_A, "SKU-A");

    const createResult = await inTenant(TENANT_A, (tx) =>
      createPracticeSession(tx, TENANT_A, customerId, productId, {
        situation: "Traffic"
      })
    );
    expect(createResult.kind).toBe("forbidden");

    const listResult = await inTenant(TENANT_A, (tx) =>
      listPracticeSessionsForCustomer(tx, TENANT_A, customerId, productId, null)
    );
    expect(listResult.kind).toBe("forbidden");

    const getResult = await inTenant(TENANT_A, (tx) =>
      getPracticeSessionForCustomer(
        tx,
        TENANT_A,
        customerId,
        productId,
        "99999999-9999-4999-8999-999999999999"
      )
    );
    expect(getResult.kind).toBe("forbidden");

    const updateResult = await inTenant(TENANT_A, (tx) =>
      updatePracticeSession(
        tx,
        TENANT_A,
        customerId,
        productId,
        "99999999-9999-4999-8999-999999999999",
        { situation: "x" }
      )
    );
    expect(updateResult.kind).toBe("forbidden");

    const completeResult = await inTenant(TENANT_A, (tx) =>
      completePracticeSession(
        tx,
        TENANT_A,
        customerId,
        productId,
        "99999999-9999-4999-8999-999999999999"
      )
    );
    expect(completeResult.kind).toBe("forbidden");
  });

  test("create/list/get/update/complete succeed once the customer holds an active entitlement", async () => {
    const customerId = await seedCustomer(TENANT_A, "0811-0000-0002");
    const productId = await seedProduct(TENANT_A, "SKU-B");
    const orderId = await seedOrder(TENANT_A, customerId);
    await seedEntitlement(TENANT_A, customerId, productId, orderId);

    const created = await inTenant(TENANT_A, (tx) =>
      createPracticeSession(tx, TENANT_A, customerId, productId, {
        situation: "Missed the bus",
        intensity: 6
      })
    );
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    expect(created.session.status).toBe("draft");
    expect(created.session.intensity).toBe(6);

    const listPage = await inTenant(TENANT_A, (tx) =>
      listPracticeSessionsForCustomer(tx, TENANT_A, customerId, productId, null)
    );
    expect(listPage.kind).toBe("ok");
    if (listPage.kind === "ok") {
      expect(listPage.page.items.length).toBe(1);
      expect(listPage.page.items[0]!.id).toBe(created.session.id);
    }

    const updated = await inTenant(TENANT_A, (tx) =>
      updatePracticeSession(
        tx,
        TENANT_A,
        customerId,
        productId,
        created.session.id,
        { neutralize: "Reframed as a common delay, not a disaster." }
      )
    );
    expect(updated.kind).toBe("updated");
    if (updated.kind === "updated") {
      expect(updated.session.neutralize).toBe(
        "Reframed as a common delay, not a disaster."
      );
      // Fields not passed keep their prior value.
      expect(updated.session.situation).toBe("Missed the bus");
    }

    const completed = await inTenant(TENANT_A, (tx) =>
      completePracticeSession(
        tx,
        TENANT_A,
        customerId,
        productId,
        created.session.id
      )
    );
    expect(completed.kind).toBe("completed");
    if (completed.kind === "completed") {
      expect(completed.session.status).toBe("completed");
      expect(completed.session.completedAt).not.toBeNull();
    }
  });

  test("completePracticeSession refuses incomplete_fields until situation/intensity are present", async () => {
    const customerId = await seedCustomer(TENANT_A, "0811-0000-0003");
    const productId = await seedProduct(TENANT_A, "SKU-C");
    const orderId = await seedOrder(TENANT_A, customerId);
    await seedEntitlement(TENANT_A, customerId, productId, orderId);

    const created = await inTenant(TENANT_A, (tx) =>
      createPracticeSession(tx, TENANT_A, customerId, productId, {})
    );
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;

    const attempt = await inTenant(TENANT_A, (tx) =>
      completePracticeSession(
        tx,
        TENANT_A,
        customerId,
        productId,
        created.session.id
      )
    );
    expect(attempt.kind).toBe("incomplete_fields");
  });

  test("a completed session is immutable: updatePracticeSession refuses once completed", async () => {
    const customerId = await seedCustomer(TENANT_A, "0811-0000-0004");
    const productId = await seedProduct(TENANT_A, "SKU-D");
    const orderId = await seedOrder(TENANT_A, customerId);
    await seedEntitlement(TENANT_A, customerId, productId, orderId);

    const created = await inTenant(TENANT_A, (tx) =>
      createPracticeSession(tx, TENANT_A, customerId, productId, {
        situation: "Deadline pressure",
        intensity: 8
      })
    );
    if (created.kind !== "created") throw new Error("setup failed");

    const completed = await inTenant(TENANT_A, (tx) =>
      completePracticeSession(
        tx,
        TENANT_A,
        customerId,
        productId,
        created.session.id
      )
    );
    expect(completed.kind).toBe("completed");

    const attemptedEdit = await inTenant(TENANT_A, (tx) =>
      updatePracticeSession(
        tx,
        TENANT_A,
        customerId,
        productId,
        created.session.id,
        { reflection: "trying to edit after completion" }
      )
    );
    expect(attemptedEdit.kind).toBe("immutable");
  });

  test("revoking the entitlement cuts off access on the very next call, including history", async () => {
    const customerId = await seedCustomer(TENANT_A, "0811-0000-0005");
    const productId = await seedProduct(TENANT_A, "SKU-E");
    const orderId = await seedOrder(TENANT_A, customerId);
    await seedEntitlement(TENANT_A, customerId, productId, orderId);

    const created = await inTenant(TENANT_A, (tx) =>
      createPracticeSession(tx, TENANT_A, customerId, productId, {
        situation: "s",
        intensity: 3
      })
    );
    expect(created.kind).toBe("created");

    await inTenant(
      TENANT_A,
      (tx) => tx`
        UPDATE awcms_commerce_entitlements
        SET status = 'revoked', revoked_at = now()
        WHERE tenant_id = ${TENANT_A} AND owner_customer_id = ${customerId}
          AND product_id = ${productId}
      `
    );

    const listAfterRevoke = await inTenant(TENANT_A, (tx) =>
      listPracticeSessionsForCustomer(tx, TENANT_A, customerId, productId, null)
    );
    expect(listAfterRevoke.kind).toBe("forbidden");
  });

  test("the intensity/post_intensity CHECK constraint rejects out-of-range values at the database", async () => {
    const customerId = await seedCustomer(TENANT_A, "0811-0000-0006");
    const productId = await seedProduct(TENANT_A, "SKU-F");

    await assertRejected(
      inTenant(
        TENANT_A,
        (tx) => tx`
          INSERT INTO awcms_practice_irm_sessions
            (tenant_id, owner_customer_id, product_id, status, intensity)
          VALUES (${TENANT_A}, ${customerId}, ${productId}, 'draft', 11)
        `
      ),
      "an intensity of 11 (above the 0-10 CHECK constraint)"
    );

    await assertRejected(
      inTenant(
        TENANT_A,
        (tx) => tx`
          INSERT INTO awcms_practice_irm_sessions
            (tenant_id, owner_customer_id, product_id, status, intensity)
          VALUES (${TENANT_A}, ${customerId}, ${productId}, 'draft', -1)
        `
      ),
      "an intensity of -1 (below the 0-10 CHECK constraint)"
    );

    await assertRejected(
      inTenant(
        TENANT_A,
        (tx) => tx`
          INSERT INTO awcms_practice_irm_sessions
            (tenant_id, owner_customer_id, product_id, status, post_intensity)
          VALUES (${TENANT_A}, ${customerId}, ${productId}, 'draft', 42)
        `
      ),
      "a post_intensity of 42 (above the 0-10 CHECK constraint)"
    );

    // A value inside the range is accepted, proving the rejection above is the
    // CHECK constraint and not some unrelated failure.
    const rows = (await inTenant(
      TENANT_A,
      (tx) => tx`
        INSERT INTO awcms_practice_irm_sessions
          (tenant_id, owner_customer_id, product_id, status, intensity, post_intensity)
        VALUES (${TENANT_A}, ${customerId}, ${productId}, 'draft', 10, 0)
        RETURNING id
      `
    )) as { id: string }[];
    expect(rows.length).toBe(1);
  });

  test("listPracticeSessionsForCustomer is owner-scoped, and RLS hides tenant A's rows from tenant B", async () => {
    const customerId = await seedCustomer(TENANT_A, "0811-0000-0007");
    const otherCustomerId = await seedCustomer(TENANT_A, "0811-0000-0008");
    const productId = await seedProduct(TENANT_A, "SKU-G");
    const orderId = await seedOrder(TENANT_A, customerId);
    const otherOrderId = await seedOrder(TENANT_A, otherCustomerId);
    await seedEntitlement(TENANT_A, customerId, productId, orderId);
    await seedEntitlement(TENANT_A, otherCustomerId, productId, otherOrderId);

    const own = await inTenant(TENANT_A, (tx) =>
      createPracticeSession(tx, TENANT_A, customerId, productId, {})
    );
    await inTenant(TENANT_A, (tx) =>
      createPracticeSession(tx, TENANT_A, otherCustomerId, productId, {})
    );
    if (own.kind !== "created") throw new Error("setup failed");

    const page = await inTenant(TENANT_A, (tx) =>
      listPracticeSessionsForCustomer(tx, TENANT_A, customerId, productId, null)
    );
    expect(page.kind).toBe("ok");
    if (page.kind === "ok") {
      expect(page.page.items.length).toBe(1);
      expect(page.page.items[0]!.ownerCustomerId).toBe(customerId);
    }

    const crossTenantRead = (await inTenant(
      TENANT_B,
      (tx) =>
        tx`SELECT id FROM awcms_practice_irm_sessions WHERE id = ${own.session.id}`
    )) as { id: string }[];
    expect(crossTenantRead.length).toBe(0);
  });
});
