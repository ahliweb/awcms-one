/**
 * Customer Web Push - the pure rules (Issue #430, ADR-0048). No database, no
 * network. Named after the ADR's regression handles where one applies:
 *
 *   TS-U2  origin validation        (storefront origin: https, not the CMS origin)
 *   TS-U3  endpoint validation      (host allowlist, abuse cases)
 *   TS-U5  strict body schema       (no client-chosen principal or content)
 *   TS-U6  defaults are off
 *   TS-S1  static: the customer push files import no staff resolver, read no cookie
 *
 * Plus: the device cap and the rate-window arithmetic, the encryption round trip
 * with AAD purpose separation, the coarse user-agent description, and the
 * operator override of the host allowlist.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "../scripts/lib/source-text";

import {
  CUSTOMER_PUSH_CONSENT_TEXT_VERSION,
  CUSTOMER_PUSH_DAILY_NOTIFICATION_CAP,
  CUSTOMER_PUSH_HOURLY_NOTIFICATION_CAP,
  CUSTOMER_PUSH_MAX_DEVICES,
  CUSTOMER_PUSH_TARGET_PATHS,
  CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES,
  deviceCapAllows,
  evaluateNotificationCap,
  notificationWindowStarts,
  parsePreferencesBody,
  parseRegisterBodyShape,
  validateRegisterConsent
} from "../src/modules/commerce/domain/customer-push";
import {
  checkCustomerPushEndpoint,
  DEFAULT_PUSH_SERVICE_HOST_RULES,
  isPushHostAllowed,
  parseExtraPushHosts,
  resolvePushHostPolicy
} from "../src/modules/commerce/domain/customer-push-endpoint";
import {
  CUSTOMER_PUSH_AUTH_SECRET_PURPOSE,
  CUSTOMER_PUSH_ENDPOINT_PURPOSE,
  decryptCustomerPushAuthSecret,
  decryptCustomerPushEndpoint,
  encryptCustomerPushAuthSecret,
  encryptCustomerPushEndpoint
} from "../src/modules/commerce/domain/customer-push-secrets";
import { classifyUserAgent } from "../src/modules/commerce/domain/customer-push-user-agent";
import { DEFAULT_COMMERCE_FEATURES } from "../src/modules/commerce/domain/commerce-features";
import {
  buildCustomerPushCapability,
  resolvePushAvailability,
  resolveStorefrontOrigin
} from "../src/modules/commerce/application/customer-push-capability";
import {
  decryptPushAuthSecret,
  encryptPushAuthSecret,
  resolvePushAuthSecretRing
} from "../src/modules/push-delivery/domain/push-auth-secret";
import { FieldEncryptionError } from "../src/lib/security/field-encryption";
import { validateSubscriptionInput } from "../src/modules/push-delivery/domain/subscription-input";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

/** 65 and 16 random bytes, base64url: the key sizes the upstream validator enforces. */
const P256DH = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString(
  "base64url"
);
const AUTH = Buffer.alloc(16, 9).toString("base64url");
const FCM = "https://fcm.googleapis.com/fcm/send/abc:APA91bEXAMPLE";

function ringFrom(spec: string) {
  const ring = resolvePushAuthSecretRing({
    PUSH_AUTH_SECRET_ENCRYPTION_KEYS: spec
  } as NodeJS.ProcessEnv);
  if (!ring.ok) throw new Error(ring.reason);
  return ring;
}

// Random, because the ring refuses placeholder, short and constant keys.
const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const RING_A = ringFrom(`ka:${KEY_A}`);
const RING_AB = ringFrom(`kb:${KEY_B},ka:${KEY_A}`);

describe("defaults (TS-U6)", () => {
  test("the customerPush feature defaults OFF", () => {
    expect(DEFAULT_COMMERCE_FEATURES.customerPush).toBe(false);
  });

  test("the limits are the owner's decided values (ADR-0048 Q7)", () => {
    expect(CUSTOMER_PUSH_MAX_DEVICES).toBe(5);
    expect(CUSTOMER_PUSH_HOURLY_NOTIFICATION_CAP).toBe(12);
    expect(CUSTOMER_PUSH_DAILY_NOTIFICATION_CAP).toBe(40);
  });

  test("marketing is not a transactional purpose and has no click target", () => {
    expect(CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES).not.toContain("marketing");
    expect(Object.keys(CUSTOMER_PUSH_TARGET_PATHS).sort()).toEqual(
      [...CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES].sort()
    );
    for (const path of Object.values(CUSTOMER_PUSH_TARGET_PATHS)) {
      expect(path).toMatch(/^\/[a-z0-9][a-z0-9/_-]*$/);
      expect(path).not.toContain("//");
    }
  });
});

