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
