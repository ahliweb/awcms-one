/**
 * Closed-loop stored value — gift cards and store credit (Issue #288, epic
 * #281, ADR-0029). Pure: no database, no I/O beyond the platform CSPRNG.
 *
 * ## What is here
 *
 *   - the vocabulary (kinds, account statuses, ledger-entry kinds, sources);
 *   - the redeemable CODE: generation (CSPRNG, 100 bits + a check character),
 *     normalisation, shape check, the tenant-scoped hash that is the ONLY form
 *     stored, and masking;
 *   - signed-money arithmetic in integer cents (the shared `toCents` cannot
 *     carry a sign: `toCents("-0.50")` is `+50`);
 *   - the ledger's rules as pure functions ({@link evaluateEntry}, mirrored by
 *     the database trigger in `sql/980`, which is the actual enforcement), and
 *     {@link replayLedger} — the model reconcile and the tests compare the
 *     stored projection against;
 *   - request validation for the owner routes.
 *
 * ## The code
 *
 * 20 characters drawn uniformly from a 32-symbol alphabet with no `I`, `O`,
 * `0`, `1` (so it can be read off a receipt or spoken aloud) is exactly 100
 * bits of entropy; one Luhn-mod-32 check character is appended so a typo is
 * caught before it reaches the database (and before it counts as a failed
 * lookup). 21 characters, shown as three groups of seven. `32 = 2^5`, so
 * `byte & 31` is uniform with no modulo bias (the shape `affiliate-code.ts`
 * uses for its 8-character code). Even with the last four characters public
 * (the display form) 17 random characters = 85 bits remain.
 *
 * The hash is `sha256` over `awcms.stored_value.v1|<tenant id>|<normalised
 * code>`. Why sha256 and not an HMAC with a server secret: the input is a
 * 100-bit CSPRNG value, so an offline guess against a leaked hash is
 * computationally infeasible whatever the hash function (a keyed hash defends
 * LOW-entropy inputs such as passwords or short PINs, which this never is); a
 * secret would add a key to provision, rotate and keep available for the
 * lifetime of every outstanding card for no gain, and would make "restore the
 * database to another host" a key-recovery exercise. The tenant id in the
 * input domain-separates tenants (the same code in two tenants hashes
 * differently) and the version prefix leaves room to migrate. Same `sha256:`
 * at-rest shape as a customer session token (ADR-0016 D3).
 */
import { createHash, randomBytes } from "node:crypto";
import { fromCents, toCents } from "./price-calculation";

export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const STORED_VALUE_KINDS = ["gift_card", "store_credit"] as const;
export type StoredValueKind = (typeof STORED_VALUE_KINDS)[number];

export const STORED_VALUE_ACCOUNT_STATUSES = [
  "active",
  "disabled",
  "expired"
] as const;
export type StoredValueAccountStatus =
  (typeof STORED_VALUE_ACCOUNT_STATUSES)[number];

export const STORED_VALUE_ENTRY_KINDS = [
  "issue",
  "load",
  "redeem",
  "refund",
  "adjust",
  "expire",
  "disable",
  "enable"
] as const;
export type StoredValueEntryKind = (typeof STORED_VALUE_ENTRY_KINDS)[number];

export function isStoredValueKind(value: unknown): value is StoredValueKind {
  return (
    typeof value === "string" &&
    (STORED_VALUE_KINDS as readonly string[]).includes(value)
  );
}

/** `true` for the two payment-allocation tenders that draw on this ledger. */
export function isStoredValueTender(value: string): value is StoredValueKind {
  return value === "gift_card" || value === "store_credit";
}

export const STORED_VALUE_ENTRY_MAX_REASON = 500;
export const STORED_VALUE_MAX_EXPIRY_DAYS = 3650;
/** The `numeric(14,2)` shape: at most 12 whole digits, at most two decimals. */
export const STORED_VALUE_MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const SIGNED_MONEY_PATTERN = /^-?\d{1,12}(\.\d{1,2})?$/;

// ---------------------------------------------------------------------------
// Signed money (integer cents)
// ---------------------------------------------------------------------------

/** Parses a (possibly negative) `numeric(14,2)` string into signed integer cents. */
export function signedToCents(value: string): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new RangeError(`not a numeric(14,2) string: ${value}`);
  }
  const negative = value.startsWith("-");
  const cents = toCents(negative ? value.slice(1) : value);
  return negative ? -cents : cents;
}

/** Formats signed integer cents as a canonical two-decimal string (`"-0.50"`, `"0.00"`). */
export function signedFromCents(cents: bigint): string {
  return cents < 0n ? `-${fromCents(-cents)}` : fromCents(cents);
}

