/**
 * Employee-commission sale attribution (Issue #391, ADR-0046) - the PURE half:
 * vocabulary, request validation, and the three decisions the order-paid
 * consumer takes (who earns, on what base, on which day). No database, no I/O;
 * `application/commission-attribution.ts` reads the order and hands the facts in.
 *
 * ## What this adapter is, and is not
 *
 * It reports a SALE FACT to the `hr_commission` accrual ledger through the
 * neutral `CommissionAccrualPort` (`_shared/ports/commission-accrual-port.ts`):
 * "this paid POS order line, worth this much net, was rung up by this employee".
 * The ledger owns the arithmetic (which rule, what rate, rounding) and the
 * lifecycle (approve, pay, void). Nothing here knows a rate, an amount of
 * commission, or an accrual state, and no consumer's own commission scheme lives
 * here: the tenant authors the rule in `hr_commission` and names its key in the
 * settings (ADR-0024: a reusable adapter, no consumer-specific rules).
 *
 * ## Who earns - never the client's word (threat model F5, row T)
 *
 * The beneficiary is derived on the server from two facts the client cannot set:
 * the order was rung up at the counter (`channel = 'pos'`), and the login that
 * rang it up (`pos_cashier_tenant_user_id`, stamped from the authenticated
 * session by `pos-directory.ts`) has a LIVE staff link to an employment. A
 * storefront order, a POS order with no stamp, and a login with no live link are
 * all NOT attributed - there is no fallback beneficiary and no default employee.
 *
 * ## The base - what the customer actually paid for the line
 *
 * The base amount of a line is its `line_total` less its share of the order-level
 * discounts (`discount` + `loyalty_discount`, the same two figures the loyalty
 * earner nets off), allocated pro rata by line total in integer cents with the
 * remainder handed out largest-fraction-first, so the shares always add up to the
 * discount exactly and the same order always yields the same shares (a redelivery
 * must reproduce the request byte for byte, or the ledger rightly calls it a
 * conflict). Shipping, insurance and tax are never part of it. Lines whose net is
 * zero are not reported (a zero commission is noise, not a record).
 */
import { fromCents, toCents } from "./price-calculation";
import { allocateOrderDiscount } from "./returns";
import {
  resolveSalesReportDay,
  SALES_REPORT_TIME_ZONE
} from "./sales-report-deltas";
import type {
  CommissionAccrualOutcome,
  CommissionVoidOutcome
} from "../../_shared/ports/commission-accrual-port";

export type CommissionValidationError = { field: string; message: string };
type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: CommissionValidationError[] };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The neutral default: what the adapter reports is one order line. A rule must declare the same `sourceType`. */
export const COMMISSION_DEFAULT_SOURCE_TYPE = "commerce_order_line";

/**
 * Commerce is single-currency (IDR): `documents` and `quotation_versions` CHECK
 * it and the tax cutover posts it. The order has no currency column to read, so
 * the adapter states the module's own currency; a rule in another currency is
 * refused by the port (`currency_mismatch`), never converted.
 */
export const COMMISSION_CURRENCY_CODE = "IDR";

/** Same shape `hr_commission` validates a rule key and a source type with (lower-case code). */
export const COMMISSION_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,62}$/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Order statuses a commission may be reported for: every status AFTER payment that is not a cancellation (the loyalty earner's own set). */
export const COMMISSIONABLE_ORDER_STATUSES: readonly string[] = [
  "paid",
  "processing",
  "shipped",
  "completed"
];

/** Why the consumer reported nothing for an order. A skip is a normal outcome, not a failure. */
export const COMMISSION_SKIP_REASONS = [
  "disabled",
  "hr_commission_disabled",
  "order_not_found",
  "order_not_commissionable",
  "not_a_counter_sale",
  "no_cashier_stamp",
  "no_staff_link",
  "no_commissionable_lines",
  // Reversal-only reasons (ADR-0046 D9).
  "no_reversal_actor",
  "return_not_settled",
  "return_not_found"
] as const;
export type CommissionSkipReason = (typeof COMMISSION_SKIP_REASONS)[number];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[]
): CommissionValidationError[] {
  return Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ field: key, message: `${key} is not a known field.` }));
}

