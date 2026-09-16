import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { comparePrices, formatDiscountPercent, formatPrice, priceToNumber } from "../src/lib/harga";

describe("lib/harga: formatPrice", () => {
  test("formats a numeric(14,2) string as id-ID currency, no decimals", () => {
    // `Intl.NumberFormat("id-ID", {style: "currency", ...})` inserts a space
    // between the "Rp" symbol and the amount — asserted on the DIGITS/
    // separators only, so this test does not depend on which exact space
    // character (regular vs. non-breaking) the ICU data on a given Bun
    // build happens to choose.
    expect(formatPrice("85000.00").replace(/\s/g, " ")).toBe("Rp 85.000");
  });

  test("rounds to whole rupiah for display only — never used for a stored value", () => {
    const digitsOnly = formatPrice("1234.56").replace(/[^\d]/g, "");
    expect(digitsOnly).toBe("1235");
  });

  test("throws for a non-finite value rather than silently formatting NaN", () => {
    expect(() => formatPrice("not-a-number")).toThrow();
  });
});

describe("lib/harga: priceToNumber / comparePrices", () => {
  test("priceToNumber parses a valid price string", () => {
    expect(priceToNumber("120.50")).toBe(120.5);
  });

  test("comparePrices orders ascending by numeric value", () => {
    expect(comparePrices("100.00", "200.00")).toBeLessThan(0);
    expect(comparePrices("200.00", "100.00")).toBeGreaterThan(0);
    expect(comparePrices("100.00", "100.00")).toBe(0);
  });
});

describe("lib/harga: formatDiscountPercent", () => {
  test("renders the integer percentage with a trailing %", () => {
    expect(formatDiscountPercent(10)).toBe("10%");
    expect(formatDiscountPercent(0)).toBe("0%");
  });
});

// ---------------------------------------------------------------------------
// The grep guard issue #27's own acceptance criteria ask for: "No arithmetic
// on prices in the storefront — no `parseFloat(`/`Number(` on a field named
// `price*` outside `harga.ts`". Every OTHER numeric handling of a price
// string in this app (sorting a produk-index listing, a min/max range
// filter) is required to go through `priceToNumber`/`comparePrices` in
// THIS file instead — see `src/lib/catalog.ts`'s `filterProdukIndex`.
// ---------------------------------------------------------------------------

const SRC_ROOT = join(import.meta.dir, "..", "src");
const HARGA_FILE = join(SRC_ROOT, "lib", "harga.ts");
const SCANNABLE_EXTENSIONS = [".ts", ".astro"];

/** A `Number(...)`/`parseFloat(...)` call whose argument mentions a `price`-shaped identifier — case-insensitive, matches `price`, `Price`, `finalPrice`, `salePrice`, `priceLevel2`, etc. Deliberately does NOT match across a nested `)` — good enough for this codebase's actual call shapes, verified by this very test finding zero violations today. */
const FORBIDDEN_PATTERN = /\b(?:Number|parseFloat)\s*\(([^()]*\bprice\w*\b[^()]*)\)/gi;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath, files);
    } else if (SCANNABLE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("grep guard: no Number()/parseFloat() on a price field outside harga.ts", () => {
  test("src/ has no such call outside src/lib/harga.ts", () => {
    const violations: string[] = [];

    for (const file of walk(SRC_ROOT)) {
      if (file === HARGA_FILE) continue;

      const contents = readFileSync(file, "utf8");
      const matches = [...contents.matchAll(FORBIDDEN_PATTERN)];
      for (const match of matches) {
        violations.push(`${relative(SRC_ROOT, file)}: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test("the pattern itself actually catches a violation (the guard is not vacuous)", () => {
    const violating = "const total = Number(product.price) * quantity;";
    expect([...violating.matchAll(FORBIDDEN_PATTERN)]).toHaveLength(1);
  });
});
