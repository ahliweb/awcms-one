/**
 * The commerce document lifecycle (Issue #286, epic #281 and #280, ADR-0029) —
 * the PURE half: vocabulary, status machines, request validation, numbering
 * format, the canonical content hash of a snapshot, and the render contract.
 * No database, no I/O (the application layer reads and writes; this file
 * decides), so every rule below is unit-testable.
 *
 * ## Five things, five vocabularies — never one `sale_status`
 *
 *   held sale      a parked cart                      (`HELD_SALE_STATUSES`)
 *   quotation      a versioned offer                  (`QUOTATION_STATUSES`)
 *   work order     an operational job record          (`WORK_ORDER_STATUSES`)
 *   commerce order the ONLY monetary authority        (ADR-0025, untouched)
 *   document       an immutable numbered snapshot     (`DOCUMENT_TYPES`)
 *
 * A future accounts-receivable invoice is a SIXTH thing that will reference a
 * document, not extend it (ADR-0029 D1).
 *
 * ## Money
 *
 * Every amount is a `numeric(14,2)` STRING (ADR-0003) and every comparison is
 * integer cents (`bigint`); nothing here uses `Number` for money.
 */
import { createHash } from "node:crypto";
import {
  isRecord,
  optionalText,
  validateIdempotencyKey,
  type ValidationError
} from "./payment-allocation";
import { fromCents, toCents } from "./price-calculation";

export type { ValidationError };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const DOCUMENT_SEQUENCE_TYPES = [
  "quotation",
  "work_order",
  "receipt",
  "invoice"
] as const;
export type DocumentSequenceType = (typeof DOCUMENT_SEQUENCE_TYPES)[number];

/** The two issuable legal documents (the sequence vocabulary minus the two operational ones). */
export const ISSUED_DOCUMENT_TYPES = ["receipt", "invoice"] as const;
export type IssuedDocumentType = (typeof ISSUED_DOCUMENT_TYPES)[number];

export const HELD_SALE_STATUSES = [
  "held",
  "resumed",
  "discarded",
  "expired"
] as const;
export type HeldSaleStatus = (typeof HELD_SALE_STATUSES)[number];

export const QUOTATION_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "expired",
  "converted",
  "cancelled"
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

export const WORK_ORDER_STATUSES = [
  "received",
  "scheduled",
  "in_progress",
  "on_hold",
  "ready",
  "completed",
  "cancelled"
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const WORK_ORDER_PRIORITIES = [
  "low",
  "normal",
  "high",
  "urgent"
] as const;
export type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];

export const DEFAULT_HOLD_TTL_HOURS = 24;
export const MAX_HOLD_TTL_HOURS = 168;
export const DEFAULT_QUOTATION_VALID_DAYS = 14;
export const MAX_QUOTATION_VALID_DAYS = 180;

const MAX_LINES = 100;
const MAX_QUANTITY = 10000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

export const DOCUMENT_NUMBER_PREFIX: Readonly<
  Record<DocumentSequenceType, string>
> = {
  quotation: "QUO",
  work_order: "WO",
  receipt: "RCP",
  invoice: "INV"
};

/** The numbering period of an instant: its UTC calendar year (ADR-0029 D3 - the counter restarts each January 1st UTC). */
export function numberingPeriod(at: Date): string {
  return String(at.getUTCFullYear()).padStart(4, "0");
}

/** `INV-2026-000042`: prefix, period, a six-digit zero-padded counter (it simply grows a digit past 999999). */
export function formatDocumentNumber(
  type: DocumentSequenceType,
  period: string,
  counter: number
): string {
  if (!Number.isInteger(counter) || counter < 1) {
    throw new RangeError("A document counter is a positive integer.");
  }
  return `${DOCUMENT_NUMBER_PREFIX[type]}-${period}-${String(counter).padStart(6, "0")}`;
}

const NUMBER_PATTERN = /^([A-Z]{2,3})-(\d{4})-(\d{6,})$/;

