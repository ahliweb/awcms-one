/**
 * The guarded per-tenant WhatsApp mode flip against a REAL migrated PostgreSQL
 * (Issue #393, ADR-0133 section 6 phase 3, ADR-0047 "Cutover"). WORLD 1 (see
 * `harness.ts`): the ephemeral database, the least-privilege `awcms_app` role,
 * RLS enforced. The route and CLI wiring are
 * `commerce-whatsapp-cutover-routes.integration.test.ts`.
 *
 * What is proved:
 *
 *   - the flip into `upstream` is REFUSED while the legacy queue holds a
 *     `queued` or `sending` row (and a row that is `queued` again for a retry),
 *     with the counts per status and the age of the oldest row, and a refusal
 *     writes nothing but the audit event of the refused attempt;
 *   - it is ALLOWED once the real legacy dispatcher has taken those rows to a
 *     terminal state, a `failed` row does not block, and the new mode sends the
 *     next message to the other queue without touching the old rows (no copy, no
 *     dual write);
 *   - the flip is AUDITED (actor, reason, counts) and the evidence names the
 *     audit row; a dry run writes nothing at all;
 *   - a flip into a dead channel (flag off, module off, no key ring, no provider)
 *     is refused, and the warnings must be acknowledged;
 *   - the reverse flip waits for the upstream queue, `retry_wait` included;
 *   - TWO LIVE QUEUES FOR ONE TENANT NEVER COEXIST: an enqueue in flight when the
 *     flip starts is counted (the flip waits, then refuses); an enqueue that
 *     starts while the flip holds the lock waits, then lands in the NEW queue;
 *     and a flip racing an enqueue many times over always ends with exactly one
 *     message in exactly the queue the final mode names;
 *   - one tenant's rows never block or leak into another tenant's flip (RLS).
 *
 * Gated on `DATABASE_URL` (harness). Never hands a Bun.SQL query to
 * `expect(...).rejects` (it spins the process at 100% CPU): it awaits in try/catch.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { createAccountForCustomer } from "../../src/modules/commerce/application/customer-account-store";
import { updateMarketingConsent } from "../../src/modules/commerce/application/customer-auth";
import { findOrCreateCustomerByPhone } from "../../src/modules/commerce/application/customer-directory";
import { resetStoreSettings } from "../../src/modules/commerce/application/store-settings-directory";
import { dispatchWhatsappQueue as dispatchLegacyQueue } from "../../src/modules/commerce/application/whatsapp-dispatch";
import { enqueueWhatsappMessage } from "../../src/modules/commerce/application/whatsapp-enqueue";
import { summarizeLegacyWhatsappQueue } from "../../src/modules/commerce/application/whatsapp-message-directory";
import {
  lockWhatsappModeExclusive,
  readWhatsappMode
} from "../../src/modules/commerce/application/whatsapp-mode";
import {
  flipWhatsappMode,
  readWhatsappModeStatus,
  UPSTREAM_DRAIN_PAGE_LIMIT,
  type FlipOptions,
  type FlipResult
} from "../../src/modules/commerce/application/whatsapp-mode-flip";
import type { WhatsappMode } from "../../src/modules/commerce/domain/whatsapp-mode";
import { dispatchWhatsappQueue as dispatchUpstreamQueue } from "../../src/modules/whatsapp-delivery/application/whatsapp-dispatch";
import {
  getAdminSql,
  getRuntimeSql,
  getWorkerRoleSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "39300000-0000-4000-8000-00000000000a";
const TENANT_B = "39300000-0000-4000-8000-00000000000b";
const STAFF = "39300000-0000-4000-8000-0000000000c1";
const PHONE = "+6281234567890";

const KEY = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 13 + 7) % 251)
).toString("base64");

const ENV_KEYS = [
  "WHATSAPP_ENABLED",
  "WHATSAPP_PROVIDER",
  "WHATSAPP_RECIPIENT_HASH_KEYS",
  "COMMERCE_WHATSAPP_ENABLED",
  "COMMERCE_WHATSAPP_PROVIDER"
] as const;
const SAVED: Record<string, string | undefined> = {};

function setEnv() {
  process.env.WHATSAPP_ENABLED = "true";
  process.env.WHATSAPP_PROVIDER = "log";
  process.env.WHATSAPP_RECIPIENT_HASH_KEYS = `k1:${KEY}`;
  process.env.COMMERCE_WHATSAPP_ENABLED = "true";
  process.env.COMMERCE_WHATSAPP_PROVIDER = "log";
}

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedStaff(tenantId: string): Promise<void> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Cutover Test Actor')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`cutover-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  await admin`
    INSERT INTO awcms_tenant_users (id, tenant_id, identity_id)
    VALUES (${STAFF}, ${tenantId}, ${identity[0]!.id})
    ON CONFLICT (id) DO NOTHING
  `;
}

const inTenant = <T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
) => withTenantOrThrow(getRuntimeSql(), tenantId, fn);

const OTP_VARIABLES = {
  code: "246810",
  expiresInMinutes: "10",
  storeName: "Toko A"
};

/** One legacy-or-upstream message, whichever queue the tenant's mode names. */
function enqueueOtp(
  tx: Bun.TransactionSQL,
  tenantId: string,
  correlationId: string,
  phone = PHONE
) {
  return enqueueWhatsappMessage(tx, {
    tenantId,
    toPhone: phone,
    templateKey: "commerce.customer_otp",
    variables: OTP_VARIABLES,
    correlationId
  });
}

async function enqueueMany(tenantId: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    await inTenant(tenantId, (tx) =>
      enqueueOtp(tx, tenantId, `seed-${index}`, `+628123456${7000 + index}`)
    );
  }
}

