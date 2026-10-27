/**
 * Pure rules of the cashier / front-desk screen (Issue #388,
 * `docs/booking-ux-flows.md` section 5, Surface D). No DOM, no network, no
 * clock: `tests/front-desk-client.test.ts` asserts every function here directly,
 * and `front-desk-island.ts` is the thin DOM layer over them.
 *
 * ## What this module is NOT
 *
 * It is not an authority. The server reads the balance from the payment ledger
 * and the price from the order line (threat control C-36), re-checks the
 * register session (C-35) and the tenant's check-in policy (ADR-0045 D19), and
 * a body that names an amount owed, a price, an order or a customer is a `400`.
 * Everything here is a PREVIEW or a hint, so the cashier learns about a refusal
 * before a round trip - and the screen never sends a figure the server would
 * not accept: the only money in a request is what the customer hands over.
 *
 * ## Why the check-in policy is read, never decided here (residual R3)
 *
 * Whether a guest with a balance owed may be checked in is the TENANT's setting
 * (`checkinRequiresSettlement`, default `true` = block; ADR-0045 D19). The card
 * carries it as `policy.checkInRequiresSettlement` and carries the result as
 * `actions.canCheckIn` / `actions.checkInBlockedReason`. This module only turns
 * those hints into the visible reason; there is no "override" control, because
 * the policy is switched on the commerce settings screen (which asks for a step
 * up when it is switched OFF) and by nothing else. The default is still pending
 * the owner's confirmation (PR #443, residual R3).
 */

// ---------------------------------------------------------------------------
// Money (ADR-0003: numeric(14,2) strings in, bigint cents inside)
// ---------------------------------------------------------------------------

/** What a tender amount may look like: up to 12 whole digits and at most two decimals. */
export const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/** `"25000.50"` -> `2500050n`. Only call it with a string {@link MONEY_PATTERN} accepted, or a server figure. */
export function toCents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole || "0") * 100n + BigInt((fraction + "00").slice(0, 2));
}

export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * A figure for the eye (`Rp 700.000,00`). Display only: the number is never
 * parsed back and never sent. A non-numeric input prints a dash rather than
 * `NaN`, which is a wrong statement about money.
 */
export function formatMoney(
  value: string,
  intlTag: string,
  currency: string
): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  try {
    return new Intl.NumberFormat(intlTag, {
      style: "currency",
      currency
    }).format(numeric);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// The lookup (control C-34)
// ---------------------------------------------------------------------------

/** Booking's `reservation_no` shape; the request is upper-cased before the check. */
export const RESERVATION_NO_PATTERN = /^[A-Z0-9][A-Z0-9-]{3,31}$/;
const EMAIL_SHAPE = /^[^\s@%*?]+@[^\s@%*?]+\.[^\s@%*?]+$/;
const MAX_EMAIL_LENGTH = 254;
/** National Indonesian numbers carry 8 to 13 digits after the country code; this only rejects the obvious. */
const PHONE_SHAPE = /^\+?[\d\s().-]{8,24}$/;

export type LookupField = "code" | "contact";
export type LookupFieldProblem =
  "code_required" | "code_invalid" | "contact_required" | "contact_invalid";

export type LookupBody =
  | { reservationNo: string; phone: string }
  | { reservationNo: string; email: string };

export type LookupInput =
  | { ok: true; body: LookupBody }
  | { ok: false; field: LookupField; problem: LookupFieldProblem };

/**
 * The code, plus ONE contact. A contact holding an `@` is an e-mail, anything
 * else a phone. Both are required: the till finds a reservation by the code
 * TOGETHER with the customer's contact, never by either alone and never by a
 * search (C-34), so there is no code-only or name-only path to build here.
 * Returns the FIRST invalid field so focus can go there.
 */
export function buildLookupBody(
  codeRaw: string,
  contactRaw: string
): LookupInput {
  const code = codeRaw.trim().toUpperCase();
  if (code === "") {
    return { ok: false, field: "code", problem: "code_required" };
  }
  if (!RESERVATION_NO_PATTERN.test(code)) {
    return { ok: false, field: "code", problem: "code_invalid" };
  }
  const contact = contactRaw.trim();
  if (contact === "") {
    return { ok: false, field: "contact", problem: "contact_required" };
  }
  if (contact.includes("@")) {
    const email = contact.toLowerCase();
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) {
      return { ok: false, field: "contact", problem: "contact_invalid" };
    }
    return { ok: true, body: { reservationNo: code, email } };
  }
  if (!PHONE_SHAPE.test(contact) || contact.replace(/\D/g, "").length < 8) {
    return { ok: false, field: "contact", problem: "contact_invalid" };
  }
  return { ok: true, body: { reservationNo: code, phone: contact } };
}

