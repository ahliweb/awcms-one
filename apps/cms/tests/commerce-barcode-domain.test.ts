/**
 * Issue #292 (ADR-0032) - `domain/barcode.ts`: GTIN check digits, the barcode
 * validation policy, and the Code 128 / EAN-13 / EAN-8 encodings. Pure.
 */
import { describe, expect, test } from "bun:test";
import {
  CODE128_SYMBOL_PATTERNS,
  code128Symbols,
  DEFAULT_LABEL_SHEET_OPTIONS,
  encodeBarcode,
  gtinCheckDigit,
  isValidGtin,
  LABEL_LIMITS,
  parseLabelSheetOptions,
  parseLabelTargets,
  plannedLabelCount,
  renderBarcodeSvg,
  validateAssignBarcodeInput,
  validateBarcode
} from "../src/modules/commerce/domain/barcode";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const VARIANT = "22222222-2222-4222-8222-222222222222";

describe("GTIN check digit", () => {
  test("known-good GTIN-8/12/13/14 values validate", () => {
    for (const code of [
      "96385074", // EAN-8
      "036000291452", // UPC-A
      "4006381333931", // EAN-13
      "5901234123457", // EAN-13
      "10614141000415" // GTIN-14
    ]) {
      expect(isValidGtin(code)).toBe(true);
    }
  });

  test("a single wrong digit or a wrong check digit fails", () => {
    expect(isValidGtin("4006381333932")).toBe(false);
    expect(isValidGtin("4006381333941")).toBe(false);
    expect(isValidGtin("96385075")).toBe(false);
  });

  test("gtinCheckDigit computes the digit for the body", () => {
    expect(gtinCheckDigit("400638133393")).toBe(1);
    expect(gtinCheckDigit("9638507")).toBe(4);
  });

  test("lengths other than 8/12/13/14 are not GTINs", () => {
    expect(isValidGtin("123456789")).toBe(false);
    expect(isValidGtin("12345")).toBe(false);
  });
});

describe("validateBarcode", () => {
  test("a valid GTIN is classified by length", () => {
    expect(validateBarcode("4006381333931")).toEqual({
      valid: true,
      code: "4006381333931",
      symbology: "ean13"
    });
    expect(validateBarcode("96385074")).toMatchObject({ symbology: "ean8" });
    expect(validateBarcode("036000291452")).toMatchObject({
      symbology: "upca"
    });
    expect(validateBarcode("10614141000415")).toMatchObject({
      symbology: "gtin14"
    });
  });

  test("a numeric GTIN-length code with a bad check digit is rejected, not fixed", () => {
    expect(validateBarcode("4006381333932")).toEqual({
      valid: false,
      reason: "bad_check_digit"
    });
  });

  test("other codes are free Code 128 internal codes", () => {
    expect(validateBarcode("SKU-0042")).toMatchObject({ symbology: "code128" });
    expect(validateBarcode("12345")).toMatchObject({ symbology: "code128" });
    expect(validateBarcode("  ABC123  ")).toMatchObject({ code: "ABC123" });
  });

  test("rejects empty, too long, spaces, control and non-ASCII characters", () => {
    expect(validateBarcode("")).toEqual({ valid: false, reason: "empty" });
    expect(validateBarcode("   ")).toEqual({ valid: false, reason: "empty" });
    expect(validateBarcode(42)).toEqual({ valid: false, reason: "empty" });
    expect(validateBarcode("A".repeat(49))).toEqual({
      valid: false,
      reason: "too_long"
    });
    expect(validateBarcode("A".repeat(48))).toMatchObject({ valid: true });
    for (const bad of ["AB CD", "AB\tCD", "AB\nCD", "café", "AB\u0000"]) {
      expect(validateBarcode(bad)).toEqual({
        valid: false,
        reason: "bad_characters"
      });
    }
  });

  test("a code that looks like the scan field's quantity prefix is refused", () => {
    expect(validateBarcode("3*ABC")).toEqual({
      valid: false,
      reason: "quantity_prefix"
    });
    expect(validateBarcode("ABC*3")).toMatchObject({ valid: true });
    expect(validateBarcode("*ABC")).toMatchObject({ valid: true });
  });

  test("tenant text with markup characters is a legal code but never reaches the SVG", () => {
    const checked = validateBarcode("<b>&\"'");
    expect(checked.valid).toBe(true);
    if (!checked.valid) return;
    const svg = renderBarcodeSvg(encodeBarcode(checked.code));
    expect(svg).not.toContain("<b>");
    expect(svg).not.toContain("&amp;");
    expect(svg).not.toContain("\"'");
  });
});

