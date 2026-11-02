/**
 * The customer Web Push dispatcher (Issue #432, ADR-0048 sections 5.5 and 5.6).
 * NOT a public HTTP endpoint: the trusted internal worker boundary every
 * dispatcher in this repo keeps. Invoked by `scripts/commerce-customer-push-
 * dispatch.ts`, one tenant at a time, as `awcms_worker` (sql/1058, sql/1061).
 *
 * ## Three phases, never a provider call inside a transaction (ADR-0006)
 *
 *  1. CLAIM - one short transaction flips due `queued` / `retry_wait` rows (and a
 *     `sending` row whose lease lapsed) to `sending` with `FOR UPDATE SKIP
 *     LOCKED`; `next_attempt_at` is the lease, so a worker that died mid-flight
 *     does not strand a row.
 *  2. PREPARE + SEND, per message - a short transaction takes the row lock,
 *     checks the lease is still ours, re-checks ELIGIBILITY (ADR-0048 5.5: a
 *     revoked device, a withdrawn preference, a blocked account or a logged-out
 *     session cancels the message with no provider call), applies the send-side
 *     cap and reads the credential row; the credentials are decrypted AFTER the
 *     transaction closes, then the upstream Web Push provider is called with no
 *     transaction open.
 *  3. FINALIZE - one transaction per message records the attempt and moves the
 *     row: `sent` (the push service accepted it - never "delivered"), `retry_wait`
 *     with exponential backoff, `failed`, or, on a 404/410, the device becomes
 *     `gone` and its waiting messages are cancelled.
 *
 * ## What "idempotent" means here, honestly
 *
 * Re-running the job sends nothing twice: a `sent` row is terminal, a `sending`
 * row is invisible to a claim until its lease lapses, the finalize is guarded by
 * `status = 'sending'`, and the enqueue is unique per (event, device). The one
 * window no design closes against an external HTTP service is a crash AFTER the
 * push service accepted a request and BEFORE the finalize commits: the lease
 * lapses and the row is sent again (ADR-0048 T14: provider attempts are
 * at-least-once; one duplicate banner is possible and documented). The `tag`
 * makes the repeat REPLACE the first banner instead of stacking, and a lost lease
 * is detected so a slow worker cannot send a row a faster one already took.
 *
 * ## Kill switches (claims nothing)
 *
 * `PUSH_ENABLED` not `true`, no VAPID pair or key ring, the `commerce` module
 * disabled for the tenant, or the tenant's `customerPush` feature off: the pass
 * claims nothing and calls no provider, so a switched-off deployment can never
 * leave rows in `sending` limbo.
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import {
  FieldEncryptionError,
  type KeyRing
} from "../../../lib/security/field-encryption";
import { log } from "../../../lib/logging/logger";
import { fetchTenantModuleEntry } from "../../module-management/application/tenant-module-lifecycle";
import {
  PUSH_CIRCUIT_BREAKER_KEY,
  isPushEnabled,
  resolvePushSendMaxRetries
} from "../../push-delivery/domain/push-config";
import { evaluatePushRetry } from "../../push-delivery/domain/push-retry";
import type { PushHttpClient } from "../../push-delivery/infrastructure/push-http-client";
import type { PushProvider } from "../../push-delivery/domain/push-provider-contract";
import {
  CUSTOMER_PUSH_DAY_MS,
  type CustomerPushErrorCode
} from "../domain/customer-push";
import {
  buildCustomerPushProviderMessage,
  classifyProviderResult,
  evaluateSendCap,
  evaluateSendEligibility,
  resolveProviderTtlSeconds,
  urgencyForPriority,
  type CustomerPushPriority,
  type CustomerPushProviderMessage,
  type SendEligibilityFacts,
  type SentNotification
} from "../domain/customer-push-policy";
import {
  createCustomerPushProviderFactory,
  type CustomerPushProviderFactory
} from "../infrastructure/customer-push-provider";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import {
  auditRevocation,
  buildCustomerPushDeliveryTarget,
  readCustomerPushCredentialRow,
  tombstoneCustomerPushDevices,
  type CustomerPushCredentialRow
} from "./customer-push-devices";
import {
  loadActiveDomainHostnames,
  resolveAdminOrigin
} from "./customer-push-facts";
import { expireOverdueCustomerPushMessages } from "./customer-push-outbox";
import { resolvePushAvailability } from "./customer-push-capability";

const MODULE_KEY = "commerce";
const PROVIDER_NAME = "web_push";

/** Messages claimed per pass and tenant ("bounded batch"); the script loops a bounded number of passes. */
export const CUSTOMER_PUSH_DISPATCH_DEFAULT_LIMIT = 25;
/** The lease written at claim: long enough to reach the last message of a batch behind a slow push service. */
export const CUSTOMER_PUSH_CLAIM_LEASE_MS = 5 * 60 * 1000;
/** The lease renewed right before a send: a few request timeouts. */
export const CUSTOMER_PUSH_SEND_LEASE_MS = 2 * 60 * 1000;
/** A release because the breaker is open retries after this long. */
export const CUSTOMER_PUSH_BREAKER_RELEASE_MS = 60 * 1000;
/** Expiry sweep batch inside a dispatch pass. */
const EXPIRY_SWEEP_LIMIT = 200;

