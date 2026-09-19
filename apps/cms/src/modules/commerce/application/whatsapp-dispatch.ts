/**
 * Internal WhatsApp dispatcher (Issue #108, contract #106/ADR-0017 D5). NOT
 * a public HTTP endpoint — invoked by `scripts/commerce-whatsapp-
 * dispatch.ts`, one tenant at a time. Three-phase pattern, identical to
 * `email/application/email-dispatch.ts` (ADR-0006 — never call a provider
 * inside a DB transaction):
 *
 * 1. CLAIM — one short transaction flips eligible `queued` rows to a
 *    transient `sending` status (`FOR UPDATE SKIP LOCKED`), reusing
 *    `next_attempt_at` as the claim lease expiry — same reuse the email
 *    outbox already established. A `sending` row whose lease has expired is
 *    re-claimed by a later pass.
 * 2. SEND — for each claimed row, calls the resolved `WhatsappProvider`
 *    (`../infrastructure/whatsapp-provider-resolver.ts`) *outside* any
 *    transaction. `body_rendered` was already computed at enqueue time
 *    (`whatsapp-enqueue.ts`) — this dispatcher never re-renders a template.
 * 3. FINALIZE — one short transaction per row flips `sending` to `sent`,
 *    or (on failure) to `queued` with backoff (reusing
 *    `email/domain/email-retry.ts`'s pure backoff function — the shape is
 *    provider-agnostic) or `failed` once retries are exhausted or the
 *    failure is non-retryable. Every attempt is recorded in
 *    `awcms_commerce_whatsapp_delivery_attempts`.
 *
 * If `COMMERCE_WHATSAPP_ENABLED` is not `"true"`,
 * `dispatchWhatsappQueue` returns immediately without claiming anything —
 * the same "provider off never touches the provider at all" rule
 * `dispatchEmailQueue` follows.
 *
 * `commerce.customer_otp` messages carry the raw code ONLY in
 * `body_rendered`/the provider request — never in a delivery-attempt row or
 * a log line here (the log adapter is the one deliberate exception, and it
 * reads the code from the ENQUEUE side, not from anything this file
 * writes).
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import { log } from "../../../lib/logging/logger";
import { evaluateEmailRetry } from "../../email/domain/email-retry";
import { resolveWhatsappSendMaxRetries } from "../domain/whatsapp-config";
import type { WhatsappProvider } from "../domain/whatsapp-provider";
import { resolveWhatsappProvider } from "../infrastructure/whatsapp-provider-resolver";

const MODULE_KEY = "commerce";
const CIRCUIT_BREAKER_KEY_PREFIX = "commerce-whatsapp";

export const WHATSAPP_DISPATCH_DEFAULT_LIMIT = 25;
export const WHATSAPP_DISPATCH_LEASE_MINUTES = 2;
const MAX_RESPONSE_SNIPPET_LENGTH = 500;

type ClaimedRow = {
  id: string;
  correlation_id: string | null;
  template_key: string;
  to_phone: string;
  to_phone_masked: string;
  body_rendered: string;
  variables: Record<string, unknown> | null;
  attempts: string | number;
};

export type DispatchWhatsappQueueOptions = {
  limit?: number;
  now?: Date;
  correlationId?: string;
  resolveProvider?: (env?: NodeJS.ProcessEnv) => WhatsappProvider;
  env?: NodeJS.ProcessEnv;
};

export type DispatchWhatsappQueueResult = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  deferred: number;
  breakerOpen: boolean;
};

/** Same lease-aware claim predicate `email-dispatch.ts#claimEligibleEntries` documents (Issue #143). */
async function claimEligibleEntries(
  sql: Bun.SQL,
  tenantId: string,
  now: Date,
  limit: number
): Promise<ClaimedRow[]> {
  const leaseExpiry = new Date(
    now.getTime() + WHATSAPP_DISPATCH_LEASE_MINUTES * 60_000
  );

  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const rows = await tx`
        UPDATE awcms_commerce_whatsapp_messages
        SET status = 'sending', next_attempt_at = ${leaseExpiry}
        WHERE id IN (
          SELECT id FROM awcms_commerce_whatsapp_messages
          WHERE tenant_id = ${tenantId}
            AND (
              (status = 'queued'
                AND (next_attempt_at IS NULL OR next_attempt_at <= ${now}))
              OR (status = 'sending' AND next_attempt_at <= ${now})
            )
          ORDER BY created_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, correlation_id, template_key, to_phone, to_phone_masked,
                  body_rendered, variables, attempts
      `;

      return rows as unknown as ClaimedRow[];
    },
    { workClass: "background_sync" }
  );
}

