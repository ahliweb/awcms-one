/**
 * Payment-allocation ledger rules (Issue #285, epic #281, ADR-0025). Pure —
 * no database, no I/O. Everything that decides what a set of ledger rows
 * MEANS lives here, so the SQL layer
 * (`application/payment-allocation-directory.ts`) only stores and sums, and
 * every rule below is unit-testable to the cent.
 *
 * ## Money
 *
 * Every figure is an integer number of cents (`bigint`, via
 * `price-calculation.ts`'s `toCents`/`fromCents` — the module's one decimal
 * parser) and crosses the wire as a `numeric(14,2)` STRING (ADR-0003). No
 * `Number(...)`, no float: `"0.10" + "0.20"` is exactly `"0.30"` here.
 *
 * ## Settlement is derived, never stored
 *
 *   settled     = Σ succeeded `payment` rows − Σ succeeded `reversal` rows
 *   outstanding = max(0, total − settled)
 *   overpaid    = max(0, settled − total)
 *
 * A `pending` (an in-flight gateway leg) or `failed` row never counts. The
 * order's cached `payment_status` is a pure function of that derivation
 * ({@link derivePaymentStatus}); the ORDER LIFECYCLE (`status`) is a
 * separate axis — it reaches `paid` when settlement reaches the order's
 * release threshold ({@link releaseThresholdCents}), and a later reversal
 * lowers `settled` and the payment status without ever moving the lifecycle
 * backwards (cancelling or refunding fulfilment stays a human decision —
 * `domain/order-status.ts`'s header).
 *
 * ## Cash change is computed from the cash leg ONLY
 *
 * {@link planTenders} subtracts every non-cash tender from the amount due
 * FIRST, then applies cash to what is left: `change = cash handed over −
 * remaining after the non-cash tenders`, never negative. A short cash tender
 * is a shortfall (or an explicit, permissioned due balance) — it can never
 * be papered over by change arithmetic, and a non-cash tender can never
 * exceed what is still owed.
 */
import { fromCents, toCents } from "./price-calculation";

export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

/**
 * `store_credit`/`gift_card` are NOT here on purpose: the value ledgers of
 * #288/#289 do not exist, and a tender no code path can write is a claim, not
 * a feature (`sql/940`'s header). Widen this list and the table's CHECK in
 * the migration that ships the first writer.
 */
export const PAYMENT_TENDER_TYPES = [
  "cash",
  "manual_qris",
  "manual_bank_transfer",
  "gateway"
] as const;
export type PaymentTenderType = (typeof PAYMENT_TENDER_TYPES)[number];

/**
 * The tenders a STAFF member may record by hand. `gateway` is excluded: a
 * gateway leg is only ever created by the hosted-checkout flow
 * (`payment-gateway-directory.ts`) and resolved by its webhook/reconcile
 * path — an operator typing "gateway, Rp 100.000" would be asserting money
 * the provider never confirmed.
 */
export const OWNER_RECORDABLE_TENDER_TYPES = [
  "cash",
  "manual_qris",
  "manual_bank_transfer"
] as const satisfies readonly PaymentTenderType[];
export type OwnerRecordableTenderType =
  (typeof OWNER_RECORDABLE_TENDER_TYPES)[number];

export const PAYMENT_ALLOCATION_KINDS = ["payment", "reversal"] as const;
export type PaymentAllocationKind = (typeof PAYMENT_ALLOCATION_KINDS)[number];

export const PAYMENT_ALLOCATION_STATUSES = [
  "pending",
  "succeeded",
  "failed"
] as const;
export type PaymentAllocationStatus =
  (typeof PAYMENT_ALLOCATION_STATUSES)[number];

export const PAYMENT_ALLOCATION_SOURCES = [
  "pos",
  "admin",
  "storefront_manual",
  "gateway_checkout",
  "gateway_webhook",
  "gateway_reconcile",
  "backfill"
] as const;
export type PaymentAllocationSource =
  (typeof PAYMENT_ALLOCATION_SOURCES)[number];