describe("Code 128", () => {
  test("every symbol pattern has three bars and three spaces summing to 11 modules (stop: 13)", () => {
    expect(CODE128_SYMBOL_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_SYMBOL_PATTERNS).size).toBe(107);
    CODE128_SYMBOL_PATTERNS.forEach((pattern, index) => {
      const widths = [...pattern].map(Number);
      const total = widths.reduce((a, b) => a + b, 0);
      expect(total).toBe(index === 106 ? 13 : 11);
      expect(widths).toHaveLength(index === 106 ? 7 : 6);
      for (const width of widths) {
        expect(width).toBeGreaterThanOrEqual(1);
        expect(width).toBeLessThanOrEqual(4);
      }
    });
  });

  test("symbol values and checksum for a known string", () => {
    // "A" in subset B = 33; checksum = (104 + 33*1) mod 103 = 34.
    expect(code128Symbols("A")).toEqual([104, 33, 34, 106]);
    // "PJJ123C": Wikipedia's worked example is 54 under start A (103); the
    // same data under start B (104) is one higher.
    const symbols = code128Symbols("PJJ123C");
    expect(symbols[0]).toBe(104);
    expect(symbols[symbols.length - 2]).toBe(55);
  });

  test("an even run of digits uses subset C (half the symbols)", () => {
    expect(code128Symbols("1234")).toEqual([
      105,
      12,
      34,
      (105 + 12 + 68) % 103,
      106
    ]);
    // Odd length or a letter falls back to subset B.
    expect(code128Symbols("12345")[0]).toBe(104);
    expect(code128Symbols("12AB")[0]).toBe(104);
  });

  test("modules start with a bar, end with the stop pattern and are the right length", () => {
    const encoded = encodeBarcode("SKU-1");
    expect(encoded.symbology).toBe("code128");
    expect(encoded.modules.startsWith("11010010000")).toBe(true); // start B
    expect(encoded.modules.endsWith("1100011101011")).toBe(true); // stop
    // start(11) + 5 data(55) + checksum(11) + stop(13)
    expect(encoded.modules).toHaveLength(11 + 5 * 11 + 11 + 13);
  });

  test("encoding is deterministic", () => {
    expect(encodeBarcode("ABC-123").modules).toBe(
      encodeBarcode("ABC-123").modules
    );
  });
});

describe("EAN encodings", () => {
  test("EAN-13 is 95 modules with start, centre and end guards", () => {
    const encoded = encodeBarcode("4006381333931");
    expect(encoded.symbology).toBe("ean13");
    expect(encoded.modules).toHaveLength(95);
    expect(encoded.modules.startsWith("101")).toBe(true);
    expect(encoded.modules.slice(45, 50)).toBe("01010");
    expect(encoded.modules.endsWith("101")).toBe(true);
    expect(encoded.text).toBe("4006381333931");
  });

  test("EAN-13 left half follows the parity of the first digit", () => {
    // First digit 4 -> LGLLGG; digit '0' second: L(0)=0001101.
    const modules = encodeBarcode("4006381333931").modules;
    expect(modules.slice(3, 10)).toBe("0001101"); // L, digit 0
    expect(modules.slice(10, 17)).toBe("0100111"); // G, digit 0
  });

  test("UPC-A prints as EAN-13 with a leading zero but keeps its 12-digit text", () => {
    const upc = encodeBarcode("036000291452");
    expect(upc.modules).toBe(encodeBarcode("0036000291452").modules);
    expect(upc.text).toBe("036000291452");
  });

  test("EAN-8 is 67 modules", () => {
    const encoded = encodeBarcode("96385074");
    expect(encoded.symbology).toBe("ean8");
    expect(encoded.modules).toHaveLength(67);
    expect(encoded.modules.slice(3 + 28, 3 + 28 + 5)).toBe("01010");
  });

  test("GTIN-14 falls back to Code 128", () => {
    expect(encodeBarcode("10614141000415").symbology).toBe("code128");
  });

  test("encodeBarcode refuses an invalid code", () => {
    expect(() => encodeBarcode("4006381333932")).toThrow();
    expect(() => encodeBarcode("")).toThrow();
  });
});