async function recordDeliveryAttempt(
  sql: Bun.SQL,
  tenantId: string,
  messageId: string,
  attemptNo: number,
  outcome: "success" | "failure",
  providerName: string,
  providerResponseSnippet: string | null,
  errorMessage: string | null
): Promise<void> {
  await withTenantOrThrow(
    sql,
    tenantId,
    (tx) => tx`
      INSERT INTO awcms_commerce_whatsapp_delivery_attempts
        (tenant_id, message_id, attempt_no, outcome, provider_name, provider_response_snippet, error_message)
      VALUES (
        ${tenantId}, ${messageId}, ${attemptNo}, ${outcome}, ${providerName},
        ${providerResponseSnippet}, ${errorMessage}
      )
      ON CONFLICT ON CONSTRAINT awcms_commerce_whatsapp_delivery_attempts_unique_attempt
      DO NOTHING
    `,
    { workClass: "background_sync" }
  );
}

async function finalizeSent(
  sql: Bun.SQL,
  tenantId: string,
  id: string,
  providerName: string,
  providerRef: string | undefined
): Promise<void> {
  await withTenantOrThrow(
    sql,
    tenantId,
    (tx) => tx`
      UPDATE awcms_commerce_whatsapp_messages
      SET status = 'sent', sent_at = now(), next_attempt_at = null,
          updated_at = now(), provider_ref = ${providerRef ?? null},
          last_error = null
      WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'sending'
    `,
    { workClass: "background_sync" }
  );
  void providerName;
}

/** Finding D6's "no attempt was made" undo — same shape `email-dispatch.ts#finalizeDeferred` documents. */
async function finalizeDeferred(
  sql: Bun.SQL,
  tenantId: string,
  id: string,
  reason: string
): Promise<void> {
  await withTenantOrThrow(
    sql,
    tenantId,
    (tx) => tx`
      UPDATE awcms_commerce_whatsapp_messages
      SET status = 'queued', next_attempt_at = null, updated_at = now(),
          last_error = ${`Deferred (no attempt made): ${reason}`}
      WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'sending'
    `,
    { workClass: "background_sync" }
  );
}

async function finalizeFailure(
  sql: Bun.SQL,
  tenantId: string,
  id: string,
  currentAttempts: number,
  maxRetries: number,
  retryable: boolean,
  now: Date,
  errorMessage: string
): Promise<{ eligible: boolean }> {
  const evaluation = retryable
    ? evaluateEmailRetry(currentAttempts, maxRetries, now)
    : { eligible: false as const };

  if (evaluation.eligible) {
    await withTenantOrThrow(
      sql,
      tenantId,
      (tx) => tx`
        UPDATE awcms_commerce_whatsapp_messages
        SET status = 'queued', attempts = ${currentAttempts + 1},
            next_attempt_at = ${evaluation.nextAttemptAt}, updated_at = now(),
            last_error = ${errorMessage}
        WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'sending'
      `,
      { workClass: "background_sync" }
    );

    return { eligible: true };
  }

  await withTenantOrThrow(
    sql,
    tenantId,
    (tx) => tx`
      UPDATE awcms_commerce_whatsapp_messages
      SET status = 'failed', attempts = ${currentAttempts + 1},
          next_attempt_at = null, updated_at = now(), last_error = ${errorMessage}
      WHERE tenant_id = ${tenantId} AND id = ${id} AND status = 'sending'
    `,
    { workClass: "background_sync" }
  );

  return { eligible: false };
}

/**
 * Dispatches one batch of due `awcms_commerce_whatsapp_messages` entries for
 * a single tenant. Safe to call repeatedly (claim-lease pattern); the CLI
 * script loops per tenant to drain a larger backlog.
 */