/** The cached order-level payment axis (`awcms_commerce_orders.payment_status`). */
export type SettlementPaymentStatus =
  "unpaid" | "partially_paid" | "dp_paid" | "paid" | "refunded";

/** Strict `numeric(14,2)`-shaped input: digits, at most two decimals, at most 12 whole digits. */
export const ALLOCATION_MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

const MAX_REFERENCE_LENGTH = 100;
const MAX_NOTE_LENGTH = 500;
const MAX_TENDERS = 10;

// ---------------------------------------------------------------------------
// Settlement derivation
// ---------------------------------------------------------------------------

export type LedgerRow = {
  kind: PaymentAllocationKind;
  status: PaymentAllocationStatus;
  /** `numeric(14,2)` string. */
  amount: string;
};

export type Settlement = {
  totalCents: bigint;
  /** Σ succeeded payments. */
  paidCents: bigint;
  /** Σ succeeded reversals. */
  reversedCents: bigint;
  /** paid − reversed (may exceed total when overpaid; never below 0 for a consistent ledger). */
  settledCents: bigint;
  outstandingCents: bigint;
  overpaidCents: bigint;
};

export function computeSettlement(
  total: string,
  rows: readonly LedgerRow[]
): Settlement {
  let paid = 0n;
  let reversed = 0n;
  for (const row of rows) {
    if (row.status !== "succeeded") continue;
    const cents = toCents(row.amount);
    if (row.kind === "payment") paid += cents;
    else reversed += cents;
  }
  const totalCents = toCents(total);
  const settled = paid - reversed;
  return {
    totalCents,
    paidCents: paid,
    reversedCents: reversed,
    settledCents: settled,
    outstandingCents: settled >= totalCents ? 0n : totalCents - settled,
    overpaidCents: settled > totalCents ? settled - totalCents : 0n
  };
}

export type SettlementView = {
  total: string;
  paid: string;
  reversed: string;
  settled: string;
  outstanding: string;
  overpaid: string;
  paymentStatus: SettlementPaymentStatus;
};

export function toSettlementView(
  settlement: Settlement,
  paymentStatus: SettlementPaymentStatus
): SettlementView {
  return {
    total: fromCents(settlement.totalCents),
    paid: fromCents(settlement.paidCents),
    reversed: fromCents(settlement.reversedCents),
    settled: fromCents(
      settlement.settledCents < 0n ? 0n : settlement.settledCents
    ),
    outstanding: fromCents(settlement.outstandingCents),
    overpaid: fromCents(settlement.overpaidCents),
    paymentStatus
  };
}

/**
 * The amount at which an order's LIFECYCLE may move `pending_payment ->
 * paid`. Normally the whole total. A down-payment order (`payment_method
 * 'dp'` with a `dp_amount` below the total) is released for fulfilment once
 * its down payment is covered — exactly what the pre-ledger flow did (the
 * first accepted confirmation flipped the order to `paid`); the ledger just
 * makes the remaining balance explicit instead of silently forgiving it.
 */
export function releaseThresholdCents(order: {
  total: string;
  paymentMethod: string;
  dpAmount: string | null;
}): bigint {
  const total = toCents(order.total);
  if (order.paymentMethod === "dp" && order.dpAmount !== null) {
    const dp = toCents(order.dpAmount);
    if (dp > 0n && dp < total) return dp;
  }
  return total;
}

export function derivePaymentStatus(
  settlement: Settlement,
  order: { total: string; paymentMethod: string; dpAmount: string | null }
): SettlementPaymentStatus {
  const { settledCents, totalCents, reversedCents } = settlement;
  if (settledCents <= 0n) {
    // Nothing net held. Money that came in and went back out is `refunded`;
    // an order that never received anything is `unpaid`. A zero-total order
    // owes nothing — it is settled by definition.
    if (totalCents === 0n) return "paid";
    return reversedCents > 0n ? "refunded" : "unpaid";
  }
  if (settledCents >= totalCents) return "paid";
  const dp = releaseThresholdCents(order);
  if (dp < totalCents && settledCents >= dp) return "dp_paid";
  return "partially_paid";
}

