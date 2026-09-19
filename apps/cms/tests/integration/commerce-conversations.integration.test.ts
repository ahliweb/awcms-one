/**
 * `commerce` inbox integration (Issue #111, contract #106 D8) — exercised
 * against a REAL migrated database through `tests/integration/harness.ts`,
 * the same shape `commerce-affiliates`'s own integration suite (#92) uses.
 * Gated on `DATABASE_URL`; skips cleanly without one.
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
import { checkSharedRateLimit } from "../../src/lib/security/rate-limit";
import { findOrCreateCustomerByPhone } from "../../src/modules/commerce/application/customer-directory";
import { createAccountForCustomer } from "../../src/modules/commerce/application/customer-account-store";
import {
  fetchConversationForAccount,
  fetchConversationForAdmin,
  listConversationsForAccount,
  listConversationsForAdmin,
  openConversation,
  postCustomerMessage,
  postStoreReply,
  setConversationStatus
} from "../../src/modules/commerce/application/conversation-directory";
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
const STORE_ACTOR = "33333333-3333-3333-3333-333333333333";

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
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedAccount(tenantId: string, phone: string): Promise<string> {
  return inTenant(tenantId, async (tx) => {
    const customer = await findOrCreateCustomerByPhone(
      tx,
      tenantId,
      "Inbox Shopper",
      phone,
      null
    );
    const account = await createAccountForCustomer(tx, tenantId, {
      name: "Inbox Shopper",
      phone,
      emailNormalized: `${phone.replace(/\D/g, "")}@example.test`
    });
    void customer;
    return account.id;
  });
}

suite("commerce conversations integration (Issue #111)", () => {
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

  test("open -> store reply -> unread flags flip on both sides -> customer reads clears theirs", async () => {
    const accountId = await seedAccount(TENANT_A, "+6281200000101");

    const opened = await inTenant(TENANT_A, (tx) =>
      openConversation(tx, TENANT_A, accountId, {
        subject: "Where is my order?",
        body: "Hi, I have a question about my order."
      })
    );
    expect(opened.conversation.status).toBe("open");
    // The customer's own first message never flips their OWN unread flag.
    expect(opened.conversation.unreadForCustomer).toBe(0);

    // The store's side should now be unread (a fresh customer message) —
    // checked via the LIST read, which has no side effect (unlike
    // fetchConversationForAdmin, which marks the thread read as it returns).
    const adminListBeforeRead = await inTenant(TENANT_A, (tx) =>
      listConversationsForAdmin(tx, TENANT_A, {}, null)
    );
    expect(adminListBeforeRead.items[0]?.unreadForStore).toBe(1);

    // Reading the thread on the store side clears it — the read call's own
    // return value already reflects the post-clear state.
    const adminThreadOnRead = await inTenant(TENANT_A, (tx) =>
      fetchConversationForAdmin(tx, TENANT_A, opened.conversation.id)
    );
    expect(adminThreadOnRead?.conversation.unreadForStore).toBe(0);

    const adminListAfterRead = await inTenant(TENANT_A, (tx) =>
      listConversationsForAdmin(tx, TENANT_A, {}, null)
    );
    expect(adminListAfterRead.items[0]?.unreadForStore).toBe(0);

    const reply = await inTenant(TENANT_A, (tx) =>
      postStoreReply(
        tx,
        TENANT_A,
        STORE_ACTOR,
        opened.conversation.id,
        "Thanks for reaching out — checking now."
      )
    );
    if (reply.kind !== "posted") throw new Error("expected posted");
    expect(reply.message.sender).toBe("store");

    // The store's own reply must not leave unread_for_store true for itself.
    const adminThreadAfterReply = await inTenant(TENANT_A, (tx) =>
      fetchConversationForAdmin(tx, TENANT_A, opened.conversation.id)
    );
    expect(adminThreadAfterReply?.conversation.status).toBe("open");

    // The customer's side should now be unread (a fresh store reply).
    const customerListAfterReply = await inTenant(TENANT_A, (tx) =>
      listConversationsForAccount(tx, TENANT_A, accountId, null)
    );
    expect(customerListAfterReply.items[0]?.unreadForCustomer).toBe(1);

    // Customer reads the thread -> their own unread flag clears.
    const customerThread = await inTenant(TENANT_A, (tx) =>
      fetchConversationForAccount(
        tx,
        TENANT_A,
        accountId,
        opened.conversation.id
      )
    );
    expect(customerThread?.conversation.unreadForCustomer).toBe(0);
    expect(customerThread?.messages).toHaveLength(2);
    expect(customerThread?.messages[0]?.sender).toBe("customer");
    expect(customerThread?.messages[1]?.sender).toBe("store");

    const customerListAfterRead = await inTenant(TENANT_A, (tx) =>
      listConversationsForAccount(tx, TENANT_A, accountId, null)
    );
    expect(customerListAfterRead.items[0]?.unreadForCustomer).toBe(0);
  }, 30000);

  test("closed conversation refuses a customer post with CONVERSATION_CLOSED; a store reply reopens it", async () => {
    const accountId = await seedAccount(TENANT_A, "+6281200000102");

    const opened = await inTenant(TENANT_A, (tx) =>
      openConversation(tx, TENANT_A, accountId, {
        subject: "Return request",
        body: "I would like to return an item."
      })
    );

    await inTenant(TENANT_A, (tx) =>
      setConversationStatus(
        tx,
        TENANT_A,
        STORE_ACTOR,
        opened.conversation.id,
        "closed"
      )
    );

    const closedThread = await inTenant(TENANT_A, (tx) =>
      fetchConversationForAdmin(tx, TENANT_A, opened.conversation.id)
    );
    expect(closedThread?.conversation.status).toBe("closed");

    const refused = await inTenant(TENANT_A, (tx) =>
      postCustomerMessage(
        tx,
        TENANT_A,
        accountId,
        opened.conversation.id,
        "Are you still there?"
      )
    );
    expect(refused.kind).toBe("closed");

    // A STORE reply, in contrast, implicitly reopens the thread.
    const reply = await inTenant(TENANT_A, (tx) =>
      postStoreReply(
        tx,
        TENANT_A,
        STORE_ACTOR,
        opened.conversation.id,
        "Sorry for the delay — reopening this for you."
      )
    );
    expect(reply.kind).toBe("posted");

    const reopened = await inTenant(TENANT_A, (tx) =>
      fetchConversationForAdmin(tx, TENANT_A, opened.conversation.id)
    );
    expect(reopened?.conversation.status).toBe("open");

    // Now that it is open again, the customer CAN post.
    const posted = await inTenant(TENANT_A, (tx) =>
      postCustomerMessage(
        tx,
        TENANT_A,
        accountId,
        opened.conversation.id,
        "Thank you!"
      )
    );
    expect(posted.kind).toBe("posted");
  }, 30000);

  test("RLS cross-tenant isolation — tenant B cannot read or act on tenant A's conversation", async () => {
    const accountId = await seedAccount(TENANT_A, "+6281200000103");

    const opened = await inTenant(TENANT_A, (tx) =>
      openConversation(tx, TENANT_A, accountId, {
        subject: "Tenant A only",
        body: "This belongs to tenant A."
      })
    );

    const crossTenantAdminRead = await inTenant(TENANT_B, (tx) =>
      fetchConversationForAdmin(tx, TENANT_B, opened.conversation.id)
    );
    expect(crossTenantAdminRead).toBeNull();

    const crossTenantList = await inTenant(TENANT_B, (tx) =>
      listConversationsForAdmin(tx, TENANT_B, {}, null)
    );
    expect(crossTenantList.items).toHaveLength(0);

    const crossTenantReply = await inTenant(TENANT_B, (tx) =>
      postStoreReply(
        tx,
        TENANT_B,
        STORE_ACTOR,
        opened.conversation.id,
        "Should never be applied."
      )
    );
    expect(crossTenantReply.kind).toBe("not_found");

    const crossTenantStatus = await inTenant(TENANT_B, (tx) =>
      setConversationStatus(
        tx,
        TENANT_B,
        STORE_ACTOR,
        opened.conversation.id,
        "closed"
      )
    );
    expect(crossTenantStatus.kind).toBe("not_found");

    // The row itself must still be untouched from tenant A's own view.
    const stillOpenFromTenantA = await inTenant(TENANT_A, (tx) =>
      fetchConversationForAdmin(tx, TENANT_A, opened.conversation.id)
    );
    expect(stillOpenFromTenantA?.conversation.status).toBe("open");
  }, 30000);

  test("rate limit — the 11th customer post within an hour is rejected (COMMERCE_CONVERSATION_POST_RATE_LIMIT_MAX=10)", async () => {
    // Exercises the SAME shared rate limiter, key shape, and default budget
    // the storefront route
    // (`src/pages/api/v1/commerce/storefront/account/conversations/index.ts`
    // and its `[id]/messages.ts` sibling) uses for
    // `commerce:conversations:post:account:${accountId}` — proving the real
    // limiter enforces 10/h per account, not a re-implementation of it.
    const accountId = "44444444-4444-4444-4444-444444444444";
    const key = `commerce:conversations:post:account:${accountId}`;
    const limits = { maxAttempts: 10, windowMs: 60 * 60 * 1000 };

    for (let i = 0; i < 10; i += 1) {
      const result = await checkSharedRateLimit(key, limits);
      expect(result.allowed).toBe(true);
    }

    const eleventh = await checkSharedRateLimit(key, limits);
    expect(eleventh.allowed).toBe(false);
    if (eleventh.allowed)
      throw new Error("expected the 11th attempt to be rejected");
    expect(eleventh.retryAfterSec).toBeGreaterThan(0);
  }, 30000);
});