export function isCommissionUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export type CommissionSettingsInput = {
  enabled: boolean;
  ruleKey: string | null;
  sourceType: string;
};

/** `PUT` body of the settings route. `enabled` is required; the adapter cannot be switched on without a rule key. */
export function validateCommissionSettingsInput(
  value: unknown
): ValidationResult<CommissionSettingsInput> {
  if (!isRecord(value)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "body must be a JSON object." }]
    };
  }

  const errors = unknownFields(value, ["enabled", "ruleKey", "sourceType"]);

  if (typeof value.enabled !== "boolean") {
    errors.push({ field: "enabled", message: "enabled must be a boolean." });
  }

  let ruleKey: string | null = null;
  if (value.ruleKey !== undefined && value.ruleKey !== null) {
    if (
      typeof value.ruleKey !== "string" ||
      !COMMISSION_CODE_PATTERN.test(value.ruleKey)
    ) {
      errors.push({
        field: "ruleKey",
        message:
          "ruleKey must be a lower-case code of 1 to 63 characters (letters, digits, '_', '.', '-'), starting with a letter."
      });
    } else {
      ruleKey = value.ruleKey;
    }
  }

  let sourceType = COMMISSION_DEFAULT_SOURCE_TYPE;
  if (value.sourceType !== undefined) {
    if (
      typeof value.sourceType !== "string" ||
      !COMMISSION_CODE_PATTERN.test(value.sourceType)
    ) {
      errors.push({
        field: "sourceType",
        message:
          "sourceType must be a lower-case code of 1 to 63 characters (letters, digits, '_', '.', '-'), starting with a letter."
      });
    } else {
      sourceType = value.sourceType;
    }
  }

  if (value.enabled === true && ruleKey === null) {
    errors.push({
      field: "ruleKey",
      message: "ruleKey is required to switch commission attribution on."
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { enabled: value.enabled as boolean, ruleKey, sourceType }
  };
}

export type CreateStaffLinkInput = {
  tenantUserId: string;
  employmentId: string;
};

/** `POST` body of the staff-links route. Both ids are opaque uuids; the employment is validated by the ledger when an accrual is written. */
export function validateCreateStaffLinkInput(
  value: unknown
): ValidationResult<CreateStaffLinkInput> {
  if (!isRecord(value)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "body must be a JSON object." }]
    };
  }

  const errors = unknownFields(value, ["tenantUserId", "employmentId"]);

  if (!isCommissionUuid(value.tenantUserId)) {
    errors.push({
      field: "tenantUserId",
      message: "tenantUserId must be a UUID."
    });
  }
  if (!isCommissionUuid(value.employmentId)) {
    errors.push({
      field: "employmentId",
      message: "employmentId must be a UUID."
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      tenantUserId: (value.tenantUserId as string).toLowerCase(),
      employmentId: (value.employmentId as string).toLowerCase()
    }
  };
}

// ---------------------------------------------------------------------------
// Who earns
// ---------------------------------------------------------------------------

export type OrderAttributionFacts = {
  status: string;
  /** `awcms_commerce_orders.payment_status`: `paid` only once the order is settled in full (a deposit is `dp_paid`, a refund `refunded`). */
  paymentStatus: string;
  channel: string;
  /** The login that rang the sale up, stamped server-side; `null` for a storefront order. */
  posCashierTenantUserId: string | null;
};

export type AttributionDecision =
  | { kind: "attribute"; tenantUserId: string }
  | { kind: "skip"; reason: CommissionSkipReason };

/**
 * Whether an order is attributable at all, and to which login. The employment is
 * resolved from the staff link by the caller - a login with no live link is a
 * separate skip ({@link decideBeneficiary}) so the two reasons stay distinct in
 * the audit trail.
 */
export function decideAttributableLogin(
  facts: OrderAttributionFacts
): AttributionDecision {
  if (
    !COMMISSIONABLE_ORDER_STATUSES.includes(facts.status) ||
    facts.paymentStatus !== "paid"
  ) {
    return { kind: "skip", reason: "order_not_commissionable" };
  }
  if (facts.channel !== "pos") {
    return { kind: "skip", reason: "not_a_counter_sale" };
  }
  if (!facts.posCashierTenantUserId) {
    return { kind: "skip", reason: "no_cashier_stamp" };
  }
  return { kind: "attribute", tenantUserId: facts.posCashierTenantUserId };
}