export function parseDocumentNumber(
  value: string
): { type: DocumentSequenceType; period: string; counter: number } | null {
  const match = NUMBER_PATTERN.exec(value);
  if (!match) return null;
  const type = DOCUMENT_SEQUENCE_TYPES.find(
    (candidate) => DOCUMENT_NUMBER_PREFIX[candidate] === match[1]
  );
  if (!type) return null;
  return { type, period: match[2]!, counter: Number(match[3]) };
}

// ---------------------------------------------------------------------------
// Status machines
// ---------------------------------------------------------------------------

export const LEGAL_QUOTATION_TRANSITIONS: Record<
  QuotationStatus,
  readonly QuotationStatus[]
> = {
  draft: ["sent", "cancelled"],
  sent: ["accepted", "rejected", "expired", "cancelled"],
  accepted: ["converted", "cancelled"],
  rejected: [],
  expired: [],
  converted: [],
  cancelled: []
};

/** A new version may be added (status returns to `draft`) from these states. */
export const REVISABLE_QUOTATION_STATUSES: readonly QuotationStatus[] = [
  "draft",
  "sent",
  "expired"
];

export function canTransitionQuotation(
  from: QuotationStatus,
  to: QuotationStatus
): boolean {
  return LEGAL_QUOTATION_TRANSITIONS[from].includes(to);
}

export const LEGAL_WORK_ORDER_TRANSITIONS: Record<
  WorkOrderStatus,
  readonly WorkOrderStatus[]
> = {
  received: ["scheduled", "in_progress", "cancelled"],
  scheduled: ["in_progress", "on_hold", "cancelled"],
  in_progress: ["on_hold", "ready", "cancelled"],
  on_hold: ["in_progress", "cancelled"],
  ready: ["completed", "in_progress"],
  completed: [],
  cancelled: []
};

export function canTransitionWorkOrder(
  from: WorkOrderStatus,
  to: WorkOrderStatus
): boolean {
  return LEGAL_WORK_ORDER_TRANSITIONS[from].includes(to);
}

/**
 * A held sale's EFFECTIVE status: a still-`held` row whose expiry has passed
 * reads as `expired` without any job having run (the stored status is
 * persisted lazily, on the first touch that finds it past due).
 */
export function effectiveHeldSaleStatus(
  status: HeldSaleStatus,
  expiresAt: Date,
  now: Date
): HeldSaleStatus {
  return status === "held" && expiresAt.getTime() <= now.getTime()
    ? "expired"
    : status;
}

/** A quotation's version validity: past `validUntil` an offer cannot be accepted. */
export function isQuotationVersionExpired(
  validUntil: Date,
  now: Date
): boolean {
  return validUntil.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export type CartLineInput = {
  productId: string;
  variantId: string | null;
  quantity: number;
};

function validateCartLines(
  value: unknown,
  errors: ValidationError[]
): CartLineInput[] {
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
      message: `lines may hold at most ${MAX_LINES} entries.`
    });
    return [];
  }
  const lines: CartLineInput[] = [];
  value.forEach((raw, index) => {
    const field = `lines[${index}]`;
    if (!isRecord(raw)) {
      errors.push({ field, message: `${field} must be an object.` });
      return;
    }
    if (!isUuid(raw.productId)) {
      errors.push({
        field: `${field}.productId`,
        message: `${field}.productId must be a UUID.`
      });
    }
    let variantId: string | null = null;
    if (raw.variantId !== undefined && raw.variantId !== null) {
      if (isUuid(raw.variantId)) variantId = raw.variantId;
      else {
        errors.push({
          field: `${field}.variantId`,
          message: `${field}.variantId must be a UUID, or null.`
        });
      }
    }
    if (
      typeof raw.quantity !== "number" ||
      !Number.isInteger(raw.quantity) ||
      raw.quantity < 1 ||
      raw.quantity > MAX_QUANTITY
    ) {
      errors.push({
        field: `${field}.quantity`,
        message: `${field}.quantity must be an integer between 1 and ${MAX_QUANTITY}.`
      });
    }
    if (isUuid(raw.productId) && typeof raw.quantity === "number") {
      lines.push({
        productId: raw.productId,
        variantId,
        quantity: raw.quantity
      });
    }
  });
  return lines;
}

export type CustomerSnapshotInput = { name: string; phone: string };

