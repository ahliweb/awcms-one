/**
 * Customer account auth (Issue #89, contract #86/ADR-0016) against a REAL
 * migrated PostgreSQL, through `tests/integration/harness.ts` — the same
 * ephemeral-database world `commerce-customer-account-store.integration.
 * test.ts` (#87) already exercises, extended one layer up to
 * `application/customer-auth.ts` (the OTP request/verify orchestration) and
 * `application/customer-session-auth.ts` (the bearer guard). Gated on
 * `DATABASE_URL`; skips cleanly without one.
 *
 * Exercised at the APPLICATION layer rather than through the Astro route
 * handlers: `getDatabaseClient()` (what the routes call internally) is
 * memoized per-process to whichever database is resolved FIRST (harness's
 * own header, "TWO DATABASES, AND WHY"), and `commerce`'s anonymous routes
 * additionally require an `Origin`/`awcms_tenant_domains` resolution this
 * suite would otherwise have to seed just to reach the same functions this
 * file already drives directly. The route handlers' own HTTP-shape mapping
 * (status codes, envelope, CORS headers) is covered by
 * `commerce-customer-auth.test.ts` (mocked store) instead.
 *
 * A `CustomerOtpChannel` stub captures the code exactly the way
 * `password-reset.integration.test.ts`'s stub `AuthNotificationPort`
 * captures the reset URL — the channel's own request payload IS where the
 * code lives; this suite never reads `code_hash` (unrecoverable by design).
 *
 * Covers: request -> verify -> a live bearer session -> logout -> the same
 * bearer now unauthenticated; wrong code x5 exhausts the OTP even for the
 * correct 6th guess; register with a phone already bound to an account
 * (409-shaped outcome); D4's history_from rule on both branches (matching
 * guest e-mail vs a different one); a blocked account cannot log in and
 * never gets a session.
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
  requestCustomerOtp,
  verifyCustomerOtp,
  fetchCustomerAccountView
} from "../../src/modules/commerce/application/customer-auth";
import { requireCustomerSession } from "../../src/modules/commerce/application/customer-session-auth";
import { revokeSession } from "../../src/modules/commerce/application/customer-account-store";
import {
  CUSTOMER_OTP_TEMPLATE_KEY,
  createEmailCustomerOtpChannel
} from "../../src/modules/commerce/application/customer-otp-channel-adapters";
import type {
  CustomerOtpChannel,
  CustomerOtpChannelRequest
} from "../../src/modules/commerce/domain/customer-otp-channel";
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

/** Captures every request the channel is asked to send — the code is read straight off it, never guessed or derived. */
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

function bearerRequest(token: string): Request {
  return new Request(
    "https://awcms.test/api/v1/commerce/storefront/account/me",
    {
      headers: { authorization: `Bearer ${token}` }
    }
  );
}

