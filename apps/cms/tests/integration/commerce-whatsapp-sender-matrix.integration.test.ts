/**
 * Commerce's `upstream`-mode WhatsApp path across tenant-configurable senders,
 * against a real migrated PostgreSQL (Issue #466 acceptance items 2, 3 and 5;
 * template-side half). WORLD 1 (see `harness.ts`): the ephemeral database, the
 * least-privilege `awcms_app` role, RLS enforced, `awcms_worker` for dispatch.
 *
 * Commerce adds NO sender routing of its own (ADR-0047, issue #466 non-goals):
 * `enqueueWhatsappMessage` in `upstream` mode calls `WhatsappDeliveryPort.enqueue`
 * and the upstream queue decides the sender from the tenant's default-sender
 * policy. What this file proves is that commerce, as a CONSUMER, inherits the
 * guarantees and does not undermine them:
 *
 *   - the sender is PINNED on the queued row; a later change of the tenant's
 *     default affects only NEW commerce messages, and the older row is dispatched
 *     through the sender it was queued with (a mock provider records which);
 *   - a default sender that is not usable (disconnected, or its adapter switched
 *     off) is a returned refusal `SENDER_UNAVAILABLE`: nothing is queued, no other
 *     device is tried and the provider is never called (fail closed, no reroute);
 *   - another tenant's `senderAccountId` named through the port is the same
 *     refusal as an unknown one, and queues nothing;
 *   - the queue's events and the audit trail carry the MASKED recipient only,
 *     never the number, the device key or the device's external id.
 *
 * Not covered here, on purpose: campaign sender selection (blocked on #458,
 * `docs/deployment.md` lists the pending rows) and Meta numbers (a tenant-owned
 * Meta number sends only provider-approved templates, which commerce's four
 * templates do not carry).
 *
 * Gated on `DATABASE_URL` (harness). FIXTURES ARE NOT LIVE TRAFFIC: the phone
 * number is reserved-format fake, every token is a fixture string, the provider is
 * a mock with no network. Never hands a Bun.SQL query to `expect(...).rejects`.
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

import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { createChannelAccountPortAdapter } from "../../src/modules/channel-accounts/application/channel-account-port-adapter";
import { createChannelSenderCredentialAdapter } from "../../src/modules/channel-accounts/application/channel-sender-credential-adapter";
import {
  createKeyRingSecretStore,
  resetSecretDecryptCounts
} from "../../src/modules/channel-accounts/application/secret-store";
import { resolveChannelSecretsRing } from "../../src/modules/channel-accounts/domain/channel-accounts-config";
import { PROVIDER_MATRIX_VERSION } from "../../src/modules/channel-accounts/domain/provider-matrix";
import { enqueueWhatsappMessage } from "../../src/modules/commerce/application/whatsapp-enqueue";
import { flipWhatsappMode } from "../../src/modules/commerce/application/whatsapp-mode-flip";
import {
  dispatchWhatsappQueue,
  type DispatchWhatsappQueueOptions
} from "../../src/modules/whatsapp-delivery/application/whatsapp-dispatch";
import { whatsappDeliveryPortAdapter } from "../../src/modules/whatsapp-delivery/application/whatsapp-enqueue";
import { setSenderPolicy } from "../../src/modules/whatsapp-delivery/application/whatsapp-sender-directory";
import type {
  WhatsappProvider,
  WhatsappSendRequest
} from "../../src/modules/whatsapp-delivery/domain/whatsapp-provider-contract";
import type { BuildSenderProviderInput } from "../../src/modules/whatsapp-delivery/infrastructure/whatsapp-sender-providers";
import {
  getAdminSql,
  getRuntimeSql,
  getWorkerRoleSql,
  integrationEnabled,
  reassertRuntimeRoleLogins,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase,
  workerRoleActivated
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "46600000-0000-4000-8000-00000000000a";
const TENANT_B = "46600000-0000-4000-8000-00000000000b";
const PHONE = "+6281234567890";

const bytes = (mul: number) =>
  Buffer.from(
    Array.from({ length: 32 }, (_, i) => (i * mul + 3) % 251)
  ).toString("base64");
const HASH_KEY = bytes(7);
const SECRET_KEY = bytes(11);

const ring = resolveChannelSecretsRing({
  CHANNEL_SECRETS_ENCRYPTION_KEYS: `k1:${SECRET_KEY}`
} as unknown as NodeJS.ProcessEnv);

if (!ring.ok) throw new Error(ring.reason);

const store = createKeyRingSecretStore(() => ring);

/** The environment variables the default (process-environment) enqueue path reads. */
const ENV_KEYS = [
  "WHATSAPP_ENABLED",
  "WHATSAPP_PROVIDER",
  "WHATSAPP_RECIPIENT_HASH_KEYS",
  "WHATSAPP_STARSENDER_ENABLED",
  "CHANNEL_ACCOUNTS_ENABLED",
  "CHANNEL_SECRETS_ENCRYPTION_KEYS",
  "COMMERCE_WHATSAPP_ENABLED",
  "COMMERCE_WHATSAPP_PROVIDER"
] as const;
const SAVED: Record<string, string | undefined> = {};

