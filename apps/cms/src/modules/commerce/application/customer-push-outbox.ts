/**
 * The thin customer-push outbox repository (Issue #430, ADR-0048 option C).
 *
 * Scope of #430: the table (`sql/1057`) and exactly the operations the device
 * lifecycle and the next issue need to plug into. The domain-event consumer
 * (`customer-push-enqueue.ts`, which decides WHAT to send) and the
 * claim/send/finalize loop (`customer-push-dispatch.ts`) are #432; they call
 * `enqueueCustomerPushMessage`, the cap helpers and
 * {@link expireOverdueCustomerPushMessages} here.
 *
 * Every function takes an already-open transaction. No function selects a
 * credential: the outbox holds generic template text and a fixed path only
 * (ADR-0048 I6).
 */
import {
  CUSTOMER_PUSH_TARGET_PATHS,
  evaluateNotificationCap,
  notificationWindowStarts,
  type CustomerPushErrorCode,
  type CustomerPushPurpose,
  type NotificationCapDecision
} from "../domain/customer-push";

type IdRow = { id: string };

/**
 * Cancels what is still WAITING for the given devices (ADR-0048 5.2 step 8, 5.3):
 * a queued or retry_wait message is addressed to whoever owned the device when it
 * was enqueued, and delivering it after a transfer, revoke, logout or block would
 * reach somebody else. A `sending` row is in flight and is not touched here: the
 * dispatcher's send-time recipient check (I5) refuses it. Fixed `last_error`
 * codes only. Returns how many messages were cancelled.
 */
export async function cancelPendingMessagesForDevices(
  tx: Bun.SQL,
  tenantId: string,
  deviceIds: readonly string[],
  reason: CustomerPushErrorCode
): Promise<number> {
  if (deviceIds.length === 0) return 0;

  const rows = (await tx`
    UPDATE awcms_commerce_push_messages
    SET status = 'cancelled', last_error = ${reason}, next_attempt_at = NULL,
        updated_at = now()
    WHERE tenant_id = ${tenantId}
      AND status IN ('queued', 'retry_wait')
      AND device_id = ANY(${tx.array([...deviceIds], "uuid")}::uuid[])
    RETURNING id
  `) as IdRow[];

  return rows.length;
}

/**
 * Serialises the cap check and the insert of ONE account's notifications. A
 * transaction-scoped advisory lock, not a row lock on the account: the consumer
 * runs as `awcms_worker`, which has no UPDATE on accounts and so cannot take
 * `FOR UPDATE` on one (and should not be granted it for this).
 */
async function lockAccountNotificationCap(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`commerce.customer_push.cap:${tenantId}:${accountId}`}, 0)
    )
  `;
}

/**
 * NOTIFICATIONS of the account created in each rolling window that still count
 * against the cap. A notification is one source EVENT, so an event fanned out to
 * three devices counts once (ADR-0048 section 5.4: "12 per rolling hour" is what
 * the customer receives, not how many browsers they own). A cancelled or expired
 * row never reached anybody and does not count.
 */
export async function countRecentMessagesForAccount(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  now: Date = new Date()
): Promise<{ lastHour: number; lastDay: number }> {
  const { hourStart, dayStart } = notificationWindowStarts(now);

  const rows = (await tx`
    SELECT
      count(DISTINCT source_event_id)
        FILTER (WHERE created_at >= ${hourStart})::int AS last_hour,
      count(DISTINCT source_event_id)::int AS last_day
    FROM awcms_commerce_push_messages
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
      AND created_at >= ${dayStart}
      AND status NOT IN ('cancelled', 'expired')
  `) as { last_hour: number; last_day: number }[];

  return {
    lastHour: rows[0]?.last_hour ?? 0,
    lastDay: rows[0]?.last_day ?? 0
  };
}

/** Whether this event already counts for the account (an earlier device of the same event was enqueued): its later devices ride on that slot. */
async function eventAlreadyCounted(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  sourceEventId: string,
  now: Date
): Promise<boolean> {
  const { dayStart } = notificationWindowStarts(now);

  const rows = (await tx`
    SELECT 1 AS present
    FROM awcms_commerce_push_messages
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
      AND source_event_id = ${sourceEventId}
      AND created_at >= ${dayStart}
      AND status NOT IN ('cancelled', 'expired')
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}

