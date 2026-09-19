/**
 * Request-shape validation for the remaining anonymous storefront endpoints
 * (Issue #29): `POST …/cart/quote`, `POST …/orders/{code}/payment-
 * confirmations`, `POST …/orders/{code}/cancel`, `POST …/reviews`. Pure — no
 * database, no I/O. `order-request-validation.ts` carries the (larger)
 * `POST …/orders` body on its own, since it is the one every other file in
 * this group reuses `CartQuoteLineInput`/`CartQuoteShippingInput` from.
 */
import type { ValidationError } from "./address-validation";
import type { CartQuoteLineInput, CartQuoteShippingInput } from "./cart-quote";

type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Reuses the exact same per-line/per-shipping validation
// `order-request-validation.ts` uses — imported lazily inline (function
// scope) below would be circular, so the two small helpers are duplicated in
// spirit but not in code: both call into these tiny local functions rather
// than each other, keeping every file here independently readable.
function validateLine(
  record: Record<string, unknown>,
  prefix: string,
  errors: ValidationError[]
): CartQuoteLineInput {
  const productId =
    typeof record.productId === "string" && record.productId.trim().length > 0
      ? record.productId.trim()
      : (() => {
          errors.push({
            field: `${prefix}.productId`,
            message: `${prefix}.productId is required.`
          });
          return "";
        })();

  let variantId: string | null = null;
  if (record.variantId !== undefined && record.variantId !== null) {
    if (typeof record.variantId !== "string") {
      errors.push({
        field: `${prefix}.variantId`,
        message: `${prefix}.variantId must be a string, or null.`
      });
    } else {
      variantId = record.variantId;
    }
  }

  let quantity = 0;
  if (
    typeof record.quantity !== "number" ||
    !Number.isInteger(record.quantity) ||
    record.quantity < 1 ||
    record.quantity > 10000
  ) {
    errors.push({
      field: `${prefix}.quantity`,
      message: `${prefix}.quantity must be an integer between 1 and 10000.`
    });
  } else {
    quantity = record.quantity;
  }

  let serviceFormValues: Record<string, string> | null = null;
  if (
    record.serviceFormValues !== undefined &&
    record.serviceFormValues !== null
  ) {
    if (!isRecord(record.serviceFormValues)) {
      errors.push({
        field: `${prefix}.serviceFormValues`,
        message: `${prefix}.serviceFormValues must be an object, or null.`
      });
    } else {
      serviceFormValues = {};
      for (const [key, value] of Object.entries(record.serviceFormValues)) {
        if (typeof value === "string") serviceFormValues[key] = value;
      }
    }
  }

  return { productId, variantId, quantity, serviceFormValues };
}

function validateShipping(
  value: unknown,
  errors: ValidationError[]
): CartQuoteShippingInput {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    errors.push({
      field: "shipping",
      message: "shipping must be an object, or null."
    });
    return null;
  }
  if (value.method === "self_pickup") return { method: "self_pickup" };
  if (value.method === "courier") {
    if (
      typeof value.serviceId !== "string" ||
      value.serviceId.trim().length === 0
    ) {
      errors.push({
        field: "shipping.serviceId",
        message: 'shipping.serviceId is required when method is "courier".'
      });
      return { method: "courier", serviceId: "" };
    }
    return { method: "courier", serviceId: value.serviceId };
  }
  if (value.method === "alternative") {
    if (
      typeof value.serviceId !== "string" ||
      value.serviceId.trim().length === 0
    ) {
      errors.push({
        field: "shipping.serviceId",
        message: 'shipping.serviceId is required when method is "alternative".'
      });
      return { method: "alternative", serviceId: "" };
    }
    return { method: "alternative", serviceId: value.serviceId };
  }
  errors.push({
    field: "shipping.method",
    message:
      'shipping.method must be one of: "alternative", "self_pickup", "courier".'
  });
  return null;
}

export type CartQuoteRequestInput = {
  lines: CartQuoteLineInput[];
  shipping: CartQuoteShippingInput;
  voucherCode: string | null;
  insurance: boolean;
  /** Issue #107 — optional; when present AND `shipping.courier.enabled` AND a provider is configured, `shippingOptions[]` carries live courier rates instead of the disabled placeholder. */
  destination: { districtCode: string } | null;
};

function validateDestination(
  value: unknown,
  errors: ValidationError[]
): { districtCode: string } | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    errors.push({
      field: "destination",
      message: "destination must be an object, or null."
    });
    return null;
  }
  if (
    typeof value.districtCode !== "string" ||
    value.districtCode.trim().length === 0
  ) {
    errors.push({
      field: "destination.districtCode",
      message: "destination.districtCode is required."
    });
    return null;
  }
  return { districtCode: value.districtCode.trim().slice(0, 50) };
}

