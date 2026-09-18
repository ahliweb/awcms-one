/**
 * The wishlist sync merge rule (issue #90) — a PURE function of two item
 * lists, with no `window`/`localStorage`/`fetch` of its own, so it is
 * unit-tested with no DOM (`tests/wishlist-sinkron.test.ts`) exactly like
 * `wishlist-kontrak.ts`'s own pure operations.
 *
 * The rule (issue #90's own words): union of the local and server
 * wishlists by `productId`, keeping the EARLIEST `addedAt` on conflict —
 * whichever copy of a bookmark is older is the more honest "when did this
 * shopper actually add it" — capped at 200 items.
 *
 * This file works on the PLAIN item shape both `wishlist-kontrak.ts`'s
 * `WishlistItem` and `akun-klien.ts`'s `WishlistAkunItem` already share
 * field-for-field, so a caller passes either without conversion.
 */

export type WishlistSinkronItem = {
  productId: string;
  slug: string;
  name: string;
  price: string;
  image: { url: string; alt: string } | null;
  addedAt: string;
};

/** The cap issue #90 names — applied AFTER the union, keeping the 200 EARLIEST-added items (the ones a shopper has had on their list longest), never an arbitrary/insertion-order slice. */
export const WISHLIST_SYNC_MAX_ITEMS = 200;

/**
 * Merges `local` and `server` into one deduplicated-by-`productId` list,
 * keeping whichever copy of a shared item has the EARLIER `addedAt`, then
 * caps the result at {@link WISHLIST_SYNC_MAX_ITEMS} by dropping the
 * MOST-RECENTLY-added items first (a full list should still remember what a
 * shopper bookmarked longest ago, not what they happened to sync last).
 *
 * Pure: never mutates either argument; the order of items in the returned
 * array is ascending by `addedAt`.
 */
export function gabungkanWishlist<T extends WishlistSinkronItem>(local: T[], server: T[]): T[] {
  const byProductId = new Map<string, T>();

  for (const item of [...server, ...local]) {
    const existing = byProductId.get(item.productId);
    if (!existing) {
      byProductId.set(item.productId, item);
      continue;
    }

    const existingTime = Date.parse(existing.addedAt);
    const itemTime = Date.parse(item.addedAt);
    if (itemTime < existingTime) byProductId.set(item.productId, item);
  }

  return Array.from(byProductId.values())
    .sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt))
    .slice(0, WISHLIST_SYNC_MAX_ITEMS);
}
