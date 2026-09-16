🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](ui-ux.id.md)

# UI / UX

The storefront's visual and interaction design decisions that are load-bearing enough to need explaining, rather than a restatement of every CSS rule in `apps/storefront/src/styles/`.

## Product imagery now exists — increment 1's "no imagery, anywhere" no longer holds

`awcms_commerce_product_images` (issue #23) gave `CommerceProduct` a real `images[]` field, resolved through `media_library` to a public URL, and the product detail page (`/product/{slug}`) renders an image gallery. `apps/storefront` still has no `media_library` client of its own for CMS-managed **site chrome** — the storefront's own logo/favicon are still not resolved from `logoMediaId`/`faviconMediaId` (see [`docs/cms.md`](cms.md)) — but **product photography is real**, and the CSP's `img-src` is now derived at build time specifically to allow it safely; see [`docs/arsitektur.md`](arsitektur.md).

## `labelColor`: a CMS-chosen color, rendered safely — unchanged mechanism

`label`/`labelColor` on a product is still a free-form merchandising badge where `labelColor` is an arbitrary hex string a merchandiser typed. The same build-time mechanism from increment 1 still applies: `apps/storefront/src/pages/product-labels.css.ts` scans every product, collects the distinct `labelColor` values, and emits one small, same-origin stylesheet — `style-src 'self'` needs no exemption. Contrast is computed by `contrastingForeground()` (relative-luminance-based, picks whichever of black/white gives the higher ratio), unit-tested in `apps/storefront/tests/warna.test.ts` against every default brand colour.

## Price presentation: five figures, never computed client-side

A product now carries `price`, up to three tier prices (`priceLevel2/3/4`), and a server-computed `finalPrice` — plus, when a flash sale applies, a flash-sale price fetched from `GET /flash-sales/active`. `apps/storefront` still performs **no price arithmetic of its own**: every figure shown is exactly what `apps/cms` computed, formatted through `Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR" })` (`formatPrice()`, now in `apps/storefront/src/lib/harga.ts` — the app's own grep-guarded rule that this is the *only* file converting a price string to a number, enforced by a unit test over `src/`). The cart and checkout pages re-quote every line against `apps/cms` live (`POST .../cart/quote`) rather than trusting a static page's own numbers into an order — see [ADR-0007](adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md).

## The variant picker, size chart, service form, and subscription/digital notes

The product detail page renders, when present: a variant picker (attribute-based, e.g. size/colour, each variant carrying its own price/stock), an insurance note (`withInsurance`/`insuranceRequired`/`insuranceFee`), a size chart (`none`/an image/a table, per `sizeChartType`), a service product's intake-form fields (`serviceForm`), and a subscription-period or digital-download note. None of these compute anything — they render exactly the shape `apps/cms` returns, the same "no arithmetic in this app" rule extended to every new field rather than relaxed for it.

## The cart is a browser-local contract

`apps/storefront/src/lib/keranjang-kontrak.ts` defines the cart's shape: `localStorage` key `awcms-one:keranjang:v1`, `{id, lines, updatedAt}`, a `keranjang:berubah` event fired on every write (the header's cart-count badge listens for it). The cart's own `id` doubles as the checkout order's idempotency key — a double-submitted "place order" click cannot create two orders, because the client sends the same key both times and `apps/cms`'s `awcms_idempotency_keys` store recognises the repeat (see [`docs/api.md`](api.md)).

## Stock and price presentation on cards

Stock is still shown as a binary badge — "Stok tersedia" / "Stok habis" — derived from `stock > 0`, not the numeric count. `discountPercent` is still shown as the percentage `apps/cms` sends, never as a client-computed discounted price.

## Language: Indonesian, unconditionally — unchanged

Every user-facing string is written directly in Indonesian (`<html lang="id">`) — there is no i18n framework, no locale switcher, and no English copy anywhere in the rendered output, including every new cart/checkout/order-tracking/wishlist string added in increment 2.

## Not built

A locale switcher; any product-imagery decision tied to dark mode (the colour-scheme media query governs this app's own chrome, not CMS-supplied imagery or `labelColor`); a live carrier-rate comparison at checkout (courier options render as "segera" — disabled — pending [issue #33](https://github.com/ahliweb/awcms-one/issues/33), see [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md)).
