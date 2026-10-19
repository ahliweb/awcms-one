/**
 * Pure rules of the booking no-show (Issue #382, ADR-0045 D15, contracts section
 * 3.8; threat control C-41). No database, no clock, no I/O.
 *
 * ## A no-show retains by the ORIGINAL policy version and refunds nothing
 *
 * Marking a no-show is a staff act (Booking measures arrival plus the tenant's
 * grace: `NO_SHOW_TOO_EARLY` before). What the business keeps is decided by the
 * `no_show_retention` rule of the cancellation policy version that applied when
 * the booking was MADE (the root of a reschedule chain, exactly as a cancel):
 *
 *   - `retain_deposit` - the deposit is kept: the part of what was paid up to the
 *     order's release threshold (the deposit of a down-payment order, the whole
 *     total of any other). Whatever was paid beyond it is NOT retained; it is
 *     reported as such and returned by the ordinary refund path if staff decide
 *     so, never by this action.
 *   - `retain_all` - everything paid is kept.
 *   - `refund_per_windows` - the cancellation windows are evaluated at the
 *     moment of the no-show. That moment is after arrival, and "after arrival
 *     refunds nothing" is a rule of the windows themselves
 *     (`computeCancellationRefund`), so the share is zero in practice; whatever
 *     the windows would give back is excluded from the retained amount, and is
 *     still not refunded here.
 *   - no policy applied (`none`, ADR-0045 D6) - everything paid is kept, the
 *     same fail-closed answer a cancel gives.
 *
 * In NO case does a no-show create a refund leg: the decision's computed and
 * final refund are zero and a database trigger refuses to give a no-show
 * decision a return (sql/1045).
 *
 * A no-show body carries no amount: `reasonCode` is the only field, a short
 * lowercase code for the audit row.
 */
import { isRecord, type ValidationError } from "./payment-allocation";

export type { ValidationError };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export type NoShowRetentionRule =
  | "retain_deposit"
  | "retain_all"
  | "refund_per_windows"
  /** No policy applied to the booking (ADR-0045 D6). */
  | "none";

export type NoShowRetention = {
  /** What the policy keeps. Never above the amount paid. */
  retainedCents: bigint;
  /** Paid and not kept (`paid - retained`); NOT refunded by the no-show. */
  notRetainedCents: bigint;
};

/**
 * What a no-show retains. `thresholdCents` is the order's release threshold
 * (the deposit for a down-payment order, the total otherwise);
 * `windowRefundCents` is what `refund_per_windows` would give back at the
 * no-show instant (zero after arrival, by the windows' own rule).
 */
export function computeNoShowRetention(input: {
  rule: NoShowRetentionRule;
  amountPaidCents: bigint;
  thresholdCents: bigint;
  windowRefundCents: bigint;
}): NoShowRetention {
  const paid = input.amountPaidCents > 0n ? input.amountPaidCents : 0n;
  let retained: bigint;
  switch (input.rule) {
    case "retain_deposit": {
      const threshold = input.thresholdCents > 0n ? input.thresholdCents : 0n;
      retained = paid < threshold ? paid : threshold;
      break;
    }
    case "refund_per_windows": {
      const back =
        input.windowRefundCents > 0n
          ? input.windowRefundCents > paid
            ? paid
            : input.windowRefundCents
          : 0n;
      retained = paid - back;
      break;
    }
    case "retain_all":
    case "none":
      retained = paid;
      break;
  }
  return { retainedCents: retained, notRetainedCents: paid - retained };
}

export type NoShowRequest = { reasonCode: string };

/** The reason recorded when a request names none. */
export const DEFAULT_NO_SHOW_REASON_CODE = "guest_did_not_arrive";

const REASON_CODE = /^[a-z][a-z0-9_]{2,39}$/;

/** The body of the staff no-show: an optional closed `reasonCode`, nothing else (no amount, no refund). */
export function validateNoShowRequest(
  body: unknown
): ValidationResult<NoShowRequest> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  for (const key of Object.keys(record)) {
    if (key === "reasonCode") continue;
    errors.push({
      field: key,
      message: `${key} is not accepted: the server applies the policy's retention.`
    });
  }
  let reasonCode = DEFAULT_NO_SHOW_REASON_CODE;
  if (record.reasonCode !== undefined && record.reasonCode !== null) {
    if (
      typeof record.reasonCode !== "string" ||
      !REASON_CODE.test(record.reasonCode)
    ) {
      errors.push({
        field: "reasonCode",
        message:
          "reasonCode must be a short lowercase code (letters, digits, underscore), never free text."
      });
    } else {
      reasonCode = record.reasonCode;
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { reasonCode } };
}

/** The source key of a no-show decision: one per Booking reservation, the same keyspace as a cancel's (a reservation is cancelled OR no-show, once). */
export { decisionSourceKey as noShowDecisionSourceKey } from "./booking-cancellation";
