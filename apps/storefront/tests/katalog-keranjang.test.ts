import { describe, expect, test } from "bun:test";
import {
  addOrMergeLine,
  countCartItems,
  createEmptyCart,
  KERANJANG_EVENT_NAME,
  KERANJANG_STORAGE_KEY,
  parseCart,
  removeLine,
  setLineQuantity,
  validateCartLine,
  type CartLine
} from "../src/lib/keranjang-kontrak";

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    productId: "prod-1",
    variantId: null,
    slug: "produk-a",
    name: "Produk A",
    variantName: null,
    sku: "SKU-1",
    unitPrice: "10000.00",
    quantity: 1,
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

describe("keranjang-kontrak: constants", () => {
  test("the storage key and event name are the contract issue #30 builds on", () => {
    expect(KERANJANG_STORAGE_KEY).toBe("awcms-one:keranjang:v1");
    expect(KERANJANG_EVENT_NAME).toBe("keranjang:berubah");
  });
});

describe("keranjang-kontrak: validateCartLine", () => {
  test("a well-shaped line round-trips", () => {
    expect(validateCartLine(line())).toEqual(line());
  });

  test("rejects a non-object", () => {
    expect(validateCartLine(null)).toBeNull();
    expect(validateCartLine("nope")).toBeNull();
    expect(validateCartLine(42)).toBeNull();
  });

  test("rejects a non-numeric(14,2) unitPrice", () => {
    expect(validateCartLine(line({ unitPrice: "not-a-price" }))).toBeNull();
    expect(validateCartLine(line({ unitPrice: "10.999" }))).toBeNull();
  });

  test("rejects a zero or negative quantity", () => {
    expect(validateCartLine(line({ quantity: 0 }))).toBeNull();
    expect(validateCartLine(line({ quantity: -1 }))).toBeNull();
  });

  test("rejects a non-integer quantity", () => {
    expect(validateCartLine(line({ quantity: 1.5 }))).toBeNull();
  });

  test("rejects a malformed addedAt", () => {
    expect(validateCartLine(line({ addedAt: "not-a-date" }))).toBeNull();
  });

  test("accepts a well-shaped image, rejects a malformed one", () => {
    expect(validateCartLine(line({ image: { url: "https://x/y.jpg", alt: "Alt" } }))?.image).toEqual({
      url: "https://x/y.jpg",
      alt: "Alt"
    });
    expect(validateCartLine(line({ image: { url: "https://x/y.jpg" } as never }))).toBeNull();
  });

  test("accepts service form values as a string-to-string map, rejects a non-string value", () => {
    expect(validateCartLine(line({ serviceFormValues: { catatan: "Tolong bungkus rapi" } }))).not.toBeNull();
    expect(validateCartLine(line({ serviceFormValues: { catatan: 123 as never } }))).toBeNull();
  });
});

describe("keranjang-kontrak: parseCart", () => {
  test("null/empty input means no cart, not an error", () => {
    expect(parseCart(null)).toBeNull();
    expect(parseCart(undefined)).toBeNull();
    expect(parseCart("")).toBeNull();
  });

  test("invalid JSON degrades to null", () => {
    expect(parseCart("{not json")).toBeNull();
  });

  test("a well-shaped cart round-trips", () => {
    const cart = { id: "cart-1", lines: [line()], updatedAt: "2026-09-16T00:00:00.000Z" };
    expect(parseCart(JSON.stringify(cart))).toEqual(cart);
  });

  test("drops individual malformed lines rather than voiding the whole cart", () => {
    const raw = JSON.stringify({
      id: "cart-1",
      lines: [line(), { not: "a line" }],
      updatedAt: "2026-09-16T00:00:00.000Z"
    });
    const cart = parseCart(raw);
    expect(cart?.lines).toHaveLength(1);
  });

  test("a missing top-level field yields null", () => {
    expect(parseCart(JSON.stringify({ lines: [] }))).toBeNull();
  });
});

describe("keranjang-kontrak: countCartItems", () => {
  test("sums quantities across lines", () => {
    const cart = createEmptyCart("c1", "2026-09-16T00:00:00.000Z");
    expect(countCartItems({ ...cart, lines: [line({ quantity: 2 }), line({ quantity: 3 })] })).toBe(5);
  });

  test("null cart is zero", () => {
    expect(countCartItems(null)).toBe(0);
  });
});

