/**
 * Midtrans webhook (HTTP notification) body -> `PaymentGatewayWebhookInput`
 * (Issue #113, contract #106's D2/D3). Pure — no I/O, no database.
 *
 * Midtrans's own documented field names are snake_case
 * (`order_id`/`status_code`/`gross_amount`/`transaction_status`/
 * `fraud_status`/`signature_key`) — this is the ONE place that vocabulary
 * is translated into `PaymentGatewayWebhookInput`'s own camelCase shape, so
 * every other file in this module (`domain/gateway-status-mapping.ts`,
 * `infrastructure/midtrans-provider.ts`'s `verifyWebhook`) stays provider-
 * agnostic. `fraud_status` is genuinely optional in Midtrans's own payload
 * (only present for a card `capture`) — missing/non-string collapses to
 * `null`, never an empty string, matching `PaymentGatewayWebhookInput`'s own
 * `string | null` field.
 *
 * Returns `null` for anything that is not a well-formed object carrying the
 * four REQUIRED string fields (`order_id`, `status_code`, `gross_amount`,
 * `signature_key`) — the route answers a generic `400`/`401` for that,
 * never a field-by-field validation error (contract's own "never disclose
 * shape to an unauthenticated caller" rule, `api-body-auth-boundary.ts`'s
 * header states the same principle for session-gated bodies; a webhook
 * caller is equally unauthenticated until its signature checks out).
 */
import type { PaymentGatewayWebhookInput } from "./payment-gateway-provider";

function readRequiredString(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseMidtransWebhookBody(
  body: unknown
): PaymentGatewayWebhookInput | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;

  const orderId = readRequiredString(record, "order_id");
  const statusCode = readRequiredString(record, "status_code");
  const grossAmount = readRequiredString(record, "gross_amount");
  const signatureKey = readRequiredString(record, "signature_key");
  const transactionStatus = readRequiredString(record, "transaction_status");

  if (
    !orderId ||
    !statusCode ||
    !grossAmount ||
    !signatureKey ||
    !transactionStatus
  ) {
    return null;
  }

  const fraudStatus =
    typeof record.fraud_status === "string" ? record.fraud_status : null;

  return {
    orderId,
    statusCode,
    grossAmount,
    transactionStatus,
    fraudStatus,
    signatureKey
  };
}
