/**
 * GA4's one build-time switch (issue #56, A10) — `src/lib/ga.ts`.
 * `isValidGaMeasurementId` is the single validator `BaseLayout.astro` and
 * `src/pages/csp.json.ts` both defer to, so it is tested directly against
 * every shape that must and must not turn GA on.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isValidGaMeasurementId, readGaMeasurementId } from "../src/lib/ga";

describe("isValidGaMeasurementId", () => {
  test("accepts a real-shaped GA4 Measurement ID", () => {
    expect(isValidGaMeasurementId("G-TEST1234")).toBe(true);
    expect(isValidGaMeasurementId("g-abc123")).toBe(true); // case-insensitive prefix
  });

  test("rejects everything that is not one", () => {
    expect(isValidGaMeasurementId(undefined)).toBe(false);
    expect(isValidGaMeasurementId(null)).toBe(false);
    expect(isValidGaMeasurementId("")).toBe(false);
    expect(isValidGaMeasurementId("   ")).toBe(false);
    expect(isValidGaMeasurementId("G-")).toBe(false); // prefix with nothing after it
    expect(isValidGaMeasurementId("UA-12345-1")).toBe(false); // Universal Analytics, not GA4
    expect(isValidGaMeasurementId("GTM-ABCDEF")).toBe(false); // Tag Manager container, not a GA4 id
    expect(isValidGaMeasurementId("not-an-id")).toBe(false);
  });
});

describe("readGaMeasurementId", () => {
  const ORIGINAL = process.env.PUBLIC_GA_ID;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PUBLIC_GA_ID;
    else process.env.PUBLIC_GA_ID = ORIGINAL;
  });

  test("undefined (GA off) when PUBLIC_GA_ID is unset", () => {
    delete process.env.PUBLIC_GA_ID;
    expect(readGaMeasurementId()).toBeUndefined();
  });

  test("undefined (GA off, not a thrown error) when PUBLIC_GA_ID is malformed", () => {
    process.env.PUBLIC_GA_ID = "not-an-id";
    expect(readGaMeasurementId()).toBeUndefined();
  });

  test("the trimmed id when PUBLIC_GA_ID is a valid GA4 Measurement ID", () => {
    process.env.PUBLIC_GA_ID = "  G-TEST1234  ";
    expect(readGaMeasurementId()).toBe("G-TEST1234");
  });
});
