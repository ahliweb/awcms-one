/**
 * `src/lib/awcms/toko-origin.ts` — `PUBLIC_AWCMS_ORIGIN` validation. The
 * acceptance criterion this covers directly: "with `PUBLIC_AWCMS_ORIGIN`
 * unset the build FAILS with a message naming the variable" — `csp.json.ts`
 * calls `requireAwcmsOrigin()` during every build (see that file), so a
 * throw here IS the build failure; this test asserts the throw's shape
 * without needing to run a real `astro build`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { AwcmsOriginConfigError, requireAwcmsOrigin } from "../src/lib/awcms/toko-origin";

const ORIGINAL = process.env.PUBLIC_AWCMS_ORIGIN;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PUBLIC_AWCMS_ORIGIN;
  else process.env.PUBLIC_AWCMS_ORIGIN = ORIGINAL;
});

describe("requireAwcmsOrigin", () => {
  test("throws, naming the variable, when unset", () => {
    delete process.env.PUBLIC_AWCMS_ORIGIN;
    expect(() => requireAwcmsOrigin()).toThrow(AwcmsOriginConfigError);
    expect(() => requireAwcmsOrigin()).toThrow(/PUBLIC_AWCMS_ORIGIN/);
  });

  test("returns the bare origin for a well-formed value", () => {
    process.env.PUBLIC_AWCMS_ORIGIN = "https://cms.example.com";
    expect(requireAwcmsOrigin()).toBe("https://cms.example.com");
  });

  test("strips a trailing slash's worth of nothing — a bare origin has none to strip", () => {
    process.env.PUBLIC_AWCMS_ORIGIN = "http://localhost:4310";
    expect(requireAwcmsOrigin()).toBe("http://localhost:4310");
  });

  test("rejects a value carrying a path", () => {
    process.env.PUBLIC_AWCMS_ORIGIN = "https://cms.example.com/api";
    expect(() => requireAwcmsOrigin()).toThrow(AwcmsOriginConfigError);
  });

  test("rejects a value carrying a trailing slash", () => {
    process.env.PUBLIC_AWCMS_ORIGIN = "https://cms.example.com/";
    expect(() => requireAwcmsOrigin()).toThrow(AwcmsOriginConfigError);
  });

  test("rejects a value carrying credentials", () => {
    process.env.PUBLIC_AWCMS_ORIGIN = "https://user:pass@cms.example.com";
    expect(() => requireAwcmsOrigin()).toThrow(AwcmsOriginConfigError);
  });

  test("rejects a non-http(s) scheme", () => {
    process.env.PUBLIC_AWCMS_ORIGIN = "ftp://cms.example.com";
    expect(() => requireAwcmsOrigin()).toThrow(AwcmsOriginConfigError);
  });

  test("rejects a value that is not a URL at all", () => {
    process.env.PUBLIC_AWCMS_ORIGIN = "not a url";
    expect(() => requireAwcmsOrigin()).toThrow(AwcmsOriginConfigError);
  });
});