function validateCustomerSnapshot(
  value: unknown,
  errors: ValidationError[],
  required: boolean
): CustomerSnapshotInput | null {
  if (value === undefined || value === null) {
    if (required) {
      errors.push({ field: "customer", message: "customer is required." });
    }
    return null;
  }
  if (!isRecord(value)) {
    errors.push({ field: "customer", message: "customer must be an object." });
    return null;
  }
  const name = optionalText(value.name, "customer.name", 120, errors);
  const phone = optionalText(value.phone, "customer.phone", 32, errors);
  if (!name) {
    errors.push({
      field: "customer.name",
      message: "customer.name is required."
    });
  }
  if (!phone) {
    errors.push({
      field: "customer.phone",
      message: "customer.phone is required."
    });
  }
  return name && phone ? { name, phone } : null;
}

// -- Held sales ------------------------------------------------------------

export type HoldSaleInput = {
  idempotencyKey: string;
  label: string | null;
  lines: CartLineInput[];
  customer: { name: string | null; phone: string | null } | null;
  notes: string | null;
  registerId: string | null;
  ttlHours: number;
};

export function validateHoldSaleInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<HoldSaleInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  const label = optionalText(record.label, "label", 120, errors);
  const lines = validateCartLines(record.lines, errors);
  const notes = optionalText(record.notes, "notes", 1000, errors);

  let customer: HoldSaleInput["customer"] = null;
  if (record.customer !== undefined && record.customer !== null) {
    if (!isRecord(record.customer)) {
      errors.push({
        field: "customer",
        message: "customer must be an object."
      });
    } else {
      customer = {
        name: optionalText(record.customer.name, "customer.name", 120, errors),
        phone: optionalText(record.customer.phone, "customer.phone", 32, errors)
      };
    }
  }

  let registerId: string | null = null;
  if (record.registerId !== undefined && record.registerId !== null) {
    if (isUuid(record.registerId)) registerId = record.registerId;
    else {
      errors.push({
        field: "registerId",
        message: "registerId must be a UUID, or null."
      });
    }
  }

  let ttlHours = DEFAULT_HOLD_TTL_HOURS;
  if (record.ttlHours !== undefined && record.ttlHours !== null) {
    if (
      typeof record.ttlHours !== "number" ||
      !Number.isInteger(record.ttlHours) ||
      record.ttlHours < 1 ||
      record.ttlHours > MAX_HOLD_TTL_HOURS
    ) {
      errors.push({
        field: "ttlHours",
        message: `ttlHours must be an integer between 1 and ${MAX_HOLD_TTL_HOURS}.`
      });
    } else {
      ttlHours = record.ttlHours;
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      label,
      lines,
      customer,
      notes,
      registerId,
      ttlHours
    }
  };
}

/** The stored `cart` JSON of a held sale: the lines, the optional customer, the notes - nothing else, and never a price. */
export function buildHeldCart(input: HoldSaleInput): Record<string, unknown> {
  return {
    lines: input.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity
    })),
    customer: input.customer,
    notes: input.notes
  };
}

export type HeldSaleDecisionInput = { idempotencyKey: string };

export function validateHeldSaleDecisionInput(
  _body: unknown,
  idempotencyKey: string
): ValidationResult<HeldSaleDecisionInput> {
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { idempotencyKey: key } };
}

// -- Quotations ------------------------------------------------------------

export type QuotationContentInput = {
  lines: CartLineInput[];
  validUntil: Date;
  notes: string | null;
};

export type CreateQuotationInput = QuotationContentInput & {
  idempotencyKey: string;
  customer: CustomerSnapshotInput;
};

export type ReviseQuotationInput = QuotationContentInput & {
  idempotencyKey: string;
};

