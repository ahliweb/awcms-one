/**
 * The pure helpers of the booking adapter's admin screens (Issue #385).
 * Asserts what the screens send: the POLICY, never a computed deposit, and a
 * specific message per server refusal code.
 */
import { describe, expect, test } from "bun:test";

import {
  buildDepositPolicyBody,
  isUuidText,
  newIdempotencyKey,
  pickRefusalMessage
} from "../src/lib/ui/commerce-booking-client";

describe("buildDepositPolicyBody", () => {
  test("full payment carries no amount", () => {
    expect(buildDepositPolicyBody("full", "30", "5")).toEqual({
      ok: true,
      body: { kind: "full" }
    });
  });

  test("percent accepts up to two decimals within 0 < p <= 100", () => {
    expect(buildDepositPolicyBody("percent", " 30.5 ", "")).toEqual({
      ok: true,
      body: { kind: "percent", percent: "30.5" }
    });
    expect(buildDepositPolicyBody("percent", "100", "").ok).toBe(true);
    for (const bad of ["", "0", "100.01", "101", "-5", "1.234", "abc"]) {
      expect(buildDepositPolicyBody("percent", bad, "")).toEqual({
        ok: false,
        field: "percent"
      });
    }
  });

  test("fixed accepts a positive amount with at most two decimals", () => {
    expect(buildDepositPolicyBody("fixed", "", "50000.00")).toEqual({
      ok: true,
      body: { kind: "fixed", fixedAmount: "50000.00" }
    });
    for (const bad of ["", "0", "0.00", "-1", "1.234", "1e3"]) {
      expect(buildDepositPolicyBody("fixed", "", bad)).toEqual({
        ok: false,
        field: "fixedAmount"
      });
    }
  });

  test("an unknown kind is refused and never produces a body", () => {
    expect(buildDepositPolicyBody("amount", "10", "10")).toEqual({
      ok: false,
      field: "kind"
    });
  });
});

describe("isUuidText", () => {
  test("accepts a canonical uuid and rejects anything else", () => {
    expect(isUuidText("0192f3a0-1b2c-4d5e-8f90-abcdef012345")).toBe(true);
    expect(isUuidText(" 0192f3a0-1b2c-4d5e-8f90-abcdef012345 ")).toBe(true);
    expect(isUuidText("not-a-uuid")).toBe(false);
    expect(isUuidText("")).toBe(false);
  });
});

describe("pickRefusalMessage", () => {
  const map = JSON.stringify({ PRODUCT_NOT_SERVICE: "service only" });
  test("returns the message for a known code", () => {
    expect(pickRefusalMessage(map, "PRODUCT_NOT_SERVICE", "generic")).toBe(
      "service only"
    );
  });
  test("falls back for an unknown code, a missing code or a bad map", () => {
    expect(pickRefusalMessage(map, "OTHER", "generic")).toBe("generic");
    expect(pickRefusalMessage(map, null, "generic")).toBe("generic");
    expect(pickRefusalMessage(undefined, "X", "generic")).toBe("generic");
    expect(pickRefusalMessage("{not json", "X", "generic")).toBe("generic");
  });
});

test("an idempotency key is a fresh uuid per attempt", () => {
  const a = newIdempotencyKey();
  expect(isUuidText(a)).toBe(true);
  expect(newIdempotencyKey()).not.toBe(a);
});
