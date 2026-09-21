import { describe, expect, test } from "bun:test";

import {
  checkStorefrontEnvShape,
  isHttpsUrl,
  looksLikeToken
} from "../tools/deploy-preflight.mjs";

/**
 * Shape/config tests only — no real credentials, no build, no network. See
 * `docs/adr/0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md`
 * D4/D5 for why `AWCMS_API_TOKEN` must never appear in a `PUBLIC_*` variable
 * or the served artefact, and why this preflight is fail-closed.
 */

/** A minimal stand-in for packages/gerbang/lib/reporter.mjs's createReporter, capturing calls instead of printing/exiting. */
function fakeReport() {
  const violations = [];
  const notes = [];
  return {
    violation: (gate, file, message) => violations.push({ gate, file, message }),
    note: (line) => notes.push(line),
    violations,
    notes
  };
}

describe("isHttpsUrl / looksLikeToken", () => {
  test("https passes, http and garbage fail", () => {
    expect(isHttpsUrl("https://shop.example.test")).toBe(true);
    expect(isHttpsUrl("http://shop.example.test")).toBe(false);
    expect(isHttpsUrl("not-a-url")).toBe(false);
    expect(isHttpsUrl(undefined)).toBe(false);
  });

  test("a short label does not look like a token", () => {
    expect(looksLikeToken("toko")).toBe(false);
    expect(looksLikeToken(undefined)).toBe(false);
  });

  test("a long alphanumeric string looks like a token", () => {
    expect(looksLikeToken("abcDEF123456ghijKLMN7890")).toBe(true);
  });
});

describe("checkStorefrontEnvShape", () => {
  test("a fully-valid production env has no violations", () => {
    const report = fakeReport();
    checkStorefrontEnvShape(
      {
        SITE_PROFILE: "toko",
        SITE_URL: "https://shop.example.test",
        PUBLIC_AWCMS_ORIGIN: "https://cms.example.test",
        AWCMS_API_URL: "https://cms.example.test",
        AWCMS_API_TOKEN: "a-build-time-only-token-value",
        PUBLIC_GA_ID: "G-ABCDEF1234"
      },
      true,
      report
    );
    expect(report.violations).toEqual([]);
  });

  test("an invalid SITE_PROFILE is a violation", () => {
    const report = fakeReport();
    checkStorefrontEnvShape({ SITE_PROFILE: "not-a-profile" }, false, report);
    expect(report.violations.some((v) => v.file === "SITE_PROFILE")).toBe(true);
  });

  test("http SITE_URL/PUBLIC_AWCMS_ORIGIN fail in production, pass shape check outside it", () => {
    const prod = fakeReport();
    checkStorefrontEnvShape(
      { SITE_URL: "http://shop.example.test", PUBLIC_AWCMS_ORIGIN: "http://cms.example.test" },
      true,
      prod
    );
    expect(prod.violations.some((v) => v.file === "SITE_URL")).toBe(true);
    expect(prod.violations.some((v) => v.file === "PUBLIC_AWCMS_ORIGIN")).toBe(true);

    const dev = fakeReport();
    checkStorefrontEnvShape(
      { SITE_URL: "http://shop.example.test", PUBLIC_AWCMS_ORIGIN: "http://cms.example.test" },
      false,
      dev
    );
    expect(dev.violations).toEqual([]);
  });

  test("missing AWCMS_API_TOKEN fails in production only", () => {
    const prod = fakeReport();
    checkStorefrontEnvShape({}, true, prod);
    expect(prod.violations.some((v) => v.file === "AWCMS_API_TOKEN")).toBe(true);

    const dev = fakeReport();
    checkStorefrontEnvShape({}, false, dev);
    expect(dev.violations.some((v) => v.file === "AWCMS_API_TOKEN")).toBe(false);
  });

  test("AWCMS_API_TOKEN is never allowed to look PUBLIC_-prefixed", () => {
    const report = fakeReport();
    checkStorefrontEnvShape({ AWCMS_API_TOKEN: "PUBLIC_leaked-value" }, false, report);
    expect(report.violations.some((v) => v.file === "AWCMS_API_TOKEN")).toBe(true);
  });

  test("a PUBLIC_* variable whose value looks like a token is a violation", () => {
    const report = fakeReport();
    checkStorefrontEnvShape(
      { PUBLIC_SOME_SECRET: "abcDEF123456ghijKLMN7890" },
      false,
      report
    );
    expect(report.violations.some((v) => v.file === "PUBLIC_SOME_SECRET")).toBe(true);
  });

  test("PUBLIC_GA_ID is exempt from the token-shape heuristic", () => {
    const report = fakeReport();
    checkStorefrontEnvShape({ PUBLIC_GA_ID: "G-ABCDEFGHIJ1234567890" }, false, report);
    expect(report.violations.some((v) => v.file === "PUBLIC_GA_ID")).toBe(false);
  });
});