function flip(
  tenantId: string,
  target: WhatsappMode,
  over: Partial<FlipOptions> = {}
): Promise<FlipResult> {
  return inTenant(tenantId, (tx) =>
    flipWhatsappMode(
      tx,
      tenantId,
      { tenantUserId: STAFF, surface: "api" },
      target,
      {
        reason: "integration test",
        acknowledgeWarnings: true,
        env: process.env,
        ...over
      }
    )
  );
}

type Counts = { legacy: number; upstream: number; audit: number };

async function counts(tenantId: string): Promise<Counts> {
  const admin = getAdminSql();
  const rows = (await admin`
    SELECT
      (SELECT count(*) FROM awcms_commerce_whatsapp_messages WHERE tenant_id = ${tenantId}) AS legacy,
      (SELECT count(*) FROM awcms_whatsapp_messages WHERE tenant_id = ${tenantId}) AS upstream,
      (SELECT count(*) FROM awcms_audit_events
        WHERE tenant_id = ${tenantId} AND action LIKE 'whatsapp_mode.%') AS audit
  `) as { legacy: string; upstream: string; audit: string }[];

  return {
    legacy: Number(rows[0]!.legacy),
    upstream: Number(rows[0]!.upstream),
    audit: Number(rows[0]!.audit)
  };
}

async function modeRow(tenantId: string) {
  const rows = (await getAdminSql()`
    SELECT whatsapp_mode, whatsapp_mode_changed_at, deleted_at, settings
    FROM awcms_commerce_store_settings WHERE tenant_id = ${tenantId}
  `) as {
    whatsapp_mode: string;
    whatsapp_mode_changed_at: Date | null;
    deleted_at: Date | null;
    settings: Record<string, unknown>;
  }[];

  return rows[0] ?? null;
}

async function auditRows(tenantId: string) {
  return (await getAdminSql()`
    SELECT id, action, severity, actor_tenant_user_id, resource_type, resource_id,
           message, attributes, correlation_id
    FROM awcms_audit_events
    WHERE tenant_id = ${tenantId} AND action LIKE 'whatsapp_mode.%'
    ORDER BY created_at, id
  `) as {
    id: string;
    action: string;
    severity: string;
    actor_tenant_user_id: string | null;
    resource_type: string;
    resource_id: string;
    message: string;
    attributes: Record<string, unknown>;
    correlation_id: string;
  }[];
}

async function setLegacyStatus(tenantId: string, status: string, limit = 1) {
  await getAdminSql()`
    UPDATE awcms_commerce_whatsapp_messages SET status = ${status}
    WHERE id IN (
      SELECT id FROM awcms_commerce_whatsapp_messages
      WHERE tenant_id = ${tenantId} AND status = 'queued' LIMIT ${limit}
    )
  `;
}

const failingRetryable = () => ({
  async send() {
    return { ok: false as const, error: "boom", retryable: true };
  },
  async healthCheck() {
    return { ok: true as const };
  }
});
const failingTerminal = () => ({
  async send() {
    return { ok: false as const, error: "bad number", retryable: false };
  },
  async healthCheck() {
    return { ok: true as const };
  }
});

/** Polls until some session is waiting on an advisory lock, instead of sleeping and hoping. */
async function waitForLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = (await getAdminSql()`
      SELECT count(*) AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
    `) as { waiting: string }[];
    if (Number(rows[0]!.waiting) > 0) return;
    await Bun.sleep(50);
  }
  throw new Error("no session ever waited on the mode lock");
}

async function seedOptedInAccount(tenantId: string, phone: string) {
  await inTenant(tenantId, async (tx) => {
    await findOrCreateCustomerByPhone(tx, tenantId, "Shopper", phone, null);
    const account = await createAccountForCustomer(tx, tenantId, {
      name: "Shopper",
      phone,
      emailNormalized: `${phone.replace(/\D/g, "")}@example.test`
    });
    await updateMarketingConsent(tx, tenantId, account, true);
  });
}

