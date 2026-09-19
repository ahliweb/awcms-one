import { normalizePhoneNumber } from "./phone-normalisation";

/**
 * Customer account registration validation and the D4 history-from rule
 * (Issue #87, C1, contract #86/ADR-0016). Pure — no database, no I/O.
 *
 * `ValidationError`/`ValidationResult` mirror the shape every other commerce
 * domain file declares locally (`category-validation.ts`,
 * `product-image-validation.ts`, `slider-validation.ts`, …) — this module
 * has no shared `_shared/validation.ts` to import from, so a fresh local
 * copy here is the existing convention, not a divergence from it.
 */
export type ValidationError = { field: string; message: string };

type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const MAX_NAME_LENGTH = 150;
const MIN_NAME_LENGTH = 2;

/** Deliberately permissive — RFC 5322's real grammar is far larger than any regex should attempt; this only rejects the obviously-wrong shapes (no `@`, no domain, embedded whitespace) that a fat-fingered input produces. The real proof of reachability is the OTP itself. */
const EMAIL_SHAPE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

/**
 * `lower(btrim(email))` — matches the SQL-side normalisation
 * (`email_normalized`, `sql/917`) exactly, so a value normalised here and one
 * normalised by a raw `lower(btrim(...))` query always compare equal.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isWellFormedEmail(email: string): boolean {
  return (
    email.length > 0 &&
    email.length <= MAX_EMAIL_LENGTH &&
    EMAIL_SHAPE_PATTERN.test(email)
  );
}

export type RegistrationInput = {
  name: string;
  phone: string;
  email: string;
};

export type ValidatedRegistration = {
  name: string;
  phone: string;
  emailNormalized: string;
};

/**
 * D4's first sentence: "Registration requires name + phone + e-mail." Phone
 * goes through the existing `normalizePhoneNumber` (E.164); e-mail is
 * normalised (`normalizeEmail`) and shape-checked, never verified here — the
 * OTP flow (`application/customer-account-store.ts`) is what proves the
 * e-mail is actually reachable.
 */
export function validateRegistration(
  input: unknown
): ValidationResult<ValidatedRegistration> {
  const record = (input ?? {}) as Record<string, unknown>;
  const errors: ValidationError[] = [];

  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: "name",
      message: `name is required and must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters.`
    });
  }

  let normalizedPhone = "";
  if (typeof record.phone !== "string" || record.phone.trim().length === 0) {
    errors.push({ field: "phone", message: "phone is required." });
  } else {
    const phoneResult = normalizePhoneNumber(record.phone);
    if (!phoneResult.valid) {
      errors.push({
        field: "phone",
        message: "phone is not a valid Indonesian phone number."
      });
    } else {
      normalizedPhone = phoneResult.value;
    }
  }

  let emailNormalized = "";
  if (typeof record.email !== "string" || record.email.trim().length === 0) {
    errors.push({ field: "email", message: "email is required." });
  } else {
    const candidate = normalizeEmail(record.email);
    if (!isWellFormedEmail(candidate)) {
      errors.push({
        field: "email",
        message: "email is not a valid e-mail address."
      });
    } else {
      emailNormalized = candidate;
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: { name, phone: normalizedPhone, emailNormalized }
  };
}

export type ResolveHistoryFromInput = {
  guestCustomerEmail: string | null;
  verifiedEmail: string;
  guestCreatedAt: Date;
  now: Date;
};

/**
 * ADR-0016 D4, second sentence: "If the phone already exists as a guest
 * customer, the account binds to that row, but `history_from` = that row's
 * `created_at` ONLY IF the guest row's e-mail equals the verified e-mail;
 * otherwise `history_from = now()`."
 *
 * Both e-mails are normalised before comparison so that a guest row saved
 * with mixed case/whitespace (Issue #29's `awcms_commerce_customers.email`
 * has no normalisation of its own — it is a free-text field a guest typed at
 * checkout) does not spuriously fail to match a verified e-mail that IS the
 * same address. `guestCustomerEmail: null` (a guest checkout that never
 * supplied one) can never equal a verified e-mail — always `now()`.
 */
export function resolveHistoryFrom(input: ResolveHistoryFromInput): Date {
  if (input.guestCustomerEmail === null) return input.now;

  const guestNormalized = normalizeEmail(input.guestCustomerEmail);
  const verifiedNormalized = normalizeEmail(input.verifiedEmail);

  return guestNormalized === verifiedNormalized
    ? input.guestCreatedAt
    : input.now;
}
