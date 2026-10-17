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

/**
 * Issue #379 (ADR-0041 D2) - the same integer-cent equality check, against the
 * amount the SESSION was created to collect instead of the order's current
 * total.
 *
 *   - `full`: the reported figure must equal the order's current total (exactly
 *     the check above, so a whole-total order is as guarded as before this
 *     change - an amended total or a stale callback still mismatches) AND, for a
 *     session that carries one, the session's frozen `expected_amount`. A
 *     session created before `sql/1025` has no `expected_amount` and is checked
 *     against the order total alone.
 *   - `deposit` / `balance`: the reported figure must equal the session's own
 *     `expected_amount`, which must be greater than zero. The order total is
 *     deliberately not consulted - a deposit is less than it by construction.
 *
 * "Equal" is both directions: a lower figure (a partial capture) and a higher
 * one (a tampered or inflated callback) are each a mismatch.
 */
export function checkSessionPaymentAmount(
  reportedGrossAmount: string,
  session: { purpose: string; expectedAmount: string | null },
  orderTotal: string
): PaymentAmountCheck {
  if (session.purpose === "full") {
    const againstTotal = checkPaymentAmount(reportedGrossAmount, orderTotal);
    if (!againstTotal.ok || session.expectedAmount === null) {
      return againstTotal;
    }
    return checkPaymentAmount(reportedGrossAmount, session.expectedAmount);
  }

  const expected = session.expectedAmount;
  if (
    expected === null ||
    !DECIMAL_PATTERN.test(expected) ||
    toCents(expected) <= 0n
  ) {
    return {
      ok: false,
      reason: "unparseable",
      reported: reportedGrossAmount,
      expected: expected ?? ""
    };
  }
  return checkPaymentAmount(reportedGrossAmount, expected);
}

/** Which mapped provider statuses count as a TERMINAL failure — the only case an amount-mismatched event still moves the gateway SESSION row (to `failed`); every other mismatch leaves the session as it was. */
export function isTerminalFailureStatus(status: string): boolean {
  return status === "failed" || status === "expired";
}