export async function dispatchWhatsappQueue(
  sql: Bun.SQL,
  tenantId: string,
  options: DispatchWhatsappQueueOptions = {}
): Promise<DispatchWhatsappQueueResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const limit = options.limit ?? WHATSAPP_DISPATCH_DEFAULT_LIMIT;
  const correlationId = options.correlationId ?? crypto.randomUUID();
  const maxRetries = resolveWhatsappSendMaxRetries(env);
  const providerKind = env.COMMERCE_WHATSAPP_PROVIDER ?? "unknown";
  const breaker = getProviderCircuitBreaker(
    `${CIRCUIT_BREAKER_KEY_PREFIX}-${providerKind}`
  );
  const breakerOpen = !breaker.canAttempt(now);

  const result: DispatchWhatsappQueueResult = {
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    deferred: 0,
    breakerOpen
  };

  if (env.COMMERCE_WHATSAPP_ENABLED !== "true") {
    return result;
  }

  if (breakerOpen) {
    log("warning", "commerce.whatsapp.dispatch.breaker_open", {
      correlationId,
      tenantId,
      moduleKey: MODULE_KEY
    });
    return result;
  }

  const claimed = await claimEligibleEntries(sql, tenantId, now, limit);
  result.claimed = claimed.length;

  if (claimed.length === 0) {
    return result;
  }

  log("info", "commerce.whatsapp.dispatch.claimed", {
    correlationId,
    tenantId,
    moduleKey: MODULE_KEY,
    count: claimed.length
  });

  const provider = (options.resolveProvider ?? resolveWhatsappProvider)(env);

  for (const entry of claimed) {
    const attempts = Number(entry.attempts);
    const attemptNo = attempts + 1;
    const messageCorrelationId = entry.correlation_id ?? correlationId;
    const otpCode =
      entry.template_key === "commerce.customer_otp" &&
      entry.variables &&
      typeof (entry.variables as Record<string, unknown>).code === "string"
        ? ((entry.variables as Record<string, unknown>).code as string)
        : undefined;

    const deliveryResult = await provider.send({
      toPhone: entry.to_phone,
      templateKey: entry.template_key,
      body: entry.body_rendered,
      otpCode,
      correlationId: messageCorrelationId
    });

    if (deliveryResult.ok) {
      await recordDeliveryAttempt(
        sql,
        tenantId,
        entry.id,
        attemptNo,
        "success",
        providerKind,
        deliveryResult.providerMessageId?.slice(
          0,
          MAX_RESPONSE_SNIPPET_LENGTH
        ) ?? null,
        null
      );
      await finalizeSent(
        sql,
        tenantId,
        entry.id,
        providerKind,
        deliveryResult.providerMessageId
      );
      log("info", "commerce.whatsapp.dispatch.sent", {
        correlationId: messageCorrelationId,
        tenantId,
        moduleKey: MODULE_KEY,
        to: entry.to_phone_masked,
        templateKey: entry.template_key
      });
      result.sent += 1;
      continue;
    }

    const safeError = deliveryResult.error.slice(
      0,
      MAX_RESPONSE_SNIPPET_LENGTH
    );

    if (deliveryResult.skipped) {
      await finalizeDeferred(sql, tenantId, entry.id, safeError);
      log("warning", "commerce.whatsapp.dispatch.deferred", {
        correlationId: messageCorrelationId,
        tenantId,
        moduleKey: MODULE_KEY,
        templateKey: entry.template_key,
        error: safeError
      });
      result.deferred += 1;
      continue;
    }

    await recordDeliveryAttempt(
      sql,
      tenantId,
      entry.id,
      attemptNo,
      "failure",
      providerKind,
      safeError,
      safeError
    );

    const finalized = await finalizeFailure(
      sql,
      tenantId,
      entry.id,
      attempts,
      maxRetries,
      deliveryResult.retryable,
      now,
      safeError
    );

    if (finalized.eligible) {
      log("warning", "commerce.whatsapp.dispatch.retry_scheduled", {
        correlationId: messageCorrelationId,
        tenantId,
        moduleKey: MODULE_KEY,
        templateKey: entry.template_key,
        attempts: attempts + 1,
        error: safeError
      });
      result.retried += 1;
    } else {
      log("error", "commerce.whatsapp.dispatch.failed", {
        correlationId: messageCorrelationId,
        tenantId,
        moduleKey: MODULE_KEY,
        templateKey: entry.template_key,
        attempts: attempts + 1,
        error: safeError
      });
      result.failed += 1;
    }
  }

  return result;
}
