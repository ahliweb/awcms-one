import { PRODUCT_TYPES, type ProductType } from "./product-type";
import {
  reconcileSizeChart,
  SIZE_CHART_TYPES,
  type SizeChartType
} from "./size-chart";
import {
  SUBSCRIPTION_PERIODS,
  type SubscriptionPeriod
} from "./subscription-period";
import {
  validateServiceForm,
  type ServiceFormField
} from "./service-form-validation";
import {
  validateVariantAttributes,
  type VariantAttributeGroup
} from "./variant-attributes-validation";

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
/** `numeric(2,1)` as TEXT — `manualRating`, `0.0`..`5.0`. */
const RATING_PATTERN = /^\d(\.\d)?$/;

const MAX_SKU_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
const MAX_LABEL_LENGTH = 50;
const MAX_LABEL_COLOR_LENGTH = 20;
const MAX_DISCOUNT_PERCENT = 100;
const MAX_PROMO_TITLE_LENGTH = 200;
const MAX_PROMO_SUBTITLE_LENGTH = 200;
const MAX_PROMO_BADGE_LENGTH = 50;
const MAX_PROMO_ICON_LENGTH = 100;
const MAX_PROMO_COLOR_LENGTH = 20;
const MAX_DOWNLOAD_LINK_LENGTH = 2000;
/** `sizeChartDetails` is `jsonb`; capped so an admin form cannot wedge megabytes into one row. */
const MAX_SIZE_CHART_DETAILS_JSON_LENGTH = 20000;

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

/**
 * A `numeric(14,2)` field that may be `null`/absent — `priceLevel2/3/4`,
 * `costPrice`, `insuranceFee`. Returns `undefined` when nothing was supplied
 * (caller decides what "absent" means), `null` when explicitly cleared, or
 * the validated string otherwise; pushes onto `errors` on a bad shape.
 */
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

function validateOptionalBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
  errors: ValidationError[]
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    errors.push({
      field,
      message: `${field} must be a string of at most ${maxLength} characters, or null.`
    });
    return undefined;
  }
  return normalizeOptionalText(value);
}

function validateBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
  errors: ValidationError[]
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    errors.push({ field, message: `${field} must be a boolean.` });
    return fallback;
  }
  return value;
}

/**
 * The fields Issue #23 adds to `awcms_commerce_products` — shared shape
 * between create (always fully resolved, defaults applied) and update
 * (`Partial<...>`, only the fields a caller actually sent).
 */
type ProductParityFields = {
  priceLevel2: string | null;
  priceLevel3: string | null;
  priceLevel4: string | null;
  costPrice: string | null;
  minPurchase: number;
  weightGrams: number;
  manualRating: string | null;
  manualSoldCount: number;
  withInsurance: boolean;
  insuranceRequired: boolean;
  insuranceFee: string | null;
  promoBannerShow: boolean;
  promoBannerTitle: string | null;
  promoBannerSubtitle: string | null;
  promoBannerBadge: string | null;
  promoBannerIcon: string | null;
  promoBannerColor: string | null;
  sizeChartType: SizeChartType;
  sizeChartMediaId: string | null;
  sizeChartDetails: unknown | null;
  serviceForm: ServiceFormField[] | null;
  subscriptionPeriod: SubscriptionPeriod | null;
  downloadLink: string | null;
  allowDp: boolean;
  allowFreeShipping: boolean;
  variantAttributes: VariantAttributeGroup[] | null;
  isFeatured: boolean;
  isRecommended: boolean;
};

/**
 * Validates every Issue #23 field COMMON to create/update, filling `value`
 * with only the keys actually present in `record` (so update's "absent means
 * unchanged" contract holds) and pushing onto the shared `errors` array.
 * Create fills in the rest of the defaults itself, since it always resolves a
 * FULL set of values; update passes its partial result straight through to
 * `updateProduct`, which merges against the existing row.
 */