/** `true` once settlement has reached the point where the lifecycle may move to `paid`. */
export function hasReachedRelease(
  settlement: Settlement,
  order: { total: string; paymentMethod: string; dpAmount: string | null }
): boolean {
  return settlement.settledCents >= releaseThresholdCents(order);
}

// ---------------------------------------------------------------------------
// Tender planning (POS / any multi-tender settlement)
// ---------------------------------------------------------------------------

export type TenderInput = {
  tenderType: OwnerRecordableTenderType;
  /**
   * For a NON-cash tender: the amount applied to the order. For the cash
   * tender: the amount the customer HANDED OVER (the applied amount and the
   * change are derived by {@link planTenders}). `null` is the legacy-adapter
   * shorthand for "the whole remaining balance" (an old single-tender QRIS
   * payload carries no amount) and is only valid on one non-cash tender.
   */
  amount: string | null;
  reference: string | null;
};

export type PlannedTender = {
  tenderType: OwnerRecordableTenderType;
  /** Applied to the order, `numeric(14,2)`, > 0. */
  amount: string;
  /** Cash leg only. */
  tenderedAmount: string | null;
  /** Cash leg only; `"0.00"` when exact. */
  changeAmount: string | null;
  reference: string | null;
};

export type TenderPlan = {
  legs: PlannedTender[];
  /** What the sale still owes after these tenders (`"0.00"` when settled). */
  dueAmount: string;
  /** Total change handed back (cash leg), `null` when the sale had no cash leg. */
  changeAmount: string | null;
  /** Total cash handed over, `null` when the sale had no cash leg. */
  cashTendered: string | null;
};

export class InsufficientTenderError extends Error {
  public readonly shortfall: string;
  constructor(shortfall: string) {
    super("The tenders do not cover the order total.");
    this.name = "InsufficientTenderError";
    this.shortfall = shortfall;
  }
}

export class OverpaymentError extends Error {
  public readonly outstanding: string;
  public readonly attempted: string;
  constructor(outstanding: string, attempted: string) {
    super(
      "The amount exceeds what is still owed on the order (only a cash leg may exceed it, and only as change)."
    );
    this.name = "OverpaymentError";
    this.outstanding = outstanding;
    this.attempted = attempted;
  }
}

export class InvalidTenderPlanError extends Error {
  public readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "InvalidTenderPlanError";
    this.field = field;
  }
}

/**
 * Turns the tenders a cashier entered into the ledger legs to write.
 *
 * Rules (each one a unit test):
 *   1. At most one cash tender; non-cash tenders may repeat.
 *   2. Σ non-cash must not exceed the total — `OverpaymentError`. Only cash
 *      may exceed what is owed, and only as change.
 *   3. cash applied = min(cash handed over, total − Σ non-cash);
 *      change = handed over − applied. A cash tender when nothing is left to
 *      pay (non-cash already covered the total) is `InvalidTenderPlanError`
 *      — change is never produced out of thin air.
 *   4. If, after all tenders, an amount is still owed: `InsufficientTenderError`
 *      unless `allowDue` (a permissioned, explicit due balance), in which case
 *      the plan carries `dueAmount`.
 *   5. A `null` amount (legacy adapter) means "the whole remaining balance"
 *      and is valid only for exactly one non-cash tender and no other
 *      non-cash tender.
 */
