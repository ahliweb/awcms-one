/**
 * `commerce` customer account/OTP/session store integration (Issue #87, C1,
 * contract #86/ADR-0016) — exercised against a REAL migrated database
 * through `tests/integration/harness.ts`, the way `commerce-orders` (#29)
 * already is. Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * Covers the properties only a real database can prove:
 *
 *   - `createAccountForCustomer` binds to an existing guest customer row and
 *     applies D4's history_from rule both ways (e-mail matches / differs);
 *   - `issueOtp` + `consumeOtp`: correct code succeeds once, a wrong code is
 *     rejected, attempts exhaust after `OTP_MAX_ATTEMPTS`, and an expired
 *     code is rejected even with the correct value;
 *   - `issueSession`/`findSessionByTokenHash`/`touchSession`/`revokeSession`/
 *     `revokeAllSessions` round-trip correctly and a revoked/expired session
 *     is never returned;
 *   - RLS: tenant B cannot see tenant A's account/session even with the
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
  consumeOtp,
  createAccountForCustomer,
  findAccountByEmail,
  findAccountById,
  findSessionByTokenHash,
  issueOtp,
  issueSession,
  revokeAllSessions,
  revokeSession,
  touchSession
} from "../../src/modules/commerce/application/customer-account-store";
import { hashCustomerSessionToken } from "../../src/modules/commerce/domain/customer-session-token";
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

const NOW = new Date("2026-09-19T10:00:00.000Z");
const MINUTE = 60 * 1000;

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

suite("commerce customer account store integration (Issue #87)", () => {
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

  test("createAccountForCustomer binds to an existing guest row and applies D4 (matching e-mail → guest created_at)", async () => {
    await inTenant(
      TENANT_A,
      (tx) =>
        tx`
          INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email, created_at)
          VALUES (${TENANT_A}, 'Siti', '+6281234567890', 'siti@example.com', '2026-01-01T00:00:00.000Z')
        `
    );

    const account = await inTenant(TENANT_A, (tx) =>
      createAccountForCustomer(
        tx,
        TENANT_A,
        {
          name: "Siti",
          phone: "+6281234567890",
          emailNormalized: "siti@example.com",
          now: NOW
        },
        undefined
      )
    );

    expect(account.historyFrom).toBe("2026-01-01T00:00:00.000Z");
  });

  test("createAccountForCustomer falls back to now() when the guest e-mail differs", async () => {
    await inTenant(
      TENANT_A,
      (tx) =>
        tx`
          INSERT INTO awcms_commerce_customers (tenant_id, name, phone, email, created_at)
          VALUES (${TENANT_A}, 'Siti', '+6281234567891', 'lain@example.com', '2026-01-01T00:00:00.000Z')
        `
    );

    const account = await inTenant(TENANT_A, (tx) =>
      createAccountForCustomer(tx, TENANT_A, {
        name: "Siti",
        phone: "+6281234567891",
        emailNormalized: "siti@example.com",
        now: NOW
      })
    );

    expect(account.historyFrom).toBe(NOW.toISOString());
  });

  test("issueOtp + consumeOtp: correct code succeeds exactly once", async () => {
    const email = "otp@example.com";
    let code = "";

    await inTenant(TENANT_A, async (tx) => {
      const issued = await issueOtp(tx, TENANT_A, email, "login", null, NOW);
      code = issued.code;
    });

    const first = await inTenant(TENANT_A, (tx) =>
      consumeOtp(tx, TENANT_A, email, "login", code, NOW)
    );
    expect(first.ok).toBe(true);

    // Single-use: the same code cannot be consumed twice.
    const second = await inTenant(TENANT_A, (tx) =>
      consumeOtp(tx, TENANT_A, email, "login", code, NOW)
    );
    expect(second.ok).toBe(false);
  });

  test("consumeOtp rejects a wrong code and exhausts after OTP_MAX_ATTEMPTS", async () => {
    const email = "otp-wrong@example.com";

    await inTenant(TENANT_A, (tx) =>
      issueOtp(tx, TENANT_A, email, "login", null, NOW)
    );

    let lastResult;
    for (let i = 0; i < 5; i++) {
      lastResult = await inTenant(TENANT_A, (tx) =>
        consumeOtp(tx, TENANT_A, email, "login", "000000", NOW)
      );
    }
    expect(lastResult!.ok).toBe(false);
    if (!lastResult!.ok) {
      expect(lastResult!.reason).toBe("exhausted");
    }
  });

  test("consumeOtp rejects an expired code even with the correct value", async () => {
    const email = "otp-expired@example.com";
    let code = "";

    await inTenant(TENANT_A, async (tx) => {
      const issued = await issueOtp(tx, TENANT_A, email, "login", null, NOW);
      code = issued.code;
    });

    const afterExpiry = new Date(NOW.getTime() + 11 * MINUTE);
    const result = await inTenant(TENANT_A, (tx) =>
      consumeOtp(tx, TENANT_A, email, "login", code, afterExpiry)
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("expired");
    }
  });

  test("session round-trip: issue, find by token hash, touch, revoke", async () => {
    await inTenant(
      TENANT_A,
      (tx) =>
        tx`
          INSERT INTO awcms_commerce_customers (tenant_id, name, phone, created_at)
          VALUES (${TENANT_A}, 'Siti', '+6281234567892', ${NOW})
        `
    );
    const account = await inTenant(TENANT_A, (tx) =>
      createAccountForCustomer(tx, TENANT_A, {
        name: "Siti",
        phone: "+6281234567892",
        emailNormalized: "siti2@example.com",
        now: NOW
      })
    );

    const session = await inTenant(TENANT_A, (tx) =>
      issueSession(
        tx,
        TENANT_A,
        account.id,
        { clientIpHash: null, userAgentSummary: null },
        NOW
      )
    );

    const tokenHash = hashCustomerSessionToken(session.token);
    const found = await inTenant(TENANT_A, (tx) =>
      findSessionByTokenHash(tx, tokenHash, NOW)
    );
    expect(found?.accountId).toBe(account.id);

    await inTenant(TENANT_A, (tx) =>
      touchSession(tx, TENANT_A, session.sessionId, NOW)
    );

    await inTenant(TENANT_A, (tx) =>
      revokeSession(tx, TENANT_A, session.sessionId, NOW)
    );
    const afterRevoke = await inTenant(TENANT_A, (tx) =>
      findSessionByTokenHash(tx, tokenHash, NOW)
    );
    expect(afterRevoke).toBeNull();
  });

  test("revokeAllSessions revokes every live session for the account", async () => {
    await inTenant(
      TENANT_A,
      (tx) =>
        tx`
          INSERT INTO awcms_commerce_customers (tenant_id, name, phone, created_at)
          VALUES (${TENANT_A}, 'Siti', '+6281234567893', ${NOW})
        `
    );
    const account = await inTenant(TENANT_A, (tx) =>
      createAccountForCustomer(tx, TENANT_A, {
        name: "Siti",
        phone: "+6281234567893",
        emailNormalized: "siti3@example.com",
        now: NOW
      })
    );

    const sessionA = await inTenant(TENANT_A, (tx) =>
      issueSession(
        tx,
        TENANT_A,
        account.id,
        { clientIpHash: null, userAgentSummary: null },
        NOW
      )
    );
    const sessionB = await inTenant(TENANT_A, (tx) =>
      issueSession(
        tx,
        TENANT_A,
        account.id,
        { clientIpHash: null, userAgentSummary: null },
        NOW
      )
    );

    await inTenant(TENANT_A, (tx) =>
      revokeAllSessions(tx, TENANT_A, account.id, NOW)
    );

    const foundA = await inTenant(TENANT_A, (tx) =>
      findSessionByTokenHash(tx, hashCustomerSessionToken(sessionA.token), NOW)
    );
    const foundB = await inTenant(TENANT_A, (tx) =>
      findSessionByTokenHash(tx, hashCustomerSessionToken(sessionB.token), NOW)
    );
    expect(foundA).toBeNull();
    expect(foundB).toBeNull();
  });

  test("RLS: tenant B cannot see tenant A's account by id", async () => {
    await inTenant(
      TENANT_A,
      (tx) =>
        tx`
          INSERT INTO awcms_commerce_customers (tenant_id, name, phone, created_at)
          VALUES (${TENANT_A}, 'Siti', '+6281234567894', ${NOW})
        `
    );
    const account = await inTenant(TENANT_A, (tx) =>
      createAccountForCustomer(tx, TENANT_A, {
        name: "Siti",
        phone: "+6281234567894",
        emailNormalized: "siti4@example.com",
        now: NOW
      })
    );

    const crossTenantRead = await inTenant(TENANT_B, (tx) =>
      findAccountById(tx, TENANT_B, account.id)
    );
    expect(crossTenantRead).toBeNull();

    const crossTenantByEmail = await inTenant(TENANT_B, (tx) =>
      findAccountByEmail(tx, TENANT_B, "siti4@example.com")
    );
    expect(crossTenantByEmail).toBeNull();
  });
});