export type EnqueueCustomerPushInput = {
  tenantId: string;
  accountId: string;
  deviceId: string;
  /** Opaque id of the domain event; no FK (event retention differs). */
  sourceEventId: string;
  eventType: string;
  purpose: CustomerPushPurpose;
  priority: "low" | "normal" | "high";
  /** The coalescing tag (the purpose family). */
  tag: string;
  /** Generic rendered template text; never order data. */
  title: string;
  body: string;
  expiresAt: Date;
};

export type EnqueueCustomerPushOutcome =
  | { kind: "enqueued"; messageId: string }
  | { kind: "duplicate" }
  | {
      kind: "suppressed";
      reason: Extract<NotificationCapDecision, { allowed: false }>["reason"];
    };

/**
 * Inserts one message for one device, once per (event, device): the dedupe key is
 * the event id and the device id, `ON CONFLICT DO NOTHING` (ADR-0048 I7). The
 * per-account cap is checked under an advisory lock on the account so two
 * concurrent consumers cannot both pass it. The click target is the FIXED path of the
 * purpose, never an argument. Over the cap: nothing is inserted and the caller
 * counts `suppressed_rate_limit`.
 */
export async function enqueueCustomerPushMessage(
  tx: Bun.SQL,
  input: EnqueueCustomerPushInput,
  now: Date = new Date()
): Promise<EnqueueCustomerPushOutcome> {
  await lockAccountNotificationCap(tx, input.tenantId, input.accountId);

  // A later device of an event that already holds a slot never trips the cap on
  // its own: the cap limits notifications, and the event is one of them.
  if (
    !(await eventAlreadyCounted(
      tx,
      input.tenantId,
      input.accountId,
      input.sourceEventId,
      now
    ))
  ) {
    const decision = evaluateNotificationCap(
      await countRecentMessagesForAccount(
        tx,
        input.tenantId,
        input.accountId,
        now
      )
    );
    if (!decision.allowed) {
      return { kind: "suppressed", reason: decision.reason };
    }
  }

  const dedupeKey = `${input.sourceEventId}:${input.deviceId}`;

  const rows = (await tx`
    INSERT INTO awcms_commerce_push_messages
      (tenant_id, account_id, device_id, source_event_id, event_type, purpose,
       priority, tag, dedupe_key, title, body, target_path, expires_at)
    VALUES (
      ${input.tenantId}, ${input.accountId}, ${input.deviceId},
      ${input.sourceEventId}, ${input.eventType}, ${input.purpose},
      ${input.priority}, ${input.tag}, ${dedupeKey}, ${input.title},
      ${input.body}, ${CUSTOMER_PUSH_TARGET_PATHS[input.purpose]},
      ${input.expiresAt}
    )
    ON CONFLICT ON CONSTRAINT awcms_commerce_push_messages_dedupe_key
    DO NOTHING
    RETURNING id
  `) as IdRow[];

  const row = rows[0];
  return row ? { kind: "enqueued", messageId: row.id } : { kind: "duplicate" };
}

/**
 * Moves what is still waiting past its `expires_at` to `expired` (ADR-0048 5.5:
 * "after this a queued message is expired, never sent late"). Called by the
 * dispatcher before it claims and by the maintenance job, which runs even when
 * the feature is off, so a message queued before the kill switch does not sit in
 * `queued` forever. A `sending` row whose lease has lapsed is included: its
 * worker is gone, and it is no longer sendable. Bounded; fixed `last_error`.
 * Returns how many rows moved.
 */
export async function expireOverdueCustomerPushMessages(
  tx: Bun.SQL,
  tenantId: string,
  now: Date,
  limit: number
): Promise<number> {
  const rows = (await tx`
    UPDATE awcms_commerce_push_messages
    SET status = 'expired', last_error = 'expired', next_attempt_at = NULL,
        updated_at = now()
    WHERE id IN (
      SELECT id FROM awcms_commerce_push_messages
      WHERE tenant_id = ${tenantId}
        AND expires_at <= ${now}
        AND (
          status IN ('queued', 'retry_wait')
          OR (status = 'sending' AND next_attempt_at <= ${now})
        )
      ORDER BY expires_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `) as IdRow[];

  return rows.length;
}