describe("device cap", () => {
  test("allows up to five active devices and refuses the sixth", () => {
    expect(deviceCapAllows(0)).toBe(true);
    expect(deviceCapAllows(4)).toBe(true);
    // `activeOthers` excludes the endpoint being registered: 5 others means the
    // newcomer would be the sixth.
    expect(deviceCapAllows(5)).toBe(false);
    expect(deviceCapAllows(9)).toBe(false);
  });
});

describe("notification rate-window math", () => {
  test("12 per rolling hour: the 13th is refused with the hourly reason", () => {
    expect(evaluateNotificationCap({ lastHour: 11, lastDay: 11 })).toEqual({
      allowed: true,
      reason: null
    });
    expect(evaluateNotificationCap({ lastHour: 12, lastDay: 12 })).toEqual({
      allowed: false,
      reason: "hourly_cap"
    });
  });

  test("40 per rolling day: the 41st is refused with the daily reason", () => {
    expect(evaluateNotificationCap({ lastHour: 3, lastDay: 39 })).toEqual({
      allowed: true,
      reason: null
    });
    expect(evaluateNotificationCap({ lastHour: 3, lastDay: 40 })).toEqual({
      allowed: false,
      reason: "daily_cap"
    });
  });

  test("the tighter window names the reason when both are exceeded", () => {
    expect(evaluateNotificationCap({ lastHour: 20, lastDay: 99 }).reason).toBe(
      "hourly_cap"
    );
  });

  test("custom caps are honoured (the constants are tunable without a schema change)", () => {
    expect(
      evaluateNotificationCap(
        { lastHour: 2, lastDay: 2 },
        { hourly: 2, daily: 10 }
      ).allowed
    ).toBe(false);
  });

  test("the windows start exactly one hour and one day before now", () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const { hourStart, dayStart } = notificationWindowStarts(now);
    expect(hourStart.toISOString()).toBe("2026-10-25T11:00:00.000Z");
    expect(dayStart.toISOString()).toBe("2026-10-24T12:00:00.000Z");
  });
});

describe("push-service host allowlist (TS-U3)", () => {
  test.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://web.push.apple.com/QGAAAA",
    "https://wns2-par02p.notify.windows.com/w/?token=abc"
  ])("accepts a vendor endpoint: %s", (endpoint) => {
    expect(checkCustomerPushEndpoint(endpoint).ok).toBe(true);
  });

  test.each([
    ["an unknown https host", "https://evil.example.com/push"],
    [
      "a vendor name as a subdomain of someone else's domain",
      "https://fcm.googleapis.com.evil.example/push"
    ],
    [
      "a vendor name as a prefix label",
      "https://evil-fcm.googleapis.com.attacker.test/x"
    ],
    [
      "a vendor name as a userinfo trick",
      "https://fcm.googleapis.com@evil.example/x"
    ],
    ["an http scheme", "http://fcm.googleapis.com/fcm/send/abc"],
    ["an explicit port", "https://fcm.googleapis.com:8443/fcm/send/abc"],
    ["userinfo", "https://user:pass@fcm.googleapis.com/fcm/send/abc"],
    ["a trailing-dot host", "https://fcm.googleapis.com./fcm/send/abc"],
    ["a private IPv4 literal", "https://10.0.0.5/push"],
    ["a loopback literal", "https://127.0.0.1/push"],
    ["an IPv6 literal", "https://[::1]/push"],
    ["a cloud metadata address", "https://169.254.169.254/latest/meta-data"],
    ["localhost", "https://localhost/push"],
    [
      "a bare suffix without the label dot",
      "https://evilnotify.windows.com.attacker.test/x"
    ],
    ["a different parent of the suffix", "https://notify.windows.com/x"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/plain,hi"],
    ["not a URL", "not a url"],
    ["an empty string", ""]
  ])("refuses %s", (_label, endpoint) => {
    expect(checkCustomerPushEndpoint(endpoint).ok).toBe(false);
  });

  test("the refusal message never echoes the caller's host", () => {
    const result = checkCustomerPushEndpoint("https://evil.example.com/push");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("evil");
    }
  });

  test("the case of the host does not matter (the URL parser normalises it)", () => {
    expect(
      checkCustomerPushEndpoint("https://FCM.GoogleAPIs.com/fcm/x").ok
    ).toBe(true);
  });

  test("the default policy is exactly the four vendors", () => {
    expect(DEFAULT_PUSH_SERVICE_HOST_RULES).toEqual([
      { kind: "exact", host: "fcm.googleapis.com" },
      { kind: "exact", host: "updates.push.services.mozilla.com" },
      { kind: "exact", host: "web.push.apple.com" },
      { kind: "suffix", suffix: "notify.windows.com" }
    ]);
  });

  test("an IP literal is never allowed even if an operator lists it", () => {
    const policy = resolvePushHostPolicy({
      COMMERCE_CUSTOMER_PUSH_EXTRA_ENDPOINT_HOSTS: "10.0.0.5, ::1"
    } as NodeJS.ProcessEnv);
    expect(isPushHostAllowed("10.0.0.5", policy)).toBe(false);
    expect(isPushHostAllowed("::1", policy)).toBe(false);
  });
});

