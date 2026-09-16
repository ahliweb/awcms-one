/**
 * `/cari` client-side search — replaces the increment-1/#24 placeholder body
 * ("hasil akan muncul di sini") with a real, client-side search over the
 * same build-time index `/produk`'s listing uses (`/index/produk.json`).
 * `?q=` is read from `window.location.search`, never `Astro.url` — this page
 * is prerendered ONCE (`output: "static"`), so the query string can only
 * ever be read in the browser (see `cari.astro`'s own docblock).
 *
 * Pagination is URL-synced (`?halaman=`) the same way `/produk`'s does, so a
 * search result page is bookmarkable and back/forward both work.
 */
import { fetchProdukIndex, renderProdukGrid, renderPagination } from "./produk-index-klien";
import { filterProdukIndex, paginateProdukIndex } from "../lib/catalog";

const grid = document.querySelector<HTMLElement>("[data-produk-grid]");
const emptyState = document.querySelector<HTMLElement>("[data-produk-empty]");
const paginationEl = document.querySelector<HTMLElement>("[data-produk-pagination]");
const heading = document.querySelector<HTMLElement>("[data-search-heading]");

function currentQuery(): string {
  return new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
}

function currentPage(): number {
  const raw = new URLSearchParams(window.location.search).get("halaman");
  const parsed = raw ? Number(raw) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

if (grid) {
  // A `const` alias so TypeScript's null-narrowing survives into the nested
  // closures below — narrowing an outer `const` does not carry into a
  // function body declared after the check.
  const gridEl = grid;
  const q = currentQuery();

  const input = document.getElementById("page-search-q");
  if (input instanceof HTMLInputElement && q) input.value = q;

  async function run(page: number): Promise<void> {
    if (!q) {
      gridEl.hidden = true;
      if (emptyState) {
        emptyState.hidden = false;
        emptyState.textContent = "Ketik kata kunci untuk mencari produk.";
      }
      return;
    }

    if (heading) heading.textContent = `Hasil pencarian untuk "${q}"`;

    const items = await fetchProdukIndex();
    const filtered = filterProdukIndex(items, { q });
    const paged = paginateProdukIndex(filtered, page);

    if (emptyState) emptyState.textContent = `Tidak ditemukan produk untuk "${q}".`;
    renderProdukGrid(gridEl, paged.items, emptyState);

    if (paginationEl) {
      renderPagination(paginationEl, paged.page, paged.totalPages, (nextPage) => {
        const next = new URLSearchParams(window.location.search);
        next.set("halaman", String(nextPage));
        window.history.pushState(null, "", `?${next.toString()}`);
        void run(nextPage);
        gridEl.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  window.addEventListener("popstate", () => void run(currentPage()));

  void run(currentPage());
}
