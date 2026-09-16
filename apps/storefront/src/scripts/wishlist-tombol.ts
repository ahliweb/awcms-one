/**
 * Site-wide wishlist heart-button wiring — imported once from
 * `Header.astro` (loaded on every page via `BaseLayout.astro`, the same way
 * that file already imports `keranjang-hitung.ts` for the cart-count badge)
 * rather than from every page that happens to render a `ProductCard`.
 *
 * Event DELEGATION on `document`, not one listener per button: a page's
 * product cards are static HTML (`ProductCard.astro`, server-rendered), but
 * this same button also needs to work correctly if a future page renders
 * cards client-side after this script has already run — delegation costs
 * nothing extra today and is correct either way, the same trade
 * `cari-listing.ts`'s own client-rendered cards already accepted for a
 * different reason (kept markup-compatible with `ProductCard.astro`, see
 * that file's docblock).
 *
 * Every `[data-wishlist]` button carries the product's own display
 * snapshot as data attributes (`data-product-id/-slug/-name/-price`, and
 * `data-image-url`/`data-image-alt` when the product has one) — set once by
 * `ProductCard.astro` at render time — so toggling needs no second fetch and
 * no re-reading of `data-produk-detail`-style JSON.
 */
import {
  isWishlisted,
  WISHLIST_EVENT_NAME,
  WISHLIST_STORAGE_KEY,
  type WishlistItem
} from "../lib/wishlist-kontrak";
import { loadWishlist, toggleWishlist } from "../lib/wishlist-klien";

const BUTTON_SELECTOR = "[data-wishlist]";

function itemFromButton(button: HTMLElement): WishlistItem | null {
  const productId = button.dataset.productId;
  const slug = button.dataset.slug;
  const name = button.dataset.name;
  const price = button.dataset.price;

  if (!productId || !slug || !name || !price) return null;

  const imageUrl = button.dataset.imageUrl;
  const imageAlt = button.dataset.imageAlt;

  return {
    productId,
    slug,
    name,
    price,
    image: imageUrl ? { url: imageUrl, alt: imageAlt ?? name } : null,
    addedAt: new Date().toISOString()
  };
}

function renderButtonState(button: HTMLElement, wishlisted: boolean): void {
  button.setAttribute("aria-pressed", String(wishlisted));
  button.classList.toggle("wishlist-button--active", wishlisted);
  const label = wishlisted ? "Hapus dari wishlist" : "Tambah ke wishlist";
  button.setAttribute("aria-label", label);
  button.title = label;

  const glyph = button.querySelector("[aria-hidden]");
  if (glyph) glyph.textContent = wishlisted ? "♥" : "♡";
}

function refreshAllButtons(): void {
  const wishlist = loadWishlist();
  for (const button of document.querySelectorAll<HTMLElement>(BUTTON_SELECTOR)) {
    const productId = button.dataset.productId;
    if (!productId) continue;
    renderButtonState(button, isWishlisted(wishlist, productId));
  }
}

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLElement>(BUTTON_SELECTOR);
  if (!button) return;

  event.preventDefault();

  const item = itemFromButton(button);
  if (!item) return;

  const next = toggleWishlist(item);
  renderButtonState(button, isWishlisted(next, item.productId));
});

window.addEventListener(WISHLIST_EVENT_NAME, refreshAllButtons);
window.addEventListener("storage", (event) => {
  if (event.key === WISHLIST_STORAGE_KEY) refreshAllButtons();
});

refreshAllButtons();