function validateParityFields(
  record: Record<string, unknown>,
  errors: ValidationError[]
): Partial<ProductParityFields> {
  const value: Partial<ProductParityFields> = {};

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
  const costPrice = validateOptionalMoney(
    record.costPrice,
    "costPrice",
    errors
  );
  if (costPrice !== undefined) value.costPrice = costPrice;
  const insuranceFee = validateOptionalMoney(
    record.insuranceFee,
    "insuranceFee",
    errors
  );
  if (insuranceFee !== undefined) value.insuranceFee = insuranceFee;

  if (record.minPurchase !== undefined) {
    if (
      typeof record.minPurchase !== "number" ||
      !Number.isInteger(record.minPurchase) ||
      record.minPurchase < 1
    ) {
      errors.push({
        field: "minPurchase",
        message: "minPurchase must be an integer >= 1."
      });
    } else {
      value.minPurchase = record.minPurchase;
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

  if (record.manualRating !== undefined) {
    if (record.manualRating === null) {
      value.manualRating = null;
    } else if (
      typeof record.manualRating !== "string" ||
      !RATING_PATTERN.test(record.manualRating) ||
      Number(record.manualRating) > 5
    ) {
      errors.push({
        field: "manualRating",
        message:
          'manualRating must be a decimal string "0.0"-"5.0" with at most 1 fractional digit (numeric(2,1)), or null.'
      });
    } else {
      value.manualRating = record.manualRating;
    }
  }

  if (record.manualSoldCount !== undefined) {
    if (
      typeof record.manualSoldCount !== "number" ||
      !Number.isInteger(record.manualSoldCount) ||
      record.manualSoldCount < 0
    ) {
      errors.push({
        field: "manualSoldCount",
        message: "manualSoldCount must be a non-negative integer."
      });
    } else {
      value.manualSoldCount = record.manualSoldCount;
    }
  }

  if (record.withInsurance !== undefined) {
    value.withInsurance = validateBoolean(
      record.withInsurance,
      "withInsurance",
      false,
      errors
    );
  }
  if (record.insuranceRequired !== undefined) {
    value.insuranceRequired = validateBoolean(
      record.insuranceRequired,
      "insuranceRequired",
      false,
      errors
    );
  }

  if (record.promoBannerShow !== undefined) {
    value.promoBannerShow = validateBoolean(
      record.promoBannerShow,
      "promoBannerShow",
      false,
      errors
    );
  }

  const promoBannerTitle = validateOptionalBoundedText(
    record.promoBannerTitle,
    "promoBannerTitle",
    MAX_PROMO_TITLE_LENGTH,
    errors
  );
  if (promoBannerTitle !== undefined) value.promoBannerTitle = promoBannerTitle;
  const promoBannerSubtitle = validateOptionalBoundedText(
    record.promoBannerSubtitle,
    "promoBannerSubtitle",
    MAX_PROMO_SUBTITLE_LENGTH,
    errors
  );
  if (promoBannerSubtitle !== undefined)
    value.promoBannerSubtitle = promoBannerSubtitle;
  const promoBannerBadge = validateOptionalBoundedText(
    record.promoBannerBadge,
    "promoBannerBadge",
    MAX_PROMO_BADGE_LENGTH,
    errors
  );
  if (promoBannerBadge !== undefined) value.promoBannerBadge = promoBannerBadge;
  const promoBannerIcon = validateOptionalBoundedText(
    record.promoBannerIcon,
    "promoBannerIcon",
    MAX_PROMO_ICON_LENGTH,
    errors
  );
  if (promoBannerIcon !== undefined) value.promoBannerIcon = promoBannerIcon;
  const promoBannerColor = validateOptionalBoundedText(
    record.promoBannerColor,
    "promoBannerColor",
    MAX_PROMO_COLOR_LENGTH,
    errors
  );
  if (promoBannerColor !== undefined) value.promoBannerColor = promoBannerColor;

  if (record.sizeChartType !== undefined) {
    if (
      typeof record.sizeChartType !== "string" ||
      !(SIZE_CHART_TYPES as readonly string[]).includes(record.sizeChartType)
    ) {
      errors.push({
        field: "sizeChartType",
        message: `sizeChartType must be one of: ${SIZE_CHART_TYPES.join(", ")}.`
      });
    } else {
      value.sizeChartType = record.sizeChartType as SizeChartType;
    }
  }

  if (record.sizeChartMediaId !== undefined) {
    if (
      record.sizeChartMediaId !== null &&
      (typeof record.sizeChartMediaId !== "string" ||
        !UUID_PATTERN.test(record.sizeChartMediaId))
    ) {
      errors.push({
        field: "sizeChartMediaId",
        message: "sizeChartMediaId must be a valid UUID, or null."
      });
    } else {
      value.sizeChartMediaId = record.sizeChartMediaId as string | null;
    }
  }

  if (record.sizeChartDetails !== undefined) {
    if (record.sizeChartDetails === null) {
      value.sizeChartDetails = null;
    } else if (
      typeof record.sizeChartDetails !== "object" ||
      JSON.stringify(record.sizeChartDetails).length >
        MAX_SIZE_CHART_DETAILS_JSON_LENGTH
    ) {
      errors.push({
        field: "sizeChartDetails",
        message: `sizeChartDetails must be a JSON object/array of at most ${MAX_SIZE_CHART_DETAILS_JSON_LENGTH} serialized characters, or null.`
      });
    } else {
      value.sizeChartDetails = record.sizeChartDetails;
    }
  }

  if (record.serviceForm !== undefined) {
    const serviceForm = validateServiceForm(record.serviceForm);
    if (!serviceForm.valid) {
      errors.push(...serviceForm.errors);
    } else {
      value.serviceForm = serviceForm.value;
    }
  }

  if (record.subscriptionPeriod !== undefined) {
    if (
      record.subscriptionPeriod !== null &&
      (typeof record.subscriptionPeriod !== "string" ||
        !(SUBSCRIPTION_PERIODS as readonly string[]).includes(
          record.subscriptionPeriod
        ))
    ) {
      errors.push({
        field: "subscriptionPeriod",
        message: `subscriptionPeriod must be one of: ${SUBSCRIPTION_PERIODS.join(", ")}, or null.`
      });
    } else {
      value.subscriptionPeriod =
        record.subscriptionPeriod as SubscriptionPeriod | null;
    }
  }

  const downloadLink = validateOptionalBoundedText(
    record.downloadLink,
    "downloadLink",
    MAX_DOWNLOAD_LINK_LENGTH,
    errors
  );
  if (downloadLink !== undefined) value.downloadLink = downloadLink;

  if (record.allowDp !== undefined) {
    value.allowDp = validateBoolean(record.allowDp, "allowDp", false, errors);
  }
  if (record.allowFreeShipping !== undefined) {
    value.allowFreeShipping = validateBoolean(
      record.allowFreeShipping,
      "allowFreeShipping",
      true,
      errors
    );
  }

  if (record.variantAttributes !== undefined) {
    const variantAttributes = validateVariantAttributes(
      record.variantAttributes
    );
    if (!variantAttributes.valid) {
      errors.push(...variantAttributes.errors);
    } else {
      value.variantAttributes = variantAttributes.value;
    }
  }

  if (record.isFeatured !== undefined) {
    value.isFeatured = validateBoolean(
      record.isFeatured,
      "isFeatured",
      false,
      errors
    );
  }
  if (record.isRecommended !== undefined) {
    value.isRecommended = validateBoolean(
      record.isRecommended,
      "isRecommended",
      false,
      errors
    );
  }

  return value;
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
} & ProductParityFields;

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

  const parity = validateParityFields(record, errors);

  // Cross-field size-chart consistency (`domain/size-chart.ts`'s
  // `reconcileSizeChart`) runs against the FULLY RESOLVED values — create
  // always has a complete set (default `"none"`/`null`/`null` when the caller
  // sends none of the three fields), unlike update's partial patch, which
  // reconciles against the MERGED existing+patch state in
  // `product-directory.ts`'s `updateProduct` instead.
  const sizeChart = reconcileSizeChart({
    sizeChartType: parity.sizeChartType ?? "none",
    sizeChartMediaId: parity.sizeChartMediaId ?? null,
    sizeChartDetails: parity.sizeChartDetails ?? null
  });
  if (!sizeChart.valid) {
    errors.push(...sizeChart.errors);
  }

  if (errors.length > 0 || !sizeChart.valid) {
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
      labelColor: normalizeOptionalText(record.labelColor),
      priceLevel2: parity.priceLevel2 ?? null,
      priceLevel3: parity.priceLevel3 ?? null,
      priceLevel4: parity.priceLevel4 ?? null,
      costPrice: parity.costPrice ?? null,
      minPurchase: parity.minPurchase ?? 1,
      weightGrams: parity.weightGrams ?? 0,
      manualRating: parity.manualRating ?? null,
      manualSoldCount: parity.manualSoldCount ?? 0,
      withInsurance: parity.withInsurance ?? false,
      insuranceRequired: parity.insuranceRequired ?? false,
      insuranceFee: parity.insuranceFee ?? null,
      promoBannerShow: parity.promoBannerShow ?? false,
      promoBannerTitle: parity.promoBannerTitle ?? null,
      promoBannerSubtitle: parity.promoBannerSubtitle ?? null,
      promoBannerBadge: parity.promoBannerBadge ?? null,
      promoBannerIcon: parity.promoBannerIcon ?? null,
      promoBannerColor: parity.promoBannerColor ?? null,
      sizeChartType: sizeChart.value.sizeChartType,
      sizeChartMediaId: sizeChart.value.sizeChartMediaId,
      sizeChartDetails: sizeChart.value.sizeChartDetails,
      serviceForm: parity.serviceForm ?? null,
      subscriptionPeriod: parity.subscriptionPeriod ?? null,
      downloadLink: parity.downloadLink ?? null,
      allowDp: parity.allowDp ?? false,
      allowFreeShipping: parity.allowFreeShipping ?? true,
      variantAttributes: parity.variantAttributes ?? null,
      isFeatured: parity.isFeatured ?? false,
      isRecommended: parity.isRecommended ?? false
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
} & Partial<ProductParityFields>;

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

  const parity = validateParityFields(record, errors);
  Object.assign(value, parity);

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
