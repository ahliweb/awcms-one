/**
 * The browser-only cart client — `localStorage` read/write and the
 * `CustomEvent` dispatch, built entirely out of `src/lib/keranjang-kontrak.ts`'s
 * pure functions. Never imported from `.astro` FRONTMATTER (server/build
 * context has no `window`); imported only from a `<script>` block, which
 * Astro bundles into an external, content-hashed module — never inline, per
 * `script-src 'self'` (`server/penyaji.mjs`).
 *
 * `src/scripts/produk-detail.ts` (the "Tambah ke keranjang" button) is this
 * file's main caller; `src/scripts/keranjang-hitung.ts` (the header count)
 * only ever READS, via `keranjang-kontrak.ts`'s `parseCart`/`countCartItems`
 * directly, so it does not need this file at all.
 */
import {
  addOrMergeLine,
  createEmptyCart,
  KERANJANG_EVENT_NAME,
  KERANJANG_STORAGE_KEY,
  parseCart,
  removeLine,
  setLineQuantity,
  type Cart,
  type CartLine
} from "./keranjang-kontrak";

function newCartId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `keranjang-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The current cart, or a fresh empty one — never throws, never returns `null`, so a caller never has to special-case "no cart yet". */
export function loadCart(): Cart {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KERANJANG_STORAGE_KEY);
  } catch {
    // A private window or blocked storage reads the same as "no cart".
  }

  return parseCart(raw) ?? createEmptyCart(newCartId(), new Date().toISOString());
}

/** Persists `cart` and notifies every listener on this page (`KERANJANG_EVENT_NAME`) — `keranjang-hitung.ts` (and any future listener) re-counts on this event; the native `storage` event covers a change made in another tab. */
export function saveCart(cart: Cart): void {
  try {
    window.localStorage.setItem(KERANJANG_STORAGE_KEY, JSON.stringify(cart));
  } catch {
    // A full or blocked storage means this add did not persist — nothing
    // further to do from here; the caller's own UI (produk-detail.ts) is
    // what surfaces that failure to the shopper, not this file.
    return;
  }

  window.dispatchEvent(new CustomEvent(KERANJANG_EVENT_NAME, { detail: cart }));
}

/** Adds one line (freshly stamped with `addedAt`) to the current cart and persists the result — the product detail page's "Tambah ke keranjang" button, and nothing else, calls this. */
export function addToCart(line: Omit<CartLine, "addedAt">): Cart {
  const cart = loadCart();
  const now = new Date().toISOString();
  const next = addOrMergeLine(cart, { ...line, addedAt: now }, now);
  saveCart(next);
  return next;
}

/** Removes a line by index and persists the result. */
export function removeCartLine(index: number): Cart {
  const cart = loadCart();
  const next = removeLine(cart, index, new Date().toISOString());
  saveCart(next);
  return next;
}

/** Sets a line's quantity by index and persists the result. */
export function updateCartLineQuantity(index: number, quantity: number): Cart {
  const cart = loadCart();
  const next = setLineQuantity(cart, index, quantity, new Date().toISOString());
  saveCart(next);
  return next;
}

/**
 * Issue #30: replaces the cart with a fresh, EMPTY one carrying a NEW `id` —
 * called once, after `POST …/orders` succeeds (`src/scripts/checkout.ts`).
 *
 * A fresh id, not a cleared `lines` array on the SAME id, matters for one
 * reason: `cart.id` doubles as the order's `idempotencyKey` (this file's own
 * docblock, and the #29⇄#30 contract). Keeping the old id around after it
 * has already been consumed by a successful order would let a SECOND,
 * unrelated cart that happens to reuse browser storage before this tab
 * reloads collide with an order the CMS already considers settled — an
 * empty cart with a stale id is not "no cart", it is a landmine the next
 * checkout would step on.
 */
export function clearCart(): Cart {
  const next = createEmptyCart(newCartId(), new Date().toISOString());
  saveCart(next);
  return next;
}