function resolveValidUntil(
  record: Record<string, unknown>,
  now: Date,
  errors: ValidationError[]
): Date {
  const fallback = new Date(
    now.getTime() + DEFAULT_QUOTATION_VALID_DAYS * 86_400_000
  );
  if (record.validUntil === undefined || record.validUntil === null) {
    return fallback;
  }
  if (typeof record.validUntil !== "string") {
    errors.push({
      field: "validUntil",
      message: "validUntil must be an ISO-8601 timestamp string."
    });
    return fallback;
  }
  const parsed = new Date(record.validUntil);
  if (Number.isNaN(parsed.getTime())) {
    errors.push({
      field: "validUntil",
      message: "validUntil must be an ISO-8601 timestamp string."
    });
    return fallback;
  }
  if (parsed.getTime() <= now.getTime()) {
    errors.push({
      field: "validUntil",
      message: "validUntil must be in the future."
    });
  }
  if (
    parsed.getTime() >
    now.getTime() + MAX_QUOTATION_VALID_DAYS * 86_400_000
  ) {
    errors.push({
      field: "validUntil",
      message: `validUntil may be at most ${MAX_QUOTATION_VALID_DAYS} days ahead.`
    });
  }
  return parsed;
}

export function validateCreateQuotationInput(
  body: unknown,
  idempotencyKey: string,
  now: Date = new Date()
): ValidationResult<CreateQuotationInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  const customer = validateCustomerSnapshot(record.customer, errors, true);
  const lines = validateCartLines(record.lines, errors);
  const validUntil = resolveValidUntil(record, now, errors);
  const notes = optionalText(record.notes, "notes", 1000, errors);
  if (errors.length > 0 || !customer) {
    return { valid: false, errors };
  }
  return {
    valid: true,
    value: { idempotencyKey: key, customer, lines, validUntil, notes }
  };
}

export function validateReviseQuotationInput(
  body: unknown,
  idempotencyKey: string,
  now: Date = new Date()
): ValidationResult<ReviseQuotationInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  const lines = validateCartLines(record.lines, errors);
  const validUntil = resolveValidUntil(record, now, errors);
  const notes = optionalText(record.notes, "notes", 1000, errors);
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { idempotencyKey: key, lines, validUntil, notes }
  };
}

export const QUOTATION_ACTIONS = [
  "send",
  "accept",
  "reject",
  "cancel"
] as const;
export type QuotationAction = (typeof QUOTATION_ACTIONS)[number];

export type QuotationActionInput = {
  idempotencyKey: string;
  note: string | null;
};

export function validateQuotationActionInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<QuotationActionInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  const note = optionalText(record.note, "note", 500, errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { idempotencyKey: key, note } };
}

export type ConvertQuotationInput = {
  idempotencyKey: string;
  registerId: string | null;
  /** The shopper-visible price may have moved since the quote; `true` accepts the CURRENT price. */
  acceptPriceChange: boolean;
};

export function validateConvertQuotationInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<ConvertQuotationInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  let registerId: string | null = null;
  if (record.registerId !== undefined && record.registerId !== null) {
    if (isUuid(record.registerId)) registerId = record.registerId;
    else {
      errors.push({
        field: "registerId",
        message: "registerId must be a UUID, or null."
      });
    }
  }
  let acceptPriceChange = false;
  if (
    record.acceptPriceChange !== undefined &&
    record.acceptPriceChange !== null
  ) {
    if (typeof record.acceptPriceChange !== "boolean") {
      errors.push({
        field: "acceptPriceChange",
        message: "acceptPriceChange must be a boolean."
      });
    } else {
      acceptPriceChange = record.acceptPriceChange;
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { idempotencyKey: key, registerId, acceptPriceChange }
  };
}

/** Whether two `numeric(14,2)` totals differ (integer cents, never a float compare). */
export function totalsDiffer(quoted: string, current: string): boolean {
  return toCents(quoted) !== toCents(current);
}

/** `current - quoted`, signed, as a `numeric(14,2)`-shaped string. */
export function signedDifference(quoted: string, current: string): string {
  const delta = toCents(current) - toCents(quoted);
  return delta < 0n ? `-${fromCents(-delta)}` : fromCents(delta);
}

// -- Work orders -----------------------------------------------------------

export type CreateWorkOrderInput = {
  idempotencyKey: string;
  title: string;
  description: string | null;
  priority: WorkOrderPriority;
  customerId: string | null;
  quotationId: string | null;
  orderId: string | null;
  assigneeTenantUserId: string | null;
  dueAt: Date | null;
};

