import { PRODUCT_TYPES, type ProductType } from "./product-type";

export type ValidationError = { field: string; message: string };

type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Slug format shared by `product-validation.ts` and `category-validation.ts`:
 * lowercase ASCII alphanumerics separated by single hyphens, no
 * leading/trailing/duplicate hyphens — same grammar as
 * `blog-content/domain/slug-policy.ts`'s `SLUG_PATTERN`, copied rather than
 * imported (a domain file never imports another module's domain code —
 * ADR-0013 §6). Uniqueness is the migration's partial unique index; this only
 * validates the string shape.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 200;

/**
 * `numeric(14,2)` as TEXT: up to 12 integer digits, an optional `.` and 1-2
 * fractional digits, no sign. `price` is never negative in this slice (a
 * markdown/discount is `discountPercent`, not a negative price) and never a
 * float — this validates the STRING shape the wire carries; the column does
 * the arithmetic-safe storage (Issue #4's "money is numeric(14,2)" decision).
 */
const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

const MAX_SKU_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
const MAX_LABEL_LENGTH = 50;
const MAX_LABEL_COLOR_LENGTH = 20;
const MAX_DISCOUNT_PERCENT = 100;

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Trims a caller-supplied optional text field and normalises an
 * empty/whitespace-only string to `null` — an empty string and "not set" are
 * the same intent, and storing `""` would just mean a second way to be
 * absent. `undefined` (field omitted) is left alone by the CALLER, not this
 * helper: create defaults it, update leaves it out of the patch.
 */
function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type CreateProductInput = {
  categoryId: string | null;
  type: ProductType;
  sku: string;
  name: string;
  slug: string;
  description: string | null;
  digitalNote: string | null;
  price: string;
  discountPercent: number;
  stock: number;
  label: string | null;
  labelColor: string | null;
};

export function validateCreateProductInput(
  body: unknown
): ValidationResult<CreateProductInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (!isNonEmptyTrimmedString(record.sku)) {
    errors.push({ field: "sku", message: "sku is required." });
  } else if ((record.sku as string).trim().length > MAX_SKU_LENGTH) {
    errors.push({
      field: "sku",
      message: `sku must be at most ${MAX_SKU_LENGTH} characters.`
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
    typeof record.slug !== "string" ||
    record.slug.length === 0 ||
    record.slug.length > MAX_SLUG_LENGTH ||
    !SLUG_PATTERN.test(record.slug)
  ) {
    errors.push({
      field: "slug",
      message:
        "slug is required and must be lowercase alphanumeric segments separated by single hyphens."
    });
  }

  let type: ProductType = "physical";
  if (record.type !== undefined) {
    if (
      typeof record.type !== "string" ||
      !(PRODUCT_TYPES as readonly string[]).includes(record.type)
    ) {
      errors.push({
        field: "type",
        message: `type must be one of: ${PRODUCT_TYPES.join(", ")}.`
      });
    } else {
      type = record.type as ProductType;
    }
  }

  let categoryId: string | null = null;
  if (record.categoryId !== undefined && record.categoryId !== null) {
    if (
      typeof record.categoryId !== "string" ||
      !UUID_PATTERN.test(record.categoryId)
    ) {
      errors.push({
        field: "categoryId",
        message: "categoryId must be a valid UUID."
      });
    } else {
      categoryId = record.categoryId;
    }
  }

  if (typeof record.price !== "string" || !PRICE_PATTERN.test(record.price)) {
    errors.push({
      field: "price",
      message:
        "price is required and must be a non-negative decimal string with at most 2 fractional digits (numeric(14,2))."
    });
  }

  let discountPercent = 0;
  if (record.discountPercent !== undefined) {
    if (
      typeof record.discountPercent !== "number" ||
      !Number.isInteger(record.discountPercent) ||
      record.discountPercent < 0 ||
      record.discountPercent > MAX_DISCOUNT_PERCENT
    ) {
      errors.push({
        field: "discountPercent",
        message: `discountPercent must be an integer between 0 and ${MAX_DISCOUNT_PERCENT}.`
      });
    } else {
      discountPercent = record.discountPercent;
    }
  }

  let stock = 0;
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
      stock = record.stock;
    }
  }

  if (
    record.label !== undefined &&
    record.label !== null &&
    (typeof record.label !== "string" ||
      record.label.trim().length > MAX_LABEL_LENGTH)
  ) {
    errors.push({
      field: "label",
      message: `label must be a string of at most ${MAX_LABEL_LENGTH} characters.`
    });
  }

  if (
    record.labelColor !== undefined &&
    record.labelColor !== null &&
    (typeof record.labelColor !== "string" ||
      record.labelColor.trim().length > MAX_LABEL_COLOR_LENGTH)
  ) {
    errors.push({
      field: "labelColor",
      message: `labelColor must be a string of at most ${MAX_LABEL_COLOR_LENGTH} characters.`
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      categoryId,
      type,
      sku: (record.sku as string).trim(),
      name: (record.name as string).trim(),
      slug: record.slug as string,
      description: normalizeOptionalText(record.description),
      digitalNote: normalizeOptionalText(record.digitalNote),
      price: record.price as string,
      discountPercent,
      stock,
      label: normalizeOptionalText(record.label),
      labelColor: normalizeOptionalText(record.labelColor)
    }
  };
}

