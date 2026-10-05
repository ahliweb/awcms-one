/**
 * The pure half of commerce's inventory adapter (Issue #282, ADR-0038): item
 * references, posting order, the cache value, the `ledger`-mode edit rule and
 * the refusal vocabulary. No database.
 */
import { describe, expect, test } from "bun:test";

import {
  COMMERCE_PRODUCT_ITEM_TYPE,
  COMMERCE_VARIANT_ITEM_TYPE,
  MAX_STOCK_CACHE_VALUE,
  cacheValueFromBalance,
  describeRefusal,
  isInventoryMode,
  isOutOfStock,
  quantityText,
  sortForPosting,
  stockItemFor,
  stockItemTarget,
  stockWriteRefused,
  type LedgerRefusalKind
} from "../src/modules/commerce/domain/commerce-inventory";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const V1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("item reference mapping", () => {
  test("a line with a variant is the variant's unit, otherwise the product's", () => {
    expect(stockItemFor({ productId: P1, variantId: V1 })).toEqual({
      itemType: COMMERCE_VARIANT_ITEM_TYPE,
      itemRef: V1
    });
    expect(stockItemFor({ productId: P1, variantId: null })).toEqual({
      itemType: COMMERCE_PRODUCT_ITEM_TYPE,
      itemRef: P1
    });
  });

  test("the references use the namespaced types the port documents", () => {
    expect(COMMERCE_VARIANT_ITEM_TYPE).toBe("commerce.variant");
    expect(COMMERCE_PRODUCT_ITEM_TYPE).toBe("commerce.product");
  });

  test("stockItemTarget inverts it, and refuses another module's item", () => {
    expect(
      stockItemTarget({ itemType: "commerce.variant", itemRef: V1 })
    ).toEqual({
      kind: "variant",
      id: V1
    });
    expect(
      stockItemTarget({ itemType: "commerce.product", itemRef: P1 })
    ).toEqual({
      kind: "product",
      id: P1
    });
    expect(stockItemTarget({ itemType: "pos.item", itemRef: P1 })).toBeNull();
  });
});

describe("posting order", () => {
  test("sorts by (itemType, itemRef, lineKey) byte-wise, so every process agrees", () => {
    const lines = [
      { item: stockItemFor({ productId: P2, variantId: null }), lineKey: "b" },
      { item: stockItemFor({ productId: P1, variantId: V1 }), lineKey: "a" },
      { item: stockItemFor({ productId: P1, variantId: null }), lineKey: "z" },
      { item: stockItemFor({ productId: P1, variantId: null }), lineKey: "c" }
    ];
    expect(
      sortForPosting(lines).map(
        (line) => `${line.item.itemType}:${line.item.itemRef}:${line.lineKey}`
      )
    ).toEqual([
      `commerce.product:${P1}:c`,
      `commerce.product:${P1}:z`,
      `commerce.product:${P2}:b`,
      `commerce.variant:${V1}:a`
    ]);
  });

  test("does not mutate its input and is stable for an already-sorted list", () => {
    const lines = [
      { item: stockItemFor({ productId: P1, variantId: null }), lineKey: "a" },
      { item: stockItemFor({ productId: P2, variantId: null }), lineKey: "a" }
    ];
    const copy = [...lines];
    expect(sortForPosting(lines)).toEqual(copy);
    expect(lines).toEqual(copy);
  });

  test("two orders touching the same items reach them in the same order whatever the cart order", () => {
    const forward = [P1, P2].map((id) => ({
      item: stockItemFor({ productId: id, variantId: null }),
      lineKey: id
    }));
    expect(sortForPosting(forward)).toEqual(
      sortForPosting([...forward].reverse())
    );
  });
});

describe("the cache value", () => {
  test("is GREATEST(0, floor(on-hand))", () => {
    expect(cacheValueFromBalance("0")).toBe(0);
    expect(cacheValueFromBalance("7")).toBe(7);
    expect(cacheValueFromBalance("7.999999")).toBe(7);
    expect(cacheValueFromBalance("0.5")).toBe(0);
    expect(cacheValueFromBalance("-3")).toBe(0);
    expect(cacheValueFromBalance("-0.5")).toBe(0);
  });

  test("clamps to the integer column's range", () => {
    expect(cacheValueFromBalance("99999999999999")).toBe(MAX_STOCK_CACHE_VALUE);
  });

  test("refuses text that is not a canonical decimal", () => {
    expect(() => cacheValueFromBalance("1e3")).toThrow();
    expect(() => cacheValueFromBalance("")).toThrow();
  });
});

describe("quantity text", () => {
  test("is a positive integer rendered as plain decimal text", () => {
    expect(quantityText(3)).toBe("3");
    expect(() => quantityText(0)).toThrow();
    expect(() => quantityText(-1)).toThrow();
    expect(() => quantityText(1.5)).toThrow();
  });
});

describe("ledger-mode stock edits (D6)", () => {
  test("counter mode never refuses", () => {
    expect(stockWriteRefused("counter", 50, 5)).toBe(false);
  });

  test("ledger mode refuses a change and accepts the unchanged value or an absent one", () => {
    expect(stockWriteRefused("ledger", 50, 5)).toBe(true);
    expect(stockWriteRefused("ledger", 5, 5)).toBe(false);
    expect(stockWriteRefused("ledger", undefined, 5)).toBe(false);
  });

  test("a create may only start at zero in ledger mode", () => {
    expect(stockWriteRefused("ledger", 0, 0)).toBe(false);
    expect(stockWriteRefused("ledger", 3, 0)).toBe(true);
  });
});

describe("refusal vocabulary", () => {
  const kinds: LedgerRefusalKind[] = [
    "insufficient_stock",
    "unit_mismatch",
    "quantity_out_of_range",
    "location_not_found",
    "location_inactive",
    "source_conflict"
  ];

  test("only insufficient_stock is the out-of-stock answer", () => {
    expect(kinds.filter(isOutOfStock)).toEqual(["insufficient_stock"]);
  });

  test("every kind has a sentence that names no identifier", () => {
    for (const kind of kinds) {
      const sentence = describeRefusal(kind);
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });

  test("the inventory modes are exactly counter and ledger", () => {
    expect(isInventoryMode("counter")).toBe(true);
    expect(isInventoryMode("ledger")).toBe(true);
    expect(isInventoryMode("both")).toBe(false);
  });
});
