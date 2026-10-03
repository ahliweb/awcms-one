/**
 * POS registers, register sessions and cash-up (Issue #284, epic #281,
 * ADR-0028) — the PURE half: vocabulary, request validation, and the exact-
 * money arithmetic of a cash-up. No database, no I/O (the application layer,
 * `application/register-*.ts`, reads the ledger and movements and hands the
 * sums in), so every rule below is unit-testable.
 *
 * ## Money
 *
 * Every amount is a `numeric(14,2)` STRING on the wire (ADR-0003) and every
 * sum is integer cents (`bigint`) — never `Number`, never floating point. A
 * signed amount (a variance, a correction) is rendered through
 * {@link signedFromCents} because `price-calculation.ts`'s `fromCents` is for
 * non-negative amounts only.
 *
 * ## What "expected" means
 *
 *   expected(cash)  = opening float
 *                   + Σ succeeded cash payment legs stamped with the session
 *                   − Σ succeeded cash reversal legs stamped with the session
 *                   + Σ drawer movements in − Σ drawer movements out
 *   expected(other) = Σ succeeded payments − Σ succeeded reversals of that
 *                     tender stamped with the session
 *
 * (A cash payment leg's `amount` is what was APPLIED to the sale — change is
 * already excluded, so the drawer arithmetic is exact.)
 *
 * ## The approval threshold
 *
 * A close needs a user holding the approve permission when the GROSS variance
 * — the sum of the ABSOLUTE per-tender variances — is strictly greater than
 * the tenant's `cashUp.approvalThreshold`. Gross, not net: a cash surplus must
 * not be able to hide a QRIS shortfall by netting to zero. The default
 * threshold is `0.00` (any discrepancy needs a supervisor): safe by default,
 * relaxed by the tenant deliberately.
 */
import {
  isRecord,
  optionalText,
  PAYMENT_TENDER_TYPES,
  positiveMoney,
  validateIdempotencyKey,
  type PaymentTenderType,
  type ValidationError
} from "./payment-allocation";
import { fromCents, toCents } from "./price-calculation";

export type { ValidationError };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const REGISTER_SESSION_STATUSES = [
  "open",
  "closing",
  "closed",
  "corrected"
] as const;
export type RegisterSessionStatus = (typeof REGISTER_SESSION_STATUSES)[number];

/** A session in one of these states is "active": it holds the register's single active slot. */
export const ACTIVE_REGISTER_SESSION_STATUSES = ["open", "closing"] as const;

export const REGISTER_MOVEMENT_TYPES = [
  "cash_in",
  "cash_out",
  "safe_drop",
  "expense",
  "transfer",
  "correction"
] as const;
export type RegisterMovementType = (typeof REGISTER_MOVEMENT_TYPES)[number];

export type RegisterMovementDirection = "in" | "out";

/** The direction a movement type is allowed to take; `either` means the caller chooses. */
export const MOVEMENT_TYPE_DIRECTION: Readonly<
  Record<RegisterMovementType, RegisterMovementDirection | "either">
> = {
  cash_in: "in",
  cash_out: "out",
  safe_drop: "out",
  expense: "out",
  transfer: "either",
  correction: "either"
};

export const REGISTER_CLOSE_DECISIONS = [
  "auto",
  "pending",
  "approved",
  "rejected"
] as const;
export type RegisterCloseDecision = (typeof REGISTER_CLOSE_DECISIONS)[number];

/** Report/ordering order of the tender lines. */
export const REGISTER_TENDER_ORDER: readonly PaymentTenderType[] =
  PAYMENT_TENDER_TYPES;

export const DEFAULT_CASH_UP_APPROVAL_THRESHOLD = "0.00";

