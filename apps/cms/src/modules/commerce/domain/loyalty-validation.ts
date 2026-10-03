/**
 * Loyalty request validation — Issue #289. Pure — no database, no I/O.
 * Shaped after `voucher-validation.ts`: a `ValidationResult<T>` union with
 * `{ field, message }` errors, field-by-field checks, and normalised output so
 * what reaches the application layer is already in its canonical form.
 *
 * Covers four inputs: a program create/update body, a redemption, a manual
 * adjustment, and the idempotency-key header the last two share.
 */
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LEDGER_POINTS,
  MAX_LOYALTY_REASON_LENGTH
} from "./loyalty";
import { fromCents, toCents } from "./price-calculation";

export type ValidationError = { field: string; message: string };
export type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const MAX_NAME_LENGTH = 200;
const MAX_NOTES_LENGTH = 1000;
const MAX_POINTS_PER_UNIT = 1_000_000;
const MAX_EXPIRY_DAYS = 3650;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMoney(
  value: unknown,
  field: string,
  errors: ValidationError[]
): string | null {
  if (typeof value !== "string" || !MONEY_PATTERN.test(value.trim())) {
    errors.push({
      field,
      message: `${field} must be a decimal string with at most two fraction digits.`
    });
    return null;
  }
  return fromCents(toCents(value.trim()));
}

function parseIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  errors: ValidationError[]
): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    errors.push({ field, message: `${field} must be an integer.` });
    return null;
  }
  if (value < min || value > max) {
    errors.push({
      field,
      message: `${field} must be between ${min} and ${max}.`
    });
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Idempotency-Key
// ---------------------------------------------------------------------------

/**
 * A client-supplied `Idempotency-Key` header. Restricted to a conservative
 * alphabet and a bounded length because it is composed into a ledger
 * `idempotency_key` (`redeem:<accountId>:<key>`) that `sql/950` caps at 300
 * characters.
 */
export function validateIdempotencyKeyHeader(
  value: string | null
): ValidationResult<string> {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return {
      valid: false,
      errors: [
        { field: "Idempotency-Key", message: "Idempotency-Key is required." }
      ]
    };
  }
  if (
    trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(trimmed)
  ) {
    return {
      valid: false,
      errors: [
        {
          field: "Idempotency-Key",
          message: `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters of letters, digits, '.', '_', ':' or '-'.`
        }
      ]
    };
  }
  return { valid: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Program create / update
// ---------------------------------------------------------------------------

export type LoyaltyProgramInput = {
  name: string;
  earnUnitAmount: string;
  earnPointsPerUnit: number;
  minOrderAmount: string;
  maxPointsPerOrder: number | null;
  expiryDays: number | null;
  notes: string | null;
};

export type LoyaltyProgramPatch = Partial<LoyaltyProgramInput>;

function readNotes(
  value: unknown,
  errors: ValidationError[]
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_NOTES_LENGTH) {
    errors.push({
      field: "notes",
      message: `notes must be a string of at most ${MAX_NOTES_LENGTH} characters.`
    });
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Create body: `name`, `earnUnitAmount` and `earnPointsPerUnit` are required; the rest default to "no minimum / no cap / never expires". */
export function validateCreateLoyaltyProgram(
  body: unknown
): ValidationResult<LoyaltyProgramInput> {
  if (!isRecord(body)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "Request body must be an object." }]
    };
  }
  const errors: ValidationError[] = [];

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: `name is required and at most ${MAX_NAME_LENGTH} characters.`
    });
  }

  const earnUnitAmount = parseMoney(
    body.earnUnitAmount,
    "earnUnitAmount",
    errors
  );
  if (earnUnitAmount !== null && toCents(earnUnitAmount) <= 0n) {
    errors.push({
      field: "earnUnitAmount",
      message: "earnUnitAmount must be greater than zero."
    });
  }

  const earnPointsPerUnit = parseIntegerInRange(
    body.earnPointsPerUnit,
    "earnPointsPerUnit",
    1,
    MAX_POINTS_PER_UNIT,
    errors
  );

  const minOrderAmount =
    body.minOrderAmount === undefined
      ? "0.00"
      : parseMoney(body.minOrderAmount, "minOrderAmount", errors);

  let maxPointsPerOrder: number | null = null;
  if (body.maxPointsPerOrder !== undefined && body.maxPointsPerOrder !== null) {
    maxPointsPerOrder = parseIntegerInRange(
      body.maxPointsPerOrder,
      "maxPointsPerOrder",
      1,
      MAX_LEDGER_POINTS,
      errors
    );
  }

  let expiryDays: number | null = null;
  if (body.expiryDays !== undefined && body.expiryDays !== null) {
    expiryDays = parseIntegerInRange(
      body.expiryDays,
      "expiryDays",
      1,
      MAX_EXPIRY_DAYS,
      errors
    );
  }

  const notes = readNotes(body.notes, errors);

  if (
    errors.length > 0 ||
    earnUnitAmount === null ||
    earnPointsPerUnit === null ||
    minOrderAmount === null
  ) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      name,
      earnUnitAmount,
      earnPointsPerUnit,
      minOrderAmount,
      maxPointsPerOrder,
      expiryDays,
      notes: notes ?? null
    }
  };
}