suite("commerce customer auth integration (Issue #89)", () => {
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

  test("register: request -> verify -> live session -> me -> logout -> me is unauthenticated", async () => {
    const { channel, sent } = capturingChannel();

    const requested = await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email: "budi@example.com",
          purpose: "register",
          name: "Budi",
          phone: "081234567890"
        },
        channel
      )
    );
    expect(requested.kind).toBe("sent");
    expect(sent).toHaveLength(1);
    const code = sent[0]!.code;
    expect(code).toMatch(/^\d{6}$/);

    const verified = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        { email: "budi@example.com", code, purpose: "register" },
        { clientIpHash: null, userAgentSummary: "test-agent" }
      )
    );
    expect(verified.kind).toBe("success");
    if (verified.kind !== "success") return;

    expect(verified.account.name).toBe("Budi");
    expect(verified.account.phone).toBe("+6281234567890");
    expect(verified.account.email).toBe("budi@example.com");

    const authOutcome = await inTenant(TENANT_A, (tx) =>
      requireCustomerSession(bearerRequest(verified.token), tx, TENANT_A)
    );
    expect(authOutcome.ok).toBe(true);
    if (!authOutcome.ok) return;

    const view = await inTenant(TENANT_A, (tx) =>
      fetchCustomerAccountView(tx, TENANT_A, authOutcome.account.id)
    );
    expect(view?.email).toBe("budi@example.com");

    await inTenant(TENANT_A, (tx) =>
      revokeSession(tx, TENANT_A, authOutcome.sessionId)
    );

    const afterLogout = await inTenant(TENANT_A, (tx) =>
      requireCustomerSession(bearerRequest(verified.token), tx, TENANT_A)
    );
    expect(afterLogout.ok).toBe(false);
  });

  test("the e-mail channel seeds the tenant's OTP template on first use, so a tenant created after sql/919 still gets a message enqueued", async () => {
    // The harness creates tenants AFTER migrations ran, so neither has the
    // row sql/919 seeded — exactly the production shape of a tenant
    // provisioned later. Without the adapter's self-seed this request would
    // answer its neutral 202 with nothing in the outbox.
    const admin = getAdminSql();
    const before = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM awcms_email_templates
      WHERE tenant_id = ${TENANT_A} AND template_key = ${CUSTOMER_OTP_TEMPLATE_KEY}
    `;
    expect(before[0]!.n).toBe(0);

    const outcome = await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        { email: "seed@example.com", purpose: "login" },
        createEmailCustomerOtpChannel()
      )
    );
    expect(outcome.kind).toBe("sent");

    const templates = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM awcms_email_templates
      WHERE tenant_id = ${TENANT_A} AND template_key = ${CUSTOMER_OTP_TEMPLATE_KEY} AND deleted_at IS NULL
    `;
    expect(templates[0]!.n).toBe(1);

    const messages = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM awcms_email_messages
      WHERE tenant_id = ${TENANT_A} AND template_key = ${CUSTOMER_OTP_TEMPLATE_KEY}
    `;
    expect(messages[0]!.n).toBe(1);
  });

  test("wrong code five times exhausts the OTP — the sixth guess, even if correct, is rejected", async () => {
    const { channel, sent } = capturingChannel();

    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        { email: "wrong@example.com", purpose: "login" },
        channel
      )
    );
    const code = sent[0]!.code;
    const wrongCode = code === "000000" ? "111111" : "000000";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const outcome = await inTenant(TENANT_A, (tx) =>
        verifyCustomerOtp(
          tx,
          TENANT_A,
          { email: "wrong@example.com", code: wrongCode, purpose: "login" },
          { clientIpHash: null, userAgentSummary: null }
        )
      );
      expect(outcome.kind).toBe("otp_invalid");
    }

    const finalAttempt = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        { email: "wrong@example.com", code, purpose: "login" },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(finalAttempt.kind).toBe("otp_invalid");
  });

  test("register with a phone already bound to an account answers phone_already_registered", async () => {
    const { channel: channel1, sent: sent1 } = capturingChannel();
    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email: "first@example.com",
          purpose: "register",
          name: "Pertama",
          phone: "081111111111"
        },
        channel1
      )
    );
    const firstVerify = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        {
          email: "first@example.com",
          code: sent1[0]!.code,
          purpose: "register"
        },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(firstVerify.kind).toBe("success");

    const { channel: channel2, sent: sent2 } = capturingChannel();
    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email: "second@example.com",
          purpose: "register",
          name: "Kedua",
          phone: "081111111111"
        },
        channel2
      )
    );
    const secondVerify = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        {
          email: "second@example.com",
          code: sent2[0]!.code,
          purpose: "register"
        },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(secondVerify.kind).toBe("phone_already_registered");
  });

  test("register again with an e-mail that already owns an account logs in — one account, a second live session", async () => {
    // A returning shopper who picks "Daftar" instead of "Masuk" has still
    // proven control of the mailbox; a second account is impossible (unique
    // e-mail per tenant) and a 500 from that index is not an answer.
    const email = "again@example.com";
    const { channel: c1, sent: s1 } = capturingChannel();
    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        { email, purpose: "register", name: "Ulang", phone: "081222222222" },
        c1
      )
    );
    const first = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        { email, code: s1[0]!.code, purpose: "register" },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(first.kind).toBe("success");

    const { channel: c2, sent: s2 } = capturingChannel();
    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email,
          purpose: "register",
          name: "Ulang Lagi",
          phone: "081333333333"
        },
        c2
      )
    );
    const second = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        { email, code: s2[0]!.code, purpose: "register" },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(second.kind).toBe("success");
    if (first.kind === "success" && second.kind === "success") {
      expect(second.account.id).toBe(first.account.id);
      // The original registration wins: the second attempt's name/phone are
      // not applied, because it was a login, not an edit.
      expect(second.account.name).toBe("Ulang");
      expect(second.token).not.toBe(first.token);
    }
  });

  test("D4: registration binds to a guest row whose e-mail matches -> history_from is the guest's own created_at", async () => {
    await inTenant(
      TENANT_A,
      (tx) =>
        tx`
          INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email, created_at)
          VALUES (${TENANT_A}, 'Siti', '+6281234500001', 'siti@example.com', '2026-01-01T00:00:00.000Z')
        `
    );

    const { channel, sent } = capturingChannel();
    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email: "siti@example.com",
          purpose: "register",
          name: "Siti",
          phone: "081234500001"
        },
        channel
      )
    );

    const verified = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        { email: "siti@example.com", code: sent[0]!.code, purpose: "register" },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(verified.kind).toBe("success");
    if (verified.kind !== "success") return;
    expect(verified.account.historyFrom).toBe("2026-01-01T00:00:00.000Z");
  });

  test("D4: registration binds to a guest row whose e-mail differs -> history_from is now (not the guest's created_at)", async () => {
    await inTenant(
      TENANT_A,
      (tx) =>
        tx`
          INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email, created_at)
          VALUES (${TENANT_A}, 'Wati', '+6281234500002', 'lama@example.com', '2026-01-01T00:00:00.000Z')
        `
    );

    const { channel, sent } = capturingChannel();
    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email: "baru@example.com",
          purpose: "register",
          name: "Wati",
          phone: "081234500002"
        },
        channel
      )
    );

    const verified = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        { email: "baru@example.com", code: sent[0]!.code, purpose: "register" },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(verified.kind).toBe("success");
    if (verified.kind !== "success") return;
    expect(verified.account.historyFrom).not.toBe("2026-01-01T00:00:00.000Z");
  });

  test("a blocked account cannot log in and is never issued a session", async () => {
    const { channel, sent } = capturingChannel();
    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email: "diblokir@example.com",
          purpose: "register",
          name: "Diblokir",
          phone: "081234500003"
        },
        channel
      )
    );
    const registered = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        {
          email: "diblokir@example.com",
          code: sent[0]!.code,
          purpose: "register"
        },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(registered.kind).toBe("success");

    await inTenant(
      TENANT_A,
      (tx) =>
        tx`
          UPDATE awcms_commerce_customer_accounts
          SET status = 'blocked'
          WHERE tenant_id = ${TENANT_A} AND email_normalized = 'diblokir@example.com'
        `
    );

    const { channel: loginChannel, sent: loginSent } = capturingChannel();
    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        { email: "diblokir@example.com", purpose: "login" },
        loginChannel
      )
    );

    const loginAttempt = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        {
          email: "diblokir@example.com",
          code: loginSent[0]!.code,
          purpose: "login"
        },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(loginAttempt.kind).toBe("blocked");
  });

  test("a token from tenant B is not a live session in tenant A (RLS)", async () => {
    const { channel, sent } = capturingChannel();
    await inTenant(TENANT_B, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_B,
        "Toko B",
        {
          email: "lintas@example.com",
          purpose: "register",
          name: "Lintas",
          phone: "081234500004"
        },
        channel
      )
    );
    const verified = await inTenant(TENANT_B, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_B,
        {
          email: "lintas@example.com",
          code: sent[0]!.code,
          purpose: "register"
        },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(verified.kind).toBe("success");
    if (verified.kind !== "success") return;

    const crossTenantAuth = await inTenant(TENANT_A, (tx) =>
      requireCustomerSession(bearerRequest(verified.token), tx, TENANT_A)
    );
    expect(crossTenantAuth.ok).toBe(false);
  });
});