// ---------------------------------------------------------------------------
// The reservation card (what POST lookup answers)
// ---------------------------------------------------------------------------

export type FrontDeskCard = {
  reservationId: string;
  reservationNo: string;
  status: string;
  linkStatus: string;
  startsAt: string;
  endsAt: string;
  orderId: string;
  orderCode: string;
  orderStatus: string;
  guest: { name: string; phoneMasked: string; emailMasked: string | null };
  serviceLine: {
    name: string;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
  } | null;
  settlement: {
    total: string;
    paid: string;
    deposit: string;
    balanceDue: string;
    paymentStatus: string;
  };
  policy: { checkInRequiresSettlement: boolean };
  actions: {
    canCollectBalance: boolean;
    canCheckIn: boolean;
    checkInBlockedReason: "balance_not_settled" | null;
    canCheckOut: boolean;
  };
};

/** The card's lookup answer is untrusted JSON until proven otherwise; this is the shape gate. */
export function isFrontDeskCard(value: unknown): value is FrontDeskCard {
  if (typeof value !== "object" || value === null) return false;
  const card = value as Partial<FrontDeskCard>;
  return (
    typeof card.reservationId === "string" &&
    typeof card.reservationNo === "string" &&
    typeof card.status === "string" &&
    typeof card.startsAt === "string" &&
    typeof card.endsAt === "string" &&
    typeof card.settlement?.balanceDue === "string" &&
    typeof card.settlement?.total === "string" &&
    typeof card.settlement?.paid === "string" &&
    typeof card.actions === "object" &&
    card.actions !== null &&
    typeof card.guest?.name === "string"
  );
}

/** Whole nights between two instants, by their UTC calendar dates (the card's dates are the stay's dates). */
export function nightsBetween(startsAt: string, endsAt: string): number {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const day = (ms: number): number => Math.floor(ms / 86_400_000);
  return Math.max(0, day(end) - day(start));
}

export const STATUS_TONES: Readonly<Record<string, string>> = {
  held: "warning",
  confirmed: "success",
  checked_in: "success",
  completed: "success",
  cancelled: "neutral",
  expired: "neutral",
  no_show: "danger",
  rescheduled: "neutral"
};

export function statusTone(status: string): string {
  return STATUS_TONES[status] ?? "neutral";
}

// ---------------------------------------------------------------------------
// What the three controls may do, and WHY NOT when they may not
// ---------------------------------------------------------------------------

export type ActionName = "checkIn" | "checkOut" | "collect";

/**
 * Why a control is unavailable. Each is a visible sentence on the screen, never
 * a silently greyed button (a disabled control with no reason is the defect
 * UX flows section 5.1 step 4 names).
 */
export type BlockedReason =
  | "no_permission"
  | "no_session"
  | "balance_not_settled"
  | "not_confirmed"
  | "not_checked_in"
  | "nothing_owed"
  | "not_payable";

export type ActionState =
  { enabled: true; reason: null } | { enabled: false; reason: BlockedReason };

export type DeskCapabilities = {
  canCheckIn: boolean;
  canCheckOut: boolean;
  canCollect: boolean;
  /** The cashier holds an OPEN session on the register the writes name. */
  hasSession: boolean;
};

/**
 * The card's `actions` are the server's hints for the reservation; this adds
 * what only the screen knows - the cashier's permission and open session. Order
 * of precedence is what the cashier can FIX first: a missing permission cannot
 * be fixed at the desk, a missing session can, then the reservation's own state.
 */