export type CustomerPushDispatchGate =
  "push_disabled" | "push_not_configured" | "module_disabled" | "feature_off";

export type DispatchCustomerPushOptions = {
  limit?: number;
  /** Pins the clock (tests). Production reads the real clock for every decision. */
  now?: Date;
  env?: NodeJS.ProcessEnv;
  correlationId?: string;
  /** Test seam: the outbound HTTP client of the upstream provider (default: the SSRF-guarded one). */
  http?: PushHttpClient;
  /** Test seam: replaces the upstream-provider factory. */
  providerFactory?: CustomerPushProviderFactory;
  /**
   * Test seam: runs between the claim and the first send, so a test can play the
   * part of a second worker (let a lease lapse, settle a row) at the one moment
   * the lease checks exist for. Never set in production.
   */
  afterClaim?: (claimedIds: readonly string[]) => Promise<void>;
};

export type DispatchCustomerPushResult = {
  /** Rows claimed (the bounded-pass loop stops at 0). */
  claimed: number;
  /** Provider ACCEPTED the request. Never "delivered". */
  sent: number;
  retried: number;
  failed: number;
  /** The push service said 404/410: the device was set to `gone`. */
  gone: number;
  /** Send-time eligibility cancelled the message with no provider call. */
  cancelled: number;
  expired: number;
  /** Deferred by the send-side cap (hourly/daily) to when the window frees. */
  deferred: number;
  /** Released unsent because the circuit breaker opened. */
  released: number;
  /** The lease was no longer ours; another worker owns the row. */
  leaseLost: number;
  breakerOpen: boolean;
  /** Set when a kill switch held the whole pass: nothing was claimed. */
  gated: CustomerPushDispatchGate | null;
  count: number;
};

function emptyResult(): DispatchCustomerPushResult {
  return {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    gone: 0,
    cancelled: 0,
    expired: 0,
    deferred: 0,
    released: 0,
    leaseLost: 0,
    breakerOpen: false,
    gated: null,
    count: 0
  };
}

type Claimed = { id: string; retryCount: number };

async function claim(
  sql: Bun.SQL,
  tenantId: string,
  now: Date,
  limit: number
): Promise<Claimed[]> {
  const lease = new Date(now.getTime() + CUSTOMER_PUSH_CLAIM_LEASE_MS);

  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      // `MATERIALIZED` is load-bearing (upstream Issue #1007): an inlined
      // locking sub-select can be re-run per outer row and claim more than
      // `limit`.
      const rows = (await tx`
        WITH due AS MATERIALIZED (
          SELECT id FROM awcms_commerce_push_messages
          WHERE tenant_id = ${tenantId}
            AND expires_at > ${now}
            AND (
              (status IN ('queued', 'retry_wait')
                AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}))
              OR (status = 'sending' AND next_attempt_at <= ${now})
            )
          ORDER BY
            CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
            created_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE awcms_commerce_push_messages AS m
        SET status = 'sending', next_attempt_at = ${lease}, updated_at = now()
        FROM due
        WHERE m.id = due.id
        RETURNING m.id, m.retry_count, m.priority, m.created_at
      `) as {
        id: string;
        retry_count: number;
        priority: string;
        created_at: Date;
      }[];

      // `UPDATE ... RETURNING` makes no promise about row order, so the batch is
      // sorted here: the claim's ORDER BY decides WHICH rows fit in the batch,
      // this decides which of them is sent first (a payment before a courtesy).
      const rank = (priority: string) =>
        priority === "high" ? 0 : priority === "normal" ? 1 : 2;

      return rows
        .sort(
          (a, b) =>
            rank(a.priority) - rank(b.priority) ||
            a.created_at.getTime() - b.created_at.getTime() ||
            a.id.localeCompare(b.id)
        )
        .map((row) => ({ id: row.id, retryCount: Number(row.retry_count) }));
    },
    { workClass: "background_sync" }
  );
}

