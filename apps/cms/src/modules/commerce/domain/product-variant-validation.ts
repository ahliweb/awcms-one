/**
 * Input validation for `awcms_commerce_product_variants` rows (Issue #23).
 * Pure — no database, no I/O. Existence/ownership of `imageMediaObjectId`
 * (via `MediaLibraryPort`) and the SKU's cross-table uniqueness against
 * `awcms_commerce_products` both need a database round trip and live in
 * `application/product-variant-directory.ts` instead — same split every other
 * validator in this module already draws.
 */
export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same `numeric(14,2)`-as-text grammar as `product-validation.ts`'s `PRICE_PATTERN`. */
const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

const MAX_NAME_LENGTH = 100;
const MAX_VALUE_LENGTH = 100;
const MAX_SKU_LENGTH = 64;

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Shared by create/update: everything except `mediaObjectId`'s existence check, which needs the database. */
type VariantScalarFields = {
  name?: string;
  value?: string;
  colorHex?: string | null;
  imageMediaObjectId?: string | null;
  sku?: string | null;
  price?: string | null;
  priceLevel2?: string | null;
  priceLevel3?: string | null;
  priceLevel4?: string | null;
  stock?: number;
  weightGrams?: number;
  sortOrder?: number;
};

function validateOptionalMoney(
  value: unknown,
  field: string,
  errors: ValidationError[]
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !PRICE_PATTERN.test(value)) {
    errors.push({
      field,
      message: `${field} must be a non-negative decimal string with at most 2 fractional digits (numeric(14,2)), or null.`
    });
    return undefined;
  }
  return value;
}

function validateScalarFields(
  record: Record<string, unknown>,
  errors: ValidationError[],
  requireCore: boolean
): VariantScalarFields {
  const value: VariantScalarFields = {};

  if (requireCore || record.name !== undefined) {
    if (
      !isNonEmptyTrimmedString(record.name) ||
      (record.name as string).trim().length > MAX_NAME_LENGTH
    ) {
      errors.push({
        field: "name",
        message: `name is required and must be at most ${MAX_NAME_LENGTH} characters.`
      });
    } else {
      value.name = (record.name as string).trim();
    }
  }

  if (requireCore || record.value !== undefined) {
    if (
      !isNonEmptyTrimmedString(record.value) ||
      (record.value as string).trim().length > MAX_VALUE_LENGTH
    ) {
      errors.push({
        field: "value",
        message: `value is required and must be at most ${MAX_VALUE_LENGTH} characters.`
      });
    } else {
      value.value = (record.value as string).trim();
    }
  }

  if (record.colorHex !== undefined) {
    if (
      record.colorHex !== null &&
      (typeof record.colorHex !== "string" ||
        !HEX_COLOR_PATTERN.test(record.colorHex))
    ) {
      errors.push({
        field: "colorHex",
        message: "colorHex must be a #RRGGBB string, or null."
      });
    } else {
      value.colorHex = record.colorHex === null ? null : record.colorHex;
    }
  }

  if (record.imageMediaObjectId !== undefined) {
    if (
      record.imageMediaObjectId !== null &&
      (typeof record.imageMediaObjectId !== "string" ||
        !UUID_PATTERN.test(record.imageMediaObjectId))
    ) {
      errors.push({
        field: "imageMediaObjectId",
        message: "imageMediaObjectId must be a valid UUID, or null."
      });
    } else {
      value.imageMediaObjectId = record.imageMediaObjectId as string | null;
    }
  }

  if (record.sku !== undefined) {
    if (
      record.sku !== null &&
      (typeof record.sku !== "string" ||
        record.sku.trim().length === 0 ||
        record.sku.trim().length > MAX_SKU_LENGTH)
    ) {
      errors.push({
        field: "sku",
        message: `sku must be a non-empty string of at most ${MAX_SKU_LENGTH} characters, or null.`
      });
    } else {
      value.sku = normalizeOptionalText(record.sku);
    }
  }

  const price = validateOptionalMoney(record.price, "price", errors);
  if (price !== undefined) value.price = price;
  const priceLevel2 = validateOptionalMoney(
    record.priceLevel2,
    "priceLevel2",
    errors
  );
  if (priceLevel2 !== undefined) value.priceLevel2 = priceLevel2;
  const priceLevel3 = validateOptionalMoney(
    record.priceLevel3,
    "priceLevel3",
    errors
  );
  if (priceLevel3 !== undefined) value.priceLevel3 = priceLevel3;
  const priceLevel4 = validateOptionalMoney(
    record.priceLevel4,
    "priceLevel4",
    errors
  );
  if (priceLevel4 !== undefined) value.priceLevel4 = priceLevel4;

  if (record.stock !== undefined) {
    if (
      typeof record.stock !== "number" ||
      !Number.isInteger(record.stock) ||
      record.stock < 0
    ) {
      errors.push({
        field: "stock",
        message: "stock must be a non-negative integer."
      });
    } else {
      value.stock = record.stock;
    }
  }

  if (record.weightGrams !== undefined) {
    if (
      typeof record.weightGrams !== "number" ||
      !Number.isInteger(record.weightGrams) ||
      record.weightGrams < 0
    ) {
      errors.push({
        field: "weightGrams",
        message: "weightGrams must be a non-negative integer."
      });
    } else {
      value.weightGrams = record.weightGrams;
    }
  }

  if (record.sortOrder !== undefined) {
    if (
      typeof record.sortOrder !== "number" ||
      !Number.isInteger(record.sortOrder)
    ) {
      errors.push({
        field: "sortOrder",
        message: "sortOrder must be an integer."
      });
    } else {
      value.sortOrder = record.sortOrder;
    }
  }

  return value;
}

export type CreateProductVariantInput = {
  name: string;
  value: string;
  colorHex: string | null;
  imageMediaObjectId: string | null;
  sku: string | null;
  price: string | null;
  priceLevel2: string | null;
  priceLevel3: string | null;
  priceLevel4: string | null;
  stock: number;
  weightGrams: number;
  sortOrder: number;
};

export function validateCreateProductVariantInput(
  body: unknown
): ValidationResult<CreateProductVariantInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const parsed = validateScalarFields(record, errors, true);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      name: parsed.name!,
      value: parsed.value!,
      colorHex: parsed.colorHex ?? null,
      imageMediaObjectId: parsed.imageMediaObjectId ?? null,
      sku: parsed.sku ?? null,
      price: parsed.price ?? null,
      priceLevel2: parsed.priceLevel2 ?? null,
      priceLevel3: parsed.priceLevel3 ?? null,
      priceLevel4: parsed.priceLevel4 ?? null,
      stock: parsed.stock ?? 0,
      weightGrams: parsed.weightGrams ?? 0,
      sortOrder: parsed.sortOrder ?? 0
    }
  };
}

export type UpdateProductVariantInput = Partial<CreateProductVariantInput>;

export function validateUpdateProductVariantInput(
  body: unknown
): ValidationResult<UpdateProductVariantInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value = validateScalarFields(record, errors, false);

  if (errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({
      field: "body",
      message: "Provide at least one field to update."
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value };
}