describe("operator override of the host allowlist (ADR-0048 Q6)", () => {
  test("extends the list with an exact host and a wildcard suffix", () => {
    const policy = resolvePushHostPolicy({
      COMMERCE_CUSTOMER_PUSH_EXTRA_ENDPOINT_HOSTS:
        "push.vendor.example, *.relay.example.org"
    } as NodeJS.ProcessEnv);

    expect(
      checkCustomerPushEndpoint("https://push.vendor.example/x", policy).ok
    ).toBe(true);
    expect(
      checkCustomerPushEndpoint("https://a.relay.example.org/x", policy).ok
    ).toBe(true);
    // The wildcard does not match the bare parent.
    expect(
      checkCustomerPushEndpoint("https://relay.example.org/x", policy).ok
    ).toBe(false);
    // The defaults still hold.
    expect(
      checkCustomerPushEndpoint("https://fcm.googleapis.com/x", policy).ok
    ).toBe(true);
  });

  test("an unset or blank override changes nothing", () => {
    expect(parseExtraPushHosts(undefined)).toEqual({ rules: [], invalid: [] });
    expect(parseExtraPushHosts("  ,  ")).toEqual({ rules: [], invalid: [] });
  });

  test("malformed entries are ignored (fail closed) and reported", () => {
    const parsed = parseExtraPushHosts(
      "good.example.com, localhost, 10.0.0.1, single, *.com.., a b, host.local, x.internal"
    );
    expect(parsed.rules).toEqual([{ kind: "exact", host: "good.example.com" }]);
    expect(parsed.invalid).toEqual(
      expect.arrayContaining([
        "localhost",
        "10.0.0.1",
        "single",
        "host.local",
        "x.internal"
      ])
    );
  });

  test("the override is capped at 32 rules", () => {
    const many = Array.from({ length: 40 }, (_, i) => `h${i}.example.com`).join(
      ","
    );
    const parsed = parseExtraPushHosts(many);
    expect(parsed.rules).toHaveLength(32);
    expect(parsed.invalid).toHaveLength(8);
  });
});