type FactsRow = {
  id: string;
  status: string;
  next_attempt_at: Date | null;
  account_id: string;
  device_id: string;
  source_event_id: string;
  purpose: string;
  priority: string;
  tag: string;
  title: string;
  body: string;
  target_path: string;
  expires_at: Date;
  device_present: boolean;
  device_status: string | null;
  device_account_id: string | null;
  storefront_origin: string | null;
  session_present: boolean;
  session_revoked_at: Date | null;
  session_expires_at: Date | null;
  account_present: boolean;
  account_status: string | null;
  email_verified_at: Date | null;
  account_deleted_at: Date | null;
  customer_status: string | null;
  pref_enabled: boolean | null;
  pref_version: string | null;
};

/** Everything section 5.5 needs, in ONE statement, with the message row locked. */
async function loadSendFacts(
  tx: Bun.SQL,
  tenantId: string,
  messageId: string
): Promise<FactsRow | null> {
  const rows = (await tx`
    SELECT
      m.id, m.status, m.next_attempt_at, m.account_id, m.device_id,
      m.source_event_id, m.purpose, m.priority, m.tag, m.title, m.body,
      m.target_path, m.expires_at,
      (d.id IS NOT NULL) AS device_present,
      d.status AS device_status, d.account_id AS device_account_id,
      d.storefront_origin,
      (s.id IS NOT NULL) AS session_present,
      s.revoked_at AS session_revoked_at, s.expires_at AS session_expires_at,
      (a.id IS NOT NULL) AS account_present,
      a.status AS account_status, a.email_verified_at,
      a.deleted_at AS account_deleted_at,
      c.status AS customer_status,
      p.enabled AS pref_enabled, p.consent_text_version AS pref_version
    FROM awcms_commerce_push_messages m
    LEFT JOIN awcms_commerce_push_devices d
      ON d.tenant_id = m.tenant_id AND d.id = m.device_id
    LEFT JOIN awcms_commerce_customer_sessions s
      ON s.tenant_id = d.tenant_id AND s.id = d.session_id
    LEFT JOIN awcms_commerce_customer_accounts a
      ON a.tenant_id = m.tenant_id AND a.id = m.account_id
    LEFT JOIN awcms_commerce_customers c
      ON c.tenant_id = a.tenant_id AND c.id = a.customer_id
    LEFT JOIN awcms_commerce_push_preferences p
      ON p.tenant_id = m.tenant_id AND p.account_id = m.account_id
      AND p.purpose = m.purpose
    WHERE m.tenant_id = ${tenantId} AND m.id = ${messageId}
    FOR UPDATE OF m
  `) as FactsRow[];

  return rows[0] ?? null;
}

function toEligibilityFacts(
  row: FactsRow,
  domainHostnames: ReadonlySet<string>,
  adminOrigin: string | null
): SendEligibilityFacts {
  return {
    message: {
      accountId: row.account_id,
      purpose: row.purpose,
      title: row.title,
      body: row.body,
      targetPath: row.target_path,
      tag: row.tag,
      expiresAt: row.expires_at
    },
    device: row.device_present
      ? {
          status: row.device_status ?? "",
          accountId: row.device_account_id ?? "",
          storefrontOrigin: row.storefront_origin ?? ""
        }
      : null,
    session: row.session_present
      ? {
          revokedAt: row.session_revoked_at,
          expiresAt: row.session_expires_at ?? new Date(0)
        }
      : null,
    account: row.account_present
      ? {
          status: row.account_status ?? "",
          emailVerifiedAt: row.email_verified_at,
          deletedAt: row.account_deleted_at
        }
      : null,
    customerStatus: row.customer_status,
    preference:
      row.pref_enabled === null || row.pref_version === null
        ? null
        : { enabled: row.pref_enabled, consentTextVersion: row.pref_version },
    domainHostnames,
    adminOrigin
  };
}