export function validateCartQuoteRequest(
  body: unknown
): ValidationResult<CartQuoteRequestInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  const rawLines = Array.isArray(record.lines) ? record.lines : [];
  if (!Array.isArray(record.lines) || record.lines.length === 0) {
    errors.push({
      field: "lines",
      message: "lines must be a non-empty array."
    });
  }

  const lines = rawLines.slice(0, 100).map((entry, index) => {
    const entryRecord = isRecord(entry) ? entry : {};
    return validateLine(entryRecord, `lines[${index}]`, errors);
  });

  const shipping = validateShipping(record.shipping, errors);

  let voucherCode: string | null = null;
  if (record.voucherCode !== undefined && record.voucherCode !== null) {
    if (typeof record.voucherCode !== "string") {
      errors.push({
        field: "voucherCode",
        message: "voucherCode must be a string, or null."
      });
    } else {
      voucherCode = record.voucherCode.trim().slice(0, 50);
    }
  }

  const insurance = record.insurance === true;
  const destination = validateDestination(record.destination, errors);

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { lines, shipping, voucherCode, insurance, destination }
  };
}

export type PaymentConfirmationRequestInput = {
  phone: string;
  method: "manual_bank" | "manual_qris";
  amount: string;
  bankName: string | null;
  accountName: string | null;
  transferredAt: string | null;
  proofMediaObjectId: string | null;
};

const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export function validatePaymentConfirmationInput(
  body: unknown
): ValidationResult<PaymentConfirmationRequestInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  const phone =
    typeof record.phone === "string" && record.phone.trim().length > 0
      ? record.phone.trim()
      : (() => {
          errors.push({ field: "phone", message: "phone is required." });
          return "";
        })();

  const method =
    record.method === "manual_bank" || record.method === "manual_qris"
      ? record.method
      : (() => {
          errors.push({
            field: "method",
            message: 'method must be one of: "manual_bank", "manual_qris".'
          });
          return "manual_qris" as const;
        })();

  const amount =
    typeof record.amount === "string" && MONEY_PATTERN.test(record.amount)
      ? record.amount
      : (() => {
          errors.push({
            field: "amount",
            message: "amount must be a non-negative decimal string."
          });
          return "0.00";
        })();

  const bankName =
    typeof record.bankName === "string"
      ? record.bankName.trim().slice(0, 100)
      : null;
  const accountName =
    typeof record.accountName === "string"
      ? record.accountName.trim().slice(0, 200)
      : null;
  const transferredAt =
    typeof record.transferredAt === "string" ? record.transferredAt : null;
  const proofMediaObjectId =
    typeof record.proofMediaObjectId === "string"
      ? record.proofMediaObjectId
      : null;

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      phone,
      method,
      amount,
      bankName,
      accountName,
      transferredAt,
      proofMediaObjectId
    }
  };
}

export type CancelOrderRequestInput = { phone: string; reason: string | null };

export function validateCancelOrderInput(
  body: unknown
): ValidationResult<CancelOrderRequestInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  const phone =
    typeof record.phone === "string" && record.phone.trim().length > 0
      ? record.phone.trim()
      : (() => {
          errors.push({ field: "phone", message: "phone is required." });
          return "";
        })();

  const reason =
    typeof record.reason === "string" && record.reason.trim().length > 0
      ? record.reason.trim().slice(0, 500)
      : null;

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { phone, reason } };
}

export type CreateReviewRequestInput = {
  orderCode: string;
  phone: string;
  productId: string;
  rating: number;
  body: string;
};

export function validateCreateReviewInput(
  body: unknown
): ValidationResult<CreateReviewRequestInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  const orderCode =
    typeof record.orderCode === "string" && record.orderCode.trim().length > 0
      ? record.orderCode.trim()
      : (() => {
          errors.push({
            field: "orderCode",
            message: "orderCode is required."
          });
          return "";
        })();

  const phone =
    typeof record.phone === "string" && record.phone.trim().length > 0
      ? record.phone.trim()
      : (() => {
          errors.push({ field: "phone", message: "phone is required." });
          return "";
        })();

  const productId =
    typeof record.productId === "string" && record.productId.trim().length > 0
      ? record.productId.trim()
      : (() => {
          errors.push({
            field: "productId",
            message: "productId is required."
          });
          return "";
        })();

  let rating = 0;
  if (
    typeof record.rating !== "number" ||
    !Number.isInteger(record.rating) ||
    record.rating < 1 ||
    record.rating > 5
  ) {
    errors.push({
      field: "rating",
      message: "rating must be an integer between 1 and 5."
    });
  } else {
    rating = record.rating;
  }

  const reviewBody =
    typeof record.body === "string" && record.body.trim().length > 0
      ? record.body.trim().slice(0, 4000)
      : (() => {
          errors.push({ field: "body", message: "body is required." });
          return "";
        })();

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { orderCode, phone, productId, rating, body: reviewBody }
  };
}