describe("register body is strict (TS-U5)", () => {
  const valid = {
    endpoint: FCM,
    keys: { p256dh: P256DH, auth: AUTH },
    expirationTime: null,
    consent: {
      purposes: ["order_updates"],
      textVersion: CUSTOMER_PUSH_CONSENT_TEXT_VERSION
    }
  };

  test("accepts the browser's PushSubscription.toJSON() shape plus consent", () => {
    expect(parseRegisterBodyShape(valid).ok).toBe(true);
  });

  test.each([
    "accountId",
    "customerId",
    "tenantId",
    "sessionId",
    "tenantUserId",
    "transport",
    "title",
    "body",
    "navigate",
    "targetPath",
    "storefrontOrigin"
  ])("a client-chosen %s is refused", (key) => {
    const result = parseRegisterBodyShape({ ...valid, [key]: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.field)).toContain(key);
    }
  });

  test("unknown keys inside keys and consent are refused too", () => {
    expect(
      parseRegisterBodyShape({
        ...valid,
        keys: { ...valid.keys, extra: "x" }
      }).ok
    ).toBe(false);
    expect(
      parseRegisterBodyShape({
        ...valid,
        consent: { ...valid.consent, accountId: "x" }
      }).ok
    ).toBe(false);
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a string", "x"],
    ["a number", 1]
  ])("a non-object body (%s) is refused", (_label, body) => {
    expect(parseRegisterBodyShape(body).ok).toBe(false);
  });

  test("wrong types are refused", () => {
    expect(parseRegisterBodyShape({ ...valid, endpoint: 5 }).ok).toBe(false);
    expect(parseRegisterBodyShape({ ...valid, keys: "x" }).ok).toBe(false);
    expect(
      parseRegisterBodyShape({ ...valid, expirationTime: "soon" }).ok
    ).toBe(false);
    expect(parseRegisterBodyShape({ ...valid, consent: [] }).ok).toBe(false);
  });

  test("upstream's validator (reused) checks the key sizes with the transport fixed server-side", () => {
    expect(
      validateSubscriptionInput({
        transport: "web_push",
        endpoint: FCM,
        keys: { p256dh: P256DH, auth: AUTH }
      }).valid
    ).toBe(true);
    expect(
      validateSubscriptionInput({
        transport: "web_push",
        endpoint: FCM,
        keys: { p256dh: "short", auth: AUTH }
      }).valid
    ).toBe(false);
  });
});

describe("consent validation", () => {
  const version = CUSTOMER_PUSH_CONSENT_TEXT_VERSION;

  test("accepts distinct transactional purposes and de-duplicates", () => {
    const result = validateRegisterConsent({
      purposes: ["order_updates", "order_updates", "support_replies"],
      textVersion: version
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.purposes).toEqual([
        "order_updates",
        "support_replies"
      ]);
    }
  });

  test("marketing is refused: transactional consent never implies marketing (T13)", () => {
    expect(
      validateRegisterConsent({ purposes: ["marketing"], textVersion: version })
        .ok
    ).toBe(false);
  });

  test("an empty purposes list, an unknown purpose and a non-string purpose are refused", () => {
    expect(
      validateRegisterConsent({ purposes: [], textVersion: version }).ok
    ).toBe(false);
    expect(
      validateRegisterConsent({ purposes: ["spam"], textVersion: version }).ok
    ).toBe(false);
    expect(
      validateRegisterConsent({ purposes: [5], textVersion: version }).ok
    ).toBe(false);
  });

  test("a stale or malformed consent text version is refused", () => {
    expect(
      validateRegisterConsent({
        purposes: ["order_updates"],
        textVersion: "draft-2020-01"
      }).ok
    ).toBe(false);
    expect(
      validateRegisterConsent({
        purposes: ["order_updates"],
        textVersion: "has spaces and <b>"
      }).ok
    ).toBe(false);
  });
});

describe("preferences body", () => {
  const version = CUSTOMER_PUSH_CONSENT_TEXT_VERSION;

  test("turning a purpose on needs the current wording version", () => {
    expect(parsePreferencesBody({ purposes: { order_updates: true } }).ok).toBe(
      false
    );
    expect(
      parsePreferencesBody({
        purposes: { order_updates: true },
        textVersion: version
      }).ok
    ).toBe(true);
  });

  test("turning a purpose off never needs a version (withdrawal is always possible)", () => {
    const result = parsePreferencesBody({
      purposes: { order_updates: false, payment_updates: false }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.changes).toEqual([
        { purpose: "order_updates", enabled: false },
        { purpose: "payment_updates", enabled: false }
      ]);
    }
  });

  test("marketing, unknown purposes, non-booleans and unknown keys are refused", () => {
    expect(
      parsePreferencesBody({
        purposes: { marketing: true },
        textVersion: version
      }).ok
    ).toBe(false);
    expect(parsePreferencesBody({ purposes: { bogus: false } }).ok).toBe(false);
    expect(
      parsePreferencesBody({ purposes: { order_updates: "yes" } }).ok
    ).toBe(false);
    expect(
      parsePreferencesBody({
        purposes: { order_updates: false },
        accountId: "x"
      }).ok
    ).toBe(false);
    expect(parsePreferencesBody({ purposes: {} }).ok).toBe(false);
    expect(parsePreferencesBody(null).ok).toBe(false);
  });
});