export function actionStates(
  card: FrontDeskCard,
  caps: DeskCapabilities
): Record<ActionName, ActionState> {
  const blocked = (reason: BlockedReason): ActionState => ({
    enabled: false,
    reason
  });
  const open: ActionState = { enabled: true, reason: null };

  const checkIn: ActionState = !caps.canCheckIn
    ? blocked("no_permission")
    : card.actions.checkInBlockedReason === "balance_not_settled"
      ? blocked("balance_not_settled")
      : card.status !== "confirmed" || !card.actions.canCheckIn
        ? blocked("not_confirmed")
        : !caps.hasSession
          ? blocked("no_session")
          : open;

  const checkOut: ActionState = !caps.canCheckOut
    ? blocked("no_permission")
    : card.status !== "checked_in" || !card.actions.canCheckOut
      ? blocked("not_checked_in")
      : !caps.hasSession
        ? blocked("no_session")
        : open;

  const owed = toCents(card.settlement.balanceDue) > 0n;
  const collect: ActionState = !caps.canCollect
    ? blocked("no_permission")
    : !owed
      ? blocked("nothing_owed")
      : !card.actions.canCollectBalance
        ? blocked("not_payable")
        : !caps.hasSession
          ? blocked("no_session")
          : open;

  return { checkIn, checkOut, collect };
}

// ---------------------------------------------------------------------------
// Balance collection: the tender plan preview
// ---------------------------------------------------------------------------

export type TenderType =
  | "cash"
  | "manual_qris"
  | "manual_bank_transfer"
  | "gift_card"
  | "store_credit";

export type TenderLine = {
  type: TenderType;
  /** What was typed: for cash the amount HANDED OVER, otherwise the amount applied. */
  amount: string;
  reference?: string;
  /** Gift card / store credit code; sent once, never echoed. */
  code?: string;
};

export function isStoredValueTender(type: TenderType): boolean {
  return type === "gift_card" || type === "store_credit";
}

export type TenderPlan = {
  balanceCents: bigint;
  /** Lines with an amount typed (an empty line is ignored, like the POS sale form). */
  filled: number;
  nonCashCents: bigint;
  cashCount: number;
  cashHandedCents: bigint;
  /** The part of the cash that settles the balance. */
  appliedCashCents: bigint;
  /** Cash to hand back. */
  changeCents: bigint;
  /** What would still be owed after this payment. */
  remainingCents: bigint;
  /** The non-cash legs alone exceed the balance: refused (`409 OVERPAYMENT`). */
  overpaid: boolean;
  /** Indices of lines whose amount is not a positive money value. */
  badAmounts: number[];
  /** Indices of stored-value lines with no code. */
  missingCodes: number[];
};

/**
 * Mirrors `planTenders` in `domain/payment-allocation.ts`, in `bigint` cents:
 * non-cash lines are applied first, cash is applied to what is left and anything
 * above it is change. Only a CASH line may exceed the balance. A payment smaller
 * than the balance is allowed (the card then shows what remains), which is why
 * `remainingCents` is reported and not refused.
 */
export function planBalanceTenders(
  balanceDue: string,
  lines: readonly TenderLine[]
): TenderPlan {
  const balanceCents = toCents(balanceDue);
  let nonCash = 0n;
  let cashHanded = 0n;
  let cashCount = 0;
  let filled = 0;
  const badAmounts: number[] = [];
  const missingCodes: number[] = [];

  lines.forEach((line, index) => {
    const raw = line.amount.trim();
    if (raw === "") return;
    if (!MONEY_PATTERN.test(raw) || toCents(raw) <= 0n) {
      badAmounts.push(index);
      return;
    }
    filled += 1;
    if (isStoredValueTender(line.type) && (line.code ?? "").trim() === "") {
      missingCodes.push(index);
    }
    if (line.type === "cash") {
      cashCount += 1;
      cashHanded += toCents(raw);
    } else {
      nonCash += toCents(raw);
    }
  });

  const left = balanceCents > nonCash ? balanceCents - nonCash : 0n;
  const appliedCash = cashHanded >= left ? left : cashHanded;
  const remaining = balanceCents - nonCash - appliedCash;
  return {
    balanceCents,
    filled,
    nonCashCents: nonCash,
    cashCount,
    cashHandedCents: cashHanded,
    appliedCashCents: appliedCash,
    changeCents: cashHanded - appliedCash,
    remainingCents: remaining > 0n ? remaining : 0n,
    overpaid: nonCash > balanceCents,
    badAmounts,
    missingCodes
  };
}

