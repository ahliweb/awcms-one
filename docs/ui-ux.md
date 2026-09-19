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

## The news surface, as increment 3 shaped it

The news pages are no longer the catalog's chrome with articles in it. They carry their own header (a utility bar with the WIB date, contact and official-account icons; an eight-item nav; the **Daerah panel**, which is always fully server-rendered with all fourteen regencies and only *collapsed* by script, so a reader without JavaScript sees every link; a "Terkini" ticker), their own footer (Rubrik/Umum/Daerah columns, the 24-institution Mitra directory, a leaderboard above the footer, a back-to-top link), and **one shared sidebar** across every news page with a side column — tabbed Terbaru/Mitra Borneo lists, three ad slots, a newsletter box, a tag cloud.

Four decisions inside that surface are worth carrying forward:

- **An ad slot with nothing booked renders nothing.** Not an empty frame, not a placeholder — the reference site's own placeholder boxes were a symptom of its inventory, not a design goal.
- **"Terpopuler" is either real or absent.** It ranks from `visitor_analytics`' own rollups and falls back to "latest" silently in code, never announcing a ranking the data cannot support.
- **The read-aloud player is offered only where it works.** The card ships `hidden` and is revealed only when the browser really has `speechSynthesis` and a voice; the highlight it draws while reading is an outline, so the article never reflows under someone who is listening.
- **The institution emblem belongs to the institution.** One upload serves every article of that channel, and an article whose institution has none simply has none ([ADR-0014](adr/0014-the-institution-owns-the-emblem-not-the-post.md)).

## The account surface (issue #90, S2 of #32)

`/akun/alamat`, `/akun/pesanan`, and `/akun/ulasan` extend the S1 account shell (`/masuk`, `/daftar`, `/akun`) with the shopper's own addresses, order history, and reviews. Three decisions carried forward from S1, applied here too:

- **Every page renders both states in static markup.** A script (`akun-alamat.ts`/`akun-pesanan.ts`/`akun-ulasan.ts`) toggles guest vs. signed-in per `bacaSesi()`, the same split `akun.ts` (S1) already established — the HTML itself never decides anything only JavaScript could know.
- **The region control is shared, not duplicated.** `/akun/alamat`'s add/edit form and `checkout.astro`'s own "Pilih alamat tersimpan" autofill both drive the province/city/district `<select>`s through the SAME module, `apps/storefront/src/lib/wilayah-region-select.ts` — extracted out of `checkout.ts`'s original inline cascading-fetch code specifically so this issue would not need a second copy of it.
- **The account's own order detail reuses the guest tracking page's renderer.** `apps/storefront/src/lib/pesanan-render.ts` is the DOM-building code `/pesanan` (issue #30) already had, extracted so `/akun/pesanan?kode=` renders an `Order` identically — minus the phone-verification form and the confirm-payment/cancel actions, which stay phone-gated CMS routes issue #86 names no account-authenticated equivalent for (a deliberate scope reduction, not an oversight).

**The wishlist becomes account-synced while signed in, and stays local otherwise.** `apps/storefront/src/lib/wishlist-sinkron.ts` is a PURE merge function (union by `productId`, earliest `addedAt` wins, capped at 200) — on login, the local wishlist's product ids are `PUT` to the account and the local copy is replaced with the merge of what was local and what the CMS answered; while signed in, `wishlist-tombol.ts` (every heart button, site-wide) and `wishlist.ts` (the `/wishlist` listing) write through to the account on every add/remove, treating `localStorage` as a render cache rather than the source of truth. Logging out leaves the local copy exactly as it is. Any network failure degrades to local-only operation with a shared, polite `aria-live` status region (`apps/storefront/src/lib/wishlist-akun-sync.ts`) — the heart button never looks broken.

## The affiliate surface (issue #93, S3 of #32)

`/akun/afiliasi` renders one of three states from build-time and runtime data together, never a spinner-then-guess: **closed** (`affiliateProgramEnabled` is `false` at build time — a short explanation only, no enrol button ever rendered, since the CMS's own contract answers `409 AFFILIATE_PROGRAM_DISABLED` for any attempt); **logged out** (links to `/masuk`/`/daftar`); **signed in** (an idempotent enrol button when not yet enrolled, otherwise the referral link with a copy button reusing the voucher-code copy pattern, the commission rate, status, lifetime stats formatted through `formatPrice`, and a keyset-paginated commissions list). `?ref={code}` capture (`apps/storefront/src/scripts/afiliasi-tangkap.ts`, mounted once from `BaseLayout` on every page) and the checkout-time `affiliateCode` attribution are invisible to the shopper by design — a referral is remembered and forwarded, never surfaced as its own UI step in the cart or checkout flow.

## Status-label vocabulary: one small `Record` per surface, never the raw API enum

Every moderation/lifecycle status this app renders is translated to Indonesian through a small, page-local `Record<Status, string>` lookup rather than a shared enum-to-copy table — `akun-ulasan.ts`'s review statuses (`pending` → "Menunggu moderasi", `published` → "Terbit", `rejected` → "Ditolak"), `akun-afiliasi.ts`'s own two vocabularies (affiliate `active`/`suspended` → "Aktif"/"Ditangguhkan"; commission `pending`/`approved`/`paid`/`void` → "Menunggu"/"Disetujui"/"Dibayar"/"Dibatalkan"), and `pesanan-render.ts`'s `STATUS_LABELS` for order status (shared by `/pesanan` and `/akun/pesanan`, unchanged by this increment). Every lookup falls back to the raw API value (`?? status`) rather than throwing or rendering nothing, so a status this app's copy has not caught up to yet — new API-side state, a future migration — still shows something a shopper can read.

## Not built

A locale switcher; any product-imagery decision tied to dark mode (the colour-scheme media query governs this app's own chrome, not CMS-supplied imagery or `labelColor`); a live carrier-rate comparison at checkout (courier options render as "segera" — disabled — pending [issue #33](https://github.com/ahliweb/awcms-one/issues/33), see [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md)).
