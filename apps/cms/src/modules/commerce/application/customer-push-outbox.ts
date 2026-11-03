/**
 * The thin customer-push outbox repository (Issue #430, ADR-0048 option C).
 *
 * Scope of #430: the table (`sql/1057`) and exactly the operations the device
 * lifecycle and the next issue need to plug into. The domain-event consumers
 * (which decide WHAT to send), the claim/send/finalize loop and the dispatch
 * job are #432; they call `enqueueCustomerPushMessage` and the cap helpers here
 * and add the dispatch functions beside them. Nothing in #430 enqueues a
 * message; the only writer in #430 is {@link cancelPendingMessagesForDevices}.
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

/** Messages of the account created in each rolling window that still count against the cap (a cancelled or expired row never reached anybody). */
export async function countRecentMessagesForAccount(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  now: Date = new Date()
): Promise<{ lastHour: number; lastDay: number }> {
  const { hourStart, dayStart } = notificationWindowStarts(now);

  const rows = (await tx`
    SELECT
      count(*) FILTER (WHERE created_at >= ${hourStart})::int AS last_hour,
      count(*)::int AS last_day
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
 * per-account cap is checked under a lock on the account row so two concurrent
 * consumers cannot both pass it. The click target is the FIXED path of the
 * purpose, never an argument. Over the cap: nothing is inserted and the caller
 * counts `suppressed_rate_limit`.
 */
export async function enqueueCustomerPushMessage(
  tx: Bun.SQL,
  input: EnqueueCustomerPushInput,
  now: Date = new Date()
): Promise<EnqueueCustomerPushOutcome> {
  await tx`
    SELECT id FROM awcms_commerce_customer_accounts
    WHERE tenant_id = ${input.tenantId} AND id = ${input.accountId}
    FOR NO KEY UPDATE
  `;

  const decision = evaluateNotificationCap(
    await countRecentMessagesForAccount(
      tx,
      input.tenantId,
      input.accountId,
      now
    )
  );
  if (!decision.allowed) return { kind: "suppressed", reason: decision.reason };

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