export type TenderProblem =
  "no_tender" | "bad_amount" | "two_cash" | "overpayment" | "code_required";

/**
 * The first reason the form cannot be submitted, with the index of the line it
 * is about (so focus and `aria-invalid` go to that line), or `null`.
 */
export function firstTenderProblem(
  plan: TenderPlan
): { problem: TenderProblem; index: number | null } | null {
  if (plan.badAmounts.length > 0) {
    return { problem: "bad_amount", index: plan.badAmounts[0]! };
  }
  if (plan.filled === 0) return { problem: "no_tender", index: null };
  if (plan.cashCount > 1) return { problem: "two_cash", index: null };
  if (plan.missingCodes.length > 0) {
    return { problem: "code_required", index: plan.missingCodes[0]! };
  }
  if (plan.overpaid) return { problem: "overpayment", index: null };
  return null;
}

export type BalanceBody = {
  registerId: string;
  tenders: {
    tenderType: TenderType;
    amount: string;
    reference: string | null;
    storedValueCode?: string;
  }[];
};

/**
 * The request body of a balance collection: the register and the tenders, and
 * NOTHING about the balance, the price, the order or the customer (a body that
 * names one is a `400`, C-36). Empty lines are dropped. A stored-value line
 * sends its code and no reference (a code must never double as a stored
 * reference); a cash line sends no reference either.
 */
export function buildBalanceBody(
  registerId: string,
  lines: readonly TenderLine[]
): BalanceBody {
  const tenders: BalanceBody["tenders"] = [];
  for (const line of lines) {
    const raw = line.amount.trim();
    if (raw === "") continue;
    const stored = isStoredValueTender(line.type);
    tenders.push({
      tenderType: line.type,
      amount: fromCents(toCents(raw)),
      reference:
        line.type === "cash" || stored ? null : line.reference?.trim() || null,
      ...(stored ? { storedValueCode: (line.code ?? "").trim() } : {})
    });
  }
  return { registerId, tenders };
}

// ---------------------------------------------------------------------------
// Idempotency: one key per ATTEMPT, kept across a retry of the same request
// ---------------------------------------------------------------------------

/**
 * Every write carries an `Idempotency-Key`. A key is bound to the exact request
 * it was first sent with: re-using it for a DIFFERENT request is
 * `409 IDEMPOTENCY_CONFLICT`, and sending a fresh key after a network error that
 * hid the outcome could write the money twice. So the key is kept while the
 * request is the same (a retry after a dropped connection replays the first
 * outcome) and renewed when the request changed or the attempt was settled.
 */
export function createAttemptKeys(
  generate: () => string = () => globalThis.crypto.randomUUID()
) {
  let signature: string | null = null;
  let key: string | null = null;
  return {
    /** The key for a request with this signature. */
    keyFor(next: string): string {
      if (key === null || signature !== next) {
        signature = next;
        key = generate();
      }
      return key;
    },
    /** The attempt reached a definite outcome (written or refused): the next one starts fresh. */
    settle(): void {
      signature = null;
      key = null;
    }
  };
}

/**
 * True when a write's outcome is unknown, so its key must be KEPT for a retry.
 * That is a dropped connection (`NETWORK_ERROR`) and also any failure without a
 * server error envelope: a proxy's 502/504 page or a truncated body arrives as
 * `ok: false, errorCode: null`, and the server may well have committed the
 * payment behind it. Only an answer carrying an error code is a definite refusal.
 */
