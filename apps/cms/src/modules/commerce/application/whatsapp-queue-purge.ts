/**
 * Retention for the WhatsApp outbox (Issue #108) — this module's registered
 * "delegated" adopter for the two `dataLifecycle` descriptors in
 * `../module.ts` (`commerce.whatsapp_messages`/`commerce.
 * whatsapp_delivery_attempts`). Same shape
 * `email/application/email-queue-purge.ts` uses for its own outbox, minus
 * that file's legal-hold integration — this module's other queue-shaped
 * tables (`commerce.customer_otps`/`commerce.customer_sessions`,
 * `module.ts`) already set `legalHold.applicable: false` for the same
 * reason: a spent OTP/delivery record carries no evidentiary value once
 * dead, so there is nothing here a legal hold would ever need to freeze.
 *
 * Deliberately NOT the generic age-only executor
 * (`HighVolumeTableDescriptor`'s `cursorColumn`-only predicate) — pointed at
 * this table it would delete a message still `queued` behind a slow
 * provider, which would look exactly like successful housekeeping. Every
 * DELETE here names the terminal status set explicitly, and `sending` is
 * never touched (a dispatcher pass may be mid-flight; its own lease is what
 * recovers it).
 */
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import { recordAuditEvent } from "../../logging/application/audit-log";

export const WHATSAPP_MESSAGE_DEFAULT_RETENTION_DAYS = 90;
export const WHATSAPP_ATTEMPT_DEFAULT_RETENTION_DAYS = 30;
export const WHATSAPP_PURGE_BATCH_LIMIT = 5000;

/**
 * Every status a row can hold once nothing further will happen to it.
 * Exported so a test can assert it against the migration's own CHECK
 * constraint — a status added to the schema and not here would accumulate
 * forever with no error anywhere.
 */
export const WHATSAPP_TERMINAL_STATUSES = ["sent", "failed"] as const;

const MODULE_KEY = "commerce";

function resolveCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

export type PurgeWhatsappQueueOptions = {
  messageRetentionDays?: number;
  attemptRetentionDays?: number;
  batchLimit?: number;
  now?: Date;
  correlationId?: string;
};

export type PurgeWhatsappQueueResult = {
  purgedAttempts: number;
  purgedMessages: number;
};

type IdRow = { id: string };

export async function purgeWhatsappQueue(
  sql: Bun.SQL,
  tenantId: string,
  options: PurgeWhatsappQueueOptions = {}
): Promise<PurgeWhatsappQueueResult> {
  const now = options.now ?? new Date();
  const batchLimit = options.batchLimit ?? WHATSAPP_PURGE_BATCH_LIMIT;
  const messageCutoff = resolveCutoff(
    now,
    options.messageRetentionDays ?? WHATSAPP_MESSAGE_DEFAULT_RETENTION_DAYS
  );
  const attemptCutoff = resolveCutoff(
    now,
    options.attemptRetentionDays ?? WHATSAPP_ATTEMPT_DEFAULT_RETENTION_DAYS
  );

  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      // 1. Attempts, first — FK ordering (messages step below skips any
      //    message an attempt row still points at).
      const deletedAttempts = (await tx`
        DELETE FROM awcms_commerce_whatsapp_delivery_attempts
        WHERE id IN (
          SELECT id FROM awcms_commerce_whatsapp_delivery_attempts
          WHERE tenant_id = ${tenantId} AND attempted_at < ${attemptCutoff}
          ORDER BY attempted_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as IdRow[];

      // 2. Messages — TERMINAL only (`sent`/`failed`; `queued`/`sending` are
      //    work, not history, however old they are).
      const deletedMessages = (await tx`
        DELETE FROM awcms_commerce_whatsapp_messages
        WHERE id IN (
          SELECT m.id FROM awcms_commerce_whatsapp_messages m
          WHERE m.tenant_id = ${tenantId}
            AND m.status IN ('sent', 'failed')
            AND m.updated_at < ${messageCutoff}
            AND NOT EXISTS (
              SELECT 1 FROM awcms_commerce_whatsapp_delivery_attempts a
              WHERE a.tenant_id = m.tenant_id AND a.message_id = m.id
            )
          ORDER BY m.updated_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as IdRow[];

      const result: PurgeWhatsappQueueResult = {
        purgedAttempts: deletedAttempts.length,
        purgedMessages: deletedMessages.length
      };

      const total = result.purgedAttempts + result.purgedMessages;

      if (total > 0) {
        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: MODULE_KEY,
          action: "purge",
          resourceType: "whatsapp_queue",
          severity: "info",
          message: `WhatsApp outbox retention purge removed ${total} row(s).`,
          attributes: {
            purgedAttempts: result.purgedAttempts,
            purgedMessages: result.purgedMessages,
            messageCutoff: messageCutoff.toISOString(),
            attemptCutoff: attemptCutoff.toISOString(),
            ...(options.correlationId
              ? { correlationId: options.correlationId }
              : {})
          }
        });
      }

      return result;
    },
    { workClass: "maintenance" }
  );
}