export function planTenders(
  total: string,
  tenders: readonly TenderInput[],
  options: { allowDue: boolean }
): TenderPlan {
  const totalCents = toCents(total);

  const cashTenders = tenders.filter((t) => t.tenderType === "cash");
  if (cashTenders.length > 1) {
    throw new InvalidTenderPlanError(
      "tenders",
      "At most one cash tender is allowed; combine cash into a single amount."
    );
  }

  const remainderTenders = tenders.filter(
    (t) => t.tenderType !== "cash" && t.amount === null
  );
  if (remainderTenders.length > 0) {
    // Legacy adapter only: one non-cash tender standing for "the whole bill".
    if (tenders.length !== 1) {
      throw new InvalidTenderPlanError(
        "tenders",
        "A tender without an amount must be the only tender."
      );
    }
  }

  let nonCashCents = 0n;
  const legs: PlannedTender[] = [];

  for (const tender of tenders) {
    if (tender.tenderType === "cash") continue;
    let cents: bigint;
    if (tender.amount === null) {
      cents = totalCents;
    } else {
      if (!ALLOCATION_MONEY_PATTERN.test(tender.amount)) {
        throw new RangeError("tender amount must be a numeric(14,2) string.");
      }
      cents = toCents(tender.amount);
    }
    if (cents <= 0n) {
      throw new InvalidTenderPlanError(
        "tenders",
        "Every tender amount must be greater than zero."
      );
    }
    nonCashCents += cents;
    legs.push({
      tenderType: tender.tenderType,
      amount: fromCents(cents),
      tenderedAmount: null,
      changeAmount: null,
      reference: tender.reference
    });
  }

  if (nonCashCents > totalCents) {
    throw new OverpaymentError(fromCents(totalCents), fromCents(nonCashCents));
  }

  const remainingAfterNonCash = totalCents - nonCashCents;
  let changeCents = 0n;
  let cashHandedCents: bigint | null = null;
  let appliedCashCents = 0n;

  const cash = cashTenders[0];
  if (cash) {
    if (cash.amount === null || !ALLOCATION_MONEY_PATTERN.test(cash.amount)) {
      throw new RangeError("tender amount must be a numeric(14,2) string.");
    }
    const handed = toCents(cash.amount);
    if (handed <= 0n) {
      throw new InvalidTenderPlanError(
        "tenders",
        "Every tender amount must be greater than zero."
      );
    }
    if (remainingAfterNonCash === 0n) {
      throw new InvalidTenderPlanError(
        "tenders",
        "The non-cash tenders already cover the total; a cash tender would only produce change."
      );
    }
    cashHandedCents = handed;
    appliedCashCents =
      handed >= remainingAfterNonCash ? remainingAfterNonCash : handed;
    changeCents = handed - appliedCashCents;
    legs.push({
      tenderType: "cash",
      amount: fromCents(appliedCashCents),
      tenderedAmount: fromCents(handed),
      changeAmount: fromCents(changeCents),
      reference: cash.reference
    });
  }

  const dueCents = totalCents - nonCashCents - appliedCashCents;
  if (dueCents > 0n && !options.allowDue) {
    throw new InsufficientTenderError(fromCents(dueCents));
  }

  return {
    legs,
    dueAmount: fromCents(dueCents),
    changeAmount: cash ? fromCents(changeCents) : null,
    cashTendered: cashHandedCents === null ? null : fromCents(cashHandedCents)
  };
}

// ---------------------------------------------------------------------------
// Owner-side request validation
// ---------------------------------------------------------------------------

export type RecordPaymentInput = {
  idempotencyKey: string;
  tenderType: OwnerRecordableTenderType;
  /** Applied amount for non-cash; for `cash`, the amount handed over (change is derived). */
  amount: string;
  reference: string | null;
  note: string | null;
};

export type RecordReversalInput = {
  idempotencyKey: string;
  /** `null` = reverse whatever remains reversible of the payment. */
  amount: string | null;
  note: string;
};

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