/** Notifications whose first send was accepted in the last day, one entry per source event. */
async function loadSentNotifications(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  now: Date
): Promise<SentNotification[]> {
  const dayStart = new Date(now.getTime() - CUSTOMER_PUSH_DAY_MS);
  // A message accepted in the last day was created at most a TTL (12 h) plus its
  // retries earlier; two days is a safe floor that keeps the account-window
  // index range-bounded.
  const createdFloor = new Date(now.getTime() - 2 * CUSTOMER_PUSH_DAY_MS);

  const rows = (await tx`
    SELECT source_event_id, min(sent_at) AS first_sent_at
    FROM awcms_commerce_push_messages
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
      AND status = 'sent' AND sent_at >= ${dayStart}
      AND created_at >= ${createdFloor}
    GROUP BY source_event_id
  `) as { source_event_id: string; first_sent_at: Date }[];

  return rows.map((row) => ({
    eventId: row.source_event_id,
    firstSentAt: row.first_sent_at
  }));
}

type Prepared =
  | { kind: "lease_lost" }
  | { kind: "cancelled" | "expired" | "deferred" }
  | {
      kind: "ready";
      credential: CustomerPushCredentialRow;
      message: CustomerPushProviderMessage;
      priority: CustomerPushPriority;
      expiresAt: Date;
    };

async function finishWithoutSend(
  tx: Bun.SQL,
  tenantId: string,
  messageId: string,
  status: "cancelled" | "expired",
  error: CustomerPushErrorCode
): Promise<void> {
  await tx`
    UPDATE awcms_commerce_push_messages
    SET status = ${status}, last_error = ${error}, next_attempt_at = NULL,
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${messageId} AND status = 'sending'
  `;
}

/**
 * The short transaction before a send. Everything that can make the message
 * unsendable is decided here, under the row lock, so a decision and the state it
 * rests on cannot drift apart.
 */
async function prepareSend(
  sql: Bun.SQL,
  tenantId: string,
  messageId: string,
  now: Date,
  adminOrigin: string | null,
  correlationId: string
): Promise<Prepared> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx): Promise<Prepared> => {
      const row = await loadSendFacts(tx, tenantId, messageId);

      // Still ours? A worker that was slow enough for the lease to lapse must not
      // send a row another claim may already hold.
      if (
        !row ||
        row.status !== "sending" ||
        row.next_attempt_at === null ||
        row.next_attempt_at.getTime() <= now.getTime()
      ) {
        return { kind: "lease_lost" };
      }

      const domains = await loadActiveDomainHostnames(tx, tenantId);
      const verdict = evaluateSendEligibility(
        toEligibilityFacts(row, domains, adminOrigin),
        now
      );

      if (!verdict.eligible) {
        await finishWithoutSend(
          tx,
          tenantId,
          messageId,
          verdict.outcome === "expire" ? "expired" : "cancelled",
          verdict.error
        );

        if (verdict.tombstone && row.device_present) {
          const ids = await tombstoneCustomerPushDevices(
            tx,
            tenantId,
            [row.device_id],
            verdict.tombstone.status,
            verdict.tombstone.reason,
            verdict.error,
            now
          );
          await auditRevocation(
            tx,
            tenantId,
            row.account_id,
            ids,
            verdict.tombstone.reason,
            correlationId
          );
        }

        return { kind: verdict.outcome === "expire" ? "expired" : "cancelled" };
      }

      // The send-side cap (12 per hour, 40 per day): defer, never drop.
      const cap = evaluateSendCap(
        await loadSentNotifications(tx, tenantId, row.account_id, now),
        row.source_event_id,
        now
      );
      if (!cap.allowed) {
        await tx`
          UPDATE awcms_commerce_push_messages
          SET status = 'retry_wait', next_attempt_at = ${cap.retryAt},
              last_error = 'rate_limited', updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${messageId}
            AND status = 'sending'
        `;
        return { kind: "deferred" };
      }

      const credential = await readCustomerPushCredentialRow(
        tx,
        tenantId,
        row.device_id
      );
      if (!credential) {
        // Eligible a moment ago, gone now (a concurrent revoke): same outcome as
        // the device check above.
        await finishWithoutSend(
          tx,
          tenantId,
          messageId,
          "cancelled",
          "device_revoked"
        );
        return { kind: "cancelled" };
      }

      // Renew the lease for the duration of the send.
      await tx`
        UPDATE awcms_commerce_push_messages
        SET next_attempt_at = ${new Date(now.getTime() + CUSTOMER_PUSH_SEND_LEASE_MS)},
            updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${messageId}
          AND status = 'sending'
      `;

      // Eligibility already proved the row is catalogue text on the purpose's
      // fixed path; this is the same builder, so what is sent is exactly that.
      const message = buildCustomerPushProviderMessage({
        purpose: row.purpose,
        title: row.title,
        body: row.body,
        targetPath: row.target_path,
        tag: row.tag
      });
      if (message === null) {
        await finishWithoutSend(
          tx,
          tenantId,
          messageId,
          "cancelled",
          "not_eligible"
        );
        return { kind: "cancelled" };
      }

      return {
        kind: "ready",
        credential,
        message,
        priority: row.priority as CustomerPushPriority,
        expiresAt: row.expires_at
      };
    },
    { workClass: "background_sync" }
  );
}

