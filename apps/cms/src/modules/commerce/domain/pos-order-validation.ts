/**
 * Request-shape validation for `POST /api/v1/commerce/pos/orders` (Issue
 * #116, contract #106 D6). Pure — no database, no I/O; existence/price/stock
 * checks are the application layer's job
 * (`application/pos-directory.ts`'s `createPosOrder`, which re-quotes the
 * cart inside the transaction via `buildCartQuote`, the same "never trust a
 * client-sent price" discipline `order-request-validation.ts` already
 * follows for the storefront).
 *
 * ## Money, always as strings (ADR-0003)
 *
 * `amountTendered` arrives as a `numeric(14,2)`-shaped STRING, exactly like
 * every other money value this module accepts — never a JS `number`. This
 * file only shape-validates it (`MONEY_PATTERN`); the actual `change =
 * amountTendered - total` arithmetic is `computeChange` below, which runs
 * entirely in integer cents via `domain/price-calculation.ts`'s
 * `toCents`/`fromCents` — never floating-point, never `Number(...)`.
 */
import type { PaymentMethod } from "./commerce-order-types";
import { fromCents, toCents } from "./price-calculation";

export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export type PosOrderLineInput = {
  productId: string;
  variantId: string | null;
  quantity: number;
};

export type PosOrderCustomerInput = {
  name: string | null;
  phone: string | null;
};

/**
 * POS-only allow-list (contract #106 D6) — `"cash"` and `"manual_qris"`
 * (a QRIS sticker at the counter). Deliberately narrower than
 * `PaymentMethod`'s full union: `"manual_bank"`/`"dp"`/`"gateway"` all
 * presume an UNPAID order awaiting a later confirmation/redirect, which has
 * no meaning for a counter sale that is paid, in full, at the moment it is
 * rung up.
 */
export const POS_PAYMENT_METHODS: readonly PaymentMethod[] = [
  "cash",
  "manual_qris"
];

export type CreatePosOrderInput = {
  idempotencyKey: string;
  customer: PosOrderCustomerInput;
  lines: PosOrderLineInput[];
  payment: { method: PaymentMethod; amountTendered: string | null };
  notes: string | null;
};

const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
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

function validateCustomer(
  value: unknown,
  errors: ValidationError[]
): PosOrderCustomerInput {
  if (value === undefined || value === null) return { name: null, phone: null };
  if (!isRecord(value)) {
    errors.push({
      field: "customer",
      message: "customer must be an object, or null."
    });
    return { name: null, phone: null };
  }

  const name = optionalText(value.name, 200);

  let phone: string | null = null;
  if (value.phone !== undefined && value.phone !== null) {
    if (typeof value.phone !== "string") {
      errors.push({
        field: "customer.phone",
        message: "customer.phone must be a string, or null."
      });
    } else {
      phone = value.phone.trim().slice(0, 30) || null;
    }
  }

  return { name, phone };
}

function validateLines(
  value: unknown,
  errors: ValidationError[]
): PosOrderLineInput[] {
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

    return { productId, variantId, quantity };
  });
}

function validatePayment(
  value: unknown,
  errors: ValidationError[]
): { method: PaymentMethod; amountTendered: string | null } {
  const record = isRecord(value) ? value : {};

  if (
    typeof record.method !== "string" ||
    !(POS_PAYMENT_METHODS as readonly string[]).includes(record.method)
  ) {
    errors.push({
      field: "payment.method",
      message: `payment.method must be one of: ${POS_PAYMENT_METHODS.join(", ")}.`
    });
  }
  const method = (
    (POS_PAYMENT_METHODS as readonly string[]).includes(record.method as string)
      ? record.method
      : "cash"
  ) as PaymentMethod;

  let amountTendered: string | null = null;
  if (record.amountTendered !== undefined && record.amountTendered !== null) {
    if (
      typeof record.amountTendered !== "string" ||
      !MONEY_PATTERN.test(record.amountTendered)
    ) {
      errors.push({
        field: "payment.amountTendered",
        message: "payment.amountTendered must be a numeric(14,2) string."
      });
    } else {
      amountTendered = record.amountTendered;
    }
  }

  return { method, amountTendered };
}

export function validateCreatePosOrderInput(
  body: unknown
): ValidationResult<CreatePosOrderInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  const idempotencyKey = requiredText(
    record.idempotencyKey,
    "idempotencyKey",
    100,
    errors
  );
  const customer = validateCustomer(record.customer, errors);
  const lines = validateLines(record.lines, errors);
  const payment = validatePayment(record.payment, errors);
  const notes = optionalText(record.notes, 1000);

  // `amountTendered` vs. the order total is NOT checked here — the total is
  // only known after the transaction's own re-quote (`buildCartQuote`
  // inside `createPosOrder`); `computeChange` below is what rejects an
  // insufficient tender, once the total exists to compare against.

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: { idempotencyKey, customer, lines, payment, notes }
  };
}

export class InsufficientTenderError extends Error {
  constructor() {
    super("payment.amountTendered is less than the order total.");
    this.name = "InsufficientTenderError";
  }
}

/**
 * `change = amountTendered - total`, both `numeric(14,2)` strings, computed
 * entirely in integer cents (ADR-0003 — never `Number(...)`, never a float).
 *
 * @throws {InsufficientTenderError} `amountTendered` is less than `total` —
 *   a cashier typo (or a customer who does not actually have the cash) must
 *   fail the sale, never silently record a negative change.
 */
export function computeChange(amountTendered: string, total: string): string {
  const tenderedCents = toCents(amountTendered);
  const totalCents = toCents(total);
  if (tenderedCents < totalCents) {
    throw new InsufficientTenderError();
  }
  return fromCents(tenderedCents - totalCents);
}
