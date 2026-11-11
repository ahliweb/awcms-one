/**
 * Pure parts of the optional `Idempotency-Key` contract of the mutating
 * storefront endpoints (Issue #513, work unit C): key shape, per-route scopes,
 * the key hash / request digest (what binds a key to an account and a target),
 * the HTTP edge (a malformed header is answered before any database work), and
 * the route wiring - above all that EVERY keyed route lists `idempotency-key` in
 * its preflight (a browser blocks the header otherwise) without a `*` or an
 * allow-credentials header.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import {
  commerceIdempotentPreflightHeaders,
  commercePreflightHeaders
} from "../src/modules/commerce/domain/commerce-cors";
import {
  parseStorefrontIdempotencyKey,
  STOREFRONT_IDEMPOTENCY_SCOPES,
  STOREFRONT_IDEMPOTENCY_TTL_SECONDS,
  storefrontDigestsEqual
} from "../src/modules/commerce/domain/storefront-idempotency";
import {
  computeStorefrontRequestDigest,
  hashStorefrontIdempotencyKey
} from "../src/modules/commerce/application/storefront-idempotency";
import { readStorefrontIdempotencyKey } from "../src/modules/commerce/application/storefront-idempotency-http";

const ROUTES = [
  "account/addresses/index.ts",
  "account/conversations/index.ts",
  "account/conversations/[id]/messages.ts",
  "orders/[orderCode]/payment-confirmations.ts",
  "orders/[orderCode]/cancel.ts",
  "reviews/index.ts"
] as const;

const SCOPE = STOREFRONT_IDEMPOTENCY_SCOPES.orderCancel;

describe("parseStorefrontIdempotencyKey", () => {
  test("absent, valid and invalid shapes (the shape unit B fixed)", () => {
    expect(parseStorefrontIdempotencyKey(null)).toEqual({ kind: "absent" });
    const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(parseStorefrontIdempotencyKey(uuid)).toEqual({
      kind: "valid",
      key: uuid
    });
    for (const bad of [
      "",
      "short",
      "a".repeat(15),
      "a".repeat(129),
      "with space 0123456789",
      "emoji-0123456789abcd\u{1F600}",
      " attempt-0123456789abcdef"
    ]) {
      expect(parseStorefrontIdempotencyKey(bad)).toEqual({ kind: "invalid" });
    }
    expect(parseStorefrontIdempotencyKey("a".repeat(16)).kind).toBe("valid");
    expect(parseStorefrontIdempotencyKey("a".repeat(128)).kind).toBe("valid");
  });
});

describe("scopes and window", () => {
  test("one distinct scope per route, all under the commerce.storefront namespace", () => {
    const scopes = Object.values(STOREFRONT_IDEMPOTENCY_SCOPES);
    expect(scopes).toHaveLength(6);
    expect(new Set(scopes).size).toBe(6);
    for (const scope of scopes) {
      expect(scope).toMatch(/^commerce\.storefront\.[a-z_]+$/);
    }
  });

  test("the replay window is bounded (a key left in a browser is of no use the next day)", () => {
    expect(STOREFRONT_IDEMPOTENCY_TTL_SECONDS).toBeGreaterThanOrEqual(600);
    expect(STOREFRONT_IDEMPOTENCY_TTL_SECONDS).toBeLessThanOrEqual(86400);
  });
});

describe("key hash and request digest", () => {
  const KEY = "attempt-0123456789abcdef-A";

  test("the stored key is an HMAC (64 hex), never the key", () => {
    const hash = hashStorefrontIdempotencyKey(SCOPE, null, KEY);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(KEY);
  });

  test("the key hash is bound to the scope and to the account", () => {
    const base = hashStorefrontIdempotencyKey(SCOPE, "acct-1", KEY);
    expect(hashStorefrontIdempotencyKey(SCOPE, "acct-1", KEY)).toBe(base);
    expect(hashStorefrontIdempotencyKey(SCOPE, "acct-2", KEY)).not.toBe(base);
    expect(hashStorefrontIdempotencyKey(SCOPE, null, KEY)).not.toBe(base);
    expect(
      hashStorefrontIdempotencyKey(
        STOREFRONT_IDEMPOTENCY_SCOPES.reviewCreate,
        "acct-1",
        KEY
      )
    ).not.toBe(base);
  });

  test("the digest covers everything that identifies the target (order code, phone, reason) and ignores key order", () => {
    const base = computeStorefrontRequestDigest(SCOPE, null, {
      orderCode: "ORD-1",
      phone: "+6281200000001",
      reason: null
    });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(
      computeStorefrontRequestDigest(SCOPE, null, {
        reason: null,
        phone: "+6281200000001",
        orderCode: "ORD-1"
      })
    ).toBe(base);
    for (const changed of [
      { orderCode: "ORD-2", phone: "+6281200000001", reason: null },
      { orderCode: "ORD-1", phone: "+6281200000002", reason: null },
      { orderCode: "ORD-1", phone: "+6281200000001", reason: "x" }
    ]) {
      expect(computeStorefrontRequestDigest(SCOPE, null, changed)).not.toBe(
        base
      );
    }
    expect(
      computeStorefrontRequestDigest(
        STOREFRONT_IDEMPOTENCY_SCOPES.reviewCreate,
        null,
        { orderCode: "ORD-1", phone: "+6281200000001", reason: null }
      )
    ).not.toBe(base);
  });

  test("digests compare in constant time and unequal lengths are simply unequal", () => {
    const a = computeStorefrontRequestDigest(SCOPE, null, { a: 1 });
    expect(storefrontDigestsEqual(a, a)).toBe(true);
    expect(
      storefrontDigestsEqual(
        a,
        computeStorefrontRequestDigest(SCOPE, null, { a: 2 })
      )
    ).toBe(false);
    expect(storefrontDigestsEqual(a, a.slice(1))).toBe(false);
  });
});

describe("readStorefrontIdempotencyKey (HTTP edge)", () => {
  const req = (value?: string) =>
    new Request("https://shop.example.test/x", {
      method: "POST",
      headers: value === undefined ? {} : { "idempotency-key": value }
    });

  test("no header is no key; a valid header is the key", () => {
    expect(readStorefrontIdempotencyKey(req())).toEqual({ key: null });
    expect(
      readStorefrontIdempotencyKey(req("attempt-0123456789abcdef"))
    ).toEqual({ key: "attempt-0123456789abcdef" });
  });

  test("a malformed header is 400 IDEMPOTENCY_KEY_INVALID (the code otp/verify uses), never ignored", async () => {
    const outcome = readStorefrontIdempotencyKey(req("nope"));
    if (!("response" in outcome)) throw new Error("expected a response");
    expect(outcome.response.status).toBe(400);
    const body = (await outcome.response.json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_INVALID");
  });
});

describe("route wiring", () => {
  const read = (route: string) =>
    readFile(`src/pages/api/v1/commerce/storefront/${route}`, "utf8");

  test("every keyed route lists idempotency-key in its preflight through the shared helper", async () => {
    for (const route of ROUTES) {
      const source = await read(route);
      expect(source).toContain("commerceIdempotentPreflightHeaders");
      expect(source).toContain("readStorefrontIdempotencyKey");
      expect(source).toContain("storefrontIdempotencyConflictResponse");
      // The string is never typed by hand (so the list cannot drift).
      expect(source).not.toMatch(/\[[^\]]*"idempotency-key"[^\]]*\]/);
      // The OPTIONS handler passes the idempotent list, not the default.
      const options = source.slice(source.indexOf("export const OPTIONS"));
      expect(options).toMatch(
        /commerceIdempotentPreflightHeaders\(|PREFLIGHT_ALLOWED_HEADERS/
      );
    }
  });

  test("the preflight list answers the header without * or credentials", () => {
    for (const base of [
      ["content-type"],
      ["content-type", "authorization"]
    ] as const) {
      const list = commerceIdempotentPreflightHeaders(base);
      expect(list).toContain("idempotency-key");
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
    }
  });

  test("cancel and payment-confirmation preflight is no longer the default (content-type only) list", async () => {
    for (const route of [
      "orders/[orderCode]/cancel.ts",
      "orders/[orderCode]/payment-confirmations.ts"
    ]) {
      const source = await read(route);
      const options = source.slice(source.indexOf("export const OPTIONS"));
      expect(options).toContain(
        'commerceIdempotentPreflightHeaders(["content-type"])'
      );
    }
  });

  test("a replay is flagged in data.replayed, the place unit B and the booking routes use", async () => {
    for (const route of ROUTES) {
      const source = await read(route);
      expect(source).toContain("replayed: true");
    }
  });
});
