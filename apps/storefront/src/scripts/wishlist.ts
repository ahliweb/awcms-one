/**
 * `/wishlist` page interactivity (issue #30) — renders the list from
 * `localStorage` (`wishlist-klien.ts`), with a remove button per item.
 * Distinct from `wishlist-tombol.ts` (the site-wide heart-button wiring
 * imported from `Header.astro`): that script toggles membership from
 * ANYWHERE a card renders one; this one is this ONE page's own listing.
 *
 * 2026-09 redesign (issue #167): each item now also renders a "Ke
 * keranjang" link (a real navigation to the product page — see
 * `itemMarkup`'s own comment for why this is not a direct `addToCart()`)
 * beside the existing remove button; storage/sync behaviour is unchanged.
 */
import { loadWishlist, removeFromWishlist } from "../lib/wishlist-klien";
import { WISHLIST_EVENT_NAME, WISHLIST_STORAGE_KEY, type WishlistItem } from "../lib/wishlist-kontrak";
import { formatPrice } from "../lib/harga";
import { pasangSinkronisasiWishlist, tulisKeAkunJikaMasuk } from "../lib/wishlist-akun-sync";

const root = document.querySelector<HTMLElement>("[data-wishlist-root]");
if (root) {
  const emptyEl = root.querySelector<HTMLElement>("[data-wishlist-empty]");
  const listEl = root.querySelector<HTMLUListElement>("[data-wishlist-items]");

  function itemMarkup(item: WishlistItem): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "card-wrap";

    const link = document.createElement("a");
    link.href = `/product/${item.slug}`;
    link.className = "card";

    if (item.image) {
      const img = document.createElement("img");
      img.src = item.image.url;
      img.alt = item.image.alt;
      img.loading = "lazy";
      img.width = 280;
      img.height = 280;
      img.className = "card-image";
      link.appendChild(img);
    }

    const title = document.createElement("h2");
    title.className = "card-title";
    title.textContent = item.name;
    link.appendChild(title);

    const price = document.createElement("p");
    price.className = "card-price";
    price.textContent = formatPrice(item.price);
    link.appendChild(price);

    li.appendChild(link);

    // 2026-09 redesign (issue #167): "Ke keranjang" + remove, as SIBLINGS of
    // the card link (never nested inside it — an `<a>`/`<button>` inside an
    // `<a>` is invalid interactive-in-interactive content, the same rule
    // `ProductCard.astro`'s own wishlist button already follows). "Ke
    // keranjang" is a real navigation to the product page, not a direct
    // `addToCart()`: `WishlistItem` carries no `minPurchase`/`maxQuantity`/
    // `sku` snapshot (see `wishlist-kontrak.ts`'s own docblock on why a
    // wishlist entry is a thinner snapshot than a `CartLine`), so there is
    // no honest quantity/stock to add without re-fetching — the product
    // page is where that add already happens correctly.
    const actions = document.createElement("div");
    actions.className = "wishlist-grid-actions";

    const toCartLink = document.createElement("a");
    toCartLink.href = `/product/${item.slug}`;
    toCartLink.className = "btn btn--primary btn--sm";
    toCartLink.textContent = "Ke keranjang";
    actions.appendChild(toCartLink);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "wishlist-button wishlist-button--active";
    removeButton.setAttribute("aria-label", `Hapus ${item.name} dari wishlist`);
    removeButton.innerHTML = '<span aria-hidden="true">♥</span>';
    removeButton.addEventListener("click", () => {
      removeFromWishlist(item.productId);
      render();
      void tulisKeAkunJikaMasuk(item.productId, false);
    });
    actions.appendChild(removeButton);

    li.appendChild(actions);
    return li;
  }

  function render(): void {
    const wishlist = loadWishlist();

    if (!listEl) return;
    listEl.innerHTML = "";

    if (wishlist.items.length === 0) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }

    if (emptyEl) emptyEl.hidden = true;
    for (const item of wishlist.items) {
      listEl.appendChild(itemMarkup(item));
    }
  }

  render();

  window.addEventListener(WISHLIST_EVENT_NAME, render);
  window.addEventListener("storage", (event) => {
    if (event.key === WISHLIST_STORAGE_KEY) render();
  });
  // Header.astro's wishlist-tombol.ts already wires this on every page, but
  // `/wishlist` renders this list even for a shopper who arrived here with
  // JavaScript that has not yet re-run that mount (e.g. a bfcache restore) —
  // idempotent, see `pasangSinkronisasiWishlist`'s own docblock.
  pasangSinkronisasiWishlist();
}