const MAX_REGISTER_CODE = 40;
const MAX_REGISTER_NAME = 120;
const MAX_LOCATION_LABEL = 120;
const MAX_REFERENCE = 100;
const MAX_NOTE = 500;
const MAX_CORRECTION_LINES = PAYMENT_TENDER_TYPES.length;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A non-negative `numeric(14,2)`-shaped string; zero is allowed (an empty float, a zero count). */
const NON_NEGATIVE_MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const SIGNED_MONEY_PATTERN = /^-?\d{1,12}(\.\d{1,2})?$/;
const REGISTER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Integer cents -> `numeric(14,2)` string, sign preserved (`-5.50`). */
export function signedFromCents(cents: bigint): string {
  return cents < 0n ? `-${fromCents(-cents)}` : fromCents(cents);
}

/** `numeric(14,2)` string (optionally signed) -> integer cents. */
export function signedToCents(value: string): bigint {
  return value.startsWith("-") ? -toCents(value.slice(1)) : toCents(value);
}

/** Re-renders a possibly-negative `numeric(14,2)` read from the database as the canonical two-decimal string (`"0.00"`, never `"0"`; `"-5.50"`). */
export function normalizeSignedMoney(value: string): string {
  return signedFromCents(signedToCents(value));
}

function absCents(value: bigint): bigint {
  return value < 0n ? -value : value;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function requiredText(
  value: unknown,
  field: string,
  max: number,
  errors: ValidationError[]
): string {
  const text = optionalText(value, field, max, errors);
  if (text === null && !errors.some((error) => error.field === field)) {
    errors.push({ field, message: `${field} is required.` });
  }
  return text ?? "";
}

function nonNegativeMoney(
  value: unknown,
  field: string,
  errors: ValidationError[]
): string {
  if (typeof value !== "string" || !NON_NEGATIVE_MONEY_PATTERN.test(value)) {
    errors.push({
      field,
      message: `${field} must be a numeric(14,2) string (digits with at most two decimals), never a JSON number.`
    });
    return "0.00";
  }
  return fromCents(toCents(value));
}

export type CreateRegisterInput = {
  code: string;
  name: string;
  locationLabel: string | null;
};

export function validateCreateRegisterInput(
  body: unknown
): ValidationResult<CreateRegisterInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const code = requiredText(record.code, "code", MAX_REGISTER_CODE, errors);
  if (code.length > 0 && !REGISTER_CODE_PATTERN.test(code)) {
    errors.push({
      field: "code",
      message:
        "code may contain only letters, digits, '.', '_' and '-', and must start with a letter or digit."
    });
  }
  const name = requiredText(record.name, "name", MAX_REGISTER_NAME, errors);
  const locationLabel = optionalText(
    record.locationLabel,
    "locationLabel",
    MAX_LOCATION_LABEL,
    errors
  );
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { code, name, locationLabel } };
}

export type UpdateRegisterInput = {
  name?: string;
  /** `null` clears the label. */
  locationLabel?: string | null;
  active?: boolean;
};

export function validateUpdateRegisterInput(
  body: unknown
): ValidationResult<UpdateRegisterInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const value: UpdateRegisterInput = {};

  if (record.name !== undefined) {
    value.name = requiredText(record.name, "name", MAX_REGISTER_NAME, errors);
  }
  if (record.locationLabel !== undefined) {
    value.locationLabel = optionalText(
      record.locationLabel,
      "locationLabel",
      MAX_LOCATION_LABEL,
      errors
    );
  }
  if (record.active !== undefined) {
    if (typeof record.active === "boolean") {
      value.active = record.active;
    } else {
      errors.push({ field: "active", message: "active must be a boolean." });
    }
  }
  if (record.code !== undefined) {
    errors.push({
      field: "code",
      message: "A register's code never changes."
    });
  }
  if (Object.keys(value).length === 0 && errors.length === 0) {
    errors.push({
      field: "body",
      message: "Provide at least one of name, locationLabel, active."
    });
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value };
}

export type OpenSessionInput = {
  idempotencyKey: string;
  registerId: string;
  openingFloat: string;
};

export function validateOpenSessionInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<OpenSessionInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  if (!isUuid(record.registerId)) {
    errors.push({
      field: "registerId",
      message: "registerId must be a UUID."
    });
  }
  const openingFloat = nonNegativeMoney(
    record.openingFloat,
    "openingFloat",
    errors
  );
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      registerId: record.registerId as string,
      openingFloat
    }
  };
}

