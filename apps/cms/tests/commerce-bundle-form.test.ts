import { describe, expect, test } from "bun:test";
import {
  formatBundleLines,
  parseBundleLines
} from "../src/lib/ui/commerce-bundle-form";

describe("bundle component editor text (Issue #290)", () => {
  test("parses SKU x quantity lines, a bare SKU meaning one, blank lines ignored", () => {
    expect(
      parseBundleLines("KOPI-1 x 2\n\n  TEH-9  \nGULA × 10\r\nSKU-X X 3")
    ).toEqual([
      { sku: "KOPI-1", quantity: 2 },
      { sku: "TEH-9", quantity: 1 },
      { sku: "GULA", quantity: 10 },
      { sku: "SKU-X", quantity: 3 }
    ]);
  });

  test("an empty text is an empty list; a zero quantity is refused", () => {
    expect(parseBundleLines("")).toEqual([]);
    expect(parseBundleLines("A x 0")).toBeNull();
  });

  test("a SKU may contain an x", () => {
    expect(parseBundleLines("BOX-XL x 2")).toEqual([
      { sku: "BOX-XL", quantity: 2 }
    ]);
  });

  test("round-trips through the formatter", () => {
    const lines = [
      { sku: "A-1", quantity: 2 },
      { sku: "B-2", quantity: 1 }
    ];
    expect(parseBundleLines(formatBundleLines(lines))).toEqual(lines);
  });
});
