/**
 * Commerce-local petty cash and operational expenses (Issue #294, epic #281,
 * ADR-0031) — the PURE half: vocabulary, request validation, the approval
 * decision and the segregation-of-duties rules. No database, no I/O (the
 * application layer, `application/expense-*.ts`, reads and writes and hands the
 * facts in), so every rule below is unit-testable.
 *
 * This is NOT a general ledger or accounts-payable model (ADR-0031 D1): an
 * expense is a category, an amount, a tender, a date, a reason, an optional
 * payee and receipt, and — when it was paid out of an open POS drawer — a link
 * to the register session whose cash-up it affects, through a register
 * MOVEMENT (never a direct edit of a cash-up total).
 *
 * ## Money
 *
 * Every amount is a `numeric(14,2)` STRING on the wire (ADR-0003) and every sum
 * is integer cents (`bigint`) — never `Number`, never floating point.
 *
 * ## The approval rule
 *
 * An expense whose amount is STRICTLY GREATER than the tenant's
 * `expenses.approvalThreshold` (default `0.00`: every expense needs a second
 * person, safe by default and relaxed deliberately) needs an approver:
 *
 *   - within the threshold                                   -> `auto`, posted;
 *   - above it, the poster holds the approve permission AND
 *     is not the expense's creator                           -> `approved` by
 *     the poster, posted in one step;
 *   - above it otherwise                                     -> `pending`,
 *     waiting for someone who holds the approve permission and is neither the
 *     creator nor the submitter.
 *
 * "Creator cannot approve own expense above the threshold" is therefore a
 * mechanical consequence of this function and of a schema CHECK
 * (`sql/990`'s `approver_check`), not a convention.
 */
import {
  isRecord,
  OWNER_RECORDABLE_TENDER_TYPES,
  optionalText,
  positiveMoney,
  validateIdempotencyKey,
  type PaymentTenderType,
  type ValidationError
} from "./payment-allocation";
import { fromCents, toCents } from "./price-calculation";
import { isUuid } from "./register";

export type { ValidationError };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const EXPENSE_STATUSES = [
  "draft",
  "pending_approval",
  "posted",
  "reversed",
  "cancelled"
] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/** The tenders an expense may be paid with: what staff can record by hand (never `gateway`). */
export const EXPENSE_TENDER_TYPES = OWNER_RECORDABLE_TENDER_TYPES;
export type ExpenseTenderType = (typeof EXPENSE_TENDER_TYPES)[number];

export const EXPENSE_DECISIONS = ["auto", "approved", "rejected"] as const;
export type ExpenseDecision = (typeof EXPENSE_DECISIONS)[number];

export const DEFAULT_EXPENSE_APPROVAL_THRESHOLD = "0.00";

/** A report/export range may span at most this many days (the CSV is bounded by construction). */
export const MAX_EXPENSE_REPORT_DAYS = 366;
/** The CSV carries at most this many rows; a longer range is flagged truncated, never silently cut. */
export const MAX_EXPENSE_EXPORT_ROWS = 10_000;

const MAX_CATEGORY_CODE = 40;
const MAX_CATEGORY_NAME = 120;
const MAX_DESCRIPTION = 500;
const MAX_PAYEE = 120;
const MAX_NOTE = 500;

