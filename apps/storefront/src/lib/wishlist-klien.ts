/**
 * The browser-only wishlist client — `localStorage` read/write and the
 * `CustomEvent` dispatch, built entirely out of `src/lib/wishlist-kontrak.ts`'s
 * pure functions. Mirrors `keranjang-klien.ts` exactly, for the same reason:
 * never imported from `.astro` frontmatter (no `window` at build time),
 * only from a `<script>` block Astro bundles into an external module.
 */
import {
  createEmptyWishlist,
  parseWishlist,
  toggleWishlistItem,
  WISHLIST_EVENT_NAME,
  WISHLIST_STORAGE_KEY,
  type Wishlist,
  type WishlistItem
} from "./wishlist-kontrak";

/** The current wishlist, or a fresh empty one — never throws, never `null`. */
export function loadWishlist(): Wishlist {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(WISHLIST_STORAGE_KEY);
  } catch {
    // A private window or blocked storage reads the same as "no wishlist".
  }

  return parseWishlist(raw) ?? createEmptyWishlist();
}

/** Persists `wishlist` and notifies every listener on this page (`WISHLIST_EVENT_NAME`) — every heart button re-checks its own state on this event. */
export function saveWishlist(wishlist: Wishlist): void {
  try {
    window.localStorage.setItem(WISHLIST_STORAGE_KEY, JSON.stringify(wishlist));
  } catch {
    // A full/blocked storage means this write did not persist — the caller's
    // own UI is what surfaces that, not this file.
    return;
  }

  window.dispatchEvent(new CustomEvent(WISHLIST_EVENT_NAME, { detail: wishlist }));
}

/** Toggles one item on/off the wishlist and persists the result — the heart button's whole click handler. */
export function toggleWishlist(item: WishlistItem): Wishlist {
  const wishlist = loadWishlist();
  const next = toggleWishlistItem(wishlist, item);
  saveWishlist(next);
  return next;
}

/** Removes one item by product id and persists the result — `/wishlist`'s own remove button (which already knows the id, unlike the heart button's toggle). */
export function removeFromWishlist(productId: string): Wishlist {
  const wishlist = loadWishlist();
  const next = { items: wishlist.items.filter((item) => item.productId !== productId) };
  saveWishlist(next);
  return next;
}