/** Canonical two-decimal rendering of a signed `numeric(14,2)` read from the database. */
export function normalizeSignedMoney(value: string): string {
  return signedFromCents(signedToCents(value));
}

// ---------------------------------------------------------------------------
// The redeemable code
// ---------------------------------------------------------------------------

/** 32 symbols: no `I`, `O`, `0`, `1` (unambiguous on a receipt). */
export const STORED_VALUE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Random characters: 20 x 5 bits = 100 bits. */
export const STORED_VALUE_CODE_RANDOM_LENGTH = 20;
/** Random characters plus the check character. */
export const STORED_VALUE_CODE_LENGTH = STORED_VALUE_CODE_RANDOM_LENGTH + 1;
/** Entropy of the random part, in bits (a statement the unit test pins). */
export const STORED_VALUE_CODE_ENTROPY_BITS =
  STORED_VALUE_CODE_RANDOM_LENGTH * 5;
const GROUP_SIZE = 7;
const BASE = STORED_VALUE_CODE_ALPHABET.length;

function alphabetIndex(char: string): number {
  return STORED_VALUE_CODE_ALPHABET.indexOf(char);
}

/** Luhn-mod-N check character over a payload of alphabet characters. */
export function storedValueCheckChar(payload: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = payload.length - 1; i >= 0; i -= 1) {
    const codePoint = alphabetIndex(payload[i]!);
    let addend = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / BASE) + (addend % BASE);
    sum += addend;
  }
  const remainder = sum % BASE;
  return STORED_VALUE_CODE_ALPHABET[(BASE - remainder) % BASE]!;
}

/** A fresh, random, normalised (separator-free) code — 21 characters. */
export function generateStoredValueCode(
  random: (size: number) => Uint8Array = randomBytes
): string {
  const bytes = random(STORED_VALUE_CODE_RANDOM_LENGTH);
  let payload = "";
  for (let i = 0; i < STORED_VALUE_CODE_RANDOM_LENGTH; i += 1) {
    payload += STORED_VALUE_CODE_ALPHABET[bytes[i]! & 31];
  }
  return payload + storedValueCheckChar(payload);
}

/**
 * Normal form: upper-case, with spaces and hyphens removed. Anything else is
 * left alone (and will fail {@link isStoredValueCodeWellFormed}) — there is no
 * lenient aliasing of `O`/`0`: the alphabet has neither, so a code containing
 * one is simply not one of ours.
 */
export function normalizeStoredValueCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

/** Shape + check-character verification of an ALREADY normalised code. */
export function isStoredValueCodeWellFormed(normalized: string): boolean {
  if (normalized.length !== STORED_VALUE_CODE_LENGTH) return false;
  for (const char of normalized) {
    if (alphabetIndex(char) < 0) return false;
  }
  return storedValueCheckChar(normalized.slice(0, -1)) === normalized.slice(-1);
}

/** The display form of a normalised code: `XXXXXXX-XXXXXXX-XXXXXXX`. */
export function formatStoredValueCode(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += GROUP_SIZE) {
    groups.push(normalized.slice(i, i + GROUP_SIZE));
  }
  return groups.join("-");
}

/** The only form of the code ever stored. */
export function hashStoredValueCode(
  tenantId: string,
  normalized: string
): string {
  return `sha256:${createHash("sha256")
    .update(`awcms.stored_value.v1|${tenantId}|${normalized}`, "utf8")
    .digest("hex")}`;
}

export function storedValueCodeLast4(normalized: string): string {
  return normalized.slice(-4);
}

/** `•••••••-•••••••-•••ABCD` — what every list, receipt line and response shows. */
export function maskStoredValueCode(last4: string): string {
  return `${"•".repeat(GROUP_SIZE)}-${"•".repeat(GROUP_SIZE)}-${"•".repeat(
    GROUP_SIZE - last4.length
  )}${last4}`;
}

// ---------------------------------------------------------------------------
// Ledger rules (pure mirror of `sql/980`'s trigger)
// ---------------------------------------------------------------------------

export type AccountState = {
  status: StoredValueAccountStatus;
  /** Signed cents. */
  balanceCents: bigint;
  version: number;
  /** `null` = never expires. */
  expiresAt: Date | null;
};

export type EntryRefusal =
  | "ACCOUNT_EXPIRED"
  | "ACCOUNT_UNAVAILABLE"
  | "ACCOUNT_LAPSED"
  | "NOT_LAPSED"
  | "NOT_ACTIVE"
  | "NOT_DISABLED"
  | "INSUFFICIENT";

