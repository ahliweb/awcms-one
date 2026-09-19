/**
 * Provider-reported amount vs. order total (Issue #113, defense in depth).
 * Pure — no I/O.
 *
 * A verified webhook/status response is a statement about the SERVICE's
 * view of the transaction, not proof the amount matches what this platform
 * expects to be paid — a tampered Snap transaction, a stale callback for an
 * amended order, or a provider-side bug can all carry the right signature
 * over the wrong `gross_amount`. So the webhook intake route and the
 * reconcile job both refuse to mark an order paid unless the amounts are
 * equal, and record the event as `outcome = 'amount_mismatch'` instead
 * (`sql/934`).
 *
 * Comparison is in integer cents (`toCents`, ADR-0003) — never a float.
 * Midtrans sends `gross_amount` as a decimal string such as `"150000.00"`;
 * a value that cannot be read as such (empty, non-numeric, negative) counts
 * as a mismatch rather than a pass, since an unparseable amount is never a
 * reason to release goods.
 */
import { toCents } from "./price-calculation";

const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;

export type PaymentAmountCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "unparseable" | "mismatch";
      reported: string;
      expected: string;
    };

export function checkPaymentAmount(
  reportedGrossAmount: string,
  orderTotal: string
): PaymentAmountCheck {
  const reported = reportedGrossAmount.trim();
  if (!DECIMAL_PATTERN.test(reported) || !DECIMAL_PATTERN.test(orderTotal)) {
    return {
      ok: false,
      reason: "unparseable",
      reported: reportedGrossAmount,
      expected: orderTotal
    };
  }
  if (toCents(reported) !== toCents(orderTotal)) {
    return {
      ok: false,
      reason: "mismatch",
      reported: reportedGrossAmount,
      expected: orderTotal
    };
  }
  return { ok: true };
}

/** Which mapped provider statuses count as a TERMINAL failure — the only case an amount-mismatched event still moves the gateway SESSION row (to `failed`); every other mismatch leaves the session as it was. */
export function isTerminalFailureStatus(status: string): boolean {
  return status === "failed" || status === "expired";
}