describe("credential encryption (Q2)", () => {
  test("auth secret and endpoint round-trip under the customer purposes", () => {
    const authCipher = encryptCustomerPushAuthSecret(
      AUTH,
      TENANT,
      HASH,
      RING_A
    );
    const endpointCipher = encryptCustomerPushEndpoint(
      FCM,
      TENANT,
      HASH,
      RING_A
    );

    expect(authCipher).toMatch(/^v2:ka:/);
    expect(authCipher).not.toContain(AUTH);
    expect(endpointCipher).not.toContain("fcm.googleapis.com");

    expect(
      decryptCustomerPushAuthSecret(authCipher, TENANT, HASH, RING_A)
    ).toBe(AUTH);
    expect(
      decryptCustomerPushEndpoint(endpointCipher, TENANT, HASH, RING_A)
    ).toBe(FCM);
  });

  test("a fresh IV every time: the same plaintext never encrypts to the same envelope", () => {
    expect(encryptCustomerPushAuthSecret(AUTH, TENANT, HASH, RING_A)).not.toBe(
      encryptCustomerPushAuthSecret(AUTH, TENANT, HASH, RING_A)
    );
  });

  test("AAD purpose separation: neither column's ciphertext decrypts as the other", () => {
    const authCipher = encryptCustomerPushAuthSecret(
      AUTH,
      TENANT,
      HASH,
      RING_A
    );
    const endpointCipher = encryptCustomerPushEndpoint(
      FCM,
      TENANT,
      HASH,
      RING_A
    );

    expect(() =>
      decryptCustomerPushEndpoint(authCipher, TENANT, HASH, RING_A)
    ).toThrow(FieldEncryptionError);
    expect(() =>
      decryptCustomerPushAuthSecret(endpointCipher, TENANT, HASH, RING_A)
    ).toThrow(FieldEncryptionError);
    expect(CUSTOMER_PUSH_AUTH_SECRET_PURPOSE).not.toBe(
      CUSTOMER_PUSH_ENDPOINT_PURPOSE
    );
  });

  test("a customer ciphertext cannot be read as an upstream (staff) auth secret, and the other way round", () => {
    const customer = encryptCustomerPushAuthSecret(AUTH, TENANT, HASH, RING_A);
    const staff = encryptPushAuthSecret(AUTH, TENANT, HASH, RING_A);

    expect(() => decryptPushAuthSecret(customer, TENANT, HASH, RING_A)).toThrow(
      FieldEncryptionError
    );
    expect(() =>
      decryptCustomerPushAuthSecret(staff, TENANT, HASH, RING_A)
    ).toThrow(FieldEncryptionError);
  });

  test("a ciphertext copied to another tenant or another endpoint fails authentication", () => {
    const cipher = encryptCustomerPushAuthSecret(AUTH, TENANT, HASH, RING_A);

    expect(() =>
      decryptCustomerPushAuthSecret(cipher, OTHER_TENANT, HASH, RING_A)
    ).toThrow(FieldEncryptionError);
    expect(() =>
      decryptCustomerPushAuthSecret(cipher, TENANT, OTHER_HASH, RING_A)
    ).toThrow(FieldEncryptionError);
  });

  test("a tampered envelope fails authentication", () => {
    const cipher = encryptCustomerPushAuthSecret(AUTH, TENANT, HASH, RING_A);
    const parts = cipher.split(":");
    parts[4] = Buffer.from("tampered").toString("base64url");

    expect(() =>
      decryptCustomerPushAuthSecret(parts.join(":"), TENANT, HASH, RING_A)
    ).toThrow(FieldEncryptionError);
  });

  test("key rotation: the first key writes, every key reads", () => {
    const old = encryptCustomerPushEndpoint(FCM, TENANT, HASH, RING_A);
    const fresh = encryptCustomerPushEndpoint(FCM, TENANT, HASH, RING_AB);

    expect(old).toMatch(/^v2:ka:/);
    expect(fresh).toMatch(/^v2:kb:/);
    expect(decryptCustomerPushEndpoint(old, TENANT, HASH, RING_AB)).toBe(FCM);
    // A ring that dropped the key can no longer read it: fail closed.
    expect(() =>
      decryptCustomerPushEndpoint(fresh, TENANT, HASH, RING_A)
    ).toThrow(FieldEncryptionError);
  });

  test("no ring, no registration: the availability check fails closed without the ring or VAPID", () => {
    const base = {
      PUSH_ENABLED: "true",
      PUSH_PROVIDER: "web_push"
    } as NodeJS.ProcessEnv;
    expect(resolvePushAvailability(base).ok).toBe(false);
    expect(resolvePushAvailability({ ...base, PUSH_ENABLED: "false" }).ok).toBe(
      false
    );
  });
});

