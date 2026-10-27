/**
 * Customer Web Push fan-out against a REAL migrated PostgreSQL (Issue #432,
 * ADR-0048 sections 5.4 to 5.6), through `tests/integration/harness.ts` (world 1):
 * the least-privilege runtime role for what the storefront does (register,
 * logout, reply), the worker role for what the domain-event runtime and the
 * dispatch job do, and the schema owner where a constraint is the property
 * under test. Gated on `DATABASE_URL`; skips cleanly without one.
 *
 * The push service is a LOCAL stub HTTP server (`Bun.serve`) behind the upstream
 * provider's injectable HTTP seam: the real VAPID signing, RFC 8291 encryption,
 * response mapping and circuit breaker run; only the network hop is replaced. The
 * stub answers by the endpoint's name (`ok`, `gone410`, `gone404`, `busy503`,
 * `limit429`, `reject400`) and records the headers it saw.
 *
 * Regression handles of the ADR's section 8:
 *
 *   TS-I4   the eligibility truth table, against real rows: each predicate,
 *           changed alone, cancels the message and the stub sees no request
 *   TS-I5   replay and double delivery give one row per dedupe key; concurrent
 *           dispatch sends each message once; an expired lease is re-claimed once
 *   TS-I6   201 -> sent; 404/410 -> device gone; 429/5xx -> retry_wait with
 *           exponential backoff; permanent 4xx -> failed; TTL expiry; the breaker
 *   TS-E1   (the server half) logout cancels what is queued and revokes the device
 *
 * Plus: every event E1 to E7 enqueues; no enqueue with the preference or the flag
 * off; tenant isolation; the per-account cap at enqueue and at send; the worker's
 * column grants; `postStoreReply` appends the new event in its own transaction.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from "bun:test";

import { resetProviderCircuitBreakersForTests } from "../../src/lib/database/circuit-breaker";
import { withTenantOrThrow } from "../../src/lib/database/tenant-context";
import { postStoreReply } from "../../src/modules/commerce/application/conversation-directory";
import {
  dispatchCustomerPushForTenant,
  type DispatchCustomerPushResult
} from "../../src/modules/commerce/application/customer-push-dispatch";
import {
  registerCustomerPushDevice,
  revokeCustomerPushDevicesOfSession,
  revokeOwnCustomerPushDevice,
  type RegisterCustomerPushInput
} from "../../src/modules/commerce/application/customer-push-devices";
import { enqueueCustomerPushForEvent } from "../../src/modules/commerce/application/customer-push-enqueue";
import { enqueueCustomerPushMessage } from "../../src/modules/commerce/application/customer-push-outbox";
import { purgeCustomerPushForTenant } from "../../src/modules/commerce/application/customer-push-maintenance";
import { applyPreferenceChanges } from "../../src/modules/commerce/application/customer-push-preferences";
import { CUSTOMER_PUSH_CONSENT_TEXT_VERSION } from "../../src/modules/commerce/domain/customer-push";
import {
  COMMERCE_CONVERSATION_AGGREGATE_TYPE,
  COMMERCE_CONVERSATION_STORE_REPLIED_EVENT_TYPE,
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_AGGREGATE_TYPE,
  COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
  COMMERCE_ORDER_EXPIRED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EVENT_TYPE,
  COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
  COMMERCE_REFUND_SETTLED_EVENT_TYPE,
  COMMERCE_RETURN_AGGREGATE_TYPE,
  COMMERCE_RETURN_RECORDED_EVENT_TYPE
} from "../../src/modules/commerce/domain/commerce-events";
import { renderCustomerPushText } from "../../src/modules/commerce/domain/customer-push-policy";
import type { DomainEventForHandler } from "../../src/modules/_shared/domain-event-consumer-contract";
import { appendDomainEvent } from "../../src/modules/domain-event-runtime/application/append-domain-event";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";
import { resolvePushAuthSecretRing } from "../../src/modules/push-delivery/domain/push-auth-secret";
import type {
  PushHttpClient,
  PushHttpRequest
} from "../../src/modules/push-delivery/infrastructure/push-http-client";
import {
  assertRejected,
  getAdminSql,
  getRuntimeSql,
  getWorkerRoleSql,
  integrationEnabled,
  resetDatabase,
  setupIntegrationDatabase,
  teardownIntegrationDatabase,
  workerRoleActivated
} from "./harness";

const suite = integrationEnabled ? describe : describe.skip;

const TENANT_A = "11111111-1111-4111-8111-111111111432";
const TENANT_B = "22222222-2222-4222-8222-222222222432";
const HOST_A = "shop-a.example.test";
const HOST_B = "shop-b.example.test";
const ORIGIN_A = `https://${HOST_A}`;
const ORIGIN_B = `https://${HOST_B}`;
const CMS_ORIGIN = "https://cms.example.test";
const VERSION = CUSTOMER_PUSH_CONSENT_TEXT_VERSION;

// ---------------------------------------------------------------------------
// Environment: push on, a VAPID pair, the key ring (restored afterwards)
// ---------------------------------------------------------------------------

function makeVapid(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256"
  });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(pub.x!, "base64url"),
      Buffer.from(pub.y!, "base64url")
    ]).toString("base64url"),
    privateKey: priv.d!
  };
}

/** A real P-256 subscriber public key: the payload is genuinely encrypted to it. */
function makeSubscriberKey(): string {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url")
  ]).toString("base64url");
}

const VAPID = makeVapid();
const KEY_A = randomBytes(32).toString("base64");

function ringFrom(spec: string) {
  const ring = resolvePushAuthSecretRing({
    PUSH_AUTH_SECRET_ENCRYPTION_KEYS: spec
  } as NodeJS.ProcessEnv);
  if (!ring.ok) throw new Error(ring.reason);
  return ring;
}

const RING_A = ringFrom(`ka:${KEY_A}`);

const PUSH_ENV: Record<string, string> = {
  PUSH_ENABLED: "true",
  PUSH_PROVIDER: "web_push",
  PUSH_VAPID_PUBLIC_KEY: VAPID.publicKey,
  PUSH_VAPID_PRIVATE_KEY: VAPID.privateKey,
  PUSH_VAPID_SUBJECT: "mailto:ops@example.test",
  PUSH_AUTH_SECRET_ENCRYPTION_KEYS: `ka:${KEY_A}`,
  PUSH_SEND_MAX_RETRIES: "3",
  APP_URL: CMS_ORIGIN
};

const savedEnv = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

// ---------------------------------------------------------------------------
// The stub push service
// ---------------------------------------------------------------------------

type Seen = {
  path: string;
  headers: Record<string, string>;
  bodyBytes: number;
};

let server: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];

/** `<behaviour>` is the first token of the endpoint's last path segment. */
function statusFor(path: string): number {
  const behaviour = /\/fcm\/send\/([a-z0-9]+)/.exec(path)?.[1] ?? "ok";
  if (behaviour.startsWith("gone410")) return 410;
  if (behaviour.startsWith("gone404")) return 404;
  if (behaviour.startsWith("busy503")) return 503;
  if (behaviour.startsWith("limit429")) return 429;
  if (behaviour.startsWith("reject400")) return 400;
  return 201;
}

/** The provider's HTTP seam: same request, delivered to the local stub. */
const stubHttp: PushHttpClient = async (url, request: PushHttpRequest) => {
  const path = new URL(url).pathname;
  const response = await fetch(`http://localhost:${server.port}${path}`, {
    method: request.method,
    headers: request.headers,
    body: request.body as unknown as BodyInit
  });
  return { ok: true, status: response.status, body: await response.text() };
};

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function inTenant<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return withTenantOrThrow(getRuntimeSql(), tenantId, fn);
}

/** The scheduled job's transaction shape: `awcms_worker` under a tenant context. */
function workerTx<T>(
  tenantId: string,
  fn: (tx: Bun.TransactionSQL) => Promise<T>
): Promise<T> {
  return getWorkerRoleSql().begin(async (tx) => {
    await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
    return fn(tx);
  });
}

async function seedTenant(
  id: string,
  code: string,
  options: { host: string; customerPush?: boolean; locale?: string }
): Promise<void> {
  const admin = getAdminSql();
  await admin`
    INSERT INTO awcms_tenants
      (id, tenant_code, tenant_name, legal_name, status, default_locale, default_theme)
    VALUES (${id}, ${code}, ${code + " Name"}, ${code + " Legal"}, 'active',
            ${options.locale ?? "en"}, 'light')
    ON CONFLICT (id) DO NOTHING
  `;
  await admin`
    INSERT INTO awcms_modules (module_key, module_name)
    VALUES ('commerce', 'Commerce') ON CONFLICT (module_key) DO NOTHING
  `;
  await admin`
    INSERT INTO awcms_tenant_modules (tenant_id, module_key, enabled)
    VALUES (${id}, 'commerce', true)
  `;
  await setFeature(id, options.customerPush ?? true);
  await admin`
    INSERT INTO awcms_tenant_domains
      (tenant_id, hostname, normalized_hostname, status, verified_at)
    VALUES (${id}, ${options.host}, ${options.host}, 'active', now())
  `;
}

async function setFeature(tenantId: string, customerPush: boolean) {
  await getAdminSql()`
    INSERT INTO awcms_module_settings (tenant_id, module_key, settings)
    VALUES (${tenantId}, 'commerce', ${{ features: { customerPush } }}::jsonb)
    ON CONFLICT (tenant_id, module_key)
    DO UPDATE SET settings = EXCLUDED.settings
  `;
}

type Shopper = {
  tenantId: string;
  customerId: string;
  accountId: string;
  sessionId: string;
};

let shopperSeq = 0;
let tokenSeq = 0;

