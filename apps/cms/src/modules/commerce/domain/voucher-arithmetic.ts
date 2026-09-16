/**
 * `POST /api/v1/commerce/vouchers/validate`'s pure arithmetic (Issue #26).
 * Pure — no database, no I/O; the route/application layer resolves a `code`
 * to a row (or a `not_found` — see `voucher-validation.ts`'s header) and
 * hands this function the row's fields plus the caller's `subtotal`/
 * `shippingCost`.
 *
 * Reuses `price-calculation.ts`'s `toCents`/`fromCents` — the ONE decimal
 * parser this module uses for exact arithmetic (ADR-0003) — rather than a
 * second hand-rolled copy. `discount` is always returned to 2 decimal
 * places, HALF-UP, same rounding rule `computeFinalPrice` uses.
 */
import { fromCents, toCents } from "./price-calculation";
import type { VoucherType } from "./voucher-validation";

export type VoucherEvaluationReason =
  "not_started" | "expired" | "quota_exhausted" | "min_order";

export type VoucherEvaluationInput = {
  type: VoucherType;
  /** For `percentage`: a `0..100` decimal string. For `nominal`: a `numeric(14,2)` money string. Ignored for `free_shipping`. */
  value: string;
  minOrder: string;
  /** Caps a `percentage` discount. `null` for `nominal`/`free_shipping` (see `reconcileVoucherFields`). */
  maxDiscount: string | null;
  /** `0` means unlimited — the convention this module picks since the issue's schema does not say otherwise. */
  quota: number;
  usedCount: number;
  startsAt: Date;
  endsAt: Date;
};

export type VoucherEvaluation =
  | { valid: true; discount: string; freeShipping: boolean }
  | { valid: false; reason: VoucherEvaluationReason };

/**
 * Checked in this order — window first (a caller most often wants to know
 * WHEN a voucher works before whether their cart qualifies), then quota,
 * then the order minimum. `subtotal`/`shippingCost` are trusted to already
 * be `numeric(14,2)`-shaped strings (the route validates the request body
 * before this runs, same "caller invariant" contract `computeFinalPrice`
 * documents for its own arguments).
 */
export function evaluateVoucher(
  voucher: VoucherEvaluationInput,
  subtotal: string,
  _shippingCost: string,
  now: Date
): VoucherEvaluation {
  if (now < voucher.startsAt) return { valid: false, reason: "not_started" };
  if (now > voucher.endsAt) return { valid: false, reason: "expired" };
  if (voucher.quota > 0 && voucher.usedCount >= voucher.quota) {
    return { valid: false, reason: "quota_exhausted" };
  }

  const subtotalCents = toCents(subtotal);
  const minOrderCents = toCents(voucher.minOrder);
  if (subtotalCents < minOrderCents) {
    return { valid: false, reason: "min_order" };
  }

  if (voucher.type === "free_shipping") {
    return { valid: true, discount: "0.00", freeShipping: true };
  }

  if (voucher.type === "nominal") {
    return {
      valid: true,
      discount: fromCents(toCents(voucher.value)),
      freeShipping: false
    };
  }

  // percentage — `value` is a percentage scaled the same way a money string
  // is (two fractional digits), so `toCents("10.00")` yields `1000n` meaning
  // "10.00%"; dividing by `10000n` (not `100n`) undoes that extra scale
  // factor. HALF-UP, same `+ half-of-divisor` trick `computeFinalPrice` uses.
  const percentScaled = toCents(voucher.value);
  let discountCents = (subtotalCents * percentScaled + 5000n) / 10000n;

  if (voucher.maxDiscount !== null) {
    const capCents = toCents(voucher.maxDiscount);
    if (discountCents > capCents) discountCents = capCents;
  }

  return {
    valid: true,
    discount: fromCents(discountCents),
    freeShipping: false
  };
}
