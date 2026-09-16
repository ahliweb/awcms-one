/**
 * The wishlist contract — shape, storage key, event name, and every PURE
 * operation on a wishlist, built on the same pattern `keranjang-kontrak.ts`
 * (#27/#30's cart) already established: a plain function of its arguments
 * (no `window`, no `localStorage`) so it is unit-testable with no DOM, and a
 * thin browser-only wrapper (`wishlist-klien.ts`) built entirely out of what
 * is exported here.
 *
 * A wishlist item snapshots enough of a product to RENDER `/wishlist`
 * without a second network round-trip or a re-fetch of the build-time
 * catalog index — `name`/`price`/`image` are display-only and may drift
 * from the live catalog between a visit and the next (the same trade
 * `CartLine.unitPrice` already makes, and for the same reason: this is a
 * static site with no live CMS connection from the browser except the
 * anonymous commerce endpoints `src/lib/toko-klien.ts` calls, none of which
 * exist to re-price an idle wishlist item). Unlike the cart, a wishlist
 * entry is NEVER re-quoted — it carries no purchase intent of its own; it
 * is a bookmark, and a shopper who acts on it lands on the real product
 * page, which fetches nothing stale.
 */

/** `localStorage` key — namespaced under the same `awcms-one:` prefix as the cart (`keranjang-kontrak.ts`), versioned the same way. */
export const WISHLIST_STORAGE_KEY = "awcms-one:wishlist:v1";

/** `CustomEvent` name dispatched on `window` after every write — `src/scripts/wishlist-tombol.ts` (every heart button, site-wide) listens for this to keep every button showing the same product in sync, and the native `storage` event covers a write from another tab. */
export const WISHLIST_EVENT_NAME = "wishlist:berubah";

/** Same `numeric(14,2)` guard `keranjang-kontrak.ts`'s `PRICE_PATTERN` uses — a corrupted/tampered `localStorage` value is rejected rather than trusted. */
const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export type WishlistItem = {
  productId: string;
  slug: string;
  name: string;
  /** `numeric(14,2)` string, the price shown AT THE MOMENT this was added — display-only, see this file's own docblock. */
  price: string;
  image: { url: string; alt: string } | null;
  addedAt: string;
};

export type Wishlist = {
  items: WishlistItem[];
};

export function createEmptyWishlist(): Wishlist {
  return { items: [] };
}

/** Validates one candidate item, returning `null` (never throwing) for anything malformed — dropped rather than voiding the whole list, the same posture `keranjang-kontrak.ts`'s `validateCartLine` takes. */
export function validateWishlistItem(value: unknown): WishlistItem | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.productId !== "string" || candidate.productId.length === 0) return null;
  if (typeof candidate.slug !== "string" || candidate.slug.length === 0) return null;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) return null;
  if (typeof candidate.price !== "string" || !PRICE_PATTERN.test(candidate.price)) return null;
  if (!isIsoDateString(candidate.addedAt)) return null;

  if (candidate.image !== null) {
    if (typeof candidate.image !== "object") return null;
    const image = candidate.image as Record<string, unknown>;
    if (typeof image.url !== "string" || typeof image.alt !== "string") return null;
  }

  return {
    productId: candidate.productId,
    slug: candidate.slug,
    name: candidate.name,
    price: candidate.price,
    image: candidate.image as WishlistItem["image"],
    addedAt: candidate.addedAt
  };
}

/** Parses a raw `localStorage` string into a {@link Wishlist}, or `null` for anything not at least a well-shaped `{items}` object — mirrors `keranjang-kontrak.ts`'s `parseCart`. */
export function parseWishlist(raw: string | null | undefined): Wishlist | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (!Array.isArray(candidate.items)) return null;

  const items: WishlistItem[] = [];
  for (const entry of candidate.items) {
    const item = validateWishlistItem(entry);
    if (item) items.push(item);
  }

  return { items };
}

/** Whether `productId` is already on the wishlist — the heart button's own initial-state check. */
export function isWishlisted(wishlist: Wishlist | null, productId: string): boolean {
  return (wishlist?.items ?? []).some((item) => item.productId === productId);
}

/** Adds `item`, or returns `wishlist` UNCHANGED if `item.productId` is already present — a wishlist has no quantity, so re-adding is a no-op rather than a duplicate row. Pure: never mutates `wishlist`. */
export function addWishlistItem(wishlist: Wishlist, item: WishlistItem): Wishlist {
  if (isWishlisted(wishlist, item.productId)) return wishlist;
  return { items: [...wishlist.items, item] };
}

/** Removes the item for `productId`, or returns `wishlist` unchanged if it is not present — never throws. */
export function removeWishlistItem(wishlist: Wishlist, productId: string): Wishlist {
  if (!isWishlisted(wishlist, productId)) return wishlist;
  return { items: wishlist.items.filter((item) => item.productId !== productId) };
}

/** Adds `item` if absent, removes it if present — the heart button's single click handler. */
export function toggleWishlistItem(wishlist: Wishlist, item: WishlistItem): Wishlist {
  return isWishlisted(wishlist, item.productId)
    ? removeWishlistItem(wishlist, item.productId)
    : addWishlistItem(wishlist, item);
}
