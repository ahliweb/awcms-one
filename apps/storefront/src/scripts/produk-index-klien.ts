/**
 * Shared browser-side plumbing for `/produk` and `/cari`: fetching the
 * build-time search index (`/index/produk.json`) once, and rendering a
 * result grid + pagination from it. `src/scripts/produk-listing.ts`
 * (`/produk`'s sidebar filters) and `src/scripts/cari-listing.ts`
 * (`/cari`'s query box) both import this rather than duplicating the
 * card/pagination markup — "what a produk-index row looks like as HTML" is
 * decided exactly once.
 *
 * Every filter/sort/paginate DECISION still comes from `src/lib/catalog.ts`
 * (`filterProdukIndex`/`paginateProdukIndex`) — this file only turns the
 * result into DOM.
 */
import { formatPrice } from "../lib/harga";
import { labelClassName, type ProdukIndexEntry } from "../lib/catalog";

let indexPromise: Promise<ProdukIndexEntry[]> | undefined;

/** Fetches `/index/produk.json` once per page load and caches the result — every filter/sort/page change re-uses the same snapshot rather than re-fetching. */
export function fetchProdukIndex(): Promise<ProdukIndexEntry[]> {
  indexPromise ??= fetch("/index/produk.json")
    .then((response) => {
      if (!response.ok) {
        throw new Error(`/index/produk.json responded ${response.status}`);
      }
      return response.json() as Promise<ProdukIndexEntry[]>;
    })
    .catch((error) => {
      // A failed fetch degrades to "no results" rather than an unhandled
      // rejection breaking every control on the page — the SSR'd first
      // page (produced at build time, already in the DOM) stays visible.
      console.warn(`[katalog] could not load /index/produk.json: ${String(error)}`);
      return [];
    });

  return indexPromise;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cardHtml(item: ProdukIndexEntry): string {
  const badgeClass = labelClassName(item.labelColor);
  const inStock = item.stock > 0;
  const image = item.image
    ? `<img src="${escapeHtml(item.image.url)}" alt="${escapeHtml(item.image.alt)}" loading="lazy" width="280" height="280" class="card-image" />`
    : `<span class="card-image-placeholder" aria-hidden="true"></span>`;
  const flashBadge = item.inFlashSale ? `<span class="flash-badge">Flash Sale</span>` : "";

  return `
    <li>
      <a href="/product/${encodeURIComponent(item.slug)}" class="card">
        ${image}
        ${item.categoryName ? `<span class="card-eyebrow">${escapeHtml(item.categoryName)}</span>` : ""}
        <h2 class="card-title">${escapeHtml(item.name)}</h2>
        ${item.label ? `<span class="label-badge ${badgeClass ?? ""}">${escapeHtml(item.label)}</span>` : ""}
        ${flashBadge}
        <p class="card-price">${escapeHtml(formatPrice(item.finalPrice))}</p>
        <span class="stock-badge ${inStock ? "stock-badge--in" : "stock-badge--out"}">
          ${inStock ? "Stok tersedia" : "Stok habis"}
        </span>
      </a>
    </li>`;
}

/** Replaces `grid`'s content with one card per `items` entry, and toggles `emptyState` (if given) when there are none. */
export function renderProdukGrid(
  grid: HTMLElement,
  items: readonly ProdukIndexEntry[],
  emptyState?: HTMLElement | null
): void {
  grid.innerHTML = items.map(cardHtml).join("");
  grid.hidden = items.length === 0;
  if (emptyState) emptyState.hidden = items.length !== 0;
}

/** Renders a simple numbered pager into `container` — each page a `<button data-page="N">`, the current page marked `aria-current="page"` and disabled. `onPageChange` is called with the 1-based page number clicked. */
export function renderPagination(
  container: HTMLElement,
  page: number,
  totalPages: number,
  onPageChange: (page: number) => void
): void {
  if (totalPages <= 1) {
    container.innerHTML = "";
    return;
  }

  const buttons: string[] = [];
  for (let candidate = 1; candidate <= totalPages; candidate += 1) {
    const isCurrent = candidate === page;
    buttons.push(
      `<button type="button" data-page="${candidate}" ${isCurrent ? 'aria-current="page" disabled' : ""}>${candidate}</button>`
    );
  }

  container.innerHTML = buttons.join("");
  container.querySelectorAll<HTMLButtonElement>("button[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = Number(button.dataset.page);
      if (Number.isFinite(target)) onPageChange(target);
    });
  });
}
