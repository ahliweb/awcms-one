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
 * entirely in integer cents (`bigint`) via `domain/price-calculation.ts`'s
 * `toCents`/`fromCents` — never floating-point, never `Number(...)`.
 *
 * ## The idempotency key is NOT part of the body
 *
 * `Idempotency-Key` is an HTTP header (skill `awcms-idempotency`, every
 * other owner-side high-risk mutation in this repo); the route reads it in
 * `prepare` and hands it in as `CreatePosOrderInput.idempotencyKey`. A body
 * field of the same name is ignored — unlike the anonymous storefront
 * checkout, which has no other place to carry it.
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
export type PosPaymentMethod = Extract<PaymentMethod, "cash" | "manual_qris">;

export const POS_PAYMENT_METHODS: readonly PosPaymentMethod[] = [
  "cash",
  "manual_qris"
];

/**
 * The customer name a no-name counter sale is attached to. Data (a stored
 * customer name), not UI copy — so it is Indonesian, the tenants' own
 * language, rather than an i18n'd string that would differ per cashier
 * locale and create two "walk-in" rows.
 */
export const POS_WALK_IN_CUSTOMER_NAME = "Pelanggan Walk-in";

export type CreatePosOrderInput = {
  idempotencyKey: string;
  customer: PosOrderCustomerInput;
  lines: PosOrderLineInput[];
  /** `amountTendered` is a `numeric(14,2)` string for `cash`, always `null` for `manual_qris`. */
  payment: { method: PosPaymentMethod; amountTendered: string | null };
  notes: string | null;
};