describe("renderBarcodeSvg", () => {
  test("is numbers only: one path, aria-hidden, no text nodes", () => {
    const svg = renderBarcodeSvg(encodeBarcode("4006381333931"));
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('viewBox="0 0 113 1"'); // 11 + 95 + 7
    expect(svg).toContain('aria-hidden="true"');
    expect(svg.match(/<path /g)).toHaveLength(1);
    expect(svg).not.toContain("<text");
    expect(svg).not.toContain("<script");
    const d = /d="([^"]*)"/.exec(svg)![1]!;
    expect(d).toMatch(/^(M\d+ 0h\d+v1h-\d+z)+$/);
  });
});

describe("label sheet options", () => {
  test("defaults when nothing is supplied", () => {
    expect(parseLabelSheetOptions(new URLSearchParams())).toEqual(
      DEFAULT_LABEL_SHEET_OPTIONS
    );
  });

  test("numbers are clamped into the limits and garbage falls back", () => {
    const options = parseLabelSheetOptions(
      new URLSearchParams(
        "columns=99&copies=0&widthMm=1&heightMm=abc&layout=1&showName=1"
      )
    );
    expect(options.columns).toBe(LABEL_LIMITS.columns.max);
    expect(options.copies).toBe(LABEL_LIMITS.copies.min);
    expect(options.widthMm).toBe(LABEL_LIMITS.widthMm.min);
    expect(options.heightMm).toBe(DEFAULT_LABEL_SHEET_OPTIONS.heightMm);
    // A submitted form: unchecked boxes are absent, so they are OFF.
    expect(options.showName).toBe(true);
    expect(options.showPrice).toBe(false);
    expect(options.showSku).toBe(false);
  });

  test("an injected style value can only ever be an integer", () => {
    const options = parseLabelSheetOptions(
      new URLSearchParams("columns=3;background:url(x)&widthMm=60px")
    );
    expect(Number.isInteger(options.columns)).toBe(true);
    expect(Number.isInteger(options.widthMm)).toBe(true);
  });

  test("planned label count is capped", () => {
    const options = { ...DEFAULT_LABEL_SHEET_OPTIONS, copies: 50 };
    expect(plannedLabelCount(100, options)).toBe(LABEL_LIMITS.maxLabels);
    expect(plannedLabelCount(2, options)).toBe(100);
  });

  test("label targets: dedupe, drop malformed, cap", () => {
    const targets = parseLabelTargets(
      `${PRODUCT},${PRODUCT}:${VARIANT},${PRODUCT},not-a-uuid,${PRODUCT}:bad`
    );
    expect(targets).toEqual([
      { productId: PRODUCT, variantId: null },
      { productId: PRODUCT, variantId: VARIANT }
    ]);
    expect(parseLabelTargets(null)).toEqual([]);
    const many = Array.from(
      { length: 300 },
      (_, i) => `${PRODUCT.slice(0, -4)}${String(i).padStart(4, "0")}`
    ).join(",");
    expect(parseLabelTargets(many)).toHaveLength(LABEL_LIMITS.maxItems);
  });
});

describe("validateAssignBarcodeInput", () => {
  test("accepts a product or variant target with a code, or null to clear", () => {
    expect(
      validateAssignBarcodeInput({ productId: PRODUCT, barcode: "ABC123" })
    ).toEqual({
      valid: true,
      value: {
        target: { productId: PRODUCT, variantId: null },
        code: "ABC123"
      }
    });
    expect(
      validateAssignBarcodeInput({
        productId: PRODUCT,
        variantId: VARIANT,
        barcode: null
      })
    ).toMatchObject({ valid: true, value: { code: null } });
  });

  test("rejects a missing barcode key, a bad id and an invalid code", () => {
    const missing = validateAssignBarcodeInput({ productId: PRODUCT });
    expect(missing.valid).toBe(false);
    const badId = validateAssignBarcodeInput({
      productId: "x",
      barcode: "ABC"
    });
    expect(badId.valid).toBe(false);
    const badCode = validateAssignBarcodeInput({
      productId: PRODUCT,
      barcode: "4006381333932"
    });
    expect(badCode.valid).toBe(false);
    if (!badCode.valid) expect(badCode.errors[0]!.field).toBe("barcode");
    expect(validateAssignBarcodeInput(null).valid).toBe(false);
  });
});