function setEnv(starsender = true) {
  process.env.WHATSAPP_ENABLED = "true";
  process.env.WHATSAPP_PROVIDER = "log";
  process.env.WHATSAPP_RECIPIENT_HASH_KEYS = `k1:${HASH_KEY}`;
  process.env.CHANNEL_ACCOUNTS_ENABLED = "true";
  process.env.CHANNEL_SECRETS_ENCRYPTION_KEYS = `k1:${SECRET_KEY}`;
  process.env.COMMERCE_WHATSAPP_ENABLED = "true";
  process.env.COMMERCE_WHATSAPP_PROVIDER = "log";

  if (starsender) process.env.WHATSAPP_STARSENDER_ENABLED = "true";
  else delete process.env.WHATSAPP_STARSENDER_ENABLED;
}

const runtime = () => getRuntimeSql();
const inTenant = <T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
) => withTenantOrThrow(runtime(), tenantId, fn);

let deviceSequence = 4_000_000_000;
const nextDeviceId = () => String((deviceSequence += 1));

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

/** A tenant user, returned by id: the flip's actor and the sender policy's actor. */
async function seedUser(tenantId: string): Promise<string> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Matrix Test Actor') RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`matrix-${crypto.randomUUID()}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  const user = (await admin`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
  `) as { id: string }[];

  return user[0]!.id;
}

/** sql/340: a StarSender device cannot be connected without an active acknowledgement. */
async function ensureRiskAcknowledgement(
  tenantId: string,
  userId: string
): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_channel_provider_risk_acknowledgements
      (tenant_id, provider, tenant_user_id, text_version, text_sha256)
    SELECT ${tenantId}, 'starsender', ${userId}, 'fixture-v1', ${"0".repeat(64)}
    WHERE NOT EXISTS (
      SELECT 1 FROM awcms_channel_provider_risk_acknowledgements
      WHERE tenant_id = ${tenantId} AND provider = 'starsender' AND revoked_at IS NULL
    )
  `;
}

type Device = { id: string; externalId: string; token: string };

/** A connected StarSender device with its evidence and a fixture key, through the real secret store. */
async function seedDevice(tenantId: string, userId: string): Promise<Device> {
  const admin = getAdminSql();
  const externalId = nextDeviceId();
  const token = `FIXTURE-KEY-${externalId}`;

  await ensureRiskAcknowledgement(tenantId, userId);

  const rows = (await admin`
    INSERT INTO awcms_channel_accounts
      (tenant_id, provider, account_kind, external_id, display_name,
       auth_mode, status)
    VALUES (${tenantId}, 'starsender', 'device', ${externalId},
            ${`device-${externalId}`}, 'device_key', 'connected')
    RETURNING id
  `) as { id: string }[];
  const id = rows[0]!.id;

  for (const capability of ["dm", "reply", "broadcast"]) {
    await admin`
      INSERT INTO awcms_channel_account_capabilities
        (tenant_id, account_id, capability, state, evidence_kind,
         evidence_ref, matrix_version, verified_at)
      VALUES (${tenantId}, ${id}, ${capability}, 'granted',
              ${capability === "broadcast" ? "contract_reference" : "app_review_reference"},
              'evidence-1', ${PROVIDER_MATRIX_VERSION}, now())
    `;
  }

  const ref = await inTenant(tenantId, (tx) =>
    store.put(tx, {
      tenantId,
      purpose: "device_key",
      plaintext: token,
      createdBy: null
    })
  );

  await admin`UPDATE awcms_channel_accounts SET secret_id = ${ref.secretId} WHERE id = ${id}`;

  return { id, externalId, token };
}

const CA_ENV = {
  CHANNEL_ACCOUNTS_ENABLED: "true"
} as unknown as NodeJS.ProcessEnv;
const senders = createChannelAccountPortAdapter({ env: CA_ENV });
const credentials = createChannelSenderCredentialAdapter({
  store,
  env: CA_ENV
});

async function setDefault(
  tenantId: string,
  userId: string,
  deviceId: string | null
) {
  return await inTenant(tenantId, (tx) =>
    setSenderPolicy(
      tx,
      tenantId,
      userId,
      { businessScope: null, defaultSenderAccountId: deviceId },
      senders
    )
  );
}

