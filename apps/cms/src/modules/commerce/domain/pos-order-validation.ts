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
import {
  InsufficientTenderError,
  validatePosTenders,
  type TenderInput
} from "./payment-allocation";
import { fromCents, toCents } from "./price-calculation";
import { isUuid } from "./register";

// One class for "the tenders do not cover the total" across the legacy
// single-tender arithmetic below and the multi-tender planner
// (`payment-allocation.ts`, Issue #285) - re-exported so every existing
// importer (the route, the integration tests) keeps its import path.
export { InsufficientTenderError };

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
  /**
   * The LEGACY single-tender payload (`payment: { method, amountTendered }`) -
   * `amountTendered` is a `numeric(14,2)` string for `cash`, always `null` for
   * `manual_qris`. Exactly one of `payment` / `tenders` is non-null; the legacy
   * form is adapted to one ledger leg (`createPosOrder`), byte-for-byte the
   * behaviour it had before Issue #285.
   */
  payment: { method: PosPaymentMethod; amountTendered: string | null } | null;
  /**
   * The explicit multi-tender payload (Issue #285, ADR-0025): `tenders: [
   * { tenderType, amount, reference? } ]`. For a non-cash tender `amount` is
   * the amount applied to the sale; for the (single, optional) cash tender it
   * is the amount HANDED OVER - the server derives what is applied and the
   * change, from the cash leg only (`payment-allocation.ts`'s `planTenders`).
   */
  tenders: TenderInput[] | null;
  /**
   * `true` lets the sale finalize with a balance still DUE (an explicit,
   * permissioned credit sale - `commerce.pos_due.create`). Only valid with
   * `tenders`; the sale stays `pending_payment` with the outstanding amount
   * on its ledger until later payments settle it.
   */
  allowDue: boolean;
  /**
   * Issue #284 (ADR-0028) - the register the sale is rung up on. Required (by
   * `createPosOrder`, not by shape) when the tenant's `register` feature is
   * on: the sale is attached to that register's open session. Optional and
   * ignored-by-absence when the feature is off, so every pre-existing client
   * payload keeps working. Sending it while the feature is off is refused
   * (`409 FEATURE_DISABLED`) rather than silently not attaching the sale.
   */
  registerId?: string | null;
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
): NonNullable<CreatePosOrderInput["payment"]> {
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

  // Exactly one payment shape: the legacy `payment` object, or the explicit
  // `tenders[]` array (Issue #285). Neither falls through to the legacy
  // validator so an old client that forgot `payment` gets the same message it
  // always did.
  const hasTenders = record.tenders !== undefined && record.tenders !== null;
  const hasPayment = record.payment !== undefined && record.payment !== null;
  let payment: CreatePosOrderInput["payment"] = null;
  let tenders: CreatePosOrderInput["tenders"] = null;
  let allowDue = false;
  if (hasTenders && hasPayment) {
    errors.push({
      field: "payment",
      message: "Send either payment or tenders, not both."
    });
  } else if (hasTenders) {
    tenders = validatePosTenders(record.tenders, errors);
  } else {
    payment = validatePayment(record.payment, errors);
  }
  if (record.allowDue !== undefined && record.allowDue !== null) {
    if (typeof record.allowDue !== "boolean") {
      errors.push({
        field: "allowDue",
        message: "allowDue must be a boolean."
      });
    } else if (record.allowDue && tenders === null) {
      errors.push({
        field: "allowDue",
        message: "allowDue is only valid together with tenders[]."
      });
    } else {
      allowDue = record.allowDue;
    }
  }
  if (tenders !== null && tenders.length === 0 && !allowDue) {
    errors.push({
      field: "tenders",
      message:
        "tenders must contain at least one entry unless allowDue is true."
    });
  }
  let registerId: string | null = null;
  if (record.registerId !== undefined && record.registerId !== null) {
    if (isUuid(record.registerId)) {
      registerId = record.registerId;
    } else {
      errors.push({
        field: "registerId",
        message: "registerId must be a UUID, or null."
      });
    }
  }
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
      tenders,
      allowDue,
      registerId,
      notes
    }
  };
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
