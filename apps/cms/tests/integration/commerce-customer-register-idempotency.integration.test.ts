/**
 * Registration / login double-submit safety (Issue #513, work unit B) against
 * a REAL migrated PostgreSQL, through `tests/integration/harness.ts` and the
 * real runtime role (`awcms_app`, subject to FORCE RLS) - the same world
 * `commerce-customer-auth.integration.test.ts` uses. The application layer is
 * driven directly (the routes only map outcomes to HTTP; their shape is
 * covered by `commerce-customer-otp-verify-route.test.ts`).
 *
 * Every race here runs on a dedicated pool (`createRuntimePool`) so the
 * transactions really are in flight at the same time.
 *
 * What is pinned:
 *   a. two concurrent `otp/verify` with the same valid code (single use),
 *   b. the same request retried serially after the first one succeeded,
 *   c. two concurrent / back-to-back `otp/request` for the same registration,
 *   d. concurrent account creation for one phone (unique-constraint race),
 * plus the `Idempotency-Key` contract (replay with a FRESH session, conflict on
 * a different request, tenant isolation, nothing secret persisted).
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
  type VerifyCustomerOtpOutcome
} from "../../src/modules/commerce/application/customer-auth";
import {
  createAccountForCustomer,
  findAccountByEmail
} from "../../src/modules/commerce/application/customer-account-store";
import type {
  CustomerOtpChannel,
  CustomerOtpChannelRequest
} from "../../src/modules/commerce/domain/customer-otp-channel";
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
const META = { clientIpHash: null, userAgentSummary: "test-agent" };
const KEY = "attempt-0123456789abcdef-A";

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

type Reg = { email: string; name: string; phone: string };
const BUDI: Reg = {
  email: "budi@example.com",
  name: "Budi",
  phone: "081234567890"
};

function requestRegister(
  reg: Reg,
  channel: CustomerOtpChannel,
  tenantId = TENANT_A,
  now?: Date
) {
  return inTenant(tenantId, (tx) =>
    requestCustomerOtp(
      tx,
      tenantId,
      "Toko",
      {
        email: reg.email,
        purpose: "register",
        name: reg.name,
        phone: reg.phone
      },
      channel,
      undefined,
      now
    )
  );
}

/** Issues a registration code and returns it. */
async function issueCode(
  reg: Reg,
  tenantId = TENANT_A
): Promise<{ code: string }> {
  const { channel, sent } = capturingChannel();
  await requestRegister(reg, channel, tenantId);
  expect(sent).toHaveLength(1);
  return { code: sent[0]!.code };
}

function verify(
  email: string,
  code: string,
  options?: { idempotencyKey?: string | null },
  tenantId = TENANT_A,
  purpose: "register" | "login" = "register"
): Promise<VerifyCustomerOtpOutcome> {
  return inTenant(tenantId, (tx) =>
    (
      verifyCustomerOtp as (
        ...args: unknown[]
      ) => Promise<VerifyCustomerOtpOutcome>
    )(
      tx,
      tenantId,
      { email, code, purpose },
      META,
      undefined,
      undefined,
      options
    )
  );
}

async function count(sqlText: string, tenantId = TENANT_A): Promise<number> {
  const admin = getAdminSql();
  const rows = await admin.unsafe(sqlText, [tenantId]);
  return Number((rows[0] as { n: number | string }).n);
}

const accounts = () =>
  count(
    "SELECT count(*)::int AS n FROM awcms_commerce_customer_accounts WHERE tenant_id = $1"
  );
const audits = (action: string) =>
  count(
    `SELECT count(*)::int AS n FROM awcms_audit_events WHERE tenant_id = $1 AND action = '${action}'`
  );
const sessions = () =>
  count(
    "SELECT count(*)::int AS n FROM awcms_commerce_customer_sessions WHERE tenant_id = $1"
  );
const idempotencyRows = (tenantId = TENANT_A) =>
  count(
    "SELECT count(*)::int AS n FROM awcms_idempotency_keys WHERE tenant_id = $1 AND request_scope = 'commerce.customer_otp_verify'",
    tenantId
  );

function kinds(outcomes: VerifyCustomerOtpOutcome[]): string[] {
  return outcomes.map((o) => o.kind).sort();
}