function optionalUuid(
  value: unknown,
  field: string,
  errors: ValidationError[]
): string | null {
  if (value === undefined || value === null) return null;
  if (isUuid(value)) return value;
  errors.push({ field, message: `${field} must be a UUID, or null.` });
  return null;
}

function optionalDate(
  value: unknown,
  field: string,
  errors: ValidationError[]
): Date | null {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    errors.push({
      field,
      message: `${field} must be an ISO-8601 timestamp string, or null.`
    });
    return null;
  }
  return parsed;
}

export function validateCreateWorkOrderInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<CreateWorkOrderInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  const title = optionalText(record.title, "title", 160, errors);
  if (!title) errors.push({ field: "title", message: "title is required." });
  const description = optionalText(
    record.description,
    "description",
    2000,
    errors
  );
  let priority: WorkOrderPriority = "normal";
  if (record.priority !== undefined && record.priority !== null) {
    if (
      (WORK_ORDER_PRIORITIES as readonly unknown[]).includes(record.priority)
    ) {
      priority = record.priority as WorkOrderPriority;
    } else {
      errors.push({
        field: "priority",
        message: `priority must be one of: ${WORK_ORDER_PRIORITIES.join(", ")}.`
      });
    }
  }
  const customerId = optionalUuid(record.customerId, "customerId", errors);
  const quotationId = optionalUuid(record.quotationId, "quotationId", errors);
  const orderId = optionalUuid(record.orderId, "orderId", errors);
  const assigneeTenantUserId = optionalUuid(
    record.assigneeTenantUserId,
    "assigneeTenantUserId",
    errors
  );
  const dueAt = optionalDate(record.dueAt, "dueAt", errors);
  if (errors.length > 0 || !title) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      title,
      description,
      priority,
      customerId,
      quotationId,
      orderId,
      assigneeTenantUserId,
      dueAt
    }
  };
}

export type WorkOrderTransitionInput = {
  idempotencyKey: string;
  status: WorkOrderStatus | null;
  note: string | null;
  assigneeTenantUserId: string | null | undefined;
  dueAt: Date | null | undefined;
  priority: WorkOrderPriority | null;
};

/** `PATCH` body: a status move and/or an assignment/due-date/priority change; at least one. */
export function validateWorkOrderUpdateInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<WorkOrderTransitionInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  let status: WorkOrderStatus | null = null;
  if (record.status !== undefined && record.status !== null) {
    if ((WORK_ORDER_STATUSES as readonly unknown[]).includes(record.status)) {
      status = record.status as WorkOrderStatus;
    } else {
      errors.push({
        field: "status",
        message: `status must be one of: ${WORK_ORDER_STATUSES.join(", ")}.`
      });
    }
  }
  const note = optionalText(record.note, "note", 500, errors);
  let assigneeTenantUserId: string | null | undefined;
  if ("assigneeTenantUserId" in record) {
    assigneeTenantUserId = optionalUuid(
      record.assigneeTenantUserId,
      "assigneeTenantUserId",
      errors
    );
  }
  let dueAt: Date | null | undefined;
  if ("dueAt" in record) dueAt = optionalDate(record.dueAt, "dueAt", errors);
  let priority: WorkOrderPriority | null = null;
  if (record.priority !== undefined && record.priority !== null) {
    if (
      (WORK_ORDER_PRIORITIES as readonly unknown[]).includes(record.priority)
    ) {
      priority = record.priority as WorkOrderPriority;
    } else {
      errors.push({
        field: "priority",
        message: `priority must be one of: ${WORK_ORDER_PRIORITIES.join(", ")}.`
      });
    }
  }
  if (
    status === null &&
    assigneeTenantUserId === undefined &&
    dueAt === undefined &&
    priority === null &&
    errors.length === 0
  ) {
    errors.push({
      field: "status",
      message: "Send a status, an assignee, a due date or a priority."
    });
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      status,
      note,
      assigneeTenantUserId,
      dueAt,
      priority
    }
  };
}

// -- Documents -------------------------------------------------------------

export type IssueDocumentInput = {
  idempotencyKey: string;
  orderId: string;
  docType: IssuedDocumentType;
};

