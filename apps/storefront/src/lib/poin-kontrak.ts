/**
 * The loyalty-points redemption contract for checkout (awcms-one issue #363,
 * ADR-0043) - pure functions only, no `window`, no network, so they are
 * unit-testable without a DOM. `src/scripts/checkout.ts` is the only consumer.
 *
 * ## What this app does and does not decide
 *
 * It sends ONE number with an order: how many whole points the shopper wants
 * to spend (`loyaltyRedemption: { points }`). It never sends - and could not be
 * trusted if it did - a discount, a rate, a total or an account: the CMS takes
 * the account from the bearer session and computes the discount from the
 * tenant's point value. Everything here that looks like arithmetic is a
 * DISPLAY ESTIMATE for the shopper, never an input to an order.
 *
 * The shopper's balance and the tenant's point value come from the
 * bearer-secured `GET /account/loyalty` (`ambilPoin` in `akun-klien.ts`),
 * which answers a neutral 404 when loyalty is off - the checkout then simply
 * never shows the field.
 */

/** What `GET /account/loyalty` tells checkout: the shopper's balance, and what a point is worth at checkout (`null` = points cannot be spent). */
export type PoinAkun = {
  balance: number;
  redemption: { rupiahPerPoint: number; maxGoodsPercent: number | null } | null;
};

/** Validates the `GET /account/loyalty` body into a {@link PoinAkun}, or `null` for anything malformed - dropped, never trusted. */
export function parsePoinAkun(value: unknown): PoinAkun | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.balance !== "number" || !Number.isSafeInteger(candidate.balance)) return null;

  const raw = candidate.redemption;
  if (raw === null || raw === undefined) return { balance: candidate.balance, redemption: null };
  if (typeof raw !== "object") return null;
  const terms = raw as Record<string, unknown>;
  if (
    typeof terms.rupiahPerPoint !== "number" ||
    !Number.isSafeInteger(terms.rupiahPerPoint) ||
    terms.rupiahPerPoint < 1
  ) {
    return null;
  }
  const cap = terms.maxGoodsPercent;
  if (cap !== null && cap !== undefined && (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1 || cap > 100)) {
    return null;
  }

  return {
    balance: candidate.balance,
    redemption: { rupiahPerPoint: terms.rupiahPerPoint, maxGoodsPercent: typeof cap === "number" ? cap : null }
  };
}

/** Whether checkout should offer the field at all: points can be spent here AND the shopper has some. */
export function bolehPakaiPoin(poin: PoinAkun | null): poin is PoinAkun & { redemption: NonNullable<PoinAkun["redemption"]> } {
  return poin !== null && poin.redemption !== null && poin.balance > 0;
}

/** The whole points typed into the field, or `null` for blank. `NaN` for anything else (the caller shows an error): a fraction, a negative, text. */
export function bacaPoinInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,12}$/.test(trimmed)) return Number.NaN;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) return Number.NaN;
  return value;
}

/** `points x rupiahPerPoint` rupiah, as a plain integer - the same product the CMS computes (display only). */
export function perkiraanDiskonPoin(points: number, rupiahPerPoint: number): number {
  return points * rupiahPerPoint;
}

/** The Indonesian message for a CMS refusal of a redemption, or `null` when `code` is not one. `details` is the error's `details` (`maxPoints`, `balance`). */
export function pesanKesalahanPoin(code: string, details?: unknown): string | null {
  const info = (typeof details === "object" && details !== null ? details : {}) as {
    maxPoints?: unknown;
    reason?: unknown;
    balance?: unknown;
  };
  switch (code) {
    case "LOYALTY_REDEMPTION_UNAVAILABLE":
      return "Poin loyalitas belum dapat dipakai di toko ini.";
    case "LOYALTY_REDEMPTION_REQUIRES_ACCOUNT":
      return "Masuk ke akun Anda untuk memakai poin loyalitas.";
    case "LOYALTY_REDEMPTION_DEPOSIT_CONFLICT":
      return "Poin tidak dapat digabung dengan pembayaran DP.";
    case "LOYALTY_REDEMPTION_CUSTOMER_UNAVAILABLE":
      return "Akun ini tidak dapat memakai poin loyalitas.";
    case "LOYALTY_REDEMPTION_EXCEEDS_LIMIT": {
      const max = typeof info.maxPoints === "number" ? info.maxPoints : null;
      const alasan =
        info.reason === "cap"
          ? "Poin hanya dapat membayar sebagian dari harga barang."
          : "Nilai poin melebihi harga barang.";
      return max === null ? alasan : `${alasan} Maksimal ${max} poin untuk pesanan ini.`;
    }
    case "INSUFFICIENT_POINTS": {
      const saldo = typeof info.balance === "number" ? info.balance : null;
      return saldo === null ? "Poin Anda tidak cukup." : `Poin Anda tidak cukup. Saldo Anda ${saldo} poin.`;
    }
    default:
      return null;
  }
}