async function setUpstreamMode(tenantId: string, userId: string) {
  return await inTenant(tenantId, (tx) =>
    flipWhatsappMode(
      tx,
      tenantId,
      { tenantUserId: userId, surface: "api" },
      "upstream",
      {
        reason: "integration test",
        acknowledgeWarnings: true,
        env: process.env
      }
    )
  );
}

const OTP_VARIABLES = {
  code: "246810",
  expiresInMinutes: "10",
  storeName: "Toko Uji"
};

let correlation = 0;

/** A commerce message through commerce's OWN entry point (the router), as the customer OTP does. */
function commerceEnqueue(tenantId: string, phone = PHONE) {
  return inTenant(tenantId, (tx) =>
    enqueueWhatsappMessage(tx, {
      tenantId,
      toPhone: phone,
      templateKey: "commerce.customer_otp",
      variables: OTP_VARIABLES,
      correlationId: `matrix-${(correlation += 1)}`
    })
  );
}

async function messageRow(id: string) {
  return (
    (await getAdminSql()`
      SELECT id, status, sender_account_id, sender_selection, recipient_masked
      FROM awcms_whatsapp_messages WHERE id = ${id}
    `) as {
      id: string;
      status: string;
      sender_account_id: string | null;
      sender_selection: string;
      recipient_masked: string;
    }[]
  )[0]!;
}

async function queueCount(tenantId: string): Promise<number> {
  return (
    (await getAdminSql()`
      SELECT count(*)::int AS n FROM awcms_whatsapp_messages WHERE tenant_id = ${tenantId}
    `) as { n: number }[]
  )[0]!.n;
}

type Sent = { senderAccountId: string | null; request: WhatsappSendRequest };

/** A dispatcher with NO network: every provider is a mock that records the sender it was built for. */
function mockDispatchOptions(
  sent: Sent[],
  built: BuildSenderProviderInput[]
): DispatchWhatsappQueueOptions {
  const make = (senderAccountId: string | null): WhatsappProvider => ({
    async send(request) {
      sent.push({ senderAccountId, request });

      return { ok: true, providerMessageId: `mock-${sent.length}` };
    },
    async healthCheck() {
      return { ok: true };
    }
  });

  return {
    env: process.env,
    senders,
    credentials,
    now: new Date(Date.now() + 1000),
    resolveProvider: () => make(null),
    buildSenderProvider: (input) => {
      built.push(input);

      return make(input.sender.accountId);
    }
  };
}

async function requireWorkerRole(): Promise<void> {
  await reassertRuntimeRoleLogins();

  if (!workerRoleActivated) {
    throw new Error(
      "awcms_worker is not provisioned or cannot log in: a skipped assertion is not a pass."
    );
  }
}

