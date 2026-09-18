/**
 * `commerce/domain/customer-otp.ts` unit tests (Issue #87, C1). Pure — no
 * database, no network.
 */
import { describe, expect, test } from "bun:test";

import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  generateOtpCode,
  hashOtpCode,
  isOtpExpired,
  verifyOtpCode
} from "../src/modules/commerce/domain/customer-otp";

describe("generateOtpCode", () => {
  test("is always exactly 6 digits, zero-padded", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  test("covers the low end of the range (leading zeros happen)", () => {
    // Statistically near-certain across 5000 draws (~0.5% chance per draw of
    // a leading zero); a flake here would mean generateOtpCode stopped using
    // the full 000000-999999 range.
    const codes = Array.from({ length: 5000 }, () => generateOtpCode());
    expect(codes.some((code) => code.startsWith("0"))).toBe(true);
  });
});

describe("hashOtpCode / verifyOtpCode", () => {
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const email = "budi@example.com";

  test("hash is sha256:-prefixed and deterministic for the same inputs", () => {
    const hash1 = hashOtpCode("123456", email, tenantId);
    const hash2 = hashOtpCode("123456", email, tenantId);
    expect(hash1).toStartWith("sha256:");
    expect(hash1).toHaveLength("sha256:".length + 64);
    expect(hash1).toBe(hash2);
  });

  test("different tenant or email salts to a different hash for the SAME code", () => {
    const base = hashOtpCode("123456", email, tenantId);
    const otherTenant = hashOtpCode(
      "123456",
      email,
      "22222222-2222-2222-2222-222222222222"
    );
    const otherEmail = hashOtpCode("123456", "lain@example.com", tenantId);
    expect(otherTenant).not.toBe(base);
    expect(otherEmail).not.toBe(base);
  });

  test("verifyOtpCode matches equal hashes and rejects different ones", () => {
    const hash = hashOtpCode("654321", email, tenantId);
    const sameHash = hashOtpCode("654321", email, tenantId);
    const wrongHash = hashOtpCode("000000", email, tenantId);

    expect(verifyOtpCode(hash, sameHash)).toBe(true);
    expect(verifyOtpCode(hash, wrongHash)).toBe(false);
  });

  test("verifyOtpCode is false (not throwing) for mismatched-length input", () => {
    expect(verifyOtpCode("short", "sha256:" + "a".repeat(64))).toBe(false);
  });
});

describe("isOtpExpired", () => {
  test("false before expiry, true at and after expiry", () => {
    const expiresAt = new Date("2026-09-19T10:10:00.000Z");
    expect(isOtpExpired(expiresAt, new Date("2026-09-19T10:09:59.999Z"))).toBe(
      false
    );
    expect(isOtpExpired(expiresAt, expiresAt)).toBe(true);
    expect(isOtpExpired(expiresAt, new Date("2026-09-19T10:10:00.001Z"))).toBe(
      true
    );
  });
});

describe("constants", () => {
  test("OTP_TTL_SECONDS is 10 minutes (ADR-0016 D2)", () => {
    expect(OTP_TTL_SECONDS).toBe(600);
  });

  test("OTP_MAX_ATTEMPTS is 5 (ADR-0016 D2)", () => {
    expect(OTP_MAX_ATTEMPTS).toBe(5);
  });
});
