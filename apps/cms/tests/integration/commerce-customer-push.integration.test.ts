/**
 * Customer Web Push against a REAL migrated PostgreSQL (Issue #430, ADR-0048),
 * through `tests/integration/harness.ts` (world 1): the least-privilege runtime
 * role under FORCE RLS, the worker role for what a job may and may not do, and
 * the schema OWNER where a constraint (not RLS) is the property under test.
 * Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * What only a database proves, with the ADR's regression handles:
 *
 *   TS-I1  FORCE RLS, composite foreign keys across tenants, unique/CHECK
 *          constraints, worker column grants (cannot INSERT a device or rewrite
 *          the identity columns), the credentials-iff-active CHECK
 *   TS-I2  concurrent registration of one endpoint by two accounts: one owner,
 *          queued messages cancelled, one transfer audit event; the device cap
 *          under concurrency
 *   TS-I3  logout revokes exactly that session's devices
 *   TS-I4  (partial, #430's half) a customer can neither see nor revoke
 *          another customer's device; a tenant cannot reach another tenant's
 *   TS-I5  the outbox: dedupe per (event, device), the per-account rolling cap
 *   TS-I7  retention: the purge touches only tombstones and terminal rows;
 *          credentials are destroyed on every non-active status; erasure
 *          deletes the account's rows; key re-rotation; fail-closed without
 *          the ring
 *
 * Plus: idempotent registration, the audit trail carries ids only, no plaintext
 * credential at rest, and the diagnostics are aggregate-only.
 */
import { randomBytes } from "node:crypto";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { FieldEncryptionError } from "../../src/lib/security/field-encryption";
import { updateCustomer } from "../../src/modules/commerce/application/customer-directory";
import { fetchCustomerPushDiagnostics } from "../../src/modules/commerce/application/customer-push-diagnostics";
import {
  listOwnCustomerPushDevices,
  loadCustomerPushDeliveryTarget,
  registerCustomerPushDevice,
  revokeAllOwnCustomerPushDevices,
  revokeCustomerPushDevicesOfSession,
  revokeOwnCustomerPushDevice,
  type RegisterCustomerPushInput
} from "../../src/modules/commerce/application/customer-push-devices";
import {
  eraseCustomerPushData,
  exportCustomerPushData
} from "../../src/modules/commerce/application/customer-push-erasure";
import { purgeCustomerPushForTenant } from "../../src/modules/commerce/application/customer-push-maintenance";
import {
  countRecentMessagesForAccount,
  enqueueCustomerPushMessage
} from "../../src/modules/commerce/application/customer-push-outbox";
import {
  applyPreferenceChanges,
  listCustomerPushPreferences
} from "../../src/modules/commerce/application/customer-push-preferences";
import {
  countCustomerPushCredentialsByKeyId,
  rekeyCustomerPushCredentialsForTenant
} from "../../src/modules/commerce/application/customer-push-rekey";
import {
  CUSTOMER_PUSH_CONSENT_TEXT_VERSION,
  CUSTOMER_PUSH_MAX_DEVICES
} from "../../src/modules/commerce/domain/customer-push";
import { decryptCustomerPushAuthSecret } from "../../src/modules/commerce/domain/customer-push-secrets";
import { resolvePushAuthSecretRing } from "../../src/modules/push-delivery/domain/push-auth-secret";
import {
  assertRejected,
  assertRejectedInSavepoint,
  createRuntimePool,
  getAdminSql,
  getOwnerSql,
  getRuntimeSql,
  getWorkerRoleSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase,
  workerRoleActivated
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "11111111-1111-4111-8111-111111111430";
const TENANT_B = "22222222-2222-4222-8222-222222222430";
const ORIGIN = "https://shop-a.example.test";
const VERSION = CUSTOMER_PUSH_CONSENT_TEXT_VERSION;

const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString(
  "base64url"
);

function ringFrom(spec: string) {
  const ring = resolvePushAuthSecretRing({
    PUSH_AUTH_SECRET_ENCRYPTION_KEYS: spec
  } as NodeJS.ProcessEnv);
  if (!ring.ok) throw new Error(ring.reason);
  return ring;
}

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const RING_A = ringFrom(`ka:${KEY_A}`);
const RING_BA = ringFrom(`kb:${KEY_B},ka:${KEY_A}`);

let endpointSeq = 0;
/** A unique, plausible FCM endpoint. The tail is the part a mask keeps. */
function newEndpoint(): string {
  endpointSeq += 1;
  return `https://fcm.googleapis.com/fcm/send/dev${endpointSeq}:APA91bSECRETTOKEN${endpointSeq}xyz`;
}

/**
 * The scheduled job's transaction shape: `awcms_worker` under a per-tenant
 * context, on a transaction of its own. Used instead of `withTenantOrThrow`
 * where a test deliberately provokes several `permission denied` errors in a row:
 * those count against the process-wide database circuit breaker, which would
 * then refuse the next assertion for a reason that has nothing to do with it.
 */
function workerTx<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return getWorkerRoleSql().begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    return fn(tx);
  });
}

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

async function seedTenant(id: string, code: string): Promise<void> {
  await getAdminSql()`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active', 'en', 'light')
    ON CONFLICT (id) DO NOTHING
  `;
}

type Shopper = {
  tenantId: string;
  customerId: string;
  accountId: string;
  sessionId: string;
};

let shopperSeq = 0;
async function seedShopper(
  tenantId: string,
  options: { blocked?: boolean; verified?: boolean } = {}
): Promise<Shopper> {
  shopperSeq += 1;
  const admin = getAdminSql();
  const customer = (await admin`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
    VALUES (${tenantId}, ${`Shopper ${shopperSeq}`}, ${`+62812000${String(shopperSeq).padStart(5, "0")}`})
    RETURNING id
  `) as { id: string }[];
  const account = (await admin`
    INSERT INTO awcms_commerce_customer_accounts
      (tenant_id, customer_id, email_normalized, status, email_verified_at, history_from)
    VALUES (${tenantId}, ${customer[0]!.id}, ${`shopper${shopperSeq}@example.test`},
            ${options.blocked ? "blocked" : "active"},
            ${options.verified === false ? null : new Date()}, now() - interval '1 day')
    RETURNING id
  `) as { id: string }[];
  const session = await seedSession(tenantId, account[0]!.id);
  return {
    tenantId,
    customerId: customer[0]!.id,
    accountId: account[0]!.id,
    sessionId: session
  };
}