export type BeneficiaryDecision =
  | { kind: "attribute"; employmentId: string }
  | { kind: "skip"; reason: CommissionSkipReason };

/** The full beneficiary decision: attributable login + live staff link -> employment. */
export function decideBeneficiary(
  facts: OrderAttributionFacts,
  liveLinkEmploymentId: string | null
): BeneficiaryDecision {
  const login = decideAttributableLogin(facts);
  if (login.kind === "skip") return login;
  if (!liveLinkEmploymentId) return { kind: "skip", reason: "no_staff_link" };
  return { kind: "attribute", employmentId: liveLinkEmploymentId };
}

// ---------------------------------------------------------------------------
// On what base
// ---------------------------------------------------------------------------

export type CommissionLine = {
  /** The order-line id; becomes the source `line`. */
  id: string;
  /** `numeric(14,2)` string. */
  lineTotal: string;
};

export type CommissionLineBase = {
  id: string;
  /** `numeric(14,2)` string, never negative. */
  baseAmount: string;
};

/**
 * Each line's net base: its total less its pro-rata share of `orderDiscount`
 * (a `numeric(14,2)` string). Integer cents throughout, and the SAME largest-
 * remainder allocation the returns module uses (`allocateOrderDiscount`) - one
 * allocation, not a second one, so a later refund-driven correction maps to
 * the same per-line figures. The shares sum to the discount EXACTLY (clamped to
 * the goods, so a net is never negative) and depend only on the lines in the
 * order given: `lines` MUST be in a stable order (the caller sorts by
 * `created_at, id`).
 */
export function allocateLineBases(
  lines: readonly CommissionLine[],
  orderDiscount: string
): CommissionLineBase[] {
  const totals = lines.map((line) => toCents(line.lineTotal));
  const discount = toCents(orderDiscount);
  const shares = allocateOrderDiscount(totals, discount > 0n ? discount : 0n);

  return lines.map((line, index) => {
    const net = (totals[index] ?? 0n) - (shares[index] ?? 0n);
    return { id: line.id, baseAmount: fromCents(net < 0n ? 0n : net) };
  });
}

// ---------------------------------------------------------------------------
// The source identity and the request
// ---------------------------------------------------------------------------

export type CommissionSourceIdentity = {
  type: string;
  ref: string;
  line: string;
};

/**
 * The ledger's idempotency key for one line: `(source type, order id, order-line
 * id)` (plus the employment, which the ledger adds). Stable by construction - an
 * order id and a line id never change - so a redelivered event reproduces it.
 * Ids are lower-cased uuids, inside the port's `[A-Za-z0-9_.:-]` alphabet.
 */
export function commissionSourceIdentity(
  sourceType: string,
  orderId: string,
  orderLineId: string
): CommissionSourceIdentity {
  return {
    type: sourceType,
    ref: orderId.toLowerCase(),
    line: orderLineId.toLowerCase()
  };
}

/** The civil date `YYYY-MM-DD` of the paid instant in the tenant's own time zone; an unusable zone falls back to commerce's reporting zone. */
export function commissionOccurredOn(paidAt: Date, timeZone: string): string {
  try {
    return resolveSalesReportDay(paidAt, timeZone);
  } catch {
    return resolveSalesReportDay(paidAt, SALES_REPORT_TIME_ZONE);
  }
}

// ---------------------------------------------------------------------------
// What the ledger answered
// ---------------------------------------------------------------------------

export type OutcomeClass =
  "accrued" | "replayed" | "refused" | "conflict" | "invalid";

/** Refusals that say the SAME thing for every line of the order (so the consumer stops at the first). */
const ORDER_WIDE_REFUSALS: readonly CommissionAccrualOutcome["outcome"][] = [
  "no_effective_rule",
  "rule_ambiguous",
  "source_type_mismatch",
  "currency_mismatch",
  "employment_not_found",
  "employment_not_eligible"
];