export function validateIssueDocumentInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<IssueDocumentInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  if (!isUuid(record.orderId)) {
    errors.push({ field: "orderId", message: "orderId must be a UUID." });
  }
  if (!(ISSUED_DOCUMENT_TYPES as readonly unknown[]).includes(record.docType)) {
    errors.push({
      field: "docType",
      message: `docType must be one of: ${ISSUED_DOCUMENT_TYPES.join(", ")}.`
    });
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      orderId: record.orderId as string,
      docType: record.docType as IssuedDocumentType
    }
  };
}

export type IssueEligibility =
  | { eligible: true }
  | { eligible: false; reason: "ORDER_NOT_FINAL" | "ORDER_NOT_PAID" };

/**
 * Whether a document of `docType` may be issued for an order in this state.
 * An invoice documents an order that took effect (any status but `cancelled` /
 * `expired`); a receipt documents money received, so the order must also be
 * fully paid by the ledger-derived payment status (ADR-0025).
 */
export function checkIssueEligibility(
  docType: IssuedDocumentType,
  order: { status: string; paymentStatus: string }
): IssueEligibility {
  if (order.status === "cancelled" || order.status === "expired") {
    return { eligible: false, reason: "ORDER_NOT_FINAL" };
  }
  if (docType === "receipt" && order.paymentStatus !== "paid") {
    return { eligible: false, reason: "ORDER_NOT_PAID" };
  }
  return { eligible: true };
}

// ---------------------------------------------------------------------------
// Snapshots and the content hash
// ---------------------------------------------------------------------------

/** JSON with every object's keys sorted, so the same content always serialises to the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 hex of the canonical JSON: the tamper-evidence of a snapshot. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export type SnapshotLine = {
  name: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
};

export type DocumentSnapshot = {
  schemaVersion: 1;
  docType: IssuedDocumentType;
  number: string;
  issuedAt: string;
  currency: "IDR";
  seller: {
    name: string;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  customer: { name: string; phone: string; email: string | null };
  order: {
    id: string;
    orderCode: string;
    channel: string;
    status: string;
    paymentStatus: string;
    createdAt: string;
    paidAt: string | null;
    notes: string | null;
  };
  lines: SnapshotLine[];
  totals: {
    subtotal: string;
    discount: string;
    shippingCost: string;
    insuranceFee: string;
    tax: string;
    total: string;
  };
  /** Informational: what the payment ledger said AT ISSUE TIME. The ledger stays the authority. */
  payments: {
    tenderType: string;
    kind: string;
    amount: string;
    at: string;
  }[];
  settlement: { paid: string; reversed: string; outstanding: string };
};

// ---------------------------------------------------------------------------
// Render contract (print / export / digital delivery)
// ---------------------------------------------------------------------------

export const DOCUMENT_RENDER_FORMATS = ["json", "text", "html"] as const;
export type DocumentRenderFormat = (typeof DOCUMENT_RENDER_FORMATS)[number];
export const DOCUMENT_RENDER_LOCALES = ["id", "en"] as const;
export type DocumentRenderLocale = (typeof DOCUMENT_RENDER_LOCALES)[number];

type LabelKey =
  | "receipt"
  | "invoice"
  | "number"
  | "date"
  | "order"
  | "customer"
  | "item"
  | "qty"
  | "price"
  | "amount"
  | "subtotal"
  | "discount"
  | "shipping"
  | "insurance"
  | "tax"
  | "total"
  | "payments"
  | "paid"
  | "reversed"
  | "outstanding"
  | "footer";

const LABELS: Record<DocumentRenderLocale, Record<LabelKey, string>> = {
  id: {
    receipt: "Struk pembayaran",
    invoice: "Faktur penjualan",
    number: "Nomor",
    date: "Tanggal",
    order: "Pesanan",
    customer: "Pelanggan",
    item: "Barang",
    qty: "Jml",
    price: "Harga",
    amount: "Jumlah",
    subtotal: "Subtotal",
    discount: "Diskon",
    shipping: "Ongkos kirim",
    insurance: "Asuransi",
    tax: "Pajak",
    total: "Total",
    payments: "Pembayaran",
    paid: "Dibayar",
    reversed: "Dikembalikan",
    outstanding: "Sisa tagihan",
    footer:
      "Dokumen ini dicetak dari salinan permanen; mencetak ulang tidak mengubahnya."
  },
  en: {
    receipt: "Payment receipt",
    invoice: "Sales invoice",
    number: "Number",
    date: "Date",
    order: "Order",
    customer: "Customer",
    item: "Item",
    qty: "Qty",
    price: "Price",
    amount: "Amount",
    subtotal: "Subtotal",
    discount: "Discount",
    shipping: "Shipping",
    insurance: "Insurance",
    tax: "Tax",
    total: "Total",
    payments: "Payments",
    paid: "Paid",
    reversed: "Reversed",
    outstanding: "Outstanding",
    footer: "Printed from a permanent copy; reprinting never changes it."
  }
};