let tokenSeq = 0;
async function seedSession(
  tenantId: string,
  accountId: string,
  options: { expiresAt?: Date; revokedAt?: Date | null } = {}
): Promise<string> {
  tokenSeq += 1;
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_customer_sessions
      (tenant_id, account_id, token_hash, expires_at, revoked_at)
    VALUES (${tenantId}, ${accountId}, ${`sha256:test${tokenSeq}`},
            ${options.expiresAt ?? new Date(Date.now() + 86_400_000)},
            ${options.revokedAt ?? null})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

function registerInput(
  who: Shopper,
  overrides: Partial<RegisterCustomerPushInput> = {}
): RegisterCustomerPushInput {
  return {
    tenantId: who.tenantId,
    accountId: who.accountId,
    sessionId: who.sessionId,
    storefrontOrigin: ORIGIN,
    endpoint: newEndpoint(),
    p256dhKey: P256DH,
    authSecret: Buffer.alloc(16, 9).toString("base64url"),
    userAgentSummary: "Chrome on Android (mobile)",
    consent: { purposes: ["order_updates"], textVersion: VERSION },
    ring: RING_A,
    ...overrides
  };
}

function register(
  who: Shopper,
  overrides: Partial<RegisterCustomerPushInput> = {}
) {
  const input = registerInput(who, overrides);
  return {
    input,
    outcome: inTenant(who.tenantId, (tx) =>
      registerCustomerPushDevice(tx, input)
    )
  };
}

type DeviceRow = Record<string, unknown> & {
  id: string;
  status: string;
  account_id: string;
  endpoint_ciphertext: string | null;
  auth_secret_ciphertext: string | null;
  p256dh_key: string | null;
  revoked_at: Date | null;
  status_reason: string | null;
};

async function deviceRows(tenantId?: string): Promise<DeviceRow[]> {
  if (tenantId) {
    return (await getAdminSql()`
      SELECT * FROM awcms_commerce_push_devices
      WHERE tenant_id = ${tenantId} ORDER BY created_at, id
    `) as DeviceRow[];
  }
  return (await getAdminSql()`
    SELECT * FROM awcms_commerce_push_devices ORDER BY created_at, id
  `) as DeviceRow[];
}

async function seedStaff(tenantId: string): Promise<string> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Push Test Staff')
    RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`push-staff-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  const user = (await admin`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identity[0]!.id})
    RETURNING id
  `) as { id: string }[];
  return user[0]!.id;
}

async function queueMessage(
  who: Shopper,
  deviceId: string,
  options: {
    eventId?: string;
    purpose?: "order_updates" | "payment_updates";
  } = {}
) {
  return inTenant(who.tenantId, (tx) =>
    enqueueCustomerPushMessage(tx, {
      tenantId: who.tenantId,
      accountId: who.accountId,
      deviceId,
      sourceEventId: options.eventId ?? crypto.randomUUID(),
      eventType: "awcms.commerce.order.paid",
      purpose: options.purpose ?? "payment_updates",
      priority: "high",
      tag: "payment",
      title: "Payment update",
      body: "Open your account to see it.",
      expiresAt: new Date(Date.now() + 4 * 3_600_000)
    })
  );
}

async function messageRows(): Promise<
  {
    id: string;
    status: string;
    last_error: string | null;
    target_path: string;
  }[]
> {
  return (await getAdminSql()`
    SELECT id, status, last_error, target_path
    FROM awcms_commerce_push_messages ORDER BY created_at, id
  `) as never;
}

suite("customer Web Push - devices, consent, outbox (Issue #430)", () => {
  beforeAll(async () => {
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    await resetDatabase();
    await seedTenant(TENANT_A, "push-a");
    await seedTenant(TENANT_B, "push-b");
  }, 30000);

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  test("registers a device: ciphertext at rest, a mask for display, consent recorded", async () => {
    const shopper = await seedShopper(TENANT_A);
    const { input, outcome } = register(shopper);
    const result = await outcome;

    expect(result.kind).toBe("registered");
    if (result.kind !== "registered") return;
    expect(result.transferred).toBe(false);

    const rows = await deviceRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("active");
    expect(row.account_id).toBe(shopper.accountId);
    expect(row.storefront_origin).toBe(ORIGIN);
    expect(row.user_agent_summary).toBe("Chrome on Android (mobile)");

    // No plaintext credential anywhere at rest (I3): not in a column, not in the
    // whole row serialised.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("SECRETTOKEN");
    expect(serialised).not.toContain("fcm.googleapis.com/fcm/send");
    expect(String(row.endpoint_ciphertext)).toMatch(/^v2:ka:/);
    expect(String(row.auth_secret_ciphertext)).toMatch(/^v2:ka:/);
    expect(row.endpoint_masked).toStartWith("https://fcm.googleapis.com/…");
    expect(String(row.endpoint_masked)).not.toContain("SECRETTOKEN");

    const preferences = await inTenant(TENANT_A, (tx) =>
      listCustomerPushPreferences(tx, TENANT_A, shopper.accountId)
    );
    const order = preferences.find((p) => p.purpose === "order_updates")!;
    expect(order.enabled).toBe(true);
    expect(order.consentTextVersion).toBe(VERSION);
    expect(order.grantedAt).not.toBeNull();
    expect(
      preferences.find((p) => p.purpose === "payment_updates")!.enabled
    ).toBe(false);

    // The delivery target decrypts back to exactly what was registered.
    const target = await inTenant(TENANT_A, (tx) =>
      loadCustomerPushDeliveryTarget(tx, TENANT_A, row.id, RING_A)
    );
    expect(target?.target.endpoint).toBe(input.endpoint);
    expect(target?.target.authSecret).toBe(input.authSecret);
    expect(target?.target.transport).toBe("web_push");
    expect(target?.accountId).toBe(shopper.accountId);
    expect(target?.storefrontOrigin).toBe(ORIGIN);
  });

  test("registration is idempotent: the same endpoint twice is one row, the second is unchanged and not re-audited", async () => {
    const shopper = await seedShopper(TENANT_A);
    const endpoint = newEndpoint();

    const first = await register(shopper, { endpoint }).outcome;
    const second = await register(shopper, { endpoint }).outcome;

    expect(first.kind).toBe("registered");
    expect(second.kind).toBe("unchanged");
    expect(await deviceRows()).toHaveLength(1);

    const audit = (await getAdminSql()`
      SELECT action FROM awcms_audit_events
      WHERE action LIKE 'commerce.customer_push.%' ORDER BY created_at, id
    `) as { action: string }[];
    expect(
      audit.filter(
        (a) => a.action === "commerce.customer_push.device_registered"
      )
    ).toHaveLength(1);
    expect(
      audit.filter(
        (a) => a.action === "commerce.customer_push.preferences_changed"
      )
    ).toHaveLength(1);
  });

  test("a re-registration from a new session by the same account rebinds the session", async () => {
    const shopper = await seedShopper(TENANT_A);
    const endpoint = newEndpoint();
    await register(shopper, { endpoint }).outcome;

    const secondSession = await seedSession(TENANT_A, shopper.accountId);
    const result = await register(shopper, {
      endpoint,
      sessionId: secondSession
    }).outcome;

    expect(result.kind).toBe("unchanged");
    expect((await deviceRows())[0]!.session_id).toBe(secondSession);
  });

  test("the list returns this account's active devices, masked, flagging the current session", async () => {
    const shopper = await seedShopper(TENANT_A);
    const other = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    await register(other).outcome;
    const otherSession = await seedSession(TENANT_A, shopper.accountId);
    await register(shopper, { sessionId: otherSession }).outcome;

    const devices = await inTenant(TENANT_A, (tx) =>
      listOwnCustomerPushDevices(
        tx,
        TENANT_A,
        shopper.accountId,
        shopper.sessionId
      )
    );

    expect(devices).toHaveLength(2);
    expect(devices.filter((d) => d.current)).toHaveLength(1);
    const serialised = JSON.stringify(devices);
    expect(serialised).not.toContain("SECRETTOKEN");
    expect(serialised).not.toContain("ciphertext");
    for (const device of devices) {
      expect(Object.keys(device).sort()).toEqual(
        [
          "current",
          "endpointMasked",
          "id",
          "lastSuccessAt",
          "registeredAt",
          "status",
          "userAgentSummary"
        ].sort()
      );
    }
  });

  // -------------------------------------------------------------------------
  // The device cap
  // -------------------------------------------------------------------------

  test("the sixth device is refused before anything is written; a re-registration of one of the five still succeeds", async () => {
    const shopper = await seedShopper(TENANT_A);
    const endpoints: string[] = [];
    for (let i = 0; i < CUSTOMER_PUSH_MAX_DEVICES; i += 1) {
      const endpoint = newEndpoint();
      endpoints.push(endpoint);
      expect((await register(shopper, { endpoint }).outcome).kind).toBe(
        "registered"
      );
    }

    const before = (
      await inTenant(TENANT_A, (tx) =>
        listCustomerPushPreferences(tx, TENANT_A, shopper.accountId)
      )
    ).find((p) => p.purpose === "support_replies")!;
    expect(before.enabled).toBe(false);

    const sixth = await register(shopper, {
      consent: { purposes: ["support_replies"], textVersion: VERSION }
    }).outcome;
    expect(sixth.kind).toBe("device_limit");
    expect(await deviceRows()).toHaveLength(5);

    // No consent row was written by the refused attempt.
    const after = (
      await inTenant(TENANT_A, (tx) =>
        listCustomerPushPreferences(tx, TENANT_A, shopper.accountId)
      )
    ).find((p) => p.purpose === "support_replies")!;
    expect(after.enabled).toBe(false);

    expect(
      (await register(shopper, { endpoint: endpoints[0]! }).outcome).kind
    ).toBe("unchanged");

    // Revoking one frees a slot.
    const [first] = await deviceRows();
    expect(
      await inTenant(TENANT_A, (tx) =>
        revokeOwnCustomerPushDevice(tx, TENANT_A, shopper.accountId, first!.id)
      )
    ).toBe(true);
    expect((await register(shopper).outcome).kind).toBe("registered");
  });

  test("the cap is per account: another account on the same tenant is unaffected", async () => {
    const heavy = await seedShopper(TENANT_A);
    const light = await seedShopper(TENANT_A);
    for (let i = 0; i < CUSTOMER_PUSH_MAX_DEVICES; i += 1) {
      await register(heavy).outcome;
    }
    expect((await register(light).outcome).kind).toBe("registered");
  });

  test("TS-I2: concurrent registrations of different endpoints cannot slip past the cap", async () => {
    const shopper = await seedShopper(TENANT_A);
    const pool = createRuntimePool(10);
    try {
      const outcomes = await Promise.all(
        Array.from({ length: 9 }, () =>
          withTenantOrThrow(pool, TENANT_A, (tx) =>
            registerCustomerPushDevice(tx, registerInput(shopper))
          )
        )
      );

      expect(outcomes.filter((o) => o.kind === "registered")).toHaveLength(
        CUSTOMER_PUSH_MAX_DEVICES
      );
      expect(outcomes.filter((o) => o.kind === "device_limit")).toHaveLength(4);
      const active = (await deviceRows()).filter((r) => r.status === "active");
      expect(active).toHaveLength(CUSTOMER_PUSH_MAX_DEVICES);
    } finally {
      await pool.close({ timeout: 1 });
    }
  });

  // -------------------------------------------------------------------------
  // Transfer (shared device)
  // -------------------------------------------------------------------------

  test("TS-I2: registering another account's endpoint is an explicit, audited transfer that cancels the previous owner's queued messages", async () => {
    const alice = await seedShopper(TENANT_A);
    const bob = await seedShopper(TENANT_A);
    const endpoint = newEndpoint();

    await register(alice, { endpoint }).outcome;
    const [device] = await deviceRows();
    const queued = await queueMessage(alice, device!.id);
    expect(queued.kind).toBe("enqueued");

    const result = await register(bob, { endpoint }).outcome;
    expect(result.kind).toBe("registered");
    if (result.kind === "registered") expect(result.transferred).toBe(true);

    // One row, now Bob's, with Bob's session.
    const rows = await deviceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_id).toBe(bob.accountId);
    expect(rows[0]!.session_id).toBe(bob.sessionId);
    expect(rows[0]!.status).toBe("active");

    // Alice's queued message is cancelled with a fixed code; nothing reaches Bob.
    const messages = await messageRows();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.status).toBe("cancelled");
    expect(messages[0]!.last_error).toBe("device_transferred");

    // Alice can no longer see or revoke it.
    expect(
      await inTenant(TENANT_A, (tx) =>
        listOwnCustomerPushDevices(
          tx,
          TENANT_A,
          alice.accountId,
          alice.sessionId
        )
      )
    ).toHaveLength(0);
    expect(
      await inTenant(TENANT_A, (tx) =>
        revokeOwnCustomerPushDevice(tx, TENANT_A, alice.accountId, device!.id)
      )
    ).toBe(false);

    // One transfer audit event, ids only.
    const audit = (await getAdminSql()`
      SELECT action, severity, attributes::text AS attributes
      FROM awcms_audit_events
      WHERE action = 'commerce.customer_push.device_transferred'
    `) as { action: string; severity: string; attributes: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.severity).toBe("warning");
    const attributes = JSON.parse(audit[0]!.attributes) as Record<
      string,
      unknown
    >;
    expect(attributes.previousAccountId).toBe(alice.accountId);
    expect(attributes.accountId).toBe(bob.accountId);
    expect(audit[0]!.attributes).not.toContain("SECRETTOKEN");
    expect(audit[0]!.attributes).not.toContain("fcm.googleapis.com");
  });

  test("TS-I2: two accounts racing to register one endpoint leave exactly one owner and one transfer event", async () => {
    const alice = await seedShopper(TENANT_A);
    const bob = await seedShopper(TENANT_A);
    const endpoint = newEndpoint();
    const pool = createRuntimePool(6);
    try {
      const outcomes = await Promise.all([
        withTenantOrThrow(pool, TENANT_A, (tx) =>
          registerCustomerPushDevice(tx, registerInput(alice, { endpoint }))
        ),
        withTenantOrThrow(pool, TENANT_A, (tx) =>
          registerCustomerPushDevice(tx, registerInput(bob, { endpoint }))
        )
      ]);

      expect(outcomes.every((o) => o.kind === "registered")).toBe(true);
      const rows = await deviceRows();
      expect(rows).toHaveLength(1);
      expect([alice.accountId, bob.accountId]).toContain(rows[0]!.account_id);

      const audit = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_audit_events
        WHERE action = 'commerce.customer_push.device_transferred'
      `) as { n: number }[];
      expect(audit[0]!.n).toBe(1);
    } finally {
      await pool.close({ timeout: 1 });
    }
  });

  test("a tombstoned endpoint re-registered by its own account is revived with fresh credentials", async () => {
    const shopper = await seedShopper(TENANT_A);
    const endpoint = newEndpoint();
    await register(shopper, { endpoint }).outcome;
    const [device] = await deviceRows();
    await inTenant(TENANT_A, (tx) =>
      revokeOwnCustomerPushDevice(tx, TENANT_A, shopper.accountId, device!.id)
    );

    const revived = await register(shopper, { endpoint }).outcome;
    expect(revived.kind).toBe("registered");
    if (revived.kind === "registered") expect(revived.transferred).toBe(false);

    const rows = await deviceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("active");
    expect(rows[0]!.revoked_at).toBeNull();
    expect(rows[0]!.status_reason).toBeNull();
    expect(rows[0]!.endpoint_ciphertext).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Revocation, isolation between customers and tenants
  // -------------------------------------------------------------------------

  test("revoking destroys the credentials in the same statement and keeps only a tombstone", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const [device] = await deviceRows();
    const queued = await queueMessage(shopper, device!.id);
    expect(queued.kind).toBe("enqueued");

    expect(
      await inTenant(TENANT_A, (tx) =>
        revokeOwnCustomerPushDevice(tx, TENANT_A, shopper.accountId, device!.id)
      )
    ).toBe(true);

    const [row] = await deviceRows();
    expect(row!.status).toBe("revoked");
    expect(row!.status_reason).toBe("customer_removed");
    expect(row!.endpoint_ciphertext).toBeNull();
    expect(row!.p256dh_key).toBeNull();
    expect(row!.auth_secret_ciphertext).toBeNull();
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.endpoint_hash).toMatch(/^[0-9a-f]{64}$/);

    expect((await messageRows())[0]!.status).toBe("cancelled");

    // A second revoke is indistinguishable from an absent device.
    expect(
      await inTenant(TENANT_A, (tx) =>
        revokeOwnCustomerPushDevice(tx, TENANT_A, shopper.accountId, device!.id)
      )
    ).toBe(false);

    // The delivery target of a tombstone is gone.
    expect(
      await inTenant(TENANT_A, (tx) =>
        loadCustomerPushDeliveryTarget(tx, TENANT_A, device!.id, RING_A)
      )
    ).toBeNull();
  });

  test("TS-I4: a customer cannot see or revoke another customer's device", async () => {
    const alice = await seedShopper(TENANT_A);
    const mallory = await seedShopper(TENANT_A);
    await register(alice).outcome;
    const [device] = await deviceRows();

    expect(
      await inTenant(TENANT_A, (tx) =>
        revokeOwnCustomerPushDevice(tx, TENANT_A, mallory.accountId, device!.id)
      )
    ).toBe(false);
    expect(
      await inTenant(TENANT_A, (tx) =>
        listOwnCustomerPushDevices(
          tx,
          TENANT_A,
          mallory.accountId,
          mallory.sessionId
        )
      )
    ).toHaveLength(0);
    expect(
      await inTenant(TENANT_A, (tx) =>
        revokeAllOwnCustomerPushDevices(tx, TENANT_A, mallory.accountId)
      )
    ).toBe(0);

    expect((await deviceRows())[0]!.status).toBe("active");
  });

  test("TS-I1: tenant isolation - tenant B cannot see, revoke or erase tenant A's device, even with tenant A's ids", async () => {
    const alice = await seedShopper(TENANT_A);
    const bea = await seedShopper(TENANT_B);
    await register(alice).outcome;
    await register(bea).outcome;
    const aRow = (await deviceRows(TENANT_A))[0]!;

    // RLS: tenant B's transaction sees only its own device row.
    const visible = await inTenant(TENANT_B, async (tx) => {
      return (await tx`
        SELECT id, tenant_id FROM awcms_commerce_push_devices
      `) as { id: string; tenant_id: string }[];
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]!.tenant_id).toBe(TENANT_B);

    // ... and cannot revoke or erase tenant A's, handing over A's ids.
    expect(
      await inTenant(TENANT_B, (tx) =>
        revokeOwnCustomerPushDevice(tx, TENANT_B, alice.accountId, aRow.id)
      )
    ).toBe(false);
    expect(
      await inTenant(TENANT_B, (tx) =>
        revokeAllOwnCustomerPushDevices(tx, TENANT_B, alice.accountId)
      )
    ).toBe(0);
    const erased = await inTenant(TENANT_B, (tx) =>
      eraseCustomerPushData(tx, TENANT_B, alice.accountId)
    );
    expect(erased).toEqual({ devices: 0, preferences: 0, messages: 0 });
    expect(
      await inTenant(TENANT_B, (tx) =>
        loadCustomerPushDeliveryTarget(tx, TENANT_B, aRow.id, RING_A)
      )
    ).toBeNull();

    expect((await deviceRows(TENANT_A))[0]!.status).toBe("active");
  });

  test("TS-I1: the database refuses a device whose account belongs to another tenant (composite FK) and a row for a foreign tenant (WITH CHECK)", async () => {
    const alice = await seedShopper(TENANT_A);

    // The OWNER role is not subject to the app role's grants, but FORCE RLS and
    // the composite foreign key still apply: a tenant-B row naming tenant A's
    // account cannot exist.
    await assertRejected(
      getOwnerSql().begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', ${TENANT_B}, true)`;
        await tx`
          INSERT INTO awcms_commerce_push_devices
            (tenant_id, account_id, session_id, storefront_origin, endpoint_ciphertext,
             endpoint_hash, endpoint_masked, p256dh_key, auth_secret_ciphertext)
          VALUES (${TENANT_B}, ${alice.accountId}, ${alice.sessionId}, ${ORIGIN},
                  'v2:ka:x:y:z', ${"c".repeat(64)}, 'masked', 'k', 'v2:ka:x:y:z')
        `;
      }),
      "a tenant-B device row naming tenant A's account"
    );

    // RLS WITH CHECK: tenant A's transaction cannot write a tenant-B row.
    await assertRejected(
      inTenant(
        TENANT_A,
        (tx) => tx`
        INSERT INTO awcms_commerce_push_devices
          (tenant_id, account_id, session_id, storefront_origin, endpoint_ciphertext,
           endpoint_hash, endpoint_masked, p256dh_key, auth_secret_ciphertext)
        VALUES (${TENANT_B}, ${alice.accountId}, ${alice.sessionId}, ${ORIGIN},
                'v2:ka:x:y:z', ${"d".repeat(64)}, 'masked', 'k', 'v2:ka:x:y:z')
      `
      ),
      "a foreign-tenant row written from tenant A's context"
    );
  });

  test("TS-I1: RLS is enabled AND forced on all four tables, each with a tenant policy", async () => {
    const rows = (await getAdminSql()`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      WHERE c.relname IN (
        'awcms_commerce_push_devices', 'awcms_commerce_push_preferences',
        'awcms_commerce_push_messages', 'awcms_commerce_push_delivery_attempts'
      )
      ORDER BY c.relname
    `) as {
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }[];

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
      expect(row.policies).toBeGreaterThanOrEqual(1);
    }
  });

  test("TS-I1: the credentials-iff-active CHECK holds for any role (a row cannot keep a credential once it is not active)", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const [device] = await deviceRows();

    // A status change that forgets to destroy the credentials is refused.
    await assertRejected(
      getAdminSql()`
        UPDATE awcms_commerce_push_devices
        SET status = 'revoked', status_reason = 'customer_removed', revoked_at = now()
        WHERE id = ${device!.id}
      `,
      "a revoked device that keeps its credentials"
    );
    // ... and so is an active device without them.
    await assertRejected(
      getAdminSql()`
        UPDATE awcms_commerce_push_devices SET endpoint_ciphertext = NULL
        WHERE id = ${device!.id}
      `,
      "an active device without its endpoint"
    );
    // The reason vocabulary is closed.
    await assertRejected(
      getAdminSql()`
        UPDATE awcms_commerce_push_devices
        SET status = 'revoked', status_reason = 'because', revoked_at = now(),
            endpoint_ciphertext = NULL, p256dh_key = NULL, auth_secret_ciphertext = NULL
        WHERE id = ${device!.id}
      `,
      "an unknown status reason"
    );
  });

  test("TS-I1: the identity columns of a device never change, for any role", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const [device] = await deviceRows();

    await assertRejected(
      getAdminSql()`
        UPDATE awcms_commerce_push_devices SET endpoint_hash = ${"e".repeat(64)}
        WHERE id = ${device!.id}
      `,
      "rewriting endpoint_hash"
    );
    await assertRejected(
      inTenant(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_push_devices SET endpoint_hash = ${"e".repeat(64)}
        WHERE id = ${device!.id}
      `
      ),
      "rewriting endpoint_hash as the runtime role"
    );
  });

  test("TS-I1: unique endpoint per tenant; the same endpoint hash may exist in two tenants", async () => {
    const alice = await seedShopper(TENANT_A);
    const bea = await seedShopper(TENANT_B);
    const endpoint = newEndpoint();
    await register(alice, { endpoint }).outcome;
    // Same endpoint string in another tenant is a different row.
    expect((await register(bea, { endpoint }).outcome).kind).toBe("registered");
    expect(await deviceRows()).toHaveLength(2);
  });

  test("a message's click target must be a same-origin path: the CHECK refuses an absolute URL, a protocol-relative one and traversal", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const [device] = await deviceRows();

    for (const path of [
      "https://evil.example/x",
      "//evil.example/x",
      "/\\evil.example",
      "/a/../b",
      "/akun?x=1",
      "akun/pesanan",
      "javascript:alert(1)"
    ]) {
      await assertRejected(
        getAdminSql()`
          INSERT INTO awcms_commerce_push_messages
            (tenant_id, account_id, device_id, source_event_id, event_type, purpose,
             tag, dedupe_key, title, body, target_path, expires_at)
          VALUES (${TENANT_A}, ${shopper.accountId}, ${device!.id}, ${crypto.randomUUID()},
                  'x.y', 'order_updates', 'order', ${crypto.randomUUID()}, 't', 'b',
                  ${path}, now() + interval '1 hour')
        `,
        `target_path ${path}`
      );
    }
  });

  // -------------------------------------------------------------------------
  // Logout, block
  // -------------------------------------------------------------------------

  test("TS-I3: logout revokes exactly that session's devices, atomically with the session", async () => {
    const shopper = await seedShopper(TENANT_A);
    const otherSession = await seedSession(TENANT_A, shopper.accountId);
    await register(shopper).outcome;
    await register(shopper, { sessionId: otherSession }).outcome;

    const revoked = await inTenant(TENANT_A, (tx) =>
      revokeCustomerPushDevicesOfSession(tx, TENANT_A, shopper.sessionId)
    );
    expect(revoked).toBe(1);

    const rows = await deviceRows();
    expect(rows.filter((r) => r.status === "revoked")).toHaveLength(1);
    expect(rows.find((r) => r.status === "revoked")!.status_reason).toBe(
      "logout"
    );
    expect(rows.find((r) => r.status === "active")!.session_id).toBe(
      otherSession
    );
  });

  test("TS-I3: a failure after the revoke rolls it back (same transaction as the session revoke)", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;

    await assertRejected(
      inTenant(TENANT_A, async (tx) => {
        await revokeCustomerPushDevicesOfSession(
          tx,
          TENANT_A,
          shopper.sessionId
        );
        throw new Error(
          "boom: the logout transaction fails after the device revoke"
        );
      }),
      "the enclosing transaction"
    );

    expect((await deviceRows())[0]!.status).toBe("active");
  });

  test("blocking the customer revokes the account's devices in the same transaction (T12)", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const actor = await seedStaff(TENANT_A);

    await inTenant(TENANT_A, (tx) =>
      updateCustomer(tx, TENANT_A, actor, shopper.customerId, {
        status: "blocked"
      })
    );

    const [row] = await deviceRows();
    expect(row!.status).toBe("revoked");
    expect(row!.status_reason).toBe("account_blocked");
    expect(row!.endpoint_ciphertext).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  test("a withdrawal keeps its row as evidence; marketing has no route to enabled", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper, {
      consent: {
        purposes: ["order_updates", "support_replies"],
        textVersion: VERSION
      }
    }).outcome;

    const applied = await inTenant(TENANT_A, (tx) =>
      applyPreferenceChanges(
        tx,
        TENANT_A,
        shopper.accountId,
        [
          { purpose: "order_updates", enabled: false },
          { purpose: "payment_updates", enabled: false }
        ],
        null
      )
    );
    expect(applied.changed).toEqual([
      { purpose: "order_updates", enabled: false }
    ]);

    const rows = (await getAdminSql()`
      SELECT purpose, enabled, revoked_at, granted_at
      FROM awcms_commerce_push_preferences
      WHERE account_id = ${shopper.accountId} ORDER BY purpose
    `) as {
      purpose: string;
      enabled: boolean;
      revoked_at: Date | null;
      granted_at: Date | null;
    }[];

    const order = rows.find((r) => r.purpose === "order_updates")!;
    expect(order.enabled).toBe(false);
    expect(order.revoked_at).not.toBeNull();
    expect(order.granted_at).not.toBeNull();
    expect(rows.find((r) => r.purpose === "support_replies")!.enabled).toBe(
      true
    );
    // An explicit "off" for a purpose never turned on is on record too.
    expect(rows.find((r) => r.purpose === "payment_updates")!.enabled).toBe(
      false
    );
    expect(rows.find((r) => r.purpose === "marketing")).toBeUndefined();

    // The reserved purpose can be stored as OFF only: enabled needs a grant time.
    await assertRejected(
      getAdminSql()`
        INSERT INTO awcms_commerce_push_preferences
          (tenant_id, account_id, purpose, enabled, consent_text_version)
        VALUES (${TENANT_A}, ${shopper.accountId}, 'marketing', true, 'v')
      `,
      "an enabled preference without a grant time"
    );
  });

  test("re-granting under the same wording keeps the original grant time; a new wording regrants", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const first = (
      await inTenant(TENANT_A, (tx) =>
        listCustomerPushPreferences(tx, TENANT_A, shopper.accountId)
      )
    ).find((p) => p.purpose === "order_updates")!;

    await register(shopper).outcome;
    const second = (
      await inTenant(TENANT_A, (tx) =>
        listCustomerPushPreferences(tx, TENANT_A, shopper.accountId)
      )
    ).find((p) => p.purpose === "order_updates")!;
    expect(second.grantedAt).toBe(first.grantedAt);

    await inTenant(TENANT_A, (tx) =>
      applyPreferenceChanges(
        tx,
        TENANT_A,
        shopper.accountId,
        [{ purpose: "order_updates", enabled: true }],
        "draft-2027-01"
      )
    );
    const third = (
      await inTenant(TENANT_A, (tx) =>
        listCustomerPushPreferences(tx, TENANT_A, shopper.accountId)
      )
    ).find((p) => p.purpose === "order_updates")!;
    expect(third.consentTextVersion).toBe("draft-2027-01");
    expect(third.grantedAt).not.toBe(first.grantedAt);
  });

  // -------------------------------------------------------------------------
  // The outbox
  // -------------------------------------------------------------------------

  test("TS-I5: one row per (event, device) under replay; the click target is the purpose's fixed path", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const [device] = await deviceRows();
    const eventId = crypto.randomUUID();

    expect((await queueMessage(shopper, device!.id, { eventId })).kind).toBe(
      "enqueued"
    );
    expect((await queueMessage(shopper, device!.id, { eventId })).kind).toBe(
      "duplicate"
    );
    expect(await messageRows()).toHaveLength(1);
    expect((await messageRows())[0]!.target_path).toBe("/akun/pesanan");
  });

  test("TS-I5: the per-account rolling hourly cap stops the 13th notification; another account is unaffected", async () => {
    const heavy = await seedShopper(TENANT_A);
    const light = await seedShopper(TENANT_A);
    await register(heavy).outcome;
    await register(light).outcome;
    const [heavyDevice, lightDevice] = await deviceRows();

    for (let i = 0; i < 12; i += 1) {
      expect((await queueMessage(heavy, heavyDevice!.id)).kind).toBe(
        "enqueued"
      );
    }
    const refused = await queueMessage(heavy, heavyDevice!.id);
    expect(refused).toEqual({ kind: "suppressed", reason: "hourly_cap" });
    expect((await queueMessage(light, lightDevice!.id)).kind).toBe("enqueued");

    const counts = await inTenant(TENANT_A, (tx) =>
      countRecentMessagesForAccount(tx, TENANT_A, heavy.accountId)
    );
    expect(counts).toEqual({ lastHour: 12, lastDay: 12 });
  });

  test("TS-I5: the daily cap counts messages older than an hour, and cancelled rows do not count", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const [device] = await deviceRows();

    // 40 messages created 3 hours ago: outside the hourly window, inside the day.
    for (let i = 0; i < 40; i += 1) {
      await getAdminSql()`
        INSERT INTO awcms_commerce_push_messages
          (tenant_id, account_id, device_id, source_event_id, event_type, purpose,
           tag, dedupe_key, title, body, target_path, expires_at, status, created_at)
        VALUES (${TENANT_A}, ${shopper.accountId}, ${device!.id}, ${crypto.randomUUID()},
                'x.y', 'order_updates', 'order', ${`old-${i}`}, 't', 'b', '/akun/pesanan',
                now() + interval '1 hour', 'sent', now() - interval '3 hours')
      `;
    }
    expect(await queueMessage(shopper, device!.id)).toEqual({
      kind: "suppressed",
      reason: "daily_cap"
    });

    // Cancelled rows never reached anybody and free their slot.
    await getAdminSql()`
      UPDATE awcms_commerce_push_messages SET status = 'cancelled'
      WHERE dedupe_key = 'old-0'
    `;
    expect((await queueMessage(shopper, device!.id)).kind).toBe("enqueued");
  });

  // -------------------------------------------------------------------------
  // Retention, erasure, export, rotation
  // -------------------------------------------------------------------------

  test("TS-I7: maintenance revokes devices of ended sessions and blocked accounts, destroying their credentials", async () => {
    const live = await seedShopper(TENANT_A);
    const expired = await seedShopper(TENANT_A);
    const revokedSession = await seedShopper(TENANT_A);
    const blocked = await seedShopper(TENANT_A);

    await register(live).outcome;
    await register(expired).outcome;
    await register(revokedSession).outcome;
    await register(blocked).outcome;

    await getAdminSql()`
      UPDATE awcms_commerce_customer_sessions SET expires_at = now() - interval '1 minute'
      WHERE id = ${expired.sessionId}
    `;
    await getAdminSql()`
      UPDATE awcms_commerce_customer_sessions SET revoked_at = now()
      WHERE id = ${revokedSession.sessionId}
    `;
    await getAdminSql()`
      UPDATE awcms_commerce_customer_accounts SET status = 'blocked'
      WHERE id = ${blocked.accountId}
    `;

    const result = await purgeCustomerPushForTenant(getRuntimeSql(), TENANT_A);

    expect(result.sweptSessionEnded).toBe(2);
    expect(result.sweptAccountBlocked).toBe(1);

    const byAccount = new Map(
      (await deviceRows()).map((row) => [row.account_id, row])
    );
    expect(byAccount.get(live.accountId)!.status).toBe("active");
    for (const [who, reason] of [
      [expired, "session_ended"],
      [revokedSession, "session_ended"],
      [blocked, "account_blocked"]
    ] as const) {
      const row = byAccount.get(who.accountId)!;
      expect(row.status).toBe("revoked");
      expect(row.status_reason).toBe(reason);
      expect(row.endpoint_ciphertext).toBeNull();
      expect(row.auth_secret_ciphertext).toBeNull();
    }
  });

  test("TS-I7: a purged session leaves the device row alive (SET NULL) and the sweep then revokes it", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;

    // The customer-auth purge deletes a revoked session; the device must not
    // block it, and must not vanish with it.
    await getAdminSql()`
      DELETE FROM awcms_commerce_customer_sessions WHERE id = ${shopper.sessionId}
    `;
    const [orphan] = await deviceRows();
    expect(orphan!.session_id).toBeNull();
    expect(orphan!.status).toBe("active");

    const result = await purgeCustomerPushForTenant(getRuntimeSql(), TENANT_A);
    expect(result.sweptSessionEnded).toBe(1);
    expect((await deviceRows())[0]!.status).toBe("revoked");
  });

  test("TS-I7: the purge removes only tombstones, terminal messages and attempts past 30 days; active devices and queued messages stay however old", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome; // stays active
    await register(shopper).outcome; // will be revoked (old)
    await register(shopper).outcome; // will be revoked (recent)
    const devices = await deviceRows();
    const [active, oldRevoked, recentRevoked] = devices;

    for (const [device, daysAgo] of [
      [oldRevoked!, 31],
      [recentRevoked!, 2]
    ] as const) {
      await getAdminSql()`
        UPDATE awcms_commerce_push_devices
        SET status = 'revoked', status_reason = 'customer_removed',
            endpoint_ciphertext = NULL, p256dh_key = NULL, auth_secret_ciphertext = NULL,
            revoked_at = now() - ${`${daysAgo} days`}::interval
        WHERE id = ${device.id}
      `;
    }
    // An ancient active device is not purgeable: its revoked_at is NULL.
    await getAdminSql()`
      UPDATE awcms_commerce_push_devices SET registered_at = now() - interval '400 days'
      WHERE id = ${active!.id}
    `;

    const insertMessage = async (
      status: string,
      ageDays: number,
      key: string,
      deviceId = active!.id
    ) => {
      const rows = (await getAdminSql()`
        INSERT INTO awcms_commerce_push_messages
          (tenant_id, account_id, device_id, source_event_id, event_type, purpose,
           tag, dedupe_key, title, body, target_path, expires_at, status, created_at, updated_at)
        VALUES (${TENANT_A}, ${shopper.accountId}, ${deviceId}, ${crypto.randomUUID()},
                'x.y', 'order_updates', 'order', ${key}, 't', 'b', '/akun/pesanan',
                now() + interval '1 hour', ${status},
                now() - ${`${ageDays} days`}::interval, now() - ${`${ageDays} days`}::interval)
        RETURNING id
      `) as { id: string }[];
      return rows[0]!.id;
    };

    const oldSent = await insertMessage("sent", 45, "old-sent");
    await insertMessage("failed", 45, "old-failed");
    await insertMessage("cancelled", 45, "old-cancelled");
    await insertMessage("queued", 45, "old-queued");
    await insertMessage("retry_wait", 45, "old-retry");
    await insertMessage("sending", 45, "old-sending");
    await insertMessage("sent", 3, "recent-sent");
    await getAdminSql()`
      INSERT INTO awcms_commerce_push_delivery_attempts
        (tenant_id, message_id, attempt_no, outcome, created_at)
      VALUES (${TENANT_A}, ${oldSent}, 1, 'success', now() - interval '45 days')
    `;

    const result = await purgeCustomerPushForTenant(getRuntimeSql(), TENANT_A);

    expect(result.purgedDevices).toBe(1);
    expect(result.purgedMessages).toBe(3);
    expect(result.purgedAttempts).toBe(1);

    const remainingDevices = (await deviceRows()).map((d) => d.id);
    expect(remainingDevices).toContain(active!.id);
    expect(remainingDevices).toContain(recentRevoked!.id);
    expect(remainingDevices).not.toContain(oldRevoked!.id);

    const remaining = (await getAdminSql()`
      SELECT dedupe_key FROM awcms_commerce_push_messages ORDER BY dedupe_key
    `) as { dedupe_key: string }[];
    expect(remaining.map((m) => m.dedupe_key)).toEqual([
      "old-queued",
      "old-retry",
      "old-sending",
      "recent-sent"
    ]);

    // Idempotent: a second pass finds nothing.
    const again = await purgeCustomerPushForTenant(getRuntimeSql(), TENANT_A);
    expect(
      again.purgedDevices + again.purgedMessages + again.purgedAttempts
    ).toBe(0);
  });

  test("TS-I7: erasure deletes the account's devices, preferences, messages and attempts - and nobody else's", async () => {
    const alice = await seedShopper(TENANT_A);
    const bob = await seedShopper(TENANT_A);
    await register(alice).outcome;
    await register(bob).outcome;
    const [aliceDevice, bobDevice] = await deviceRows();
    const message = await queueMessage(alice, aliceDevice!.id);
    await queueMessage(bob, bobDevice!.id);
    if (message.kind === "enqueued") {
      await getAdminSql()`
        INSERT INTO awcms_commerce_push_delivery_attempts
          (tenant_id, message_id, attempt_no, outcome)
        VALUES (${TENANT_A}, ${message.messageId}, 1, 'success')
      `;
    }

    const exported = await inTenant(TENANT_A, (tx) =>
      exportCustomerPushData(tx, TENANT_A, alice.accountId)
    );
    expect(exported.devices).toHaveLength(1);
    expect(exported.preferences.length).toBeGreaterThanOrEqual(1);
    expect(exported.messages).toHaveLength(1);
    const exportedText = JSON.stringify(exported);
    expect(exportedText).not.toContain("SECRETTOKEN");
    expect(exportedText).not.toContain("ciphertext");
    expect(exportedText).not.toContain("endpoint_hash");
    expect(exportedText).not.toContain("p256dh");
    expect(exported.devices[0]!.endpointMasked).toContain("…");

    const erased = await inTenant(TENANT_A, (tx) =>
      eraseCustomerPushData(tx, TENANT_A, alice.accountId)
    );
    expect(erased.devices).toBe(1);
    expect(erased.messages).toBe(1);
    expect(erased.preferences).toBeGreaterThanOrEqual(1);

    expect(
      await inTenant(TENANT_A, (tx) =>
        exportCustomerPushData(tx, TENANT_A, alice.accountId)
      )
    ).toEqual({ devices: [], preferences: [], messages: [] });
    expect((await deviceRows()).map((d) => d.account_id)).toEqual([
      bob.accountId
    ]);

    const attempts = (await getAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_push_delivery_attempts
    `) as { n: number }[];
    expect(attempts[0]!.n).toBe(0);

    // The audit event carries counts, never an identifier of a credential.
    const audit = (await getAdminSql()`
      SELECT attributes::text AS attributes FROM awcms_audit_events
      WHERE action = 'commerce.customer_push.data_erased'
    `) as { attributes: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.attributes).not.toContain("SECRETTOKEN");

    // Idempotent.
    expect(
      await inTenant(TENANT_A, (tx) =>
        eraseCustomerPushData(tx, TENANT_A, alice.accountId)
      )
    ).toEqual({ devices: 0, preferences: 0, messages: 0 });
  });

  test("TS-I7: deleting the customer account removes its push data in the database (FK cascade), with no application step", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const [device] = await deviceRows();
    await queueMessage(shopper, device!.id);

    await getAdminSql().begin(async (tx) => {
      await tx`DELETE FROM awcms_commerce_customer_sessions WHERE account_id = ${shopper.accountId}`;
      await tx`DELETE FROM awcms_commerce_customer_accounts WHERE id = ${shopper.accountId}`;
    });

    expect(await deviceRows()).toHaveLength(0);
    expect(await messageRows()).toHaveLength(0);
    const prefs = (await getAdminSql()`
      SELECT count(*)::int AS n FROM awcms_commerce_push_preferences
    `) as { n: number }[];
    expect(prefs[0]!.n).toBe(0);
  });

  test("TS-I7: key rotation - the first key writes, the re-key command moves both ciphertexts, an undecryptable row is counted and left alone", async () => {
    const shopper = await seedShopper(TENANT_A);
    const { input } = register(shopper);
    await inTenant(TENANT_A, (tx) => registerCustomerPushDevice(tx, input));
    await register(shopper).outcome;

    const before = await countCustomerPushCredentialsByKeyId(
      getRuntimeSql(),
      TENANT_A
    );
    expect(before).toEqual({ endpoint: { ka: 2 }, authSecret: { ka: 2 } });

    // Rotation: a new first key, the old one kept for reading.
    const result = await rekeyCustomerPushCredentialsForTenant(
      getRuntimeSql(),
      TENANT_A,
      RING_BA
    );
    expect(result).toEqual({ converted: 2, failed: 0, complete: true });

    const after = await countCustomerPushCredentialsByKeyId(
      getRuntimeSql(),
      TENANT_A
    );
    expect(after).toEqual({ endpoint: { kb: 2 }, authSecret: { kb: 2 } });

    // Still decryptable under the new ring, to the same values.
    const [device] = await deviceRows();
    const target = await inTenant(TENANT_A, (tx) =>
      loadCustomerPushDeliveryTarget(tx, TENANT_A, device!.id, RING_BA)
    );
    expect(target?.target.endpoint).toBeTruthy();

    // Idempotent: nothing left to convert.
    expect(
      await rekeyCustomerPushCredentialsForTenant(
        getRuntimeSql(),
        TENANT_A,
        RING_BA
      )
    ).toEqual({ converted: 0, failed: 0, complete: true });

    // Retiring the old key too early: a ring without it cannot read - fail closed.
    const onlyA = ringFrom(`ka:${KEY_A}`);
    await expect(
      inTenant(TENANT_A, (tx) =>
        loadCustomerPushDeliveryTarget(tx, TENANT_A, device!.id, onlyA)
      )
    ).rejects.toBeInstanceOf(FieldEncryptionError);

    // A row whose ciphertext cannot be decrypted is counted, not "fixed".
    const ringOnlyKc = ringFrom(`kc:${randomBytes(32).toString("base64")}`);
    const failing = await rekeyCustomerPushCredentialsForTenant(
      getRuntimeSql(),
      TENANT_A,
      ringOnlyKc
    );
    expect(failing.failed).toBe(2);
    expect(failing.converted).toBe(0);
    expect(
      await countCustomerPushCredentialsByKeyId(getRuntimeSql(), TENANT_A)
    ).toEqual({ endpoint: { kb: 2 }, authSecret: { kb: 2 } });
  });

  test("a customer ciphertext does not authenticate as an upstream auth secret (purpose-bound AAD) once at rest", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const [row] = await deviceRows();
    // Decrypting the stored customer ciphertext under the wrong purpose fails.
    const { decryptPushAuthSecret } =
      await import("../../src/modules/push-delivery/domain/push-auth-secret");
    expect(() =>
      decryptPushAuthSecret(
        String(row!.auth_secret_ciphertext),
        TENANT_A,
        String(row!.endpoint_hash),
        RING_A
      )
    ).toThrow(FieldEncryptionError);
    expect(
      decryptCustomerPushAuthSecret(
        String(row!.auth_secret_ciphertext),
        TENANT_A,
        String(row!.endpoint_hash),
        RING_A
      )
    ).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  test("diagnostics are aggregate-only: counts by status and purpose, never an identifier or an endpoint", async () => {
    const alice = await seedShopper(TENANT_A);
    const bob = await seedShopper(TENANT_A);
    await register(alice).outcome;
    await register(bob, {
      consent: {
        purposes: ["order_updates", "payment_updates"],
        textVersion: VERSION
      }
    }).outcome;
    const [aliceDevice, bobDevice] = await deviceRows();
    await queueMessage(alice, aliceDevice!.id);
    await inTenant(TENANT_A, (tx) =>
      revokeOwnCustomerPushDevice(tx, TENANT_A, bob.accountId, bobDevice!.id)
    );

    const diagnostics = await inTenant(TENANT_A, (tx) =>
      fetchCustomerPushDiagnostics(tx, TENANT_A)
    );

    expect(diagnostics.devices).toEqual({
      active: 1,
      revoked: 1,
      gone: 0,
      disabled: 0
    });
    expect(diagnostics.accountsWithActiveDevice).toBe(1);
    expect(diagnostics.messages.byStatus.queued).toBe(1);
    expect(
      diagnostics.preferences.find((p) => p.purpose === "order_updates")
    ).toEqual({ purpose: "order_updates", enabled: 2, withdrawn: 0 });
    expect(
      diagnostics.preferences.find((p) => p.purpose === "marketing")
    ).toEqual({ purpose: "marketing", enabled: 0, withdrawn: 0 });

    const text = JSON.stringify(diagnostics);
    for (const secret of [
      alice.accountId,
      bob.accountId,
      alice.customerId,
      aliceDevice!.id,
      bobDevice!.id,
      "SECRETTOKEN",
      "fcm.googleapis.com",
      "sha256:"
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text.toLowerCase()).not.toContain("delivered");
    // Another tenant's diagnostics see none of it.
    const other = await inTenant(TENANT_B, (tx) =>
      fetchCustomerPushDiagnostics(tx, TENANT_B)
    );
    expect(other.devices.active).toBe(0);
    expect(other.messages.byStatus.queued).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Grants (the worker's least privilege)
  // -------------------------------------------------------------------------

  test("TS-I1: the worker cannot insert a device or rewrite identity columns; it may only clear credentials and settle status", async () => {
    if (!workerRoleActivated) {
      console.warn("[skip] awcms_worker is not provisioned in this database.");
      return;
    }
    const shopper = await seedShopper(TENANT_A);
    const other = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const [device] = await deviceRows();

    // No INSERT of a device.
    await assertRejected(
      workerTx(
        TENANT_A,
        (tx) => tx`
        INSERT INTO awcms_commerce_push_devices
          (tenant_id, account_id, session_id, storefront_origin, endpoint_ciphertext,
           endpoint_hash, endpoint_masked, p256dh_key, auth_secret_ciphertext)
        VALUES (${TENANT_A}, ${shopper.accountId}, ${shopper.sessionId}, ${ORIGIN},
                'v2:ka:x:y:z', ${"f".repeat(64)}, 'masked', 'k', 'v2:ka:x:y:z')
      `
      ),
      "a worker device INSERT"
    );

    // No UPDATE of the columns that decide where a delivery goes.
    for (const [column, value] of [
      ["account_id", other.accountId],
      ["session_id", other.sessionId],
      ["storefront_origin", "https://evil.example"],
      ["endpoint_hash", "9".repeat(64)],
      ["endpoint_masked", "x"]
    ] as const) {
      await assertRejected(
        workerTx(TENANT_A, (tx) =>
          tx.unsafe(
            `UPDATE awcms_commerce_push_devices SET ${column} = $1 WHERE id = $2`,
            [value, device!.id]
          )
        ),
        `worker UPDATE of ${column}`
      );
    }

    // The guard trigger: the worker may not replace the public key, nor
    // resurrect a tombstone by writing a ciphertext into it.
    await assertRejected(
      workerTx(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_push_devices SET p256dh_key = 'attacker-key'
        WHERE id = ${device!.id}
      `
      ),
      "worker replacing p256dh_key"
    );

    // What it MAY do: settle status and destroy credentials in one statement.
    await workerTx(
      TENANT_A,
      (tx) => tx`
      UPDATE awcms_commerce_push_devices
      SET status = 'gone', status_reason = 'endpoint_gone', revoked_at = now(),
          endpoint_ciphertext = NULL, p256dh_key = NULL,
          auth_secret_ciphertext = NULL, updated_at = now()
      WHERE id = ${device!.id}
    `
    );
    expect((await deviceRows())[0]!.status).toBe("gone");

    // A tombstone cannot be turned back into a live subscription by the worker.
    await assertRejected(
      workerTx(
        TENANT_A,
        (tx) => tx`
        UPDATE awcms_commerce_push_devices
        SET status = 'active', status_reason = NULL, revoked_at = NULL,
            endpoint_ciphertext = 'v2:ka:a:b:c', p256dh_key = NULL,
            auth_secret_ciphertext = 'v2:ka:a:b:c'
        WHERE id = ${device!.id}
      `
      ),
      "worker resurrecting a tombstone"
    );
  });

  test("TS-I7: the maintenance job and the re-key command work as the least-privilege worker role", async () => {
    if (!workerRoleActivated) {
      console.warn("[skip] awcms_worker is not provisioned in this database.");
      return;
    }
    const worker = getWorkerRoleSql();
    const expired = await seedShopper(TENANT_A);
    const live = await seedShopper(TENANT_A);
    await register(expired).outcome;
    await register(live).outcome;
    const [expiredDevice] = await deviceRows();
    await queueMessage(expired, expiredDevice!.id);
    await getAdminSql()`
      UPDATE awcms_commerce_customer_sessions SET revoked_at = now()
      WHERE id = ${expired.sessionId}
    `;
    // An old tombstone and an old terminal message to purge.
    await getAdminSql()`
      INSERT INTO awcms_commerce_push_messages
        (tenant_id, account_id, device_id, source_event_id, event_type, purpose,
         tag, dedupe_key, title, body, target_path, expires_at, status, updated_at)
      VALUES (${TENANT_A}, ${live.accountId}, (SELECT id FROM awcms_commerce_push_devices WHERE account_id = ${live.accountId}),
              ${crypto.randomUUID()}, 'x.y', 'order_updates', 'order', 'w-old', 't', 'b',
              '/akun/pesanan', now() + interval '1 hour', 'sent', now() - interval '60 days')
    `;

    const swept = await purgeCustomerPushForTenant(worker, TENANT_A);
    expect(swept.sweptSessionEnded).toBe(1);
    expect(swept.purgedMessages).toBe(1);

    const rows = await deviceRows();
    expect(rows.find((r) => r.account_id === expired.accountId)!.status).toBe(
      "revoked"
    );
    expect(
      (await messageRows()).find((m) => m.last_error === "session_ended")
        ?.status
    ).toBe("cancelled");

    // Rotation as the worker: both ciphertext columns, active devices only.
    const rekeyed = await rekeyCustomerPushCredentialsForTenant(
      worker,
      TENANT_A,
      RING_BA
    );
    expect(rekeyed).toEqual({ converted: 1, failed: 0, complete: true });
    expect(await countCustomerPushCredentialsByKeyId(worker, TENANT_A)).toEqual(
      {
        endpoint: { kb: 1 },
        authSecret: { kb: 1 }
      }
    );
  });

  test("TS-I1: the worker's table privileges are exactly the matrix", async () => {
    if (!workerRoleActivated) {
      console.warn("[skip] awcms_worker is not provisioned in this database.");
      return;
    }
    const expected: Record<string, string[]> = {
      awcms_commerce_push_devices: ["DELETE", "SELECT"],
      awcms_commerce_push_preferences: ["SELECT"],
      // INSERT and UPDATE are column-only since sql/1061 (Issue #432): see
      // commerce-customer-push-fanout.integration.test.ts for the column lists.
      awcms_commerce_push_messages: ["DELETE", "SELECT"],
      awcms_commerce_push_delivery_attempts: ["DELETE", "INSERT", "SELECT"]
    };

    for (const [table, privileges] of Object.entries(expected)) {
      const held: string[] = [];
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const rows = (await getAdminSql()`
          SELECT has_table_privilege('awcms_worker', ${table}, ${privilege}) AS held
        `) as { held: boolean }[];
        if (rows[0]!.held) held.push(privilege);
      }
      expect(held.sort()).toEqual(privileges.sort());
    }
  });

  test("a savepoint-guarded violation does not poison the transaction (the helper the harness offers)", async () => {
    const shopper = await seedShopper(TENANT_A);
    await register(shopper).outcome;
    const [device] = await deviceRows();

    await inTenant(TENANT_A, async (tx) => {
      await assertRejectedInSavepoint(
        tx,
        (sp) => sp`
          UPDATE awcms_commerce_push_devices SET endpoint_hash = ${"1".repeat(64)}
          WHERE id = ${device!.id}
        `,
        "rewriting endpoint_hash"
      );
      const rows =
        (await tx`SELECT count(*)::int AS n FROM awcms_commerce_push_devices`) as {
          n: number;
        }[];
      expect(rows[0]!.n).toBe(1);
    });
  });
});
