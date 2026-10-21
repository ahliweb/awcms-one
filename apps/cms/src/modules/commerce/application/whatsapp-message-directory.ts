/**
 * Admin/diagnostics read over `awcms_commerce_whatsapp_messages` (Issue
 * #108) — `GET /api/v1/commerce/whatsapp/messages`
 * (`commerce.whatsapp.read`) and its admin screen section
 * (`src/pages/admin/commerce-whatsapp.astro`). Read-only: this issue ships
 * no cancel/retry admin action over the outbox. Mirrors `email/application/
 * email-message-directory.ts`'s keyset-pagination shape. Never selects
 * `to_phone` — only `to_phone_masked` (`awcms-sensitive-data`).
 */
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";

import {
  LEGACY_TERMINAL_STATUSES,
  buildQueueDrain,
  type QueueDrain
} from "../domain/whatsapp-cutover";

export const WHATSAPP_MESSAGE_LIST_LIMIT = 100;

export type WhatsappMessageStatus = "queued" | "sending" | "sent" | "failed";

export type WhatsappMessageEntry = {
  id: string;
  correlationId: string | null;
  templateKey: string;
  status: WhatsappMessageStatus;
  toPhoneMasked: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
};

type WhatsappMessageRow = {
  id: string;
  correlation_id: string | null;
  template_key: string;
  status: WhatsappMessageStatus;
  to_phone_masked: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  created_at_cursor: string;
  sent_at: Date | null;
};

export type WhatsappMessageListPage = {
  messages: WhatsappMessageEntry[];
  nextCursor: string | null;
};

function toView(row: WhatsappMessageRow): WhatsappMessageEntry {
  return {
    id: row.id,
    correlationId: row.correlation_id,
    templateKey: row.template_key,
    status: row.status,
    toPhoneMasked: row.to_phone_masked,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    sentAt: row.sent_at?.toISOString() ?? null
  };
}

/** One keyset-paginated page of WhatsApp messages, newest first — same full-precision-cursor reasoning `email-message-directory.ts` documents (Issue #158). */
export async function fetchWhatsappMessageEntries(
  tx: Bun.SQL,
  tenantId: string,
  statusFilter?: WhatsappMessageStatus,
  cursor?: KeysetCursor
): Promise<WhatsappMessageListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (
    statusFilter
      ? await tx`
        SELECT id, correlation_id, template_key, status, to_phone_masked,
               attempts, last_error, created_at,
               ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor,
               sent_at
        FROM awcms_commerce_whatsapp_messages
        WHERE tenant_id = ${tenantId} AND status = ${statusFilter}
          AND (
            ${cursorCreatedAt}::timestamptz IS NULL
            OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ${WHATSAPP_MESSAGE_LIST_LIMIT}
      `
      : await tx`
        SELECT id, correlation_id, template_key, status, to_phone_masked,
               attempts, last_error, created_at,
               ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor,
               sent_at
        FROM awcms_commerce_whatsapp_messages
        WHERE tenant_id = ${tenantId}
          AND (
            ${cursorCreatedAt}::timestamptz IS NULL
            OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ${WHATSAPP_MESSAGE_LIST_LIMIT}
      `
  ) as WhatsappMessageRow[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === WHATSAPP_MESSAGE_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { messages: rows.map(toView), nextCursor };
}

/**
 * The live outbox state of the legacy messages whose `correlation_id` is one of
 * `correlationIds` (Issue #295's document-delivery history, moved here by Issue
 * #392 so that `document-delivery-directory.ts` no longer names the legacy table:
 * the history reads the legacy queue through this function and the `upstream`
 * queue through `whatsapp-upstream-status.ts`). The statement is the one the
 * history has always run. Never written.
 */
export async function readLegacyWhatsappStatesByCorrelation(
  tx: Bun.SQL,
  tenantId: string,
  correlationIds: readonly string[]
): Promise<
  Map<
    string,
    {
      status: string;
      providerMessageId: string | null;
      retryCount: number;
      lastError: string | null;
      sentAt: string | null;
    }
  >
> {
  const result = new Map<
    string,
    {
      status: string;
      providerMessageId: string | null;
      retryCount: number;
      lastError: string | null;
      sentAt: string | null;
    }
  >();

  if (correlationIds.length === 0) return result;

  const found = (await tx`
      SELECT correlation_id, status, provider_ref, attempts, last_error, sent_at
      FROM awcms_commerce_whatsapp_messages
      WHERE tenant_id = ${tenantId}
        AND correlation_id = ANY(${tx.array([...correlationIds], "text")}::text[])
    `) as {
    correlation_id: string;
    status: string;
    provider_ref: string | null;
    attempts: number;
    last_error: string | null;
    sent_at: Date | null;
  }[];
  for (const row of found) {
    result.set(row.correlation_id, {
      status: row.status,
      providerMessageId: row.provider_ref,
      // Both dispatchers count FAILED attempts only (a success never bumps
      // the counter), so `attempts` here and `retry_count` on the e-mail outbox
      // mean the same.
      retryCount: Number(row.attempts),
      lastError: row.last_error,
      sentAt: row.sent_at ? row.sent_at.toISOString() : null
    });
  }

  return result;
}

/**
 * The legacy queue's state for one tenant, for the guarded mode flip (Issue
 * #393): the row count per status, how many are still work (every status that is
 * not terminal, so an unknown future status blocks rather than slips through) and
 * the age of the oldest one. A read; the flip holds the exclusive mode lock when
 * it calls this, so no new legacy row can appear between this answer and the
 * commit.
 */
export async function summarizeLegacyWhatsappQueue(
  tx: Bun.SQL,
  tenantId: string
): Promise<QueueDrain> {
  const counts = (await tx`
    SELECT status, count(*) AS count
    FROM awcms_commerce_whatsapp_messages
    WHERE tenant_id = ${tenantId}
    GROUP BY status
  `) as { status: string; count: string | number }[];

  const oldest = (await tx`
    SELECT floor(extract(epoch FROM (now() - min(created_at))))::bigint AS age_seconds
    FROM awcms_commerce_whatsapp_messages
    WHERE tenant_id = ${tenantId}
      AND status <> ALL(${tx.array([...LEGACY_TERMINAL_STATUSES], "text")}::text[])
  `) as { age_seconds: string | number | null }[];

  const age = oldest[0]?.age_seconds;

  return buildQueueDrain(
    Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])),
    LEGACY_TERMINAL_STATUSES,
    age === null || age === undefined ? null : Number(age)
  );
}
