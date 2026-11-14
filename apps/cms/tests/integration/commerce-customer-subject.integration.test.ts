/**
 * Shopper data-subject rights, export and erasure end to end (Issue #529,
 * ADR-0055) against a REAL migrated PostgreSQL through
 * `tests/integration/harness.ts`. Gated on `DATABASE_URL`; skips cleanly without
 * one. NOT EXECUTED in the environment that wrote it (no Docker/PostgreSQL
 * there): it runs through `bun run ci:cms` (`local-ci/check-cms`).
 *
 * Exercised at the APPLICATION layer (`application/customer-subject-flow.ts`),
 * the same choice `commerce-customer-auth.integration.test.ts` documents: the
 * route handlers need an Origin/tenant-domain resolution this suite would have
 * to seed just to reach the same functions, and their HTTP mapping is held by
 * the OpenAPI contract and `tests/customer-bearer-body-boundary.test.ts`.
 *
 * Covers: the export bundle's contents and redaction (no token_hash, code_hash,
 * push endpoint or key anywhere in it); an erasure with the personal rows
 * deleted, the identity anonymised with unique sentinels, the orders, ledgers
 * and conversations' store replies retained and resolving to the anonymised
 * customer; the old bearer dying; a replayed Idempotency-Key answering the
 * stored result with no second request row; a second request answering
 * ALREADY_ERASED; another tenant's customer refused; an open order and a
 * stored-value balance refusing the erasure; a login code not authorising an
 * erasure; the admin maker/checker rule and the append-only request rows; the
 * erased customer leaving segment eligibility.
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
  issueOtp,
  issueSession
} from "../../src/modules/commerce/application/customer-account-store";
import { findLiveCustomerSession } from "../../src/modules/commerce/application/customer-session-auth";
import { requestSubjectOtp } from "../../src/modules/commerce/application/customer-subject-otp";
import {
  adminDecideErasure,
  adminExport,
  adminRequestErasure,
  storefrontErase,
  storefrontExport
} from "../../src/modules/commerce/application/customer-subject-flow";
import { listSubjectRequests } from "../../src/modules/commerce/application/customer-subject-requests";
import { POS_WALK_IN_CUSTOMER_SENTINEL_PHONE } from "../../src/modules/commerce/domain/phone-normalisation";
import type {
  CustomerOtpChannel,
  CustomerOtpChannelRequest
} from "../../src/modules/commerce/domain/customer-otp-channel";
import {
  erasedEmail,
  erasedPhone
} from "../../src/modules/commerce/domain/customer-subject-policy";
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
const STAFF_1 = "a1111111-1111-4111-8111-111111111111";
const STAFF_2 = "a2222222-2222-4222-8222-222222222222";
const EMAIL = "shopper@example.test";
const PHONE = "+6281200000001";

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedTenantUser(tenantId: string, id: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Subject Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`subject-actor-${id}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${id}, ${tenantId}, ${identity[0]!.id})
  `;
}

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

function capturingChannel(): {
  channel: CustomerOtpChannel;
  sent: CustomerOtpChannelRequest[];
} {
  const sent: CustomerOtpChannelRequest[] = [];
  return {
    sent,
    channel: {
      async sendOtp(_tx, request) {
        sent.push(request);
        return { sent: true };
      }
    }
  };
}

type Shopper = { customerId: string; accountId: string; orderId: string };

/** A shopper with an account, a completed order, an address, a session, a conversation and a campaign-free history. */
async function seedShopper(
  tenantId: string,
  options: { email?: string; phone?: string; orderStatus?: string } = {}
): Promise<Shopper> {
  const admin = getAdminSql();
  const email = options.email ?? EMAIL;
  const phone = options.phone ?? PHONE;

  const customer = (await admin`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email)
    VALUES (${tenantId}, 'Siti Shopper', ${phone}, ${email})
    RETURNING id
  `) as { id: string }[];
  const customerId = customer[0]!.id;

  const account = (await admin`
    INSERT INTO awcms_commerce_customer_accounts
      (tenant_id, customer_id, email_normalized, email_verified_at, history_from)
    VALUES (${tenantId}, ${customerId}, ${email}, now(), now())
    RETURNING id
  `) as { id: string }[];
  const accountId = account[0]!.id;

  const order = (await admin`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, shipping_method,
       subtotal, total, address, notes)
    VALUES (${tenantId}, ${"ORD-" + crypto.randomUUID().slice(0, 8)}, ${customerId},
            ${options.orderStatus ?? "completed"}, 'manual_bank', 'self_pickup',
            100000, 100000, ${JSON.stringify({ street: "Jl. Mawar 1" })}::jsonb,
            'leave at the gate')
    RETURNING id
  `) as { id: string }[];

  await admin`
    INSERT INTO awcms_commerce_customer_addresses
      (tenant_id, customer_id, recipient_name, phone, province_code, province_name,
       city_code, city_name, district_code, district_name, street, is_default)
    VALUES (${tenantId}, ${customerId}, 'Siti Shopper', ${phone}, '62', 'Kalimantan Tengah',
            '6271', 'Palangka Raya', '627101', 'Pahandut', 'Jl. Mawar 1', true)
  `;

  const conversation = (await admin`
    INSERT INTO awcms_commerce_conversations (tenant_id, account_id, subject)
    VALUES (${tenantId}, ${accountId}, 'Where is my parcel?')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_commerce_messages (tenant_id, conversation_id, sender, body)
    VALUES (${tenantId}, ${conversation[0]!.id}, 'customer', 'My phone is 0812 0000 0001')
  `;
  await admin`
    INSERT INTO awcms_commerce_messages
      (tenant_id, conversation_id, sender, sender_tenant_user_id, body)
    VALUES (${tenantId}, ${conversation[0]!.id}, 'store', ${STAFF_1}, 'It ships tomorrow.')
  `;

  return { customerId, accountId, orderId: order[0]!.id };
}

async function countRows(table: string, where: string, value: string) {
  const admin = getAdminSql();
  const rows = (await admin.unsafe(
    `SELECT count(*)::int AS count FROM ${table} WHERE ${where} = $1`,
    [value]
  )) as { count: number }[];
  return rows[0]!.count;
}

/** Issues a subject code through the real request path and reads it off the channel. */
async function subjectCode(
  tenantId: string,
  accountId: string,
  type: "export" | "erasure"
): Promise<string> {
  const { channel, sent } = capturingChannel();
  const outcome = await inTenant(tenantId, (tx) =>
    requestSubjectOtp(tx, tenantId, "Toko A", accountId, type, channel)
  );
  expect(outcome.kind).toBe("sent");
  expect(sent).toHaveLength(1);
  return sent[0]!.code;
}

suite("commerce shopper data-subject rights (Issue #529)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-subject-a");
    await seedTenant(TENANT_B, "tenant-subject-b");
    await seedTenantUser(TENANT_A, STAFF_1);
    await seedTenantUser(TENANT_A, STAFF_2);
  }, 30000);

  describe("export", () => {
    test("returns the shopper's data, redacts every secret and writes a counts-only disclosure row", async () => {
      const shopper = await seedShopper(TENANT_A);
      const session = await inTenant(TENANT_A, (tx) =>
        issueSession(tx, TENANT_A, shopper.accountId)
      );

      const code = await subjectCode(TENANT_A, shopper.accountId, "export");
      const outcome = await inTenant(TENANT_A, (tx) =>
        storefrontExport(
          tx,
          TENANT_A,
          { id: shopper.accountId, customerId: shopper.customerId },
          code
        )
      );
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") return;

      const { bundle } = outcome;
      expect(bundle.version).toBe(1);
      expect(bundle.customerId).toBe(shopper.customerId);
      expect(bundle.sections.customer).toHaveLength(1);
      expect(bundle.sections.orders).toHaveLength(1);
      expect(bundle.sections.addresses).toHaveLength(1);
      expect(bundle.sections.conversations).toHaveLength(1);
      expect(bundle.sections.messages).toHaveLength(2);
      expect(bundle.sections.sessions).toHaveLength(1);
      expect(bundle.unanswered.map((u) => u.table)).toContain(
        "awcms_commerce_whatsapp_messages"
      );

      const serialised = JSON.stringify(bundle);
      expect(serialised).not.toContain("token_hash");
      expect(serialised).not.toContain("code_hash");
      expect(serialised).not.toContain("client_ip_hash");
      expect(serialised).not.toContain(session.token);

      const requests = await inTenant(TENANT_A, (tx) =>
        listSubjectRequests(tx, TENANT_A)
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        requestType: "export",
        channel: "storefront",
        status: "disclosed"
      });
      expect(JSON.stringify(requests[0])).not.toContain("Siti Shopper");
    });

    test("a wrong code and a login code are the same refusal, and a code is single use", async () => {
      const shopper = await seedShopper(TENANT_A);
      const account = {
        id: shopper.accountId,
        customerId: shopper.customerId
      };

      // A login code of the same account does not authorise an export.
      const loginCode = await inTenant(
        TENANT_A,
        async (tx) => (await issueOtp(tx, TENANT_A, EMAIL, "login")).code
      );
      const wrong = await inTenant(TENANT_A, (tx) =>
        storefrontExport(tx, TENANT_A, account, loginCode)
      );
      expect(wrong.kind).toBe("otp_invalid");

      const code = await subjectCode(TENANT_A, shopper.accountId, "export");
      const first = await inTenant(TENANT_A, (tx) =>
        storefrontExport(tx, TENANT_A, account, code)
      );
      expect(first.kind).toBe("ok");
      const second = await inTenant(TENANT_A, (tx) =>
        storefrontExport(tx, TENANT_A, account, code)
      );
      expect(second.kind).toBe("otp_invalid");
    });

    test("an admin export is audited, needs a fresh key and does not reach another tenant's customer", async () => {
      const shopper = await seedShopper(TENANT_A);
      const other = await seedShopper(TENANT_B, {
        email: "b@example.test",
        phone: "+6281200000002"
      });

      const key = crypto.randomUUID();
      const done = await inTenant(TENANT_A, (tx) =>
        adminExport(tx, TENANT_A, STAFF_1, shopper.customerId, key)
      );
      expect(done.kind).toBe("ok");

      const replay = await inTenant(TENANT_A, (tx) =>
        adminExport(tx, TENANT_A, STAFF_1, shopper.customerId, key)
      );
      expect(replay.kind).toBe("key_replayed");

      const crossTenant = await inTenant(TENANT_A, (tx) =>
        adminExport(
          tx,
          TENANT_A,
          STAFF_1,
          other.customerId,
          crypto.randomUUID()
        )
      );
      expect(crossTenant.kind).toBe("not_found");

      const audit = (await getAdminSql()`
        SELECT severity, attributes::text AS attributes FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A}
          AND action = 'commerce.customer_subject.exported'
      `) as { severity: string; attributes: string }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]!.severity).toBe("critical");
      expect(audit[0]!.attributes).not.toContain("Siti Shopper");
    });
  });

  describe("erasure", () => {
    test("deletes the personal rows, anonymises the identity and keeps the bookkeeping", async () => {
      const shopper = await seedShopper(TENANT_A);
      const session = await inTenant(TENANT_A, (tx) =>
        issueSession(tx, TENANT_A, shopper.accountId)
      );
      const account = {
        id: shopper.accountId,
        customerId: shopper.customerId
      };
      await getAdminSql()`
        INSERT INTO awcms_commerce_affiliates
          (tenant_id, customer_id, code, commission_rate, status)
        VALUES (${TENANT_A}, ${shopper.customerId}, 'SITI10', 5, 'active')
      `;
      const code = await subjectCode(TENANT_A, shopper.accountId, "erasure");

      const outcome = await inTenant(TENANT_A, (tx) =>
        storefrontErase(tx, TENANT_A, account, code, crypto.randomUUID())
      );
      expect(outcome.kind).toBe("erased");
      if (outcome.kind !== "erased") return;
      expect(
        outcome.request.retainedSummary?.anonymised.affiliatesSuspended
      ).toBe(1);
      // The affiliate row is retained but suspended: the public code stops earning.
      const affiliate = (await getAdminSql()`
        SELECT status FROM awcms_commerce_affiliates
        WHERE customer_id = ${shopper.customerId}
      `) as { status: string }[];
      expect(affiliate).toHaveLength(1);
      expect(affiliate[0]!.status).toBe("suspended");
      expect(outcome.request.retainedSummary?.retained.sections).toContain(
        "orders"
      );

      const admin = getAdminSql();
      // Deleted.
      expect(
        await countRows(
          "awcms_commerce_customer_sessions",
          "account_id",
          shopper.accountId
        )
      ).toBe(0);
      expect(
        await countRows(
          "awcms_commerce_customer_addresses",
          "customer_id",
          shopper.customerId
        )
      ).toBe(0);

      // Anonymised, with unique sentinels, flagged and blocked.
      const customer = (await admin`
        SELECT name, phone, email, status, erased_at, deleted_at
        FROM awcms_commerce_customers WHERE id = ${shopper.customerId}
      `) as {
        name: string;
        phone: string;
        email: string | null;
        status: string;
        erased_at: Date | null;
        deleted_at: Date | null;
      }[];
      expect(customer[0]).toMatchObject({
        name: "Erased customer",
        phone: erasedPhone(shopper.customerId),
        email: null,
        status: "blocked"
      });
      expect(customer[0]!.erased_at).not.toBeNull();
      expect(customer[0]!.deleted_at).toBeNull();

      const accountRow = (await admin`
        SELECT email_normalized, status, erased_at
        FROM awcms_commerce_customer_accounts WHERE id = ${shopper.accountId}
      `) as {
        email_normalized: string;
        status: string;
        erased_at: Date | null;
      }[];
      expect(accountRow[0]!.email_normalized).toBe(
        erasedEmail(shopper.accountId)
      );
      expect(accountRow[0]!.status).toBe("blocked");
      expect(accountRow[0]!.erased_at).not.toBeNull();

      // The shopper's own words are overwritten; the store's reply stays.
      const messages = (await admin`
        SELECT sender, body FROM awcms_commerce_messages
        WHERE tenant_id = ${TENANT_A} ORDER BY sender
      `) as { sender: string; body: string }[];
      expect(messages.find((m) => m.sender === "customer")!.body).toBe(
        "[erased]"
      );
      expect(messages.find((m) => m.sender === "store")!.body).toBe(
        "It ships tomorrow."
      );

      // Retained: the order is still there and resolves to the anonymised customer.
      const order = (await admin`
        SELECT o.id, c.name FROM awcms_commerce_orders o
        JOIN awcms_commerce_customers c ON c.id = o.customer_id
        WHERE o.id = ${shopper.orderId}
      `) as { id: string; name: string }[];
      expect(order).toHaveLength(1);
      expect(order[0]!.name).toBe("Erased customer");

      // The old bearer is dead: the next request is unauthenticated.
      const live = await inTenant(TENANT_A, (tx) =>
        findLiveCustomerSession(
          new Request(
            "https://awcms.test/api/v1/commerce/storefront/account/me",
            {
              headers: { authorization: `Bearer ${session.token}` }
            }
          ),
          tx,
          TENANT_A
        )
      );
      expect(live).toBeNull();

      // The audit event carries counts, never the shopper's name or contact.
      const audit = (await admin`
        SELECT severity, attributes::text AS attributes FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'commerce.customer_subject.erased'
      `) as { severity: string; attributes: string }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]!.severity).toBe("critical");
      expect(audit[0]!.attributes).not.toContain("Siti");
      expect(audit[0]!.attributes).not.toContain(EMAIL);
    });

    // Application layer only: over HTTP a completed erasure revoked every
    // session, so the route answers 401 before this function is reached; the
    // stored answer is reachable over HTTP for a refused attempt only.
    test("a replayed Idempotency-Key answers the stored result with no second request row", async () => {
      const shopper = await seedShopper(TENANT_A);
      const account = {
        id: shopper.accountId,
        customerId: shopper.customerId
      };
      const key = crypto.randomUUID();
      const code = await subjectCode(TENANT_A, shopper.accountId, "erasure");

      const first = await inTenant(TENANT_A, (tx) =>
        storefrontErase(tx, TENANT_A, account, code, key)
      );
      expect(first.kind).toBe("erased");

      const replay = await inTenant(TENANT_A, (tx) =>
        storefrontErase(tx, TENANT_A, account, "000000", key)
      );
      expect(replay.kind).toBe("replayed");
      if (first.kind === "erased" && replay.kind === "replayed") {
        expect(replay.request.id).toBe(first.request.id);
      }

      expect(
        await countRows(
          "awcms_commerce_customer_subject_requests",
          "customer_id",
          shopper.customerId
        )
      ).toBe(1);
      const audit = (await getAdminSql()`
        SELECT count(*)::int AS count FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'commerce.customer_subject.erased'
      `) as { count: number }[];
      expect(audit[0]!.count).toBe(1);
    });

    test("a second erasure with a new key is refused as ALREADY_ERASED", async () => {
      const shopper = await seedShopper(TENANT_A);
      const account = {
        id: shopper.accountId,
        customerId: shopper.customerId
      };
      const code = await subjectCode(TENANT_A, shopper.accountId, "erasure");
      await inTenant(TENANT_A, (tx) =>
        storefrontErase(tx, TENANT_A, account, code, crypto.randomUUID())
      );

      const again = await inTenant(TENANT_A, (tx) =>
        storefrontErase(tx, TENANT_A, account, "123456", crypto.randomUUID())
      );
      expect(again.kind).toBe("refused");
      if (again.kind === "refused") {
        expect(again.codes).toEqual(["ALREADY_ERASED"]);
      }
    });

    test("an open order refuses the erasure, writes a refused row and does not burn the code", async () => {
      const shopper = await seedShopper(TENANT_A, { orderStatus: "paid" });
      const account = {
        id: shopper.accountId,
        customerId: shopper.customerId
      };
      const code = await subjectCode(TENANT_A, shopper.accountId, "erasure");

      const refused = await inTenant(TENANT_A, (tx) =>
        storefrontErase(tx, TENANT_A, account, code, crypto.randomUUID())
      );
      expect(refused.kind).toBe("refused");
      if (refused.kind === "refused") {
        expect(refused.codes).toContain("OPEN_ORDER");
        expect(refused.request.status).toBe("refused");
      }

      const customer = (await getAdminSql()`
        SELECT name, erased_at FROM awcms_commerce_customers
        WHERE id = ${shopper.customerId}
      `) as { name: string; erased_at: Date | null }[];
      expect(customer[0]).toMatchObject({
        name: "Siti Shopper",
        erased_at: null
      });

      // The order completes; the SAME code now works (a refusal does not consume it).
      await getAdminSql()`
        UPDATE awcms_commerce_orders SET status = 'completed', completed_at = now()
        WHERE id = ${shopper.orderId}
      `;
      const done = await inTenant(TENANT_A, (tx) =>
        storefrontErase(tx, TENANT_A, account, code, crypto.randomUUID())
      );
      expect(done.kind).toBe("erased");
    });

    test("a stored-value balance refuses the erasure (best effort seed: see the file header)", async () => {
      const shopper = await seedShopper(TENANT_A);
      const admin = getAdminSql();
      await admin.begin(async (tx) => {
        const program = (await tx`
          INSERT INTO awcms_commerce_stored_value_programs (tenant_id, kind, enabled)
          VALUES (${TENANT_A}, 'gift_card', true) RETURNING id
        `) as { id: string }[];
        const stored = (await tx`
          INSERT INTO awcms_commerce_stored_value_accounts
            (tenant_id, program_id, kind, code_hash, code_last4, customer_id)
          VALUES (${TENANT_A}, ${program[0]!.id}, 'gift_card',
                  ${"sha256:" + "a".repeat(64)}, 'K7QX', ${shopper.customerId})
          RETURNING id
        `) as { id: string }[];
        await tx`
          INSERT INTO awcms_commerce_stored_value_ledger
            (tenant_id, account_id, kind, amount, account_seq, balance_after,
             source_key, actor_kind)
          VALUES (${TENANT_A}, ${stored[0]!.id}, 'issue', 50000, 1, 50000,
                  'test:issue', 'system')
        `;
      });

      const dryRun = await inTenant(TENANT_A, (tx) =>
        adminRequestErasure(
          tx,
          TENANT_A,
          STAFF_1,
          shopper.customerId,
          null,
          crypto.randomUUID()
        )
      );
      expect(dryRun.kind).toBe("refused");
      if (dryRun.kind === "refused") {
        expect(dryRun.codes).toContain("STORED_VALUE_BALANCE");
      }
    });

    test("the POS walk-in sentinel customer is refused as NOT_A_PERSON", async () => {
      const walkIn = await seedShopper(TENANT_A, {
        email: "walkin@example.test",
        phone: POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
      });
      const outcome = await inTenant(TENANT_A, (tx) =>
        adminRequestErasure(
          tx,
          TENANT_A,
          STAFF_1,
          walkIn.customerId,
          null,
          crypto.randomUUID()
        )
      );
      expect(outcome.kind).toBe("refused");
      if (outcome.kind === "refused") {
        expect(outcome.codes).toEqual(["NOT_A_PERSON"]);
      }
    });

    test("another tenant's customer is not found by an admin request", async () => {
      const other = await seedShopper(TENANT_B, {
        email: "b@example.test",
        phone: "+6281200000002"
      });
      const outcome = await inTenant(TENANT_A, (tx) =>
        adminRequestErasure(
          tx,
          TENANT_A,
          STAFF_1,
          other.customerId,
          null,
          crypto.randomUUID()
        )
      );
      expect(outcome.kind).toBe("not_found");
    });
  });

  describe("admin maker and checker", () => {
    test("the requester cannot approve; a second person can; rows are then final", async () => {
      const shopper = await seedShopper(TENANT_A);
      const pending = await inTenant(TENANT_A, (tx) =>
        adminRequestErasure(
          tx,
          TENANT_A,
          STAFF_1,
          shopper.customerId,
          "asked by letter",
          crypto.randomUUID()
        )
      );
      expect(pending.kind).toBe("pending");
      if (pending.kind !== "pending") return;
      const requestId = pending.request.id;

      // Nothing was erased by the request.
      expect(
        await countRows(
          "awcms_commerce_customer_addresses",
          "customer_id",
          shopper.customerId
        )
      ).toBe(1);

      const self = await inTenant(TENANT_A, (tx) =>
        adminDecideErasure(tx, TENANT_A, STAFF_1, requestId, "approve")
      );
      expect(self.kind).toBe("same_person");

      const approved = await inTenant(TENANT_A, (tx) =>
        adminDecideErasure(tx, TENANT_A, STAFF_2, requestId, "approve")
      );
      expect(approved.kind).toBe("erased");
      expect(
        await countRows(
          "awcms_commerce_customer_addresses",
          "customer_id",
          shopper.customerId
        )
      ).toBe(0);

      // A decided row is final: a second decision is not pending, and the table
      // refuses a direct change and any delete.
      const again = await inTenant(TENANT_A, (tx) =>
        adminDecideErasure(tx, TENANT_A, STAFF_2, requestId, "reject")
      );
      expect(again.kind).toBe("not_pending");

      await expect(
        getAdminSql()`
          UPDATE awcms_commerce_customer_subject_requests
          SET reason = 'edited' WHERE id = ${requestId}`
      ).rejects.toThrow();
      await expect(
        getAdminSql()`
          DELETE FROM awcms_commerce_customer_subject_requests
          WHERE id = ${requestId}`
      ).rejects.toThrow();
    });

    test("a rejection erases nothing", async () => {
      const shopper = await seedShopper(TENANT_A);
      const pending = await inTenant(TENANT_A, (tx) =>
        adminRequestErasure(
          tx,
          TENANT_A,
          STAFF_1,
          shopper.customerId,
          null,
          crypto.randomUUID()
        )
      );
      if (pending.kind !== "pending") throw new Error("expected pending");

      const rejected = await inTenant(TENANT_A, (tx) =>
        adminDecideErasure(tx, TENANT_A, STAFF_2, pending.request.id, "reject")
      );
      expect(rejected.kind).toBe("rejected");
      expect(
        await countRows(
          "awcms_commerce_customer_addresses",
          "customer_id",
          shopper.customerId
        )
      ).toBe(1);
    });
  });

  describe("segments", () => {
    test("an erased customer no longer matches the eligibility predicate", async () => {
      const shopper = await seedShopper(TENANT_A);
      const code = await subjectCode(TENANT_A, shopper.accountId, "erasure");
      await inTenant(TENANT_A, (tx) =>
        storefrontErase(
          tx,
          TENANT_A,
          { id: shopper.accountId, customerId: shopper.customerId },
          code,
          crypto.randomUUID()
        )
      );

      const eligible = (await getAdminSql()`
        SELECT count(*)::int AS count FROM awcms_commerce_customers c
        WHERE c.tenant_id = ${TENANT_A} AND c.id = ${shopper.customerId}
          AND c.deleted_at IS NULL AND c.erased_at IS NULL AND c.status = 'active'
      `) as { count: number }[];
      expect(eligible[0]!.count).toBe(0);
    });
  });
});
