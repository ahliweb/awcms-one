import { describe, expect, test } from "bun:test";
import { gabungkanWishlist, WISHLIST_SYNC_MAX_ITEMS, type WishlistSinkronItem } from "../src/lib/wishlist-sinkron";

function item(productId: string, addedAt: string): WishlistSinkronItem {
  return { productId, slug: productId, name: productId, price: "10000.00", image: null, addedAt };
}

describe("gabungkanWishlist — issue #90's pure merge rule", () => {
  test("unions two disjoint lists", () => {
    const local = [item("a", "2026-01-01T00:00:00.000Z")];
    const server = [item("b", "2026-01-02T00:00:00.000Z")];

    const merged = gabungkanWishlist(local, server);

    expect(merged.map((i) => i.productId).sort()).toEqual(["a", "b"]);
  });

  test("keeps the EARLIEST addedAt when both sides have the same productId", () => {
    const local = [item("a", "2026-02-01T00:00:00.000Z")];
    const server = [item("a", "2026-01-01T00:00:00.000Z")];

    const merged = gabungkanWishlist(local, server);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.addedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("keeps the earliest addedAt regardless of which side (local/server) is earlier", () => {
    const local = [item("a", "2026-01-01T00:00:00.000Z")];
    const server = [item("a", "2026-02-01T00:00:00.000Z")];

    const merged = gabungkanWishlist(local, server);

    expect(merged[0]?.addedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("is a pure function — never mutates either input array", () => {
    const local = [item("a", "2026-01-01T00:00:00.000Z")];
    const server = [item("b", "2026-01-02T00:00:00.000Z")];
    const localCopy = [...local];
    const serverCopy = [...server];

    gabungkanWishlist(local, server);

    expect(local).toEqual(localCopy);
    expect(server).toEqual(serverCopy);
  });

  test("caps the result at 200 items, keeping the 200 EARLIEST-added", () => {
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const local = Array.from({ length: 250 }, (_, i) => item(`p${i}`, new Date(base + i * 1000).toISOString()));

    const merged = gabungkanWishlist(local, []);

    expect(merged).toHaveLength(WISHLIST_SYNC_MAX_ITEMS);
    // The kept items are the 200 EARLIEST (p0..p199), never the latest.
    expect(merged.map((i) => i.productId)).toContain("p0");
    expect(merged.map((i) => i.productId)).not.toContain("p249");
  });

  test("an empty local list plus a non-empty server list returns the server list (bounded by the cap)", () => {
    const server = [item("a", "2026-01-01T00:00:00.000Z"), item("b", "2026-01-02T00:00:00.000Z")];

    const merged = gabungkanWishlist([], server);

    expect(merged).toHaveLength(2);
  });

  test("returns items sorted ascending by addedAt", () => {
    const local = [item("b", "2026-01-02T00:00:00.000Z"), item("a", "2026-01-01T00:00:00.000Z")];

    const merged = gabungkanWishlist(local, []);

    expect(merged.map((i) => i.productId)).toEqual(["a", "b"]);
  });
});