/** HTML-escapes text for element content AND attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function itemName(line: SnapshotLine): string {
  return line.variantName ? `${line.name} (${line.variantName})` : line.name;
}

/** A fixed-width (42 column) plain-text rendering, for a receipt printer or a message body. */
export function renderDocumentText(
  snapshot: DocumentSnapshot,
  locale: DocumentRenderLocale = "id"
): string {
  const t = LABELS[locale];
  const width = 42;
  const row = (left: string, right: string) =>
    left.length + right.length + 1 > width
      ? `${left}\n${right.padStart(width)}`
      : `${left}${" ".repeat(width - left.length - right.length)}${right}`;
  const out: string[] = [];
  out.push(snapshot.seller.name);
  if (snapshot.seller.address) out.push(snapshot.seller.address);
  if (snapshot.seller.phone) out.push(snapshot.seller.phone);
  out.push("-".repeat(width));
  out.push(t[snapshot.docType].toUpperCase());
  out.push(row(t.number, snapshot.number));
  out.push(row(t.date, snapshot.issuedAt.slice(0, 10)));
  out.push(row(t.order, snapshot.order.orderCode));
  out.push(row(t.customer, snapshot.customer.name));
  out.push("-".repeat(width));
  for (const line of snapshot.lines) {
    out.push(itemName(line));
    out.push(row(`  ${line.quantity} x ${line.unitPrice}`, line.lineTotal));
  }
  out.push("-".repeat(width));
  out.push(row(t.subtotal, snapshot.totals.subtotal));
  if (toCents(snapshot.totals.discount) > 0n) {
    out.push(row(t.discount, `-${snapshot.totals.discount}`));
  }
  if (toCents(snapshot.totals.shippingCost) > 0n) {
    out.push(row(t.shipping, snapshot.totals.shippingCost));
  }
  if (toCents(snapshot.totals.insuranceFee) > 0n) {
    out.push(row(t.insurance, snapshot.totals.insuranceFee));
  }
  if (toCents(snapshot.totals.tax) > 0n) {
    out.push(row(t.tax, snapshot.totals.tax));
  }
  out.push(row(t.total, snapshot.totals.total));
  if (snapshot.payments.length > 0) {
    out.push("-".repeat(width));
    out.push(t.payments);
    for (const payment of snapshot.payments) {
      out.push(
        row(
          `  ${payment.tenderType}${payment.kind === "reversal" ? " (-)" : ""}`,
          payment.amount
        )
      );
    }
    out.push(row(t.paid, snapshot.settlement.paid));
    if (toCents(snapshot.settlement.reversed) > 0n) {
      out.push(row(t.reversed, snapshot.settlement.reversed));
    }
    out.push(row(t.outstanding, snapshot.settlement.outstanding));
  }
  out.push("-".repeat(width));
  out.push(t.footer);
  return `${out.join("\n")}\n`;
}

/**
 * A self-contained, print-ready HTML document (inline CSS, no script, no
 * external resource). Every dynamic value is escaped; the page is a real
 * document (`lang`, `<title>`, a captioned table with column headers) so a
 * screen reader and a PDF printer both get the structure. Served with a
 * restrictive CSP by the route.
 */
