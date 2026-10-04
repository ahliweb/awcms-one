/**
 * Loyalty earn rule and program-version selection (Issue #289, ADR-0026) —
 * pure unit tests. The properties that matter: points are integers, rounding
 * is FLOOR, money never touches a float, and the version in force at an
 * instant is exactly one (or none).
 */
import { describe, expect, test } from "bun:test";

import {
  assertPoints,
  isValidEntrySign,
  MAX_LEDGER_POINTS
} from "../src/modules/commerce/domain/loyalty";
import {
  computeEarnPoints,
  computeEligibleSpendCents,
  computeExpiresAt,
  selectEffectiveProgram,
  type LoyaltyEarnRule
} from "../src/modules/commerce/domain/loyalty-earn";

const RULE: LoyaltyEarnRule = {
  earnUnitAmount: "10000.00",
  earnPointsPerUnit: 1,
  minOrderAmount: "0.00",
  maxPointsPerOrder: null
};

describe("computeEligibleSpendCents", () => {
  test("is subtotal minus voucher discount, in integer cents", () => {
    expect(
      computeEligibleSpendCents({ subtotal: "125000.50", discount: "5000.25" })
    ).toBe(12_000_025n);
  });

  test("never goes negative", () => {
    expect(
      computeEligibleSpendCents({ subtotal: "1000.00", discount: "5000.00" })
    ).toBe(0n);
  });

  test("does not lose a cent to a float (0.1 + 0.2 shaped inputs)", () => {
    expect(
      computeEligibleSpendCents({ subtotal: "0.30", discount: "0.10" })
    ).toBe(20n);
  });
});

describe("computeEarnPoints — floor, never round", () => {
  test("1 point per Rp 10,000, remainder dropped", () => {
    expect(
      computeEarnPoints(RULE, { subtotal: "99999.99", discount: "0.00" })
    ).toBe(9);
    expect(
      computeEarnPoints(RULE, { subtotal: "100000.00", discount: "0.00" })
    ).toBe(10);
    expect(
      computeEarnPoints(RULE, { subtotal: "9999.99", discount: "0.00" })
    ).toBe(0);
  });

  test("a rate above one multiplies WHOLE units only", () => {
    const rule = { ...RULE, earnPointsPerUnit: 3 };
    expect(
      computeEarnPoints(rule, { subtotal: "25000.00", discount: "0.00" })
    ).toBe(6);
  });

  test("the voucher discount reduces what earns", () => {
    expect(
      computeEarnPoints(RULE, { subtotal: "100000.00", discount: "30000.00" })
    ).toBe(7);
  });

  test("below the minimum order earns nothing, at it earns", () => {
    const rule = { ...RULE, minOrderAmount: "50000.00" };
    expect(
      computeEarnPoints(rule, { subtotal: "49999.99", discount: "0.00" })
    ).toBe(0);
    expect(
      computeEarnPoints(rule, { subtotal: "50000.00", discount: "0.00" })
    ).toBe(5);
  });

  test("the per-order cap applies", () => {
    const rule = { ...RULE, maxPointsPerOrder: 4 };
    expect(
      computeEarnPoints(rule, { subtotal: "1000000.00", discount: "0.00" })
    ).toBe(4);
  });

  test("a fractional unit amount works in cents", () => {
    const rule = { ...RULE, earnUnitAmount: "0.50", earnPointsPerUnit: 1 };
    expect(
      computeEarnPoints(rule, { subtotal: "2.49", discount: "0.00" })
    ).toBe(4);
  });

  test("the result is always a safe integer within the ledger bound", () => {
    const rule: LoyaltyEarnRule = {
      earnUnitAmount: "0.01",
      earnPointsPerUnit: 1_000_000,
      minOrderAmount: "0.00",
      maxPointsPerOrder: null
    };
    const points = computeEarnPoints(rule, {
      subtotal: "999999999999.99",
      discount: "0.00"
    });
    expect(Number.isSafeInteger(points)).toBe(true);
    expect(points).toBeLessThanOrEqual(MAX_LEDGER_POINTS);
  });

  test("zero spend earns zero, not an error", () => {
    expect(
      computeEarnPoints(RULE, { subtotal: "0.00", discount: "0.00" })
    ).toBe(0);
  });

  test("a property sweep: always an integer, never negative, monotonic in spend", () => {
    let previous = 0;
    for (let cents = 0; cents <= 2_000_000; cents += 7919) {
      const subtotal = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
      const points = computeEarnPoints(RULE, { subtotal, discount: "0.00" });
      expect(Number.isInteger(points)).toBe(true);
      expect(points).toBeGreaterThanOrEqual(0);
      expect(points).toBeGreaterThanOrEqual(previous);
      expect(points).toBe(Math.floor(cents / 1_000_000));
      previous = points;
    }
  });
});

