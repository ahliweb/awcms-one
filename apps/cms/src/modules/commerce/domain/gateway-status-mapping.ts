/**
 * Midtrans `transaction_status`/`fraud_status` -> `PaymentGatewayStatus`
 * (Issue #110, contract #106's D3). Pure, no I/O — both
 * `infrastructure/midtrans-provider.ts`'s `fetchStatus` and its
 * `verifyWebhook` (D3's port shape; the webhook INTAKE route itself is
 * #113's scope) call this so a status check and a webhook callback can never
 * disagree about what a given Midtrans status pair means.
 *
 * Midtrans's own vocabulary: `capture` (card, needs `fraud_status`),
 * `settlement` (e-wallet/VA, no fraud check), `pending`, `deny`, `cancel`,
 * `expire`, `refund`, `partial_refund`.
 */
import type { PaymentGatewayStatus } from "./payment-gateway-provider";

export function mapMidtransStatus(
  transactionStatus: string,
  fraudStatus: string | null
): PaymentGatewayStatus {
  switch (transactionStatus) {
    case "capture":
      // A card transaction only ever carries a fraud_status; treat a
      // missing one (should not happen for `capture`) as still pending
      // rather than guessing "paid".
      if (fraudStatus === "accept") return "paid";
      if (fraudStatus === "deny") return "failed";
      return "pending"; // "challenge", or a fraud_status this mapping does not yet know.
    case "settlement":
      return "paid";
    case "pending":
      return "pending";
    case "deny":
      return "failed";
    case "cancel":
    case "expire":
      return "expired";
    case "refund":
    case "partial_refund":
      return "refunded";
    default:
      return "pending";
  }
}