function validateIdempotencyKey(
  key: string,
  errors: ValidationError[]
): string {
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

function positiveMoney(
  value: unknown,
  field: string,
  errors: ValidationError[]
): string {
  if (typeof value !== "string" || !ALLOCATION_MONEY_PATTERN.test(value)) {
    errors.push({
      field,
      message: `${field} must be a numeric(14,2) string (digits with at most two decimals), never a JSON number.`
    });
    return "0.00";
  }
  if (toCents(value) <= 0n) {
    errors.push({ field, message: `${field} must be greater than zero.` });
  }
  return fromCents(toCents(value));
}

export function validateRecordPaymentInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<RecordPaymentInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);

  const tenderValid =
    typeof record.tenderType === "string" &&
    (OWNER_RECORDABLE_TENDER_TYPES as readonly string[]).includes(
      record.tenderType
    );
  if (!tenderValid) {
    errors.push({
      field: "tenderType",
      message: `tenderType must be one of: ${OWNER_RECORDABLE_TENDER_TYPES.join(", ")}.`
    });
  }
  const amount = positiveMoney(record.amount, "amount", errors);
  const reference = optionalText(
    record.reference,
    "reference",
    MAX_REFERENCE_LENGTH,
    errors
  );
  const note = optionalText(record.note, "note", MAX_NOTE_LENGTH, errors);

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      tenderType: record.tenderType as OwnerRecordableTenderType,
      amount,
      reference,
      note
    }
  };
}

export function validateRecordReversalInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<RecordReversalInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);

  let amount: string | null = null;
  if (record.amount !== undefined && record.amount !== null) {
    amount = positiveMoney(record.amount, "amount", errors);
  }
  // A reversal takes money back out of the books; the reason is mandatory so
  // the audit trail and the ledger row both say why.
  const note = optionalText(record.note, "note", MAX_NOTE_LENGTH, errors);
  if (note === null && !errors.some((e) => e.field === "note")) {
    errors.push({ field: "note", message: "note (the reason) is required." });
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { idempotencyKey: key, amount, note: note! }
  };
}

/** Tender list shape for the POS `tenders[]` payload (explicit, versioned multi-tender contract). */
export function validatePosTenders(
  value: unknown,
  errors: ValidationError[]
): TenderInput[] {
  if (!Array.isArray(value)) {
    errors.push({ field: "tenders", message: "tenders must be an array." });
    return [];
  }
  if (value.length > MAX_TENDERS) {
    errors.push({
      field: "tenders",
      message: `tenders must contain at most ${MAX_TENDERS} entries.`
    });
  }
  const result: TenderInput[] = [];
  value.slice(0, MAX_TENDERS).forEach((entry, index) => {
    const prefix = `tenders[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ field: prefix, message: `${prefix} must be an object.` });
      return;
    }
    const tenderValid =
      typeof entry.tenderType === "string" &&
      (OWNER_RECORDABLE_TENDER_TYPES as readonly string[]).includes(
        entry.tenderType
      );
    if (!tenderValid) {
      errors.push({
        field: `${prefix}.tenderType`,
        message: `${prefix}.tenderType must be one of: ${OWNER_RECORDABLE_TENDER_TYPES.join(", ")}.`
      });
    }
    const amount = positiveMoney(entry.amount, `${prefix}.amount`, errors);
    const reference = optionalText(
      entry.reference,
      `${prefix}.reference`,
      MAX_REFERENCE_LENGTH,
      errors
    );
    if (tenderValid) {
      result.push({
        tenderType: entry.tenderType as OwnerRecordableTenderType,
        amount,
        reference
      });
    }
  });
  return result;
}

/** The legacy `orders.payment_method` summary hint for a ledger tender (the ledger, not this column, is the truth). */
export function tenderToOrderPaymentMethod(
  tenderType: PaymentTenderType
): "cash" | "manual_qris" | "manual_bank" | "gateway" {
  switch (tenderType) {
    case "cash":
      return "cash";
    case "manual_qris":
      return "manual_qris";
    case "manual_bank_transfer":
      return "manual_bank";
    case "gateway":
      return "gateway";
  }
}

/** The tender an accepted storefront manual-transfer confirmation maps to. */
export function confirmationMethodToTender(
  method: string
): "manual_qris" | "manual_bank_transfer" {
  return method === "manual_qris" ? "manual_qris" : "manual_bank_transfer";
}
