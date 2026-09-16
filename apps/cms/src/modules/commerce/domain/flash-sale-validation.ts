/**
 * `awcms_commerce_flash_sales` / `_flash_sale_products` create/update
 * validation (Issue #26). Pure — no database, no I/O. Shaped after
 * `product-validation.ts`/`voucher-validation.ts`.
 */
import {
  FLASH_SALE_EDITABLE_STATUSES,
  isFlashSaleEditableStatus,
  type FlashSaleEditableStatus
} from "./flash-sale-status";

export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 200;
const MAX_NAME_LENGTH = 200;

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type CreateFlashSaleInput = {
  name: string;
  slug: string;
  startsAt: Date;
  endsAt: Date;
  status: FlashSaleEditableStatus;
};

export function validateCreateFlashSaleInput(
  body: unknown
): ValidationResult<CreateFlashSaleInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

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

  let status: FlashSaleEditableStatus = "draft";
  if (record.status !== undefined) {
    if (!isFlashSaleEditableStatus(record.status)) {
      errors.push({
        field: "status",
        message: `status must be one of: ${FLASH_SALE_EDITABLE_STATUSES.join(", ")}.`
      });
    } else {
      status = record.status;
    }
  }

  if (errors.length > 0 || !startsAt || !endsAt) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    value: {
      name: (record.name as string).trim(),
      slug: record.slug as string,
      startsAt,
      endsAt,
      status
    }
  };
}

export type UpdateFlashSaleInput = {
  name?: string;
  slug?: string;
  startsAt?: Date;
  endsAt?: Date;
  status?: FlashSaleEditableStatus;
};

export function validateUpdateFlashSaleInput(
  body: unknown
): ValidationResult<UpdateFlashSaleInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateFlashSaleInput = {};

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

  if (record.status !== undefined) {
    if (!isFlashSaleEditableStatus(record.status)) {
      errors.push({
        field: "status",
        message: `status must be one of: ${FLASH_SALE_EDITABLE_STATUSES.join(", ")} — active/ended are computed, never set directly.`
      });
    } else {
      value.status = record.status;
    }
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

export type CreateFlashSaleProductInput = {
  productId: string;
  variantId: string | null;
  salePrice: string;
  quota: number;
  sortOrder: number;
};

/**
 * `sortOrder` defaults to `0`, matching every other sortable list in this
 * module (`product-image-validation.ts`'s own default). `quota`/`salePrice`
 * are required — a flash-sale line with no price or no stated quota is not a
 * usable offer, unlike a plain product where `stock`/`price` may be edited
 * later.
 */
export function validateCreateFlashSaleProductInput(
  body: unknown
): ValidationResult<CreateFlashSaleProductInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  if (
    typeof record.productId !== "string" ||
    !UUID_PATTERN.test(record.productId)
  ) {
    errors.push({
      field: "productId",
      message: "productId is required and must be a valid UUID."
    });
  }

  let variantId: string | null = null;
  if (record.variantId !== undefined && record.variantId !== null) {
    if (
      typeof record.variantId !== "string" ||
      !UUID_PATTERN.test(record.variantId)
    ) {
      errors.push({
        field: "variantId",
        message: "variantId must be a valid UUID, or null."
      });
    } else {
      variantId = record.variantId;
    }
  }

  if (
    typeof record.salePrice !== "string" ||
    !PRICE_PATTERN.test(record.salePrice)
  ) {
    errors.push({
      field: "salePrice",
      message:
        "salePrice is required and must be a non-negative decimal string with at most 2 fractional digits."
    });
  }

  if (
    typeof record.quota !== "number" ||
    !Number.isInteger(record.quota) ||
    record.quota < 0
  ) {
    errors.push({
      field: "quota",
      message: "quota is required and must be a non-negative integer."
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

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: {
      productId: record.productId as string,
      variantId,
      salePrice: record.salePrice as string,
      quota: record.quota as number,
      sortOrder
    }
  };
}

export type UpdateFlashSaleProductInput = {
  salePrice?: string;
  quota?: number;
  sortOrder?: number;
};

/** `productId`/`variantId` are create-only (same "re-add the line to change it" limitation `category-directory.ts` accepts for `parentId`). */
export function validateUpdateFlashSaleProductInput(
  body: unknown
): ValidationResult<UpdateFlashSaleProductInput> {
  const record = (body ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const value: UpdateFlashSaleProductInput = {};

  if (record.salePrice !== undefined) {
    if (
      typeof record.salePrice !== "string" ||
      !PRICE_PATTERN.test(record.salePrice)
    ) {
      errors.push({
        field: "salePrice",
        message:
          "salePrice must be a non-negative decimal string with at most 2 fractional digits."
      });
    } else {
      value.salePrice = record.salePrice;
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
        message: "quota must be a non-negative integer."
      });
    } else {
      value.quota = record.quota;
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
      message: "Provide at least one field to update."
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  return { valid: true, value };
}
