/**
 * The input and result of `enqueueWhatsappMessage`, shared by the mode router
 * (`application/whatsapp-enqueue.ts`), the legacy writer and the upstream
 * adapter (Issue #392). Pure types and one pure mapping; no I/O.
 *
 * It lives in `domain/` so the upstream path can use the types without importing
 * the legacy file that names the legacy table.
 */
import type { WhatsappTemplateKey } from "./whatsapp-templates";

export type EnqueueWhatsappMessageInput = {
  tenantId: string;
  /** E.164 (`+62…`) - already normalised by the caller (`domain/phone-normalisation.ts`). */
  toPhone: string;
  templateKey: WhatsappTemplateKey;
  variables: Record<string, string>;
  correlationId?: string;
  /**
   * The caller's own identity for this ONE message (Issue #392), used only in
   * `upstream` mode as the basis of the queue's idempotency key: a campaign
   * recipient is `campaign:<campaignId>:<customerId>`, a document delivery is
   * `document:<deliveryId>`. The `legacy` writer ignores it, so it changes no
   * legacy row. Leave it unset when each call is a distinct message (a customer
   * OTP: replaying a retry onto the previous code would deliver the old code
   * for the new one), and the adapter supplies a fresh key.
   */
  idempotencyKey?: string;
};

/** Why an `upstream`-mode message was not queued. The upstream port's own reasons, plus its two suppressions. */
export type WhatsappNotQueuedReason =
  | "CONSENT_REQUIRED"
  | "TEMPLATE_UNKNOWN"
  | "DISABLED"
  | "RATE_LIMITED"
  | "RECIPIENT_INVALID"
  | "RECIPIENT_UNRESOLVED"
  | "EXPIRY_REQUIRED"
  | "MISCONFIGURED"
  | "SUPPRESSED_HARD_FAILURE"
  | "SUPPRESSED_OPT_OUT";

/**
 * The legacy result shape (`id`, `bodyRendered`) plus a discriminant. In `legacy`
 * mode `enqueued` is always `true`, as the function always inserted. In
 * `upstream` mode a refusal or suppression is RETURNED with `enqueued: false`
 * and `id: ""` (never thrown: the port's contract, and a caller that is mid-way
 * through a business transaction must be able to carry on); `id` is the queue
 * message id otherwise, including for an idempotent replay.
 */
export type EnqueueWhatsappMessageResult =
  | { id: string; bodyRendered: string; enqueued: true }
  | {
      id: "";
      bodyRendered: string;
      enqueued: false;
      reason: WhatsappNotQueuedReason;
    };

/**
 * `awcms_commerce_document_deliveries.failure_reason` is a closed two-value
 * CHECK (`sql/965`), recorded for a delivery that was requested but not queued.
 * A recipient-side refusal (opted out, hard-failed, unusable number) is
 * `RECIPIENT_SUPPRESSED`; anything on the sending side (the queue is off, not
 * configured, rate limited, template unknown) is `TEMPLATE_UNAVAILABLE`.
 */
export function documentDeliveryFailureReason(
  reason: WhatsappNotQueuedReason
): "RECIPIENT_SUPPRESSED" | "TEMPLATE_UNAVAILABLE" {
  switch (reason) {
    case "SUPPRESSED_HARD_FAILURE":
    case "SUPPRESSED_OPT_OUT":
    case "CONSENT_REQUIRED":
    case "RECIPIENT_INVALID":
    case "RECIPIENT_UNRESOLVED":
      return "RECIPIENT_SUPPRESSED";
    default:
      return "TEMPLATE_UNAVAILABLE";
  }
}
