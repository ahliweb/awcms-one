/**
 * Double-submit safety of the remaining mutating storefront endpoints (Issue
 * #513, work unit C) against a REAL migrated PostgreSQL, through
 * `tests/integration/harness.ts` and the real runtime role (`awcms_app`,
 * subject to FORCE RLS). The application layer is driven directly (the routes
 * only map outcomes to HTTP; their shape is covered by the route unit tests).
 *
 * Every race runs on a dedicated pool (`createRuntimePool`) so the
 * transactions really are in flight at the same time.
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
import { findOrCreateCustomerByPhone } from "../../src/modules/commerce/application/customer-directory";
import { createAccountForCustomer } from "../../src/modules/commerce/application/customer-account-store";
import { createAccountAddress } from "../../src/modules/commerce/application/customer-account-resources";
import {
  openConversation,
  postCustomerMessage
} from "../../src/modules/commerce/application/conversation-directory";
import {
  cancelOrderByCustomer,
  createPaymentConfirmation,
  OrderNotCancellableError,
  OrderNotPayableError
} from "../../src/modules/commerce/application/order-directory";
import { createReview } from "../../src/modules/commerce/application/review-directory";
import {
  cancelOrderIdempotent,
  createAccountAddressIdempotent,
  createPaymentConfirmationIdempotent,
  createReviewIdempotent,
  openConversationIdempotent,
  postCustomerMessageIdempotent
} from "../../src/modules/commerce/application/storefront-idempotent-mutations";
import { STOREFRONT_IDEMPOTENCY_SCOPES } from "../../src/modules/commerce/domain/storefront-idempotency";
import { mediaLibraryPortAdapter } from "../../src/modules/media-library/application/media-library-port-adapter";
import type { AccountAddressInput } from "../../src/modules/commerce/domain/address-validation";
import {
  createRuntimePool,
  getAdminSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const PHONE = "+6281200000777";
const OTHER_PHONE = "+6281200000888";
const KEY = "attempt-0123456789abcdef-A";
const KEY_2 = "attempt-0123456789abcdef-B";

let pool: Bun.SQL;

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
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(pool, tenantId, fn);
}

type Shopper = { accountId: string; customerId: string; phone: string };

async function seedShopper(
  tenantId = TENANT_A,
  phone = PHONE
): Promise<Shopper> {
  return inTenant(tenantId, async (tx) => {
    const customer = await findOrCreateCustomerByPhone(
      tx,
      tenantId,
      "Siti",
      phone,
      null
    );
    const account = await createAccountForCustomer(tx, tenantId, {
      name: "Siti",
      phone,
      emailNormalized: `${phone.replace(/\D/g, "")}@example.test`
    });
    return { accountId: account.id, customerId: customer.id, phone };
  });
}

function addressInput(
  overrides: Partial<AccountAddressInput> = {}
): AccountAddressInput {
  return {
    label: "Rumah",
    recipientName: "Budi Santoso",
    phone: "+6281234567890",
    provinceCode: "62",
    provinceName: "Kalimantan Tengah",
    cityCode: "6202",
    cityName: "Kotawaringin Timur",
    districtCode: "620201",
    districtName: "Baamang",
    postalCode: "74311",
    street: "Jl. Jenderal Sudirman No. 1",
    latitude: null,
    longitude: null,
    notes: null,
    ...overrides
  };
}

async function seedOrder(
  tenantId: string,
  customerId: string,
  orderCode: string,
  status: "pending_payment" | "completed"
): Promise<string> {
  const rows = (await inTenant(
    tenantId,
    (tx) =>
      tx`
        INSERT INTO awcms_commerce_orders (
          tenant_id, order_code, customer_id, status, payment_method, payment_status,
          shipping_method, shipping_cost, subtotal, discount, voucher_discount,
          insurance_fee, tax, total
        )
        VALUES (
          ${tenantId}, ${orderCode}, ${customerId}, ${status}, 'manual_qris', 'unpaid',
          'self_pickup', '0.00', '10000.00', '0.00', '0.00', '0.00', '0.00', '10000.00'
        )
        RETURNING id
      `
  )) as { id: string }[];
  return rows[0]!.id;
}

async function seedProductInOrder(
  tenantId: string,
  orderId: string
): Promise<string> {
  const admin = getAdminSql();
  const product = (await admin`
    INSERT INTO awcms_commerce_products (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${tenantId}, 'physical', ${"SKU-" + orderId.slice(0, 8)}, 'Mie', ${"mie-" + orderId.slice(0, 8)}, '10000.00', 10, 'active')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_commerce_order_items (tenant_id, order_id, product_id, name, unit_price, quantity, line_total)
    VALUES (${tenantId}, ${orderId}, ${product[0]!.id}, 'Mie', '10000.00', 1, '10000.00')
  `;
  return product[0]!.id;
}

async function count(sqlText: string, tenantId = TENANT_A): Promise<number> {
  const rows = await getAdminSql().unsafe(sqlText, [tenantId]);
  return Number((rows[0] as { n: number | string }).n);
}

const nAddresses = () =>
  count(
    "SELECT count(*)::int AS n FROM awcms_commerce_customer_addresses WHERE tenant_id = $1"
  );
const nConversations = () =>
  count(
    "SELECT count(*)::int AS n FROM awcms_commerce_conversations WHERE tenant_id = $1"
  );
const nMessages = () =>
  count(
    "SELECT count(*)::int AS n FROM awcms_commerce_messages WHERE tenant_id = $1"
  );
const nConfirmations = () =>
  count(
    "SELECT count(*)::int AS n FROM awcms_commerce_payment_confirmations WHERE tenant_id = $1"
  );
const nReviews = () =>
  count(
    "SELECT count(*)::int AS n FROM awcms_commerce_reviews WHERE tenant_id = $1"
  );
const nOrderEvents = (to: string) =>
  count(
    `SELECT count(*)::int AS n FROM awcms_commerce_order_events WHERE tenant_id = $1 AND to_status = '${to}'`
  );

const PAYMENT = {
  method: "manual_qris" as const,
  amount: "10000.00",
  bankName: null,
  accountName: null,
  transferredAt: null,
  proofMediaObjectId: null
};

const nAudits = (action: string) =>
  count(
    `SELECT count(*)::int AS n FROM awcms_audit_events WHERE tenant_id = $1 AND action = '${action}'`
  );
const nRecords = (scope: string, tenantId = TENANT_A) =>
  count(
    `SELECT count(*)::int AS n FROM awcms_idempotency_keys WHERE tenant_id = $1 AND request_scope = '${scope}'`,
    tenantId
  );

const REPLAY_ACTION = "commerce.storefront.idempotency_replayed";
const OPT = (key: string | null) => ({ key });

function cancelKeyed(
  code: string,
  phone: string,
  key: string | null,
  reason: string | null = null,
  tenantId = TENANT_A
) {
  return inTenant(tenantId, (tx) =>
    cancelOrderIdempotent(
      tx,
      tenantId,
      mediaLibraryPortAdapter,
      code,
      phone,
      reason,
      OPT(key)
    )
  );
}

function payKeyed(
  code: string,
  phone: string,
  key: string | null,
  amount = "10000.00"
) {
  return inTenant(TENANT_A, (tx) =>
    createPaymentConfirmationIdempotent(
      tx,
      TENANT_A,
      mediaLibraryPortAdapter,
      code,
      phone,
      { ...PAYMENT, amount },
      OPT(key)
    )
  );
}

function addressKeyed(
  s: Shopper,
  key: string | null,
  overrides: Partial<AccountAddressInput> = {},
  tenantId = TENANT_A
) {
  return inTenant(tenantId, (tx) =>
    createAccountAddressIdempotent(
      tx,
      tenantId,
      { id: s.accountId, customerId: s.customerId },
      addressInput(overrides),
      OPT(key)
    )
  );
}

function reviewKeyed(
  s: Shopper,
  productId: string,
  key: string | null,
  overrides: {
    rating?: number;
    body?: string;
    orderCode?: string;
    phone?: string;
  } = {},
  accountCustomerId?: string
) {
  return inTenant(TENANT_A, (tx) =>
    createReviewIdempotent(
      tx,
      TENANT_A,
      {
        orderCode: overrides.orderCode ?? "ORD-REV",
        phone: overrides.phone ?? s.phone,
        productId,
        rating: overrides.rating ?? 5,
        body: overrides.body ?? "Mantap"
      },
      accountCustomerId,
      OPT(key)
    )
  );
}

suite("commerce storefront idempotency (Issue #513, unit C)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
    pool = createRuntimePool(10);
  }, 120000);

  afterAll(async () => {
    await pool.close();
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-a");
    await seedTenant(TENANT_B, "tenant-b");
  }, 30000);

  // -------------------------------------------------------------------------
  // Without a key: what the routes did on the unmodified code, and what they do
  // now. Documented in docs/api.md.
  // -------------------------------------------------------------------------
  describe("without a key", () => {
    test("address: two concurrent creates both succeed (one default), no raw unique violation", async () => {
      const s = await seedShopper();
      const results = await Promise.all([
        inTenant(TENANT_A, (tx) =>
          createAccountAddress(tx, TENANT_A, s.customerId, addressInput())
        ),
        inTenant(TENANT_A, (tx) =>
          createAccountAddress(tx, TENANT_A, s.customerId, addressInput())
        )
      ]);
      expect(results.map((r) => r.kind)).toEqual(["created", "created"]);
      expect(await nAddresses()).toBe(2);
      expect(
        await count(
          "SELECT count(*)::int AS n FROM awcms_commerce_customer_addresses WHERE tenant_id = $1 AND is_default"
        )
      ).toBe(1);
    });

    test("address, conversation, message, payment confirmation: a repeat WITHOUT a key creates a second record (needs a key)", async () => {
      const s = await seedShopper();
      await inTenant(TENANT_A, (tx) =>
        createAccountAddress(tx, TENANT_A, s.customerId, addressInput())
      );
      await inTenant(TENANT_A, (tx) =>
        createAccountAddress(tx, TENANT_A, s.customerId, addressInput())
      );
      expect(await nAddresses()).toBe(2);

      const input = { subject: "Halo", body: "Pesan pertama saya." };
      await inTenant(TENANT_A, (tx) =>
        openConversation(tx, TENANT_A, s.accountId, input)
      );
      const second = await inTenant(TENANT_A, (tx) =>
        openConversation(tx, TENANT_A, s.accountId, input)
      );
      expect(await nConversations()).toBe(2);

      await Promise.all([
        inTenant(TENANT_A, (tx) =>
          postCustomerMessage(
            tx,
            TENANT_A,
            s.accountId,
            second.conversation.id,
            "Ulang"
          )
        ),
        inTenant(TENANT_A, (tx) =>
          postCustomerMessage(
            tx,
            TENANT_A,
            s.accountId,
            second.conversation.id,
            "Ulang"
          )
        )
      ]);
      expect(await nMessages()).toBe(4);

      await seedOrder(TENANT_A, s.customerId, "ORD-PAY", "pending_payment");
      const submit = () =>
        inTenant(TENANT_A, (tx) =>
          createPaymentConfirmation(
            tx,
            TENANT_A,
            mediaLibraryPortAdapter,
            "ORD-PAY",
            s.phone,
            PAYMENT
          )
        );
      await submit();
      await Promise.all([submit(), submit()]);
      expect(await nConfirmations()).toBe(3);
    });

    test("cancel: a repeat on an already-cancelled order answers success, not 409, and writes nothing twice", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-C1", "pending_payment");
      const cancel = () =>
        inTenant(TENANT_A, (tx) =>
          cancelOrderByCustomer(
            tx,
            TENANT_A,
            mediaLibraryPortAdapter,
            "ORD-C1",
            s.phone,
            null
          )
        );
      const first = await cancel();
      const second = await cancel();
      expect(first?.status).toBe("cancelled");
      expect(second?.status).toBe("cancelled");
      expect(await nOrderEvents("cancelled")).toBe(1);
    });

    test("cancel: two concurrent cancels run ONE transition (one event, one audit row)", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-C2", "pending_payment");
      const cancel = () =>
        inTenant(TENANT_A, (tx) =>
          cancelOrderByCustomer(
            tx,
            TENANT_A,
            mediaLibraryPortAdapter,
            "ORD-C2",
            s.phone,
            null
          )
        );
      const both = await Promise.all([cancel(), cancel()]);
      expect(both.map((o) => o?.status)).toEqual(["cancelled", "cancelled"]);
      expect(await nOrderEvents("cancelled")).toBe(1);
      expect(
        await count(
          "SELECT count(*)::int AS n FROM awcms_audit_events WHERE tenant_id = $1 AND message LIKE 'Order ORD-C2 moved%'"
        )
      ).toBe(1);
    });

    test("cancel: a state the customer may not cancel from keeps its refusal; a wrong phone stays a neutral not-found", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-DONE", "completed");
      await expect(
        inTenant(TENANT_A, (tx) =>
          cancelOrderByCustomer(
            tx,
            TENANT_A,
            mediaLibraryPortAdapter,
            "ORD-DONE",
            s.phone,
            null
          )
        )
      ).rejects.toBeInstanceOf(OrderNotCancellableError);

      await seedOrder(TENANT_A, s.customerId, "ORD-C3", "pending_payment");
      const wrong = await inTenant(TENANT_A, (tx) =>
        cancelOrderByCustomer(
          tx,
          TENANT_A,
          mediaLibraryPortAdapter,
          "ORD-C3",
          OTHER_PHONE,
          null
        )
      );
      expect(wrong).toBeNull();
      expect(await nOrderEvents("cancelled")).toBe(0);
    });

    test("review: the unique index stays the guard (no duplicate row); a repeat is the unchanged REVIEW_NOT_ALLOWED reason", async () => {
      const s = await seedShopper();
      const orderId = await seedOrder(
        TENANT_A,
        s.customerId,
        "ORD-REV",
        "completed"
      );
      const productId = await seedProductInOrder(TENANT_A, orderId);
      const review = () =>
        inTenant(TENANT_A, (tx) =>
          createReview(tx, TENANT_A, "ORD-REV", s.phone, productId, 5, "Mantap")
        );
      const first = await review();
      const second = await review();
      expect(first.kind).toBe("created");
      expect(second).toEqual({
        kind: "not_allowed",
        reason: "already_reviewed"
      });
      expect(await nReviews()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // POST account/addresses
  // -------------------------------------------------------------------------
  describe("account/addresses with a key", () => {
    test("serial retry replays the original address; one row, one record, one replay audit row, no key stored", async () => {
      const s = await seedShopper();
      const first = await addressKeyed(s, KEY);
      const second = await addressKeyed(s, KEY);
      if (first.kind !== "created" || second.kind !== "created") {
        throw new Error("expected created");
      }
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.address.id).toBe(first.address.id);
      expect(await nAddresses()).toBe(1);
      expect(
        await nRecords(STOREFRONT_IDEMPOTENCY_SCOPES.accountAddressCreate)
      ).toBe(1);
      expect(await nAudits(REPLAY_ACTION)).toBe(1);

      const rows = (await getAdminSql()`
        SELECT idempotency_key, request_hash, actor_key, response_status, response_body
        FROM awcms_idempotency_keys WHERE tenant_id = ${TENANT_A}
      `) as {
        idempotency_key: string;
        request_hash: string;
        actor_key: string;
        response_status: number;
        response_body: unknown;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.idempotency_key).not.toContain(KEY);
      expect(rows[0]!.idempotency_key).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.request_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.response_status).toBe(201);
      const everything =
        JSON.stringify(rows) +
        JSON.stringify(
          await getAdminSql()`SELECT attributes, message FROM awcms_audit_events WHERE tenant_id = ${TENANT_A}`
        );
      expect(everything).not.toContain(KEY);
      expect(everything.toLowerCase()).not.toContain("token");
    });

    test("two concurrent requests with the same key create ONE address", async () => {
      const s = await seedShopper();
      const both = await Promise.all([
        addressKeyed(s, KEY),
        addressKeyed(s, KEY)
      ]);
      expect(both.map((o) => o.kind)).toEqual(["created", "created"]);
      expect(
        both.map((o) => (o.kind === "created" ? o.replayed : null)).sort()
      ).toEqual([false, true]);
      expect(await nAddresses()).toBe(1);
      expect(await nAudits(REPLAY_ACTION)).toBe(1);
    });

    test("same key, different address is a conflict and creates nothing", async () => {
      const s = await seedShopper();
      await addressKeyed(s, KEY);
      const other = await addressKeyed(s, KEY, { street: "Jl. Lain No. 9" });
      expect(other.kind).toBe("idempotency_conflict");
      expect(await nAddresses()).toBe(1);
    });

    test("a refusal (limit reached) is not recorded, so the key is not burnt", async () => {
      const s = await seedShopper();
      for (let i = 0; i < 10; i += 1) {
        await addressKeyed(s, null, { street: `Jl. ${i}` });
      }
      expect((await addressKeyed(s, KEY)).kind).toBe("limit_reached");
      expect(
        await nRecords(STOREFRONT_IDEMPOTENCY_SCOPES.accountAddressCreate)
      ).toBe(0);
    });

    test("a key is per account (another account's identical key and body is its own request) and per tenant", async () => {
      const a = await seedShopper(TENANT_A, PHONE);
      const b = await seedShopper(TENANT_A, OTHER_PHONE);
      const t = await seedShopper(TENANT_B, PHONE);
      const [ra, rb, rt] = await Promise.all([
        addressKeyed(a, KEY),
        addressKeyed(b, KEY),
        addressKeyed(t, KEY, {}, TENANT_B)
      ]);
      for (const r of [ra, rb, rt]) {
        expect(r.kind === "created" && r.replayed === false).toBe(true);
      }
      expect(await nAddresses()).toBe(2);
      expect(
        await count(
          "SELECT count(*)::int AS n FROM awcms_commerce_customer_addresses WHERE tenant_id = $1",
          TENANT_B
        )
      ).toBe(1);
      expect(
        await nRecords(
          STOREFRONT_IDEMPOTENCY_SCOPES.accountAddressCreate,
          TENANT_B
        )
      ).toBe(1);
      // Tenant B cannot see tenant A's records under its own RLS context.
      const seen = (await inTenant(
        TENANT_B,
        (tx) =>
          tx`SELECT count(*)::int AS n FROM awcms_idempotency_keys WHERE tenant_id = ${TENANT_A}`
      )) as { n: number }[];
      expect(seen[0]!.n).toBe(0);
    });

    test("a record older than the replay window is ignored (ordinary request) and never overwritten", async () => {
      const s = await seedShopper();
      await addressKeyed(s, KEY);
      await getAdminSql()`
        UPDATE awcms_idempotency_keys SET created_at = now() - interval '2 hours'
        WHERE tenant_id = ${TENANT_A}
      `;
      const again = await addressKeyed(s, KEY);
      expect(again.kind === "created" && again.replayed === false).toBe(true);
      expect(await nAddresses()).toBe(2);
      expect(
        await nRecords(STOREFRONT_IDEMPOTENCY_SCOPES.accountAddressCreate)
      ).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // POST account/conversations and .../messages
  // -------------------------------------------------------------------------
  describe("account/conversations and messages with a key", () => {
    function openKeyed(
      s: Shopper,
      key: string | null,
      input = { subject: "Halo", body: "Pesan pertama saya." },
      admit?: () => Promise<{ retryAfterSec: number } | null>
    ) {
      return inTenant(TENANT_A, (tx) =>
        openConversationIdempotent(tx, TENANT_A, s.accountId, input, {
          key,
          admit
        })
      );
    }

    function postKeyed(
      s: Shopper,
      conversationId: string,
      key: string | null,
      body = "Ulang",
      admit?: () => Promise<{ retryAfterSec: number } | null>
    ) {
      return inTenant(TENANT_A, (tx) =>
        postCustomerMessageIdempotent(
          tx,
          TENANT_A,
          s.accountId,
          conversationId,
          body,
          { key, admit }
        )
      );
    }

    test("conversation: concurrent same key opens ONE thread with ONE message; the replay does not spend the post limit", async () => {
      const s = await seedShopper();
      let admitted = 0;
      const admit = async () => {
        admitted += 1;
        return null;
      };
      const both = await Promise.all([
        openKeyed(s, KEY, undefined, admit),
        openKeyed(s, KEY, undefined, admit)
      ]);
      const created = both.map((o) => {
        if (o.kind !== "created") throw new Error("expected created");
        return o;
      });
      expect(created.map((o) => o.replayed).sort()).toEqual([false, true]);
      expect(created[0]!.result.conversation.id).toBe(
        created[1]!.result.conversation.id
      );
      expect(await nConversations()).toBe(1);
      expect(await nMessages()).toBe(1);
      expect(admitted).toBe(1);
      expect(await nAudits(REPLAY_ACTION)).toBe(1);
    });

    test("conversation: a different subject under the same key is a conflict; a refused post is not recorded", async () => {
      const s = await seedShopper();
      const refused = await openKeyed(s, KEY, undefined, async () => ({
        retryAfterSec: 30
      }));
      expect(refused).toEqual({ kind: "rate_limited", retryAfterSec: 30 });
      expect(await nConversations()).toBe(0);

      const first = await openKeyed(s, KEY);
      expect(first.kind).toBe("created");
      const conflict = await openKeyed(s, KEY, {
        subject: "Lain",
        body: "Pesan pertama saya."
      });
      expect(conflict.kind).toBe("idempotency_conflict");
      expect(await nConversations()).toBe(1);
    });

    test("message: serial and concurrent same key post ONE message; another conversation or text under the key is a conflict", async () => {
      const s = await seedShopper();
      const one = await openKeyed(s, null);
      const two = await openKeyed(s, null, {
        subject: "Dua",
        body: "Pesan pertama kedua."
      });
      if (one.kind !== "created" || two.kind !== "created") throw new Error();
      const c1 = one.result.conversation.id;
      const c2 = two.result.conversation.id;
      const before = await nMessages();

      const first = await postKeyed(s, c1, KEY);
      const retry = await postKeyed(s, c1, KEY);
      if (first.kind !== "posted" || retry.kind !== "posted") throw new Error();
      expect(first.replayed).toBe(false);
      expect(retry.replayed).toBe(true);
      expect(retry.message.id).toBe(first.message.id);
      expect(await nMessages()).toBe(before + 1);

      const raced = await Promise.all([
        postKeyed(s, c1, KEY_2, "Balap"),
        postKeyed(s, c1, KEY_2, "Balap")
      ]);
      expect(raced.map((o) => o.kind)).toEqual(["posted", "posted"]);
      expect(await nMessages()).toBe(before + 2);

      // The same key for ANOTHER conversation (or text) never replays or posts.
      expect((await postKeyed(s, c2, KEY)).kind).toBe("idempotency_conflict");
      expect((await postKeyed(s, c1, KEY, "Beda")).kind).toBe(
        "idempotency_conflict"
      );
      expect(await nMessages()).toBe(before + 2);
    });

    test("message: not-found and closed are answered as before and not recorded", async () => {
      const s = await seedShopper();
      const other = await seedShopper(TENANT_A, OTHER_PHONE);
      const opened = await openKeyed(s, null);
      if (opened.kind !== "created") throw new Error();
      const id = opened.result.conversation.id;

      // Another account's conversation: neutral not-found.
      expect(
        (
          await inTenant(TENANT_A, (tx) =>
            postCustomerMessageIdempotent(
              tx,
              TENANT_A,
              other.accountId,
              id,
              "Intip",
              OPT(KEY)
            )
          )
        ).kind
      ).toBe("not_found");

      await getAdminSql()`
        UPDATE awcms_commerce_conversations SET status = 'closed' WHERE id = ${id}
      `;
      expect((await postKeyed(s, id, KEY)).kind).toBe("closed");
      expect(
        await nRecords(STOREFRONT_IDEMPOTENCY_SCOPES.accountMessagePost)
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST orders/{code}/payment-confirmations
  // -------------------------------------------------------------------------
  describe("payment-confirmations with a key", () => {
    test("serial + concurrent same key record ONE confirmation; the replay answers the order as it is now", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-PAY", "pending_payment");

      const first = await payKeyed("ORD-PAY", s.phone, KEY);
      const retry = await payKeyed("ORD-PAY", s.phone, KEY);
      if (first.kind !== "done" || retry.kind !== "done") throw new Error();
      expect(first.replayed).toBe(false);
      expect(retry.replayed).toBe(true);
      expect(retry.order.orderCode).toBe("ORD-PAY");
      expect(await nConfirmations()).toBe(1);

      const raced = await Promise.all([
        payKeyed("ORD-PAY", s.phone, KEY_2, "9000.00"),
        payKeyed("ORD-PAY", s.phone, KEY_2, "9000.00")
      ]);
      expect(raced.map((o) => o.kind)).toEqual(["done", "done"]);
      expect(await nConfirmations()).toBe(2);
      expect(await nAudits(REPLAY_ACTION)).toBe(2);

      // The record is a marker: no order data, no phone, no key.
      const rows = (await getAdminSql()`
        SELECT idempotency_key, response_body FROM awcms_idempotency_keys
        WHERE tenant_id = ${TENANT_A}
      `) as { idempotency_key: string; response_body: unknown }[];
      for (const row of rows) {
        expect(row.response_body).toEqual({ outcome: "submitted" });
        expect(row.idempotency_key).not.toContain(KEY);
      }
    });

    test("the key cannot be replayed against another order, another phone or another amount (conflict, nothing recorded)", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-PAY", "pending_payment");
      await seedOrder(TENANT_A, s.customerId, "ORD-PAY-2", "pending_payment");
      await payKeyed("ORD-PAY", s.phone, KEY);

      expect((await payKeyed("ORD-PAY-2", s.phone, KEY)).kind).toBe(
        "idempotency_conflict"
      );
      // Someone who knows the key but not the phone: a conflict, never the
      // stored answer (and never an order record).
      expect((await payKeyed("ORD-PAY", OTHER_PHONE, KEY)).kind).toBe(
        "idempotency_conflict"
      );
      expect((await payKeyed("ORD-PAY", s.phone, KEY, "1.00")).kind).toBe(
        "idempotency_conflict"
      );
      expect(await nConfirmations()).toBe(1);
      expect(await nAudits(REPLAY_ACTION)).toBe(0);
    });

    test("an order that is not payable is refused as before and nothing is recorded", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-DONE", "completed");
      await expect(payKeyed("ORD-DONE", s.phone, KEY)).rejects.toBeInstanceOf(
        OrderNotPayableError
      );
      expect(
        await nRecords(STOREFRONT_IDEMPOTENCY_SCOPES.paymentConfirmationCreate)
      ).toBe(0);
      expect((await payKeyed("ORD-NOPE", s.phone, KEY)).kind).toBe("not_found");
    });

    test("a key is per tenant", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-PAY", "pending_payment");
      await payKeyed("ORD-PAY", s.phone, KEY);
      // Tenant B has no such order: the same key + body is its own (not-found)
      // request there, never tenant A's stored answer.
      const inB = await inTenant(TENANT_B, (tx) =>
        createPaymentConfirmationIdempotent(
          tx,
          TENANT_B,
          mediaLibraryPortAdapter,
          "ORD-PAY",
          s.phone,
          PAYMENT,
          OPT(KEY)
        )
      );
      expect(inB.kind).toBe("not_found");
    });
  });

  // -------------------------------------------------------------------------
  // POST orders/{code}/cancel
  // -------------------------------------------------------------------------
  describe("cancel with a key", () => {
    test("serial + concurrent same key cancel once; the replay answers the cancelled order", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-C1", "pending_payment");
      await seedOrder(TENANT_A, s.customerId, "ORD-C2", "pending_payment");

      const first = await cancelKeyed("ORD-C1", s.phone, KEY);
      const retry = await cancelKeyed("ORD-C1", s.phone, KEY);
      if (first.kind !== "done" || retry.kind !== "done") throw new Error();
      expect(first.replayed).toBe(false);
      expect(retry.replayed).toBe(true);
      expect(retry.order.status).toBe("cancelled");

      const raced = await Promise.all([
        cancelKeyed("ORD-C2", s.phone, KEY_2),
        cancelKeyed("ORD-C2", s.phone, KEY_2)
      ]);
      expect(raced.map((o) => o.kind)).toEqual(["done", "done"]);
      expect(await nOrderEvents("cancelled")).toBe(2);
      expect(await nAudits(REPLAY_ACTION)).toBe(2);
    });

    test("a fresh key on an already-cancelled order is a success too (natural idempotency), with no second event", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-C1", "pending_payment");
      await cancelKeyed("ORD-C1", s.phone, KEY);
      const again = await cancelKeyed("ORD-C1", s.phone, KEY_2);
      expect(again.kind === "done" && again.order.status === "cancelled").toBe(
        true
      );
      expect(await nOrderEvents("cancelled")).toBe(1);
    });

    test("the key cannot be replayed against another order, another phone or another reason", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-C1", "pending_payment");
      await seedOrder(TENANT_A, s.customerId, "ORD-C2", "pending_payment");
      await cancelKeyed("ORD-C1", s.phone, KEY, "salah pesan");

      expect(
        (await cancelKeyed("ORD-C2", s.phone, KEY, "salah pesan")).kind
      ).toBe("idempotency_conflict");
      expect(
        (await cancelKeyed("ORD-C1", OTHER_PHONE, KEY, "salah pesan")).kind
      ).toBe("idempotency_conflict");
      expect((await cancelKeyed("ORD-C1", s.phone, KEY, "lain")).kind).toBe(
        "idempotency_conflict"
      );
      expect(await nOrderEvents("cancelled")).toBe(1);
      expect(await nAudits(REPLAY_ACTION)).toBe(0);
    });

    test("a refusal (not cancellable) and a wrong phone are answered as before and not recorded", async () => {
      const s = await seedShopper();
      await seedOrder(TENANT_A, s.customerId, "ORD-DONE", "completed");
      await expect(
        cancelKeyed("ORD-DONE", s.phone, KEY)
      ).rejects.toBeInstanceOf(OrderNotCancellableError);
      await seedOrder(TENANT_A, s.customerId, "ORD-C1", "pending_payment");
      expect((await cancelKeyed("ORD-C1", OTHER_PHONE, KEY_2)).kind).toBe(
        "not_found"
      );
      expect(await nRecords(STOREFRONT_IDEMPOTENCY_SCOPES.orderCancel)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST reviews
  // -------------------------------------------------------------------------
  describe("reviews with a key", () => {
    async function seedReviewable(s: Shopper): Promise<string> {
      const orderId = await seedOrder(
        TENANT_A,
        s.customerId,
        "ORD-REV",
        "completed"
      );
      return seedProductInOrder(TENANT_A, orderId);
    }

    test("a retry replays the 201 with the same review id instead of REVIEW_NOT_ALLOWED; concurrent keyed requests create one", async () => {
      const s = await seedShopper();
      const productId = await seedReviewable(s);

      const first = await reviewKeyed(s, productId, KEY);
      const retry = await reviewKeyed(s, productId, KEY);
      if (first.kind !== "created" || retry.kind !== "created")
        throw new Error();
      expect(first.replayed).toBe(false);
      expect(retry.replayed).toBe(true);
      expect(retry.id).toBe(first.id);
      expect(await nReviews()).toBe(1);

      // The same review without a key is still the unchanged refusal.
      expect(await reviewKeyed(s, productId, null)).toEqual({
        kind: "not_allowed",
        reason: "already_reviewed"
      });
    });

    test("concurrent same-key reviews create one review", async () => {
      const s = await seedShopper();
      const productId = await seedReviewable(s);
      const both = await Promise.all([
        reviewKeyed(s, productId, KEY),
        reviewKeyed(s, productId, KEY)
      ]);
      expect(both.map((o) => o.kind)).toEqual(["created", "created"]);
      expect(await nReviews()).toBe(1);
      expect(await nAudits(REPLAY_ACTION)).toBe(1);
    });

    test("the key cannot be replayed with another text, rating, order or phone", async () => {
      const s = await seedShopper();
      const productId = await seedReviewable(s);
      await reviewKeyed(s, productId, KEY);

      for (const override of [
        { body: "Lain" },
        { rating: 1 },
        { orderCode: "ORD-OTHER" },
        { phone: OTHER_PHONE }
      ]) {
        expect((await reviewKeyed(s, productId, KEY, override)).kind).toBe(
          "idempotency_conflict"
        );
      }
      expect(await nReviews()).toBe(1);
    });

    test("a refusal (order not completed) and a neutral not-found are not recorded", async () => {
      const s = await seedShopper();
      const orderId = await seedOrder(
        TENANT_A,
        s.customerId,
        "ORD-REV",
        "pending_payment"
      );
      const productId = await seedProductInOrder(TENANT_A, orderId);
      expect((await reviewKeyed(s, productId, KEY)).kind).toBe("not_allowed");
      expect(
        (await reviewKeyed(s, productId, KEY, { phone: OTHER_PHONE })).kind
      ).toBe("not_found");
      expect(await nRecords(STOREFRONT_IDEMPOTENCY_SCOPES.reviewCreate)).toBe(
        0
      );
    });

    test("a signed-in shopper's key lives in their own namespace", async () => {
      const s = await seedShopper();
      const productId = await seedReviewable(s);
      const guest = await reviewKeyed(s, productId, KEY);
      expect(guest.kind).toBe("created");
      // The same key string from the account's bearer session is a different
      // request namespace: not a replay of the guest's record. (The review
      // itself is the unchanged already-reviewed refusal.)
      const signedIn = await reviewKeyed(s, productId, KEY, {}, s.customerId);
      expect(signedIn).toEqual({
        kind: "not_allowed",
        reason: "already_reviewed"
      });
      expect(await nAudits(REPLAY_ACTION)).toBe(0);
    });
  });

  test("a normal request writes no replay audit row and exactly one record per keyed success", async () => {
    const s = await seedShopper();
    await addressKeyed(s, KEY);
    await addressKeyed(s, null);
    expect(await nAudits(REPLAY_ACTION)).toBe(0);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM awcms_idempotency_keys WHERE tenant_id = $1"
      )
    ).toBe(1);
  });
});
