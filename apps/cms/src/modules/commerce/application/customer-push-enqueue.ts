/**
 * The customer Web Push fan-out CONSUMER (Issue #432, ADR-0048 section 5.4):
 * turns one transactional commerce domain event into outbox rows for the
 * customer who opted in. Declared in `module.ts`'s `domainEventConsumers` as
 * `commerce.customer_push_enqueuer`, so it runs inside the runtime's delivery
 * transaction with the default once-per-effect guard, and it makes NO network
 * call: the checkout, payment and webhook paths never wait on a push service
 * (the issue's first acceptance criterion, TS-S3 pins that this file imports no
 * provider, transport or credential code).
 *
 * ## The decision, in order (every "stop" is a recorded reason, never an error)
 *
 *  1. `PUSH_ENABLED` is on (the deployment kill switch) and the tenant's
 *     `customerPush` feature is on (the tenant kill switch, default OFF).
 *  2. The event maps to a purpose through the CLOSED table in
 *     `domain/customer-push-policy.ts`. No entry, no push. No entry maps to
 *     `marketing` (T13).
 *  3. The event is not older than the policy's TTL (a payment banner ten hours
 *     after the fact is noise, and a paused consumer must not flush a backlog).
 *  4. The customer is found from SERVER-SIDE facts only: order -> customer ->
 *     the single account bound to it, or conversation -> account. A guest or
 *     walk-in has no account: stop. The id comes from the event's aggregate or a
 *     validated `orderId`, never from anything a client sent.
 *  5. The account is active, verified and not erased, its customer is not
 *     blocked; a cancellation the customer made themselves is not announced to
 *     them.
 *  6. The preference for the purpose is explicitly ON under the CURRENT consent
 *     wording version. Otherwise stop: the inbox is the fallback.
 *  7. The account's devices that are active, whose enrolling session is live and
 *     whose storefront origin is still one of the tenant's domains. None: stop.
 *  8. One outbox row per device through `enqueueCustomerPushMessage`: the dedupe
 *     key is (event, device) so a replay writes nothing, the per-account cap
 *     (12 per hour, 40 per day) is applied under a lock, and the text is the
 *     catalogue string in the tenant's locale.
 *
 * The send-time eligibility (`customer-push-dispatch.ts`) re-checks 5 to 7: the
 * world can change between the event and the send.
 */
import { log } from "../../../lib/logging/logger";
import type { DomainEventForHandler } from "../../_shared/domain-event-consumer-contract";
import { isPushEnabled } from "../../push-delivery/domain/push-config";
import { CUSTOMER_PUSH_CONSENT_TEXT_VERSION } from "../domain/customer-push";
import {
  asEventUuid,
  isStorefrontOriginStillValid,
  renderCustomerPushText,
  resolveCustomerPushPolicy,
  type CustomerPushPolicy
} from "../domain/customer-push-policy";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import {
  loadActiveDomainHostnames,
  loadTenantPushLocale,
  resolveAdminOrigin
} from "./customer-push-facts";
import { enqueueCustomerPushMessage } from "./customer-push-outbox";

export type CustomerPushEnqueueSkip =
  | "push_disabled"
  | "feature_off"
  | "unmapped_event"
  | "status_not_notified"
  | "event_too_old"
  | "bad_subject"
  | "no_account"
  | "account_ineligible"
  | "customer_is_actor"
  | "purpose_off"
  | "no_device";

export type CustomerPushEnqueueResult =
  | { kind: "skipped"; reason: CustomerPushEnqueueSkip }
  | {
      kind: "processed";
      purpose: string;
      devices: number;
      enqueued: number;
      duplicates: number;
      /** Devices not written because the account is at its hourly or daily cap (`suppressed_rate_limit`). */
      suppressedRateLimit: number;
    };

export type CustomerPushEnqueueOptions = {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  correlationId?: string;
};

type AccountFacts = {
  account_id: string;
  status: string;
  email_verified_at: Date | null;
  deleted_at: Date | null;
  customer_status: string | null;
};

/** Order -> customer -> the single account bound to that customer (`UNIQUE (tenant_id, customer_id)`). */
async function accountOfOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<AccountFacts | null> {
  const rows = (await tx`
    SELECT a.id AS account_id, a.status, a.email_verified_at, a.deleted_at,
           c.status AS customer_status
    FROM awcms_commerce_orders o
    JOIN awcms_commerce_customer_accounts a
      ON a.tenant_id = o.tenant_id AND a.customer_id = o.customer_id
    LEFT JOIN awcms_commerce_customers c
      ON c.tenant_id = a.tenant_id AND c.id = a.customer_id
    WHERE o.tenant_id = ${tenantId} AND o.id = ${orderId}
  `) as AccountFacts[];

  return rows[0] ?? null;
}

/** Conversation -> its account (`awcms_commerce_conversations.account_id`). */
async function accountOfConversation(
  tx: Bun.SQL,
  tenantId: string,
  conversationId: string
): Promise<AccountFacts | null> {
  const rows = (await tx`
    SELECT a.id AS account_id, a.status, a.email_verified_at, a.deleted_at,
           c.status AS customer_status
    FROM awcms_commerce_conversations v
    JOIN awcms_commerce_customer_accounts a
      ON a.tenant_id = v.tenant_id AND a.id = v.account_id
    LEFT JOIN awcms_commerce_customers c
      ON c.tenant_id = a.tenant_id AND c.id = a.customer_id
    WHERE v.tenant_id = ${tenantId} AND v.id = ${conversationId}
      AND v.deleted_at IS NULL
  `) as AccountFacts[];

  return rows[0] ?? null;
}