export function classifyAccrualOutcome(
  outcome: CommissionAccrualOutcome
): OutcomeClass {
  switch (outcome.outcome) {
    case "accrued":
      return "accrued";
    case "replayed":
      return "replayed";
    case "source_conflict":
      return "conflict";
    case "input_invalid":
      return "invalid";
    default:
      return "refused";
  }
}

export function isOrderWideRefusal(outcome: CommissionAccrualOutcome): boolean {
  return ORDER_WIDE_REFUSALS.includes(outcome.outcome);
}

export type OutcomeTally = {
  accrued: number;
  replayed: number;
  /** Refusal code -> count (the port's own outcome names; no amount, no reference). */
  refused: Record<string, number>;
  conflicts: number;
  invalid: number;
};

export function emptyTally(): OutcomeTally {
  return { accrued: 0, replayed: 0, refused: {}, conflicts: 0, invalid: 0 };
}

export function tallyOutcome(
  tally: OutcomeTally,
  outcome: CommissionAccrualOutcome
): void {
  switch (classifyAccrualOutcome(outcome)) {
    case "accrued":
      tally.accrued += 1;
      break;
    case "replayed":
      tally.replayed += 1;
      break;
    case "conflict":
      tally.conflicts += 1;
      break;
    case "invalid":
      tally.invalid += 1;
      break;
    case "refused":
      tally.refused[outcome.outcome] =
        (tally.refused[outcome.outcome] ?? 0) + 1;
      break;
  }
}

// ---------------------------------------------------------------------------
// Reversal (ADR-0046 D9): cancel and refund void the accrual by source identity
// ---------------------------------------------------------------------------

/** The `reason` CODE handed to `CommissionAccrualPort.void` (a code, never free text). */
export const COMMISSION_VOID_REASON_ORDER_CANCELLED = "order_cancelled";
export const COMMISSION_VOID_REASON_LINE_RETURNED = "line_returned";

/**
 * Whether a line's accrual is reversed by refunds: ONLY when every unit of the
 * line has been returned, across all completed returns of the order. The port
 * voids a whole accrual, irreversibly (a voided accrual is never resurrected by
 * a redelivery), so a partly returned line keeps its accrual and is left for a
 * human (ADR-0046 D9: the conservative option - the ledger never loses a
 * commission on units the customer kept).
 */
export function isLineFullyReturned(
  orderedQuantity: number,
  returnedQuantity: number
): boolean {
  return orderedQuantity > 0 && returnedQuantity >= orderedQuantity;
}

export type VoidTally = {
  voided: number;
  alreadyVoided: number;
  /** Nothing was accrued for that line and employment: the normal case for a line below the threshold, a rule-less tenant or a sale that was refused. */
  notFound: number;
  /** Lines of a partly returned order line left untouched (a human decides). */
  partial: number;
  /** `payable` / `paid` accruals: a clawback for a human. NEVER retried. */
  periodClosed: Record<"payable" | "paid", number>;
  actorRequired: number;
  invalid: number;
};

export function emptyVoidTally(): VoidTally {
  return {
    voided: 0,
    alreadyVoided: 0,
    notFound: 0,
    partial: 0,
    periodClosed: { payable: 0, paid: 0 },
    actorRequired: 0,
    invalid: 0
  };
}

export function tallyVoidOutcome(
  tally: VoidTally,
  outcome: CommissionVoidOutcome
): void {
  switch (outcome.outcome) {
    case "voided":
      tally.voided += 1;
      break;
    case "already_voided":
      tally.alreadyVoided += 1;
      break;
    case "not_found":
      tally.notFound += 1;
      break;
    case "period_closed":
      tally.periodClosed[outcome.status] += 1;
      break;
    case "actor_required":
      tally.actorRequired += 1;
      break;
    case "input_invalid":
      tally.invalid += 1;
      break;
  }
}

/** True when a human has to look: money the ledger would not reverse, or a reversal that could not be attributed. */
export function voidNeedsAttention(tally: VoidTally): boolean {
  return (
    tally.periodClosed.payable + tally.periodClosed.paid > 0 ||
    tally.actorRequired > 0 ||
    tally.invalid > 0 ||
    tally.partial > 0
  );
}