suite("commerce customer register idempotency (Issue #513)", () => {
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
  // (a) concurrent verify, same code
  // -------------------------------------------------------------------------

  test("(a) two concurrent verifies with the same code and NO key: the code is single-use - one success, one otp_invalid, one account", async () => {
    const { code } = await issueCode(BUDI);

    const outcomes = await Promise.all([
      verify(BUDI.email, code),
      verify(BUDI.email, code)
    ]);

    expect(kinds(outcomes)).toEqual(["otp_invalid", "success"]);
    expect(await accounts()).toBe(1);
    expect(await audits("commerce.customer.account_registered")).toBe(1);
    expect(await sessions()).toBe(1);
  });

  test("(a) two concurrent verifies with the same code AND the same key: one account, one account_registered event, both answer success with DISTINCT fresh sessions", async () => {
    const { code } = await issueCode(BUDI);

    const outcomes = await Promise.all([
      verify(BUDI.email, code, { idempotencyKey: KEY }),
      verify(BUDI.email, code, { idempotencyKey: KEY })
    ]);

    expect(kinds(outcomes)).toEqual(["success", "success"]);
    const [first, second] = outcomes as Extract<
      VerifyCustomerOtpOutcome,
      { kind: "success" }
    >[];
    expect(first!.account.id).toBe(second!.account.id);
    expect(first!.token).not.toBe(second!.token);
    expect(await accounts()).toBe(1);
    expect(await audits("commerce.customer.account_registered")).toBe(1);
    expect(await sessions()).toBe(2);
    expect(await idempotencyRows()).toBe(1);
  });

  // -------------------------------------------------------------------------
  // (b) serial retry after the first response was lost
  // -------------------------------------------------------------------------

  test("(b) the same request retried serially with the same key replays: success, same account, a FRESH session, replayed flag", async () => {
    const { code } = await issueCode(BUDI);

    const first = await verify(BUDI.email, code, { idempotencyKey: KEY });
    const retry = await verify(BUDI.email, code, { idempotencyKey: KEY });

    expect(first.kind).toBe("success");
    expect(retry.kind).toBe("success");
    if (first.kind !== "success" || retry.kind !== "success") return;
    expect(retry.account.id).toBe(first.account.id);
    expect(retry.token).not.toBe(first.token);
    expect(retry.replayed).toBe(true);
    expect(first.replayed ?? false).toBe(false);
    expect(await accounts()).toBe(1);
    expect(await audits("commerce.customer.account_registered")).toBe(1);
    expect(await audits("commerce.customer.otp_verify_replayed")).toBe(1);
  });

  test("(b) the same request retried serially WITHOUT a key stays otp_invalid (the code is single-use)", async () => {
    const { code } = await issueCode(BUDI);
    expect((await verify(BUDI.email, code)).kind).toBe("success");
    expect((await verify(BUDI.email, code)).kind).toBe("otp_invalid");
    expect(await accounts()).toBe(1);
  });

  test("(b) a login replays the same way", async () => {
    const reg = await issueCode(BUDI);
    expect((await verify(BUDI.email, reg.code)).kind).toBe("success");

    const { channel, sent } = capturingChannel();
    await inTenant(TENANT_A, (tx) =>
      requestCustomerOtp(
        tx,
        TENANT_A,
        "Toko",
        { email: BUDI.email, purpose: "login" },
        channel
      )
    );
    const code = sent[0]!.code;
    const first = await verify(
      BUDI.email,
      code,
      { idempotencyKey: KEY },
      TENANT_A,
      "login"
    );
    const retry = await verify(
      BUDI.email,
      code,
      { idempotencyKey: KEY },
      TENANT_A,
      "login"
    );
    expect(first.kind).toBe("success");
    expect(retry.kind).toBe("success");
    if (first.kind !== "success" || retry.kind !== "success") return;
    expect(retry.account.id).toBe(first.account.id);
    expect(retry.token).not.toBe(first.token);
    expect(retry.replayed).toBe(true);
  });

  test("the same key with a DIFFERENT code or a different e-mail is idempotency_conflict, and nothing else changes", async () => {
    const { code } = await issueCode(BUDI);
    expect((await verify(BUDI.email, code, { idempotencyKey: KEY })).kind).toBe(
      "success"
    );

    const otherCode = code === "000000" ? "111111" : "000000";
    expect(
      (await verify(BUDI.email, otherCode, { idempotencyKey: KEY })).kind
    ).toBe("idempotency_conflict");
    expect(
      (await verify("lain@example.com", code, { idempotencyKey: KEY })).kind
    ).toBe("idempotency_conflict");
    expect(await accounts()).toBe(1);
    expect(await sessions()).toBe(1);
  });

  test("a failed verify (wrong code) with a key stores nothing, so the right code under the same key still works", async () => {
    const { code } = await issueCode(BUDI);
    const wrong = code === "000000" ? "111111" : "000000";
    expect(
      (await verify(BUDI.email, wrong, { idempotencyKey: KEY })).kind
    ).toBe("otp_invalid");
    expect(await idempotencyRows()).toBe(0);
    expect((await verify(BUDI.email, code, { idempotencyKey: KEY })).kind).toBe(
      "success"
    );
  });

  test("a record older than the replay window is ignored: the request is an ordinary verify (single-use code -> otp_invalid)", async () => {
    const { code } = await issueCode(BUDI);
    expect((await verify(BUDI.email, code, { idempotencyKey: KEY })).kind).toBe(
      "success"
    );
    await getAdminSql()`
      UPDATE awcms_idempotency_keys
      SET created_at = now() - interval '11 minutes'
      WHERE tenant_id = ${TENANT_A} AND request_scope = 'commerce.customer_otp_verify'
    `;
    expect((await verify(BUDI.email, code, { idempotencyKey: KEY })).kind).toBe(
      "otp_invalid"
    );
    expect(await accounts()).toBe(1);
  });

  test("a replay for an account that was blocked in the meantime is blocked, never a session", async () => {
    const { code } = await issueCode(BUDI);
    expect((await verify(BUDI.email, code, { idempotencyKey: KEY })).kind).toBe(
      "success"
    );
    await getAdminSql()`
      UPDATE awcms_commerce_customer_accounts SET status = 'blocked'
      WHERE tenant_id = ${TENANT_A}
    `;
    expect((await verify(BUDI.email, code, { idempotencyKey: KEY })).kind).toBe(
      "blocked"
    );
    expect(await sessions()).toBe(1);
  });

  test("nothing secret is persisted: no raw key, no code, no session token in the idempotency row", async () => {
    const { code } = await issueCode(BUDI);
    const outcome = await verify(BUDI.email, code, { idempotencyKey: KEY });
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;

    const rows = await getAdminSql()`
      SELECT * FROM awcms_idempotency_keys
      WHERE tenant_id = ${TENANT_A} AND request_scope = 'commerce.customer_otp_verify'
    `;
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows[0]);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain(outcome.token);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(BUDI.email);
    expect(JSON.stringify(rows[0]!.response_body)).toBe(
      JSON.stringify({
        outcome: "session_issued",
        accountId: outcome.account.id
      })
    );
    expect(String(rows[0]!.idempotency_key)).toMatch(/^[0-9a-f]{64}$/);

    const audit = await getAdminSql()`
      SELECT attributes, message FROM awcms_audit_events WHERE tenant_id = ${TENANT_A}
    `;
    const auditDump = JSON.stringify(audit);
    expect(auditDump).not.toContain(KEY);
    expect(auditDump).not.toContain(outcome.token);
    expect(auditDump).not.toContain(code);
  });

  test("tenant isolation: tenant B neither replays nor sees tenant A's record; RLS hides it from B's runtime transaction", async () => {
    const regA = await issueCode(BUDI, TENANT_A);
    const a = await verify(BUDI.email, regA.code, { idempotencyKey: KEY });
    expect(a.kind).toBe("success");

    const regB = await issueCode(BUDI, TENANT_B);
    const b = await verify(
      BUDI.email,
      regB.code,
      { idempotencyKey: KEY },
      TENANT_B
    );
    expect(b.kind).toBe("success");
    if (a.kind !== "success" || b.kind !== "success") return;
    expect(b.replayed ?? false).toBe(false);
    expect(b.account.id).not.toBe(a.account.id);
    expect(await idempotencyRows(TENANT_A)).toBe(1);
    expect(await idempotencyRows(TENANT_B)).toBe(1);

    const seenByB = await inTenant(
      TENANT_B,
      (tx) =>
        tx`SELECT tenant_id FROM awcms_idempotency_keys WHERE request_scope = 'commerce.customer_otp_verify'`
    );
    expect(
      seenByB.every((r: { tenant_id: string }) => r.tenant_id === TENANT_B)
    ).toBe(true);
    expect(seenByB).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // (c) otp/request double submit
  // -------------------------------------------------------------------------

  test("(c) two concurrent otp/request for the same registration send ONE message", async () => {
    const { channel, sent } = capturingChannel();
    const outcomes = await Promise.all([
      requestRegister(BUDI, channel),
      requestRegister(BUDI, channel)
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual(["sent", "sent"]);
    expect(sent).toHaveLength(1);

    // the one code that was sent is the live one
    expect((await verify(BUDI.email, sent[0]!.code)).kind).toBe("success");
  });

  test("(c) a second otp/request inside the resend window is a same-shape no-op success; after the window, or with a different registration, a new code goes out", async () => {
    const { channel, sent } = capturingChannel();
    const t0 = new Date();
    const first = await requestRegister(BUDI, channel, TENANT_A, t0);
    const dup = await requestRegister(
      BUDI,
      channel,
      TENANT_A,
      new Date(t0.getTime() + 20_000)
    );
    expect(first.kind).toBe("sent");
    expect(dup.kind).toBe("sent");
    expect(Object.keys(dup).sort()).toEqual(Object.keys(first).sort());
    expect(sent).toHaveLength(1);
    expect(await audits("commerce.customer.otp_requested")).toBe(1);

    // a corrected phone number is a different registration: new code
    await requestRegister(
      { ...BUDI, phone: "081200000001" },
      channel,
      TENANT_A,
      new Date(t0.getTime() + 25_000)
    );
    expect(sent).toHaveLength(2);

    // past the window, the same registration gets a new code
    await requestRegister(
      { ...BUDI, phone: "081200000001" },
      channel,
      TENANT_A,
      new Date(t0.getTime() + 25_000 + 61_000)
    );
    expect(sent).toHaveLength(3);
    // and the superseded codes are dead: only the newest verifies
    expect((await verify(BUDI.email, sent[0]!.code)).kind).toBe("otp_invalid");
  });

  test("(c) the resend window is per (tenant, identifier, purpose): another e-mail and another tenant still get their own code", async () => {
    const { channel, sent } = capturingChannel();
    await requestRegister(BUDI, channel);
    await requestRegister({ ...BUDI, email: "ani@example.com" }, channel);
    await requestRegister(BUDI, channel, TENANT_B);
    expect(sent).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // (d) unique-constraint races
  // -------------------------------------------------------------------------

  test("(d) two registrations racing for ONE phone with different e-mails: one account, the loser is phone_already_registered (not an error)", async () => {
    const a = await issueCode(BUDI);
    const b = await issueCode({ ...BUDI, email: "ani@example.com" });

    const outcomes = await Promise.all([
      verify(BUDI.email, a.code),
      verify("ani@example.com", b.code)
    ]);

    expect(kinds(outcomes)).toEqual(["phone_already_registered", "success"]);
    expect(await accounts()).toBe(1);
    expect(await audits("commerce.customer.account_registered")).toBe(1);
  });

  test("(d) createAccountForCustomer racing on one phone: exactly one account; the loser gets the typed unique-violation error, not a raw database error", async () => {
    const results = await Promise.allSettled([
      inTenant(TENANT_A, (tx) =>
        createAccountForCustomer(tx, TENANT_A, {
          name: "Budi",
          phone: "+6281234567890",
          emailNormalized: "budi@example.com"
        })
      ),
      inTenant(TENANT_A, (tx) =>
        createAccountForCustomer(tx, TENANT_A, {
          name: "Budi",
          phone: "+6281234567890",
          emailNormalized: "budi@example.com"
        })
      )
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as
      PromiseRejectedResult | undefined;
    expect(rejected).toBeDefined();
    expect((rejected!.reason as Error).name).toBe(
      "CustomerAccountUniqueViolationError"
    );
    expect(await accounts()).toBe(1);
  });

  test("(d) a registration whose e-mail already has an account is a login, even with a different phone (never PHONE_ALREADY_REGISTERED)", async () => {
    const first = await issueCode(BUDI);
    expect((await verify(BUDI.email, first.code)).kind).toBe("success");

    const again = await issueCode({ ...BUDI, phone: "081200000002" });
    const outcome = await verify(BUDI.email, again.code);
    expect(outcome.kind).toBe("success");
    expect(await accounts()).toBe(1);
    expect(await audits("commerce.customer.account_registered")).toBe(1);
  });

  test("(d) the phone of another e-mail's account is still PHONE_ALREADY_REGISTERED", async () => {
    const first = await issueCode(BUDI);
    expect((await verify(BUDI.email, first.code)).kind).toBe("success");

    const other = await issueCode({ ...BUDI, email: "ani@example.com" });
    expect((await verify("ani@example.com", other.code)).kind).toBe(
      "phone_already_registered"
    );
    expect(
      await inTenant(TENANT_A, (tx) =>
        findAccountByEmail(tx, TENANT_A, "ani@example.com")
      )
    ).toBeNull();
  });
});