export const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const MAX_LINES = 100;
const MAX_QUANTITY = 10000;

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

  if (
    value.name !== undefined &&
    value.name !== null &&
    typeof value.name !== "string"
  ) {
    errors.push({
      field: "customer.name",
      message: "customer.name must be a string, or null."
    });
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
  if (value.length > MAX_LINES) {
    errors.push({
      field: "lines",
      message: `lines must contain at most ${MAX_LINES} entries.`
    });
  }

  return value.slice(0, MAX_LINES).map((entry, index) => {
    const prefix = `lines[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ field: prefix, message: `${prefix} must be an object.` });
      return { productId: "", variantId: null, quantity: 0 };
    }

    const productId = requiredText(
      entry.productId,
      `${prefix}.productId`,
      64,
      errors
    );

    let variantId: string | null = null;
    if (entry.variantId !== undefined && entry.variantId !== null) {
      if (typeof entry.variantId !== "string" || entry.variantId.length === 0) {
        errors.push({
          field: `${prefix}.variantId`,
          message: `${prefix}.variantId must be a non-empty string, or null.`
        });
      } else {
        variantId = entry.variantId.slice(0, 64);
      }
    }

    let quantity = 0;
    if (
      typeof entry.quantity !== "number" ||
      !Number.isInteger(entry.quantity) ||
      entry.quantity < 1 ||
      entry.quantity > MAX_QUANTITY
    ) {
      errors.push({
        field: `${prefix}.quantity`,
        message: `${prefix}.quantity must be an integer between 1 and ${MAX_QUANTITY}.`
      });
    } else {
      quantity = entry.quantity;
    }

    return { productId, variantId, quantity };
  });
}

function validatePayment(
  value: unknown,
  errors: ValidationError[]
): CreatePosOrderInput["payment"] {
  if (!isRecord(value)) {
    errors.push({
      field: "payment",
      message: "payment must be an object."
    });
    return { method: "cash", amountTendered: null };
  }

  const methodValid =
    typeof value.method === "string" &&
    (POS_PAYMENT_METHODS as readonly string[]).includes(value.method);
  if (!methodValid) {
    errors.push({
      field: "payment.method",
      message: `payment.method must be one of: ${POS_PAYMENT_METHODS.join(", ")}.`
    });
  }
  const method: PosPaymentMethod = methodValid
    ? (value.method as PosPaymentMethod)
    : "cash";

  let amountTendered: string | null = null;
  const rawTendered = value.amountTendered;
  if (rawTendered !== undefined && rawTendered !== null) {
    if (typeof rawTendered !== "string" || !MONEY_PATTERN.test(rawTendered)) {
      errors.push({
        field: "payment.amountTendered",
        message:
          "payment.amountTendered must be a numeric(14,2) string (digits with at most two decimals), never a JSON number."
      });
    } else {
      amountTendered = rawTendered;
    }
  }

  // Cash MUST say how much was handed over — `change` is computed from it
  // server-side and printed on the receipt; a QRIS sale is always exact, so
  // a tendered amount there is meaningless and dropped rather than stored.
  if (method === "cash" && methodValid && amountTendered === null) {
    if (!errors.some((e) => e.field === "payment.amountTendered")) {
      errors.push({
        field: "payment.amountTendered",
        message: "payment.amountTendered is required for a cash sale."
      });
    }
  }
  if (method === "manual_qris") {
    amountTendered = null;
  }

  return { method, amountTendered };
}

/**
 * Validates the request BODY only. `idempotencyKey` comes from the
 * `Idempotency-Key` header (see this file's header) and is supplied by the
 * caller, which is why it is a separate argument rather than a body field.
 */
export function validateCreatePosOrderInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<CreatePosOrderInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  if (
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length === 0
  ) {
    errors.push({
      field: "Idempotency-Key",
      message: "Idempotency-Key header is required."
    });
  } else if (idempotencyKey.length > 200) {
    errors.push({
      field: "Idempotency-Key",
      message: "Idempotency-Key must be at most 200 characters."
    });
  }

  const customer = validateCustomer(record.customer, errors);
  const lines = validateLines(record.lines, errors);
  const payment = validatePayment(record.payment, errors);
  if (
    record.notes !== undefined &&
    record.notes !== null &&
    typeof record.notes !== "string"
  ) {
    errors.push({
      field: "notes",
      message: "notes must be a string, or null."
    });
  }
  const notes = optionalText(record.notes, 1000);

  // `amountTendered` vs. the order total is NOT checked here — the total is
  // only known after the transaction's own re-quote (`buildCartQuote`
  // inside `createPosOrder`); `computeChange` below is what rejects an
  // insufficient tender, once the total exists to compare against.

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: {
      idempotencyKey: idempotencyKey.trim(),
      customer,
      lines,
      payment,
      notes
    }
  };
}

export class InsufficientTenderError extends Error {
  public readonly shortfall: string;
  constructor(shortfall: string) {
    super("payment.amountTendered is less than the order total.");
    this.name = "InsufficientTenderError";
    this.shortfall = shortfall;
  }
}

/**
 * `change = amountTendered - total`, both `numeric(14,2)` strings, computed
 * entirely in integer cents as `bigint` (ADR-0003 — never `Number(...)`,
 * never a float; `"0.10" + "0.20"` is exactly `"0.30"` here).
 *
 * @throws {RangeError} either argument is not a `numeric(14,2)`-shaped string.
 * @throws {InsufficientTenderError} `amountTendered` is less than `total` —
 *   a cashier typo (or a customer who does not actually have the cash) must
 *   fail the sale, never silently record a negative change.
 */
export function computeChange(amountTendered: string, total: string): string {
  if (!MONEY_PATTERN.test(amountTendered)) {
    throw new RangeError("amountTendered must be a numeric(14,2) string.");
  }
  if (!MONEY_PATTERN.test(total)) {
    throw new RangeError("total must be a numeric(14,2) string.");
  }
  const tenderedCents = toCents(amountTendered);
  const totalCents = toCents(total);
  if (tenderedCents < totalCents) {
    throw new InsufficientTenderError(fromCents(totalCents - tenderedCents));
  }
  return fromCents(tenderedCents - totalCents);
}