export function isLapsed(state: AccountState, now: Date): boolean {
  return state.expiresAt !== null && state.expiresAt.getTime() <= now.getTime();
}

/**
 * Whether an entry of `kind` for `amountCents` may be appended to an account
 * in `state` at `now`, and the account's state afterwards. The database
 * trigger is the enforcement; this is the same rule set, evaluated in the
 * application BEFORE a write so a refusal is a clean outcome, not a
 * constraint violation — and so the unit tests pin the rules without a
 * database.
 */
export function evaluateEntry(
  state: AccountState,
  kind: StoredValueEntryKind,
  amountCents: bigint,
  now: Date
):
  | { ok: true; next: AccountState }
  | { ok: false; refusal: EntryRefusal; available: bigint } {
  const refuse = (refusal: EntryRefusal) => ({
    ok: false as const,
    refusal,
    available: state.balanceCents
  });
  if (state.status === "expired") return refuse("ACCOUNT_EXPIRED");

  const lapsed = isLapsed(state, now);
  const usable = state.status === "active" && !lapsed;
  let nextStatus: StoredValueAccountStatus = state.status;

  switch (kind) {
    case "issue":
      if (state.version !== 0) return refuse("ACCOUNT_UNAVAILABLE");
      break;
    case "load":
    case "redeem":
    case "refund":
      if (!usable)
        return refuse(lapsed ? "ACCOUNT_LAPSED" : "ACCOUNT_UNAVAILABLE");
      break;
    case "adjust":
      if (!(state.status === "disabled" || usable)) {
        return refuse(lapsed ? "ACCOUNT_LAPSED" : "ACCOUNT_UNAVAILABLE");
      }
      break;
    case "expire":
      if (!lapsed) return refuse("NOT_LAPSED");
      nextStatus = "expired";
      break;
    case "disable":
      if (state.status !== "active") return refuse("NOT_ACTIVE");
      nextStatus = "disabled";
      break;
    case "enable":
      if (state.status !== "disabled") return refuse("NOT_DISABLED");
      nextStatus = "active";
      break;
  }

  const nextBalance = state.balanceCents + amountCents;
  if (nextBalance < 0n) return refuse("INSUFFICIENT");
  return {
    ok: true,
    next: {
      status: nextStatus,
      balanceCents: nextBalance,
      version: state.version + 1,
      expiresAt: state.expiresAt
    }
  };
}

export type ReplayEntry = {
  accountSeq: number;
  /** Signed `numeric(14,2)` string. */
  amount: string;
  /** Signed `numeric(14,2)` string, as stored. */
  balanceAfter: string;
  kind: StoredValueEntryKind;
};

export type ReplayResult = {
  balance: string;
  version: number;
  status: StoredValueAccountStatus;
  /** Human-readable findings; empty for a consistent ledger. */
  breaks: string[];
};

/**
 * Rebuilds an account's projection from its ledger entries alone, and reports
 * every way the stored entries disagree with themselves: a gap or repeat in
 * the per-account sequence, a running balance that does not add up, a sign that
 * the kind forbids, a balance that dipped below zero, an entry after an
 * expiry. The status follows the entries (`disable`/`enable`/`expire`).
 */
export function replayLedger(entries: readonly ReplayEntry[]): ReplayResult {
  const ordered = [...entries].sort((a, b) => a.accountSeq - b.accountSeq);
  const breaks: string[] = [];
  let running = 0n;
  let status: StoredValueAccountStatus = "active";
  let expected = 1;
  for (const entry of ordered) {
    if (entry.accountSeq !== expected) {
      breaks.push(`sequence: expected ${expected}, found ${entry.accountSeq}`);
      expected = entry.accountSeq;
    }
    expected += 1;
    const amount = signedToCents(entry.amount);
    if (status === "expired") {
      breaks.push(`entry ${entry.accountSeq} follows an expiry`);
    }
    if (!signAllowed(entry.kind, amount)) {
      breaks.push(
        `entry ${entry.accountSeq}: a ${entry.kind} of ${entry.amount} is not allowed`
      );
    }
    running += amount;
    if (running < 0n) {
      breaks.push(`entry ${entry.accountSeq}: balance below zero`);
    }
    if (signedToCents(entry.balanceAfter) !== running) {
      breaks.push(
        `entry ${entry.accountSeq}: balance_after ${entry.balanceAfter} but the running sum is ${signedFromCents(running)}`
      );
    }
    if (entry.kind === "disable") status = "disabled";
    else if (entry.kind === "enable") status = "active";
    else if (entry.kind === "expire") status = "expired";
  }
  return {
    balance: signedFromCents(running),
    version: ordered.length,
    status,
    breaks
  };
}

