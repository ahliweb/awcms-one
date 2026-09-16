/**
 * The header's cart-count badge (`[data-cart-count]`, `Header.astro`).
 *
 * Replaces increment-1's inline logic, which read a bare `localStorage`
 * array under the key `"cart"` and listened to no event at all. This reads
 * THIS issue's real contract (`src/lib/keranjang-kontrak.ts`: key
 * `awcms-one:keranjang:v1`, `{id, lines, updatedAt}` shape) and re-counts:
 *
 *   - once, immediately, on page load;
 *   - on `KERANJANG_EVENT_NAME` — dispatched by `keranjang-klien.ts` after
 *     every write on THIS tab;
 *   - on the native `storage` event — fired by the browser when another TAB
 *     writes the same key.
 *
 * An external module (`Header.astro`'s `<script>` block is a one-line
 * `import`), never inline body — `script-src 'self'` (`server/penyaji.mjs`).
 */
import {
  countCartItems,
  parseCart,
  KERANJANG_EVENT_NAME,
  KERANJANG_STORAGE_KEY
} from "../lib/keranjang-kontrak";

function render(): void {
  const el = document.querySelector("[data-cart-count]");
  if (!el) return;

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KERANJANG_STORAGE_KEY);
  } catch {
    // A private window or blocked storage reads the same as "no cart".
  }

  el.textContent = String(countCartItems(parseCart(raw)));
}

render();

window.addEventListener(KERANJANG_EVENT_NAME, render);

window.addEventListener("storage", (event) => {
  if (event.key === KERANJANG_STORAGE_KEY) render();
});
