/**
 * Request-shape validation for the anonymous `POST …/storefront/orders`
 * endpoint (Issue #29). Pure — no database, no I/O; existence checks
 * (does `productId` resolve to a live product? is `voucherCode` real?) are
 * the application layer's job (`application/order-directory.ts`), which
 * re-quotes the cart inside the transaction and answers `409 CART_CHANGED`
 * rather than a 400 for anything this file cannot see (it has no database
 * handle).
 *
 * Field paths in `details` match the storefront contract's own examples —
 * `customer.phone`, `lines[1].quantity`, `address.districtCode` — so a
 * client can highlight the right form field directly from the error list.
 */
import {
  validateAddressInput,
  type AddressInput,
  type ValidationError
} from "./address-validation";
import type { CartQuoteLineInput, CartQuoteShippingInput } from "./cart-quote";
import type { PaymentMethod } from "./commerce-order-types";

export type { ValidationError };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export type OrderCustomerInput = {
  name: string;
  phone: string;
  email: string | null;
};

export type CreateOrderInput = {
  idempotencyKey: string;
  customer: OrderCustomerInput;
  address: AddressInput | null;
  lines: CartQuoteLineInput[];
  shipping: CartQuoteShippingInput;
  payment: { method: PaymentMethod };
  voucherCode: string | null;
  insurance: boolean;
  notes: string | null;
};

const PAYMENT_METHODS: readonly PaymentMethod[] = [
  "manual_bank",
  "manual_qris",
  "dp",
  "gateway"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(
  value: unknown,
  field: string,
  max: number,
  errors: ValidationError[]
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({ field, message: `${field} is required.` });
    return "";
  }
  if (value.trim().length > max) {
    errors.push({
      field,
      message: `${field} must be at most ${max} characters.`
    });
  }
  return value.trim().slice(0, max);
}

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

function validateCustomer(
  value: unknown,
  errors: ValidationError[]
): OrderCustomerInput {
  const record = isRecord(value) ? value : {};
  return {
    name: requiredText(record.name, "customer.name", 200, errors),
    phone: requiredText(record.phone, "customer.phone", 30, errors),
    email: optionalText(record.email, 320)
  };
}

function validateServiceFormValues(
  value: unknown,
  field: string,
  errors: ValidationError[]
): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    errors.push({ field, message: `${field} must be an object, or null.` });
    return null;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function validateLines(
  value: unknown,
  errors: ValidationError[]
): CartQuoteLineInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({
      field: "lines",
      message: "lines must be a non-empty array."
    });
    return [];
  }
  if (value.length > 100) {
    errors.push({
      field: "lines",
      message: "lines must contain at most 100 entries."
    });
  }

  return value.slice(0, 100).map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const prefix = `lines[${index}]`;

    const productId = requiredText(
      record.productId,
      `${prefix}.productId`,
      64,
      errors
    );

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

    const serviceFormValues = validateServiceFormValues(
      record.serviceFormValues,
      `${prefix}.serviceFormValues`,
      errors
    );

    return { productId, variantId, quantity, serviceFormValues };
  });
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
  if (value.method === "courier") return { method: "courier" };
  if (value.method === "alternative") {
    const serviceId = requiredText(
      value.serviceId,
      "shipping.serviceId",
      50,
      errors
    );
    return { method: "alternative", serviceId };
  }

  errors.push({
    field: "shipping.method",
    message:
      'shipping.method must be one of: "alternative", "self_pickup", "courier".'
  });
  return null;
}

function validatePayment(
  value: unknown,
  errors: ValidationError[]
): { method: PaymentMethod } {
  const record = isRecord(value) ? value : {};
  if (
    typeof record.method !== "string" ||
    !(PAYMENT_METHODS as readonly string[]).includes(record.method)
  ) {
    errors.push({
      field: "payment.method",
      message: `payment.method must be one of: ${PAYMENT_METHODS.join(", ")}.`
    });
    return { method: "manual_qris" };
  }
  return { method: record.method as PaymentMethod };
}

export function validateCreateOrderInput(
  body: unknown
): ValidationResult<CreateOrderInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  const idempotencyKey = requiredText(
    record.idempotencyKey,
    "idempotencyKey",
    100,
    errors
  );
  const customer = validateCustomer(record.customer, errors);
  const shipping = validateShipping(record.shipping, errors);

  let address: AddressInput | null = null;
  if (shipping && shipping.method === "self_pickup") {
    if (record.address !== null && record.address !== undefined) {
      const addressResult = validateAddressInput(record.address);
      if (!addressResult.valid) errors.push(...addressResult.errors);
      else address = addressResult.value;
    }
  } else {
    const addressResult = validateAddressInput(record.address);
    if (!addressResult.valid) errors.push(...addressResult.errors);
    else address = addressResult.value;
  }

  const lines = validateLines(record.lines, errors);
  const payment = validatePayment(record.payment, errors);

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
  const notes = optionalText(record.notes, 1000);

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: {
      idempotencyKey,
      customer,
      address,
      lines,
      shipping,
      payment,
      voucherCode,
      insurance,
      notes
    }
  };
}
