/**
 * Client helpers for the booking cancellation screens (Issue #381,
 * `docs/booking-ux-flows.md` sections 11.4 and 11.5): the refund-override dialog
 * and the cancellation-policy windows editor. Pure functions with no DOM
 * dependency so `tests/commerce-booking-refund-client.test.ts` asserts them
 * directly.
 *
 * Nothing here is an authority. The server computes the refund, re-checks the
 * cap (`REFUND_EXCEEDS_PAID`), the reason length and the step-up, and refuses a
 * body that names an amount outside the `override` object. The dialog's
 * disabled state is a convenience that tells the operator BEFORE the round trip;
 * a hand-built request meets the same refusals.
 */

const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export const OVERRIDE_REASON_MIN = 10;
export const OVERRIDE_REASON_MAX = 500;

/** `"1250.5"` -> 125050n; `null` when it is not a non-negative amount with at most two decimals. */
export function moneyToCents(text: string): bigint | null {
  const trimmed = text.trim();
  if (!MONEY_PATTERN.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole!) * 100n + BigInt((fraction + "00").slice(0, 2));
}

/** 125050n -> `"1250.50"`. */
export function centsToMoney(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export type OverrideProblem =
  | "amount_malformed"
  | "amount_above_paid"
  | "amount_unchanged"
  | "reason_too_short"
  | "reason_too_long";

export type OverrideCheck =
  | { ok: true; finalRefund: string; reason: string }
  | { ok: false; problems: OverrideProblem[] };

/**
 * Whether the override dialog's submit may be enabled: the amount is a
 * well-formed figure between zero and the amount paid, it differs from the
 * policy's, and the reason is 10 to 500 characters once trimmed.
 */
export function checkOverrideForm(input: {
  amountText: string;
  paidText: string;
  computedText: string;
  reason: string;
}): OverrideCheck {
  const problems: OverrideProblem[] = [];
  const amount = moneyToCents(input.amountText);
  const paid = moneyToCents(input.paidText);
  const computed = moneyToCents(input.computedText);
  if (amount === null) problems.push("amount_malformed");
  else if (paid !== null && amount > paid) problems.push("amount_above_paid");
  else if (computed !== null && amount === computed) {
    problems.push("amount_unchanged");
  }
  const reason = input.reason.trim();
  if (reason.length < OVERRIDE_REASON_MIN) problems.push("reason_too_short");
  else if (reason.length > OVERRIDE_REASON_MAX)
    problems.push("reason_too_long");
  if (problems.length > 0 || amount === null) return { ok: false, problems };
  return { ok: true, finalRefund: centsToMoney(amount), reason };
}

/** The staff cancel body: a closed reason code and, only for an override, `{ finalRefund, reason }`. */
export function buildStaffCancelBody(
  reasonCode: string,
  override: { finalRefund: string; reason: string } | null
): Record<string, unknown> {
  return override ? { reasonCode, override } : { reasonCode };
}

export type WindowRowInput = {
  /** The number typed in the "at least" field. */
  amount: string;
  unit: "hours" | "days";
  /** The "refund %" field. */
  percent: string;
};

export type PolicyDraftBody = {
  productId: string | null;
  refundBasis: "whole_stay" | "per_night";
  noShowRetention: "retain_deposit" | "retain_all" | "refund_per_windows";
  windows: { minHoursBeforeStart: number; refundablePercent: string }[];
};

export type PolicyFormResult =
  | { ok: true; body: PolicyDraftBody }
  | {
      ok: false;
      /** Row index (0-based) and field, or `null` for a rule of the whole list. */
      row: number | null;
      problem:
        | "empty"
        | "notice_invalid"
        | "percent_invalid"
        | "duplicate_notice"
        | "refund_grows";
    };

const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

/** The notice in whole hours, or `null` when it is not a whole non-negative number (days are 24 hours). */
export function noticeToHours(
  amount: string,
  unit: "hours" | "days"
): number | null {
  const trimmed = amount.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const hours = Number(trimmed) * (unit === "days" ? 24 : 1);
  return hours <= 8_760 ? hours : null;
}

/** Splits whole hours into the editor's friendliest unit (days when exact). */
export function hoursToNotice(hours: number): {
  amount: number;
  unit: "hours" | "days";
} {
  return hours > 0 && hours % 24 === 0
    ? { amount: hours / 24, unit: "days" }
    : { amount: hours, unit: "hours" };
}

/**
 * Builds the `POST .../cancellation-policies` body from the editor rows. The
 * rule that more notice never refunds less is checked here so the operator is
 * told before the round trip; the server and the database enforce it.
 */
export function buildPolicyDraftBody(input: {
  productId: string | null;
  refundBasis: string;
  noShowRetention: string;
  rows: readonly WindowRowInput[];
}): PolicyFormResult {
  if (input.rows.length === 0) {
    return { ok: false, row: null, problem: "empty" };
  }
  const windows: { minHoursBeforeStart: number; refundablePercent: string }[] =
    [];
  for (const [index, row] of input.rows.entries()) {
    const hours = noticeToHours(row.amount, row.unit);
    if (hours === null) {
      return { ok: false, row: index, problem: "notice_invalid" };
    }
    const percent = row.percent.trim();
    if (!PERCENT_PATTERN.test(percent) || Number(percent) > 100) {
      return { ok: false, row: index, problem: "percent_invalid" };
    }
    if (windows.some((window) => window.minHoursBeforeStart === hours)) {
      return { ok: false, row: index, problem: "duplicate_notice" };
    }
    windows.push({ minHoursBeforeStart: hours, refundablePercent: percent });
  }
  const ordered = [...windows].sort(
    (a, b) => b.minHoursBeforeStart - a.minHoursBeforeStart
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (
      Number(ordered[index]!.refundablePercent) >
      Number(ordered[index - 1]!.refundablePercent)
    ) {
      return { ok: false, row: null, problem: "refund_grows" };
    }
  }
  return {
    ok: true,
    body: {
      productId: input.productId,
      refundBasis:
        input.refundBasis === "per_night" ? "per_night" : "whole_stay",
      noShowRetention:
        input.noShowRetention === "retain_all" ||
        input.noShowRetention === "refund_per_windows"
          ? input.noShowRetention
          : "retain_deposit",
      windows: ordered
    }
  };
}
