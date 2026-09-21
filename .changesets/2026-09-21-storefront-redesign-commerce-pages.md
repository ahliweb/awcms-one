---
bump: minor
type: structure
impact: public
---

# Storefront redesign — commerce pages (home, catalog, product, cart, checkout, tracking, wishlist)

Wave 2 of the 2026-09 redesign (issue #167), built on the foundation issue #166 landed (`.btn`, `.pill`, `.band-inverse`, `.stepper`, `.radio-card`, `.segmented`, `.field-label`/`.is-mono`, the token scales). Markup/CSS only — every client contract (`toko-klien`, `keranjang-kontrak`, `wishlist-kontrak`, the checkout quote/order flow) is unchanged.

- **Home**: the CMS slider now renders on the inverse band as a hero card (badge, heading, copy, primary + secondary CTAs); the flash-sale strip is an amber soft band; product cards carry a price/was/discount row and a "Grosir mulai …" tier line when the product actually has a level-2 price.
- **Product card** (`ProductCard.astro`, used by home/catalog/category/related-products): a grouped badges row, price/was/discount, tier line, and a 44px wishlist heart hit area.
- **Catalog** (`/produk`, `/kategori/[slug]`): the sidebar filter card and category-tree rows are restyled (a decorative marker box beside each — still real `<a>` navigation, the documented fallback for "no multi-select client contract to add"), sort/price/stock controls use the new form primitives.
- **Product detail**: badges, price-tier table in an info-toned `.tier-box`, a `[data-wishlist]` button beside "Tambah ke Keranjang" (wired for free by the site-wide `wishlist-tombol.ts`), a notes list, description before the restyled size-chart table, and `.btn`-toned share actions. No fabricated reviews list is rendered — awcms's contract has no `GET …/storefront/reviews` (only anonymous `POST` submission), so the existing rating-average + sold-count line is the only real review data available.
- **Cart**: line cards are restyled with a `.stepper` −/n/+ control (still calling the same `updateCartLineQuantity`) and a real line-total column (`quoteLine.lineTotal`, never computed client-side), a two-column layout with the summary sticky on desktop, and a proper `.empty-state`.
- **Checkout**: a decorative (non-interactive) step-pill row kept in sync by the existing `showStep()`, `.is-mono` phone/postcode fields, and shipping/payment options restyled as `.radio-card`-style rows — all over the unchanged quote/step logic.
- **Tracking**: mono inputs, a status pill toned by the real order status, and a "Bayar sekarang" band shown exactly when the existing gateway-pending condition is true.
- **Wishlist**: an info band, and a "Ke keranjang" link beside remove — a real navigation to the product page (a `WishlistItem` snapshot carries no `minPurchase`/`maxQuantity`/`sku`, so there is no honest quantity to add directly).

Documented in `docs/ui-ux.md`'s "Design system (2026-09 redesign)" section (+ Indonesian mirror).
