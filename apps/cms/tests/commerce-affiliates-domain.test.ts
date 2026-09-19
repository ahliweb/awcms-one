/**
 * `commerce` affiliate-program domain tests (Issue #92, contract #86's D5).
 * Pure — no database, no network. Covers `domain/affiliate-code.ts` and
 * `domain/affiliate-commission.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
  AFFILIATE_CODE_ALPHABET,
  AFFILIATE_CODE_LENGTH,
  generateAffiliateCode,
  isAffiliateCodeShape
} from "../src/modules/commerce/domain/affiliate-code";
import {
  computeCommissionAmount,
  computeCommissionBase,
  shouldEarnCommission,
  validateCommissionRateInput
} from "../src/modules/commerce/domain/affiliate-commission";

describe("affiliate-code", () => {
  test("generates codes of the fixed length, from the unambiguous alphabet only", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateAffiliateCode();
      expect(code.length).toBe(AFFILIATE_CODE_LENGTH);
      for (const ch of code) {
        expect(AFFILIATE_CODE_ALPHABET.includes(ch)).toBe(true);
      }
      // No ambiguous characters ever appear.
      expect(code).not.toMatch(/[IO01]/);
    }
  });

  test("generateAffiliateCode is not trivially deterministic (CSPRNG, not a counter)", () => {
    const codes = new Set(
      Array.from({ length: 50 }, () => generateAffiliateCode())
    );
    // Collisions are astronomically unlikely at this sample size (32^8 space).
    expect(codes.size).toBe(50);
  });

  test("isAffiliateCodeShape accepts well-formed codes", () => {
    expect(isAffiliateCodeShape("ABCDEFGH")).toBe(true);
    expect(isAffiliateCodeShape("23456789")).toBe(true);
  });

  test("isAffiliateCodeShape rejects wrong length, ambiguous characters, and lowercase", () => {
    expect(isAffiliateCodeShape("ABCDEFG")).toBe(false); // 7 chars
    expect(isAffiliateCodeShape("ABCDEFGHI")).toBe(false); // 9 chars
    expect(isAffiliateCodeShape("ABCDEFGI")).toBe(false); // contains I
    expect(isAffiliateCodeShape("ABCDEFGO")).toBe(false); // contains O
    expect(isAffiliateCodeShape("ABCDEFG0")).toBe(false); // contains 0
    expect(isAffiliateCodeShape("ABCDEFG1")).toBe(false); // contains 1
    expect(isAffiliateCodeShape("abcdefgh")).toBe(false); // lowercase
    expect(isAffiliateCodeShape("")).toBe(false);
  });
});

describe("affiliate-commission — computeCommissionBase", () => {
  test("subtotal minus discount minus voucher discount", () => {
    expect(computeCommissionBase("100.00", "10.00", "5.00")).toBe("85.00");
  });

  test("floors at zero when discounts exceed the subtotal", () => {
    expect(computeCommissionBase("10.00", "8.00", "5.00")).toBe("0.00");
  });

  test("zero discounts leave the subtotal untouched", () => {
    expect(computeCommissionBase("250.50", "0.00", "0.00")).toBe("250.50");
  });
});

describe("affiliate-commission — computeCommissionAmount", () => {
  test("base * rate / 100, rounded half-up to the cent", () => {
    expect(computeCommissionAmount("1000.00", "10.00")).toBe("100.00");
    expect(computeCommissionAmount("3.33", "10.00")).toBe("0.33");
  });

  test("rounds 0.5 cents up", () => {
    // 1.00 at 12.5% = 0.125 -> rounds to 0.13 (half-up).
    expect(computeCommissionAmount("1.00", "12.50")).toBe("0.13");
  });

  test("zero base yields a zero commission", () => {
    expect(computeCommissionAmount("0.00", "50.00")).toBe("0.00");
  });

  test("100% rate returns the base unchanged", () => {
    expect(computeCommissionAmount("42.42", "100.00")).toBe("42.42");
  });
});

describe("affiliate-commission — shouldEarnCommission", () => {
  const base = {
    affiliateCustomerId: "affiliate-customer",
    orderCustomerId: "order-customer",
    affiliateStatus: "active" as const
  };

  test("true for an ordinary referral by an active affiliate", () => {
    expect(shouldEarnCommission(base)).toBe(true);
  });

  test("false on self-referral, even while active", () => {
    expect(
      shouldEarnCommission({
        ...base,
        orderCustomerId: base.affiliateCustomerId
      })
    ).toBe(false);
  });

  test("false for a suspended affiliate, even on a genuine referral", () => {
    expect(
      shouldEarnCommission({ ...base, affiliateStatus: "suspended" })
    ).toBe(false);
  });

  test("false when BOTH self-referral and suspended", () => {
    expect(
      shouldEarnCommission({
        affiliateCustomerId: "same",
        orderCustomerId: "same",
        affiliateStatus: "suspended"
      })
    ).toBe(false);
  });
});

describe("affiliate-commission — validateCommissionRateInput", () => {
  test("null/undefined is valid — means the program is off", () => {
    expect(validateCommissionRateInput(null)).toEqual({
      valid: true,
      value: null
    });
    expect(validateCommissionRateInput(undefined)).toEqual({
      valid: true,
      value: null
    });
  });

  test("accepts a well-formed decimal string, normalized to two places", () => {
    expect(validateCommissionRateInput("10")).toEqual({
      valid: true,
      value: "10.00"
    });
    expect(validateCommissionRateInput("10.5")).toEqual({
      valid: true,
      value: "10.50"
    });
    expect(validateCommissionRateInput("0")).toEqual({
      valid: true,
      value: "0.00"
    });
    expect(validateCommissionRateInput("100")).toEqual({
      valid: true,
      value: "100.00"
    });
  });

  test("accepts a number, formatted to two places", () => {
    expect(validateCommissionRateInput(12.5)).toEqual({
      valid: true,
      value: "12.50"
    });
  });

  test("rejects out-of-range values", () => {
    expect(validateCommissionRateInput("100.01").valid).toBe(false);
    expect(validateCommissionRateInput("-1").valid).toBe(false);
    expect(validateCommissionRateInput(101).valid).toBe(false);
  });

  test("rejects more than two decimal places or non-numeric strings", () => {
    expect(validateCommissionRateInput("10.123").valid).toBe(false);
    expect(validateCommissionRateInput("abc").valid).toBe(false);
    expect(validateCommissionRateInput(true).valid).toBe(false);
  });
});
