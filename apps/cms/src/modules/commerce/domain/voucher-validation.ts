/**
 * `awcms_commerce_vouchers` create/update validation (Issue #26). Pure — no
 * database, no I/O. Shaped after `product-validation.ts`: a
 * `ValidationResult<T>` discriminated union, field-by-field checks pushing
 * onto one shared `errors` array, and a `reconcile*` cross-field pass at the
 * end (the same "check the next state before the write" rule
 * `size-chart.ts`'s `reconcileSizeChart` established for this module).
 */

export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

/**
 * `percentage` (`value` is 0-100, optionally capped by `maxDiscount`),
 * `nominal` (`value` is a flat money amount), `free_shipping` (`value` is
 * not meaningful — forced to `"0.00"` by {@link reconcileVoucherFields}
 * regardless of what a caller sends, the discount comes from waiving
 * shipping, not from `value`).
 */
export const VOUCHER_TYPES = [
  "percentage",
  "nominal",
  "free_shipping"
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

export function isVoucherType(value: unknown): value is VoucherType {
  return (
    typeof value === "string" &&
    (VOUCHER_TYPES as readonly string[]).includes(value)
  );
}

/**
 * A plain admin on/off switch — unlike a flash sale's status, NEVER
 * time-derived. A voucher's live-ness for `POST .../validate` also depends
 * on its window/quota (`domain/voucher-arithmetic.ts`), but `inactive`,
 * soft-deleted, and genuinely absent all resolve to the SAME `not_found`
 * outcome there — the same three-causes-one-answer shape
 * `category-directory.ts`'s `ParentCategoryNotFoundError` already uses in
 * this module (GHSA-r7cx-c4jh-cvvw's shape) — so `status` is deliberately
 * NOT one of the public `reason` values the contract enumerates.
 */
export const VOUCHER_STATUSES = ["active", "inactive"] as const;
export type VoucherStatus = (typeof VOUCHER_STATUSES)[number];

export function isVoucherStatus(value: unknown): value is VoucherStatus {
  return (
    typeof value === "string" &&
    (VOUCHER_STATUSES as readonly string[]).includes(value)
  );
}

const CODE_PATTERN = /^[A-Z0-9_-]{3,40}$/;
const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_PERCENTAGE_VALUE = 100;

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Uppercased, trimmed — `awcms_commerce_vouchers_tenant_code_key` compares stored values verbatim, so normalizing here is what makes the index effectively case-insensitive. */
function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().toUpperCase();
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type VoucherFields = {
  type: VoucherType;
  value: string;
  maxDiscount: string | null;
};

/**
 * Enforces the shape `sql/909`'s CHECKs cannot: `percentage` needs `value`
 * in `0..100`; `nominal` accepts any non-negative amount and never a
 * `maxDiscount` (there is nothing to cap — the whole `value` IS the
 * discount); `free_shipping` ignores whatever `value`/`maxDiscount` a
 * caller sent and always stores `"0.00"`/`null` — deliberately CLEARING the
 * irrelevant fields rather than merely allowing them to be stale, same
 * choice `reconcileSizeChart` makes.
 */
export function reconcileVoucherFields(
  fields: VoucherFields
):
  | { valid: true; value: VoucherFields }
  | { valid: false; errors: ValidationError[] } {
  if (fields.type === "free_shipping") {
    return {
      valid: true,
      value: { type: "free_shipping", value: "0.00", maxDiscount: null }
    };
  }

  if (fields.type === "nominal") {
    return {
      valid: true,
      value: { type: "nominal", value: fields.value, maxDiscount: null }
    };
  }

  // percentage
  const numericValue = Number(fields.value);
  if (!Number.isFinite(numericValue) || numericValue > MAX_PERCENTAGE_VALUE) {
    return {
      valid: false,
      errors: [
        {
          field: "value",
          message: `value must be a decimal string between "0" and "${MAX_PERCENTAGE_VALUE}" when type is "percentage".`
        }
      ]
    };
  }

  return {
    valid: true,
    value: {
      type: "percentage",
      value: fields.value,
      maxDiscount: fields.maxDiscount
    }
  };
}

export type CreateVoucherInput = {
  code: string;
  name: string;
  description: string | null;
  type: VoucherType;
  value: string;
  minOrder: string;
  maxDiscount: string | null;
  quota: number;
  isPublic: boolean;
  startsAt: Date;
  endsAt: Date;
};

export function validateCreateVoucherInput(
  body: unknown
): ValidationResult<CreateVoucherInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  const code = normalizeCode(record.code);
  if (!code || !CODE_PATTERN.test(code)) {
    errors.push({
      field: "code",
      message:
        "code is required and must be 3-40 characters of A-Z, 0-9, - or _."
    });
  }

  if (!isNonEmptyTrimmedString(record.name)) {
    errors.push({ field: "name", message: "name is required." });
  } else if ((record.name as string).trim().length > MAX_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: `name must be at most ${MAX_NAME_LENGTH} characters.`
    });
  }

  if (
    record.description !== undefined &&
    record.description !== null &&
    (typeof record.description !== "string" ||
      record.description.trim().length > MAX_DESCRIPTION_LENGTH)
  ) {
    errors.push({
      field: "description",
      message: `description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters, or null.`
    });
  }

  let type: VoucherType = "percentage";
  if (!isVoucherType(record.type)) {
    errors.push({
      field: "type",
      message: `type is required and must be one of: ${VOUCHER_TYPES.join(", ")}.`
    });
  } else {
    type = record.type;
  }

  if (typeof record.value !== "string" || !PRICE_PATTERN.test(record.value)) {
    errors.push({
      field: "value",
      message:
        "value is required and must be a non-negative decimal string with at most 2 fractional digits."
    });
  }

  let minOrder = "0.00";
  if (record.minOrder !== undefined) {
    if (
      typeof record.minOrder !== "string" ||
      !PRICE_PATTERN.test(record.minOrder)
    ) {
      errors.push({
        field: "minOrder",
        message:
          "minOrder must be a non-negative decimal string with at most 2 fractional digits."
      });
    } else {
      minOrder = record.minOrder;
    }
  }

  let maxDiscount: string | null = null;
  if (record.maxDiscount !== undefined && record.maxDiscount !== null) {
    if (
      typeof record.maxDiscount !== "string" ||
      !PRICE_PATTERN.test(record.maxDiscount)
    ) {
      errors.push({
        field: "maxDiscount",
        message:
          "maxDiscount must be a non-negative decimal string with at most 2 fractional digits, or null."
      });
    } else {
      maxDiscount = record.maxDiscount;
    }
  }

  let quota = 0;
  if (record.quota !== undefined) {
    if (
      typeof record.quota !== "number" ||
      !Number.isInteger(record.quota) ||
      record.quota < 0
    ) {
      errors.push({
        field: "quota",
        message: "quota must be a non-negative integer (0 = unlimited)."
      });
    } else {
      quota = record.quota;
    }
  }

  const isPublic = record.isPublic === true;

  const startsAt = parseIsoDate(record.startsAt);
  if (!startsAt) {
    errors.push({
      field: "startsAt",
      message: "startsAt is required and must be an ISO-8601 date-time string."
    });
  }

  const endsAt = parseIsoDate(record.endsAt);
  if (!endsAt) {
    errors.push({
      field: "endsAt",
      message: "endsAt is required and must be an ISO-8601 date-time string."
    });
  }

  if (startsAt && endsAt && endsAt <= startsAt) {
    errors.push({ field: "endsAt", message: "endsAt must be after startsAt." });
  }

  if (errors.length > 0 || !startsAt || !endsAt) {
    return { valid: false, errors };
  }

  const reconciled = reconcileVoucherFields({
    type,
    value: record.value as string,
    maxDiscount
  });
  if (!reconciled.valid) return { valid: false, errors: reconciled.errors };

  return {
    valid: true,
    value: {
      code: code as string,
      name: (record.name as string).trim(),
      description: normalizeOptionalText(record.description),
      type: reconciled.value.type,
      value: reconciled.value.value,
      minOrder,
      maxDiscount: reconciled.value.maxDiscount,
      quota,
      isPublic,
      startsAt,
      endsAt
    }
  };
}