suite("commerce upstream WhatsApp across tenant senders (Issue #466)", () => {
  let userA = "";
  let userB = "";

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
    resetProviderCircuitBreakersForTests();
    resetSecretDecryptCounts();
    await seedTenant(TENANT_A, "matrix-a");
    await seedTenant(TENANT_B, "matrix-b");
    userA = await seedUser(TENANT_A);
    userB = await seedUser(TENANT_B);
    await setUpstreamMode(TENANT_A, userA);
    await setUpstreamMode(TENANT_B, userB);
  }, 60000);

  afterEach(() => setEnv());

  test("a queued commerce message stays pinned to its sender across a default switch; only new messages follow the new default", async () => {
    await requireWorkerRole();

    const s1 = await seedDevice(TENANT_A, userA);
    const s2 = await seedDevice(TENANT_A, userA);

    expect(await setDefault(TENANT_A, userA, s1.id)).toMatchObject({
      outcome: "set"
    });

    const first = await commerceEnqueue(TENANT_A);

    expect(first.enqueued).toBe(true);

    expect(await setDefault(TENANT_A, userA, s2.id)).toMatchObject({
      outcome: "set",
      changed: true
    });

    const second = await commerceEnqueue(TENANT_A, "+6281234567891");

    expect(second.enqueued).toBe(true);

    // The earlier row KEEPS S1; the later one is S2.
    expect((await messageRow(first.id)).sender_account_id).toBe(s1.id);
    expect((await messageRow(second.id)).sender_account_id).toBe(s2.id);

    // And dispatch goes through each row's OWN pinned sender, not the current default.
    const sent: Sent[] = [];
    const built: BuildSenderProviderInput[] = [];

    await dispatchWhatsappQueue(
      getWorkerRoleSql(),
      TENANT_A,
      mockDispatchOptions(sent, built)
    );

    expect(sent.map((entry) => entry.senderAccountId).sort()).toEqual(
      [s1.id, s2.id].sort()
    );
  });

  test("a default sender that is not usable refuses the commerce message and reroutes to no other device or provider", async () => {
    await requireWorkerRole();

    const s1 = await seedDevice(TENANT_A, userA);
    const s2 = await seedDevice(TENANT_A, userA);

    await setDefault(TENANT_A, userA, s1.id);
    // S1 is blocked at the provider; S2 is healthy and WOULD be a tempting fallback.
    await getAdminSql()`
      UPDATE awcms_channel_accounts SET status = 'disconnected' WHERE id = ${s1.id}
    `;

    const refused = await commerceEnqueue(TENANT_A);

    expect(refused.enqueued).toBe(false);
    expect(refused).toMatchObject({ reason: "SENDER_UNAVAILABLE" });
    expect(await queueCount(TENANT_A)).toBe(0);

    const sent: Sent[] = [];
    const built: BuildSenderProviderInput[] = [];

    await dispatchWhatsappQueue(
      getWorkerRoleSql(),
      TENANT_A,
      mockDispatchOptions(sent, built)
    );

    expect(sent).toHaveLength(0);
    expect(built.some((input) => input.sender.accountId === s2.id)).toBe(false);
  });

  test("fails closed when the StarSender adapter is switched off: a default pointing at a device refuses instead of falling back to the deployment provider", async () => {
    const s1 = await seedDevice(TENANT_A, userA);

    await setDefault(TENANT_A, userA, s1.id);
    setEnv(false);

    const refused = await commerceEnqueue(TENANT_A);

    expect(refused).toMatchObject({
      enqueued: false,
      reason: "SENDER_UNAVAILABLE"
    });
    expect(await queueCount(TENANT_A)).toBe(0);
  });

  test("another tenant's senderAccountId, named through the port, is refused like an unknown one and queues nothing", async () => {
    const foreign = await seedDevice(TENANT_B, userB);
    const outcome = await inTenant(TENANT_A, (tx) =>
      whatsappDeliveryPortAdapter.enqueue(tx, {
        tenantId: TENANT_A,
        templateKey: "commerce.customer_otp",
        variables: OTP_VARIABLES,
        recipient: { kind: "address", phone: PHONE },
        idempotencyKey: `spoof-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
        senderAccountId: foreign.id
      })
    );

    expect(outcome).toEqual({
      status: "refused",
      reason: "SENDER_UNAVAILABLE"
    });

    const unknown = await inTenant(TENANT_A, (tx) =>
      whatsappDeliveryPortAdapter.enqueue(tx, {
        tenantId: TENANT_A,
        templateKey: "commerce.customer_otp",
        variables: OTP_VARIABLES,
        recipient: { kind: "address", phone: PHONE },
        idempotencyKey: `spoof-${crypto.randomUUID()}`,
        expiresAt: new Date(Date.now() + 600_000),
        senderAccountId: crypto.randomUUID()
      })
    );

    // Same answer: the response does not reveal that the foreign id exists.
    expect(unknown).toEqual(outcome);
    expect(await queueCount(TENANT_A)).toBe(0);
  });

  test("tenant B's own policy never leaks into tenant A: each tenant's message pins its own device", async () => {
    const sA = await seedDevice(TENANT_A, userA);
    const sB = await seedDevice(TENANT_B, userB);

    await setDefault(TENANT_A, userA, sA.id);
    await setDefault(TENANT_B, userB, sB.id);

    const a = await commerceEnqueue(TENANT_A);
    const b = await commerceEnqueue(TENANT_B);

    expect((await messageRow(a.id)).sender_account_id).toBe(sA.id);
    expect((await messageRow(b.id)).sender_account_id).toBe(sB.id);
  });

  test("events and the audit trail carry the masked recipient only: no number, no device key, no device id", async () => {
    await requireWorkerRole();

    const s1 = await seedDevice(TENANT_A, userA);

    await setDefault(TENANT_A, userA, s1.id);

    const queued = await commerceEnqueue(TENANT_A);
    const sent: Sent[] = [];

    await dispatchWhatsappQueue(
      getWorkerRoleSql(),
      TENANT_A,
      mockDispatchOptions(sent, [])
    );

    const row = await messageRow(queued.id);

    expect(row.recipient_masked).not.toContain("1234567890");
    expect(row.recipient_masked).toContain("****");

    const evidence = JSON.stringify([
      await getAdminSql()`
        SELECT payload FROM awcms_domain_events WHERE tenant_id = ${TENANT_A}
      `,
      await getAdminSql()`
        SELECT action, message, attributes FROM awcms_audit_events WHERE tenant_id = ${TENANT_A}
      `
    ]);

    expect(evidence).not.toContain(PHONE);
    expect(evidence).not.toContain("81234567890");
    expect(evidence).not.toContain(s1.token);
    expect(evidence).not.toContain(s1.externalId);
    expect(evidence).not.toContain(OTP_VARIABLES.code);
  });
});
