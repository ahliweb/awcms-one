/**
 * Issue #311 — a customer OTP e-mail enqueued through the REAL commerce path
 * (`requestCustomerOtp` + `createEmailCustomerOtpChannel`) and drained by the
 * REAL `dispatchEmailQueue` must reach the provider with its code in the body.
 * Before the fix the `email:dispatch` process had not registered
 * `derived.commerce_customer_otp`, so every variable was dropped and the body
 * went out as "Your verification code is . It expires in  minutes.".
 *
 * That the registration holds in a process that never imported commerce is
 * proved by `tests/commerce-email-categories-dispatch.test.ts` (fresh
 * subprocess); this suite proves the whole queue -> render -> provider path.
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
import { requestCustomerOtp } from "../../src/modules/commerce/application/customer-auth";
import { createEmailCustomerOtpChannel } from "../../src/modules/commerce/application/customer-otp-channel-adapters";
import { dispatchEmailQueue } from "../../src/modules/email/application/email-dispatch";
import type {
  EmailMessage,
  EmailProvider
} from "../../src/modules/email/domain/email-provider-contract";
import {
  getAdminSql,
  getRuntimeSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "66666666-6666-6666-6666-666666666666";

function capturingProvider(): {
  provider: EmailProvider;
  sent: EmailMessage[];
} {
  const sent: EmailMessage[] = [];
  return {
    sent,
    provider: {
      async send(message) {
        sent.push(message);
        return { ok: true, providerMessageId: "capture-1" };
      },
      async healthCheck() {
        return { ok: true };
      }
    }
  };
}

suite("commerce e-mail dispatch integration (Issue #311)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await getAdminSql()`
      INSERT INTO awcms_tenants
        (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
      VALUES (${TENANT_A}, 'tenant-311', 'Tenant 311', 'Tenant 311 Legal', 'active', 'en', 'light')
    `;
  }, 30000);

  test("an OTP e-mail enqueued by the commerce adapter is delivered with its code and expiry", async () => {
    await withTenantOrThrow(getRuntimeSql(), TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko Tiga Satu Satu",
        { email: "shopper311@example.com", purpose: "login" },
        createEmailCustomerOtpChannel()
      )
    );

    const { provider, sent } = capturingProvider();
    const result = await dispatchEmailQueue(getRuntimeSql(), TENANT_A, {
      env: {
        EMAIL_ENABLED: "true",
        EMAIL_PROVIDER: "mailketing"
      } as NodeJS.ProcessEnv,
      resolveProvider: () => provider,
      fromAddress: "noreply@example.com"
    });

    expect(result.sent).toBe(1);
    expect(sent).toHaveLength(1);
    const body = sent[0]!.textBody ?? "";
    // The code is whatever the adapter issued: read it back from the message
    // rather than from a literal, and require it to be a real 6-digit code.
    const code = /\b(\d{6})\b/.exec(body)?.[1];
    expect(code).toBeDefined();
    expect(body).toContain(`verification code is ${code}.`);
    expect(body).toContain("expires in");
    expect(body).not.toContain("{{");
    expect(body).not.toMatch(/code is \./);
    expect(body).toContain("Toko Tiga Satu Satu");
  });
});
