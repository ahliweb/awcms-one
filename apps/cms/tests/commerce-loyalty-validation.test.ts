/**
 * Loyalty request validation (Issue #289) — pure unit tests.
 */
import { describe, expect, test } from "bun:test";

import {
  validateAdjustInput,
  validateCreateLoyaltyProgram,
  validateIdempotencyKeyHeader,
  validateLoyaltyProgramPatch,
  validateRedeemInput
} from "../src/modules/commerce/domain/loyalty-validation";

describe("validateCreateLoyaltyProgram", () => {
  const valid = {
    name: "  Poin Setia ",
    earnUnitAmount: "10000",
    earnPointsPerUnit: 1
  };

  test("normalises a valid body and applies the defaults", () => {
    const result = validateCreateLoyaltyProgram(valid);
    expect(result).toEqual({
      valid: true,
      value: {
        name: "Poin Setia",
        earnUnitAmount: "10000.00",
        earnPointsPerUnit: 1,
        minOrderAmount: "0.00",
        maxPointsPerOrder: null,
        expiryDays: null,
        notes: null
      }
    });
  });

  test("money must be an exact decimal string — never a number", () => {
    const result = validateCreateLoyaltyProgram({
      ...valid,
      earnUnitAmount: 10000
    });
    expect(result.valid).toBe(false);
  });

  test("a zero or negative unit amount is rejected", () => {
    expect(
      validateCreateLoyaltyProgram({ ...valid, earnUnitAmount: "0.00" }).valid
    ).toBe(false);
    expect(
      validateCreateLoyaltyProgram({ ...valid, earnUnitAmount: "-5" }).valid
    ).toBe(false);
  });

  test("points per unit must be an integer in range (a float is rejected)", () => {
    expect(
      validateCreateLoyaltyProgram({ ...valid, earnPointsPerUnit: 1.5 }).valid
    ).toBe(false);
    expect(
      validateCreateLoyaltyProgram({ ...valid, earnPointsPerUnit: 0 }).valid
    ).toBe(false);
    expect(
      validateCreateLoyaltyProgram({ ...valid, earnPointsPerUnit: 1_000_001 })
        .valid
    ).toBe(false);
  });

  test("expiry days is bounded and optional", () => {
    expect(
      validateCreateLoyaltyProgram({ ...valid, expiryDays: 365 }).valid
    ).toBe(true);
    expect(
      validateCreateLoyaltyProgram({ ...valid, expiryDays: 0 }).valid
    ).toBe(false);
    expect(
      validateCreateLoyaltyProgram({ ...valid, expiryDays: 3651 }).valid
    ).toBe(false);
  });

  test("a non-object body is a single validation error", () => {
    expect(validateCreateLoyaltyProgram(null).valid).toBe(false);
    expect(validateCreateLoyaltyProgram([]).valid).toBe(false);
  });

  test("an empty name is rejected", () => {
    expect(validateCreateLoyaltyProgram({ ...valid, name: "  " }).valid).toBe(
      false
    );
  });
});

describe("validateLoyaltyProgramPatch", () => {
  test("accepts any non-empty subset", () => {
    expect(validateLoyaltyProgramPatch({ earnPointsPerUnit: 2 })).toEqual({
      valid: true,
      value: { earnPointsPerUnit: 2 }
    });
    expect(validateLoyaltyProgramPatch({ expiryDays: null })).toEqual({
      valid: true,
      value: { expiryDays: null }
    });
  });

  test("an empty patch is rejected", () => {
    expect(validateLoyaltyProgramPatch({}).valid).toBe(false);
  });
});

describe("validateRedeemInput / validateAdjustInput", () => {
  test("redeem takes a positive integer count", () => {
    expect(validateRedeemInput({ points: 50 })).toEqual({
      valid: true,
      value: { points: 50, reason: null }
    });
    expect(validateRedeemInput({ points: 0 }).valid).toBe(false);
    expect(validateRedeemInput({ points: -5 }).valid).toBe(false);
    expect(validateRedeemInput({ points: 2.5 }).valid).toBe(false);
    expect(validateRedeemInput({ points: "10" }).valid).toBe(false);
  });

  test("adjust requires a non-zero signed integer AND a reason", () => {
    expect(validateAdjustInput({ points: -10, reason: "correction" })).toEqual({
      valid: true,
      value: { points: -10, reason: "correction" }
    });
    expect(validateAdjustInput({ points: 10 }).valid).toBe(false);
    expect(validateAdjustInput({ points: 10, reason: "   " }).valid).toBe(
      false
    );
    expect(validateAdjustInput({ points: 0, reason: "x" }).valid).toBe(false);
    expect(validateAdjustInput({ points: 1.2, reason: "x" }).valid).toBe(false);
  });

  test("a reason longer than 500 characters is rejected", () => {
    expect(
      validateAdjustInput({ points: 1, reason: "x".repeat(501) }).valid
    ).toBe(false);
  });
});

describe("validateIdempotencyKeyHeader", () => {
  test("is required", () => {
    expect(validateIdempotencyKeyHeader(null).valid).toBe(false);
    expect(validateIdempotencyKeyHeader("   ").valid).toBe(false);
  });

  test("accepts a UUID and trims", () => {
    expect(
      validateIdempotencyKeyHeader(" 3f2504e0-4f89-11d3-9a0c-0305e82c3301 ")
    ).toEqual({ valid: true, value: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" });
  });

  test("rejects characters outside the conservative alphabet and over-long keys", () => {
    expect(validateIdempotencyKeyHeader("a b").valid).toBe(false);
    expect(validateIdempotencyKeyHeader("a/b").valid).toBe(false);
    expect(validateIdempotencyKeyHeader("k".repeat(129)).valid).toBe(false);
  });
});
