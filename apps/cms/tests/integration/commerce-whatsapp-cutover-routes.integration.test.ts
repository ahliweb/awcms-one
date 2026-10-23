/**
 * `GET` / `POST /api/v1/commerce/whatsapp/mode` through the REAL route handlers
 * and `bun run commerce:whatsapp:cutover` as a real subprocess (Issue #393,
 * ADR-0047 "Cutover"). WORLD 2 (see `harness.ts`): runs against the migrated
 * `DATABASE_URL` database; skips cleanly when it is not migrated. The decision
 * itself, the drain check and the concurrency proof are
 * `commerce-whatsapp-cutover.integration.test.ts`; this file proves the two
 * surfaces are wired to it and enforce what only a surface can:
 *
 *   - `commerce.whatsapp_mode.read` for GET, `commerce.whatsapp_mode.manage` for
 *     POST, neither implied by the other, no token / another tenant refused;
 *   - a real flip needs an `Idempotency-Key` and a recent step-up; a dry run
 *     needs neither and writes nothing;
 *   - a refusal is `409` with the evidence record in `error.details`, and is
 *     audited; a replay of the same key returns the stored evidence and writes
 *     nothing again; the same key with another body is `IDEMPOTENCY_CONFLICT`;
 *   - the CLI prints the evidence JSON, exits 1 on a refusal and 2 on bad usage.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import {
  createCookieJar,
  ensureHandlerDatabaseReady,
  getHandlerAdminSql,
  getHandlerDatabaseClient,
  integrationEnabled,
  invoke,
  resetHandlerDatabase,
  teardownHandlerDatabase
} from "./harness";
import { hashSessionToken } from "../../src/lib/auth/session-token";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { enqueueWhatsappMessage } from "../../src/modules/commerce/application/whatsapp-enqueue";
import { GET, POST } from "../../src/pages/api/v1/commerce/whatsapp/mode";

type Principal = { tenantId: string; token: string; tenantUserId: string };
type Evidence = {
  channelEnvironmentNotice: string;
  force: { requested: boolean; applied: boolean; bypassedNonTerminal: number };
  outcome: string;
  from: string;
  to: string;
  dryRun: boolean;
  auditEventId: string | null;
  refusal: { code: string } | null;
  queues: {
    legacy: { nonTerminal: number };
    upstream: { nonTerminal: number };
    upstreamScope: { unrelatedNonTerminal: number };
  };
  warnings: { code: string }[];
};
type Envelope<T = unknown> = {
  success: boolean;
  data: T;
  error?: { code: string; details?: Evidence };
};

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

const TENANT_B = "39300000-0000-4000-8000-00000000000b";

let counter = 0;

/** A tenant user holding ONLY the given permission keys, with a live session. */
async function seedPrincipal(
  tenantId: string,
  label: string,
  perms: string[]
): Promise<Principal> {
  const admin = getHandlerAdminSql();
  counter += 1;
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', ${`Profile ${label}`})
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`${label}-${counter}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  const tenantUser = (await admin`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identity[0]!.id})
    RETURNING id
  `) as { id: string }[];
  const role = (await admin`
    INSERT INTO awcms_roles (tenant_id, role_code, role_name)
    VALUES (${tenantId}, ${`${label}-${counter}`}, ${label})
    RETURNING id
  `) as { id: string }[];
  for (const key of perms) {
    const [moduleKey, activityCode, action] = key.split(".");
    const permission = (await admin`
      SELECT id FROM awcms_permissions
      WHERE module_key = ${moduleKey!} AND activity_code = ${activityCode!} AND action = ${action!}
    `) as { id: string }[];
    if (!permission[0]) throw new Error(`permission ${key} is not seeded`);
    await admin`
      INSERT INTO awcms_role_permissions (tenant_id, role_id, permission_id)
      VALUES (${tenantId}, ${role[0]!.id}, ${permission[0].id})
    `;
  }
  await admin`
    INSERT INTO awcms_access_policies (tenant_id, tenant_user_id, role_id, scope_type, scope_id)
    VALUES (${tenantId}, ${tenantUser[0]!.id}, ${role[0]!.id}, 'tenant', ${tenantId})
  `;
  const token = `it-token-${label}-${counter}-${Date.now()}`;
  await admin`
    INSERT INTO awcms_sessions (tenant_id, identity_id, token_hash, expires_at)
    VALUES (${tenantId}, ${identity[0]!.id}, ${hashSessionToken(token)}, ${new Date(Date.now() + 3_600_000)})
  `;
  return { tenantId, token, tenantUserId: tenantUser[0]!.id };
}

async function stepUp(who: Principal) {
  await getHandlerAdminSql()`
    UPDATE awcms_sessions
    SET assurance_level = 'aal2', stepped_up_at = now(), last_authenticated_at = now()
    WHERE token_hash = ${hashSessionToken(who.token)}
  `;
}

async function seedTenant(id: string, code: string) {
  await getHandlerAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

function headers(who: Principal, extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "x-awcms-tenant-id": who.tenantId,
    authorization: `Bearer ${who.token}`,
    ...extra
  };
}

const get = (who: Principal) =>
  invoke<Envelope<Record<string, unknown>>>(GET, {
    method: "GET",
    path: "/api/v1/commerce/whatsapp/mode",
    headers: headers(who),
    cookies: createCookieJar()
  });

const post = (
  who: Principal,
  body: unknown,
  extraHeaders: Record<string, string> = {}
) =>
  invoke<Envelope<Evidence>>(POST, {
    method: "POST",
    path: "/api/v1/commerce/whatsapp/mode",
    headers: headers(who, extraHeaders),
    body,
    cookies: createCookieJar()
  });

const FLIP = {
  to: "upstream",
  reason: "route test",
  acknowledgeWarnings: true
};

async function modeOf(tenantId: string): Promise<string> {
  const rows = (await getHandlerAdminSql()`
    SELECT whatsapp_mode FROM awcms_commerce_store_settings WHERE tenant_id = ${tenantId}
  `) as { whatsapp_mode: string }[];
  return rows[0]?.whatsapp_mode ?? "legacy";
}

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = (await getHandlerAdminSql()`
    SELECT action FROM awcms_audit_events
    WHERE tenant_id = ${tenantId} AND action LIKE 'whatsapp_mode.%'
    ORDER BY created_at, id
  `) as { action: string }[];
  return rows.map((row) => row.action);
}

/** The tenant in `upstream` mode with one OF COMMERCE'S messages stuck in `retry_wait` behind a failing provider. */
async function upstreamTenantWithStuckRow(): Promise<void> {
  await getHandlerAdminSql()`
    INSERT INTO awcms_commerce_store_settings (tenant_id, settings, whatsapp_mode, whatsapp_mode_changed_at)
    VALUES (${TENANT_A}, '{}'::jsonb, 'upstream', now())
    ON CONFLICT (tenant_id) DO UPDATE SET whatsapp_mode = 'upstream'
  `;
  await withTenantOrThrow(getHandlerDatabaseClient(), TENANT_A, (tx) =>
    enqueueWhatsappMessage(tx, {
      tenantId: TENANT_A,
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      variables: { code: "123456", expiresInMinutes: "10", storeName: "A" },
      correlationId: "route-stuck"
    })
  );
  await getHandlerAdminSql()`
    UPDATE awcms_whatsapp_messages SET status = 'retry_wait' WHERE tenant_id = ${TENANT_A}
  `;
}

const suite = integrationEnabled ? describe : describe.skip;
let handlerReady = false;

suite("the WhatsApp mode route and CLI (Issue #393)", () => {
  beforeAll(async () => {
    for (const name of ENV_KEYS) SAVED[name] = process.env[name];
    handlerReady = await ensureHandlerDatabaseReady();
  });

  afterAll(async () => {
    for (const name of ENV_KEYS) {
      if (SAVED[name] === undefined) delete process.env[name];
      else process.env[name] = SAVED[name];
    }
    await teardownHandlerDatabase();
  });

  beforeEach(async () => {
    setEnv();
    if (!handlerReady) return;
    await resetHandlerDatabase();
    await seedTenant(TENANT_A, "tenant-a");
  });

  const run = (name: string, fn: () => Promise<void>) =>
    test(name, async () => {
      if (!handlerReady) {
        console.warn(`[skip] ${name}: handler database is not migrated.`);
        return;
      }
      await fn();
    });

  // -------------------------------------------------------------------------
  describe("permissions", () => {
    run(
      "GET needs commerce.whatsapp_mode.read; manage alone does not read, read alone does not flip",
      async () => {
        const reader = await seedPrincipal(TENANT_A, "reader", [
          "commerce.whatsapp_mode.read"
        ]);
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);
        const nobody = await seedPrincipal(TENANT_A, "nobody", [
          "commerce.whatsapp.read"
        ]);

        const read = await get(reader);
        expect(read.status).toBe(200);
        expect(read.body.data).toMatchObject({
          mode: "legacy",
          queues: { legacy: { nonTerminal: 0 } },
          flip: { to: "upstream", allowed: true }
        });
        expect((await get(manager)).status).toBe(403);
        expect((await get(nobody)).status).toBe(403);

        expect((await post(reader, { ...FLIP, dryRun: true })).status).toBe(
          403
        );
        await stepUp(manager);
        expect(
          (await post(manager, FLIP, { "idempotency-key": "k-perm" })).status
        ).toBe(200);
        expect(await modeOf(TENANT_A)).toBe("upstream");
      }
    );

    run(
      "no token is 401, and a token of another tenant cannot reach this tenant",
      async () => {
        const reader = await seedPrincipal(TENANT_A, "reader", [
          "commerce.whatsapp_mode.read"
        ]);

        const anonymous = await invoke<Envelope>(GET, {
          method: "GET",
          path: "/api/v1/commerce/whatsapp/mode",
          headers: { "x-awcms-tenant-id": TENANT_A },
          cookies: createCookieJar()
        });
        expect(anonymous.status).toBe(401);

        await seedTenant(TENANT_B, "tenant-b");
        const crossed = await invoke<Envelope>(GET, {
          method: "GET",
          path: "/api/v1/commerce/whatsapp/mode",
          headers: headers({ ...reader, tenantId: TENANT_B }),
          cookies: createCookieJar()
        });
        expect([401, 403]).toContain(crossed.status);
      }
    );
  });

  // -------------------------------------------------------------------------
  describe("POST", () => {
    run(
      "validates the body: unknown fields, a bad mode, no reason",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);

        for (const body of [
          { to: "elsewhere", reason: "x", dryRun: true },
          { to: "upstream", dryRun: true },
          { to: "upstream", reason: "   ", dryRun: true },
          { to: "upstream", reason: "x", dryRun: true, force: true },
          { to: "upstream", reason: "x", dryRun: "yes" },
          { to: "upstream", reason: "x", from: "z", dryRun: true }
        ]) {
          const result = await post(manager, body);
          expect({ body, status: result.status }).toEqual({
            body,
            status: 400
          });
          expect(result.body.error?.code).toBe("VALIDATION_ERROR");
        }
      }
    );

    run(
      "a real flip needs an Idempotency-Key; a dry run does not",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);
        await stepUp(manager);

        const missing = await post(manager, FLIP);
        expect(missing.status).toBe(400);
        expect(missing.body.error?.code).toBe("IDEMPOTENCY_REQUIRED");

        const dry = await post(manager, { ...FLIP, dryRun: true });
        expect(dry.status).toBe(200);
        expect(dry.body.data).toMatchObject({
          outcome: "would_flip",
          dryRun: true,
          auditEventId: null
        });
      }
    );

    run(
      "a real flip needs a recent step-up; a dry run is allowed without one and writes nothing",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);

        const denied = await post(manager, FLIP, { "idempotency-key": "k-su" });
        expect(denied.status).toBe(403);
        expect(denied.body.error?.code).toBe("STEP_UP_REQUIRED");
        expect(await modeOf(TENANT_A)).toBe("legacy");

        const dry = await post(manager, { ...FLIP, dryRun: true });
        expect(dry.status).toBe(200);
        expect(await modeOf(TENANT_A)).toBe("legacy");
        expect(await auditActions(TENANT_A)).toEqual([]);

        await stepUp(manager);
        const flipped = await post(manager, FLIP, {
          "idempotency-key": "k-su"
        });
        expect(flipped.status).toBe(200);
        expect(flipped.body.data.outcome).toBe("flipped");
      }
    );

    run(
      "a flip is audited with the signed-in actor, and the evidence names the audit row",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);
        await stepUp(manager);

        const result = await post(manager, FLIP, {
          "idempotency-key": "k-audit"
        });

        expect(result.body.data).toMatchObject({
          outcome: "flipped",
          from: "legacy",
          to: "upstream",
          surface: "api"
        });
        const rows = (await getHandlerAdminSql()`
        SELECT id, action, actor_tenant_user_id FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'whatsapp_mode.flip'
      `) as { id: string; actor_tenant_user_id: string }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe(result.body.data.auditEventId!);
        expect(rows[0]!.actor_tenant_user_id).toBe(manager.tenantUserId);
      }
    );

    run(
      "unacknowledged warnings are 409 with the evidence in error.details, and the refusal is audited",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);
        await stepUp(manager);

        const refused = await post(
          manager,
          { to: "upstream", reason: "route test" },
          { "idempotency-key": "k-warn" }
        );

        expect(refused.status).toBe(409);
        expect(refused.body.error?.code).toBe("WARNINGS_NOT_ACKNOWLEDGED");
        expect(refused.body.error?.details).toMatchObject({
          outcome: "refused",
          refusal: { code: "WARNINGS_NOT_ACKNOWLEDGED" }
        });
        expect(
          refused.body.error?.details?.warnings.map((w) => w.code)
        ).toContain("RATE_LIMITS_DIFFER");
        expect(await modeOf(TENANT_A)).toBe("legacy");
        expect(await auditActions(TENANT_A)).toEqual([
          "whatsapp_mode.flip_refused"
        ]);
      }
    );

    run(
      "a non-terminal legacy row is 409 DRAIN_PENDING with the counts, then the flip passes once it is terminal",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);
        await stepUp(manager);
        await withTenantOrThrow(getHandlerDatabaseClient(), TENANT_A, (tx) =>
          enqueueWhatsappMessage(tx, {
            tenantId: TENANT_A,
            toPhone: "+6281234567890",
            templateKey: "commerce.customer_otp",
            variables: {
              code: "123456",
              expiresInMinutes: "10",
              storeName: "A"
            },
            correlationId: "route-drain"
          })
        );

        const refused = await post(manager, FLIP, {
          "idempotency-key": "k-drain-1"
        });
        expect(refused.status).toBe(409);
        expect(refused.body.error?.code).toBe("DRAIN_PENDING");
        expect(refused.body.error?.details?.queues.legacy.nonTerminal).toBe(1);
        expect(await modeOf(TENANT_A)).toBe("legacy");

        await getHandlerAdminSql()`
        UPDATE awcms_commerce_whatsapp_messages SET status = 'sent' WHERE tenant_id = ${TENANT_A}
      `;
        const passed = await post(manager, FLIP, {
          "idempotency-key": "k-drain-2"
        });
        expect(passed.status).toBe(200);
        expect(await modeOf(TENANT_A)).toBe("upstream");
      }
    );

    run(
      "a replay of the same key returns the stored evidence and writes nothing; the same key with another body is IDEMPOTENCY_CONFLICT",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);
        await stepUp(manager);

        const first = await post(manager, FLIP, {
          "idempotency-key": "k-replay"
        });
        expect(first.body.data.outcome).toBe("flipped");

        // Another operator flips it back in between, so a re-run would NOT be a no-op.
        await getHandlerAdminSql()`
        UPDATE awcms_commerce_store_settings SET whatsapp_mode = 'legacy' WHERE tenant_id = ${TENANT_A}
      `;
        const replay = await post(manager, FLIP, {
          "idempotency-key": "k-replay"
        });

        expect(replay.status).toBe(200);
        expect(replay.body.data.auditEventId).toBe(
          first.body.data.auditEventId
        );
        expect(await modeOf(TENANT_A)).toBe("legacy");
        expect(await auditActions(TENANT_A)).toEqual(["whatsapp_mode.flip"]);

        const conflict = await post(
          manager,
          { ...FLIP, reason: "something else" },
          { "idempotency-key": "k-replay" }
        );
        expect(conflict.status).toBe(409);
        expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
      }
    );

    run(
      "flipping to the mode the tenant is already in is 200 unchanged, and from makes the request conditional",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);
        await stepUp(manager);

        const unchanged = await post(
          manager,
          { to: "legacy", reason: "already" },
          { "idempotency-key": "k-un" }
        );
        expect(unchanged.status).toBe(200);
        expect(unchanged.body.data.outcome).toBe("unchanged");

        const stale = await post(
          manager,
          { ...FLIP, from: "upstream" },
          { "idempotency-key": "k-stale" }
        );
        expect(stale.status).toBe(409);
        expect(stale.body.error?.code).toBe("MODE_CHANGED");
      }
    );
  });

  // -------------------------------------------------------------------------
  // Issue #449 (ADR-0047 D12, D13).
  describe("the rollback override and the environment notice", () => {
    run(
      "GET and every POST evidence say the channel facts come from the web process, not the dispatchers",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage",
          "commerce.whatsapp_mode.read"
        ]);

        const status = await get(manager);
        expect(status.status).toBe(200);
        expect(status.body.data.channelEnvironmentNotice).toContain(
          "web (CMS) server process"
        );
        expect(status.body.data.channelEnvironmentNotice).toContain(
          "not from the WhatsApp dispatchers"
        );

        const dry = await post(manager, { ...FLIP, dryRun: true });
        expect(dry.body.data.channelEnvironmentNotice).toContain(
          "web (CMS) server process"
        );
      }
    );

    run(
      "force is a rollback-only field: with to upstream it is a 400, on a dry run too",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);

        const result = await post(manager, {
          ...FLIP,
          force: true,
          dryRun: true
        });
        expect(result.status).toBe(400);
        expect(result.body.error?.code).toBe("VALIDATION_ERROR");
      }
    );

    run(
      "a stuck commerce row refuses the rollback; force (with the same step-up and key) rolls it back, audited under its own action",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);
        await stepUp(manager);
        await upstreamTenantWithStuckRow();
        const rollback = { to: "legacy", reason: "provider outage" };

        const refused = await post(manager, rollback, {
          "idempotency-key": "k-rb-1"
        });
        expect(refused.status).toBe(409);
        expect(refused.body.error?.code).toBe("DRAIN_PENDING");
        expect(refused.body.error?.details?.queues.upstream.nonTerminal).toBe(
          1
        );
        expect(await modeOf(TENANT_A)).toBe("upstream");

        const dry = await post(manager, {
          ...rollback,
          force: true,
          dryRun: true
        });
        expect(dry.status).toBe(200);
        expect(dry.body.data).toMatchObject({
          outcome: "would_flip",
          force: { requested: true, applied: true, bypassedNonTerminal: 1 }
        });
        expect(await modeOf(TENANT_A)).toBe("upstream");

        const forced = await post(
          manager,
          { ...rollback, force: true },
          { "idempotency-key": "k-rb-2" }
        );
        expect(forced.status).toBe(200);
        expect(forced.body.data).toMatchObject({
          outcome: "flipped",
          from: "upstream",
          to: "legacy",
          force: { requested: true, applied: true, bypassedNonTerminal: 1 }
        });
        expect(await modeOf(TENANT_A)).toBe("legacy");
        expect(await auditActions(TENANT_A)).toEqual([
          "whatsapp_mode.flip_refused",
          "whatsapp_mode.flip_forced"
        ]);
        const rows = (await getHandlerAdminSql()`
          SELECT id, actor_tenant_user_id FROM awcms_audit_events
          WHERE tenant_id = ${TENANT_A} AND action = 'whatsapp_mode.flip_forced'
        `) as { id: string; actor_tenant_user_id: string }[];
        expect(rows[0]!.id).toBe(forced.body.data.auditEventId!);
        expect(rows[0]!.actor_tenant_user_id).toBe(manager.tenantUserId);
      }
    );

    run(
      "a forced rollback still needs a recent step-up and an Idempotency-Key, and the key cannot replay the plain request as the forced one",
      async () => {
        const manager = await seedPrincipal(TENANT_A, "manager", [
          "commerce.whatsapp_mode.manage"
        ]);
        await upstreamTenantWithStuckRow();
        const forcedBody = { to: "legacy", reason: "outage", force: true };

        const noStepUp = await post(manager, forcedBody, {
          "idempotency-key": "k-f-1"
        });
        expect(noStepUp.status).toBe(403);
        expect(noStepUp.body.error?.code).toBe("STEP_UP_REQUIRED");

        await stepUp(manager);
        const noKey = await post(manager, forcedBody);
        expect(noKey.status).toBe(400);
        expect(noKey.body.error?.code).toBe("IDEMPOTENCY_REQUIRED");
        expect(await modeOf(TENANT_A)).toBe("upstream");

        // The plain rollback is refused (not stored), the forced one with the
        // SAME key is its own request: it is evaluated, not conflicted or replayed.
        const plain = await post(
          manager,
          { to: "legacy", reason: "outage" },
          { "idempotency-key": "k-f-2" }
        );
        expect(plain.status).toBe(409);
        const forced = await post(manager, forcedBody, {
          "idempotency-key": "k-f-2"
        });
        expect(forced.status).toBe(200);
        expect(forced.body.data.force.applied).toBe(true);

        // Now both are stored under that key: the plain body conflicts.
        const mismatch = await post(
          manager,
          { to: "legacy", reason: "outage" },
          { "idempotency-key": "k-f-2" }
        );
        expect(mismatch.status).toBe(409);
        expect(mismatch.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
      }
    );
  });

  // -------------------------------------------------------------------------
  describe("the CLI", () => {
    const cli = async (...args: string[]) => {
      const processHandle = Bun.spawn(
        ["bun", "scripts/commerce-whatsapp-cutover.ts", ...args],
        {
          cwd: process.cwd(),
          env: { ...process.env },
          stdout: "pipe",
          stderr: "pipe"
        }
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
        processHandle.exited
      ]);
      return { stdout, stderr, exitCode };
    };

    run(
      "--force is a rollback override that needs --operator: usage errors exit 2, the forced rollback prints the bypass and the environment note",
      async () => {
        await upstreamTenantWithStuckRow();

        const noOperator = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "legacy",
          "--reason",
          "outage",
          "--force"
        );
        expect(noOperator.exitCode).toBe(2);
        const intoUpstream = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "upstream",
          "--reason",
          "outage",
          "--force",
          "--operator",
          "ops-1"
        );
        expect(intoUpstream.exitCode).toBe(2);

        const plain = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "legacy",
          "--reason",
          "outage"
        );
        expect(plain.exitCode).toBe(1);
        expect(JSON.parse(plain.stdout).refusal.code).toBe("DRAIN_PENDING");
        expect(await modeOf(TENANT_A)).toBe("upstream");

        const forced = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "legacy",
          "--reason",
          "outage",
          "--force",
          "--operator",
          "ops-1"
        );
        expect(forced.exitCode).toBe(0);
        expect(JSON.parse(forced.stdout)).toMatchObject({
          outcome: "flipped",
          surface: "cli",
          operator: "ops-1",
          force: { applied: true, bypassedNonTerminal: 1 }
        });
        expect(forced.stderr).toContain("FORCED");
        expect(forced.stderr).toContain("not from the WhatsApp dispatchers");
        expect(await modeOf(TENANT_A)).toBe("legacy");
        expect(await auditActions(TENANT_A)).toContain(
          "whatsapp_mode.flip_forced"
        );
      }
    );

    run("--status prints the mode and both queues", async () => {
      const result = await cli("--tenant", TENANT_A, "--status");

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: "legacy",
        queues: { legacy: { nonTerminal: 0 }, upstream: { nonTerminal: 0 } },
        flip: { to: "upstream" }
      });
    });

    run(
      "--dry-run writes nothing; a real run needs --ack-warnings, then flips, prints the evidence and audits without an actor",
      async () => {
        const dry = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "upstream",
          "--reason",
          "wave 1",
          "--dry-run",
          "--ack-warnings"
        );
        expect(dry.exitCode).toBe(0);
        expect(JSON.parse(dry.stdout)).toMatchObject({
          outcome: "would_flip",
          surface: "cli"
        });
        expect(await modeOf(TENANT_A)).toBe("legacy");

        // A dry run is faithful: without the acknowledgement it reports the
        // refusal the real run would get, listing the warnings to read.
        const dryUnacked = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "upstream",
          "--reason",
          "wave 1",
          "--dry-run"
        );
        expect(dryUnacked.exitCode).toBe(1);
        expect(JSON.parse(dryUnacked.stdout)).toMatchObject({
          dryRun: true,
          refusal: { code: "WARNINGS_NOT_ACKNOWLEDGED" }
        });
        expect(await auditActions(TENANT_A)).toEqual([]);

        const unacked = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "upstream",
          "--reason",
          "wave 1"
        );
        expect(unacked.exitCode).toBe(1);
        expect(JSON.parse(unacked.stdout).refusal.code).toBe(
          "WARNINGS_NOT_ACKNOWLEDGED"
        );
        expect(unacked.stderr).toContain("REFUSED");

        const flipped = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "upstream",
          "--reason",
          "wave 1",
          "--ack-warnings",
          "--operator",
          "ops-1"
        );
        expect(flipped.exitCode).toBe(0);
        const evidence = JSON.parse(flipped.stdout) as Evidence & {
          operator: string;
        };
        expect(evidence).toMatchObject({
          outcome: "flipped",
          from: "legacy",
          to: "upstream",
          operator: "ops-1"
        });
        expect(await modeOf(TENANT_A)).toBe("upstream");
        const rows = (await getHandlerAdminSql()`
        SELECT id, actor_tenant_user_id FROM awcms_audit_events
        WHERE tenant_id = ${TENANT_A} AND action = 'whatsapp_mode.flip'
      `) as { id: string; actor_tenant_user_id: string | null }[];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.id).toBe(evidence.auditEventId!);
        expect(rows[0]!.actor_tenant_user_id).toBeNull();

        const again = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "upstream",
          "--reason",
          "wave 1 again",
          "--ack-warnings"
        );
        expect(again.exitCode).toBe(0);
        expect(JSON.parse(again.stdout).outcome).toBe("unchanged");
      }
    );

    run(
      "a non-terminal legacy row refuses with exit 1 and the drain counts in the evidence",
      async () => {
        await withTenantOrThrow(getHandlerDatabaseClient(), TENANT_A, (tx) =>
          enqueueWhatsappMessage(tx, {
            tenantId: TENANT_A,
            toPhone: "+6281234567890",
            templateKey: "commerce.customer_otp",
            variables: {
              code: "123456",
              expiresInMinutes: "10",
              storeName: "A"
            },
            correlationId: "cli-drain"
          })
        );

        const result = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "upstream",
          "--reason",
          "too early",
          "--ack-warnings"
        );

        expect(result.exitCode).toBe(1);
        const evidence = JSON.parse(result.stdout) as Evidence;
        expect(evidence.refusal?.code).toBe("DRAIN_PENDING");
        expect(evidence.queues.legacy.nonTerminal).toBe(1);
        expect(await modeOf(TENANT_A)).toBe("legacy");
      }
    );

    run(
      "--wait polls with dry runs until the old queue drains, then makes the one real attempt (one flip audit event, no audit per poll)",
      async () => {
        await withTenantOrThrow(getHandlerDatabaseClient(), TENANT_A, (tx) =>
          enqueueWhatsappMessage(tx, {
            tenantId: TENANT_A,
            toPhone: "+6281234567890",
            templateKey: "commerce.customer_otp",
            variables: {
              code: "123456",
              expiresInMinutes: "10",
              storeName: "A"
            },
            correlationId: "cli-wait"
          })
        );
        // The legacy dispatcher's job, done by hand a few seconds in.
        const drain = Bun.sleep(2500).then(
          () =>
            getHandlerAdminSql()`
            UPDATE awcms_commerce_whatsapp_messages SET status = 'sent' WHERE tenant_id = ${TENANT_A}
          `
        );

        const result = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "upstream",
          "--reason",
          "patient",
          "--ack-warnings",
          "--wait",
          "60"
        );
        await drain;

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain(
          "waiting for the legacy queue to drain"
        );
        expect(JSON.parse(result.stdout).outcome).toBe("flipped");
        expect(await auditActions(TENANT_A)).toEqual(["whatsapp_mode.flip"]);
      }
    );

    run(
      "--wait gives up at the deadline with the one real attempt: a single audited refusal",
      async () => {
        await withTenantOrThrow(getHandlerDatabaseClient(), TENANT_A, (tx) =>
          enqueueWhatsappMessage(tx, {
            tenantId: TENANT_A,
            toPhone: "+6281234567890",
            templateKey: "commerce.customer_otp",
            variables: {
              code: "123456",
              expiresInMinutes: "10",
              storeName: "A"
            },
            correlationId: "cli-wait-timeout"
          })
        );

        const result = await cli(
          "--tenant",
          TENANT_A,
          "--to",
          "upstream",
          "--reason",
          "impatient",
          "--ack-warnings",
          "--wait",
          "1"
        );

        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout).refusal.code).toBe("DRAIN_PENDING");
        expect(await auditActions(TENANT_A)).toEqual([
          "whatsapp_mode.flip_refused"
        ]);
      }
    );

    run(
      "bad usage is exit 2 with nothing on stdout; an unknown tenant is exit 2",
      async () => {
        const usage = await cli("--tenant", TENANT_A, "--to", "upstream");
        expect(usage.exitCode).toBe(2);
        expect(usage.stdout).toBe("");
        expect(usage.stderr).toContain("--reason");

        const missing = await cli(
          "--tenant",
          "39300000-0000-4000-8000-0000000000ff",
          "--status"
        );
        expect(missing.exitCode).toBe(2);
        expect(missing.stderr).toContain("does not exist");
      }
    );
  });
});

const TENANT_A = "39300000-0000-4000-8000-00000000000a";