export type UpdateVoucherInput = {
  code?: string;
  name?: string;
  description?: string | null;
  type?: VoucherType;
  value?: string;
  minOrder?: string;
  maxDiscount?: string | null;
  quota?: number;
  isPublic?: boolean;
  status?: VoucherStatus;
  startsAt?: Date;
  endsAt?: Date;
};

export function validateUpdateVoucherInput(
  body: unknown
): ValidationResult<UpdateVoucherInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateVoucherInput = {};

  if (record.code !== undefined) {
    const code = normalizeCode(record.code);
    if (!code || !CODE_PATTERN.test(code)) {
      errors.push({
        field: "code",
        message: "code must be 3-40 characters of A-Z, 0-9, - or _."
      });
    } else {
      value.code = code;
    }
  }

  if (record.name !== undefined) {
    if (
      !isNonEmptyTrimmedString(record.name) ||
      (record.name as string).trim().length > MAX_NAME_LENGTH
    ) {
      errors.push({
        field: "name",
        message: `name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters.`
      });
    } else {
      value.name = (record.name as string).trim();
    }
  }

  if (record.description !== undefined) {
    if (
      record.description !== null &&
      (typeof record.description !== "string" ||
        record.description.trim().length > MAX_DESCRIPTION_LENGTH)
    ) {
      errors.push({
        field: "description",
        message: `description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters, or null.`
      });
    } else {
      value.description = normalizeOptionalText(record.description);
    }
  }

  if (record.type !== undefined) {
    if (!isVoucherType(record.type)) {
      errors.push({
        field: "type",
        message: `type must be one of: ${VOUCHER_TYPES.join(", ")}.`
      });
    } else {
      value.type = record.type;
    }
  }

  if (record.value !== undefined) {
    if (typeof record.value !== "string" || !PRICE_PATTERN.test(record.value)) {
      errors.push({
        field: "value",
        message:
          "value must be a non-negative decimal string with at most 2 fractional digits."
      });
    } else {
      value.value = record.value;
    }
  }

  if (record.minOrder !== undefined) {
    if (
      typeof record.minOrder !== "string" ||
      !PRICE_PATTERN.test(record.minOrder)
    ) {
      errors.push({
        field: "minOrder",
        message:
          "minOrder must be a non-negative decimal string with at most 2 fractional digits."
      });
    } else {
      value.minOrder = record.minOrder;
    }
  }

  if (record.maxDiscount !== undefined) {
    if (
      record.maxDiscount !== null &&
      (typeof record.maxDiscount !== "string" ||
        !PRICE_PATTERN.test(record.maxDiscount))
    ) {
      errors.push({
        field: "maxDiscount",
        message:
          "maxDiscount must be a non-negative decimal string with at most 2 fractional digits, or null."
      });
    } else {
      value.maxDiscount = record.maxDiscount as string | null;
    }
  }

  if (record.quota !== undefined) {
    if (
      typeof record.quota !== "number" ||
      !Number.isInteger(record.quota) ||
      record.quota < 0
    ) {
      errors.push({
        field: "quota",
        message: "quota must be a non-negative integer (0 = unlimited)."
      });
    } else {
      value.quota = record.quota;
    }
  }

  if (record.isPublic !== undefined) {
    if (typeof record.isPublic !== "boolean") {
      errors.push({
        field: "isPublic",
        message: "isPublic must be a boolean."
      });
    } else {
      value.isPublic = record.isPublic;
    }
  }

  if (record.status !== undefined) {
    if (!isVoucherStatus(record.status)) {
      errors.push({
        field: "status",
        message: `status must be one of: ${VOUCHER_STATUSES.join(", ")}.`
      });
    } else {
      value.status = record.status;
    }
  }

  if (record.startsAt !== undefined) {
    const startsAt = parseIsoDate(record.startsAt);
    if (!startsAt) {
      errors.push({
        field: "startsAt",
        message: "startsAt must be an ISO-8601 date-time string."
      });
    } else {
      value.startsAt = startsAt;
    }
  }

  if (record.endsAt !== undefined) {
    const endsAt = parseIsoDate(record.endsAt);
    if (!endsAt) {
      errors.push({
        field: "endsAt",
        message: "endsAt must be an ISO-8601 date-time string."
      });
    } else {
      value.endsAt = endsAt;
    }
  }

  if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
    errors.push({ field: "endsAt", message: "endsAt must be after startsAt." });
  }

  if (errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({
      field: "body",
      message: "Provide at least one field to update."
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  return { valid: true, value };
}
