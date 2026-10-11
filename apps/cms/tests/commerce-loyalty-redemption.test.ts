/**
 * Loyalty point redemption - pure domain and structural tests (Issue #363,
 * ADR-0043). The database-backed behaviour (atomicity, replay, concurrency,
 * restore, RLS) is `tests/integration/commerce-loyalty-redemption.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LOYALTY_ENTRY_KINDS,
  isValidEntrySign
} from "../src/modules/commerce/domain/loyalty";
import {
  soonestExpiryConsumedBy,
  type ReplayEntry
} from "../src/modules/commerce/domain/loyalty-lots";
import {
  computeRedemptionDiscount,
  goodsBasisCents,
  LOYALTY_REDEMPTION_ERROR_CODES,
  pointsToHaveRestored,
  readLoyaltyRedemptionInput,
  redemptionLimitCents,
  validateRedemptionSettingsInput
} from "../src/modules/commerce/domain/loyalty-redemption";
import { classifyLoyaltyBucket } from "../src/modules/commerce/domain/operational-report-deltas";

describe("computeRedemptionDiscount", () => {
  const rate = { rupiahPerPoint: 100, maxGoodsPercent: null };

  test("is exactly points x rupiah-per-point, in integer cents", () => {
    const result = computeRedemptionDiscount(250, rate, 10_000_000n);
    expect(result).toEqual({
      ok: true,
      discountCents: 2_500_000n,
      discount: "25000.00"
    });
  });

  test("never exceeds the goods: one point over is refused with the largest number that fits", () => {
    // goods Rp 1 000.00 = 100 000 cents; each point is 10 000 cents.
    const over = computeRedemptionDiscount(11, rate, 100_000n);
    expect(over).toEqual({ ok: false, reason: "goods", maxPoints: 10 });
    expect(computeRedemptionDiscount(10, rate, 100_000n).ok).toBe(true);
  });

  test("honours the cap as a share of the goods subtotal, rounding the cap DOWN", () => {
    const capped = { rupiahPerPoint: 1, maxGoodsPercent: 33 };
    // 33 % of Rp 100.01 (10 001 cents) = 3 300.33 cents -> 3 300 cents = Rp 33 = 33 points.
    expect(redemptionLimitCents(10_001n, capped)).toEqual({
      limitCents: 3_300n,
      binding: "cap"
    });
    expect(computeRedemptionDiscount(33, capped, 10_001n).ok).toBe(true);
    expect(computeRedemptionDiscount(34, capped, 10_001n)).toEqual({
      ok: false,
      reason: "cap",
      maxPoints: 33
    });
  });

  test("a 100 % cap is the goods bound, not a second one", () => {
    expect(
      redemptionLimitCents(5_000n, { rupiahPerPoint: 1, maxGoodsPercent: 100 })
    ).toEqual({ limitCents: 5_000n, binding: "goods" });
  });

  test("a rate that is not a whole rupiah, or points that are not whole, are programming errors, not prices", () => {
    expect(() => computeRedemptionDiscount(1.5, rate, 1_000_000n)).toThrow();
    expect(() => computeRedemptionDiscount(0, rate, 1_000_000n)).toThrow();
    expect(() => computeRedemptionDiscount(-3, rate, 1_000_000n)).toThrow();
    expect(() =>
      computeRedemptionDiscount(
        1,
        { rupiahPerPoint: 0.5, maxGoodsPercent: null },
        1n
      )
    ).toThrow();
    expect(() =>
      computeRedemptionDiscount(
        1,
        { rupiahPerPoint: 0, maxGoodsPercent: null },
        1n
      )
    ).toThrow();
  });

  test("no goods, no discount: any points against a zero basis are refused", () => {
    expect(computeRedemptionDiscount(1, rate, 0n)).toEqual({
      ok: false,
      reason: "goods",
      maxPoints: 0
    });
  });

  test("large figures stay exact (bigint), where a float would drift", () => {
    const big = computeRedemptionDiscount(
      999_999_999,
      { rupiahPerPoint: 999_999, maxGoodsPercent: null },
      10n ** 17n
    );
    expect(big.ok).toBe(true);
    if (big.ok) {
      expect(big.discountCents).toBe(999_999_999n * 999_999n * 100n);
    }
  });
});

describe("goodsBasisCents", () => {
  test("is the subtotal less the voucher discount, floored at zero - shipping, insurance and tax never enter", () => {
    expect(goodsBasisCents("20000.00", "0.00")).toBe(2_000_000n);
    expect(goodsBasisCents("20000.00", "5000.00")).toBe(1_500_000n);
    expect(goodsBasisCents("1000.00", "5000.00")).toBe(0n);
  });
});

describe("pointsToHaveRestored", () => {
  test("is proportional to the cash refunded and exact at 100 %", () => {
    expect(pointsToHaveRestored(5000, 300_000n, 1_200_000n)).toBe(1250);
    expect(pointsToHaveRestored(5000, 600_000n, 1_200_000n)).toBe(2500);
    expect(pointsToHaveRestored(5000, 1_200_000n, 1_200_000n)).toBe(5000);
    // More than the total (cannot happen, but must not mint points).
    expect(pointsToHaveRestored(5000, 9_000_000n, 1_200_000n)).toBe(5000);
  });

  test("floors, so partial refunds can never restore more than was spent", () => {
    expect(pointsToHaveRestored(7, 1n, 3n)).toBe(2); // floor(7/3)
    expect(pointsToHaveRestored(7, 2n, 3n)).toBe(4); // floor(14/3)
    expect(pointsToHaveRestored(7, 3n, 3n)).toBe(7);
  });

  test("restores nothing for nothing refunded, nothing spent, or nothing paid", () => {
    expect(pointsToHaveRestored(0, 100n, 200n)).toBe(0);
    expect(pointsToHaveRestored(10, 0n, 200n)).toBe(0);
    expect(pointsToHaveRestored(10, 100n, 0n)).toBe(0);
  });
});

describe("readLoyaltyRedemptionInput (the one figure a client sends)", () => {
  test("absent or null means no redemption", () => {
    expect(readLoyaltyRedemptionInput(undefined)).toEqual({
      ok: true,
      points: null
    });
    expect(readLoyaltyRedemptionInput(null)).toEqual({
      ok: true,
      points: null
    });
  });

  test("accepts exactly { points: <positive whole number> }", () => {
    expect(readLoyaltyRedemptionInput({ points: 25 })).toEqual({
      ok: true,
      points: 25
    });
  });

  test("refuses every other key by name - a discount, a rate, a total, an account", () => {
    for (const key of [
      "discount",
      "amount",
      "rate",
      "rupiahPerPoint",
      "total",
      "accountId",
      "customerId",
      "ledgerEntryId"
    ]) {
      const result = readLoyaltyRedemptionInput({ points: 5, [key]: "x" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => e.field === `loyaltyRedemption.${key}`)
        ).toBe(true);
      }
    }
  });

  test("refuses fractional, zero, negative, string, boolean, NaN and unsafe points", () => {
    for (const points of [
      0,
      -1,
      1.5,
      "10",
      true,
      null,
      Number.NaN,
      Infinity,
      2 ** 60
    ]) {
      expect(readLoyaltyRedemptionInput({ points }).ok).toBe(false);
    }
    expect(readLoyaltyRedemptionInput({}).ok).toBe(false);
    expect(readLoyaltyRedemptionInput([]).ok).toBe(false);
    expect(readLoyaltyRedemptionInput("5").ok).toBe(false);
  });
});

describe("validateRedemptionSettingsInput", () => {
  test("a whole rupiah rate and an optional whole-percent cap", () => {
    expect(validateRedemptionSettingsInput({ rupiahPerPoint: 100 })).toEqual({
      valid: true,
      value: { rupiahPerPoint: 100, maxGoodsPercent: null }
    });
    expect(
      validateRedemptionSettingsInput({
        rupiahPerPoint: 50,
        maxGoodsPercent: 30
      })
    ).toEqual({
      valid: true,
      value: { rupiahPerPoint: 50, maxGoodsPercent: 30 }
    });
  });

  test("there is no default: a missing, fractional, zero or oversized rate is refused", () => {
    for (const body of [
      {},
      { rupiahPerPoint: 0 },
      { rupiahPerPoint: 0.5 },
      { rupiahPerPoint: -1 },
      { rupiahPerPoint: "100" },
      { rupiahPerPoint: 1_000_001 },
      null,
      []
    ]) {
      expect(validateRedemptionSettingsInput(body).valid).toBe(false);
    }
  });

  test("a cap outside 1..100 or fractional is refused, and unknown keys are refused", () => {
    for (const maxGoodsPercent of [0, 101, 33.3, "30"]) {
      expect(
        validateRedemptionSettingsInput({ rupiahPerPoint: 1, maxGoodsPercent })
          .valid
      ).toBe(false);
    }
    expect(
      validateRedemptionSettingsInput({ rupiahPerPoint: 1, defaultRate: 1 })
        .valid
    ).toBe(false);
  });
});

describe("the restore ledger kind", () => {
  test("is a known kind with a strictly positive sign", () => {
    expect(LOYALTY_ENTRY_KINDS).toContain("restore");
    expect(isValidEntrySign("restore", 10)).toBe(true);
    expect(isValidEntrySign("restore", 0)).toBe(false);
    expect(isValidEntrySign("restore", -10)).toBe(false);
  });

  test("reads in the 'reversed up' operational-report bucket, so no projection silently drops it", () => {
    expect(classifyLoyaltyBucket("restore", 10n)).toBe("reversal_up");
    expect(classifyLoyaltyBucket("restore", 0n)).toBeNull();
  });
});

describe("soonestExpiryConsumedBy", () => {
  const day = 86_400_000;
  const t0 = Date.parse("2026-10-01T00:00:00.000Z");
  const earn = (
    id: string,
    seq: number,
    points: number,
    expiresInDays: number | null
  ): ReplayEntry => ({
    id,
    accountSeq: seq,
    kind: "earn",
    points,
    createdAt: new Date(t0).toISOString(),
    expiresAt:
      expiresInDays === null
        ? null
        : new Date(t0 + expiresInDays * day).toISOString(),
    reversesEntryId: null,
    sourceId: null
  });

  test("a spend takes the earliest-expiring lot first, so that is the expiry it reports", () => {
    const entries = [
      earn("a", 1, 100, 30),
      earn("b", 2, 100, 10),
      earn("c", 3, 100, null)
    ];
    expect(soonestExpiryConsumedBy(entries, 50, t0)?.getTime()).toBe(
      t0 + 10 * day
    );
  });

  test("a spend that spills into several lots reports the soonest of them", () => {
    const entries = [
      earn("a", 1, 100, 30),
      earn("b", 2, 100, 10),
      earn("c", 3, 100, null)
    ];
    expect(soonestExpiryConsumedBy(entries, 150, t0)?.getTime()).toBe(
      t0 + 10 * day
    );
  });

  test("spending only permanent points reports no expiry", () => {
    const entries = [earn("a", 1, 100, null), earn("b", 2, 100, 10)];
    // 'b' expires first, so it is consumed first - pin the other direction too:
    const permanentOnly = [earn("a", 1, 100, null)];
    expect(soonestExpiryConsumedBy(permanentOnly, 40, t0)).toBeNull();
    expect(soonestExpiryConsumedBy(entries, 40, t0)?.getTime()).toBe(
      t0 + 10 * day
    );
  });

  test("skips a lot that had already lapsed when the spend is made", () => {
    const entries = [earn("a", 1, 100, 1), earn("b", 2, 100, null)];
    expect(soonestExpiryConsumedBy(entries, 40, t0 + 2 * day)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Structural: the places a redemption is wired stay safe
// ---------------------------------------------------------------------------

const CMS = path.resolve(import.meta.dir, "..");
const read = (relative: string): string =>
  readFileSync(path.join(CMS, relative), "utf8");

describe("the wiring", () => {
  test("every refusal code is a distinct, stable string", () => {
    const codes = Object.values(LOYALTY_REDEMPTION_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain("LOYALTY_REDEMPTION_UNAVAILABLE");
    expect(codes).toContain("LOYALTY_REDEMPTION_DEPOSIT_CONFLICT");
    expect(codes).toContain("INSUFFICIENT_POINTS");
  });

  test("the POS route demands the separate redemption permission, not the adjustment one, when the body asks to redeem", () => {
    const route = read("src/pages/api/v1/commerce/pos/orders/index.ts");
    expect(route).toContain("COMMERCE_LOYALTY_REDEMPTIONS_ACTIVITY_CODE");
    expect(route).not.toContain("LOYALTY_ADJUSTMENTS");
    expect(route).toContain("prepared.loyaltyRedemption");
    expect(route).toContain("authorizeInTransaction");
  });

  test("the storefront order route passes the account ONLY from the verified session and reads no account id", () => {
    const route = read("src/pages/api/v1/commerce/storefront/orders/index.ts");
    expect(route).toContain("authOutcome.account.customerId");
    expect(route).not.toMatch(/validation\.value\.(accountId|customerId)/);
    const validation = read(
      "src/modules/commerce/domain/order-request-validation.ts"
    );
    expect(validation).not.toMatch(/record\.(accountId|loyaltyAccountId)/);
  });

  test("the settings route reads under loyalty.read and changes under loyalty.manage only", () => {
    const route = read(
      "src/pages/api/v1/commerce/loyalty/redemption-settings.ts"
    );
    expect(route).toContain('action: "read"');
    expect(route).toContain('action: "manage"');
    expect(route).not.toContain("loyalty_adjustments");
  });

  test("the redemption module writes the ledger only through appendLedgerEntry", () => {
    const source = read(
      "src/modules/commerce/application/loyalty-redemption.ts"
    );
    expect(source).toContain("appendLedgerEntry");
    expect(source).not.toMatch(/INSERT INTO awcms_commerce_loyalty_ledger/);
    expect(source).not.toMatch(/UPDATE awcms_commerce_loyalty_accounts/);
  });

  test("cancellation and expiry both restore, and the refund path restores, inside the same transaction", () => {
    const orders = read("src/modules/commerce/application/order-directory.ts");
    expect(orders.match(/restoreRedemptionForOrder\(/g)?.length).toBe(2);
    const refunds = read(
      "src/modules/commerce/application/refund-settlement.ts"
    );
    expect(refunds).toContain("restoreRedemptionForRefund");
  });

  test("a redemption is prepared (and may be refused) BEFORE the order row is inserted, and committed AFTER", () => {
    const orders = read("src/modules/commerce/application/order-directory.ts");
    const prepare = orders.indexOf("await prepareRedemption(");
    const insert = orders.indexOf("await insertOrderWithRetryableCode(");
    const commit = orders.indexOf("await commitRedemption(");
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(insert);
    expect(commit).toBeGreaterThan(insert);

    const pos = read("src/modules/commerce/application/pos-directory.ts");
    expect(pos.indexOf("await prepareRedemption(")).toBeLessThan(
      pos.indexOf("INSERT INTO awcms_commerce_orders")
    );
    expect(pos.indexOf("await commitRedemption(")).toBeGreaterThan(
      pos.indexOf("INSERT INTO awcms_commerce_orders")
    );
  });
});
