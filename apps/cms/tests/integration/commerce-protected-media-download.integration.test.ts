/**
 * Issue #268 (IRMbyDUS) — the CUSTOMER-facing half of the private-object
 * issuance flow (`GET /api/v1/commerce/storefront/products/{id}/download`),
 * exercised against a REAL PostgreSQL through the exact composed functions
 * the route calls (`fetchProtectedMediaLinkForProduct`,
 * `fetchNewsMediaObjectById`, `isMediaObjectDownloadable`,
 * `verifyEntitlement`) — the same "real chokepoint, not a mock" discipline
 * `commerce-entitlement-directory.integration.test.ts` already established
 * for the sibling entitlement-check route. The route file itself is thin
 * request/response wiring around this composition (auth/CORS/rate-limit
 * plumbing this repo's `withPublicCommerceTenant`/`requireCustomerSession`
 * already cover elsewhere) plus a pure, local presign call
 * (`media-r2-client.test.ts` covers the TTL-bounding property of that
 * directly) — this file is what proves the SECURITY-RELEVANT composition:
 * a customer only ever reaches a signed URL by holding an active
 * entitlement for the EXACT product the media object is linked to.
 *
 * Covers Issue #268's own acceptance criteria for this half:
 * - entitled customer + correctly-linked private object -> issuable;
 * - non-entitled customer -> denied, and the denial path never even
 *   constructs a URL (the route's `entitlement_required` branch returns
 *   before any R2 call);
 * - a link pointing at a PUBLIC (not private) object is refused
 *   (misconfiguration), never silently served;
 * - an entitlement for a DIFFERENT product does not unlock this one's link
 *   (entitlements are not fungible across products).
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
  verifyEntitlement
} from "../../src/modules/commerce/application/commerce-entitlement-directory";
import {
  fetchProtectedMediaLinkForProduct,
  setProtectedMediaLinkForProduct
} from "../../src/modules/commerce/application/protected-media-directory";
import {
  fetchNewsMediaObjectById,
  isMediaObjectDownloadable
} from "../../src/modules/media-library/application/media-object-directory";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT = "44444444-4444-4444-4444-444444444444";
const ACTOR = "55555555-5555-5555-5555-555555555555";
const NOW = new Date("2026-09-29T10:00:00.000Z");

function inTenant<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), TENANT, fn);
}

async function seedTenant(): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${TENANT}, 'protected-media-268', 'Protected Media 268', 'PM268 Legal',
            'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedCustomer(phone: string): Promise<string> {
  const rows = (await inTenant(
    (tx) => tx`
      INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
      VALUES (${TENANT}, 'Budi', ${phone})
      RETURNING id
    `
  )) as { id: string }[];
  return rows[0]!.id;
}

async function seedProduct(sku: string): Promise<string> {
  const rows = (await inTenant(
    (tx) => tx`
      INSERT INTO awcms_commerce_products
        (tenant_id, type, sku, name, slug, price, stock, status, min_purchase, weight_grams)
      VALUES
        (${TENANT}, 'digital_ebook', ${sku}, ${"Product " + sku}, ${sku.toLowerCase()},
         '25000.00', 100, 'active', 1, 0)
      RETURNING id
    `
  )) as { id: string }[];
  return rows[0]!.id;
}

async function seedPaidOrderAndGrant(
  customerId: string,
  productId: string
): Promise<void> {
  await inTenant(async (tx) => {
    const orderRows = (await tx`
      INSERT INTO awcms_commerce_orders
        (tenant_id, order_code, customer_id, status, payment_method, payment_status,
         shipping_method, subtotal, total, paid_at)
      VALUES
        (${TENANT}, ${"ORD-" + Math.random().toString(36).slice(2, 8)}, ${customerId},
         'paid', 'manual_qris', 'paid', 'self_pickup', '25000.00', '25000.00', ${NOW})
      RETURNING id
    `) as { id: string }[];
    const orderId = orderRows[0]!.id;

    await tx`
      INSERT INTO awcms_commerce_order_items
        (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
      VALUES
        (${TENANT}, ${orderId}, ${productId}, 'Item', '25000.00', 1, '25000.00')
    `;

    await grantEntitlementsForPaidOrder(tx, TENANT, orderId);
  });
}

async function seedMediaObject(
  label: string,
  visibility: "public" | "private",
  status: string = "verified"
): Promise<string> {
  const objectKey = `news-media/${TENANT}/2026/09/${crypto.randomUUID()}.pdf`;
  const publicUrl =
    visibility === "public" ? `https://cdn.example.test/${label}.pdf` : null;

  const rows = (await getAdminSql()`
    INSERT INTO awcms_news_media_objects
      (tenant_id, bucket_name, object_key, public_url, visibility, mime_type,
       status, created_by_tenant_user_id)
    VALUES (
      ${TENANT}, 'test-bucket', ${objectKey}, ${publicUrl}, ${visibility},
      'application/pdf', ${status}, ${ACTOR}
    )
    RETURNING id
  `) as { id: string }[];

  return rows[0]!.id;
}

/** The exact composition `download.ts`'s handler performs, once auth/blocked-account/malformed-id checks have already passed — this is the security-relevant part this file proves. */
async function resolveDownloadDecision(
  customerId: string,
  productId: string
): Promise<
  | { kind: "no_protected_content" }
  | { kind: "misconfigured" }
  | { kind: "entitlement_required" }
  | { kind: "issue"; mediaObjectId: string; objectKey: string }