export type RecordMovementInput = {
  idempotencyKey: string;
  movementType: RegisterMovementType;
  direction: RegisterMovementDirection;
  /** Positive `numeric(14,2)` string. */
  amount: string;
  reference: string | null;
  note: string | null;
};

export function validateRecordMovementInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<RecordMovementInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);

  const typeValid =
    typeof record.movementType === "string" &&
    (REGISTER_MOVEMENT_TYPES as readonly string[]).includes(
      record.movementType
    );
  if (!typeValid) {
    errors.push({
      field: "movementType",
      message: `movementType must be one of: ${REGISTER_MOVEMENT_TYPES.join(", ")}.`
    });
  }
  const movementType = record.movementType as RegisterMovementType;

  // A one-way type never takes a direction from the caller; a two-way type
  // (transfer, correction) must say which way the cash went.
  let direction: RegisterMovementDirection = "in";
  if (typeValid) {
    const fixed = MOVEMENT_TYPE_DIRECTION[movementType];
    if (fixed === "either") {
      if (record.direction === "in" || record.direction === "out") {
        direction = record.direction;
      } else {
        errors.push({
          field: "direction",
          message: `direction ("in" or "out") is required for a ${movementType} movement.`
        });
      }
    } else {
      direction = fixed;
      if (record.direction !== undefined && record.direction !== fixed) {
        errors.push({
          field: "direction",
          message: `A ${movementType} movement is always "${fixed}".`
        });
      }
    }
  }

  const amount = positiveMoney(record.amount, "amount", errors);
  const reference = optionalText(
    record.reference,
    "reference",
    MAX_REFERENCE,
    errors
  );
  const note = optionalText(record.note, "note", MAX_NOTE, errors);

  if (typeValid && reference === null) {
    if (movementType === "expense" || movementType === "transfer") {
      errors.push({
        field: "reference",
        message: `reference is required for a ${movementType} movement (what it was for, or where it went).`
      });
    }
  }
  if (typeValid && movementType === "correction" && note === null) {
    errors.push({
      field: "note",
      message: "note (the reason) is required for a correction movement."
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      movementType,
      direction,
      amount,
      reference,
      note
    }
  };
}

export type HandoverInput = {
  idempotencyKey: string;
  toTenantUserId: string;
  note: string | null;
};

export function validateHandoverInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<HandoverInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  if (!isUuid(record.toTenantUserId)) {
    errors.push({
      field: "toTenantUserId",
      message: "toTenantUserId must be a UUID."
    });
  }
  const note = optionalText(record.note, "note", MAX_NOTE, errors);
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      toTenantUserId: record.toTenantUserId as string,
      note
    }
  };
}

export type CloseSessionInput = {
  idempotencyKey: string;
  /** Counted amount per tender, `numeric(14,2)` strings (zero allowed). */
  counted: Partial<Record<PaymentTenderType, string>>;
  varianceReason: string | null;
};

export function validateCloseSessionInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<CloseSessionInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);

  const counted: Partial<Record<PaymentTenderType, string>> = {};
  if (!isRecord(record.counted)) {
    errors.push({
      field: "counted",
      message:
        "counted must be an object mapping a tender type to the counted amount."
    });
  } else {
    for (const [tender, amount] of Object.entries(record.counted)) {
      if (!(PAYMENT_TENDER_TYPES as readonly string[]).includes(tender)) {
        errors.push({
          field: `counted.${tender}`,
          message: `${tender} is not a tender type (${PAYMENT_TENDER_TYPES.join(", ")}).`
        });
        continue;
      }
      counted[tender as PaymentTenderType] = nonNegativeMoney(
        amount,
        `counted.${tender}`,
        errors
      );
    }
    if (Object.keys(counted).length === 0 && errors.length === 0) {
      errors.push({
        field: "counted",
        message: "counted must include at least the cash count."
      });
    }
  }
  const varianceReason = optionalText(
    record.varianceReason,
    "varianceReason",
    MAX_NOTE,
    errors
  );
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { idempotencyKey: key, counted, varianceReason }
  };
}