/**
 * `status` is deliberately part of this type (unlike
 * `office-validation.ts`'s split between office fields and a bodyless
 * restore route): commerce ships no dedicated status-transition endpoint, so
 * `PATCH /api/v1/commerce/products/{id}` is the only door, and
 * `product-directory.ts`'s `updateProduct` is what checks the transition is
 * LEGAL (via `product-status.ts`'s `applyProductStatus`) — this function only
 * checks that the string is a real status.
 */
export type UpdateProductInput = {
  categoryId?: string | null;
  type?: ProductType;
  sku?: string;
  name?: string;
  slug?: string;
  description?: string | null;
  digitalNote?: string | null;
  price?: string;
  discountPercent?: number;
  stock?: number;
  status?: string;
  label?: string | null;
  labelColor?: string | null;
};

export function validateUpdateProductInput(
  body: unknown
): ValidationResult<UpdateProductInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateProductInput = {};

  if (record.sku !== undefined) {
    if (
      !isNonEmptyTrimmedString(record.sku) ||
      (record.sku as string).trim().length > MAX_SKU_LENGTH
    ) {
      errors.push({
        field: "sku",
        message: `sku must be a non-empty string of at most ${MAX_SKU_LENGTH} characters.`
      });
    } else {
      value.sku = (record.sku as string).trim();
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

  if (record.slug !== undefined) {
    if (
      typeof record.slug !== "string" ||
      record.slug.length === 0 ||
      record.slug.length > MAX_SLUG_LENGTH ||
      !SLUG_PATTERN.test(record.slug)
    ) {
      errors.push({
        field: "slug",
        message:
          "slug must be lowercase alphanumeric segments separated by single hyphens."
      });
    } else {
      value.slug = record.slug;
    }
  }

  if (record.type !== undefined) {
    if (
      typeof record.type !== "string" ||
      !(PRODUCT_TYPES as readonly string[]).includes(record.type)
    ) {
      errors.push({
        field: "type",
        message: `type must be one of: ${PRODUCT_TYPES.join(", ")}.`
      });
    } else {
      value.type = record.type as ProductType;
    }
  }

  if (record.categoryId !== undefined) {
    if (record.categoryId === null) {
      value.categoryId = null;
    } else if (
      typeof record.categoryId !== "string" ||
      !UUID_PATTERN.test(record.categoryId)
    ) {
      errors.push({
        field: "categoryId",
        message: "categoryId must be a valid UUID or null."
      });
    } else {
      value.categoryId = record.categoryId;
    }
  }

  if (record.price !== undefined) {
    if (typeof record.price !== "string" || !PRICE_PATTERN.test(record.price)) {
      errors.push({
        field: "price",
        message:
          "price must be a non-negative decimal string with at most 2 fractional digits (numeric(14,2))."
      });
    } else {
      value.price = record.price;
    }
  }

  if (record.discountPercent !== undefined) {
    if (
      typeof record.discountPercent !== "number" ||
      !Number.isInteger(record.discountPercent) ||
      record.discountPercent < 0 ||
      record.discountPercent > MAX_DISCOUNT_PERCENT
    ) {
      errors.push({
        field: "discountPercent",
        message: `discountPercent must be an integer between 0 and ${MAX_DISCOUNT_PERCENT}.`
      });
    } else {
      value.discountPercent = record.discountPercent;
    }
  }

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

  if (record.status !== undefined) {
    if (
      typeof record.status !== "string" ||
      record.status.trim().length === 0
    ) {
      errors.push({ field: "status", message: "status must be a string." });
    } else {
      value.status = record.status;
    }
  }

  if (record.description !== undefined) {
    value.description = normalizeOptionalText(record.description);
  }

  if (record.digitalNote !== undefined) {
    value.digitalNote = normalizeOptionalText(record.digitalNote);
  }

  if (record.label !== undefined) {
    if (
      record.label !== null &&
      (typeof record.label !== "string" ||
        record.label.trim().length > MAX_LABEL_LENGTH)
    ) {
      errors.push({
        field: "label",
        message: `label must be a string of at most ${MAX_LABEL_LENGTH} characters, or null.`
      });
    } else {
      value.label = normalizeOptionalText(record.label);
    }
  }

  if (record.labelColor !== undefined) {
    if (
      record.labelColor !== null &&
      (typeof record.labelColor !== "string" ||
        record.labelColor.trim().length > MAX_LABEL_COLOR_LENGTH)
    ) {
      errors.push({
        field: "labelColor",
        message: `labelColor must be a string of at most ${MAX_LABEL_COLOR_LENGTH} characters, or null.`
      });
    } else {
      value.labelColor = normalizeOptionalText(record.labelColor);
    }
  }

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