const CATEGORY_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NON_NEGATIVE_MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` that is a real calendar date, as UTC milliseconds; `null` otherwise. */
export function parseCalendarDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3])
  ] as [number, number, number];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  return back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day
    ? ms
    : null;
}

function todayUtcMs(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function requiredText(
  value: unknown,
  field: string,
  max: number,
  errors: ValidationError[]
): string {
  const text = optionalText(value, field, max, errors);
  if (text === null && !errors.some((error) => error.field === field)) {
    errors.push({ field, message: `${field} is required.` });
  }
  return text ?? "";
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type CreateExpenseCategoryInput = { code: string; name: string };

export function validateCreateExpenseCategoryInput(
  body: unknown
): ValidationResult<CreateExpenseCategoryInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const code = requiredText(record.code, "code", MAX_CATEGORY_CODE, errors);
  if (code.length > 0 && !CATEGORY_CODE_PATTERN.test(code)) {
    errors.push({
      field: "code",
      message:
        "code may contain only letters, digits, '.', '_' and '-', and must start with a letter or digit."
    });
  }
  const name = requiredText(record.name, "name", MAX_CATEGORY_NAME, errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { code, name } };
}

export type UpdateExpenseCategoryInput = { name?: string; active?: boolean };

export function validateUpdateExpenseCategoryInput(
  body: unknown
): ValidationResult<UpdateExpenseCategoryInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const value: UpdateExpenseCategoryInput = {};
  if (record.name !== undefined) {
    value.name = requiredText(record.name, "name", MAX_CATEGORY_NAME, errors);
  }
  if (record.active !== undefined) {
    if (typeof record.active === "boolean") {
      value.active = record.active;
    } else {
      errors.push({ field: "active", message: "active must be a boolean." });
    }
  }
  if (record.code !== undefined) {
    errors.push({
      field: "code",
      message: "A category's code never changes."
    });
  }
  if (Object.keys(value).length === 0 && errors.length === 0) {
    errors.push({
      field: "body",
      message: "Provide at least one of name, active."
    });
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value };
}

// ---------------------------------------------------------------------------
// Expense drafts
// ---------------------------------------------------------------------------

export type ExpenseDraftFields = {
  categoryId: string;
  /** Positive `numeric(14,2)` string. */
  amount: string;
  tenderType: ExpenseTenderType;
  /** `YYYY-MM-DD`. */
  occurredOn: string;
  description: string;
  payeeName: string | null;
  /** The OPEN drawer session the cash comes from; `null` = not paid from a drawer. */
  registerSessionId: string | null;
};

export type CreateExpenseInput = ExpenseDraftFields & {
  idempotencyKey: string;
};

function validateOccurredOn(
  value: unknown,
  now: Date,
  errors: ValidationError[]
): string {
  const ms = parseCalendarDate(value);
  if (ms === null) {
    errors.push({
      field: "occurredOn",
      message: "occurredOn must be a calendar date like 2026-10-03."
    });
    return "";
  }
  // One day of slack so a client in a timezone ahead of UTC can record "today".
  if (ms > todayUtcMs(now) + MS_PER_DAY) {
    errors.push({
      field: "occurredOn",
      message: "occurredOn cannot be in the future."
    });
  }
  return value as string;
}

function validateTender(
  value: unknown,
  errors: ValidationError[]
): ExpenseTenderType {
  if (
    typeof value === "string" &&
    (EXPENSE_TENDER_TYPES as readonly string[]).includes(value)
  ) {
    return value as ExpenseTenderType;
  }
  errors.push({
    field: "tenderType",
    message: `tenderType must be one of: ${EXPENSE_TENDER_TYPES.join(", ")}.`
  });
  return "cash";
}

function validateDraftFields(
  record: Record<string, unknown>,
  now: Date,
  errors: ValidationError[]
): ExpenseDraftFields {
  const categoryId = isUuid(record.categoryId) ? record.categoryId : "";
  if (!categoryId) {
    errors.push({ field: "categoryId", message: "categoryId must be a UUID." });
  }
  const amount = positiveMoney(record.amount, "amount", errors);
  const tenderType = validateTender(record.tenderType, errors);
  const occurredOn = validateOccurredOn(record.occurredOn, now, errors);
  const description = requiredText(
    record.description,
    "description",
    MAX_DESCRIPTION,
    errors
  );
  const payeeName = optionalText(
    record.payeeName,
    "payeeName",
    MAX_PAYEE,
    errors
  );

  let registerSessionId: string | null = null;
  if (
    record.registerSessionId !== undefined &&
    record.registerSessionId !== null
  ) {
    if (isUuid(record.registerSessionId)) {
      registerSessionId = record.registerSessionId;
    } else {
      errors.push({
        field: "registerSessionId",
        message: "registerSessionId must be a UUID, or null."
      });
    }
  }
  if (registerSessionId !== null && tenderType !== "cash") {
    errors.push({
      field: "tenderType",
      message: "An expense paid from the drawer must be paid in cash."
    });
  }
  return {
    categoryId,
    amount,
    tenderType,
    occurredOn,
    description,
    payeeName,
    registerSessionId
  };
}

export function validateCreateExpenseInput(
  body: unknown,
  idempotencyKey: string,
  now: Date = new Date()
): ValidationResult<CreateExpenseInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  const fields = validateDraftFields(record, now, errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { idempotencyKey: key, ...fields } };
}

/** A PATCH of a draft: any subset of the draft fields (`registerSessionId: null` detaches the drawer). */
export type UpdateExpenseInput = Partial<ExpenseDraftFields>;

export function validateUpdateExpenseInput(
  body: unknown,
  now: Date = new Date()
): ValidationResult<UpdateExpenseInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const value: UpdateExpenseInput = {};

  if (record.categoryId !== undefined) {
    if (isUuid(record.categoryId)) value.categoryId = record.categoryId;
    else
      errors.push({
        field: "categoryId",
        message: "categoryId must be a UUID."
      });
  }
  if (record.amount !== undefined) {
    value.amount = positiveMoney(record.amount, "amount", errors);
  }
  if (record.tenderType !== undefined) {
    value.tenderType = validateTender(record.tenderType, errors);
  }
  if (record.occurredOn !== undefined) {
    value.occurredOn = validateOccurredOn(record.occurredOn, now, errors);
  }
  if (record.description !== undefined) {
    value.description = requiredText(
      record.description,
      "description",
      MAX_DESCRIPTION,
      errors
    );
  }
  if (record.payeeName !== undefined) {
    value.payeeName = optionalText(
      record.payeeName,
      "payeeName",
      MAX_PAYEE,
      errors
    );
  }
  if (record.registerSessionId !== undefined) {
    if (record.registerSessionId === null) {
      value.registerSessionId = null;
    } else if (isUuid(record.registerSessionId)) {
      value.registerSessionId = record.registerSessionId;
    } else {
      errors.push({
        field: "registerSessionId",
        message: "registerSessionId must be a UUID, or null."
      });
    }
  }
  if (Object.keys(value).length === 0 && errors.length === 0) {
    errors.push({
      field: "body",
      message:
        "Provide at least one of categoryId, amount, tenderType, occurredOn, description, payeeName, registerSessionId."
    });
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value };
}

// ---------------------------------------------------------------------------
// Posting, decision, reversal, cancel, receipt
// ---------------------------------------------------------------------------

export type KeyedInput = { idempotencyKey: string };

/** Post / cancel carry no body: only the `Idempotency-Key`. */
export function validateKeyedInput(
  idempotencyKey: string
): ValidationResult<KeyedInput> {
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { idempotencyKey: key } };
}

export type ExpenseDecisionInput = {
  idempotencyKey: string;
  decision: "approve" | "reject";
  note: string | null;
};

export function validateExpenseDecisionInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<ExpenseDecisionInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  const decision =
    record.decision === "approve" || record.decision === "reject"
      ? record.decision
      : null;
  if (decision === null) {
    errors.push({
      field: "decision",
      message: 'decision must be "approve" or "reject".'
    });
  }
  const note = optionalText(record.note, "note", MAX_NOTE, errors);
  if (decision === "reject" && note === null) {
    errors.push({
      field: "note",
      message: "note (why it is rejected) is required when rejecting."
    });
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { idempotencyKey: key, decision: decision!, note }
  };
}

export type ReverseExpenseInput = { idempotencyKey: string; reason: string };

export function validateReverseExpenseInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<ReverseExpenseInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);
  const reason = requiredText(record.reason, "reason", MAX_NOTE, errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { idempotencyKey: key, reason } };
}

export type AttachReceiptInput = { mediaObjectId: string };

export function validateAttachReceiptInput(
  body: unknown
): ValidationResult<AttachReceiptInput> {
  const record = isRecord(body) ? body : {};
  if (!isUuid(record.mediaObjectId)) {
    return {
      valid: false,
      errors: [
        { field: "mediaObjectId", message: "mediaObjectId must be a UUID." }
      ]
    };
  }
  return { valid: true, value: { mediaObjectId: record.mediaObjectId } };
}

// ---------------------------------------------------------------------------
// The approval decision and SoD
// ---------------------------------------------------------------------------

export type PostingOutcome = "auto" | "approved" | "pending";

/** Whether an amount is STRICTLY above the tenant threshold (both `numeric(14,2)` strings, compared in cents). */
export function exceedsApprovalThreshold(
  amount: string,
  threshold: string
): boolean {
  return toCents(amount) > toCents(threshold);
}

/**
 * What posting an expense does, given the tenant threshold: `auto` (within it),
 * `approved` (above it, and the poster is an approver who did not create the
 * expense), or `pending` (above it and nobody here may approve it). Amounts are
 * `numeric(14,2)` strings, compared in integer cents.
 */
export function decidePosting(input: {
  amount: string;
  threshold: string;
  creatorTenantUserId: string;
  actorTenantUserId: string;
  actorCanApprove: boolean;
}): PostingOutcome {
  if (toCents(input.amount) <= toCents(input.threshold)) return "auto";
  if (
    input.actorCanApprove &&
    input.actorTenantUserId !== input.creatorTenantUserId
  ) {
    return "approved";
  }
  return "pending";
}

/** Why an approver may not approve a pending expense, or `null` when they may. */
export function approvalSegregationViolation(input: {
  creatorTenantUserId: string;
  submitterTenantUserId: string | null;
  approverTenantUserId: string;
}): "creator" | "submitter" | null {
  if (input.approverTenantUserId === input.creatorTenantUserId)
    return "creator";
  if (input.approverTenantUserId === input.submitterTenantUserId)
    return "submitter";
  return null;
}

// ---------------------------------------------------------------------------
// Tenant setting: the approval threshold
// ---------------------------------------------------------------------------

export type ExpenseSettings = { approvalThreshold: string };

/**
 * Reads `expenses.approvalThreshold` from a `commerce` module settings view's
 * `effective` object. The generic module-settings route validates only for
 * secrets, not for shape, so this is defensive: anything that is not a
 * non-negative `numeric(14,2)` string falls back to the strict default
 * (`0.00`) — a corrupt value can only make posting STRICTER, never looser.
 */
export function resolveExpenseSettings(
  effectiveSettings: Record<string, unknown> | null | undefined
): ExpenseSettings {
  const raw = effectiveSettings?.expenses;
  const threshold =
    isRecord(raw) &&
    typeof raw.approvalThreshold === "string" &&
    NON_NEGATIVE_MONEY_PATTERN.test(raw.approvalThreshold)
      ? fromCents(toCents(raw.approvalThreshold))
      : DEFAULT_EXPENSE_APPROVAL_THRESHOLD;
  return { approvalThreshold: threshold };
}

/** Validates the value the admin form sends before it is PATCHed into module settings. */
export function validateExpenseApprovalThreshold(
  value: unknown
): string | null {
  return typeof value === "string" && NON_NEGATIVE_MONEY_PATTERN.test(value)
    ? fromCents(toCents(value))
    : null;
}

// ---------------------------------------------------------------------------
// List / report filters
// ---------------------------------------------------------------------------

export type ExpenseListFilters = {
  status?: ExpenseStatus;
  categoryId?: string;
  registerSessionId?: string;
  /** Inclusive `YYYY-MM-DD` bounds on `occurredOn`. */
  from?: string;
  to?: string;
};

export function parseExpenseListFilters(
  params: URLSearchParams
):
  | { valid: true; value: ExpenseListFilters }
  | { valid: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const filters: ExpenseListFilters = {};
  const status = params.get("status");
  if (status) {
    if ((EXPENSE_STATUSES as readonly string[]).includes(status)) {
      filters.status = status as ExpenseStatus;
    } else {
      errors.push({
        field: "status",
        message: `status must be one of: ${EXPENSE_STATUSES.join(", ")}.`
      });
    }
  }
  for (const field of ["categoryId", "registerSessionId"] as const) {
    const value = params.get(field);
    if (value) {
      if (isUuid(value)) filters[field] = value;
      else errors.push({ field, message: `${field} must be a UUID.` });
    }
  }
  for (const field of ["from", "to"] as const) {
    const value = params.get(field);
    if (value) {
      if (parseCalendarDate(value) !== null) filters[field] = value;
      else
        errors.push({
          field,
          message: `${field} must be a calendar date like 2026-10-03.`
        });
    }
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    errors.push({ field: "from", message: "from cannot be after to." });
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: filters };
}

/** A report/export range: both bounds are required and span at most {@link MAX_EXPENSE_REPORT_DAYS}. */
export function parseExpenseReportRange(
  params: URLSearchParams
):
  | { valid: true; value: { from: string; to: string } }
  | { valid: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const from = params.get("from");
  const to = params.get("to");
  const fromMs = parseCalendarDate(from);
  const toMs = parseCalendarDate(to);
  if (fromMs === null) {
    errors.push({
      field: "from",
      message: "from must be a calendar date like 2026-10-03."
    });
  }
  if (toMs === null) {
    errors.push({
      field: "to",
      message: "to must be a calendar date like 2026-10-03."
    });
  }
  if (fromMs !== null && toMs !== null) {
    if (fromMs > toMs) {
      errors.push({ field: "from", message: "from cannot be after to." });
    } else if ((toMs - fromMs) / MS_PER_DAY + 1 > MAX_EXPENSE_REPORT_DAYS) {
      errors.push({
        field: "to",
        message: `The range may span at most ${MAX_EXPENSE_REPORT_DAYS} days.`
      });
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { from: from!, to: to! } };
}

// ---------------------------------------------------------------------------
// Report arithmetic
// ---------------------------------------------------------------------------

export type ExpenseTotalsRow = {
  categoryId: string;
  tenderType: PaymentTenderType;
  status: "posted" | "reversed";
  amount: string;
  count: number;
};

export type ExpenseCategoryTotal = {
  categoryId: string;
  /** Σ posted (still in effect) - exact `numeric(14,2)`. */
  postedTotal: string;
  postedCount: number;
  reversedTotal: string;
  reversedCount: number;
};

/** Folds per-(category, tender, status) rows into per-category totals in exact cents. */
export function foldExpenseTotals(rows: readonly ExpenseTotalsRow[]): {
  byCategory: ExpenseCategoryTotal[];
  postedTotal: string;
  reversedTotal: string;
} {
  const byCategory = new Map<
    string,
    {
      posted: bigint;
      postedCount: number;
      reversed: bigint;
      reversedCount: number;
    }
  >();
  let posted = 0n;
  let reversed = 0n;
  for (const row of rows) {
    const entry = byCategory.get(row.categoryId) ?? {
      posted: 0n,
      postedCount: 0,
      reversed: 0n,
      reversedCount: 0
    };
    const cents = toCents(row.amount);
    if (row.status === "posted") {
      entry.posted += cents;
      entry.postedCount += row.count;
      posted += cents;
    } else {
      entry.reversed += cents;
      entry.reversedCount += row.count;
      reversed += cents;
    }
    byCategory.set(row.categoryId, entry);
  }
  return {
    byCategory: [...byCategory.entries()]
      .map(([categoryId, entry]) => ({
        categoryId,
        postedTotal: fromCents(entry.posted),
        postedCount: entry.postedCount,
        reversedTotal: fromCents(entry.reversed),
        reversedCount: entry.reversedCount
      }))
      .sort((a, b) => a.categoryId.localeCompare(b.categoryId)),
    postedTotal: fromCents(posted),
    reversedTotal: fromCents(reversed)
  };
}

/** The reference text stamped on the register movements an expense produces. */
export function expenseMovementReference(expenseId: string): string {
  return `EXP-${expenseId.slice(0, 8).toUpperCase()}`;
}
