/**
 * `/wishlist` page interactivity (issue #30) — renders the list from
 * `localStorage` (`wishlist-klien.ts`), with a remove button per item.
 * Distinct from `wishlist-tombol.ts` (the site-wide heart-button wiring
 * imported from `Header.astro`): that script toggles membership from
 * ANYWHERE a card renders one; this one is this ONE page's own listing.
 */
import { loadWishlist, removeFromWishlist } from "../lib/wishlist-klien";
import { WISHLIST_EVENT_NAME, WISHLIST_STORAGE_KEY, type WishlistItem } from "../lib/wishlist-kontrak";
import { formatPrice } from "../lib/harga";

const root = document.querySelector<HTMLElement>("[data-wishlist-root]");
if (root) {
  const emptyEl = root.querySelector<HTMLElement>("[data-wishlist-empty]");
  const listEl = root.querySelector<HTMLUListElement>("[data-wishlist-items]");

  function itemMarkup(item: WishlistItem): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "card-wrap";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "wishlist-button wishlist-button--active";
    removeButton.setAttribute("aria-label", `Hapus ${item.name} dari wishlist`);
    removeButton.innerHTML = '<span aria-hidden="true">♥</span>';
    removeButton.addEventListener("click", () => {
      removeFromWishlist(item.productId);
      render();
    });
    li.appendChild(removeButton);

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
}
