/**
 * Input validation for `awcms_commerce_product_images` rows (Issue #23).
 * Pure — no database, no I/O; whether `mediaObjectId` actually resolves to a
 * live, same-tenant, safe-to-reference media object is an application-layer
 * check (`application/product-image-directory.ts`, via `MediaLibraryPort` —
 * the same division `news-media-reference-gate.ts` already draws).
 */
export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ALT_TEXT_LENGTH = 300;

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type CreateProductImageInput = {
  mediaObjectId: string;
  altText: string | null;
  sortOrder: number;
};

export function validateCreateProductImageInput(
  body: unknown
): ValidationResult<CreateProductImageInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (
    typeof record.mediaObjectId !== "string" ||
    !UUID_PATTERN.test(record.mediaObjectId)
  ) {
    errors.push({
      field: "mediaObjectId",
      message: "mediaObjectId is required and must be a valid UUID."
    });
  }

  if (
    record.altText !== undefined &&
    record.altText !== null &&
    (typeof record.altText !== "string" ||
      record.altText.trim().length > MAX_ALT_TEXT_LENGTH)
  ) {
    errors.push({
      field: "altText",
      message: `altText must be a string of at most ${MAX_ALT_TEXT_LENGTH} characters.`
    });
  }

  let sortOrder = 0;
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
      sortOrder = record.sortOrder;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      mediaObjectId: record.mediaObjectId as string,
      altText: normalizeOptionalText(record.altText),
      sortOrder
    }
  };
}

export type UpdateProductImageInput = {
  altText?: string | null;
  sortOrder?: number;
};

export function validateUpdateProductImageInput(
  body: unknown
): ValidationResult<UpdateProductImageInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateProductImageInput = {};

  if (record.altText !== undefined) {
    if (
      record.altText !== null &&
      (typeof record.altText !== "string" ||
        record.altText.trim().length > MAX_ALT_TEXT_LENGTH)
    ) {
      errors.push({
        field: "altText",
        message: `altText must be a string of at most ${MAX_ALT_TEXT_LENGTH} characters, or null.`
      });
    } else {
      value.altText = normalizeOptionalText(record.altText);
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

  if (errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({
      field: "body",
      message: "Provide at least one of altText, sortOrder."
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value };
}