describe("user-agent description", () => {
  test.each([
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      "Chrome on Android (mobile)"
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "Safari on iOS (mobile)"
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
      "Firefox on Windows (desktop)"
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
      "Edge on Windows (desktop)"
    ]
  ])("describes %#", (userAgent, expected) => {
    expect(classifyUserAgent(userAgent)).toBe(expected);
  });

  test("absent or blank is null, and the raw header never leaks into the result", () => {
    expect(classifyUserAgent(null)).toBeNull();
    expect(classifyUserAgent("   ")).toBeNull();
    const hostile = `<script>alert(1)</script> ${"A".repeat(5000)}`;
    const result = classifyUserAgent(hostile)!;
    expect(result).toBe("Other on Other (desktop)");
    expect(result.length).toBeLessThanOrEqual(120);
  });
});

describe("storefront origin (TS-U2)", () => {
  test("a cross-origin https origin is the storefront origin", () => {
    expect(
      resolveStorefrontOrigin("https://shop.example.test", true, {
        APP_URL: "https://cms.example.test"
      } as NodeJS.ProcessEnv)
    ).toEqual({ ok: true, origin: "https://shop.example.test" });
  });

  test("a same-origin request is unsupported in v1 (Q3)", () => {
    expect(resolveStorefrontOrigin(null, false).ok).toBe(false);
    expect(resolveStorefrontOrigin("https://cms.example.test", false).ok).toBe(
      false
    );
  });

  test("the CMS/admin origin is never a storefront origin (T8)", () => {
    expect(
      resolveStorefrontOrigin("https://cms.example.test", true, {
        APP_URL: "https://cms.example.test"
      } as NodeJS.ProcessEnv).ok
    ).toBe(false);
    // APP_URL with a path or trailing slash still names the same origin.
    expect(
      resolveStorefrontOrigin("https://cms.example.test", true, {
        APP_URL: "https://cms.example.test/admin/"
      } as NodeJS.ProcessEnv).ok
    ).toBe(false);
  });

  test("http is refused, except a loopback origin when APP_ENV=development", () => {
    expect(resolveStorefrontOrigin("http://shop.example.test", true).ok).toBe(
      false
    );
    expect(resolveStorefrontOrigin("http://localhost:4321", true).ok).toBe(
      false
    );
    expect(
      resolveStorefrontOrigin("http://localhost:4321", true, {
        APP_ENV: "development"
      } as NodeJS.ProcessEnv).ok
    ).toBe(true);
    expect(
      resolveStorefrontOrigin("http://shop.example.test", true, {
        APP_ENV: "development"
      } as NodeJS.ProcessEnv).ok
    ).toBe(false);
  });

  test.each([
    ["null origin", "null"],
    ["a path", "https://shop.example.test/x"],
    ["userinfo", "https://user@shop.example.test"],
    ["a non-http scheme", "chrome-extension://abcdef"],
    ["garbage", "%%%"]
  ])("a malformed Origin header is refused: %s", (_label, header) => {
    expect(resolveStorefrontOrigin(header, true).ok).toBe(false);
  });

  test("the capability reports why it is off, and never leaks a key when it is", () => {
    const off = buildCustomerPushCapability({ ok: false }, { ok: false });
    expect(off).toMatchObject({
      enabled: false,
      reason: "push_not_configured",
      applicationServerKey: null,
      transports: ["web_push"],
      maxDevices: 5
    });

    const sameOrigin = buildCustomerPushCapability(
      { ok: true, applicationServerKey: "PUBLICKEY", ring: RING_A },
      { ok: false }
    );
    expect(sameOrigin.reason).toBe("origin_not_supported");
    expect(sameOrigin.applicationServerKey).toBeNull();

    const on = buildCustomerPushCapability(
      { ok: true, applicationServerKey: "PUBLICKEY", ring: RING_A },
      { ok: true, origin: "https://shop.example.test" }
    );
    expect(on).toMatchObject({
      enabled: true,
      reason: null,
      applicationServerKey: "PUBLICKEY"
    });
    expect(JSON.stringify(on)).not.toContain(KEY_A);
  });
});

