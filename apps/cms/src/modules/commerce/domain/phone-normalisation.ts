/**
 * Indonesian phone number normalisation to E.164 (`+62…`) — Issue #29. Pure —
 * no database, no I/O.
 *
 * Accepts the shapes a customer actually types: with/without dashes,
 * spaces or parentheses, a leading `0` (the domestic trunk prefix), a bare
 * `62` with no `+`, or an already-correct `+62…`. Anything else is refused
 * rather than guessed — a wrong guess here would silently misfile an order
 * under the wrong phone number, and phone is the tracking CREDENTIAL
 * (`GET .../orders/{code}?phone=`), so a normalisation mistake is a customer
 * permanently locked out of their own order.
 *
 * The storefront contract states plainly: "Phones are sent as typed by the
 * customer; the CMS normalises to E.164 (`+62…`) and echoes the normalised
 * form." Every anonymous route that accepts a phone number calls this before
 * storing or comparing it. Masking (`maskPhone`) is a separate, later step
 * applied only at the read/audit/log layer — never here, and never in
 * storage (`sql/913`'s header explains why `awcms_commerce_customers.phone`
 * itself is kept in the clear).
 */
/**
 * Issue #116 (contract #106 D6) — the per-tenant WALK-IN customer's sentinel
 * phone. `awcms_commerce_customers.phone` is `NOT NULL` (`sql/913`'s own
 * schema) and IS the tracking credential for a real phone-identified
 * customer, so a POS sale rung up with no phone at all still needs a real
 * row to attach to. `application/pos-directory.ts`'s `createPosOrder` calls
 * `findOrCreateCustomerByPhone` with EXACTLY this value whenever the
 * cashier leaves `customer.phone` blank — the SAME dedup-by-phone path a
 * real phone-identified walk-in uses, so every tenant gets exactly ONE
 * walk-in row, reused across every no-phone counter sale. Deliberately an
 * already-normalised E.164-SHAPED string (`+62` + 10 zero digits) so it
 * round-trips through `normalizePhoneNumber` unchanged and is never
 * confused with a real subscriber number (Indonesian mobile numbers never
 * start `62 0`). Documented again in `docs/kamus-data.md`'s "channel" /
 * "cash" / walk-in sentinel entry — this constant is the single source of
 * truth for the literal value.
 */
export const POS_WALK_IN_CUSTOMER_SENTINEL_PHONE = "+620000000000";

export type PhoneNormalisationResult =
  | { valid: true; value: string }
  | { valid: false; reason: "empty" | "invalid_format" | "invalid_length" };

/** National significant number length bounds (digits after the `62` country code) — Indonesian mobile/landline numbers fall inside this range in every real-world shape this module has seen. */
const MIN_NATIONAL_DIGITS = 8;
const MAX_NATIONAL_DIGITS = 13;

export function normalizePhoneNumber(raw: string): PhoneNormalisationResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { valid: false, reason: "empty" };
  }

  const trimmed = raw.trim();
  const hasLeadingPlus = trimmed.startsWith("+");
  const digitsOnly = trimmed.replace(/\D/g, "");

  if (digitsOnly.length === 0) {
    return { valid: false, reason: "invalid_format" };
  }

  let national: string;

  if (hasLeadingPlus && digitsOnly.startsWith("62")) {
    national = digitsOnly.slice(2);
  } else if (
    !hasLeadingPlus &&
    digitsOnly.startsWith("62") &&
    digitsOnly.length > 10
  ) {
    // A bare `62…` with no `+`, long enough that it is very unlikely to be a
    // domestic number that merely happens to start with "62" — Indonesian
    // domestic numbers always start `0`, never `62`.
    national = digitsOnly.slice(2);
  } else if (!hasLeadingPlus && digitsOnly.startsWith("0")) {
    national = digitsOnly.slice(1);
  } else {
    return { valid: false, reason: "invalid_format" };
  }

  if (
    national.length < MIN_NATIONAL_DIGITS ||
    national.length > MAX_NATIONAL_DIGITS
  ) {
    return { valid: false, reason: "invalid_length" };
  }

  return { valid: true, value: `+62${national}` };
}

/**
 * `+62812•••7890` — the country code plus the first 3 national digits, the
 * last 4 digits, and exactly three bullets in between regardless of how many
 * digits they replace (matching the storefront contract's own
 * `phoneMasked` example). Never applied to a value that has not already
 * been through {@link normalizePhoneNumber} — a malformed input has no
 * guaranteed length to mask safely.
 */
export function maskPhone(e164: string): string {
  if (e164.length <= 10) return "•".repeat(Math.max(e164.length - 4, 0));
  const head = e164.slice(0, 6);
  const tail = e164.slice(-4);
  return `${head}•••${tail}`;
}