describe("computeExpiresAt", () => {
  test("null expiry days never expires", () => {
    expect(computeExpiresAt(new Date("2026-10-01T00:00:00Z"), null)).toBeNull();
  });

  test("adds whole UTC days", () => {
    expect(
      computeExpiresAt(new Date("2026-10-01T10:30:00Z"), 30)?.toISOString()
    ).toBe("2026-10-31T10:30:00.000Z");
  });
});

describe("selectEffectiveProgram", () => {
  const programs = [
    {
      id: "v1",
      version: 1,
      status: "retired",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: "2026-06-01T00:00:00.000Z"
    },
    {
      id: "v2",
      version: 2,
      status: "active",
      effectiveFrom: "2026-06-01T00:00:00.000Z",
      effectiveTo: null
    },
    {
      id: "v3",
      version: 3,
      status: "draft",
      effectiveFrom: null,
      effectiveTo: null
    }
  ];

  test("picks the version whose window contains the instant", () => {
    expect(
      selectEffectiveProgram(programs, new Date("2026-03-01T00:00:00Z"))?.id
    ).toBe("v1");
    expect(
      selectEffectiveProgram(programs, new Date("2026-09-01T00:00:00Z"))?.id
    ).toBe("v2");
  });

  test("the window is half-open: effectiveTo is exclusive, effectiveFrom inclusive", () => {
    expect(
      selectEffectiveProgram(programs, new Date("2026-06-01T00:00:00.000Z"))?.id
    ).toBe("v2");
    expect(
      selectEffectiveProgram(programs, new Date("2026-05-31T23:59:59.999Z"))?.id
    ).toBe("v1");
  });

  test("before any version existed there is none", () => {
    expect(
      selectEffectiveProgram(programs, new Date("2025-12-31T23:59:59Z"))
    ).toBeNull();
  });

  test("a draft is never selected, however its window looks", () => {
    expect(
      selectEffectiveProgram(
        [
          {
            id: "d",
            version: 9,
            status: "draft",
            effectiveFrom: "2020-01-01T00:00:00.000Z",
            effectiveTo: null
          }
        ],
        new Date("2026-01-01T00:00:00Z")
      )
    ).toBeNull();
  });

  test("overlapping windows resolve to the highest version, deterministically", () => {
    const overlapping = [
      { ...programs[1]!, id: "a", version: 4 },
      { ...programs[1]!, id: "b", version: 5 }
    ];
    expect(
      selectEffectiveProgram(overlapping, new Date("2026-09-01T00:00:00Z"))?.id
    ).toBe("b");
  });
});

describe("assertPoints / isValidEntrySign", () => {
  test("accepts a safe integer, a numeric string and a bigint (the driver may return any)", () => {
    expect(assertPoints(5)).toBe(5);
    expect(assertPoints("-12")).toBe(-12);
    expect(assertPoints(40n)).toBe(40);
  });

  test("rejects floats, NaN, out-of-range and non-numbers", () => {
    expect(() => assertPoints(1.5)).toThrow(RangeError);
    expect(() => assertPoints(Number.NaN)).toThrow(RangeError);
    expect(() => assertPoints(MAX_LEDGER_POINTS + 1)).toThrow(RangeError);
    expect(() => assertPoints("abc")).toThrow(RangeError);
    expect(() => assertPoints(null)).toThrow(RangeError);
  });

  test("the per-kind sign rules mirror the SQL CHECK", () => {
    expect(isValidEntrySign("earn", 1)).toBe(true);
    expect(isValidEntrySign("earn", 0)).toBe(false);
    expect(isValidEntrySign("earn", -1)).toBe(false);
    expect(isValidEntrySign("redeem", -1)).toBe(true);
    expect(isValidEntrySign("redeem", 1)).toBe(false);
    expect(isValidEntrySign("expire", 0)).toBe(true);
    expect(isValidEntrySign("expire", -3)).toBe(true);
    expect(isValidEntrySign("expire", 3)).toBe(false);
    expect(isValidEntrySign("adjustment", 0)).toBe(false);
    expect(isValidEntrySign("adjustment", -9)).toBe(true);
    expect(isValidEntrySign("reversal", 0)).toBe(false);
    expect(isValidEntrySign("reversal", -9)).toBe(true);
    expect(isValidEntrySign("earn", 1.5)).toBe(false);
  });
});
