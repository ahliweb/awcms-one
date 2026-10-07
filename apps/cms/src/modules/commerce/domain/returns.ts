/**
 * Returns, refunds and exchanges — the pure half (Issue #287, ADR-0033).
 * No database, no I/O, no clock: every rule the application layer and the
 * unit tests both need lives here, so "exact to the cent" and "never more
 * than was sold" are properties of one function each rather than of a SQL
 * statement somebody has to re-derive.
 *
 * ## Money: integer cents, one decomposition, no drift
 *
 * An order line of `lineTotal` for `quantity` units is split into per-UNIT
 * amounts with the "first units carry the leftover cents" rule:
 * `unit(i) = floor(total / n) + (i <= total mod n ? 1 : 0)`. A return of units
 * `before+1 .. before+k` is worth the sum of exactly those units, so
 *
 *   * the values of several partial returns of one line add up to the line's
 *     value to the cent once every unit has gone back (no rounding residue is
 *     ever left on the table or invented);
 *   * the value of a return does not depend on how the units were split into
 *     returns (return 2 then 1 equals return 1 then 2 for the same units);
 *   * the discount released with the goods uses the SAME decomposition on the
 *     line's share of the order discount, with the SAME direction, which makes
 *     `refund = goods - discount` non-negative for every unit (a unit carrying
 *     an extra discount cent also carries the extra goods cent, because the
 *     line's goods total is never smaller than its discount).
 *
 * The order discount is spread over lines by the largest-remainder method on
 * integer cents, so the shares sum to the order discount exactly.
 *
 * ## Tax (Issue #323)
 *
 * The tax charged on a returned unit is refunded with it. In flat mode (and
 * for an order with no tax snapshot) the order's stored tax is prorated with
 * the SAME two steps: {@link allocateOrderTax} spreads it over the lines
 * (largest remainder, weighted by each line's value AFTER its discount share -
 * the base the tax was charged on), then {@link computeReturnValue} takes the
 * returned units' share of the line's tax with the same first-units-carry-the-
 * cents rule. The tax refunded by every return of an order therefore never
 * exceeds the order's tax and equals it exactly once every unit has gone back.
 * In engine mode the figure is the tax module's reversal snapshot instead
 * (`tax-adapter-directory.ts`); see ADR-0033's tax addendum.
 *
 * ## Refund planning
 *
 * A refund goes back along the payments that funded the order, newest first,
 * each capped at what that payment can still give back (its amount, less
 * reversals already booked, less legs already promised to a pending refund).
 */
import { fromCents, toCents } from "./price-calculation";