// ---------------------------------------------------------------------------
// TS-S1 - static: the customer push surface never touches a staff credential
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? sourceFiles(full)
      : full.endsWith(".ts")
        ? [full]
        : [];
  });
}

const CUSTOMER_PUSH_FILES = [
  ...sourceFiles(
    join(
      import.meta.dir,
      "../src/pages/api/v1/commerce/storefront/account/push"
    )
  ),
  ...[
    "customer-push-http",
    "customer-push-devices",
    "customer-push-preferences",
    "customer-push-outbox",
    "customer-push-capability",
    "customer-push-audit"
  ].map((name) =>
    join(import.meta.dir, `../src/modules/commerce/application/${name}.ts`)
  )
];

describe("TS-S1 static boundary", () => {
  test("there are customer push files to inspect", () => {
    expect(CUSTOMER_PUSH_FILES.length).toBeGreaterThanOrEqual(9);
  });

  test("no customer push file imports the staff principal resolver, session lookup or ABAC chokepoint", () => {
    for (const file of CUSTOMER_PUSH_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code).not.toMatch(/identity-access/);
      expect(code).not.toMatch(/resolveTenantPrincipal|resolveAuthInputs/);
      expect(code).not.toMatch(
        /defineSelfServiceTenantRoute|defineTenantRoute/
      );
      expect(code).not.toMatch(/awcms_sessions|auth\/session-token/);
    }
  });

  test("no customer push file reads a cookie", () => {
    for (const file of CUSTOMER_PUSH_FILES) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code).not.toMatch(/\bcookies\b/);
      expect(code).not.toMatch(/headers\.get\(\s*["']cookie["']/i);
      expect(code).not.toMatch(/set-cookie/i);
    }
  });

  test("no response ever sets Access-Control-Allow-Credentials", () => {
    for (const file of CUSTOMER_PUSH_FILES) {
      expect(stripComments(readFileSync(file, "utf8"))).not.toMatch(
        /allow-credentials/i
      );
    }
  });

  test("the customer routes authenticate with requireCustomerSession only", () => {
    const http = readFileSync(
      join(
        import.meta.dir,
        "../src/modules/commerce/application/customer-push-http.ts"
      ),
      "utf8"
    );
    expect(stripComments(http)).toContain("requireCustomerSession(");
  });

  test("only the device directory and the key-rotation file name a credential column", () => {
    const applicationDir = join(
      import.meta.dir,
      "../src/modules/commerce/application"
    );
    const allowed = new Set([
      "customer-push-devices.ts",
      "customer-push-rekey.ts"
    ]);
    for (const file of sourceFiles(applicationDir)) {
      const base = file.split("/").pop()!;
      const code = stripComments(readFileSync(file, "utf8"));
      if (/endpoint_ciphertext|auth_secret_ciphertext/.test(code)) {
        expect(allowed.has(base)).toBe(true);
      }
    }
  });

  test("no customer push file names an upstream awcms_push_* table (option C: nothing upstream is written)", () => {
    for (const file of [
      ...CUSTOMER_PUSH_FILES,
      join(
        import.meta.dir,
        "../src/modules/commerce/application/customer-push-maintenance.ts"
      ),
      join(
        import.meta.dir,
        "../src/modules/commerce/application/customer-push-rekey.ts"
      ),
      join(
        import.meta.dir,
        "../src/modules/commerce/application/customer-push-erasure.ts"
      ),
      join(
        import.meta.dir,
        "../src/modules/commerce/application/customer-push-diagnostics.ts"
      )
    ]) {
      expect(stripComments(readFileSync(file, "utf8"))).not.toMatch(
        /awcms_push_(subscriptions|messages|delivery_attempts)/
      );
    }
  });
});