async function seedSession(
  tenantId: string,
  accountId: string
): Promise<string> {
  tokenSeq += 1;
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_customer_sessions
      (tenant_id, account_id, token_hash, expires_at)
    VALUES (${tenantId}, ${accountId}, ${`sha256:fanout${tokenSeq}`},
            ${new Date(Date.now() + 86_400_000)})
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function seedShopper(
  tenantId: string,
  options: { blocked?: boolean; verified?: boolean; account?: boolean } = {}
): Promise<Shopper> {
  shopperSeq += 1;
  const admin = getAdminSql();
  const customer = (await admin`
    INSERT INTO awcms_commerce_customers (tenant_id, name, phone)
    VALUES (${tenantId}, ${`Shopper ${shopperSeq}`},
            ${`+62812000${String(shopperSeq).padStart(5, "0")}`})
    RETURNING id
  `) as { id: string }[];

  if (options.account === false) {
    return {
      tenantId,
      customerId: customer[0]!.id,
      accountId: "",
      sessionId: ""
    };
  }

  const account = (await admin`
    INSERT INTO awcms_commerce_customer_accounts
      (tenant_id, customer_id, email_normalized, status, email_verified_at, history_from)
    VALUES (${tenantId}, ${customer[0]!.id}, ${`shopper${shopperSeq}@example.test`},
            ${options.blocked ? "blocked" : "active"},
            ${options.verified === false ? null : new Date()},
            now() - interval '1 day')
    RETURNING id
  `) as { id: string }[];

  return {
    tenantId,
    customerId: customer[0]!.id,
    accountId: account[0]!.id,
    sessionId: await seedSession(tenantId, account[0]!.id)
  };
}

let endpointSeq = 0;
/** A plausible FCM endpoint whose first path token selects the stub's behaviour. */
function newEndpoint(behaviour = "ok"): string {
  endpointSeq += 1;
  return `https://fcm.googleapis.com/fcm/send/${behaviour}${endpointSeq}:APA91bSECRETTOKEN${endpointSeq}xyz`;
}

/** Registers a device (consenting to the given purposes) and returns its id. */
async function addDevice(
  who: Shopper,
  options: {
    behaviour?: string;
    origin?: string;
    purposes?: string[];
    ring?: typeof RING_A;
  } = {}
): Promise<string> {
  const input: RegisterCustomerPushInput = {
    tenantId: who.tenantId,
    accountId: who.accountId,
    sessionId: who.sessionId,
    storefrontOrigin: options.origin ?? ORIGIN_A,
    endpoint: newEndpoint(options.behaviour),
    p256dhKey: makeSubscriberKey(),
    authSecret: randomBytes(16).toString("base64url"),
    userAgentSummary: "Chrome on Android (mobile)",
    consent: {
      purposes: options.purposes ?? [
        "order_updates",
        "payment_updates",
        "support_replies"
      ],
      textVersion: VERSION
    },
    ring: options.ring ?? RING_A
  };
  const outcome = await inTenant(who.tenantId, (tx) =>
    registerCustomerPushDevice(tx, input)
  );
  if (outcome.kind !== "registered") {
    throw new Error(`registration failed: ${outcome.kind}`);
  }
  return outcome.device.id;
}

async function seedOrder(
  tenantId: string,
  customerId: string,
  status = "paid"
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_orders
      (tenant_id, order_code, customer_id, status, payment_method, shipping_method,
       subtotal, total)
    VALUES (${tenantId}, ${`ORD-${crypto.randomUUID().slice(0, 8)}`}, ${customerId},
            ${status}, 'manual_bank', 'self_pickup', '100000.00', '100000.00')
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function seedConversation(
  tenantId: string,
  accountId: string
): Promise<string> {
  const rows = (await getAdminSql()`
    INSERT INTO awcms_commerce_conversations (tenant_id, account_id, subject)
    VALUES (${tenantId}, ${accountId}, 'Where is my parcel?')
    RETURNING id
  `) as { id: string }[];
  return rows[0]!.id;
}

async function seedStaff(tenantId: string): Promise<string> {
  const admin = getAdminSql();
  const profile = (await admin`
    INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
    VALUES (${tenantId}, 'person', 'Fanout Test Staff') RETURNING id
  `) as { id: string }[];
  const identity = (await admin`
    INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
    VALUES (${tenantId}, ${profile[0]!.id}, ${`fanout-staff-${tenantId}@example.test`}, 'x')
    RETURNING id
  `) as { id: string }[];
  const user = (await admin`
    INSERT INTO awcms_tenant_users (tenant_id, identity_id)
    VALUES (${tenantId}, ${identity[0]!.id}) RETURNING id
  `) as { id: string }[];
  return user[0]!.id;
}

function eventFor(
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
  occurredAt: Date = new Date()
): DomainEventForHandler {
  return {
    id: crypto.randomUUID(),
    eventType,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType,
    aggregateId,
    orderKey: `${aggregateType}:${aggregateId}`,
    correlationId: null,
    causationId: null,
    producerModule: "commerce",
    payload,
    occurredAt,
    recordedAt: occurredAt
  };
}

/** Runs the consumer exactly as the runtime does: as the worker, in a tenant transaction. */
function runConsumer(
  tenantId: string,
  event: DomainEventForHandler,
  env: NodeJS.ProcessEnv = process.env
) {
  return workerTx(tenantId, (tx) =>
    enqueueCustomerPushForEvent(tx, tenantId, event, { env })
  );
}

type MessageRow = {
  id: string;
  account_id: string;
  device_id: string;
  source_event_id: string;
  event_type: string;
  purpose: string;
  priority: string;
  tag: string;
  title: string;
  body: string;
  target_path: string;
  status: string;
  retry_count: number;
  next_attempt_at: Date | null;
  expires_at: Date;
  last_error: string | null;
  sent_at: Date | null;
  provider_name: string | null;
  created_at: Date;
};

async function messageRows(tenantId?: string): Promise<MessageRow[]> {
  const admin = getAdminSql();
  return (
    tenantId
      ? await admin`
        SELECT * FROM awcms_commerce_push_messages
        WHERE tenant_id = ${tenantId} ORDER BY created_at, id`
      : await admin`
        SELECT * FROM awcms_commerce_push_messages ORDER BY created_at, id`
  ) as MessageRow[];
}

async function deviceRow(id: string) {
  const rows = (await getAdminSql()`
    SELECT status, status_reason, failure_count, last_success_at,
           endpoint_ciphertext, p256dh_key, auth_secret_ciphertext
    FROM awcms_commerce_push_devices WHERE id = ${id}
  `) as {
    status: string;
    status_reason: string | null;
    failure_count: number;
    last_success_at: Date | null;
    endpoint_ciphertext: string | null;
    p256dh_key: string | null;
    auth_secret_ciphertext: string | null;
  }[];
  return rows[0]!;
}

async function attemptRows(messageId?: string) {
  const admin = getAdminSql();
  return (
    messageId
      ? await admin`
        SELECT attempt_no, outcome, provider_name, provider_response_snippet, error_message
        FROM awcms_commerce_push_delivery_attempts
        WHERE message_id = ${messageId} ORDER BY attempt_no`
      : await admin`
        SELECT attempt_no, outcome, provider_name, provider_response_snippet, error_message
        FROM awcms_commerce_push_delivery_attempts ORDER BY created_at`
  ) as {
    attempt_no: number;
    outcome: string;
    provider_name: string | null;
    provider_response_snippet: string | null;
    error_message: string | null;
  }[];
}

/** Queues one catalogue-text message directly through the outbox seam (as the worker). */
async function queueMessage(
  who: Shopper,
  deviceId: string,
  options: {
    purpose?: "order_updates" | "payment_updates" | "support_replies";
    priority?: "low" | "normal" | "high";
    eventId?: string;
    ttlMs?: number;
  } = {}
): Promise<string> {
  const purpose = options.purpose ?? "payment_updates";
  const text = renderCustomerPushText(purpose, "en");
  const outcome = await workerTx(who.tenantId, (tx) =>
    enqueueCustomerPushMessage(tx, {
      tenantId: who.tenantId,
      accountId: who.accountId,
      deviceId,
      sourceEventId: options.eventId ?? crypto.randomUUID(),
      eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
      purpose,
      priority: options.priority ?? "high",
      tag: purpose === "support_replies" ? "support" : "payment",
      title: text.title,
      body: text.body,
      expiresAt: new Date(Date.now() + (options.ttlMs ?? 4 * 3_600_000))
    })
  );
  if (outcome.kind !== "enqueued") {
    throw new Error(`enqueue refused: ${outcome.kind}`);
  }
  return outcome.messageId;
}

function dispatch(
  tenantId: string,
  options: {
    now?: Date;
    limit?: number;
    env?: NodeJS.ProcessEnv;
    afterClaim?: (ids: readonly string[]) => Promise<void>;
  } = {}
): Promise<DispatchCustomerPushResult> {
  return dispatchCustomerPushForTenant(getWorkerRoleSql(), tenantId, {
    http: stubHttp,
    env: options.env,
    now: options.now,
    limit: options.limit,
    afterClaim: options.afterClaim
  });
}

suite("customer Web Push fan-out (Issue #432)", () => {
  beforeAll(async () => {
    setEnv(PUSH_ENV);
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const headers: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        const body = await request.arrayBuffer();
        const path = new URL(request.url).pathname;
        seen.push({ path, headers, bodyBytes: body.byteLength });
        return new Response("", { status: statusFor(path) });
      }
    });
    await setupIntegrationDatabase();
  }, 120000);

  afterAll(async () => {
    server.stop(true);
    restoreEnv();
    await teardownIntegrationDatabase();
  }, 60000);

  beforeEach(async () => {
    seen = [];
    resetProviderCircuitBreakersForTests();
    setEnv(PUSH_ENV);
    await resetDatabase();
    await seedTenant(TENANT_A, "fan-a", { host: HOST_A });
    await seedTenant(TENANT_B, "fan-b", { host: HOST_B });
  }, 30000);

  // =========================================================================
  // Enqueue: every event, per eligible device
  // =========================================================================

  describe("the consumer enqueues one message per eligible device", () => {
    test("E1 to E7 each produce a row per active device with the policy's purpose, priority, tag, fixed path and generic text", async () => {
      const shopper = await seedShopper(TENANT_A);
      const phone = await addDevice(shopper);
      const laptop = await addDevice(shopper);
      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      const conversationId = await seedConversation(
        TENANT_A,
        shopper.accountId
      );
      const returnId = crypto.randomUUID();

      const cases: {
        label: string;
        event: DomainEventForHandler;
        purpose: string;
        priority: string;
        tag: string;
        path: string;
        ttlHours: number;
      }[] = [
        {
          label: "E1 order.paid",
          event: eventFor(
            COMMERCE_ORDER_PAID_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId, to: "paid" }
          ),
          purpose: "payment_updates",
          priority: "high",
          tag: "payment",
          path: "/akun/pesanan",
          ttlHours: 4
        },
        {
          label: "E2 order.status_changed to shipped",
          event: eventFor(
            COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId, from: "processing", to: "shipped" }
          ),
          purpose: "order_updates",
          priority: "high",
          tag: "order",
          path: "/akun/pesanan",
          ttlHours: 12
        },
        {
          label: "E3 order.cancelled by staff",
          event: eventFor(
            COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId, to: "cancelled" }
          ),
          purpose: "order_updates",
          priority: "normal",
          tag: "order",
          path: "/akun/pesanan",
          ttlHours: 4
        },
        {
          label: "E4 order.expired",
          event: eventFor(
            COMMERCE_ORDER_EXPIRED_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId, to: "expired" }
          ),
          purpose: "payment_updates",
          priority: "normal",
          tag: "payment",
          path: "/akun/pesanan",
          ttlHours: 4
        },
        {
          label:
            "E5 refund.settled (return aggregate, order id in the payload)",
          event: eventFor(
            COMMERCE_REFUND_SETTLED_EVENT_TYPE,
            COMMERCE_RETURN_AGGREGATE_TYPE,
            returnId,
            { orderId, returnId, amount: "50000.00" }
          ),
          purpose: "payment_updates",
          priority: "normal",
          tag: "payment",
          path: "/akun/pesanan",
          ttlHours: 12
        },
        {
          label: "E6 return.recorded",
          event: eventFor(
            COMMERCE_RETURN_RECORDED_EVENT_TYPE,
            COMMERCE_RETURN_AGGREGATE_TYPE,
            returnId,
            { orderId, returnId }
          ),
          purpose: "order_updates",
          priority: "normal",
          tag: "order",
          path: "/akun/pesanan",
          ttlHours: 12
        },
        {
          label: "E7 conversation.store_replied",
          event: eventFor(
            COMMERCE_CONVERSATION_STORE_REPLIED_EVENT_TYPE,
            COMMERCE_CONVERSATION_AGGREGATE_TYPE,
            conversationId,
            { conversationId }
          ),
          purpose: "support_replies",
          priority: "high",
          tag: "support",
          path: "/akun/pesan",
          ttlHours: 12
        }
      ];

      for (const entry of cases) {
        const before = (await messageRows()).length;
        const result = await runConsumer(TENANT_A, entry.event);
        expect(result.kind, entry.label).toBe("processed");

        const created = (await messageRows()).slice(before);
        expect(created, entry.label).toHaveLength(2);
        expect(created.map((m) => m.device_id).sort()).toEqual(
          [phone, laptop].sort()
        );
        for (const message of created) {
          expect(message.purpose).toBe(entry.purpose);
          expect(message.priority).toBe(entry.priority);
          expect(message.tag).toBe(entry.tag);
          expect(message.target_path).toBe(entry.path);
          expect(message.status).toBe("queued");
          expect(message.source_event_id).toBe(entry.event.id);
          expect(message.account_id).toBe(shopper.accountId);
          // The text is the catalogue's, in the tenant's locale: no order data.
          expect(message.title).toBe(
            renderCustomerPushText(entry.purpose as never, "en").title
          );
          expect(`${message.title} ${message.body}`).not.toMatch(/\d/);
          expect(
            Math.round(
              (message.expires_at.getTime() -
                entry.event.occurredAt.getTime()) /
                3_600_000
            )
          ).toBe(entry.ttlHours);
        }
      }

      expect(await messageRows()).toHaveLength(cases.length * 2);
    });

    test("E2 enqueues only processing, shipped and completed; a transition to paid, cancelled or expired adds nothing", async () => {
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper);
      const orderId = await seedOrder(TENANT_A, shopper.customerId);

      for (const to of ["paid", "cancelled", "expired", "pending_payment"]) {
        const result = await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId, to }
          )
        );
        expect(result).toEqual({
          kind: "skipped",
          reason: "status_not_notified"
        });
      }
      expect(await messageRows()).toHaveLength(0);

      const priorities: string[] = [];
      for (const to of ["processing", "shipped", "completed"]) {
        await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId, to }
          )
        );
        priorities.push((await messageRows()).at(-1)!.priority);
      }
      expect(priorities).toEqual(["normal", "high", "low"]);
    });

    test("the text follows the tenant's default locale", async () => {
      await getAdminSql()`
        UPDATE awcms_tenants SET default_locale = 'id' WHERE id = ${TENANT_A}
      `;
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper);
      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      await runConsumer(
        TENANT_A,
        eventFor(
          COMMERCE_ORDER_PAID_EVENT_TYPE,
          COMMERCE_ORDER_AGGREGATE_TYPE,
          orderId,
          { orderId }
        )
      );
      expect((await messageRows())[0]!.title).toBe("Pembaruan pembayaran");
    });

    test("a replay of the same event writes nothing more (one row per event and device)", async () => {
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper);
      await addDevice(shopper);
      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      const event = eventFor(
        COMMERCE_ORDER_PAID_EVENT_TYPE,
        COMMERCE_ORDER_AGGREGATE_TYPE,
        orderId,
        { orderId }
      );

      const first = await runConsumer(TENANT_A, event);
      const second = await runConsumer(TENANT_A, event);
      expect(first).toMatchObject({
        kind: "processed",
        enqueued: 2,
        duplicates: 0
      });
      expect(second).toMatchObject({
        kind: "processed",
        enqueued: 0,
        duplicates: 2
      });
      expect(await messageRows()).toHaveLength(2);
    });

    test("through the real runtime: an appended event is delivered to the consumer, once, even when the dispatcher runs twice", async () => {
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper);
      const orderId = await seedOrder(TENANT_A, shopper.customerId);

      await inTenant(TENANT_A, (tx) =>
        appendDomainEvent(tx, TENANT_A, {
          eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
          eventVersion: COMMERCE_EVENT_VERSION,
          aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
          aggregateId: orderId,
          producerModule: "commerce",
          payload: { orderId, to: "paid" }
        })
      );

      await dispatchDomainEventsForTenant(getWorkerRoleSql(), TENANT_A);
      await dispatchDomainEventsForTenant(getWorkerRoleSql(), TENANT_A);

      const rows = await messageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.purpose).toBe("payment_updates");
      expect(rows[0]!.status).toBe("queued");
    });
  });

  // =========================================================================
  // Enqueue: opt-in and the switches
  // =========================================================================

  describe("no enqueue without opt-in, and none with a switch off", () => {
    test("a purpose that is off, never set, withdrawn or on under an old wording produces nothing", async () => {
      const shopper = await seedShopper(TENANT_A);
      // Only order_updates consented: payment and support events are NOT sent.
      await addDevice(shopper, { purposes: ["order_updates"] });
      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      const conversationId = await seedConversation(
        TENANT_A,
        shopper.accountId
      );

      const paid = await runConsumer(
        TENANT_A,
        eventFor(
          COMMERCE_ORDER_PAID_EVENT_TYPE,
          COMMERCE_ORDER_AGGREGATE_TYPE,
          orderId,
          { orderId }
        )
      );
      const replied = await runConsumer(
        TENANT_A,
        eventFor(
          COMMERCE_CONVERSATION_STORE_REPLIED_EVENT_TYPE,
          COMMERCE_CONVERSATION_AGGREGATE_TYPE,
          conversationId,
          { conversationId }
        )
      );
      expect(paid).toEqual({ kind: "skipped", reason: "purpose_off" });
      expect(replied).toEqual({ kind: "skipped", reason: "purpose_off" });
      expect(await messageRows()).toHaveLength(0);

      // The purpose that IS on is delivered...
      const shipped = eventFor(
        COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
        COMMERCE_ORDER_AGGREGATE_TYPE,
        orderId,
        { orderId, to: "shipped" }
      );
      expect((await runConsumer(TENANT_A, shipped)).kind).toBe("processed");

      // ...until the customer withdraws it.
      await inTenant(TENANT_A, (tx) =>
        applyPreferenceChanges(
          tx,
          TENANT_A,
          shopper.accountId,
          [{ purpose: "order_updates", enabled: false }],
          null
        )
      );
      const afterWithdrawal = await runConsumer(
        TENANT_A,
        eventFor(
          COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
          COMMERCE_ORDER_AGGREGATE_TYPE,
          orderId,
          { orderId, to: "completed" }
        )
      );
      expect(afterWithdrawal).toEqual({
        kind: "skipped",
        reason: "purpose_off"
      });
      expect(await messageRows()).toHaveLength(1);
    });

    test("a consent given under an older wording no longer counts", async () => {
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper);
      await getAdminSql()`
        UPDATE awcms_commerce_push_preferences SET consent_text_version = 'draft-2020-01'
        WHERE account_id = ${shopper.accountId}
      `;
      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      const result = await runConsumer(
        TENANT_A,
        eventFor(
          COMMERCE_ORDER_PAID_EVENT_TYPE,
          COMMERCE_ORDER_AGGREGATE_TYPE,
          orderId,
          { orderId }
        )
      );
      expect(result).toEqual({ kind: "skipped", reason: "purpose_off" });
    });

    test("the reserved marketing preference is not a path to anything: enabling it row-wise changes nothing", async () => {
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper, { purposes: ["order_updates"] });
      await getAdminSql()`
        INSERT INTO awcms_commerce_push_preferences
          (tenant_id, account_id, purpose, enabled, consent_text_version, granted_at)
        VALUES (${TENANT_A}, ${shopper.accountId}, 'marketing', true, ${VERSION}, now())
      `;
      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      // payment_updates is off; marketing on must not stand in for it.
      expect(
        await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_ORDER_PAID_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId }
          )
        )
      ).toEqual({ kind: "skipped", reason: "purpose_off" });
      expect(await messageRows()).toHaveLength(0);
    });

    test("the tenant flag off (the default) and the deployment switch off both skip", async () => {
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper);
      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      const event = eventFor(
        COMMERCE_ORDER_PAID_EVENT_TYPE,
        COMMERCE_ORDER_AGGREGATE_TYPE,
        orderId,
        { orderId }
      );

      await setFeature(TENANT_A, false);
      expect(await runConsumer(TENANT_A, event)).toEqual({
        kind: "skipped",
        reason: "feature_off"
      });

      await setFeature(TENANT_A, true);
      expect(
        await runConsumer(TENANT_A, event, {
          ...process.env,
          PUSH_ENABLED: "false"
        })
      ).toEqual({ kind: "skipped", reason: "push_disabled" });
      expect(
        await runConsumer(TENANT_A, event, {
          ...process.env,
          PUSH_ENABLED: undefined
        })
      ).toEqual({ kind: "skipped", reason: "push_disabled" });
      expect(await messageRows()).toHaveLength(0);

      // Back on: the same event now enqueues.
      expect((await runConsumer(TENANT_A, event)).kind).toBe("processed");
    });

    test("a guest or walk-in customer (no account) gets nothing; a blocked or unverified account gets nothing", async () => {
      const guest = await seedShopper(TENANT_A, { account: false });
      const guestOrder = await seedOrder(TENANT_A, guest.customerId);
      expect(
        await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_ORDER_PAID_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            guestOrder,
            { orderId: guestOrder }
          )
        )
      ).toEqual({ kind: "skipped", reason: "no_account" });

      for (const options of [{ blocked: true }, { verified: false }]) {
        const shopper = await seedShopper(TENANT_A, options);
        await addDevice(shopper);
        const orderId = await seedOrder(TENANT_A, shopper.customerId);
        expect(
          await runConsumer(
            TENANT_A,
            eventFor(
              COMMERCE_ORDER_PAID_EVENT_TYPE,
              COMMERCE_ORDER_AGGREGATE_TYPE,
              orderId,
              { orderId }
            )
          )
        ).toEqual({ kind: "skipped", reason: "account_ineligible" });
      }

      // A blocked CUSTOMER row with an active account is blocked too.
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper);
      await getAdminSql()`
        UPDATE awcms_commerce_customers SET status = 'blocked' WHERE id = ${shopper.customerId}
      `;
      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      expect(
        await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_ORDER_PAID_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId }
          )
        )
      ).toEqual({ kind: "skipped", reason: "account_ineligible" });
      expect(await messageRows()).toHaveLength(0);
    });

    test("a cancellation the customer made themselves is not announced to them; a staff cancellation is", async () => {
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper);
      const byCustomer = await seedOrder(
        TENANT_A,
        shopper.customerId,
        "cancelled"
      );
      const byStaff = await seedOrder(
        TENANT_A,
        shopper.customerId,
        "cancelled"
      );
      await getAdminSql()`
        INSERT INTO awcms_commerce_order_events (tenant_id, order_id, from_status, to_status, actor)
        VALUES (${TENANT_A}, ${byCustomer}, 'pending_payment', 'cancelled', 'customer'),
               (${TENANT_A}, ${byStaff}, 'pending_payment', 'cancelled', 'admin')
      `;

      const own = await runConsumer(
        TENANT_A,
        eventFor(
          COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
          COMMERCE_ORDER_AGGREGATE_TYPE,
          byCustomer,
          { orderId: byCustomer }
        )
      );
      const staff = await runConsumer(
        TENANT_A,
        eventFor(
          COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
          COMMERCE_ORDER_AGGREGATE_TYPE,
          byStaff,
          { orderId: byStaff }
        )
      );
      expect(own).toEqual({ kind: "skipped", reason: "customer_is_actor" });
      expect(staff.kind).toBe("processed");
    });

    test("only active devices with a live session and a still-valid storefront origin are addressed", async () => {
      const shopper = await seedShopper(TENANT_A);
      const good = await addDevice(shopper);
      const revoked = await addDevice(shopper);
      const sessionEnded = await addDevice(shopper);
      const goneOrigin = await addDevice(shopper, {
        origin: "https://removed.example.test"
      });
      await inTenant(TENANT_A, (tx) =>
        revokeOwnCustomerPushDevice(tx, TENANT_A, shopper.accountId, revoked)
      );
      // A second session that has ended, enrolling its own device.
      const endedSession = await seedSession(TENANT_A, shopper.accountId);
      await getAdminSql()`
        UPDATE awcms_commerce_push_devices SET session_id = ${endedSession}
        WHERE id = ${sessionEnded}
      `;
      await getAdminSql()`
        UPDATE awcms_commerce_customer_sessions SET revoked_at = now() WHERE id = ${endedSession}
      `;

      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      const result = await runConsumer(
        TENANT_A,
        eventFor(
          COMMERCE_ORDER_PAID_EVENT_TYPE,
          COMMERCE_ORDER_AGGREGATE_TYPE,
          orderId,
          { orderId }
        )
      );
      expect(result).toMatchObject({ kind: "processed", devices: 1 });
      const rows = await messageRows();
      expect(rows.map((m) => m.device_id)).toEqual([good]);
      expect(goneOrigin).not.toBe(good);
    });

    test("no device at all: the inbox is the fallback, nothing is queued", async () => {
      const shopper = await seedShopper(TENANT_A);
      // Consent exists (registered then revoked) but no active device remains.
      const device = await addDevice(shopper);
      await inTenant(TENANT_A, (tx) =>
        revokeOwnCustomerPushDevice(tx, TENANT_A, shopper.accountId, device)
      );
      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      expect(
        await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_ORDER_PAID_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId }
          )
        )
      ).toEqual({ kind: "skipped", reason: "no_device" });
    });

    test("an event older than its TTL is not announced late", async () => {
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper);
      const orderId = await seedOrder(TENANT_A, shopper.customerId);
      const old = new Date(Date.now() - 5 * 3_600_000);
      expect(
        await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_ORDER_PAID_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId },
            old
          )
        )
      ).toEqual({ kind: "skipped", reason: "event_too_old" });
    });

    test("a malformed subject id is refused, not queried", async () => {
      expect(
        await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_REFUND_SETTLED_EVENT_TYPE,
            COMMERCE_RETURN_AGGREGATE_TYPE,
            crypto.randomUUID(),
            { orderId: "1' OR '1'='1" }
          )
        )
      ).toEqual({ kind: "skipped", reason: "bad_subject" });
    });
  });

  // =========================================================================
  // Enqueue: tenant isolation and the cap
  // =========================================================================

  describe("tenant isolation and the per-account cap", () => {
    test("an event of tenant B cannot reach tenant A's customer, even naming tenant A's order id", async () => {
      const shopperA = await seedShopper(TENANT_A);
      await addDevice(shopperA);
      const orderA = await seedOrder(TENANT_A, shopperA.customerId);

      // The runtime's tenant context is B; the order id is A's.
      const foreign = await runConsumer(
        TENANT_B,
        eventFor(
          COMMERCE_ORDER_PAID_EVENT_TYPE,
          COMMERCE_ORDER_AGGREGATE_TYPE,
          orderA,
          { orderId: orderA }
        )
      );
      expect(foreign).toEqual({ kind: "skipped", reason: "no_account" });
      expect(await messageRows()).toHaveLength(0);

      // And the worker in tenant A's context cannot read tenant B's outbox.
      const shopperB = await seedShopper(TENANT_B);
      const deviceB = await addDevice(shopperB, { origin: ORIGIN_B });
      await queueMessage(shopperB, deviceB);
      const visibleToA = await workerTx(
        TENANT_A,
        (tx) =>
          tx`SELECT count(*)::int AS n FROM awcms_commerce_push_messages` as Promise<
            { n: number }[]
          >
      );
      expect(visibleToA[0]!.n).toBe(0);
    });

    test("the cap limits NOTIFICATIONS: an event fanned out to several devices counts once, and the 13th event is suppressed", async () => {
      const shopper = await seedShopper(TENANT_A);
      for (let i = 0; i < 3; i += 1) await addDevice(shopper);
      const orderId = await seedOrder(TENANT_A, shopper.customerId);

      // 12 events x 3 devices = 36 rows, still under the hourly cap of 12 notifications.
      for (let i = 0; i < 12; i += 1) {
        const result = await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_ORDER_PAID_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId }
          )
        );
        expect(result).toMatchObject({ kind: "processed", enqueued: 3 });
      }
      expect(await messageRows()).toHaveLength(36);

      const thirteenth = await runConsumer(
        TENANT_A,
        eventFor(
          COMMERCE_ORDER_PAID_EVENT_TYPE,
          COMMERCE_ORDER_AGGREGATE_TYPE,
          orderId,
          { orderId }
        )
      );
      expect(thirteenth).toMatchObject({
        kind: "processed",
        enqueued: 0,
        suppressedRateLimit: 3
      });
      expect(await messageRows()).toHaveLength(36);

      // Another account on the same tenant is unaffected.
      const other = await seedShopper(TENANT_A);
      await addDevice(other);
      const otherOrder = await seedOrder(TENANT_A, other.customerId);
      expect(
        await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_ORDER_PAID_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            otherOrder,
            { orderId: otherOrder }
          )
        )
      ).toMatchObject({ kind: "processed", enqueued: 1 });
    });
  });

  // =========================================================================
  // The new event, appended by postStoreReply in its own transaction
  // =========================================================================

  describe("awcms.commerce.conversation.store_replied", () => {
    async function storeReplyEvents() {
      return (await getAdminSql()`
        SELECT event_type, aggregate_type, aggregate_id, producer_module, payload
        FROM awcms_domain_events
        WHERE event_type = ${COMMERCE_CONVERSATION_STORE_REPLIED_EVENT_TYPE}
      `) as {
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        producer_module: string;
        payload: Record<string, unknown>;
      }[];
    }

    test("postStoreReply appends it with the conversation id only, and the consumer turns it into a push", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      const staff = await seedStaff(TENANT_A);
      const conversationId = await seedConversation(
        TENANT_A,
        shopper.accountId
      );

      const outcome = await inTenant(TENANT_A, (tx) =>
        postStoreReply(
          tx,
          TENANT_A,
          staff,
          conversationId,
          "Your parcel left the warehouse this morning, order ORD-77 for Rp 150.000."
        )
      );
      expect(outcome.kind).toBe("posted");

      const events = await storeReplyEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        aggregate_type: "commerce.conversation",
        aggregate_id: conversationId,
        producer_module: "commerce",
        payload: { conversationId }
      });
      // Ids only: nothing of the reply, the subject or the customer.
      expect(Object.keys(events[0]!.payload)).toEqual(["conversationId"]);
      expect(JSON.stringify(events[0])).not.toMatch(
        /parcel|warehouse|ORD-77|150|Where is/
      );

      await dispatchDomainEventsForTenant(getWorkerRoleSql(), TENANT_A);
      const rows = await messageRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        purpose: "support_replies",
        priority: "high",
        target_path: "/akun/pesan",
        device_id: device
      });
      expect(`${rows[0]!.title} ${rows[0]!.body}`).not.toMatch(/parcel|ORD|Rp/);
    });

    test("it is appended in the SAME transaction: a rolled-back reply leaves no event and no push", async () => {
      const shopper = await seedShopper(TENANT_A);
      await addDevice(shopper);
      const staff = await seedStaff(TENANT_A);
      const conversationId = await seedConversation(
        TENANT_A,
        shopper.accountId
      );

      const failure = await assertRejected(
        inTenant(TENANT_A, async (tx) => {
          await postStoreReply(tx, TENANT_A, staff, conversationId, "hello");
          throw new Error("the request failed after the reply was stored");
        }),
        "the surrounding work failing"
      );
      expect(failure.message).toContain("failed after");

      expect(await storeReplyEvents()).toHaveLength(0);
      const messages = (await getAdminSql()`
        SELECT count(*)::int AS n FROM awcms_commerce_messages
      `) as { n: number }[];
      expect(messages[0]!.n).toBe(0);
      await dispatchDomainEventsForTenant(getWorkerRoleSql(), TENANT_A);
      expect(await messageRows()).toHaveLength(0);
    });
  });

  // =========================================================================
  // Dispatch: the happy path, idempotence and the headers
  // =========================================================================

  describe("the dispatcher", () => {
    test("sends once through the provider with a TTL, an Urgency and a VAPID signature, records the attempt and the device's success", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      const messageId = await queueMessage(shopper, device, {
        priority: "high",
        ttlMs: 2 * 3_600_000
      });

      const result = await dispatch(TENANT_A);
      expect(result).toMatchObject({ claimed: 1, sent: 1, gated: null });

      expect(seen).toHaveLength(1);
      const request = seen[0]!;
      expect(request.headers.urgency).toBe("high");
      // The remaining lifetime (just under two hours), never above four hours.
      const ttl = Number(request.headers.ttl);
      expect(ttl).toBeGreaterThan(2 * 3600 - 60);
      expect(ttl).toBeLessThanOrEqual(2 * 3600);
      expect(request.headers["content-encoding"]).toBe("aes128gcm");
      expect(request.headers.authorization).toStartWith("vapid t=");
      expect(request.bodyBytes).toBeGreaterThan(80);

      const [row] = await messageRows();
      expect(row).toMatchObject({
        id: messageId,
        status: "sent",
        provider_name: "web_push",
        last_error: null
      });
      expect(row!.sent_at).not.toBeNull();

      expect(await attemptRows(messageId)).toEqual([
        {
          attempt_no: 1,
          outcome: "success",
          provider_name: "web_push",
          provider_response_snippet: null,
          error_message: null
        }
      ]);
      const state = await deviceRow(device);
      expect(state.status).toBe("active");
      expect(state.last_success_at).not.toBeNull();
      expect(state.failure_count).toBe(0);
    });

    test("the Urgency header follows the queue priority: high, normal and low", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      for (const priority of ["low", "normal", "high"] as const) {
        await queueMessage(shopper, device, { priority });
      }
      await dispatch(TENANT_A);
      // Claim order is high first, then normal, then low.
      expect(seen.map((s) => s.headers.urgency)).toEqual([
        "high",
        "normal",
        "low"
      ]);
    });

    test("a second run sends nothing: a sent row is terminal", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      await queueMessage(shopper, device);
      expect((await dispatch(TENANT_A)).sent).toBe(1);
      const again = await dispatch(TENANT_A);
      expect(again).toMatchObject({ claimed: 0, sent: 0 });
      expect(seen).toHaveLength(1);
    });

    test("two dispatchers racing over the same backlog send every message exactly once", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      for (let i = 0; i < 6; i += 1) {
        await queueMessage(shopper, device, { purpose: "order_updates" });
      }

      await Promise.all([
        dispatch(TENANT_A, { limit: 4 }),
        dispatch(TENANT_A, { limit: 4 })
      ]);
      await dispatch(TENANT_A);

      expect(seen).toHaveLength(6);
      expect((await messageRows()).every((m) => m.status === "sent")).toBe(
        true
      );
      expect((await attemptRows()).length).toBe(6);
    });

    test("a row claimed by a live worker is invisible; a row whose lease lapsed is re-claimed and sent once", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      const messageId = await queueMessage(shopper, device);
      const admin = getAdminSql();

      // Another worker holds it: sending, lease in the future.
      await admin`
        UPDATE awcms_commerce_push_messages
        SET status = 'sending', next_attempt_at = now() + interval '3 minutes'
        WHERE id = ${messageId}
      `;
      expect(await dispatch(TENANT_A)).toMatchObject({ claimed: 0 });
      expect(seen).toHaveLength(0);

      // That worker died: the lease lapsed.
      await admin`
        UPDATE awcms_commerce_push_messages
        SET next_attempt_at = now() - interval '1 minute' WHERE id = ${messageId}
      `;
      expect(await dispatch(TENANT_A)).toMatchObject({ claimed: 1, sent: 1 });
      expect(seen).toHaveLength(1);
      expect(await attemptRows(messageId)).toHaveLength(1);
      expect(await dispatch(TENANT_A)).toMatchObject({ claimed: 0 });
      expect(seen).toHaveLength(1);
    });

    test("a worker whose lease lapsed between the claim and the send does not send; the row is picked up again and sent once", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      const messageId = await queueMessage(shopper, device);

      // Another worker's view: after our claim the lease runs out (we were slow).
      const result = await dispatch(TENANT_A, {
        afterClaim: async (ids) => {
          await getAdminSql()`
            UPDATE awcms_commerce_push_messages
            SET next_attempt_at = now() - interval '1 second'
            WHERE id = ANY(${getAdminSql().array([...ids], "uuid")}::uuid[])
          `;
        }
      });
      expect(result).toMatchObject({ claimed: 1, leaseLost: 1, sent: 0 });
      expect(seen).toHaveLength(0);
      expect((await messageRows())[0]!.status).toBe("sending");

      // The lapsed lease is re-claimed by the next pass: sent exactly once.
      expect(await dispatch(TENANT_A)).toMatchObject({ claimed: 1, sent: 1 });
      expect(seen).toHaveLength(1);
      expect(await attemptRows(messageId)).toHaveLength(1);
      expect(await dispatch(TENANT_A)).toMatchObject({ claimed: 0 });
      expect(seen).toHaveLength(1);
    });

    test("a row another worker settled between our claim and our send is left alone", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      const messageId = await queueMessage(shopper, device);

      const result = await dispatch(TENANT_A, {
        afterClaim: async () => {
          await getAdminSql()`
            UPDATE awcms_commerce_push_messages
            SET status = 'sent', sent_at = now(), next_attempt_at = NULL
            WHERE id = ${messageId}
          `;
        }
      });
      expect(result).toMatchObject({ claimed: 1, leaseLost: 1, sent: 0 });
      expect(seen).toHaveLength(0);
    });

    test("the job claims in bounded batches, high priority first", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      await queueMessage(shopper, device, { priority: "low" });
      await queueMessage(shopper, device, { priority: "high" });
      await queueMessage(shopper, device, { priority: "normal" });

      const first = await dispatch(TENANT_A, { limit: 2 });
      expect(first.claimed).toBe(2);
      expect(seen.map((s) => s.headers.urgency)).toEqual(["high", "normal"]);
      const second = await dispatch(TENANT_A, { limit: 2 });
      expect(second.claimed).toBe(1);
      expect(seen.map((s) => s.headers.urgency)).toEqual([
        "high",
        "normal",
        "low"
      ]);
    });
  });

  // =========================================================================
  // Dispatch: send-time eligibility (TS-I4), against real rows
  // =========================================================================

  describe("send-time eligibility cancels with no provider call", () => {
    async function setup() {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      const messageId = await queueMessage(shopper, device);
      return { shopper, device, messageId };
    }

    async function expectCancelled(
      messageId: string,
      error: string,
      status = "cancelled"
    ) {
      const result = await dispatch(TENANT_A);
      expect(seen).toHaveLength(0);
      expect(result.sent).toBe(0);
      const row = (await messageRows()).find((m) => m.id === messageId)!;
      expect(row.status).toBe(status);
      expect(row.last_error).toBe(error);
      return result;
    }

    test("the customer turned the purpose off after it was queued", async () => {
      const { shopper, messageId } = await setup();
      await inTenant(TENANT_A, (tx) =>
        applyPreferenceChanges(
          tx,
          TENANT_A,
          shopper.accountId,
          [{ purpose: "payment_updates", enabled: false }],
          null
        )
      );
      const result = await expectCancelled(messageId, "consent_withdrawn");
      expect(result.cancelled).toBe(1);
    });

    test("the consent wording changed (the version is no longer current)", async () => {
      const { shopper, messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_commerce_push_preferences SET consent_text_version = 'draft-2020-01'
        WHERE account_id = ${shopper.accountId}
      `;
      await expectCancelled(messageId, "consent_withdrawn");
    });

    test("the account was blocked: the message is cancelled and the device's credentials are destroyed", async () => {
      const { shopper, device, messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_commerce_customer_accounts SET status = 'blocked' WHERE id = ${shopper.accountId}
      `;
      await expectCancelled(messageId, "account_blocked");
      const state = await deviceRow(device);
      expect(state).toMatchObject({
        status: "revoked",
        status_reason: "account_blocked",
        endpoint_ciphertext: null,
        auth_secret_ciphertext: null,
        p256dh_key: null
      });
    });

    test("the customer row was blocked", async () => {
      const { shopper, messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_commerce_customers SET status = 'blocked' WHERE id = ${shopper.customerId}
      `;
      await expectCancelled(messageId, "account_blocked");
    });

    test("the e-mail is not verified", async () => {
      const { shopper, messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_commerce_customer_accounts SET email_verified_at = NULL WHERE id = ${shopper.accountId}
      `;
      await expectCancelled(messageId, "not_eligible");
    });

    test("the enrolling session ended without the logout path running (revoked row): cancelled, device revoked", async () => {
      const { shopper, device, messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_commerce_customer_sessions SET revoked_at = now() WHERE id = ${shopper.sessionId}
      `;
      await expectCancelled(messageId, "session_ended");
      expect(await deviceRow(device)).toMatchObject({
        status: "revoked",
        status_reason: "session_ended"
      });
    });

    test("the enrolling session expired", async () => {
      const { shopper, messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_commerce_customer_sessions SET expires_at = now() - interval '1 second'
        WHERE id = ${shopper.sessionId}
      `;
      await expectCancelled(messageId, "session_ended");
    });

    test("the device was revoked behind the queue's back", async () => {
      const { device, messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_commerce_push_devices
        SET status = 'revoked', status_reason = 'customer_removed', revoked_at = now(),
            endpoint_ciphertext = NULL, p256dh_key = NULL, auth_secret_ciphertext = NULL
        WHERE id = ${device}
      `;
      await expectCancelled(messageId, "device_revoked");
    });

    test("the device now belongs to another account (I5): the previous owner's message is refused", async () => {
      const { device, messageId } = await setup();
      const other = await seedShopper(TENANT_A);
      await getAdminSql()`
        UPDATE awcms_commerce_push_devices
        SET account_id = ${other.accountId}, session_id = ${other.sessionId}
        WHERE id = ${device}
      `;
      await expectCancelled(messageId, "device_transferred");
      // The new owner's device is untouched: nothing was tombstoned.
      expect((await deviceRow(device)).status).toBe("active");
    });

    test("the storefront domain was removed: the message is cancelled and the device disabled (origin_revoked)", async () => {
      const { device, messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_tenant_domains SET status = 'suspended' WHERE tenant_id = ${TENANT_A}
      `;
      await expectCancelled(messageId, "origin_revoked");
      expect(await deviceRow(device)).toMatchObject({
        status: "disabled",
        status_reason: "origin_revoked",
        endpoint_ciphertext: null
      });
    });

    test("a device bound to the CMS/admin origin is never sent to", async () => {
      const shopper = await seedShopper(TENANT_A);
      await getAdminSql()`
        INSERT INTO awcms_tenant_domains (tenant_id, hostname, normalized_hostname, status, verified_at)
        VALUES (${TENANT_A}, 'cms.example.test', 'cms.example.test', 'active', now())
      `;
      const device = await addDevice(shopper, { origin: CMS_ORIGIN });
      const messageId = await queueMessage(shopper, device);
      await expectCancelled(messageId, "origin_revoked");
    });

    test("a message past its expiry is expired, never sent late", async () => {
      const { messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_commerce_push_messages SET expires_at = now() - interval '1 second'
        WHERE id = ${messageId}
      `;
      const result = await dispatch(TENANT_A);
      expect(seen).toHaveLength(0);
      expect(result.expired).toBe(1);
      expect((await messageRows())[0]).toMatchObject({
        status: "expired",
        last_error: "expired"
      });
    });

    test("a row whose text is not the catalogue's is refused, whoever wrote it", async () => {
      const { messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_commerce_push_messages SET title = 'Order ORD-1 for Rp 150.000 shipped'
        WHERE id = ${messageId}
      `;
      await expectCancelled(messageId, "not_eligible");
    });

    test("a row whose target path is not the purpose's fixed path is refused", async () => {
      const { messageId } = await setup();
      await getAdminSql()`
        UPDATE awcms_commerce_push_messages SET target_path = '/akun/pesan' WHERE id = ${messageId}
      `;
      await expectCancelled(messageId, "not_eligible");
    });

    test("logout cancels what is queued in the same transaction, and nothing is sent afterwards", async () => {
      const { shopper, device, messageId } = await setup();
      const revoked = await inTenant(TENANT_A, (tx) =>
        revokeCustomerPushDevicesOfSession(tx, TENANT_A, shopper.sessionId)
      );
      expect(revoked).toBe(1);

      const [row] = await messageRows();
      expect(row).toMatchObject({
        id: messageId,
        status: "cancelled",
        last_error: "logout"
      });
      expect(await dispatch(TENANT_A)).toMatchObject({ claimed: 0 });
      expect(seen).toHaveLength(0);
      expect((await deviceRow(device)).status).toBe("revoked");
    });

    test("revoking a device cancels what is queued for it", async () => {
      const { shopper, device, messageId } = await setup();
      await inTenant(TENANT_A, (tx) =>
        revokeOwnCustomerPushDevice(tx, TENANT_A, shopper.accountId, device)
      );
      expect((await messageRows())[0]).toMatchObject({
        id: messageId,
        status: "cancelled",
        last_error: "device_revoked"
      });
      expect(await dispatch(TENANT_A)).toMatchObject({ claimed: 0 });
      expect(seen).toHaveLength(0);
    });
  });

  // =========================================================================
  // Dispatch: the kill switches
  // =========================================================================

  describe("the kill switches claim nothing", () => {
    test("PUSH_ENABLED off, the tenant flag off, the module disabled, no VAPID, no ring: the message stays queued and the stub sees nothing", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      await queueMessage(shopper, device);
      const base = { ...process.env } as NodeJS.ProcessEnv;

      expect(
        await dispatch(TENANT_A, { env: { ...base, PUSH_ENABLED: "false" } })
      ).toMatchObject({ gated: "push_disabled", claimed: 0 });
      expect(
        await dispatch(TENANT_A, {
          env: { ...base, PUSH_VAPID_PRIVATE_KEY: undefined }
        })
      ).toMatchObject({ gated: "push_not_configured", claimed: 0 });
      expect(
        await dispatch(TENANT_A, {
          env: { ...base, PUSH_AUTH_SECRET_ENCRYPTION_KEYS: undefined }
        })
      ).toMatchObject({ gated: "push_not_configured", claimed: 0 });
      expect(
        await dispatch(TENANT_A, { env: { ...base, PUSH_PROVIDER: "log" } })
      ).toMatchObject({ gated: "push_not_configured", claimed: 0 });

      await setFeature(TENANT_A, false);
      expect(await dispatch(TENANT_A)).toMatchObject({
        gated: "feature_off",
        claimed: 0
      });
      await setFeature(TENANT_A, true);

      await getAdminSql()`
        UPDATE awcms_tenant_modules SET enabled = false WHERE tenant_id = ${TENANT_A}
      `;
      expect(await dispatch(TENANT_A)).toMatchObject({
        gated: "module_disabled",
        claimed: 0
      });
      await getAdminSql()`
        UPDATE awcms_tenant_modules SET enabled = true WHERE tenant_id = ${TENANT_A}
      `;

      expect(seen).toHaveLength(0);
      expect((await messageRows())[0]!.status).toBe("queued");

      // Switched back on: the same message goes out.
      expect(await dispatch(TENANT_A)).toMatchObject({ sent: 1, gated: null });
    });

    test("the maintenance job still expires what an earlier period queued while the flag is off", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      const messageId = await queueMessage(shopper, device);
      await setFeature(TENANT_A, false);
      await getAdminSql()`
        UPDATE awcms_commerce_push_messages SET expires_at = now() - interval '1 minute'
        WHERE id = ${messageId}
      `;

      const result = await purgeCustomerPushForTenant(
        getWorkerRoleSql(),
        TENANT_A
      );
      expect(result.expiredMessages).toBe(1);
      expect((await messageRows())[0]).toMatchObject({
        status: "expired",
        last_error: "expired"
      });
    });
  });

  // =========================================================================
  // Dispatch: the push service's answers (TS-I6)
  // =========================================================================

  describe("the push service's answers", () => {
    test.each([
      ["410", "gone410"],
      ["404", "gone404"]
    ])(
      "%s revokes the device, destroys its credentials, cancels its other queued messages and records the attempt",
      async (_label, behaviour) => {
        const shopper = await seedShopper(TENANT_A);
        const device = await addDevice(shopper, { behaviour });
        const keep = await addDevice(shopper);
        const first = await queueMessage(shopper, device, { priority: "high" });
        const second = await queueMessage(shopper, device, {
          priority: "low",
          purpose: "order_updates"
        });
        const unrelated = await queueMessage(shopper, keep);

        const result = await dispatch(TENANT_A, { limit: 1 });
        expect(result).toMatchObject({ claimed: 1, gone: 1, sent: 0 });
        expect(seen).toHaveLength(1);

        expect(await deviceRow(device)).toMatchObject({
          status: "gone",
          status_reason: "endpoint_gone",
          endpoint_ciphertext: null,
          p256dh_key: null,
          auth_secret_ciphertext: null
        });
        const rows = await messageRows();
        const byId = (id: string) => rows.find((m) => m.id === id)!;
        expect(byId(first)).toMatchObject({
          status: "cancelled",
          last_error: "endpoint_gone"
        });
        // Its other waiting message is cancelled with the device, not sent.
        expect(byId(second)).toMatchObject({
          status: "cancelled",
          last_error: "endpoint_gone"
        });
        // Another device of the same customer is unaffected.
        expect(byId(unrelated).status).toBe("queued");

        const attempts = await attemptRows(first);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({
          outcome: "failure",
          error_message: "endpoint_gone"
        });
        // The snippet holds no endpoint and no token.
        expect(JSON.stringify(attempts)).not.toMatch(
          /fcm\.googleapis|SECRETTOKEN|APA91b/
        );

        // The revocation is audited with ids only.
        const audit = (await getAdminSql()`
          SELECT action, attributes FROM awcms_audit_events
          WHERE action = 'commerce.customer_push.device_revoked'
        `) as { action: string; attributes: Record<string, unknown> }[];
        expect(audit).toHaveLength(1);
        expect(audit[0]!.attributes).toMatchObject({
          reason: "endpoint_gone",
          accountId: shopper.accountId
        });
        expect(JSON.stringify(audit)).not.toMatch(
          /fcm\.googleapis|SECRETTOKEN/
        );

        // The next event no longer addresses the dead device.
        const orderId = await seedOrder(TENANT_A, shopper.customerId);
        const next = await runConsumer(
          TENANT_A,
          eventFor(
            COMMERCE_ORDER_PAID_EVENT_TYPE,
            COMMERCE_ORDER_AGGREGATE_TYPE,
            orderId,
            { orderId }
          )
        );
        expect(next).toMatchObject({ kind: "processed", devices: 1 });
      }
    );

    test("a 503 backs off exponentially, counts the failure and stops at the retry budget", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper, { behaviour: "busy503" });
      const messageId = await queueMessage(shopper, device);
      setEnv({ PUSH_SEND_MAX_RETRIES: "2" });

      const env = { ...process.env } as NodeJS.ProcessEnv;
      let now = new Date();
      const minutes = [1, 2];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const result = await dispatch(TENANT_A, { now, env });
        expect(result).toMatchObject({ claimed: 1, retried: 1 });
        const [row] = await messageRows();
        expect(row).toMatchObject({
          status: "retry_wait",
          retry_count: attempt,
          last_error: "provider_unavailable"
        });
        expect(row!.next_attempt_at!.getTime() - now.getTime()).toBe(
          minutes[attempt - 1]! * 60_000
        );
        expect((await deviceRow(device)).failure_count).toBe(attempt);

        // Not due yet: nothing is claimed one second earlier.
        expect(
          await dispatch(TENANT_A, {
            now: new Date(row!.next_attempt_at!.getTime() - 1000),
            env
          })
        ).toMatchObject({ claimed: 0 });
        now = new Date(row!.next_attempt_at!.getTime() + 1000);
        resetProviderCircuitBreakersForTests();
      }

      // The third failure exhausts the budget (2): terminal.
      const last = await dispatch(TENANT_A, { now, env });
      expect(last).toMatchObject({ claimed: 1, failed: 1 });
      expect((await messageRows())[0]).toMatchObject({
        status: "failed",
        retry_count: 3,
        last_error: "provider_unavailable"
      });
      expect((await attemptRows(messageId)).map((a) => a.attempt_no)).toEqual([
        1, 2, 3
      ]);
      // The device is alive: a transient push-service error revokes nothing.
      expect((await deviceRow(device)).status).toBe("active");
      expect(seen).toHaveLength(3);
    });

    test("a 429 is retried; a 400 is permanent and is not", async () => {
      const shopper = await seedShopper(TENANT_A);
      const limited = await addDevice(shopper, { behaviour: "limit429" });
      const rejected = await addDevice(shopper, { behaviour: "reject400" });
      const a = await queueMessage(shopper, limited);
      const b = await queueMessage(shopper, rejected, {
        priority: "low",
        purpose: "order_updates"
      });

      const result = await dispatch(TENANT_A);
      expect(result).toMatchObject({ claimed: 2, retried: 1, failed: 1 });
      const rows = await messageRows();
      expect(rows.find((m) => m.id === a)).toMatchObject({
        status: "retry_wait",
        retry_count: 1,
        last_error: "provider_unavailable"
      });
      expect(rows.find((m) => m.id === b)).toMatchObject({
        status: "failed",
        retry_count: 1,
        last_error: "provider_rejected"
      });
      expect((await deviceRow(rejected)).status).toBe("active");
    });

    test("a later success clears the device's failure count", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper, { behaviour: "busy503" });
      await queueMessage(shopper, device);
      await dispatch(TENANT_A);
      expect((await deviceRow(device)).failure_count).toBe(1);

      // The push service recovers: same device, a fresh message that now succeeds.
      await getAdminSql()`
        UPDATE awcms_commerce_push_messages SET status = 'cancelled' WHERE device_id = ${device}
      `;
      const recovered = await addDevice(shopper);
      await getAdminSql()`
        UPDATE awcms_commerce_push_devices SET failure_count = 3 WHERE id = ${recovered}
      `;
      await queueMessage(shopper, recovered, { purpose: "order_updates" });
      resetProviderCircuitBreakersForTests();
      await dispatch(TENANT_A);
      expect(await deviceRow(recovered)).toMatchObject({ failure_count: 0 });
    });

    test("when the breaker opens mid-pass the rest are released unattempted, with their retries intact", async () => {
      const ids: string[] = [];
      // Seven shoppers: one account holds at most five devices.
      for (let i = 0; i < 7; i += 1) {
        const shopper = await seedShopper(TENANT_A);
        const device = await addDevice(shopper, { behaviour: "busy503" });
        ids.push(await queueMessage(shopper, device));
      }

      const result = await dispatch(TENANT_A);
      expect(result.breakerOpen).toBe(true);
      expect(result.retried).toBe(5);
      expect(result.released).toBe(2);
      expect(seen).toHaveLength(5);

      const rows = await messageRows();
      const released = rows.filter(
        (m) => m.status === "retry_wait" && m.retry_count === 0
      );
      expect(released).toHaveLength(2);
      expect(
        released.every((m) => m.last_error === "provider_unavailable")
      ).toBe(true);
      // No attempt was recorded for what was never attempted.
      expect((await attemptRows()).length).toBe(5);

      // While open, a new pass claims nothing.
      expect(await dispatch(TENANT_A)).toMatchObject({
        claimed: 0,
        breakerOpen: true
      });
      expect(ids).toHaveLength(7);
    });

    test("ciphertext that cannot be read is a configuration failure, not a push-service one, and sends nothing", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      const messageId = await queueMessage(shopper, device);
      // A ring that no longer holds the key the device was written under.
      const wrong = randomBytes(32).toString("base64");
      const result = await dispatch(TENANT_A, {
        env: {
          ...process.env,
          PUSH_AUTH_SECRET_ENCRYPTION_KEYS: `kz:${wrong}`
        } as NodeJS.ProcessEnv
      });
      expect(result).toMatchObject({ claimed: 1, retried: 1, sent: 0 });
      expect(seen).toHaveLength(0);
      expect((await messageRows())[0]).toMatchObject({
        status: "retry_wait",
        last_error: "config_unavailable"
      });
      expect((await attemptRows(messageId))[0]).toMatchObject({
        outcome: "failure",
        error_message: "config_unavailable",
        provider_response_snippet: null
      });
    });
  });

  // =========================================================================
  // Dispatch: the cap at send time
  // =========================================================================

  describe("the per-account cap at send time (12 per hour, 40 per day)", () => {
    async function seedSent(
      who: Shopper,
      deviceId: string,
      count: number,
      minutesAgo: (index: number) => number
    ) {
      const admin = getAdminSql();
      for (let i = 0; i < count; i += 1) {
        const at = new Date(Date.now() - minutesAgo(i) * 60_000);
        await admin`
          INSERT INTO awcms_commerce_push_messages
            (tenant_id, account_id, device_id, source_event_id, event_type, purpose,
             tag, dedupe_key, title, body, target_path, expires_at, status, sent_at, created_at)
          VALUES (${who.tenantId}, ${who.accountId}, ${deviceId}, ${crypto.randomUUID()},
                  'awcms.commerce.order.paid', 'order_updates', 'order', ${`seed-${crypto.randomUUID()}`},
                  'Your order has an update', 'Open your account to see it.', '/akun/pesanan',
                  now() + interval '1 hour', 'sent', ${at}, ${at})
        `;
      }
    }

    test("twelve notifications already sent this hour: the next is deferred until the oldest leaves the window, then goes out", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      // Queue first: the enqueue-side cap would refuse a 13th notification.
      const messageId = await queueMessage(shopper, device);
      await seedSent(shopper, device, 12, (i) => 10 + i * 4); // 10..54 minutes ago

      const result = await dispatch(TENANT_A);
      expect(result).toMatchObject({ claimed: 1, deferred: 1, sent: 0 });
      expect(seen).toHaveLength(0);

      const row = (await messageRows()).find((m) => m.id === messageId)!;
      expect(row.status).toBe("retry_wait");
      expect(row.last_error).toBe("rate_limited");
      expect(row.retry_count).toBe(0);
      // The oldest counted send was 54 minutes ago: the slot frees in about 6.
      const wait = row.next_attempt_at!.getTime() - Date.now();
      expect(wait).toBeGreaterThan(4 * 60_000);
      expect(wait).toBeLessThan(8 * 60_000);

      // Not due yet.
      expect(await dispatch(TENANT_A)).toMatchObject({ claimed: 0 });

      // Ten minutes later the window has room.
      const later = await dispatch(TENANT_A, {
        now: new Date(Date.now() + 10 * 60_000)
      });
      expect(later).toMatchObject({ claimed: 1, sent: 1 });
      expect(seen).toHaveLength(1);
    });

    test("an eleventh notification is still sent (the cap is 12, not 11)", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      await queueMessage(shopper, device);
      await seedSent(shopper, device, 11, (i) => 5 + i * 4);
      expect(await dispatch(TENANT_A)).toMatchObject({ sent: 1, deferred: 0 });
    });

    test("forty notifications already sent today: deferred to when the oldest leaves the day", async () => {
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      const messageId = await queueMessage(shopper, device);
      await seedSent(shopper, device, 40, (i) => 90 + i * 30); // spread over ~20 h

      const result = await dispatch(TENANT_A);
      expect(result).toMatchObject({ deferred: 1, sent: 0 });
      expect(seen).toHaveLength(0);
      const row = (await messageRows()).find((m) => m.id === messageId)!;
      expect(row.last_error).toBe("rate_limited");
      // The oldest was 90 + 39*30 = 1260 minutes ago: it leaves the 24 h window in 180 minutes.
      const wait = row.next_attempt_at!.getTime() - Date.now();
      expect(wait).toBeGreaterThan(170 * 60_000);
      expect(wait).toBeLessThan(190 * 60_000);
    });

    test("a second device of a notification that already holds a slot is sent even at the cap", async () => {
      const shopper = await seedShopper(TENANT_A);
      const first = await addDevice(shopper);
      const second = await addDevice(shopper);
      // One event fanned out to two devices: it is ONE notification (the 12th).
      const eventId = crypto.randomUUID();
      await queueMessage(shopper, first, { eventId });
      await queueMessage(shopper, second, { eventId });
      await seedSent(shopper, first, 11, (i) => 20 + i * 3);

      const result = await dispatch(TENANT_A);
      expect(result).toMatchObject({ claimed: 2, sent: 2, deferred: 0 });
      expect(seen).toHaveLength(2);
    });

    test("another account is not held back by this account's cap", async () => {
      const heavy = await seedShopper(TENANT_A);
      const light = await seedShopper(TENANT_A);
      const heavyDevice = await addDevice(heavy);
      const lightDevice = await addDevice(light);
      await queueMessage(heavy, heavyDevice);
      await queueMessage(light, lightDevice);
      await seedSent(heavy, heavyDevice, 12, (i) => 10 + i * 4);

      const result = await dispatch(TENANT_A);
      expect(result).toMatchObject({ claimed: 2, sent: 1, deferred: 1 });
    });
  });

  // =========================================================================
  // Tenant isolation of the dispatcher
  // =========================================================================

  describe("tenant isolation of the dispatcher", () => {
    test("a pass for tenant A never claims or sends tenant B's messages", async () => {
      const shopperA = await seedShopper(TENANT_A);
      const shopperB = await seedShopper(TENANT_B);
      const deviceA = await addDevice(shopperA);
      const deviceB = await addDevice(shopperB, { origin: ORIGIN_B });
      const a = await queueMessage(shopperA, deviceA);
      const b = await queueMessage(shopperB, deviceB);

      const result = await dispatch(TENANT_A);
      expect(result).toMatchObject({ claimed: 1, sent: 1 });
      const rows = await messageRows();
      expect(rows.find((m) => m.id === a)!.status).toBe("sent");
      expect(rows.find((m) => m.id === b)!.status).toBe("queued");

      expect(await dispatch(TENANT_B)).toMatchObject({ claimed: 1, sent: 1 });
      expect(seen).toHaveLength(2);
    });

    test("tenant B's flag being off does not hold tenant A, and vice versa", async () => {
      const shopperA = await seedShopper(TENANT_A);
      const shopperB = await seedShopper(TENANT_B);
      await queueMessage(shopperA, await addDevice(shopperA));
      await queueMessage(
        shopperB,
        await addDevice(shopperB, { origin: ORIGIN_B })
      );
      await setFeature(TENANT_B, false);

      expect(await dispatch(TENANT_A)).toMatchObject({ sent: 1 });
      expect(await dispatch(TENANT_B)).toMatchObject({
        gated: "feature_off",
        sent: 0
      });
    });
  });

  // =========================================================================
  // The worker's column grants (sql/1061)
  // =========================================================================

  describe("the worker's column-only grants on the outbox", () => {
    test("the table-level privileges are SELECT and DELETE only; INSERT and UPDATE are column lists", async () => {
      if (!workerRoleActivated) return;
      const admin = getAdminSql();
      const table = async (privilege: string) =>
        (
          (await admin`
          SELECT has_table_privilege('awcms_worker', 'awcms_commerce_push_messages', ${privilege}) AS held
        `) as { held: boolean }[]
        )[0]!.held;
      expect(await table("SELECT")).toBe(true);
      expect(await table("DELETE")).toBe(true);
      expect(await table("INSERT")).toBe(false);
      expect(await table("UPDATE")).toBe(false);

      const columns = async (privilege: string) =>
        (
          (await admin`
            SELECT attname FROM pg_attribute
            WHERE attrelid = 'awcms_commerce_push_messages'::regclass
              AND attnum > 0 AND NOT attisdropped
              AND has_column_privilege('awcms_worker', 'awcms_commerce_push_messages', attname, ${privilege})
            ORDER BY attname
          `) as { attname: string }[]
        ).map((row) => row.attname);

      expect(await columns("UPDATE")).toEqual(
        [
          "last_error",
          "next_attempt_at",
          "provider_message_id",
          "provider_name",
          "retry_count",
          "sent_at",
          "status",
          "updated_at"
        ].sort()
      );
      expect(await columns("INSERT")).toEqual(
        [
          "account_id",
          "body",
          "dedupe_key",
          "device_id",
          "event_type",
          "expires_at",
          "priority",
          "purpose",
          "source_event_id",
          "tag",
          "target_path",
          "tenant_id",
          "title"
        ].sort()
      );
    });

    test("the worker cannot rewrite where or what an existing message says, nor insert a row that is already sent", async () => {
      if (!workerRoleActivated) return;
      const shopper = await seedShopper(TENANT_A);
      const device = await addDevice(shopper);
      const other = await addDevice(await seedShopper(TENANT_A));
      const messageId = await queueMessage(shopper, device);

      for (const [column, value] of [
        ["device_id", other],
        ["account_id", shopper.accountId],
        ["title", "Hello"],
        ["body", "Hello"],
        ["target_path", "/akun/pesan"],
        ["purpose", "order_updates"],
        ["expires_at", new Date(Date.now() + 86_400_000)]
      ] as const) {
        const error = await assertRejected(
          workerTx(TENANT_A, (tx) =>
            tx.unsafe(
              `UPDATE awcms_commerce_push_messages SET ${column} = $1 WHERE id = $2`,
              [value as never, messageId]
            )
          ),
          `the worker updating ${column}`
        );
        expect(String(error.message)).toMatch(/permission denied/i);
      }

      const insertSent = await assertRejected(
        workerTx(
          TENANT_A,
          (tx) => tx`
          INSERT INTO awcms_commerce_push_messages
            (tenant_id, account_id, device_id, source_event_id, event_type, purpose,
             tag, dedupe_key, title, body, target_path, expires_at, status)
          VALUES (${TENANT_A}, ${shopper.accountId}, ${device}, ${crypto.randomUUID()},
                  'x.y', 'order_updates', 'order', 'forged', 't', 'b', '/akun/pesanan',
                  now() + interval '1 hour', 'sent')
        `
        ),
        "the worker inserting a row that is already sent"
      );
      expect(String(insertSent.message)).toMatch(/permission denied/i);
    });
  });

  // =========================================================================
  // Observability: the numbers distinguish queued, accepted, retry and revoked
  // =========================================================================

  describe("diagnostics keep the vocabulary honest", () => {
    test("counts are by status and none is called delivered", async () => {
      const shopper = await seedShopper(TENANT_A);
      const ok = await addDevice(shopper);
      const gone = await addDevice(shopper, { behaviour: "gone410" });
      const busy = await addDevice(shopper, { behaviour: "busy503" });
      await queueMessage(shopper, ok, { purpose: "order_updates" });
      await queueMessage(shopper, gone, { purpose: "payment_updates" });
      await queueMessage(shopper, busy, { purpose: "support_replies" });
      await dispatch(TENANT_A);

      const { fetchCustomerPushDiagnostics } =
        await import("../../src/modules/commerce/application/customer-push-diagnostics");
      const diagnostics = await inTenant(TENANT_A, (tx) =>
        fetchCustomerPushDiagnostics(tx, TENANT_A)
      );
      expect(diagnostics.messages.byStatus).toMatchObject({
        sent: 1,
        retry_wait: 1,
        cancelled: 1
      });
      expect(diagnostics.messages.byReason).toEqual([
        { status: "cancelled", reason: "endpoint_gone", count: 1 },
        { status: "retry_wait", reason: "provider_unavailable", count: 1 }
      ]);
      expect(diagnostics.devices).toMatchObject({ active: 2, gone: 1 });
      expect(JSON.stringify(diagnostics)).not.toMatch(/deliver|read|click/i);
    });
  });
});
