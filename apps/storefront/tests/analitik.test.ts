/**
 * The first-party visitor beacon's pure logic (issue #56, A10) —
 * `src/scripts/analitik.ts`'s payload builder and Do Not Track/Global
 * Privacy Control suppression, tested directly against
 * `POST /api/v1/analytics/collect`'s own documented validation
 * (`apps/cms/src/pages/api/v1/analytics/collect.ts`), with no network call
 * and no real `document`/`navigator` — this module's side-effecting event
 * listeners only register when `typeof document !== "undefined"`, which is
 * false under `bun test`.
 */
import { describe, expect, test } from "bun:test";
import {
  buildAnalyticsPayload,
  isTrackingOptedOut
} from "../src/scripts/analitik";

describe("buildAnalyticsPayload", () => {
  test("builds the exact shape the route validates: { tenantCode, path, referrer? }", () => {
    expect(
      buildAnalyticsPayload({
        tenantCode: "bjekmart",
        path: "/produk",
        referrer: "https://www.google.com/"
      })
    ).toEqual({
      tenantCode: "bjekmart",
      path: "/produk",
      referrer: "https://www.google.com/"
    });
  });

  test("omits referrer entirely when blank, rather than sending an empty string", () => {
    const payload = buildAnalyticsPayload({ tenantCode: "bjekmart", path: "/", referrer: "" });
    expect(payload).toEqual({ tenantCode: "bjekmart", path: "/" });
    expect(payload).not.toHaveProperty("referrer");
  });

  test("never invents a field the route does not validate (no viewport class)", () => {
    const payload = buildAnalyticsPayload({ tenantCode: "bjekmart", path: "/", referrer: "" });
    expect(Object.keys(payload ?? {}).sort()).toEqual(["path", "tenantCode"]);
  });

  test("null when tenantCode is blank — an unconfigured AWCMS_TENANT_CODE, not an error", () => {
    expect(buildAnalyticsPayload({ tenantCode: "", path: "/", referrer: "" })).toBeNull();
    expect(buildAnalyticsPayload({ tenantCode: "   ", path: "/", referrer: "" })).toBeNull();
  });

  test("null when tenantCode exceeds the route's 128-char limit", () => {
    expect(
      buildAnalyticsPayload({ tenantCode: "a".repeat(129), path: "/", referrer: "" })
    ).toBeNull();
    expect(
      buildAnalyticsPayload({ tenantCode: "a".repeat(128), path: "/", referrer: "" })
    ).not.toBeNull();
  });

  test("null when path does not start with '/', matching the route's own rule", () => {
    expect(
      buildAnalyticsPayload({ tenantCode: "bjekmart", path: "produk", referrer: "" })
    ).toBeNull();
  });

  test("null when path exceeds the route's 2048-char MAX_PATH_LENGTH", () => {
    expect(
      buildAnalyticsPayload({ tenantCode: "bjekmart", path: `/${"a".repeat(2048)}`, referrer: "" })
    ).toBeNull();
  });
});

describe("isTrackingOptedOut", () => {
  test("false when no opt-out signal is present", () => {
    expect(isTrackingOptedOut({}, undefined)).toBe(false);
    expect(isTrackingOptedOut({ doNotTrack: "0" }, "0")).toBe(false);
    expect(isTrackingOptedOut({ doNotTrack: null }, null)).toBe(false);
  });

  test("true on navigator.doNotTrack === '1'", () => {
    expect(isTrackingOptedOut({ doNotTrack: "1" }, undefined)).toBe(true);
  });

  test("true on the legacy window.doNotTrack === '1' even when navigator disagrees", () => {
    expect(isTrackingOptedOut({ doNotTrack: "unspecified" }, "1")).toBe(true);
  });

  test("true on navigator.globalPrivacyControl === true", () => {
    expect(isTrackingOptedOut({ globalPrivacyControl: true }, undefined)).toBe(true);
  });
});