/** A queued row of ANOTHER module in the shared upstream queue (a booking reminder), written straight into the table. */
async function seedForeignUpstreamRows(
  tenantId: string,
  count: number,
  status = "queued"
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_whatsapp_messages
      (tenant_id, idempotency_key, template_key, purpose, recipient,
       recipient_hash, recipient_masked, body, status)
    SELECT ${tenantId}, 'booking:reminder:' || ${status} || ':' || n, 'booking.reminder',
           'transactional', '+6281200000000', 'hash-' || ${status} || n, '+62812****0000',
           'Reminder', ${status}
    FROM generate_series(1, ${count}) AS n
  `;
}

suite("the guarded WhatsApp mode flip (Issue #393)", () => {
  beforeAll(async () => {
    for (const name of ENV_KEYS) SAVED[name] = process.env[name];
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    for (const name of ENV_KEYS) {
      if (SAVED[name] === undefined) delete process.env[name];
      else process.env[name] = SAVED[name];
    }
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    setEnv();
    await resetDatabase();
    await seedTenant(TENANT_A, "tenant-a");
    await seedTenant(TENANT_B, "tenant-b");
    await seedStaff(TENANT_A);
  }, 30000);

  afterEach(() => setEnv());

  // -------------------------------------------------------------------------
  describe("refused while the legacy queue is not drained", () => {
    test("queued rows: DRAIN_PENDING with the counts per status and the oldest age, and nothing is written but the refused attempt's audit event", async () => {
      await enqueueMany(TENANT_A, 3);
      await getAdminSql()`
        UPDATE awcms_commerce_whatsapp_messages
        SET created_at = now() - interval '2 hours' WHERE tenant_id = ${TENANT_A}
      `;
      await setLegacyStatus(TENANT_A, "sent", 1);

      const result = await flip(TENANT_A, "upstream");

      expect(result.outcome).toBe("refused");
      expect(result.evidence.refusal?.code).toBe("DRAIN_PENDING");
      expect(result.evidence.queues.legacy.countsByStatus).toEqual({
        queued: 2,
        sent: 1
      });
      expect(result.evidence.queues.legacy.nonTerminal).toBe(2);
      expect(
        result.evidence.queues.legacy.oldestNonTerminalAgeSeconds
      ).toBeGreaterThanOrEqual(7200);
      expect(result.evidence.blockers[0]?.code).toBe("DRAIN_PENDING");

      // Nothing moved: no settings row was created, no message was written.
      expect(await modeRow(TENANT_A)).toBeNull();
      expect(await counts(TENANT_A)).toEqual({
        legacy: 3,
        upstream: 0,
        audit: 1
      });
      const [audit] = await auditRows(TENANT_A);
      expect(audit).toMatchObject({
        action: "whatsapp_mode.flip_refused",
        severity: "warning",
        actor_tenant_user_id: STAFF,
        resource_type: "commerce_whatsapp_mode",
        resource_id: TENANT_A
      });
      expect(audit!.id).toBe(result.evidence.auditEventId!);
      expect(audit!.attributes).toMatchObject({
        refusalCode: "DRAIN_PENDING",
        legacyNonTerminal: 2,
        reason: "integration test"
      });
    });

    test("a row the dispatcher is sending right now blocks too", async () => {
      await enqueueMany(TENANT_A, 1);
      await setLegacyStatus(TENANT_A, "sending");

      const result = await flip(TENANT_A, "upstream");

      expect(result.outcome).toBe("refused");
      expect(result.evidence.queues.legacy.countsByStatus).toEqual({
        sending: 1
      });
    });

    test("a row waiting for its retry (the legacy table's 'retry wait' is queued with a later next_attempt_at) blocks", async () => {
      await enqueueMany(TENANT_A, 1);
      const dispatched = await dispatchLegacyQueue(getRuntimeSql(), TENANT_A, {
        env: process.env,
        resolveProvider: failingRetryable
      });
      expect(dispatched).toMatchObject({ claimed: 1, retried: 1, sent: 0 });

      const result = await flip(TENANT_A, "upstream");

      expect(result.outcome).toBe("refused");
      expect(result.evidence.queues.legacy.countsByStatus).toEqual({
        queued: 1
      });
    });

    test("a failed row is terminal and does not block", async () => {
      await enqueueMany(TENANT_A, 2);
      await dispatchLegacyQueue(getRuntimeSql(), TENANT_A, {
        env: process.env,
        resolveProvider: failingTerminal
      });
      expect((await counts(TENANT_A)).legacy).toBe(2);

      const result = await flip(TENANT_A, "upstream");

      expect(result.outcome).toBe("flipped");
      expect(result.evidence.queues.legacy.countsByStatus).toEqual({
        failed: 2
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("allowed after the old dispatcher drains", () => {
    test("the real legacy dispatcher takes the rows to a terminal state, then the flip is allowed and the next message goes upstream", async () => {
      await enqueueMany(TENANT_A, 3);
      expect((await flip(TENANT_A, "upstream")).outcome).toBe("refused");
      expect(await readWhatsappModeFor(TENANT_A)).toBe("legacy");

      const drained = await dispatchLegacyQueue(getRuntimeSql(), TENANT_A, {
        env: process.env
      });
      expect(drained).toMatchObject({ claimed: 3, sent: 3 });

      const result = await flip(TENANT_A, "upstream");

      expect(result.outcome).toBe("flipped");
      expect(result.evidence).toMatchObject({
        from: "legacy",
        to: "upstream",
        dryRun: false,
        surface: "api",
        warningsAcknowledged: true,
        refusal: null
      });
      expect(result.evidence.queues.legacy.nonTerminal).toBe(0);
      expect(await readWhatsappModeFor(TENANT_A)).toBe("upstream");

      // No copy, no dual write: the three old rows stay where they are, and the
      // new message is ONE row in the other queue.
      await inTenant(TENANT_A, (tx) => enqueueOtp(tx, TENANT_A, "after-flip"));
      expect(await counts(TENANT_A)).toMatchObject({
        legacy: 3,
        upstream: 1
      });
    });

    test("the settings row is created with real settings when the tenant had none, and the mode columns are set", async () => {
      expect(await modeRow(TENANT_A)).toBeNull();

      await flip(TENANT_A, "upstream");

      const row = await modeRow(TENANT_A);
      expect(row).toMatchObject({
        whatsapp_mode: "upstream",
        deleted_at: null
      });
      expect(row!.whatsapp_mode_changed_at).toBeInstanceOf(Date);
      expect(row!.settings).toMatchObject({ storeName: "tenant-a Name" });
    });

    test("a store-settings row stamped by a reset is revived with real settings, so the retention purge cannot take the mode with it", async () => {
      await getAdminSql()`
        INSERT INTO awcms_commerce_store_settings (tenant_id, settings, deleted_at)
        VALUES (${TENANT_A}, '{"storeName": "Stale"}'::jsonb, now())
      `;

      await flip(TENANT_A, "upstream");

      const row = await modeRow(TENANT_A);
      expect(row!.deleted_at).toBeNull();
      expect(row!.whatsapp_mode).toBe("upstream");
      expect(row!.settings.storeName).not.toBe("Stale");
    });

    test("a live settings row keeps its blob and its other modes when the flip updates it", async () => {
      await getAdminSql()`
        INSERT INTO awcms_commerce_store_settings (tenant_id, settings)
        VALUES (${TENANT_A}, '{"storeName": "Kept"}'::jsonb)
      `;

      await flip(TENANT_A, "upstream");

      const row = await modeRow(TENANT_A);
      expect(row!.settings).toEqual({ storeName: "Kept" });
      expect(row!.whatsapp_mode).toBe("upstream");

      // And a later "reset my store" does not move the tenant back.
      await inTenant(TENANT_A, (tx) => resetStoreSettings(tx, TENANT_A, STAFF));
      expect(await readWhatsappModeFor(TENANT_A)).toBe("upstream");
    });
  });

  // -------------------------------------------------------------------------
  describe("audit and dry run", () => {
    test("a flip is audited: actor, reason, counts, severity, and the evidence names the audit row", async () => {
      const result = await flip(TENANT_A, "upstream", {
        reason: "  cutover wave 1  ",
        correlationId: "corr-flip-1"
      });

      const [audit, ...rest] = await auditRows(TENANT_A);
      expect(rest).toEqual([]);
      expect(audit).toMatchObject({
        action: "whatsapp_mode.flip",
        severity: "warning",
        actor_tenant_user_id: STAFF,
        resource_type: "commerce_whatsapp_mode",
        resource_id: TENANT_A,
        correlation_id: "corr-flip-1"
      });
      expect(audit!.attributes).toMatchObject({
        from: "legacy",
        to: "upstream",
        reason: "cutover wave 1",
        surface: "api",
        legacyNonTerminal: 0,
        warningsAcknowledged: true
      });
      expect(
        (audit!.attributes.warningCodes as string[]).includes(
          "RATE_LIMITS_DIFFER"
        )
      ).toBe(true);
      expect(result.evidence.auditEventId).toBe(audit!.id);
      expect(result.evidence.correlationId).toBe("corr-flip-1");
    });

    test("a CLI flip has no tenant user: the audit row has no actor, and records the surface and the operator label", async () => {
      await inTenant(TENANT_A, (tx) =>
        flipWhatsappMode(
          tx,
          TENANT_A,
          { tenantUserId: null, surface: "cli", operator: "ops-1" },
          "upstream",
          { reason: "go live", acknowledgeWarnings: true, env: process.env }
        )
      );

      const [audit] = await auditRows(TENANT_A);
      expect(audit!.actor_tenant_user_id).toBeNull();
      expect(audit!.attributes).toMatchObject({
        surface: "cli",
        operator: "ops-1"
      });
    });

    test("a dry run runs the whole decision and writes NOTHING: no mode, no settings row, no audit event", async () => {
      const allowed = await flip(TENANT_A, "upstream", { dryRun: true });
      expect(allowed.outcome).toBe("would_flip");
      expect(allowed.evidence.dryRun).toBe(true);
      expect(allowed.evidence.auditEventId).toBeNull();

      await enqueueMany(TENANT_A, 1);
      const refused = await flip(TENANT_A, "upstream", { dryRun: true });
      expect(refused.outcome).toBe("refused");
      expect(refused.evidence.auditEventId).toBeNull();

      expect(await modeRow(TENANT_A)).toBeNull();
      expect(await counts(TENANT_A)).toEqual({
        legacy: 1,
        upstream: 0,
        audit: 0
      });
    });

    test("flipping to the mode the tenant is already in is unchanged: idempotent, no second audit event", async () => {
      await flip(TENANT_A, "upstream");
      const again = await flip(TENANT_A, "upstream");

      expect(again.outcome).toBe("unchanged");
      expect(again.evidence.auditEventId).toBeNull();
      expect((await counts(TENANT_A)).audit).toBe(1);

      // A tenant that has never been flipped is already legacy.
      const legacy = await flip(TENANT_B, "legacy");
      expect(legacy.outcome).toBe("unchanged");
      expect(await modeRow(TENANT_B)).toBeNull();
    });

    test("a stale expectation is refused MODE_CHANGED and audited as a refusal", async () => {
      await flip(TENANT_A, "upstream");

      const stale = await flip(TENANT_A, "legacy", { expected: "legacy" });

      expect(stale.outcome).toBe("refused");
      expect(stale.evidence.refusal?.code).toBe("MODE_CHANGED");
      expect(await readWhatsappModeFor(TENANT_A)).toBe("upstream");
    });

    test("an empty reason is a programming error, thrown before the lock is taken", async () => {
      let thrown: unknown;
      try {
        await flip(TENANT_A, "upstream", { reason: "   " });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TypeError);
    });
  });

  // -------------------------------------------------------------------------
  describe("a flip into a dead channel is refused", () => {
    const CASES: [string, Record<string, string | undefined>, string][] = [
      [
        "WHATSAPP_ENABLED is off",
        { ...envSnapshot(), WHATSAPP_ENABLED: "false" },
        "TARGET_DISABLED"
      ],
      [
        "the key ring is missing",
        { ...envSnapshot(), WHATSAPP_RECIPIENT_HASH_KEYS: undefined },
        "TARGET_HASH_KEYS_UNUSABLE"
      ],
      [
        "the provider is unset",
        { ...envSnapshot(), WHATSAPP_PROVIDER: undefined },
        "TARGET_PROVIDER_UNSET"
      ]
    ];

    for (const [label, env, code] of CASES) {
      test(`${label}: TARGET_CHANNEL_UNAVAILABLE (${code}), mode unchanged`, async () => {
        const result = await flip(TENANT_A, "upstream", {
          env: env as NodeJS.ProcessEnv
        });

        expect(result.outcome).toBe("refused");
        expect(result.evidence.refusal?.code).toBe(
          "TARGET_CHANNEL_UNAVAILABLE"
        );
        expect(
          (result.evidence.blockers.map((b) => b.code) as string[]).includes(
            code
          )
        ).toBe(true);
        expect(await modeRow(TENANT_A)).toBeNull();
      });
    }

    test("the whatsapp_delivery module switched off for the tenant: TARGET_MODULE_DISABLED", async () => {
      await getAdminSql()`
        INSERT INTO awcms_modules (module_key, module_name, version)
        VALUES ('whatsapp_delivery', 'WhatsApp delivery', '1.0.0')
        ON CONFLICT (module_key) DO NOTHING
      `;
      await getAdminSql()`
        INSERT INTO awcms_tenant_modules (tenant_id, module_key, enabled, disabled_at)
        VALUES (${TENANT_A}, 'whatsapp_delivery', false, now())
        ON CONFLICT (tenant_id, module_key) DO UPDATE SET enabled = false
      `;

      const result = await flip(TENANT_A, "upstream");

      expect(result.outcome).toBe("refused");
      expect(result.evidence.blockers.map((b) => b.code)).toContain(
        "TARGET_MODULE_DISABLED"
      );
      expect(result.evidence.channel.upstreamModuleEnabled).toBe(false);
    });

    test("every blocker is listed, not only the first, so one dry run shows everything to fix", async () => {
      await enqueueMany(TENANT_A, 1);

      const result = await flip(TENANT_A, "upstream", {
        env: {
          ...envSnapshot(),
          WHATSAPP_ENABLED: "false"
        } as NodeJS.ProcessEnv
      });

      expect(result.evidence.refusal?.code).toBe("DRAIN_PENDING");
      expect(result.evidence.blockers.map((b) => b.code)).toEqual([
        "DRAIN_PENDING",
        "TARGET_DISABLED"
      ]);
    });
  });

  // -------------------------------------------------------------------------
  describe("warnings must be acknowledged", () => {
    test("without the acknowledgement a flip into upstream is refused and lists the warnings, with the consent counts", async () => {
      await seedOptedInAccount(TENANT_A, "+6281300000001");
      await seedOptedInAccount(TENANT_A, "+6281300000002");

      const result = await flip(TENANT_A, "upstream", {
        acknowledgeWarnings: false
      });

      expect(result.outcome).toBe("refused");
      expect(result.evidence.refusal?.code).toBe("WARNINGS_NOT_ACKNOWLEDGED");
      expect(result.evidence.consent).toEqual({
        commerceMarketingOptIns: 2,
        upstreamGrantedConsents: 0
      });
      expect(result.evidence.warnings.map((w) => w.code)).toContain(
        "MARKETING_CONSENT_NOT_BRIDGED"
      );
      expect(await modeRow(TENANT_A)).toBeNull();
    });

    test("the reverse flip needs no acknowledgement", async () => {
      await flip(TENANT_A, "upstream");

      const back = await flip(TENANT_A, "legacy", {
        acknowledgeWarnings: false
      });

      expect(back.outcome).toBe("flipped");
      expect(back.evidence.warnings).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("the reverse flip (upstream -> legacy)", () => {
    test("is refused while the upstream queue holds a queued row, then allowed once the upstream dispatcher drains it", async () => {
      await flip(TENANT_A, "upstream");
      await inTenant(TENANT_A, (tx) => enqueueOtp(tx, TENANT_A, "up-1"));
      expect((await counts(TENANT_A)).upstream).toBe(1);

      const refused = await flip(TENANT_A, "legacy");
      expect(refused.outcome).toBe("refused");
      expect(refused.evidence.refusal?.code).toBe("DRAIN_PENDING");
      expect(refused.evidence.queues.upstream.countsByStatus.queued).toBe(1);
      expect(await readWhatsappModeFor(TENANT_A)).toBe("upstream");

      const drained = await dispatchUpstreamQueue(
        getWorkerRoleSql(),
        TENANT_A,
        { env: process.env }
      );
      expect(drained).toMatchObject({ claimed: 1, sent: 1 });

      const back = await flip(TENANT_A, "legacy");
      expect(back.outcome).toBe("flipped");
      expect(await readWhatsappModeFor(TENANT_A)).toBe("legacy");

      // The next message is a legacy row again; the upstream history stays.
      await inTenant(TENANT_A, (tx) => enqueueOtp(tx, TENANT_A, "legacy-2"));
      expect(await counts(TENANT_A)).toMatchObject({ legacy: 1, upstream: 1 });
    });

    test("retry_wait, which exists only in the upstream queue, blocks the reverse flip", async () => {
      await flip(TENANT_A, "upstream");
      await inTenant(TENANT_A, (tx) => enqueueOtp(tx, TENANT_A, "up-1"));
      await getAdminSql()`
        UPDATE awcms_whatsapp_messages SET status = 'retry_wait' WHERE tenant_id = ${TENANT_A}
      `;

      const refused = await flip(TENANT_A, "legacy");

      expect(refused.outcome).toBe("refused");
      expect(refused.evidence.queues.upstream.countsByStatus).toEqual({
        retry_wait: 1
      });
    });

    test("terminal upstream rows (sent, failed, cancelled, expired) do not block it", async () => {
      await flip(TENANT_A, "upstream");
      for (const [index, status] of [
        "sent",
        "failed",
        "cancelled",
        "expired"
      ].entries()) {
        await inTenant(TENANT_A, (tx) =>
          enqueueOtp(tx, TENANT_A, `up-${index}`, `+628123450${index}00`)
        );
        await getAdminSql()`
          UPDATE awcms_whatsapp_messages SET status = ${status}
          WHERE tenant_id = ${TENANT_A} AND status = 'queued'
        `;
      }

      expect((await flip(TENANT_A, "legacy")).outcome).toBe("flipped");
    });

    // Issue #449 (ADR-0047 D12).
    test("rows of ANOTHER module in the shared upstream queue never block a commerce rollback, and are reported", async () => {
      await flip(TENANT_A, "upstream");
      await seedForeignUpstreamRows(TENANT_A, 3, "queued");
      await seedForeignUpstreamRows(TENANT_A, 1, "retry_wait");

      const status = await inTenant(TENANT_A, (tx) =>
        readWhatsappModeStatus(tx, TENANT_A, { env: process.env })
      );
      expect(status.queues.upstream.nonTerminal).toBe(0);
      expect(status.queues.upstreamScope).toEqual({
        unrelatedNonTerminal: 4,
        commerceCountExact: true
      });
      expect(status.flip).toMatchObject({ to: "legacy", allowed: true });

      const back = await flip(TENANT_A, "legacy");
      expect(back.outcome).toBe("flipped");
      expect(back.evidence.queues.upstreamScope.unrelatedNonTerminal).toBe(4);
      // They are not touched: the upstream dispatcher still owns them.
      const rows = (await getAdminSql()`
        SELECT count(*) AS n FROM awcms_whatsapp_messages
        WHERE tenant_id = ${TENANT_A} AND template_key = 'booking.reminder'
          AND status IN ('queued', 'retry_wait')
      `) as { n: string }[];
      expect(Number(rows[0]!.n)).toBe(4);
    });

    test("commerce's OWN pending rows still block, counted without the other module's, and the message offers the override", async () => {
      await flip(TENANT_A, "upstream");
      await inTenant(TENANT_A, (tx) => enqueueOtp(tx, TENANT_A, "up-1"));
      await getAdminSql()`
        UPDATE awcms_whatsapp_messages SET status = 'retry_wait'
        WHERE tenant_id = ${TENANT_A} AND template_key = 'commerce.customer_otp'
      `;
      await seedForeignUpstreamRows(TENANT_A, 5);

      const refused = await flip(TENANT_A, "legacy");

      expect(refused.outcome).toBe("refused");
      expect(refused.evidence.refusal?.code).toBe("DRAIN_PENDING");
      expect(refused.evidence.queues.upstream.countsByStatus).toEqual({
        retry_wait: 1
      });
      expect(refused.evidence.queues.upstreamScope.unrelatedNonTerminal).toBe(
        5
      );
      expect(refused.evidence.refusal?.message).toContain(
        "5 non-terminal message(s) of other modules are not counted"
      );
      expect(refused.evidence.refusal?.message).toContain("--force");
      expect(refused.evidence.force).toEqual({
        requested: false,
        applied: false,
        bypassedNonTerminal: 0
      });
    });

    test("a status holding more than one page is not attributable: the remainder counts as commerce's (fail closed) and the evidence says so", async () => {
      await flip(TENANT_A, "upstream");
      await seedForeignUpstreamRows(
        TENANT_A,
        UPSTREAM_DRAIN_PAGE_LIMIT + 3,
        "queued"
      );

      const refused = await flip(TENANT_A, "legacy");

      expect(refused.outcome).toBe("refused");
      expect(refused.evidence.queues.upstream.nonTerminal).toBe(3);
      expect(refused.evidence.queues.upstreamScope).toEqual({
        unrelatedNonTerminal: UPSTREAM_DRAIN_PAGE_LIMIT,
        commerceCountExact: false
      });
    });

    describe("force: the audited rollback override", () => {
      async function stuckCommerceRow(): Promise<void> {
        await flip(TENANT_A, "upstream");
        await inTenant(TENANT_A, (tx) => enqueueOtp(tx, TENANT_A, "up-1"));
        await getAdminSql()`
          UPDATE awcms_whatsapp_messages SET status = 'retry_wait'
          WHERE tenant_id = ${TENANT_A}
        `;
      }

      test("rolls back over commerce's pending rows, audits it under its own action with the bypassed count, and leaves the rows to the upstream dispatcher", async () => {
        await stuckCommerceRow();

        const result = await flip(TENANT_A, "legacy", { force: true });

        expect(result.outcome).toBe("flipped");
        expect(result.evidence.force).toEqual({
          requested: true,
          applied: true,
          bypassedNonTerminal: 1
        });
        expect(result.evidence.blockers).toEqual([]);
        expect(await readWhatsappModeFor(TENANT_A)).toBe("legacy");

        const forced = (await auditRows(TENANT_A)).filter(
          (row) => row.action === "whatsapp_mode.flip_forced"
        );
        expect(forced).toHaveLength(1);
        expect(forced[0]).toMatchObject({
          severity: "warning",
          actor_tenant_user_id: STAFF
        });
        expect(forced[0]!.attributes).toMatchObject({
          from: "upstream",
          to: "legacy",
          forced: true,
          bypassedNonTerminal: 1,
          upstreamNonTerminal: 1
        });
        expect(forced[0]!.id).toBe(result.evidence.auditEventId!);
        // No plain `flip` row for the same event: one action per flip.
        expect(
          (await auditRows(TENANT_A)).filter(
            (row) =>
              row.action === "whatsapp_mode.flip" && row.id === forced[0]!.id
          )
        ).toHaveLength(0);

        // The row is untouched and the upstream dispatcher still works it.
        const left = (await getAdminSql()`
          SELECT status FROM awcms_whatsapp_messages WHERE tenant_id = ${TENANT_A}
        `) as { status: string }[];
        expect(left.map((row) => row.status)).toEqual(["retry_wait"]);
      });

      test("a dry run with force reports what it would bypass and writes nothing", async () => {
        await stuckCommerceRow();
        const before = await counts(TENANT_A);

        const result = await flip(TENANT_A, "legacy", {
          force: true,
          dryRun: true
        });

        expect(result.outcome).toBe("would_flip");
        expect(result.evidence.force).toMatchObject({
          applied: true,
          bypassedNonTerminal: 1
        });
        expect(await counts(TENANT_A)).toEqual(before);
        expect(await readWhatsappModeFor(TENANT_A)).toBe("upstream");
      });

      test("force with nothing to bypass is a plain rollback: ordinary audit action, applied false", async () => {
        await flip(TENANT_A, "upstream");

        const result = await flip(TENANT_A, "legacy", { force: true });

        expect(result.outcome).toBe("flipped");
        expect(result.evidence.force).toEqual({
          requested: true,
          applied: false,
          bypassedNonTerminal: 0
        });
        expect(
          (await auditRows(TENANT_A)).map((row) => row.action)
        ).not.toContain("whatsapp_mode.flip_forced");
      });

      test("force bypasses the drain and nothing else: a dead legacy channel still refuses, and the refusal is audited as a refusal", async () => {
        await stuckCommerceRow();

        const result = await flip(TENANT_A, "legacy", {
          force: true,
          env: {
            ...envSnapshot(),
            COMMERCE_WHATSAPP_ENABLED: "false"
          } as NodeJS.ProcessEnv
        });

        expect(result.outcome).toBe("refused");
        expect(result.evidence.refusal?.code).toBe(
          "TARGET_CHANNEL_UNAVAILABLE"
        );
        expect(await readWhatsappModeFor(TENANT_A)).toBe("upstream");
        expect((await auditRows(TENANT_A)).map((row) => row.action)).toContain(
          "whatsapp_mode.flip_refused"
        );
      });

      test("force never applies to a flip INTO upstream: the function refuses to run it", async () => {
        await expect(
          flip(TENANT_A, "upstream", { force: true })
        ).rejects.toThrow(TypeError);
        expect(await readWhatsappModeFor(TENANT_A)).toBe("legacy");
      });
    });

    test("it is refused when the legacy channel is off in this process: flipping into a dead channel would stop every OTP", async () => {
      await flip(TENANT_A, "upstream");

      const result = await flip(TENANT_A, "legacy", {
        env: {
          ...envSnapshot(),
          COMMERCE_WHATSAPP_ENABLED: "false"
        } as NodeJS.ProcessEnv
      });

      expect(result.outcome).toBe("refused");
      expect(result.evidence.refusal?.code).toBe("TARGET_CHANNEL_UNAVAILABLE");
    });
  });

  // -------------------------------------------------------------------------
  describe("two live queues for one tenant never coexist", () => {
    test("an enqueue in flight when the flip starts is counted: the flip waits for it, then refuses", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let enqueued!: () => void;
      const hasEnqueued = new Promise<void>((resolve) => (enqueued = resolve));

      const inFlight = inTenant(TENANT_A, async (tx) => {
        const result = await enqueueOtp(tx, TENANT_A, "in-flight");
        expect(result.enqueued).toBe(true);
        enqueued();
        await gate;
      });
      await hasEnqueued;

      const flipping = flip(TENANT_A, "upstream");
      await waitForLockWaiter();
      // The flip has not decided yet: it is waiting for the enqueue's shared lock.
      release();
      await inFlight;
      const result = await flipping;

      expect(result.outcome).toBe("refused");
      expect(result.evidence.refusal?.code).toBe("DRAIN_PENDING");
      expect(result.evidence.queues.legacy.countsByStatus).toEqual({
        queued: 1
      });
      expect(await readWhatsappModeFor(TENANT_A)).toBe("legacy");
    });

    test("an enqueue that starts while the flip holds the lock waits, then reads the NEW mode: no legacy row can appear after the drain check", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let decided!: () => void;
      const hasDecided = new Promise<void>((resolve) => (decided = resolve));

      const flipping = inTenant(TENANT_A, async (tx) => {
        const result = await flipWhatsappMode(
          tx,
          TENANT_A,
          { tenantUserId: STAFF, surface: "api" },
          "upstream",
          { reason: "race", acknowledgeWarnings: true, env: process.env }
        );
        decided();
        await gate;
        return result;
      });
      await hasDecided;

      const enqueue = inTenant(TENANT_A, (tx) =>
        enqueueOtp(tx, TENANT_A, "raced")
      );
      await waitForLockWaiter();
      release();
      const [flipped, enqueued] = await Promise.all([flipping, enqueue]);

      expect(flipped.outcome).toBe("flipped");
      expect(enqueued.enqueued).toBe(true);
      expect(await counts(TENANT_A)).toMatchObject({ legacy: 0, upstream: 1 });
    });

    test("the lock really is exclusive: while a flip is open, a shared-lock probe cannot be granted", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const hasLocked = new Promise<void>((resolve) => (locked = resolve));

      const holder = inTenant(TENANT_A, async (tx) => {
        await lockWhatsappModeExclusive(tx, TENANT_A);
        locked();
        await gate;
      });
      await hasLocked;

      const probe = (await getAdminSql()`
        SELECT pg_try_advisory_lock_shared(hashtextextended(${`commerce.whatsapp_mode|${TENANT_A}`}, 0)) AS got
      `) as { got: boolean }[];
      expect(probe[0]!.got).toBe(false);

      release();
      await holder;
    });

    test("a flip racing an enqueue, many times over, always ends with exactly one message, in exactly the queue the final mode names", async () => {
      const tally = { upstream: 0, legacy: 0 };

      for (let round = 0; round < 12; round += 1) {
        await getAdminSql()`DELETE FROM awcms_commerce_whatsapp_messages WHERE tenant_id = ${TENANT_A}`;
        await getAdminSql()`DELETE FROM awcms_whatsapp_messages WHERE tenant_id = ${TENANT_A}`;
        await getAdminSql()`DELETE FROM awcms_commerce_store_settings WHERE tenant_id = ${TENANT_A}`;

        const jitter = (round % 4) * 3;
        const [enqueued, flipped] = await Promise.all([
          Bun.sleep(round % 2 === 0 ? jitter : 0).then(() =>
            inTenant(TENANT_A, (tx) =>
              enqueueOtp(tx, TENANT_A, `race-${round}`)
            )
          ),
          Bun.sleep(round % 2 === 1 ? jitter + 3 : 0).then(() =>
            flip(TENANT_A, "upstream")
          )
        ]);
        expect(enqueued.enqueued).toBe(true);

        const mode = await readWhatsappModeFor(TENANT_A);
        const now = await counts(TENANT_A);

        if (mode === "upstream") {
          // The flip won: the message was routed to the new queue.
          expect(flipped.outcome).toBe("flipped");
          expect(now).toMatchObject({ legacy: 0, upstream: 1 });
          tally.upstream += 1;
        } else {
          // The enqueue won: the flip saw its row and refused.
          expect(flipped.outcome).toBe("refused");
          expect(flipped.evidence.refusal?.code).toBe("DRAIN_PENDING");
          expect(now).toMatchObject({ legacy: 1, upstream: 0 });
          tally.legacy += 1;
        }
      }

      expect(tally.upstream + tally.legacy).toBe(12);
    }, 120000);
  });

  // -------------------------------------------------------------------------
  describe("tenant isolation", () => {
    test("another tenant's non-terminal rows neither block nor appear in this tenant's flip, and its mode does not move", async () => {
      await seedStaff(TENANT_B).catch(() => undefined);
      await enqueueMany(TENANT_B, 4);

      const result = await flip(TENANT_A, "upstream");

      expect(result.outcome).toBe("flipped");
      expect(result.evidence.queues.legacy.countsByStatus).toEqual({});
      expect(await readWhatsappModeFor(TENANT_B)).toBe("legacy");
      expect(await modeRow(TENANT_B)).toBeNull();
      expect(await auditRows(TENANT_B)).toEqual([]);

      // And the other way round: B is still blocked by its OWN four rows.
      const blocked = await flip(TENANT_B, "upstream");
      expect(blocked.outcome).toBe("refused");
      expect(blocked.evidence.queues.legacy.nonTerminal).toBe(4);
    });

    test("the drain read runs under RLS: tenant A's context sees none of tenant B's rows", async () => {
      await enqueueMany(TENANT_B, 2);

      const seenByA = await inTenant(TENANT_A, (tx) =>
        summarizeLegacyWhatsappQueue(tx, TENANT_A)
      );
      const forgedAsA = await inTenant(TENANT_A, (tx) =>
        summarizeLegacyWhatsappQueue(tx, TENANT_B)
      );

      expect(seenByA.nonTerminal).toBe(0);
      expect(forgedAsA.nonTerminal).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("the status read", () => {
    test("reports the mode, both queues, the channel and what a flip to the other mode would face", async () => {
      await enqueueMany(TENANT_A, 2);

      const status = await inTenant(TENANT_A, (tx) =>
        readWhatsappModeStatus(tx, TENANT_A, { env: process.env })
      );

      expect(status).toMatchObject({
        mode: "legacy",
        changedAt: null,
        queues: {
          legacy: { nonTerminal: 2, countsByStatus: { queued: 2 } },
          upstream: { nonTerminal: 0 }
        },
        channel: {
          legacyEnabled: true,
          upstreamEnabled: true,
          upstreamProvider: "log",
          upstreamProviderKnown: true,
          upstreamHashKeysUsable: true,
          upstreamModuleEnabled: true
        },
        flip: { to: "upstream", allowed: false }
      });
      expect(status.channelEnvironmentNotice).toContain(
        "not from the WhatsApp dispatchers"
      );
      expect(status.flip.blockers.map((b) => b.code)).toEqual([
        "DRAIN_PENDING"
      ]);
    });

    test("takes no lock: it answers while a flip is mid-transaction", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const hasLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = inTenant(TENANT_A, async (tx) => {
        await lockWhatsappModeExclusive(tx, TENANT_A);
        locked();
        await gate;
      });
      await hasLocked;

      const status = await inTenant(TENANT_A, (tx) =>
        readWhatsappModeStatus(tx, TENANT_A, { env: process.env })
      );
      expect(status.mode).toBe("legacy");

      release();
      await holder;
    });
  });
});

function envSnapshot(): Record<string, string | undefined> {
  return {
    WHATSAPP_ENABLED: "true",
    WHATSAPP_PROVIDER: "log",
    WHATSAPP_RECIPIENT_HASH_KEYS: `k1:${KEY}`,
    COMMERCE_WHATSAPP_ENABLED: "true",
    COMMERCE_WHATSAPP_PROVIDER: "log"
  };
}

function readWhatsappModeFor(tenantId: string): Promise<WhatsappMode> {
  return inTenant(tenantId, (tx) => readWhatsappMode(tx, tenantId));
}
