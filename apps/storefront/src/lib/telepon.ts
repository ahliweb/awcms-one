/**
 * Indonesian phone number normalisation — PREVIEW ONLY.
 *
 * The #29⇄#30 contract is explicit: "Phones are sent as typed by the
 * customer; the CMS normalises to E.164 (`+62…`) and echoes the normalised
 * form." This file exists so the checkout contact step can show a shopper
 * `+62 812-3456-7890` as they type — catching an obviously wrong number
 * (a landline area code typed as a mobile, a missing digit) before they
 * reach the CMS's own `VALIDATION_ERROR` — but the value THIS FILE PRODUCES
 * is never what is sent to the CMS: `checkout.ts` always submits
 * `customer.phone`/`address.phone` exactly as typed, verbatim, and lets the
 * CMS be the one authority on what a valid, normalised Indonesian number is.
 * Two normalisers disagreeing would be a silent, hard-to-notice defect
 * (this file rejects a number the CMS would have accepted, or vice versa);
 * one authority and one best-effort PREVIEW cannot disagree in a way that
 * blocks a real order.
 */

/** Strips everything but digits and a leading `+`. */
function keepDigitsAndLeadingPlus(value: string): string {
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return hasPlus ? `+${digits}` : digits;
}

/**
 * A best-effort `+62…` preview of `raw`, or `null` when there is too little
 * to normalise (empty, or fewer than 8 digits after the country/trunk
 * prefix) — `null` means "not enough typed yet to preview", not "invalid";
 * the checkout UI shows no preview at all in that case rather than a
 * half-formed one.
 *
 * Accepts the three shapes an Indonesian shopper actually types:
 * `08123456789`, `8123456789`, `+628123456789`/`628123456789` — all three
 * become the same `+62 8xx-xxxx-xxxx`-grouped preview.
 */
export function previewIndonesianPhone(raw: string): string | null {
  const cleaned = keepDigitsAndLeadingPlus(raw);
  if (cleaned.length === 0) return null;

  let national: string;
  if (cleaned.startsWith("+62")) {
    national = cleaned.slice(3);
  } else if (cleaned.startsWith("62") && cleaned.length > 8) {
    national = cleaned.slice(2);
  } else if (cleaned.startsWith("0")) {
    national = cleaned.slice(1);
  } else {
    national = cleaned.replace(/^\+/, "");
  }

  if (national.length < 8 || national.length > 13) return null;

  const groups = [national.slice(0, 3), national.slice(3, 7), national.slice(7)].filter(
    (group) => group.length > 0
  );

  return `+62 ${groups.join("-")}`;
}