function signAllowed(kind: StoredValueEntryKind, cents: bigint): boolean {
  switch (kind) {
    case "issue":
    case "load":
    case "refund":
      return cents > 0n;
    case "redeem":
      return cents < 0n;
    case "adjust":
      return cents !== 0n;
    case "expire":
      return cents <= 0n;
    case "disable":
    case "enable":
      return cents === 0n;
  }
}

/** The instant an account issued at `issuedAt` under a program with `expiryDays` lapses; `null` = never. */
export function computeExpiresAt(
  issuedAt: Date,
  expiryDays: number | null
): Date | null {
  if (expiryDays === null) return null;
  return new Date(issuedAt.getTime() + expiryDays * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Source keys (row-level idempotency, `sql/980`'s unique index)
// ---------------------------------------------------------------------------

export const storedValueSourceKeys = {
  issue: (key: string) => `issue:${key}`,
  load: (accountId: string, key: string) => `load:${accountId}:${key}`,
  adjust: (accountId: string, key: string) => `adjust:${accountId}:${key}`,
  status: (accountId: string, key: string) => `status:${accountId}:${key}`,
  redeem: (allocationSourceKey: string) => `redeem:${allocationSourceKey}`,
  refund: (allocationSourceKey: string) => `refund:${allocationSourceKey}`,
  expire: (accountId: string, expiresAt: Date) =>
    `expire:${accountId}:${expiresAt.getTime()}`
} as const;

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idempotencyKeyOf(key: string, errors: ValidationError[]): string {
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
  if (typeof value !== "string" || !STORED_VALUE_MONEY_PATTERN.test(value)) {
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

function optionalReason(
  value: unknown,
  field: string,
  required: boolean,
  errors: ValidationError[]
): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) {
      errors.push({ field, message: `${field} is required.` });
    }
    return null;
  }
  if (typeof value !== "string") {
    errors.push({ field, message: `${field} must be a string.` });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (required) errors.push({ field, message: `${field} is required.` });
    return null;
  }
  if (trimmed.length > STORED_VALUE_ENTRY_MAX_REASON) {
    errors.push({
      field,
      message: `${field} must be at most ${STORED_VALUE_ENTRY_MAX_REASON} characters.`
    });
  }
  return trimmed.slice(0, STORED_VALUE_ENTRY_MAX_REASON);
}

export type UpsertProgramInput = {
  enabled: boolean;
  /** `null` = accounts never expire by default. */
  expiryDays: number | null;
  allowRefundToAccount: boolean;
  /** `null` = no ceiling. */
  maxBalance: string | null;
};

export function validateUpsertProgramInput(
  body: unknown
): ValidationResult<UpsertProgramInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];

  if (typeof record.enabled !== "boolean") {
    errors.push({ field: "enabled", message: "enabled must be a boolean." });
  }
  if (typeof record.allowRefundToAccount !== "boolean") {
    errors.push({
      field: "allowRefundToAccount",
      message: "allowRefundToAccount must be a boolean."
    });
  }

  let expiryDays: number | null = null;
  if (record.expiryDays !== undefined && record.expiryDays !== null) {
    if (
      typeof record.expiryDays !== "number" ||
      !Number.isInteger(record.expiryDays) ||
      record.expiryDays < 1 ||
      record.expiryDays > STORED_VALUE_MAX_EXPIRY_DAYS
    ) {
      errors.push({
        field: "expiryDays",
        message: `expiryDays must be an integer from 1 to ${STORED_VALUE_MAX_EXPIRY_DAYS}, or null for no expiry.`
      });
    } else {
      expiryDays = record.expiryDays;
    }
  }

  let maxBalance: string | null = null;
  if (record.maxBalance !== undefined && record.maxBalance !== null) {
    maxBalance = positiveMoney(record.maxBalance, "maxBalance", errors);
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      enabled: record.enabled as boolean,
      expiryDays,
      allowRefundToAccount: record.allowRefundToAccount as boolean,
      maxBalance
    }
  };
}

export type IssueAccountInput = {
  idempotencyKey: string;
  kind: StoredValueKind;
  amount: string;
  customerId: string | null;
  /** `undefined` = the program default; `null` = never expires; a Date = that instant. */
  expiresAt: Date | null | undefined;
  reason: string | null;
};