type FinalOutcome =
  | { kind: "accepted" }
  | { kind: "gone"; snippet: string }
  | { kind: "retry"; snippet: string | null; error: CustomerPushErrorCode }
  | { kind: "permanent"; snippet: string | null; error: CustomerPushErrorCode };

type FinalizeResult = "sent" | "gone" | "retried" | "failed" | "lease_lost";

/**
 * One transaction: the attempt row (idempotent on `(message, attempt_no)`, which
 * an expired-lease re-claim needs) and the status move, guarded by `status =
 * 'sending'` so a row another worker already settled is left alone.
 */
async function finalize(
  sql: Bun.SQL,
  tenantId: string,
  messageId: string,
  deviceId: string,
  accountId: string,
  retryCount: number,
  outcome: FinalOutcome,
  now: Date,
  maxRetries: number,
  correlationId: string
): Promise<FinalizeResult> {
  const attemptNo = retryCount + 1;

  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx): Promise<FinalizeResult> => {
      const attemptOutcome =
        outcome.kind === "accepted" ? "success" : "failure";
      const attemptError =
        outcome.kind === "accepted"
          ? null
          : outcome.kind === "gone"
            ? "endpoint_gone"
            : outcome.error;
      const snippet =
        outcome.kind === "accepted" ? null : (outcome.snippet ?? null);

      await tx`
        INSERT INTO awcms_commerce_push_delivery_attempts
          (tenant_id, message_id, attempt_no, outcome, provider_name,
           provider_response_snippet, error_message)
        VALUES (${tenantId}, ${messageId}, ${attemptNo}, ${attemptOutcome},
                ${PROVIDER_NAME}, ${snippet}, ${attemptError})
        ON CONFLICT ON CONSTRAINT awcms_commerce_push_delivery_attempts_unique_attempt
        DO NOTHING
      `;

      if (outcome.kind === "accepted") {
        const moved = (await tx`
          UPDATE awcms_commerce_push_messages
          SET status = 'sent', sent_at = ${now}, next_attempt_at = NULL,
              last_error = NULL, provider_name = ${PROVIDER_NAME},
              updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${messageId}
            AND status = 'sending'
          RETURNING id
        `) as unknown[];
        if (moved.length === 0) return "lease_lost";

        await tx`
          UPDATE awcms_commerce_push_devices
          SET last_success_at = ${now}, failure_count = 0, updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${deviceId}
            AND status = 'active'
        `;
        return "sent";
      }

      if (outcome.kind === "gone") {
        const moved = (await tx`
          UPDATE awcms_commerce_push_messages
          SET status = 'cancelled', last_error = 'endpoint_gone',
              next_attempt_at = NULL, updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${messageId}
            AND status = 'sending'
          RETURNING id
        `) as unknown[];

        // The device is dead whatever happened to this row: out of every future
        // fan-out, credentials destroyed, its other waiting messages cancelled.
        const ids = await tombstoneCustomerPushDevices(
          tx,
          tenantId,
          [deviceId],
          "gone",
          "endpoint_gone",
          "endpoint_gone",
          now
        );
        await auditRevocation(
          tx,
          tenantId,
          accountId,
          ids,
          "endpoint_gone",
          correlationId
        );
        return moved.length === 0 ? "lease_lost" : "gone";
      }

      // A failure that leaves the device alive: count it, then back off or stop.
      await tx`
        UPDATE awcms_commerce_push_devices
        SET failure_count = failure_count + 1, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${deviceId}
          AND status = 'active'
      `;

      const retry =
        outcome.kind === "retry"
          ? evaluatePushRetry(retryCount, maxRetries, now)
          : { eligible: false as const };

      if (retry.eligible) {
        const moved = (await tx`
          UPDATE awcms_commerce_push_messages
          SET status = 'retry_wait', retry_count = ${retryCount + 1},
              next_attempt_at = ${retry.nextAttemptAt}, last_error = ${outcome.error},
              updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${messageId}
            AND status = 'sending'
          RETURNING id
        `) as unknown[];
        return moved.length === 0 ? "lease_lost" : "retried";
      }

      const moved = (await tx`
        UPDATE awcms_commerce_push_messages
        SET status = 'failed', retry_count = ${retryCount + 1},
            next_attempt_at = NULL, last_error = ${outcome.error},
            updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${messageId}
          AND status = 'sending'
        RETURNING id
      `) as unknown[];
      return moved.length === 0 ? "lease_lost" : "failed";
    },
    { workClass: "background_sync" }
  );
}