describe("keranjang-kontrak: addOrMergeLine", () => {
  test("appends a new line for a different configuration", () => {
    const cart = createEmptyCart("c1", "t0");
    const next = addOrMergeLine(cart, line(), "t1");
    expect(next.lines).toHaveLength(1);
    expect(next.updatedAt).toBe("t1");
  });

  test("merges quantities for the SAME product+variant+service-form+flash-sale configuration", () => {
    const cart = { ...createEmptyCart("c1", "t0"), lines: [line({ quantity: 2 })] };
    const next = addOrMergeLine(cart, line({ quantity: 3, maxQuantity: 10 }), "t1");
    expect(next.lines).toHaveLength(1);
    expect(next.lines[0]?.quantity).toBe(5);
  });

  test("a merge clamps to the incoming line's maxQuantity (the freshest stock snapshot)", () => {
    const cart = { ...createEmptyCart("c1", "t0"), lines: [line({ quantity: 8, maxQuantity: 10 })] };
    const next = addOrMergeLine(cart, line({ quantity: 5, maxQuantity: 10 }), "t1");
    expect(next.lines[0]?.quantity).toBe(10);
  });

  test("a different variantId does NOT merge — sits as a separate line", () => {
    const cart = { ...createEmptyCart("c1", "t0"), lines: [line({ variantId: "v1" })] };
    const next = addOrMergeLine(cart, line({ variantId: "v2" }), "t1");
    expect(next.lines).toHaveLength(2);
  });

  test("a merge keeps the EXISTING line's addedAt, not the incoming one", () => {
    const cart = { ...createEmptyCart("c1", "t0"), lines: [line({ addedAt: "first" })] };
    const next = addOrMergeLine(cart, line({ addedAt: "second" }), "t1");
    expect(next.lines[0]?.addedAt).toBe("first");
  });

  test("is pure — never mutates the input cart", () => {
    const cart = createEmptyCart("c1", "t0");
    const before = JSON.stringify(cart);
    addOrMergeLine(cart, line(), "t1");
    expect(JSON.stringify(cart)).toBe(before);
  });
});

describe("keranjang-kontrak: removeLine / setLineQuantity", () => {
  test("removeLine drops the line at the given index", () => {
    const cart = { ...createEmptyCart("c1", "t0"), lines: [line({ sku: "A" }), line({ sku: "B" })] };
    const next = removeLine(cart, 0, "t1");
    expect(next.lines.map((l) => l.sku)).toEqual(["B"]);
  });

  test("removeLine on an out-of-range index is a no-op", () => {
    const cart = { ...createEmptyCart("c1", "t0"), lines: [line()] };
    expect(removeLine(cart, 5, "t1")).toEqual(cart);
  });

  test("setLineQuantity clamps to [minPurchase, maxQuantity]", () => {
    const cart = { ...createEmptyCart("c1", "t0"), lines: [line({ minPurchase: 2, maxQuantity: 5 })] };
    expect(setLineQuantity(cart, 0, 1, "t1").lines[0]?.quantity).toBe(2);
    expect(setLineQuantity(cart, 0, 99, "t1").lines[0]?.quantity).toBe(5);
    expect(setLineQuantity(cart, 0, 3, "t1").lines[0]?.quantity).toBe(3);
  });

  test("setLineQuantity to zero or below removes the line", () => {
    const cart = { ...createEmptyCart("c1", "t0"), lines: [line()] };
    expect(setLineQuantity(cart, 0, 0, "t1").lines).toHaveLength(0);
  });
});

describe("keranjang-kontrak: idempotency key stability (issue #30)", () => {
  // `cart.id` doubles as `POST …/orders`' `idempotencyKey`
  // (`commerce-storefront-endpoints.md`) — it must survive every ordinary
  // cart edit unchanged, or a retried checkout submission after a quantity
  // tweak would be treated by the CMS as a DIFFERENT order rather than the
  // same one being retried.
  test("addOrMergeLine never changes cart.id", () => {
    const cart = createEmptyCart("stable-id", "t0");
    expect(addOrMergeLine(cart, line(), "t1").id).toBe("stable-id");
    expect(addOrMergeLine(addOrMergeLine(cart, line(), "t1"), line({ sku: "B" }), "t2").id).toBe("stable-id");
  });

  test("removeLine never changes cart.id", () => {
    const cart = { ...createEmptyCart("stable-id", "t0"), lines: [line()] };
    expect(removeLine(cart, 0, "t1").id).toBe("stable-id");
  });

  test("setLineQuantity never changes cart.id, even when it empties the cart", () => {
    const cart = { ...createEmptyCart("stable-id", "t0"), lines: [line()] };
    expect(setLineQuantity(cart, 0, 5, "t1").id).toBe("stable-id");
    expect(setLineQuantity(cart, 0, 0, "t1").id).toBe("stable-id");
  });

  test("parseCart round-trips the id unchanged", () => {
    const cart = { id: "stable-id", lines: [line()], updatedAt: "2026-09-16T00:00:00.000Z" };
    expect(parseCart(JSON.stringify(cart))?.id).toBe("stable-id");
  });
});