export function validateIssueAccountInput(
  body: unknown,
  idempotencyKey: string,
  now: Date
): ValidationResult<IssueAccountInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = idempotencyKeyOf(idempotencyKey, errors);

  if (!isStoredValueKind(record.kind)) {
    errors.push({
      field: "kind",
      message: `kind must be one of: ${STORED_VALUE_KINDS.join(", ")}.`
    });
  }
  const amount = positiveMoney(record.amount, "amount", errors);

  let customerId: string | null = null;
  if (record.customerId !== undefined && record.customerId !== null) {
    if (!isUuid(record.customerId)) {
      errors.push({
        field: "customerId",
        message: "customerId must be a UUID, or null."
      });
    } else {
      customerId = record.customerId;
    }
  }

  let expiresAt: Date | null | undefined = undefined;
  if (record.expiresAt === null) {
    expiresAt = null;
  } else if (record.expiresAt !== undefined) {
    const parsed =
      typeof record.expiresAt === "string" ? new Date(record.expiresAt) : null;
    const horizon = now.getTime() + STORED_VALUE_MAX_EXPIRY_DAYS * 86_400_000;
    if (
      parsed === null ||
      Number.isNaN(parsed.getTime()) ||
      parsed.getTime() <= now.getTime() ||
      parsed.getTime() > horizon
    ) {
      errors.push({
        field: "expiresAt",
        message: `expiresAt must be an ISO-8601 instant in the future (within ${STORED_VALUE_MAX_EXPIRY_DAYS} days), or null for no expiry.`
      });
    } else {
      expiresAt = parsed;
    }
  }
  const reason = optionalReason(record.reason, "reason", false, errors);

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      kind: record.kind as StoredValueKind,
      amount,
      customerId,
      expiresAt,
      reason
    }
  };
}

export type LoadAccountInput = {
  idempotencyKey: string;
  amount: string;
  reason: string | null;
};

export function validateLoadAccountInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<LoadAccountInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = idempotencyKeyOf(idempotencyKey, errors);
  const amount = positiveMoney(record.amount, "amount", errors);
  const reason = optionalReason(record.reason, "reason", false, errors);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { idempotencyKey: key, amount, reason } };
}

export type AdjustAccountInput = {
  idempotencyKey: string;
  /** Signed, non-zero `numeric(14,2)` string. */
  amount: string;
  reason: string;
};

export function validateAdjustAccountInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<AdjustAccountInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = idempotencyKeyOf(idempotencyKey, errors);

  let amount = "0.00";
  if (
    typeof record.amount !== "string" ||
    !SIGNED_MONEY_PATTERN.test(record.amount)
  ) {
    errors.push({
      field: "amount",
      message:
        "amount must be a signed numeric(14,2) string (digits with at most two decimals), never a JSON number."
    });
  } else if (signedToCents(record.amount) === 0n) {
    errors.push({ field: "amount", message: "amount must not be zero." });
  } else {
    amount = signedFromCents(signedToCents(record.amount));
  }
  const reason = optionalReason(record.reason, "reason", true, errors);

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: { idempotencyKey: key, amount, reason: reason! }
  };
}

export type ChangeStatusInput = {
  idempotencyKey: string;
  action: "disable" | "enable";
  reason: string | null;
};

export function validateChangeStatusInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<ChangeStatusInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = idempotencyKeyOf(idempotencyKey, errors);
  const actionOk = record.action === "disable" || record.action === "enable";
  if (!actionOk) {
    errors.push({
      field: "action",
      message: "action must be disable or enable."
    });
  }
  const reason = optionalReason(
    record.reason,
    "reason",
    record.action === "disable",
    errors
  );
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      action: record.action as "disable" | "enable",
      reason
    }
  };
}

export type ReconcileInput = { repair: boolean };

export function validateReconcileInput(
  body: unknown
): ValidationResult<ReconcileInput> {
  const record = isRecord(body) ? body : {};
  if (record.repair !== undefined && typeof record.repair !== "boolean") {
    return {
      valid: false,
      errors: [{ field: "repair", message: "repair must be a boolean." }]
    };
  }
  return { valid: true, value: { repair: record.repair === true } };
}

/** The stored-value part of a payment tender (`POS tenders[]`, owner payment body): the plaintext code, validated for shape only. */
export function validateStoredValueCodeField(
  value: unknown,
  field: string,
  errors: ValidationError[]
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({
      field,
      message: `${field} is required for a gift_card / store_credit tender.`
    });
    return null;
  }
  if (value.length > 64) {
    errors.push({ field, message: `${field} is not a valid code.` });
    return null;
  }
  const normalized = normalizeStoredValueCode(value);
  if (!isStoredValueCodeWellFormed(normalized)) {
    errors.push({ field, message: `${field} is not a valid code.` });
    return null;
  }
  return normalized;
}
