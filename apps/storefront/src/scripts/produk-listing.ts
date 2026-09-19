/**
 * `/produk` client-side refine: sidebar category filter, sort, price range,
 * "in stock only", "flash sale only", and pagination — all over the SAME
 * build-time index `src/profil/toko/pages/index/produk.json.ts` serves, all URL-synced
 * (`?halaman=&kategori=&urut=&stok=&flash=&hargaMin=&hargaMax=`) via
 * `history.pushState` so a refined view is bookmarkable/shareable and the
 * back/forward buttons work.
 *
 * The page's build-time HTML (produced by `produk.astro` itself, unfiltered,
 * sort=newest, page 1) is what a crawler or a no-JS visitor sees; this
 * script REPLACES that grid the moment it runs, using the URL's own query
 * string as the starting state — so a shared filtered link renders filtered
 * on first paint once JS is available, not just after an interaction.
 */
import { fetchProdukIndex, renderProdukGrid, renderPagination } from "./produk-index-klien";
import {
  filterProdukIndex,
  paginateProdukIndex,
  type ProdukIndexFilter,
  type ProductSort
} from "../lib/catalog";

type ListingState = {
  page: number;
  categorySlug?: string;
  sort?: ProductSort;
  inStockOnly?: boolean;
  flashSaleOnly?: boolean;
  minPrice?: number;
  maxPrice?: number;
};

const KNOWN_SORTS: readonly ProductSort[] = ["newest", "price_asc", "price_desc", "name"];

function isProductSort(value: string | null): value is ProductSort {
  return value !== null && (KNOWN_SORTS as readonly string[]).includes(value);
}

function parseNumberParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readStateFromUrl(): ListingState {
  const params = new URLSearchParams(window.location.search);
  const sortParam = params.get("urut");

  return {
    page: parseNumberParam(params.get("halaman")) ?? 1,
    categorySlug: params.get("kategori") ?? undefined,
    sort: isProductSort(sortParam) ? sortParam : undefined,
    inStockOnly: params.get("stok") === "1",
    flashSaleOnly: params.get("flash") === "1",
    minPrice: parseNumberParam(params.get("hargaMin")),
    maxPrice: parseNumberParam(params.get("hargaMax"))
  };
}

function writeStateToUrl(state: ListingState): void {
  const params = new URLSearchParams();
  if (state.page > 1) params.set("halaman", String(state.page));
  if (state.categorySlug) params.set("kategori", state.categorySlug);
  if (state.sort && state.sort !== "newest") params.set("urut", state.sort);
  if (state.inStockOnly) params.set("stok", "1");
  if (state.flashSaleOnly) params.set("flash", "1");
  if (state.minPrice !== undefined) params.set("hargaMin", String(state.minPrice));
  if (state.maxPrice !== undefined) params.set("hargaMax", String(state.maxPrice));

  const query = params.toString();
  const url = query ? `${window.location.pathname}?${query}` : window.location.pathname;
  window.history.pushState(null, "", url);
}

const grid = document.querySelector<HTMLElement>("[data-produk-grid]");
const emptyState = document.querySelector<HTMLElement>("[data-produk-empty]");
const paginationEl = document.querySelector<HTMLElement>("[data-produk-pagination]");
const countEl = document.querySelector<HTMLElement>("[data-produk-count]");
const form = document.querySelector<HTMLFormElement>("[data-produk-filters]");

if (grid && form) {
  // A `const` alias so TypeScript's null-narrowing survives into the nested
  // closures below — same reasoning as `cari-listing.ts`'s `gridEl`.
  const gridEl = grid;
  const sortSelect = form.querySelector<HTMLSelectElement>("[data-filter-sort]");
  const stockCheckbox = form.querySelector<HTMLInputElement>("[data-filter-stock]");
  const flashCheckbox = form.querySelector<HTMLInputElement>("[data-filter-flash]");
  const minInput = form.querySelector<HTMLInputElement>("[data-filter-price-min]");
  const maxInput = form.querySelector<HTMLInputElement>("[data-filter-price-max]");
  const categoryLinks = Array.from(
    form.querySelectorAll<HTMLAnchorElement>("[data-filter-category]")
  );

  function syncControlsToState(state: ListingState): void {
    if (sortSelect) sortSelect.value = state.sort ?? "newest";
    if (stockCheckbox) stockCheckbox.checked = Boolean(state.inStockOnly);
    if (flashCheckbox) flashCheckbox.checked = Boolean(state.flashSaleOnly);
    if (minInput) minInput.value = state.minPrice !== undefined ? String(state.minPrice) : "";
    if (maxInput) maxInput.value = state.maxPrice !== undefined ? String(state.maxPrice) : "";

    for (const link of categoryLinks) {
      const isCurrent = (link.dataset.filterCategory ?? "") === (state.categorySlug ?? "");
      link.setAttribute("aria-current", isCurrent ? "true" : "false");
    }
  }

  async function render(state: ListingState): Promise<void> {
    const items = await fetchProdukIndex();
    const filter: ProdukIndexFilter = {
      categorySlug: state.categorySlug,
      sort: state.sort,
      inStockOnly: state.inStockOnly,
      flashSaleOnly: state.flashSaleOnly,
      minPrice: state.minPrice,
      maxPrice: state.maxPrice
    };

    const filtered = filterProdukIndex(items, filter);
    const paged = paginateProdukIndex(filtered, state.page);

    renderProdukGrid(gridEl, paged.items, emptyState);
    if (countEl) countEl.textContent = `${paged.totalItems} produk ditemukan`;

    if (paginationEl) {
      renderPagination(paginationEl, paged.page, paged.totalPages, (nextPage) => {
        const next = { ...state, page: nextPage };
        writeStateToUrl(next);
        void render(next);
        gridEl.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  }

  function readFormState(overrides: Partial<ListingState> = {}): ListingState {
    const sortValue = sortSelect?.value ?? "";
    return {
      page: 1,
      categorySlug: readStateFromUrl().categorySlug,
      sort: isProductSort(sortValue) ? sortValue : undefined,
      inStockOnly: stockCheckbox?.checked,
      flashSaleOnly: flashCheckbox?.checked,
      minPrice: parseNumberParam(minInput?.value ?? null),
      maxPrice: parseNumberParam(maxInput?.value ?? null),
      ...overrides
    };
  }

  function applyAndRender(state: ListingState): void {
    writeStateToUrl(state);
    syncControlsToState(state);
    void render(state);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    applyAndRender(readFormState());
  });

  form.addEventListener("change", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.matches("[data-filter-sort], [data-filter-stock], [data-filter-flash]")
    ) {
      applyAndRender(readFormState());
    }
  });

  for (const link of categoryLinks) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      applyAndRender(readFormState({ categorySlug: link.dataset.filterCategory || undefined }));
    });
  }

  window.addEventListener("popstate", () => {
    const state = readStateFromUrl();
    syncControlsToState(state);
    void render(state);
  });

  const initialState = readStateFromUrl();
  syncControlsToState(initialState);
  void render(initialState);
}
