/**
 * `commerce/domain/customer-session-token.ts` unit tests (Issue #87, C1).
 * Pure — no database, no network.
 */
import { describe, expect, test } from "bun:test";

import {
  CUSTOMER_SESSION_TOKEN_PREFIX,
  CUSTOMER_SESSION_TTL_SECONDS,
  generateCustomerSessionToken,
  hashCustomerSessionToken,
  looksLikeCustomerSessionToken
} from "../src/modules/commerce/domain/customer-session-token";

describe("generateCustomerSessionToken", () => {
  test("starts with cs_ and is unique across calls", () => {
    const a = generateCustomerSessionToken();
    const b = generateCustomerSessionToken();
    expect(a).toStartWith(CUSTOMER_SESSION_TOKEN_PREFIX);
    expect(a).not.toBe(b);
  });

  test("shape matches looksLikeCustomerSessionToken", () => {
    const token = generateCustomerSessionToken();
    expect(looksLikeCustomerSessionToken(token)).toBe(true);
  });
});

describe("hashCustomerSessionToken", () => {
  test("is sha256:-prefixed and deterministic", () => {
    const token = generateCustomerSessionToken();
    const hash1 = hashCustomerSessionToken(token);
    const hash2 = hashCustomerSessionToken(token);
    expect(hash1).toStartWith("sha256:");
    expect(hash1).toHaveLength("sha256:".length + 64);
    expect(hash1).toBe(hash2);
  });

  test("different tokens hash differently", () => {
    const a = hashCustomerSessionToken(generateCustomerSessionToken());
    const b = hashCustomerSessionToken(generateCustomerSessionToken());
    expect(a).not.toBe(b);
  });
});

describe("looksLikeCustomerSessionToken", () => {
  test("rejects wrong prefix, wrong length, and non-strings", () => {
    expect(looksLikeCustomerSessionToken("mc_" + "a".repeat(43))).toBe(false);
    expect(looksLikeCustomerSessionToken("cs_tooshort")).toBe(false);
    expect(looksLikeCustomerSessionToken(undefined)).toBe(false);
    expect(looksLikeCustomerSessionToken(12345)).toBe(false);
  });

  test("accepts a well-formed generated token", () => {
    expect(looksLikeCustomerSessionToken(generateCustomerSessionToken())).toBe(
      true
    );
  });
});

describe("CUSTOMER_SESSION_TTL_SECONDS", () => {
  test("is 30 days (ADR-0016 D3)", () => {
    expect(CUSTOMER_SESSION_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});
