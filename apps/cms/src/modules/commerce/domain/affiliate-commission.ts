/**
 * Affiliate commission arithmetic + the commission-rate input shape —
 * Issue #92 (#86's D5). Pure — no database, no I/O.
 *
 * All arithmetic runs through `price-calculation.ts`'s `toCents`/`fromCents`
 * (integer-cent `BigInt`, ADR-0003 — never a float), the same discipline
 * `voucher-arithmetic.ts` already follows for exactly the same reason: a
 * commission is money, and `numeric(14,2)`/`numeric(5,2)` values cross the
 * wire as strings, not JS numbers.
 */
import { toCents, fromCents } from "./price-calculation";

export type ValidationError = { field: string; message: string };

const RATE_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

/**
 * `base = subtotal − discount − voucher_discount`, floored at zero — an
 * order whose discounts exceed its subtotal (should not happen, but this is
 * pure arithmetic, not a place to throw) never yields a negative commission
 * base.
 */
export function computeCommissionBase(
  subtotal: string,
  discount: string,
  voucherDiscount: string
): string {
  const baseCents =
    toCents(subtotal) - toCents(discount) - toCents(voucherDiscount);
  return fromCents(baseCents < 0n ? 0n : baseCents);
}

/**
 * `amount = round(base × rate / 100, 2)`, half-up. `rate` is a
 * `numeric(5,2)` PERCENTAGE string (e.g. `"10.00"` means 10%) — reusing
 * `toCents` on it yields "hundredths of a percentage point"
 * (`"10.00" -> 1000`), so the combined divisor against a cents-scaled base is
 * `100 * 100 = 10000`.
 */
export function computeCommissionAmount(base: string, rate: string): string {
  const baseCents = toCents(base);
  const rateHundredths = toCents(rate);
  const amountCents = (baseCents * rateHundredths + 5000n) / 10000n;
  return fromCents(amountCents);
}

export type ShouldEarnCommissionInput = {
  affiliateCustomerId: string;
  orderCustomerId: string;
  affiliateStatus: "active" | "suspended";
};

/**
 * `false` on self-referral (the affiliate's own customer row placed the
 * order) or a suspended affiliate — evaluated again at the moment the order
 * reaches `completed`, using the affiliate's CURRENT status, since a code
 * captured `active` at checkout may have been suspended by the time the
 * order completes (`application/affiliate-directory.ts`'s
 * `resolveAffiliateForOrder` already refuses to link a suspended/unknown
 * code at order-creation time; this is the second, independent gate at
 * completion time).
 */
export function shouldEarnCommission(
  input: ShouldEarnCommissionInput
): boolean {
  if (input.affiliateStatus === "suspended") return false;
  if (input.affiliateCustomerId === input.orderCustomerId) return false;
  return true;
}

/**
 * `store_settings.affiliate_commission_rate`/`affiliates.commission_rate`
 * input shape — `numeric(5,2)`, `0..100`, at most two decimal places,
 * nullable (null = "affiliate program off" for the store-settings column;
 * an individual affiliate's own rate is never null once enrolled).
 */
export function validateCommissionRateInput(
  value: unknown,
  field = "commissionRate"
):
  | { valid: true; value: string | null }
  | { valid: false; errors: ValidationError[] } {
  if (value === null || value === undefined) {
    return { valid: true, value: null };
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return {
      valid: false,
      errors: [{ field, message: `${field} must be a number or null.` }]
    };
  }

  const text = typeof value === "number" ? value.toFixed(2) : value.trim();

  if (!RATE_PATTERN.test(text)) {
    return {
      valid: false,
      errors: [
        {
          field,
          message: `${field} must be a decimal with at most 2 places.`
        }
      ]
    };
  }

  const numeric = Number.parseFloat(text);
  if (Number.isNaN(numeric) || numeric < 0 || numeric > 100) {
    return {
      valid: false,
      errors: [{ field, message: `${field} must be between 0 and 100.` }]
    };
  }

  const [wholePart, fractionalPart = ""] = text.split(".");
  const normalized = `${Number.parseInt(wholePart!, 10)}.${(fractionalPart + "00").slice(0, 2)}`;
  return { valid: true, value: normalized };
}