/** PATCH body (draft versions only — the application layer rejects an edit of an active/retired one): any subset of the create fields. */
export function validateLoyaltyProgramPatch(
  body: unknown
): ValidationResult<LoyaltyProgramPatch> {
  if (!isRecord(body)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "Request body must be an object." }]
    };
  }
  const errors: ValidationError[] = [];
  const patch: LoyaltyProgramPatch = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: "name",
        message: `name must be 1-${MAX_NAME_LENGTH} characters.`
      });
    } else {
      patch.name = name;
    }
  }

  if (body.earnUnitAmount !== undefined) {
    const value = parseMoney(body.earnUnitAmount, "earnUnitAmount", errors);
    if (value !== null) {
      if (toCents(value) <= 0n) {
        errors.push({
          field: "earnUnitAmount",
          message: "earnUnitAmount must be greater than zero."
        });
      } else {
        patch.earnUnitAmount = value;
      }
    }
  }

  if (body.earnPointsPerUnit !== undefined) {
    const value = parseIntegerInRange(
      body.earnPointsPerUnit,
      "earnPointsPerUnit",
      1,
      MAX_POINTS_PER_UNIT,
      errors
    );
    if (value !== null) patch.earnPointsPerUnit = value;
  }

  if (body.minOrderAmount !== undefined) {
    const value = parseMoney(body.minOrderAmount, "minOrderAmount", errors);
    if (value !== null) patch.minOrderAmount = value;
  }

  if (body.maxPointsPerOrder !== undefined) {
    if (body.maxPointsPerOrder === null) {
      patch.maxPointsPerOrder = null;
    } else {
      const value = parseIntegerInRange(
        body.maxPointsPerOrder,
        "maxPointsPerOrder",
        1,
        MAX_LEDGER_POINTS,
        errors
      );
      if (value !== null) patch.maxPointsPerOrder = value;
    }
  }

  if (body.expiryDays !== undefined) {
    if (body.expiryDays === null) {
      patch.expiryDays = null;
    } else {
      const value = parseIntegerInRange(
        body.expiryDays,
        "expiryDays",
        1,
        MAX_EXPIRY_DAYS,
        errors
      );
      if (value !== null) patch.expiryDays = value;
    }
  }

  const notes = readNotes(body.notes, errors);
  if (notes !== undefined) patch.notes = notes;

  if (errors.length === 0 && Object.keys(patch).length === 0) {
    errors.push({
      field: "body",
      message: "At least one field must be provided."
    });
  }

  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, value: patch };
}

// ---------------------------------------------------------------------------
// Redeem / adjust
// ---------------------------------------------------------------------------

export type RedeemInput = {
  /** Positive count of points to spend (the ledger row stores it negated). */
  points: number;
  reason: string | null;
};

function readReason(
  value: unknown,
  required: boolean,
  errors: ValidationError[]
): string | null {
  if (value === undefined || value === null) {
    if (required) {
      errors.push({ field: "reason", message: "reason is required." });
    }
    return null;
  }
  if (typeof value !== "string") {
    errors.push({ field: "reason", message: "reason must be a string." });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) {
      errors.push({ field: "reason", message: "reason is required." });
    }
    return null;
  }
  if (trimmed.length > MAX_LOYALTY_REASON_LENGTH) {
    errors.push({
      field: "reason",
      message: `reason must be at most ${MAX_LOYALTY_REASON_LENGTH} characters.`
    });
    return null;
  }
  return trimmed;
}

export function validateRedeemInput(
  body: unknown
): ValidationResult<RedeemInput> {
  if (!isRecord(body)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "Request body must be an object." }]
    };
  }
  const errors: ValidationError[] = [];
  const points = parseIntegerInRange(
    body.points,
    "points",
    1,
    MAX_LEDGER_POINTS,
    errors
  );
  const reason = readReason(body.reason, false, errors);
  if (errors.length > 0 || points === null) return { valid: false, errors };
  return { valid: true, value: { points, reason } };
}

export type AdjustInput = {
  /** Signed, non-zero. */
  points: number;
  reason: string;
};

export function validateAdjustInput(
  body: unknown
): ValidationResult<AdjustInput> {
  if (!isRecord(body)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "Request body must be an object." }]
    };
  }
  const errors: ValidationError[] = [];
  const points = parseIntegerInRange(
    body.points,
    "points",
    -MAX_LEDGER_POINTS,
    MAX_LEDGER_POINTS,
    errors
  );
  if (points === 0) {
    errors.push({ field: "points", message: "points must not be zero." });
  }
  const reason = readReason(body.reason, true, errors);
  if (errors.length > 0 || points === null || reason === null) {
    return { valid: false, errors };
  }
  return { valid: true, value: { points, reason } };
}