export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const RETURN_REASONS = [
  "defective",
  "wrong_item",
  "not_as_described",
  "damaged_in_transit",
  "changed_mind",
  "size_fit",
  "duplicate_order",
  "other"
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/**
 * What happens to the returned units. `restock` puts them back into SELLABLE
 * stock; `damaged` and `quarantine` are recorded on the return line and change
 * no sellable stock (the unit is not available to sell).
 */
export const RETURN_DISPOSITIONS = [
  "restock",
  "damaged",
  "quarantine"
] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

export const RETURN_KINDS = ["return", "exchange"] as const;
export type ReturnKind = (typeof RETURN_KINDS)[number];

export const RETURN_STATUSES = ["open", "completed"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const REFUND_STATUSES = [
  "pending",
  "processing",
  "succeeded",
  "failed"
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const REFUND_DESTINATIONS = ["original_tender", "store_credit"] as const;
export type RefundDestination = (typeof REFUND_DESTINATIONS)[number];

export const REFUND_SETTLED_VIA = [
  "ledger",
  "provider",
  "offline",
  "store_credit"
] as const;
export type RefundSettledVia = (typeof REFUND_SETTLED_VIA)[number];

/** Orders whose goods have been (or are being) delivered: the only ones a return can be recorded against. A cancelled/expired/refunded order never had its sale completed. */
export const RETURNABLE_ORDER_STATUSES = [
  "paid",
  "processing",
  "shipped",
  "completed"
] as const;

export function isReturnableOrderStatus(status: string): boolean {
  return (RETURNABLE_ORDER_STATUSES as readonly string[]).includes(status);
}

/** The `to_status` of the order-event row a return announces itself with (the sales projections key on it). */
export const RETURN_ORDER_EVENT_STATUS = "returned";

export const MAX_RETURN_LINES = 50;
export const MAX_RETURN_NOTE_LENGTH = 500;
export const MAX_OFFLINE_REASON_LENGTH = 500;
export const MAX_RETURN_LINE_QUANTITY = 100_000;

// ---------------------------------------------------------------------------
// Integer-cents decomposition
// ---------------------------------------------------------------------------

/** `floor(total / n)` plus one cent for each of the first `total mod n` units. */
function unitCents(total: bigint, n: bigint, index: bigint): bigint {
  const base = total / n;
  const extra = total % n;
  return base + (index <= extra ? 1n : 0n);
}

/** Sum of units `from+1 .. from+count` (1-based) of a `total` split over `n` units. */
export function sumUnitCents(
  total: bigint,
  n: number,
  from: number,
  count: number
): bigint {
  if (n <= 0) throw new RangeError("n must be positive.");
  if (from < 0 || count < 0 || from + count > n) {
    throw new RangeError("The unit range is outside 1..n.");
  }
  if (count === 0) return 0n;
  const nn = BigInt(n);
  const base = total / nn;
  const extra = total % nn;
  const fromB = BigInt(from);
  const countB = BigInt(count);
  const upper = fromB + countB < extra ? fromB + countB : extra;
  const carried = upper > fromB ? upper - fromB : 0n;
  return base * countB + carried;
}

/**
 * The order discount (cents) allocated to each line by the largest-remainder
 * method: every share is `floor(D * L_i / S)`, then the leftover cents go to
 * the lines with the largest remainders (ties broken by position). The shares
 * sum to `min(D, S)` exactly and never exceed their line.
 */
export function allocateOrderDiscount(
  lineTotals: readonly bigint[],
  discountCents: bigint
): bigint[] {
  const subtotal = lineTotals.reduce((sum, v) => sum + v, 0n);
  const target = discountCents < subtotal ? discountCents : subtotal;
  if (subtotal === 0n || target <= 0n) return lineTotals.map(() => 0n);
  const shares = lineTotals.map((line) => (target * line) / subtotal);
  let leftover = target - shares.reduce((sum, v) => sum + v, 0n);
  const order = lineTotals
    .map((line, index) => ({ index, remainder: (target * line) % subtotal }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1
    );
  for (const { index } of order) {
    if (leftover === 0n) break;
    if (shares[index]! < lineTotals[index]!) {
      shares[index]! += 1n;
      leftover -= 1n;
    }
  }
  return shares;
}

/**
 * The order's tax (cents) allocated to each line, weighted by the line's
 * `lineNetCents` (line total minus its discount share). Reuses
 * {@link allocateOrderDiscount} - one allocation, not a second one: the shares
 * sum to `min(tax, Σ net)` and never exceed their line. A negative or zero tax
 * allocates nothing.
 */
export function allocateOrderTax(
  lineNetCents: readonly bigint[],
  taxCents: bigint
): bigint[] {
  return allocateOrderDiscount(lineNetCents, taxCents > 0n ? taxCents : 0n);
}

export type ReturnValueInput = {
  /** The line's total, `order_items.line_total` (pre-discount). */
  lineTotalCents: bigint;
  /** The part of the order discount allocated to this line ({@link allocateOrderDiscount}). */
  lineDiscountCents: bigint;
  /** The part of the order's tax allocated to this line ({@link allocateOrderTax}); omitted = 0 (inclusive pricing / no tax). */
  lineTaxCents?: bigint;
  /** Units sold on the line. */
  quantity: number;
  /** Units of this line already returned. */
  alreadyReturned: number;
  /** Units being returned now. */
  returning: number;
};

export type ReturnValue = {
  goodsGrossCents: bigint;
  discountShareCents: bigint;
  /** Goods minus discount - the line's refund value BEFORE tax (`return_lines.refund_amount`). */
  refundCents: bigint;
  /** The prorated tax of the returned units (flat decomposition); 0 when no `lineTaxCents`. */
  taxCents: bigint;
};

/** Value of returning `returning` more units of a line. @throws {RangeError} more than remains. */
export function computeReturnValue(input: ReturnValueInput): ReturnValue {
  const remaining = input.quantity - input.alreadyReturned;
  if (
    !Number.isInteger(input.returning) ||
    input.returning < 1 ||
    input.returning > remaining
  ) {
    throw new RangeError(
      `Cannot return ${input.returning} unit(s): ${remaining} remain eligible.`
    );
  }
  const goods = sumUnitCents(
    input.lineTotalCents,
    input.quantity,
    input.alreadyReturned,
    input.returning
  );
  const discount = sumUnitCents(
    input.lineDiscountCents,
    input.quantity,
    input.alreadyReturned,
    input.returning
  );
  const tax = sumUnitCents(
    input.lineTaxCents ?? 0n,
    input.quantity,
    input.alreadyReturned,
    input.returning
  );
  return {
    goodsGrossCents: goods,
    discountShareCents: discount,
    refundCents: goods - discount,
    taxCents: tax
  };
}

/** Units of a line still eligible to be returned (never negative). */
export function remainingEligibleQuantity(
  sold: number,
  alreadyReturned: number
): number {
  return Math.max(0, sold - alreadyReturned);
}

/** The unit value used by the unused-helper parity test (units 1..n of a total). */
export function unitValueCents(
  total: bigint,
  n: number,
  index: number
): bigint {
  return unitCents(total, BigInt(n), BigInt(index));
}

// ---------------------------------------------------------------------------
// Refund planning
// ---------------------------------------------------------------------------

export type RefundablePayment = {
  allocationId: string;
  tenderType: string;
  /** Applied amount of the payment, cents. */
  amountCents: bigint;
  /** Σ succeeded reversals already booked against it, cents. */
  reversedCents: bigint;
  /** Σ pending / processing refund legs already promised along it, cents. */
  promisedCents: bigint;
  /** Newest first ordering key (an ISO timestamp, then the insertion sequence). */
  createdAt: string;
  entrySeq: number;
};

export type PlannedRefundLeg = {
  allocationId: string;
  tenderType: string;
  amountCents: bigint;
};

export type RefundPlan =
  | { ok: true; legs: PlannedRefundLeg[]; refundableCents: bigint }
  | { ok: false; refundableCents: bigint };

export function refundableOf(payment: RefundablePayment): bigint {
  const left =
    payment.amountCents - payment.reversedCents - payment.promisedCents;
  return left > 0n ? left : 0n;
}

/**
 * Splits `totalCents` over the payments, newest first, each capped at what it
 * can still give back. Not enough room anywhere is `ok: false` with the total
 * that WAS refundable — never a partial plan.
 */
export function planRefundLegs(
  payments: readonly RefundablePayment[],
  totalCents: bigint
): RefundPlan {
  const ordered = [...payments].sort((a, b) =>
    a.createdAt === b.createdAt
      ? b.entrySeq - a.entrySeq
      : a.createdAt < b.createdAt
        ? 1
        : -1
  );
  const refundableCents = ordered.reduce((sum, p) => sum + refundableOf(p), 0n);
  if (totalCents < 0n || totalCents > refundableCents) {
    return { ok: false, refundableCents };
  }
  const legs: PlannedRefundLeg[] = [];
  let left = totalCents;
  for (const payment of ordered) {
    if (left === 0n) break;
    const room = refundableOf(payment);
    if (room === 0n) continue;
    const take = room < left ? room : left;
    legs.push({
      allocationId: payment.allocationId,
      tenderType: payment.tenderType,
      amountCents: take
    });
    left -= take;
  }
  return { ok: true, legs, refundableCents };
}

/**
 * The fraction of an amount that a cumulative refund represents:
 * `floor(amount * refunded / total)`, capped at `amount` — exact at 100%.
 * Used for the proportional compensations (loyalty points, affiliate
 * commission); each step compensates the DIFFERENCE between this cumulative
 * target and what was already compensated, so the pieces always add up.
 */
export function proportionalCents(
  amountCents: bigint,
  refundedCents: bigint,
  totalCents: bigint
): bigint {
  if (totalCents <= 0n || refundedCents <= 0n || amountCents <= 0n) return 0n;
  if (refundedCents >= totalCents) return amountCents;
  return (amountCents * refundedCents) / totalCents;
}

/** Same rule for an integer count (loyalty points). */
export function proportionalPoints(
  points: number,
  refundedCents: bigint,
  totalCents: bigint
): number {
  return Number(proportionalCents(BigInt(points), refundedCents, totalCents));
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
  errors: ValidationError[]
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    errors.push({ field, message: `${field} must be a string, or null.` });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    errors.push({
      field,
      message: `${field} must be at most ${max} characters.`
    });
  }
  return trimmed.slice(0, max);
}

function validateKey(key: string, errors: ValidationError[]): string {
  if (typeof key !== "string" || key.trim().length === 0) {
    errors.push({
      field: "Idempotency-Key",
      message: "Idempotency-Key header is required."
    });
    return "";
  }
  if (key.length > 200) {
    errors.push({
      field: "Idempotency-Key",
      message: "Idempotency-Key must be at most 200 characters."
    });
  }
  return key.trim().slice(0, 200);
}

export type CreateReturnLineInput = {
  orderItemId: string;
  quantity: number;
  reason: ReturnReason;
  disposition: ReturnDisposition;
  note: string | null;
};

export type CreateReturnRefundInput = {
  destination: RefundDestination;
  /** Optional shipping refund, `numeric(14,2)`; `null` = none. */
  shippingRefund: string | null;
  /** Cash refunds are paid out of THIS open drawer session (ADR-0028 D2). */
  registerSessionId: string | null;
  /** Store credit: an existing account to load; `null` = issue a new one. */
  storeCreditAccountId: string | null;
};

export type CreateReturnInput = {
  idempotencyKey: string;
  kind: ReturnKind;
  lines: CreateReturnLineInput[];
  note: string | null;
  /** `null` = record the return and stock effect only; no refund is made. */
  refund: CreateReturnRefundInput | null;
  /** An exchange may name its replacement order up front. */
  exchangeOrderId: string | null;
};

export function validateCreateReturnInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<CreateReturnInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateKey(idempotencyKey, errors);

  const kind = record.kind === undefined ? "return" : (record.kind as string);
  if (!(RETURN_KINDS as readonly string[]).includes(kind)) {
    errors.push({
      field: "kind",
      message: `kind must be one of: ${RETURN_KINDS.join(", ")}.`
    });
  }

  const lines: CreateReturnLineInput[] = [];
  if (!Array.isArray(record.lines) || record.lines.length === 0) {
    errors.push({
      field: "lines",
      message: "lines must be a non-empty array."
    });
  } else if (record.lines.length > MAX_RETURN_LINES) {
    errors.push({
      field: "lines",
      message: `lines must have at most ${MAX_RETURN_LINES} entries.`
    });
  } else {
    const seen = new Set<string>();
    record.lines.forEach((raw, index) => {
      const field = `lines[${index}]`;
      if (!isRecord(raw)) {
        errors.push({ field, message: `${field} must be an object.` });
        return;
      }
      const orderItemId = raw.orderItemId;
      if (typeof orderItemId !== "string" || !UUID_PATTERN.test(orderItemId)) {
        errors.push({
          field: `${field}.orderItemId`,
          message: "orderItemId must be a UUID."
        });
      } else if (seen.has(orderItemId.toLowerCase())) {
        errors.push({
          field: `${field}.orderItemId`,
          message: "Each order line may appear once per return."
        });
      } else {
        seen.add(orderItemId.toLowerCase());
      }
      const quantity = raw.quantity;
      if (
        typeof quantity !== "number" ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > MAX_RETURN_LINE_QUANTITY
      ) {
        errors.push({
          field: `${field}.quantity`,
          message: "quantity must be a positive integer."
        });
      }
      const reason = raw.reason;
      if (
        typeof reason !== "string" ||
        !(RETURN_REASONS as readonly string[]).includes(reason)
      ) {
        errors.push({
          field: `${field}.reason`,
          message: `reason is required, one of: ${RETURN_REASONS.join(", ")}.`
        });
      }
      const disposition = raw.disposition;
      if (
        typeof disposition !== "string" ||
        !(RETURN_DISPOSITIONS as readonly string[]).includes(disposition)
      ) {
        errors.push({
          field: `${field}.disposition`,
          message: `disposition is required, one of: ${RETURN_DISPOSITIONS.join(", ")}.`
        });
      }
      const note = optionalText(
        raw.note,
        `${field}.note`,
        MAX_RETURN_NOTE_LENGTH,
        errors
      );
      lines.push({
        orderItemId: typeof orderItemId === "string" ? orderItemId : "",
        quantity: typeof quantity === "number" ? quantity : 0,
        reason: reason as ReturnReason,
        disposition: disposition as ReturnDisposition,
        note
      });
    });
  }

  const note = optionalText(
    record.note,
    "note",
    MAX_RETURN_NOTE_LENGTH,
    errors
  );

  let refund: CreateReturnRefundInput | null = null;
  if (record.refund !== undefined && record.refund !== null) {
    if (!isRecord(record.refund)) {
      errors.push({
        field: "refund",
        message: "refund must be an object, or null."
      });
    } else {
      const r = record.refund;
      const destination =
        r.destination === undefined ? "original_tender" : r.destination;
      if (
        typeof destination !== "string" ||
        !(REFUND_DESTINATIONS as readonly string[]).includes(destination)
      ) {
        errors.push({
          field: "refund.destination",
          message: `destination must be one of: ${REFUND_DESTINATIONS.join(", ")}.`
        });
      }
      let shippingRefund: string | null = null;
      if (r.shippingRefund !== undefined && r.shippingRefund !== null) {
        if (
          typeof r.shippingRefund !== "string" ||
          !MONEY_PATTERN.test(r.shippingRefund)
        ) {
          errors.push({
            field: "refund.shippingRefund",
            message:
              "shippingRefund must be a numeric(14,2) string, never a JSON number."
          });
        } else if (toCents(r.shippingRefund) > 0n) {
          shippingRefund = fromCents(toCents(r.shippingRefund));
        }
      }
      let registerSessionId: string | null = null;
      if (r.registerSessionId !== undefined && r.registerSessionId !== null) {
        if (
          typeof r.registerSessionId !== "string" ||
          !UUID_PATTERN.test(r.registerSessionId)
        ) {
          errors.push({
            field: "refund.registerSessionId",
            message: "registerSessionId must be a UUID, or null."
          });
        } else {
          registerSessionId = r.registerSessionId;
        }
      }
      let storeCreditAccountId: string | null = null;
      if (
        r.storeCreditAccountId !== undefined &&
        r.storeCreditAccountId !== null
      ) {
        if (
          typeof r.storeCreditAccountId !== "string" ||
          !UUID_PATTERN.test(r.storeCreditAccountId)
        ) {
          errors.push({
            field: "refund.storeCreditAccountId",
            message: "storeCreditAccountId must be a UUID, or null."
          });
        } else {
          storeCreditAccountId = r.storeCreditAccountId;
        }
      }
      if (
        destination !== "store_credit" &&
        r.storeCreditAccountId !== undefined &&
        r.storeCreditAccountId !== null
      ) {
        errors.push({
          field: "refund.storeCreditAccountId",
          message:
            "storeCreditAccountId is only valid for a store_credit destination."
        });
      }
      refund = {
        destination: destination as RefundDestination,
        shippingRefund,
        registerSessionId,
        storeCreditAccountId
      };
    }
  }

  let exchangeOrderId: string | null = null;
  if (record.exchangeOrderId !== undefined && record.exchangeOrderId !== null) {
    if (
      typeof record.exchangeOrderId !== "string" ||
      !UUID_PATTERN.test(record.exchangeOrderId)
    ) {
      errors.push({
        field: "exchangeOrderId",
        message: "exchangeOrderId must be a UUID, or null."
      });
    } else if (kind !== "exchange") {
      errors.push({
        field: "exchangeOrderId",
        message: "exchangeOrderId is only valid for kind exchange."
      });
    } else {
      exchangeOrderId = record.exchangeOrderId;
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      kind: kind as ReturnKind,
      lines,
      note,
      refund,
      exchangeOrderId
    }
  };
}

export type LinkExchangeOrderInput = {
  idempotencyKey: string;
  orderId: string;
};

export function validateLinkExchangeOrderInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<LinkExchangeOrderInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateKey(idempotencyKey, errors);
  if (
    typeof record.orderId !== "string" ||
    !UUID_PATTERN.test(record.orderId)
  ) {
    errors.push({ field: "orderId", message: "orderId must be a UUID." });
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { idempotencyKey: key, orderId: record.orderId as string }
  };
}

export type ExecuteRefundInput = {
  idempotencyKey: string;
  /** Cash refunds are paid out of THIS open drawer session (ADR-0028 D2). */
  registerSessionId: string | null;
};

export function validateExecuteRefundInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<ExecuteRefundInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateKey(idempotencyKey, errors);
  let registerSessionId: string | null = null;
  if (
    record.registerSessionId !== undefined &&
    record.registerSessionId !== null
  ) {
    if (
      typeof record.registerSessionId !== "string" ||
      !UUID_PATTERN.test(record.registerSessionId)
    ) {
      errors.push({
        field: "registerSessionId",
        message: "registerSessionId must be a UUID, or null."
      });
    } else {
      registerSessionId = record.registerSessionId;
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { idempotencyKey: key, registerSessionId } };
}

export type OfflineRefundInput = {
  idempotencyKey: string;
  reason: string;
};

export function validateOfflineRefundInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<OfflineRefundInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateKey(idempotencyKey, errors);
  const reason = optionalText(
    record.reason,
    "reason",
    MAX_OFFLINE_REASON_LENGTH,
    errors
  );
  if (reason === null && !errors.some((e) => e.field === "reason")) {
    errors.push({
      field: "reason",
      message:
        "reason is required: say how and when the refund was made outside the system."
    });
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { idempotencyKey: key, reason: reason! } };
}
