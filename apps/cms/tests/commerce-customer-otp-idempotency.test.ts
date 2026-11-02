/**
 * Pure parts of the `otp/verify` idempotency contract (Issue #513): the key
 * shape, the request identity the digest is built from, the constant-time
 * compare, the resend window constant, and the route's header handling
 * (an invalid key is answered before any database work, so no DB is needed).
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import {
  deriveOtpVerifyIdentity,
  OTP_VERIFY_IDEMPOTENCY_TTL_SECONDS,
  otpVerifyDigestsEqual,
  parseOtpVerifyIdempotencyKey
} from "../src/modules/commerce/domain/customer-otp-idempotency";
import {
  OTP_RESEND_WINDOW_SECONDS,
  OTP_TTL_SECONDS
} from "../src/modules/commerce/domain/customer-otp";
import {
  computeOtpVerifyDigest,
  hashOtpVerifyIdempotencyKey
} from "../src/modules/commerce/application/customer-otp-verify-idempotency";

describe("parseOtpVerifyIdempotencyKey", () => {
  test("absent header is absent", () => {
    expect(parseOtpVerifyIdempotencyKey(null)).toEqual({ kind: "absent" });
  });

  test("accepts [A-Za-z0-9_-]{16,128}", () => {
    for (const key of [
      crypto.randomUUID(),
      "a".repeat(16),
      "A_b-C".repeat(25) + "xyz",
      "0123456789abcdef"
    ]) {
      expect(parseOtpVerifyIdempotencyKey(key)).toEqual({
        kind: "valid",
        key
      });
    }
    expect(parseOtpVerifyIdempotencyKey("a".repeat(128)).kind).toBe("valid");
  });

  test("refuses anything else - too short, too long, wrong alphabet, empty, padded", () => {
    for (const key of [
      "",
      "a".repeat(15),
      "a".repeat(129),
      "has space in the key....",
      "dots.are.not.allowed.here",
      "unicode-kunci-éééééé",
      " " + "a".repeat(16),
      "a".repeat(16) + "\n",
      "a".repeat(15) + "/"
    ]) {
      expect(parseOtpVerifyIdempotencyKey(key).kind).toBe("invalid");
    }
  });
});

describe("deriveOtpVerifyIdentity", () => {
  test("normalises an e-mail login/register identity", () => {
    expect(
      deriveOtpVerifyIdentity({
        email: "  Budi@Example.COM ",
        code: " 123456 ",
        purpose: "register"
      })
    ).toEqual({
      purpose: "register",
      identifierColumn: "email_normalized",
      identifierValue: "budi@example.com",
      code: "123456"
    });
  });

  test("a phone identity is login-only and normalised", () => {
    expect(
      deriveOtpVerifyIdentity({
        email: "",
        phone: "0812-3456-7890",
        code: "000001",
        purpose: "login"
      })
    ).toMatchObject({
      identifierColumn: "phone_normalized",
      identifierValue: "+6281234567890"
    });
    expect(
      deriveOtpVerifyIdentity({
        email: "",
        phone: "081234567890",
        code: "000001",
        purpose: "register"
      })
    ).toBeNull();
  });

  test("is null for everything the verifier answers with validation_error", () => {
    const ok = { email: "a@b.co", code: "123456", purpose: "login" };
    expect(deriveOtpVerifyIdentity(ok)).not.toBeNull();
    expect(deriveOtpVerifyIdentity({ ...ok, purpose: "x" })).toBeNull();
    expect(deriveOtpVerifyIdentity({ ...ok, code: "12345" })).toBeNull();
    expect(deriveOtpVerifyIdentity({ ...ok, code: 123456 })).toBeNull();
    expect(deriveOtpVerifyIdentity({ ...ok, email: "" })).toBeNull();
    expect(
      deriveOtpVerifyIdentity({ ...ok, email: "not-an-email" })
    ).toBeNull();
    expect(
      deriveOtpVerifyIdentity({ ...ok, phone: "081234567890" })
    ).toBeNull();
    expect(
      deriveOtpVerifyIdentity({
        email: "",
        phone: "123",
        code: "123456",
        purpose: "login"
      })
    ).toBeNull();
  });
});

describe("digests", () => {
  const identity = {
    purpose: "register" as const,
    identifierColumn: "email_normalized" as const,
    identifierValue: "budi@example.com",
    code: "123456"
  };

  test("the request digest is stable, 64 hex, and changes with every input", () => {
    const base = computeOtpVerifyDigest(identity);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(computeOtpVerifyDigest({ ...identity })).toBe(base);
    expect(computeOtpVerifyDigest({ ...identity, code: "654321" })).not.toBe(
      base
    );
    expect(
      computeOtpVerifyDigest({ ...identity, identifierValue: "x@example.com" })
    ).not.toBe(base);
    expect(computeOtpVerifyDigest({ ...identity, purpose: "login" })).not.toBe(
      base
    );
    expect(base).not.toContain("123456");
  });

  test("the stored key hash is a keyed digest of the key, never the key, and differs from the request digest family", () => {
    const key = "attempt-0123456789abcdef";
    const hash = hashOtpVerifyIdempotencyKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key);
    expect(hashOtpVerifyIdempotencyKey(key)).toBe(hash);
    expect(hashOtpVerifyIdempotencyKey(key + "x")).not.toBe(hash);
  });

  test("otpVerifyDigestsEqual is exact and length-safe", () => {
    const a = computeOtpVerifyDigest(identity);
    expect(otpVerifyDigestsEqual(a, a)).toBe(true);
    expect(
      otpVerifyDigestsEqual(
        a,
        computeOtpVerifyDigest({ ...identity, code: "1" })
      )
    ).toBe(false);
    expect(otpVerifyDigestsEqual(a, a.slice(1))).toBe(false);
    expect(otpVerifyDigestsEqual("", "")).toBe(true);
  });
});

describe("windows", () => {
  test("the replay window never outlives the code, the resend window is the storefront's 60 s", () => {
    expect(OTP_VERIFY_IDEMPOTENCY_TTL_SECONDS).toBeLessThanOrEqual(
      OTP_TTL_SECONDS
    );
    expect(OTP_RESEND_WINDOW_SECONDS).toBe(60);
  });
});

describe("the otp/verify route", () => {
  test("a malformed Idempotency-Key is 400 IDEMPOTENCY_KEY_INVALID before any database work", async () => {
    const { POST } =
      await import("../src/pages/api/v1/commerce/storefront/account/otp/verify");
    for (const key of ["short", "x".repeat(129), "with space in it ....."]) {
      const response = await POST({
        request: new Request(
          "https://shop.example.test/api/v1/commerce/storefront/account/otp/verify",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": key
            },
            body: JSON.stringify({
              email: "a@b.co",
              code: "123456",
              purpose: "login"
            })
          }
        ),
        clientAddress: "203.0.113.9",
        locals: {}
      } as never);
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string };
      };
      expect(body.error.code).toBe("IDEMPOTENCY_KEY_INVALID");
    }
  });

  test("the route threads the validated key, maps the conflict and the replay, and allows the header in preflight", async () => {
    const source = await readFile(
      "src/pages/api/v1/commerce/storefront/account/otp/verify.ts",
      "utf8"
    );
    expect(source).toContain("parseOtpVerifyIdempotencyKey");
    expect(source).toContain('"IDEMPOTENCY_CONFLICT"');
    expect(source).toContain("replayed: true");
    expect(source).toContain("commerceIdempotentPreflightHeaders");
  });

  test("preflight lists idempotency-key for both routes and never answers * or credentials", async () => {
    const { commerceIdempotentPreflightHeaders, commercePreflightHeaders } =
      await import("../src/modules/commerce/domain/commerce-cors");
    const list = commerceIdempotentPreflightHeaders(["content-type"]);
    expect(list).toEqual(["content-type", "idempotency-key"]);
    expect(commerceIdempotentPreflightHeaders(list)).toEqual(list);

    const headers = commercePreflightHeaders(
      { kind: "granted", origin: "https://shop.example.test" } as never,
      list
    );
    expect(headers["access-control-allow-headers"]).toContain(
      "idempotency-key"
    );
    expect(headers["access-control-allow-origin"]).toBe(
      "https://shop.example.test"
    );
    expect(JSON.stringify(headers)).not.toContain('"*"');
    expect(headers["access-control-allow-credentials"]).toBeUndefined();

    for (const route of ["verify", "request"]) {
      const source = await readFile(
        `src/pages/api/v1/commerce/storefront/account/otp/${route}.ts`,
        "utf8"
      );
      expect(source).toContain("commerceIdempotentPreflightHeaders");
      expect(source).not.toMatch(
        /PREFLIGHT_ALLOWED_HEADERS\s*=\s*\[[^\]]*idempotency-key/
      );
    }
  });

  test("otp/request ignores the header: no key plumbing, the resend window is its guard", async () => {
    const source = await readFile(
      "src/pages/api/v1/commerce/storefront/account/otp/request.ts",
      "utf8"
    );
    expect(source).not.toContain("idempotency");
  });
});