export type CloseDecisionInput = {
  idempotencyKey: string;
  decision: "approve" | "reject";
  note: string | null;
};

export function validateCloseDecisionInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<CloseDecisionInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  if (record.decision !== "approve" && record.decision !== "reject") {
    errors.push({
      field: "decision",
      message: 'decision must be "approve" or "reject".'
    });
  }
  const note = optionalText(record.note, "note", MAX_NOTE, errors);
  // A rejection sends the cashier back to recount: say why.
  if (record.decision === "reject" && note === null) {
    errors.push({
      field: "note",
      message: "note (the reason) is required to reject."
    });
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      decision: record.decision as "approve" | "reject",
      note
    }
  };
}

export type CorrectionAdjustment = {
  tenderType: PaymentTenderType;
  /** Signed, non-zero `numeric(14,2)` string: a delta to the COUNTED amount. */
  adjustment: string;
};

export type RecordCorrectionInput = {
  idempotencyKey: string;
  reason: string;
  adjustments: CorrectionAdjustment[];
};

export function validateRecordCorrectionInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<RecordCorrectionInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  const reason = requiredText(record.reason, "reason", MAX_NOTE, errors);

  const adjustments: CorrectionAdjustment[] = [];
  if (!Array.isArray(record.adjustments) || record.adjustments.length === 0) {
    errors.push({
      field: "adjustments",
      message: "adjustments must be a non-empty array."
    });
  } else if (record.adjustments.length > MAX_CORRECTION_LINES) {
    errors.push({
      field: "adjustments",
      message: `adjustments must contain at most ${MAX_CORRECTION_LINES} entries (one per tender).`
    });
  } else {
    const seen = new Set<string>();
    record.adjustments.forEach((entry: unknown, index: number) => {
      const prefix = `adjustments[${index}]`;
      if (!isRecord(entry)) {
        errors.push({ field: prefix, message: `${prefix} must be an object.` });
        return;
      }
      const tenderOk =
        typeof entry.tenderType === "string" &&
        (PAYMENT_TENDER_TYPES as readonly string[]).includes(entry.tenderType);
      if (!tenderOk) {
        errors.push({
          field: `${prefix}.tenderType`,
          message: `${prefix}.tenderType must be one of: ${PAYMENT_TENDER_TYPES.join(", ")}.`
        });
      } else if (seen.has(entry.tenderType as string)) {
        errors.push({
          field: `${prefix}.tenderType`,
          message: `${entry.tenderType as string} appears more than once.`
        });
      }
      if (
        typeof entry.adjustment !== "string" ||
        !SIGNED_MONEY_PATTERN.test(entry.adjustment)
      ) {
        errors.push({
          field: `${prefix}.adjustment`,
          message: `${prefix}.adjustment must be a signed numeric(14,2) string (e.g. "-5000.00"), never a JSON number.`
        });
      } else if (signedToCents(entry.adjustment) === 0n) {
        errors.push({
          field: `${prefix}.adjustment`,
          message: `${prefix}.adjustment must not be zero.`
        });
      } else if (tenderOk) {
        seen.add(entry.tenderType as string);
        adjustments.push({
          tenderType: entry.tenderType as PaymentTenderType,
          adjustment: signedFromCents(signedToCents(entry.adjustment))
        });
      }
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { idempotencyKey: key, reason, adjustments } };
}

// ---------------------------------------------------------------------------
// Tenant setting: the approval threshold
// ---------------------------------------------------------------------------

export type CashUpSettings = { approvalThreshold: string };

/**
 * Reads `cashUp.approvalThreshold` from a `commerce` module settings view's
 * `effective` object. The generic module-settings route validates only for
 * secrets, not for shape, so this is defensive: anything that is not a
 * non-negative `numeric(14,2)` string falls back to the strict default
 * (`0.00`) — a corrupt value can only make the close STRICTER, never looser.
 */
export function resolveCashUpSettings(
  effectiveSettings: Record<string, unknown> | null | undefined
): CashUpSettings {
  const raw = effectiveSettings?.cashUp;
  const threshold =
    isRecord(raw) &&
    typeof raw.approvalThreshold === "string" &&
    NON_NEGATIVE_MONEY_PATTERN.test(raw.approvalThreshold)
      ? fromCents(toCents(raw.approvalThreshold))
      : DEFAULT_CASH_UP_APPROVAL_THRESHOLD;
  return { approvalThreshold: threshold };
}

/** Validates the value the admin form sends before it is PATCHed into module settings. */
export function validateApprovalThreshold(value: unknown): string | null {
  return typeof value === "string" && NON_NEGATIVE_MONEY_PATTERN.test(value)
    ? fromCents(toCents(value))
    : null;
}

// ---------------------------------------------------------------------------
// Expected totals
// ---------------------------------------------------------------------------

export type TenderLedgerSum = {
  tenderType: PaymentTenderType;
  /** Σ succeeded payment legs stamped with the session. */
  paymentsCents: bigint;
  /** Σ succeeded reversal legs stamped with the session. */
  reversalsCents: bigint;
};

export type ExpectedTenderLine = {
  tenderType: PaymentTenderType;
  payments: string;
  reversals: string;
  /** Cash only: the counted opening float (`"0.00"` for every other tender). */
  openingFloat: string;
  /** Cash only: Σ movements in. */
  movementsIn: string;
  /** Cash only: Σ movements out. */
  movementsOut: string;
  /** What the drawer / the tender's settlement should hold, signed. */
  expected: string;
};

function tenderIndex(tenderType: PaymentTenderType): number {
  return REGISTER_TENDER_ORDER.indexOf(tenderType);
}

/**
 * The expected closing amount per tender. Cash is ALWAYS present (a drawer
 * with no cash sales still holds its float); any other tender appears only if
 * the ledger recorded activity for it.
 */
export function computeExpectedLines(input: {
  openingFloatCents: bigint;
  ledger: readonly TenderLedgerSum[];
  movementsInCents: bigint;
  movementsOutCents: bigint;
}): ExpectedTenderLine[] {
  const byTender = new Map<PaymentTenderType, TenderLedgerSum>();
  for (const sum of input.ledger) {
    const existing = byTender.get(sum.tenderType);
    byTender.set(
      sum.tenderType,
      existing
        ? {
            tenderType: sum.tenderType,
            paymentsCents: existing.paymentsCents + sum.paymentsCents,
            reversalsCents: existing.reversalsCents + sum.reversalsCents
          }
        : sum
    );
  }
  if (!byTender.has("cash")) {
    byTender.set("cash", {
      tenderType: "cash",
      paymentsCents: 0n,
      reversalsCents: 0n
    });
  }

  return [...byTender.values()]
    .sort((a, b) => tenderIndex(a.tenderType) - tenderIndex(b.tenderType))
    .map((sum) => {
      const isCash = sum.tenderType === "cash";
      const net = sum.paymentsCents - sum.reversalsCents;
      const expected = isCash
        ? input.openingFloatCents +
          net +
          input.movementsInCents -
          input.movementsOutCents
        : net;
      return {
        tenderType: sum.tenderType,
        payments: fromCents(sum.paymentsCents),
        reversals: fromCents(sum.reversalsCents),
        openingFloat: isCash ? fromCents(input.openingFloatCents) : "0.00",
        movementsIn: isCash ? fromCents(input.movementsInCents) : "0.00",
        movementsOut: isCash ? fromCents(input.movementsOutCents) : "0.00",
        expected: signedFromCents(expected)
      };
    });
}

// ---------------------------------------------------------------------------
// Count -> variance -> approval
// ---------------------------------------------------------------------------

export type CountedTenderLine = {
  tenderType: PaymentTenderType;
  expected: string;
  counted: string;
  /** counted − expected, signed (negative = short). */
  variance: string;
};

export type CountEvaluation = {
  lines: CountedTenderLine[];
  /** Σ variance (net), signed. */
  varianceTotal: string;
  /** Σ |variance| — the figure compared with the approval threshold. */
  varianceGross: string;
  hasVariance: boolean;
  approvalRequired: boolean;
};

export class MissingCountError extends Error {
  readonly tenderTypes: PaymentTenderType[];
  constructor(tenderTypes: PaymentTenderType[]) {
    super(`A counted amount is required for: ${tenderTypes.join(", ")}.`);
    this.name = "MissingCountError";
    this.tenderTypes = tenderTypes;
  }
}

/**
 * Compares the counted amounts with the expected lines.
 *
 * A count is REQUIRED for cash and for every tender whose ledger recorded any
 * activity (a payment or a reversal) or whose expected amount is not zero —
 * leaving one out would let a shortfall hide behind a missing field. A tender
 * with no activity may be omitted (counted 0). A counted tender the ledger
 * knows nothing about is accepted as expected 0 (a surplus is still a
 * variance to explain).
 *
 * @throws {MissingCountError} a required tender has no counted amount.
 */
export function evaluateCount(
  expectedLines: readonly ExpectedTenderLine[],
  counted: Partial<Record<PaymentTenderType, string>>,
  approvalThreshold: string
): CountEvaluation {
  const missing: PaymentTenderType[] = [];
  const lines = new Map<PaymentTenderType, CountedTenderLine>();

  for (const line of expectedLines) {
    const given = counted[line.tenderType];
    const required =
      line.tenderType === "cash" ||
      toCents(line.payments) !== 0n ||
      toCents(line.reversals) !== 0n ||
      signedToCents(line.expected) !== 0n;
    if (given === undefined && required) {
      missing.push(line.tenderType);
      continue;
    }
    const countedCents = given === undefined ? 0n : toCents(given);
    lines.set(line.tenderType, {
      tenderType: line.tenderType,
      expected: line.expected,
      counted: fromCents(countedCents),
      variance: signedFromCents(countedCents - signedToCents(line.expected))
    });
  }
  if (missing.length > 0) throw new MissingCountError(missing);

  for (const [tenderType, amount] of Object.entries(counted) as [
    PaymentTenderType,
    string
  ][]) {
    if (lines.has(tenderType)) continue;
    const countedCents = toCents(amount);
    lines.set(tenderType, {
      tenderType,
      expected: "0.00",
      counted: fromCents(countedCents),
      variance: signedFromCents(countedCents)
    });
  }

  const ordered = [...lines.values()].sort(
    (a, b) => tenderIndex(a.tenderType) - tenderIndex(b.tenderType)
  );
  let total = 0n;
  let gross = 0n;
  for (const line of ordered) {
    const variance = signedToCents(line.variance);
    total += variance;
    gross += absCents(variance);
  }
  return {
    lines: ordered,
    varianceTotal: signedFromCents(total),
    varianceGross: fromCents(gross),
    hasVariance: gross > 0n,
    approvalRequired: gross > toCents(approvalThreshold)
  };
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export type CorrectionRow = {
  tenderType: PaymentTenderType;
  adjustment: string;
};

export type EffectiveTenderLine = CountedTenderLine & {
  /** Σ corrections applied to this tender's counted amount. */
  correction: string;
  /** The counted amount after corrections. */
  effectiveCounted: string;
  /** effectiveCounted − expected. */
  effectiveVariance: string;
};

export class NegativeCorrectedCountError extends Error {
  readonly tenderType: PaymentTenderType;
  constructor(tenderType: PaymentTenderType) {
    super(
      `The correction would make the counted ${tenderType} amount negative.`
    );
    this.name = "NegativeCorrectedCountError";
    this.tenderType = tenderType;
  }
}

/**
 * The close lines with every correction applied: effective counted = counted
 * + Σ adjustments, effective variance = effective counted − expected. The
 * original lines are never changed (the result is a new array). A correction
 * for a tender the original close did not count starts from counted 0 /
 * expected 0.
 *
 * @throws {NegativeCorrectedCountError} an effective counted amount < 0.
 */
export function applyCorrections(
  lines: readonly CountedTenderLine[],
  corrections: readonly CorrectionRow[]
): EffectiveTenderLine[] {
  const adjustmentByTender = new Map<PaymentTenderType, bigint>();
  for (const correction of corrections) {
    adjustmentByTender.set(
      correction.tenderType,
      (adjustmentByTender.get(correction.tenderType) ?? 0n) +
        signedToCents(correction.adjustment)
    );
  }
  const base = new Map<PaymentTenderType, CountedTenderLine>(
    lines.map((line) => [line.tenderType, line])
  );
  for (const tenderType of adjustmentByTender.keys()) {
    if (!base.has(tenderType)) {
      base.set(tenderType, {
        tenderType,
        expected: "0.00",
        counted: "0.00",
        variance: "0.00"
      });
    }
  }
  return [...base.values()]
    .sort((a, b) => tenderIndex(a.tenderType) - tenderIndex(b.tenderType))
    .map((line) => {
      const adjustment = adjustmentByTender.get(line.tenderType) ?? 0n;
      const effective = toCents(line.counted) + adjustment;
      if (effective < 0n)
        throw new NegativeCorrectedCountError(line.tenderType);
      return {
        ...line,
        correction: signedFromCents(adjustment),
        effectiveCounted: fromCents(effective),
        effectiveVariance: signedFromCents(
          effective - signedToCents(line.expected)
        )
      };
    });
}

/** `Σ effectiveVariance`, signed. */
export function sumEffectiveVariance(
  lines: readonly EffectiveTenderLine[]
): string {
  return signedFromCents(
    lines.reduce((sum, line) => sum + signedToCents(line.effectiveVariance), 0n)
  );
}

// ---------------------------------------------------------------------------
// The cash-up report (shape shared by the application, the API and the CSV)
// ---------------------------------------------------------------------------

export type ReportTenderLine = {
  tenderType: PaymentTenderType;
  payments: string;
  reversals: string;
  /** Cash: float + net + movements. Other tenders: net of payments − reversals. Signed. */
  expected: string;
  /** `null` until a close was requested. */
  counted: string | null;
  variance: string | null;
  /** Σ post-close corrections to the counted amount (`"0.00"` when none). */
  correction: string;
  effectiveCounted: string | null;
  effectiveVariance: string | null;
};

export type ReportMovement = {
  id: string;
  movementType: RegisterMovementType;
  direction: RegisterMovementDirection;
  amount: string;
  reference: string | null;
  note: string | null;
  actorTenantUserId: string;
  createdAt: string;
};

export type ReportCloseRequest = {
  id: string;
  attempt: number;
  requestedByTenantUserId: string;
  requestedAt: string;
  varianceTotal: string;
  varianceGross: string;
  approvalThreshold: string;
  approvalRequired: boolean;
  varianceReason: string | null;
  decision: RegisterCloseDecision;
  decidedByTenantUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

export type ReportCorrection = {
  correctionId: string;
  tenderType: PaymentTenderType;
  adjustment: string;
  reason: string;
  actorTenantUserId: string;
  createdAt: string;
};

export type RegisterCashUpReport = {
  register: {
    id: string;
    code: string;
    name: string;
    locationLabel: string | null;
  };
  session: {
    id: string;
    status: RegisterSessionStatus;
    openedAt: string;
    openedByTenantUserId: string;
    currentCashierTenantUserId: string;
    closedAt: string | null;
    closedByTenantUserId: string | null;
  };
  /** `true` while the figures are derived live (open/closing); `false` once they are the stored close snapshot. */
  live: boolean;
  openingFloat: string;
  /** Sales attached to the session, cancelled/expired ones excluded. */
  sales: { count: number; total: string };
  tenders: ReportTenderLine[];
  movementTotals: { in: string; out: string };
  movements: ReportMovement[];
  closeRequests: ReportCloseRequest[];
  /** The variance of the closing request (the approved/auto one, or the pending one); `null` before any close request. */
  variance: {
    total: string;
    gross: string;
    reason: string | null;
    approvalThreshold: string;
    decision: RegisterCloseDecision;
  } | null;
  corrections: ReportCorrection[];
};
