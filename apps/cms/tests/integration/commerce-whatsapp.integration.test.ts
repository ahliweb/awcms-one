/**
 * WhatsApp outbox + OTP-via-WhatsApp integration (Issue #108, contract
 * #106/ADR-0017 D5) against a REAL migrated PostgreSQL, through
 * `tests/integration/harness.ts` — same ephemeral-database world
 * `commerce-customer-auth.integration.test.ts` (#89) already exercises.
 * Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * Covers exactly the three cases the issue calls for:
 * - enqueue -> dispatch with the `log` provider -> `sent`.
 * - OTP via WhatsApp: request (login, phone, channel enabled) -> verify by
 *   phone -> a live bearer session, resolved against an account that
 *   already existed (created here through the ordinary e-mail
 *   register/verify flow, then logged into by phone).
 * - channel unavailable: `via: "whatsapp"` with `COMMERCE_WHATSAPP_ENABLED`
 *   not `"true"` answers `channel_unavailable` — the outcome the route maps
 *   to `409 CHANNEL_UNAVAILABLE` — WITHOUT issuing an OTP row at all.
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
  verifyCustomerOtp
} from "../../src/modules/commerce/application/customer-auth";
import { createEmailCustomerOtpChannel } from "../../src/modules/commerce/application/customer-otp-channel-adapters";
import {
  createWhatsappCustomerOtpChannel,
  isWhatsappOtpChannelAvailable
} from "../../src/modules/commerce/application/whatsapp-otp-channel-adapter";
import { enqueueWhatsappMessage } from "../../src/modules/commerce/application/whatsapp-enqueue";
import { dispatchWhatsappQueue } from "../../src/modules/commerce/application/whatsapp-dispatch";
import type { CustomerOtpChannel } from "../../src/modules/commerce/domain/customer-otp-channel";
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

suite("commerce WhatsApp outbox + OTP integration (Issue #108)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-a");
  }, 30000);

  test("enqueue -> dispatch with the log provider -> sent", async () => {
    const enqueued = await inTenant(TENANT_A, (tx) =>
      enqueueWhatsappMessage(tx, {
        tenantId: TENANT_A,
        toPhone: "+6281234567890",
        templateKey: "commerce.customer_otp",
        variables: {
          code: "123456",
          expiresInMinutes: "10",
          storeName: "Toko A"
        }
      })
    );
    expect(enqueued.bodyRendered).toContain("123456");

    const admin = getAdminSql();
    const queuedRows = await admin<{ status: string; to_phone: string }[]>`
      SELECT status, to_phone FROM awcms_commerce_whatsapp_messages WHERE id = ${enqueued.id}
    `;
    expect(queuedRows[0]!.status).toBe("queued");
    expect(queuedRows[0]!.to_phone).toBe("+6281234567890");

    const runtimeSql = getRuntimeSql();
    const result = await dispatchWhatsappQueue(runtimeSql, TENANT_A, {
      env: {
        ...process.env,
        COMMERCE_WHATSAPP_ENABLED: "true",
        COMMERCE_WHATSAPP_PROVIDER: "log"
      } as NodeJS.ProcessEnv
    });

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);

    const sentRows = await admin<{ status: string; sent_at: Date | null }[]>`
      SELECT status, sent_at FROM awcms_commerce_whatsapp_messages WHERE id = ${enqueued.id}
    `;
    expect(sentRows[0]!.status).toBe("sent");
    expect(sentRows[0]!.sent_at).not.toBeNull();
  });

  test("dispatchWhatsappQueue is a no-op when COMMERCE_WHATSAPP_ENABLED is not true", async () => {
    await inTenant(TENANT_A, (tx) =>
      enqueueWhatsappMessage(tx, {
        tenantId: TENANT_A,
        toPhone: "+6281234567891",
        templateKey: "commerce.customer_otp",
        variables: {
          code: "654321",
          expiresInMinutes: "10",
          storeName: "Toko A"
        }
      })
    );

    const runtimeSql = getRuntimeSql();
    const result = await dispatchWhatsappQueue(runtimeSql, TENANT_A, {
      env: {
        ...process.env,
        COMMERCE_WHATSAPP_ENABLED: "false"
      } as NodeJS.ProcessEnv
    });

    expect(result.claimed).toBe(0);
    expect(result.sent).toBe(0);
  });

  test("OTP via WhatsApp: an existing account (registered by e-mail) can log in by phone", async () => {
    // Create the account the ordinary e-mail way first — ADR-0017 D5 keeps
    // registration e-mail-OTP only, so WhatsApp is a LOGIN channel for an
    // account that already exists.
    const emailChannel = createEmailCustomerOtpChannel();
    const requested = await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email: "siti@example.com",
          purpose: "register",
          name: "Siti",
          phone: "081234567892"
        },
        emailChannel
      )
    );
    expect(requested.kind).toBe("sent");

    const admin = getAdminSql();
    const otpRow = await admin<{ code_hash: string }[]>`
      SELECT code_hash FROM awcms_commerce_customer_otps
      WHERE tenant_id = ${TENANT_A} AND email_normalized = 'siti@example.com'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(otpRow.length).toBe(1);

    // Verify by brute-force isn't feasible (hashed) — instead capture the
    // code the SAME way the e-mail auth integration suite does: intercept
    // the channel. Re-run the request with a capturing channel to get a
    // fresh, known code.
    let capturedCode = "";
    const capturingChannel: CustomerOtpChannel = {
      async sendOtp(_tx, request) {
        capturedCode = request.code;
        return { sent: true };
      }
    };
    const requested2 = await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email: "siti@example.com",
          purpose: "register",
          name: "Siti",
          phone: "081234567892"
        },
        capturingChannel
      )
    );
    expect(requested2.kind).toBe("sent");
    expect(capturedCode).toMatch(/^\d{6}$/);

    const verified = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        { email: "siti@example.com", code: capturedCode, purpose: "register" },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(verified.kind).toBe("success");
    if (verified.kind !== "success") return;
    expect(verified.account.phone).toBe("+6281234567892");

    // Now log in again — this time via WhatsApp, by phone, no e-mail
    // supplied at all.
    let whatsappCapturedCode = "";
    const whatsappCapturingChannel: CustomerOtpChannel = {
      async sendOtp(_tx, request) {
        whatsappCapturedCode = request.code;
        expect(request.via).toBe("whatsapp");
        expect(request.phoneNormalized).toBe("+6281234567892");
        expect(request.emailNormalized).toBeNull();
        return { sent: true };
      }
    };

    const whatsappRequested = await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        { email: "", purpose: "login", via: "whatsapp", phone: "081234567892" },
        whatsappCapturingChannel,
        undefined,
        new Date(),
        { COMMERCE_WHATSAPP_ENABLED: "true" } as NodeJS.ProcessEnv
      )
    );
    expect(whatsappRequested.kind).toBe("sent");
    expect(whatsappCapturedCode).toMatch(/^\d{6}$/);

    const whatsappVerified = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        {
          email: "",
          phone: "081234567892",
          code: whatsappCapturedCode,
          purpose: "login"
        },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(whatsappVerified.kind).toBe("success");
    if (whatsappVerified.kind !== "success") return;
    expect(whatsappVerified.account.phone).toBe("+6281234567892");
    expect(whatsappVerified.token).not.toBe("");

    // And the OTP row really was keyed by phone_normalized, not e-mail.
    const phoneOtpRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM awcms_commerce_customer_otps
      WHERE tenant_id = ${TENANT_A} AND phone_normalized = '+6281234567892'
    `;
    expect(phoneOtpRows[0]!.n).toBeGreaterThan(0);
  });

  test("the real WhatsApp channel enqueues into the outbox inside the same transaction as the OTP row", async () => {
    // Reuse the register/verify dance above just far enough to have a
    // real account bound to a phone.
    const emailChannel = createEmailCustomerOtpChannel();
    let code = "";
    const capture: CustomerOtpChannel = {
      async sendOtp(_tx, request) {
        code = request.code;
        return emailChannel.sendOtp(_tx, request);
      }
    };
    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email: "rudi@example.com",
          purpose: "register",
          name: "Rudi",
          phone: "081234567893"
        },
        capture
      )
    );
    const verified = await inTenant(TENANT_A, (tx) =>
      verifyCustomerOtp(
        tx,
        TENANT_A,
        { email: "rudi@example.com", code, purpose: "register" },
        { clientIpHash: null, userAgentSummary: null }
      )
    );
    expect(verified.kind).toBe("success");

    const whatsappChannel = createWhatsappCustomerOtpChannel();
    const outcome = await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        { email: "", purpose: "login", via: "whatsapp", phone: "081234567893" },
        whatsappChannel,
        undefined,
        new Date(),
        { COMMERCE_WHATSAPP_ENABLED: "true" } as NodeJS.ProcessEnv
      )
    );
    expect(outcome.kind).toBe("sent");

    const admin = getAdminSql();
    const messages = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM awcms_commerce_whatsapp_messages
      WHERE tenant_id = ${TENANT_A} AND to_phone = '+6281234567893'
        AND template_key = 'commerce.customer_otp'
    `;
    expect(messages[0]!.n).toBe(1);
  });

  test("via: whatsapp answers channel_unavailable — configuration, not enumeration — before an OTP row is ever issued", async () => {
    expect(isWhatsappOtpChannelAvailable({} as NodeJS.ProcessEnv)).toBe(false);

    const explodingChannel: CustomerOtpChannel = {
      sendOtp: () => {
        throw new Error("must not send when the channel is unavailable");
      }
    };

    const outcome = await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko A",
        {
          email: "",
          purpose: "login",
          via: "whatsapp",
          phone: "081234567894"
        },
        explodingChannel,
        undefined,
        new Date(),
        {} as NodeJS.ProcessEnv
      )
    );

    expect(outcome.kind).toBe("channel_unavailable");

    const admin = getAdminSql();
    const otpRows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM awcms_commerce_customer_otps
      WHERE tenant_id = ${TENANT_A} AND phone_normalized = '+6281234567894'
    `;
    expect(otpRows[0]!.n).toBe(0);
  });
});
