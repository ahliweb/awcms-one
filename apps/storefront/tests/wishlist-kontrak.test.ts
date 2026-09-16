import { describe, expect, test } from "bun:test";
import {
  addWishlistItem,
  createEmptyWishlist,
  isWishlisted,
  parseWishlist,
  removeWishlistItem,
  toggleWishlistItem,
  validateWishlistItem,
  WISHLIST_EVENT_NAME,
  WISHLIST_STORAGE_KEY,
  type WishlistItem
} from "../src/lib/wishlist-kontrak";

function item(overrides: Partial<WishlistItem> = {}): WishlistItem {
  return {
    productId: "prod-1",
    slug: "produk-a",
    name: "Produk A",
    price: "10000.00",
    image: null,
    addedAt: "2026-09-16T00:00:00.000Z",
    ...overrides
  };
}

describe("wishlist-kontrak: constants", () => {
  test("storage key and event name", () => {
    expect(WISHLIST_STORAGE_KEY).toBe("awcms-one:wishlist:v1");
    expect(WISHLIST_EVENT_NAME).toBe("wishlist:berubah");
  });
});

describe("wishlist-kontrak: validateWishlistItem", () => {
  test("a well-shaped item round-trips", () => {
    expect(validateWishlistItem(item())).toEqual(item());
  });

  test("rejects a non-object", () => {
    expect(validateWishlistItem(null)).toBeNull();
    expect(validateWishlistItem("nope")).toBeNull();
  });

  test("rejects a non-numeric(14,2) price", () => {
    expect(validateWishlistItem(item({ price: "free" }))).toBeNull();
  });

  test("rejects a malformed addedAt", () => {
    expect(validateWishlistItem(item({ addedAt: "not-a-date" }))).toBeNull();
  });

  test("accepts a well-shaped image, rejects a malformed one", () => {
    expect(validateWishlistItem(item({ image: { url: "https://x/y.jpg", alt: "Alt" } }))?.image).toEqual({
      url: "https://x/y.jpg",
      alt: "Alt"
    });
    expect(validateWishlistItem(item({ image: { url: "https://x/y.jpg" } as never }))).toBeNull();
  });
});

describe("wishlist-kontrak: parseWishlist", () => {
  test("null/empty input means no wishlist", () => {
    expect(parseWishlist(null)).toBeNull();
    expect(parseWishlist("")).toBeNull();
  });

  test("invalid JSON degrades to null", () => {
    expect(parseWishlist("{not json")).toBeNull();
  });

  test("drops individual malformed items rather than voiding the whole list", () => {
    const raw = JSON.stringify({ items: [item(), { not: "an item" }] });
    expect(parseWishlist(raw)?.items).toHaveLength(1);
  });
});

describe("wishlist-kontrak: isWishlisted / add / remove / toggle", () => {
  test("isWishlisted is false for an empty/null wishlist", () => {
    expect(isWishlisted(null, "prod-1")).toBe(false);
    expect(isWishlisted(createEmptyWishlist(), "prod-1")).toBe(false);
  });

  test("addWishlistItem adds, and is a no-op for an already-present product (no quantity, no duplicate)", () => {
    const wishlist = addWishlistItem(createEmptyWishlist(), item());
    expect(wishlist.items).toHaveLength(1);

    const again = addWishlistItem(wishlist, item({ addedAt: "2026-09-17T00:00:00.000Z" }));
    expect(again).toEqual(wishlist);
  });

  test("removeWishlistItem removes, and is a no-op when absent", () => {
    const wishlist = addWishlistItem(createEmptyWishlist(), item());
    expect(removeWishlistItem(wishlist, "prod-1").items).toHaveLength(0);
    expect(removeWishlistItem(createEmptyWishlist(), "prod-1")).toEqual(createEmptyWishlist());
  });

  test("toggleWishlistItem adds when absent, removes when present", () => {
    const added = toggleWishlistItem(createEmptyWishlist(), item());
    expect(isWishlisted(added, "prod-1")).toBe(true);

    const removed = toggleWishlistItem(added, item());
    expect(isWishlisted(removed, "prod-1")).toBe(false);
  });

  test("every operation is pure — never mutates its input", () => {
    const wishlist = createEmptyWishlist();
    const before = JSON.stringify(wishlist);
    addWishlistItem(wishlist, item());
    expect(JSON.stringify(wishlist)).toBe(before);
  });
});