/**
 * The send, with no transaction open. The credentials are decrypted HERE, after
 * the pre-send transaction closed: a ciphertext that cannot be read is neither a
 * database failure nor the push service's, so it must reach neither the database
 * circuit breaker nor the provider's. A missing key is an operator fix (retry); a
 * failed authentication is permanent. No value reaches a log or a row.
 */
async function attemptSend(
  tenantId: string,
  prepared: Extract<Prepared, { kind: "ready" }>,
  ring: KeyRing,
  factory: CustomerPushProviderFactory,
  now: Date,
  correlationId: string
): Promise<FinalOutcome> {
  let target;
  try {
    target = buildCustomerPushDeliveryTarget(
      tenantId,
      prepared.credential,
      ring
    ).target;
  } catch (error) {
    const retryable =
      error instanceof FieldEncryptionError &&
      (error.code === "KEY_RING_UNAVAILABLE" ||
        error.code === "UNKNOWN_KEY_ID");
    return retryable
      ? { kind: "retry", snippet: null, error: "config_unavailable" }
      : { kind: "permanent", snippet: null, error: "config_unavailable" };
  }

  const provider: PushProvider = factory({
    storefrontOrigin: prepared.credential.storefront_origin,
    ttlSeconds: resolveProviderTtlSeconds(prepared.expiresAt, now),
    urgency: urgencyForPriority(prepared.priority)
  });

  const delivery = await provider.send(target, {
    ...prepared.message,
    correlationId
  });

  const classified = classifyProviderResult(delivery);
  switch (classified.kind) {
    case "accepted":
      return { kind: "accepted" };
    case "gone":
      return { kind: "gone", snippet: classified.snippet };
    case "retry":
      return {
        kind: "retry",
        snippet: classified.snippet,
        error: "provider_unavailable"
      };
    case "permanent":
      return {
        kind: "permanent",
        snippet: classified.snippet,
        error: "provider_rejected"
      };
  }
}

/** Gives claimed-but-unsent rows back without an attempt (the breaker opened mid-pass). */
async function releaseUnsent(
  sql: Bun.SQL,
  tenantId: string,
  ids: readonly string[],
  now: Date
): Promise<void> {
  if (ids.length === 0) return;

  await withTenantOrThrow(
    sql,
    tenantId,
    (tx) => tx`
      UPDATE awcms_commerce_push_messages
      SET status = 'retry_wait',
          next_attempt_at = ${new Date(now.getTime() + CUSTOMER_PUSH_BREAKER_RELEASE_MS)},
          last_error = 'provider_unavailable', updated_at = now()
      WHERE tenant_id = ${tenantId} AND status = 'sending'
        AND id = ANY(${tx.array([...ids], "uuid")}::uuid[])
    `,
    { workClass: "background_sync" }
  );
}

async function tenantGate(
  sql: Bun.SQL,
  tenantId: string
): Promise<CustomerPushDispatchGate | null> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const entry = await fetchTenantModuleEntry(tx, tenantId, MODULE_KEY);
      if (!entry?.tenantEnabled) return "module_disabled" as const;
      if (!(await fetchCommerceFeatures(tx, tenantId)).customerPush) {
        return "feature_off" as const;
      }
      return null;
    },
    { workClass: "background_sync" }
  );
}

