/**
 * The ONE constant shared between `src/scripts/checkout.ts` (writer, on a
 * successful order) and `src/scripts/pesanan.ts` (reader) — split into its
 * own file specifically so neither script has to `import` the OTHER
 * script's whole module just for this one string. `checkout.ts` importing
 * from `pesanan.ts` (or vice versa) would pull that page's entire
 * top-level side-effecting code (its own `document.querySelector` root
 * check) into a bundle that never needed it — harmless at runtime (each
 * guards on its own root element being absent) but pointless bundle
 * coupling between two otherwise-unrelated pages.
 *
 * `sessionStorage`, not `localStorage`: a phone number is more sensitive
 * than a cart line, and a tab closing is the right moment to forget it —
 * unlike the cart/wishlist, which are meant to survive a closed tab.
 */
export const PESANAN_PHONE_KEY = "awcms-one:pesanan:telepon";