> {
  return inTenant(async (tx) => {
    const link = await fetchProtectedMediaLinkForProduct(tx, TENANT, productId);
    if (!link) return { kind: "no_protected_content" };

    const media = await fetchNewsMediaObjectById(
      tx,
      TENANT,
      link.mediaObjectId
    );
    if (
      !media ||
      media.visibility !== "private" ||
      !isMediaObjectDownloadable(media.status)
    ) {
      return { kind: "misconfigured" };
    }

    const entitlement = await verifyEntitlement(
      tx,
      TENANT,
      customerId,
      productId
    );
    if (!entitlement) return { kind: "entitlement_required" };

    return {
      kind: "issue",
      mediaObjectId: media.id,
      objectKey: media.objectKey
    };
  });
}

suite("Issue #268 — protected media download composition", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  });

  afterAll(async () => {
    await teardownIntegrationDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant();
  });

  test("an entitled customer resolves to the linked PRIVATE media object", async () => {
    const customerId = await seedCustomer("+62811100001");
    const productId = await seedProduct("EBOOK-1");
    const mediaId = await seedMediaObject("premium-ebook", "private");

    await inTenant((tx) =>
      setProtectedMediaLinkForProduct(tx, TENANT, ACTOR, productId, mediaId)
    );
    await seedPaidOrderAndGrant(customerId, productId);

    const decision = await resolveDownloadDecision(customerId, productId);

    expect(decision.kind).toBe("issue");
    if (decision.kind === "issue") {
      expect(decision.mediaObjectId).toBe(mediaId);
    }
  });

  test("a customer with NO entitlement is denied — never issued a URL", async () => {
    const customerId = await seedCustomer("+62811100002");
    const productId = await seedProduct("EBOOK-2");
    const mediaId = await seedMediaObject("no-entitlement", "private");

    await inTenant((tx) =>
      setProtectedMediaLinkForProduct(tx, TENANT, ACTOR, productId, mediaId)
    );
    // Deliberately no `seedPaidOrderAndGrant` call — no entitlement exists.

    const decision = await resolveDownloadDecision(customerId, productId);

    expect(decision).toEqual({ kind: "entitlement_required" });
  });

  test("an entitlement for a DIFFERENT product does not unlock this one", async () => {
    const customerId = await seedCustomer("+62811100003");
    const productA = await seedProduct("EBOOK-A");
    const productB = await seedProduct("EBOOK-B");
    const mediaB = await seedMediaObject("product-b-ebook", "private");

    await inTenant((tx) =>
      setProtectedMediaLinkForProduct(tx, TENANT, ACTOR, productB, mediaB)
    );
    // Customer bought product A, not B.
    await seedPaidOrderAndGrant(customerId, productA);

    const decision = await resolveDownloadDecision(customerId, productB);

    expect(decision).toEqual({ kind: "entitlement_required" });
  });

  test("a product with no protected-media link answers no_protected_content", async () => {
    const customerId = await seedCustomer("+62811100004");
    const productId = await seedProduct("PHYSICAL-1");

    const decision = await resolveDownloadDecision(customerId, productId);

    expect(decision).toEqual({ kind: "no_protected_content" });
  });

  test("a link pointing at a PUBLIC object is refused (misconfiguration), never silently served", async () => {
    const customerId = await seedCustomer("+62811100005");
    const productId = await seedProduct("EBOOK-3");
    // Wrong on purpose: a public object should never be reachable through
    // this entitlement-gated path — FR-LIB-002's whole point is that
    // protected content has no permanent public URL in the first place.
    const publicMediaId = await seedMediaObject("wrongly-public", "public");

    await inTenant((tx) =>
      setProtectedMediaLinkForProduct(
        tx,
        TENANT,
        ACTOR,
        productId,
        publicMediaId
      )
    );
    await seedPaidOrderAndGrant(customerId, productId);

    const decision = await resolveDownloadDecision(customerId, productId);

    expect(decision).toEqual({ kind: "misconfigured" });
  });

  test("a link pointing at a not-yet-verified private object is refused (misconfiguration)", async () => {
    const customerId = await seedCustomer("+62811100006");
    const productId = await seedProduct("EBOOK-4");
    const pendingMediaId = await seedMediaObject(
      "still-uploading",
      "private",
      "pending_upload"
    );

    await inTenant((tx) =>
      setProtectedMediaLinkForProduct(
        tx,
        TENANT,
        ACTOR,
        productId,
        pendingMediaId
      )
    );
    await seedPaidOrderAndGrant(customerId, productId);

    const decision = await resolveDownloadDecision(customerId, productId);

    expect(decision).toEqual({ kind: "misconfigured" });
  });

  test("revoking the entitlement immediately denies the next request (no cache)", async () => {
    const customerId = await seedCustomer("+62811100007");
    const productId = await seedProduct("EBOOK-5");
    const mediaId = await seedMediaObject("revocable", "private");

    await inTenant((tx) =>
      setProtectedMediaLinkForProduct(tx, TENANT, ACTOR, productId, mediaId)
    );
    await seedPaidOrderAndGrant(customerId, productId);

    const before = await resolveDownloadDecision(customerId, productId);
    expect(before.kind).toBe("issue");

    await inTenant(
      (tx) => tx`
        UPDATE awcms_commerce_entitlements
        SET status = 'revoked', revoked_at = now()
        WHERE tenant_id = ${TENANT} AND owner_customer_id = ${customerId}
          AND product_id = ${productId}
      `
    );

    const after = await resolveDownloadDecision(customerId, productId);
    expect(after).toEqual({ kind: "entitlement_required" });
  });
});
