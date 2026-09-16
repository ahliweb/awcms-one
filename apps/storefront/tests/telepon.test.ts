import { describe, expect, test } from "bun:test";
import { previewIndonesianPhone } from "../src/lib/telepon";

describe("previewIndonesianPhone", () => {
  test("normalises a leading-0 mobile number", () => {
    expect(previewIndonesianPhone("081234567890")).toBe("+62 812-3456-7890");
  });

  test("normalises a number already carrying +62", () => {
    expect(previewIndonesianPhone("+6281234567890")).toBe("+62 812-3456-7890");
  });

  test("normalises a bare 62-prefixed number", () => {
    expect(previewIndonesianPhone("6281234567890")).toBe("+62 812-3456-7890");
  });

  test("tolerates spaces and dashes as typed", () => {
    expect(previewIndonesianPhone("0812-3456-7890")).toBe("+62 812-3456-7890");
    expect(previewIndonesianPhone("0812 3456 7890")).toBe("+62 812-3456-7890");
  });

  test("returns null for empty input", () => {
    expect(previewIndonesianPhone("")).toBeNull();
    expect(previewIndonesianPhone("   ")).toBeNull();
  });

  test("returns null when there is too little typed to preview yet", () => {
    expect(previewIndonesianPhone("081")).toBeNull();
  });

  test("this is a PREVIEW only — never the value actually submitted (see this file's own docblock)", () => {
    // A regression test as documentation: this function's output must never
    // be substituted for the raw customer-typed value in a request body —
    // that invariant lives in `checkout.ts` (it reads `FormData` directly,
    // never this function's return value), not in this file, but the
    // contract is worth asserting is still true of THIS function's contract:
    // it returns a NEW string, never a validation verdict.
    expect(typeof previewIndonesianPhone("081234567890")).toBe("string");
  });
});