export function isOutcomeUnknown(result: {
  readonly ok: boolean;
  readonly errorCode: string | null;
}): boolean {
  return (
    result.errorCode === "NETWORK_ERROR" ||
    (!result.ok && result.errorCode === null)
  );
}

/** A stable text for a request, so {@link createAttemptKeys} can tell a retry from a new request. */
export function requestSignature(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

// ---------------------------------------------------------------------------
// Server refusals -> the sentence the cashier reads
// ---------------------------------------------------------------------------

/**
 * Error code -> the `data-msg-*` dataset key the screen renders it from (the
 * screen renders each sentence server-side through `t()`, because the client
 * cannot translate). Codes not listed fall back to `generic`.
 */
export const REFUSAL_KEYS: Readonly<Record<string, string>> = {
  REGISTER_SESSION_REQUIRED: "msgSessionRequired",
  REGISTER_SESSION_CLOSING: "msgSessionClosing",
  NOT_SESSION_CASHIER: "msgNotSessionCashier",
  BALANCE_NOT_SETTLED: "msgBalanceNotSettled",
  NO_BALANCE_DUE: "msgNoBalanceDue",
  ORDER_NOT_PAYABLE: "msgOrderNotPayable",
  OVERPAYMENT: "msgOverpayment",
  INVALID_STATE: "msgStateChanged",
  CHECK_IN_TOO_EARLY: "msgTooEarly",
  IDEMPOTENCY_CONFLICT: "msgIdempotencyConflict",
  RATE_LIMITED: "msgRateLimited",
  FEATURE_DISABLED: "msgFeatureDisabled",
  ACCESS_DENIED: "msgDenied",
  STORED_VALUE_NOT_FOUND: "msgSvNotFound",
  STORED_VALUE_UNAVAILABLE: "msgSvUnavailable",
  STORED_VALUE_INSUFFICIENT: "msgSvInsufficient",
  STORED_VALUE_LOOKUP_THROTTLED: "msgSvThrottled",
  RESOURCE_NOT_FOUND: "msgNotFound",
  VALIDATION_ERROR: "msgGeneric"
};

export function refusalKey(errorCode: string | null): string {
  if (errorCode === null) return "msgGeneric";
  return REFUSAL_KEYS[errorCode] ?? "msgGeneric";
}

/**
 * Whether a refusal means the reservation changed under the cashier (so the card
 * is re-read and shown as it now is: "Status reservasi berubah. Data diperbarui.").
 */
export function refusalReloadsCard(errorCode: string | null): boolean {
  return (
    errorCode === "INVALID_STATE" ||
    errorCode === "BALANCE_NOT_SETTLED" ||
    errorCode === "NO_BALANCE_DUE" ||
    errorCode === "ORDER_NOT_PAYABLE" ||
    errorCode === "OVERPAYMENT"
  );
}

/** The `details.outstanding` a `BALANCE_NOT_SETTLED` / `OVERPAYMENT` refusal carries, if it is a money string. */
export function outstandingFromDetails(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const outstanding = (details as { outstanding?: unknown }).outstanding;
  return typeof outstanding === "string" && MONEY_PATTERN.test(outstanding)
    ? outstanding
    : null;
}

/** The `field` names a `VALIDATION_ERROR`'s `details` list (`[{ field, message }]`), in order. */
export function validationFields(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const fields: string[] = [];
  for (const entry of details) {
    const field = (entry as { field?: unknown } | null)?.field;
    if (typeof field === "string") fields.push(field);
  }
  return fields;
}

/**
 * Which tender line and which part of it a refused field names
 * (`tenders[1].storedValueCode` -> line 1, its code), or `null` when it is not
 * about one line. The server is the authority on a code's shape and on the
 * amount; the screen only has to put the refusal on the right control.
 */
export function tenderFieldTarget(
  field: string
): { index: number; part: "amount" | "code" | "other" } | null {
  const match = /^tenders\[(\d{1,2})\]\.?(.*)$/.exec(field);
  if (!match) return null;
  const part = match[2];
  return {
    index: Number(match[1]),
    part:
      part === "amount"
        ? "amount"
        : part === "storedValueCode"
          ? "code"
          : "other"
  };
}