/**
 * Dispatches one batch of due customer push messages for a single tenant. Safe to
 * call repeatedly (claim lease); the script loops a bounded number of passes.
 */
export async function dispatchCustomerPushForTenant(
  sql: Bun.SQL,
  tenantId: string,
  options: DispatchCustomerPushOptions = {}
): Promise<DispatchCustomerPushResult> {
  const env = options.env ?? process.env;
  const clock = (): Date => options.now ?? new Date();
  const limit = options.limit ?? CUSTOMER_PUSH_DISPATCH_DEFAULT_LIMIT;
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const result = emptyResult();

  // Kill switches first: nothing is claimed, so nothing can strand in `sending`.
  if (!isPushEnabled(env)) return { ...result, gated: "push_disabled" };

  const availability = resolvePushAvailability(env);
  const factory =
    options.providerFactory ??
    createCustomerPushProviderFactory({ env, http: options.http });
  if (!availability.ok || factory === null) {
    return { ...result, gated: "push_not_configured" };
  }
  const ring: KeyRing = availability.ring;

  const gate = await tenantGate(sql, tenantId);
  if (gate !== null) return { ...result, gated: gate };

  const breaker = getProviderCircuitBreaker(PUSH_CIRCUIT_BREAKER_KEY);
  if (!breaker.canAttempt(clock())) {
    log("warning", "commerce.customer_push.dispatch.breaker_open", {
      tenantId,
      moduleKey: MODULE_KEY,
      correlationId
    });
    return { ...result, breakerOpen: true };
  }

  // Never send late: whatever waited past its TTL is expired before the claim.
  result.expired += await withTenantOrThrow(
    sql,
    tenantId,
    (tx) =>
      expireOverdueCustomerPushMessages(
        tx,
        tenantId,
        clock(),
        EXPIRY_SWEEP_LIMIT
      ),
    { workClass: "background_sync" }
  );

  const claimed = await claim(sql, tenantId, clock(), limit);
  result.claimed = claimed.length;
  result.count = claimed.length;
  if (claimed.length === 0) return result;

  await options.afterClaim?.(claimed.map((entry) => entry.id));

  const maxRetries = resolvePushSendMaxRetries(env);
  const adminOrigin = resolveAdminOrigin(env);

  for (let index = 0; index < claimed.length; index += 1) {
    const entry = claimed[index]!;
    const now = clock();

    // A breaker that opened during this pass (a push service is failing) stops
    // the pass; the rest go back, unattempted, to be retried shortly.
    if (!breaker.canAttempt(now)) {
      result.breakerOpen = true;
      const remaining = claimed.slice(index).map((item) => item.id);
      await releaseUnsent(sql, tenantId, remaining, now);
      result.released += remaining.length;
      break;
    }

    const prepared = await prepareSend(
      sql,
      tenantId,
      entry.id,
      now,
      adminOrigin,
      correlationId
    );

    if (prepared.kind !== "ready") {
      if (prepared.kind === "lease_lost") result.leaseLost += 1;
      else if (prepared.kind === "cancelled") result.cancelled += 1;
      else if (prepared.kind === "expired") result.expired += 1;
      else result.deferred += 1;
      continue;
    }

    const { credential } = prepared;
    const outcome = await attemptSend(
      tenantId,
      prepared,
      ring,
      factory,
      now,
      correlationId
    );

    const settled = await finalize(
      sql,
      tenantId,
      entry.id,
      credential.id,
      credential.account_id,
      entry.retryCount,
      outcome,
      clock(),
      maxRetries,
      correlationId
    );

    if (settled === "sent") result.sent += 1;
    else if (settled === "gone") result.gone += 1;
    else if (settled === "retried") result.retried += 1;
    else if (settled === "failed") result.failed += 1;
    else result.leaseLost += 1;
  }

  log("info", "commerce.customer_push.dispatch.pass_completed", {
    tenantId,
    moduleKey: MODULE_KEY,
    correlationId,
    claimed: result.claimed,
    sent: result.sent,
    retried: result.retried,
    failed: result.failed,
    gone: result.gone,
    cancelled: result.cancelled,
    expired: result.expired,
    deferred: result.deferred,
    released: result.released,
    leaseLost: result.leaseLost,
    breakerOpen: result.breakerOpen
  });

  return result;
}