/** E3: true when the order's cancellation was made by the customer themselves. */
async function cancelledByCustomer(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT actor FROM awcms_commerce_order_events
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
      AND to_status = 'cancelled'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `) as { actor: string }[];

  return rows[0]?.actor === "customer";
}

function subjectId(
  policy: CustomerPushPolicy,
  event: DomainEventForHandler
): string | null {
  return policy.subject === "payload_order_id"
    ? asEventUuid(event.payload.orderId)
    : asEventUuid(event.aggregateId);
}

export async function enqueueCustomerPushForEvent(
  tx: Bun.SQL,
  tenantId: string,
  event: DomainEventForHandler,
  options: CustomerPushEnqueueOptions = {}
): Promise<CustomerPushEnqueueResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();

  const skip = (reason: CustomerPushEnqueueSkip): CustomerPushEnqueueResult => {
    log("info", "commerce.customer_push.enqueue_skipped", {
      tenantId,
      moduleKey: "commerce",
      eventType: event.eventType,
      reason,
      correlationId: options.correlationId
    });
    return { kind: "skipped", reason };
  };

  if (!isPushEnabled(env)) return { kind: "skipped", reason: "push_disabled" };

  // Cheap and total: decided before any query so the common case of an event
  // that never notifies (and a tenant with the feature off) costs one read.
  const decision = resolveCustomerPushPolicy(event.eventType, event.payload);
  if (decision.kind === "none") {
    return { kind: "skipped", reason: decision.reason };
  }
  const policy = decision.policy;

  if (!(await fetchCommerceFeatures(tx, tenantId)).customerPush) {
    return { kind: "skipped", reason: "feature_off" };
  }

  const expiresAt = new Date(event.occurredAt.getTime() + policy.ttlMs);
  if (expiresAt.getTime() <= now.getTime()) return skip("event_too_old");

  const id = subjectId(policy, event);
  if (id === null) return skip("bad_subject");

  const account =
    policy.subject === "conversation_aggregate"
      ? await accountOfConversation(tx, tenantId, id)
      : await accountOfOrder(tx, tenantId, id);
  if (!account) return skip("no_account");

  if (
    account.deleted_at !== null ||
    account.status !== "active" ||
    account.email_verified_at === null ||
    account.customer_status === null ||
    account.customer_status === "blocked"
  ) {
    return skip("account_ineligible");
  }

  if (
    policy.suppressWhenCustomerIsActor &&
    policy.subject !== "conversation_aggregate" &&
    (await cancelledByCustomer(tx, tenantId, id))
  ) {
    return skip("customer_is_actor");
  }

  // Opt-in, explicit, under the wording the customer currently has (T13).
  const preference = (await tx`
    SELECT enabled, consent_text_version
    FROM awcms_commerce_push_preferences
    WHERE tenant_id = ${tenantId} AND account_id = ${account.account_id}
      AND purpose = ${policy.purpose}
  `) as { enabled: boolean; consent_text_version: string }[];
  if (
    !preference[0]?.enabled ||
    preference[0].consent_text_version !== CUSTOMER_PUSH_CONSENT_TEXT_VERSION
  ) {
    return skip("purpose_off");
  }

  const candidates = (await tx`
    SELECT d.id, d.storefront_origin
    FROM awcms_commerce_push_devices d
    JOIN awcms_commerce_customer_sessions s
      ON s.tenant_id = d.tenant_id AND s.id = d.session_id
    WHERE d.tenant_id = ${tenantId} AND d.account_id = ${account.account_id}
      AND d.status = 'active'
      AND s.revoked_at IS NULL AND s.expires_at > ${now}
    ORDER BY d.registered_at, d.id
  `) as { id: string; storefront_origin: string }[];

  const domains = await loadActiveDomainHostnames(tx, tenantId);
  const adminOrigin = resolveAdminOrigin(env);
  const devices = candidates.filter((device) =>
    isStorefrontOriginStillValid(device.storefront_origin, domains, adminOrigin)
  );
  if (devices.length === 0) return skip("no_device");

  const text = renderCustomerPushText(
    policy.purpose,
    await loadTenantPushLocale(tx, tenantId)
  );

  let enqueued = 0;
  let duplicates = 0;
  let suppressedRateLimit = 0;

  for (const device of devices) {
    const outcome = await enqueueCustomerPushMessage(
      tx,
      {
        tenantId,
        accountId: account.account_id,
        deviceId: device.id,
        sourceEventId: event.id,
        eventType: event.eventType,
        purpose: policy.purpose,
        priority: policy.priority,
        tag: policy.tag,
        title: text.title,
        body: text.body,
        expiresAt
      },
      now
    );

    if (outcome.kind === "enqueued") enqueued += 1;
    else if (outcome.kind === "duplicate") duplicates += 1;
    else suppressedRateLimit += 1;
  }

  log("info", "commerce.customer_push.enqueued", {
    tenantId,
    moduleKey: "commerce",
    eventType: event.eventType,
    purpose: policy.purpose,
    devices: devices.length,
    enqueued,
    duplicates,
    suppressedRateLimit,
    correlationId: options.correlationId
  });

  return {
    kind: "processed",
    purpose: policy.purpose,
    devices: devices.length,
    enqueued,
    duplicates,
    suppressedRateLimit
  };
}