export function renderDocumentHtml(
  snapshot: DocumentSnapshot,
  locale: DocumentRenderLocale = "id"
): string {
  const t = LABELS[locale];
  const e = escapeHtml;
  const money = (value: string) => e(value);
  const lines = snapshot.lines
    .map(
      (line) =>
        `<tr><th scope="row">${e(itemName(line))}</th><td class="n">${line.quantity}</td><td class="n">${money(line.unitPrice)}</td><td class="n">${money(line.lineTotal)}</td></tr>`
    )
    .join("");
  const totalsRow = (label: string, value: string) =>
    `<tr><th scope="row" colspan="3">${e(label)}</th><td class="n">${money(value)}</td></tr>`;
  const totals = [
    totalsRow(t.subtotal, snapshot.totals.subtotal),
    toCents(snapshot.totals.discount) > 0n
      ? totalsRow(t.discount, `-${snapshot.totals.discount}`)
      : "",
    toCents(snapshot.totals.shippingCost) > 0n
      ? totalsRow(t.shipping, snapshot.totals.shippingCost)
      : "",
    toCents(snapshot.totals.insuranceFee) > 0n
      ? totalsRow(t.insurance, snapshot.totals.insuranceFee)
      : "",
    toCents(snapshot.totals.tax) > 0n
      ? totalsRow(t.tax, snapshot.totals.tax)
      : "",
    totalsRow(t.total, snapshot.totals.total)
  ].join("");
  const payments =
    snapshot.payments.length > 0
      ? `<h2>${e(t.payments)}</h2><table><tbody>${snapshot.payments
          .map(
            (payment) =>
              `<tr><th scope="row">${e(payment.tenderType)}${payment.kind === "reversal" ? " (-)" : ""}</th><td class="n">${money(payment.amount)}</td></tr>`
          )
          .join(
            ""
          )}${`<tr><th scope="row">${e(t.paid)}</th><td class="n">${money(snapshot.settlement.paid)}</td></tr>`}${`<tr><th scope="row">${e(t.outstanding)}</th><td class="n">${money(snapshot.settlement.outstanding)}</td></tr>`}</tbody></table>`
      : "";
  const title = `${t[snapshot.docType]} ${snapshot.number}`;
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:1.5rem auto;max-width:42rem;padding:0 1rem;color:#111;background:#fff}h1{font-size:1.25rem;margin:.2rem 0}h2{font-size:1rem;margin:1.2rem 0 .3rem}table{width:100%;border-collapse:collapse}th,td{padding:.3rem .4rem;border-bottom:1px solid #ccc;text-align:left;font-weight:400}thead th{font-weight:600}.n{text-align:right;font-variant-numeric:tabular-nums}dl{display:grid;grid-template-columns:max-content 1fr;gap:.15rem 1rem;margin:.6rem 0}dt{font-weight:600}dd{margin:0}footer{margin-top:1.2rem;color:#555;font-size:.85rem}@media print{body{margin:0}}</style></head>
<body><header><strong>${e(snapshot.seller.name)}</strong>${snapshot.seller.address ? `<div>${e(snapshot.seller.address)}</div>` : ""}${snapshot.seller.phone ? `<div>${e(snapshot.seller.phone)}</div>` : ""}</header>
<main><h1>${e(t[snapshot.docType])}</h1>
<dl><dt>${e(t.number)}</dt><dd>${e(snapshot.number)}</dd><dt>${e(t.date)}</dt><dd>${e(snapshot.issuedAt.slice(0, 10))}</dd><dt>${e(t.order)}</dt><dd>${e(snapshot.order.orderCode)}</dd><dt>${e(t.customer)}</dt><dd>${e(snapshot.customer.name)}</dd></dl>
<table><caption class="sr-only" style="position:absolute;left:-9999px">${e(title)}</caption><thead><tr><th scope="col">${e(t.item)}</th><th scope="col" class="n">${e(t.qty)}</th><th scope="col" class="n">${e(t.price)}</th><th scope="col" class="n">${e(t.amount)}</th></tr></thead><tbody>${lines}${totals}</tbody></table>
${payments}</main><footer>${e(t.footer)}</footer></body></html>
`;
}

export function renderDocument(
  snapshot: DocumentSnapshot,
  format: Exclude<DocumentRenderFormat, "json">,
  locale: DocumentRenderLocale = "id"
): string {
  return format === "html"
    ? renderDocumentHtml(snapshot, locale)
    : renderDocumentText(snapshot, locale);
}
