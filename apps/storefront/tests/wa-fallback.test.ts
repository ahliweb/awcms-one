import { describe, expect, test } from "bun:test";
import { buildWhatsappCartMessage, buildWhatsappUrl } from "../src/lib/wa-fallback";
import { createEmptyCart, addOrMergeLine, type CartLine } from "../src/lib/keranjang-kontrak";

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    productId: "prod-1",
    variantId: null,
    slug: "produk-a",
    name: "Produk A",
    variantName: null,
    sku: "SKU-1",
    unitPrice: "10000.00",
    quantity: 2,
    minPurchase: 1,
    maxQuantity: 10,
    weightGrams: 500,
    image: null,
    serviceFormValues: null,
    flashSaleId: null,
    addedAt: "2026-09-16T00:00:00.000Z",
    ...overrides
  };
}

describe("buildWhatsappCartMessage", () => {
  test("an empty cart asks a generic question rather than listing nothing", () => {
    const message = buildWhatsappCartMessage(createEmptyCart("c1", "t0"), "BjekMart");
    expect(message).toContain("BjekMart");
    expect(message).not.toContain("Perkiraan subtotal");
  });

  test("lists every line with its quantity and name", () => {
    const cart = addOrMergeLine(createEmptyCart("c1", "t0"), line(), "t1");
    const message = buildWhatsappCartMessage(cart, "BjekMart");
    expect(message).toContain("2x Produk A");
  });

  test("includes the variant name when present", () => {
    const cart = addOrMergeLine(createEmptyCart("c1", "t0"), line({ variantName: "Pedas" }), "t1");
    expect(buildWhatsappCartMessage(cart, "BjekMart")).toContain("2x Produk A (Pedas)");
  });

  test("computes a display-only subtotal from unitPrice * quantity", () => {
    const cart = addOrMergeLine(createEmptyCart("c1", "t0"), line({ unitPrice: "10000.00", quantity: 3 }), "t1");
    const message = buildWhatsappCartMessage(cart, "BjekMart");
    // Normalise the locale formatter's own thin/no-break space between "Rp"
    // and the amount — `tests/katalog-harga.test.ts` asserts the same way.
    expect(message.replace(/\s/g, " ")).toContain("Rp 30.000");
  });
});

describe("buildWhatsappUrl", () => {
  test("strips non-digits from the number and URL-encodes the message", () => {
    const url = buildWhatsappUrl("+62 851-2868-8885", "Halo & terima kasih");
    expect(url).toBe("https://wa.me/6285128688885?text=Halo%20%26%20terima%20kasih");
  });
});
