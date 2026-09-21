🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](ui-ux.id.md)

# UI / UX

The storefront's visual and interaction design decisions that are load-bearing enough to need explaining, rather than a restatement of every CSS rule in `apps/storefront/src/styles/`.

## Product imagery now exists — increment 1's "no imagery, anywhere" no longer holds

`awcms_commerce_product_images` (issue #23) gave `CommerceProduct` a real `images[]` field, resolved through `media_library` to a public URL, and the product detail page (`/product/{slug}`) renders an image gallery. `apps/storefront` still has no `media_library` client of its own for CMS-managed **site chrome** — the storefront's own logo/favicon are still not resolved from `logoMediaId`/`faviconMediaId` (see [`docs/cms.md`](cms.md)) — but **product photography is real**, and the CSP's `img-src` is now derived at build time specifically to allow it safely; see [`docs/arsitektur.md`](arsitektur.md).

## `labelColor`: a CMS-chosen color, rendered safely — unchanged mechanism

`label`/`labelColor` on a product is still a free-form merchandising badge where `labelColor` is an arbitrary hex string a merchandiser typed. The same build-time mechanism from increment 1 still applies: `apps/storefront/src/profil/toko/pages/product-labels.css.ts` scans every product, collects the distinct `labelColor` values, and emits one small, same-origin stylesheet — `style-src 'self'` needs no exemption. Contrast is computed by `contrastingForeground()` (relative-luminance-based, picks whichever of black/white gives the higher ratio), unit-tested in `apps/storefront/tests/warna.test.ts` against every default brand colour.

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

## Checkout and tracking: payment gateway, redirect-based (issue #112, contract: #106 D3)

Checkout's payment step lists **Bayar online (kartu, VA, e-wallet)** whenever the quote's `paymentMethods[]` includes `gateway` — a tenant flag (`payment.gatewayEnabled`), the same "the CMS decides, this app only renders what it lists" posture every other payment method already follows. Choosing it and submitting still places the order exactly as before (the same `POST …/orders`, cart cleared, phone stashed to `sessionStorage`); this app then makes ONE further call, `createGatewaySession`, and sends the WHOLE tab to its `redirectUrl` (`window.location.assign` — never an `<iframe>`, never a `fetch`-then-render, per [ADR-0010](adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md)). A `redirectUrl` is only ever navigated to when it validates as `https:` — or `http:`, but only when this build's own `PUBLIC_AWCMS_ORIGIN` is itself `http:` (this repo's local/CI stub, never a real deployment) — anything else, or any failure creating the session at all, falls through to `/pesanan?kode=…` instead: the order already exists, so this is never treated as a checkout failure.

`/pesanan` and `/akun/pesanan`'s detail view both render a **Bayar sekarang** button in place of manual-transfer instructions for a `gateway` order still `pending_payment` — clicking it creates (or, per the contract's own "idempotent per order", re-reads) the same gateway session and redirects the same way. While that button is showing, an `aria-live="polite"` line reads "Menunggu konfirmasi pembayaran…", and the page polls the order every 5 seconds (`apps/storefront/src/lib/pesanan-poll.ts`) — stopping once the order leaves `pending_payment`, once its `expiresAt` passes, after 15 minutes, or (a pause, not a stop) while the tab is hidden, resuming on `visibilitychange`. A `paid` order updates that same line to "Pembayaran diterima." — the existing countdown-to-expiry keeps working unchanged for every other payment method.

## WhatsApp OTP, marketing consent, and `/akun/pesan` (issue #115, S3 of #33, contract: #106 D5/D8/D9)

`/masuk` renders a channel choice — "Kirim kode lewat: E-mail | WhatsApp" — only when the public store settings' `whatsappOtpEnabled` is `true` at build time, the same "the CMS decides, this app only renders what it can act on" posture `/checkout`'s payment-gateway row already follows. Choosing WhatsApp swaps the identifier field to a phone input; both channels otherwise share the exact same two-step form (identifier → 6-digit code) and error handling, including a new `409 CHANNEL_UNAVAILABLE` message for a channel that stopped being configured after the page loaded. Registration (`/daftar`) never gains this choice — it stays e-mail-only regardless of what `/masuk` offers, with a one-line note explaining why, since a phone number is not yet a verified identity at registration time (issue #86's own deferred "phone verification").

`/akun` gains a "Preferensi Promo" card: a single real checkbox, saving immediately on `change` rather than needing its own "Simpan" button — a toggle's own state change already IS the complete intent, unlike the multi-field "Ubah Nama" form beside it. This is the first `PATCH …/account/me` field this app writes that is not `name`; `ubahProfil`'s input type became `{name?, marketingConsent?}` specifically so neither caller has to round-trip the field it is not changing.

`/akun/pesan` is this app's fourth authenticated list/detail page (after `/akun/pesanan`, `/akun/alamat`, `/akun/afiliasi`'s commissions list), reusing the exact same keyset-list-plus-`?id=`-detail shape `/akun/pesanan` established — a shopper who already knows that page's own pattern (list, "Muat lebih banyak", click through to a detail) needs to learn nothing new here. The one genuinely new element is the unread badge: a small count on each list row, `aria-label`'d rather than left as a bare visual number, and cleared server-side as a side effect of opening the thread (never a separate "mark read" action a shopper has to remember to take). A closed thread renders a plain note in place of the reply form — never a `disabled` textarea, which would invite a shopper to try typing into a control that can only fail.

## Not built

A locale switcher; any product-imagery decision tied to dark mode (the colour-scheme media query governs this app's own chrome, not CMS-supplied imagery or `labelColor`).

## Checkout: real courier rates, priced per destination (issue #109, contract: #106 D4)

The checkout shipping step's courier row is no longer a permanent "segera" placeholder — it renders one radio per priced service (`{name} ({etd}) — {price}`, e.g. "JNE REG (2-3 hari) — Rp15.000") once the address step's kecamatan `<select>` carries a value, and re-quotes automatically on every district change (including a saved-address autofill, which sets the select programmatically rather than through a user `change` event). Before a district is chosen, when the store has courier disabled, or when the provider cannot price the chosen destination, the SAME single disabled placeholder as before renders — `available:false`, `serviceId:null` — but now carries a `note` explaining which of the three it is, shown as the row's own visible help text (`aria-describedby`, not just a title attribute). An `aria-live="polite"` status line above the options announces "Menghitung ongkir…" while a quote is in flight and a short failure message if it errors, so a screen-reader user is not left guessing why the list is empty. `apps/storefront/src/lib/kurir-opsi.ts` is the one place an option becomes this text — `checkout.ts` only loops over what it decides.

## Design system (2026-09 redesign, issue #166) — foundation only

**Wave 1 of a broader visual redesign** (`redesign/AWCMS-One Admin dan Publik.zip`'s "Publik awcms-one" Claude Design canvas, 11 mocked pages — this issue reads only that mockup's markup and its chrome, lines 24-86 and 861-877, never re-implements a whole page). This issue lands the type system, the design tokens, a set of shared CSS primitives, and site-chrome updates (utility bar, brand tile, footer's fourth "Kanal" column) — every consuming page (product detail, cart, checkout, account) is a later issue (#167/#168/#169) building ON these class names, not this one.

### Type system: self-hosted, three families

`apps/storefront/public/fonts/` carries latin-subset `woff2` builds (SIL OFL, `apps/storefront/public/fonts/LICENSE-OFL.txt` names the exact families/weights/version) of:

| Token | Family | Weights vendored |
| --- | --- | --- |
| `--font-sans` | Plus Jakarta Sans | 400, 500, 600, 700, 800 |
| `--font-serif` | Lora | 400, 500, 600 (+ 400 italic) |
| `--font-mono` | IBM Plex Mono | 400, 500 |

No Google Fonts, no new CSP origin: every `@font-face src` in `apps/storefront/src/styles/global.css` is a same-origin `/fonts/*.woff2` path (`font-src 'self'`, `apps/storefront/server/penyaji.mjs`, unchanged), `font-display: swap` throughout, and `apps/storefront/tests/global-css-fonts.test.ts` proves both. `BaseLayout.astro` preloads only the three faces actually above the fold on a typical page — sans 400/600, serif 500 — everything else loads lazily on first use.

### Tokens (`apps/storefront/src/styles/global.css`)

Brand colour is never hard-coded here: `--color-primary`/`--color-secondary`/`--color-accent` still come from `/theme-tokens.css` (CMS-driven, `apps/storefront/src/pages/theme-tokens.css.ts`), used only as button/pill BACKGROUNDS paired with their `-foreground` counterpart — the same rule this file's pre-existing header docblock already states. What this issue adds:

| Group | Tokens |
| --- | --- |
| Inverse band | `--bg-inverse`, `--bg-inverse-2`, `--text-on-inverse`, `--text-on-inverse-muted`, `--border-on-inverse` |
| Soft status pairs | `--status-{success,warning,info,danger,neutral}-bg` / `-fg` (+ `--status-info-border`) |
| Link colour | `--link-color`, `--link-hover` (sky, distinct from `--accent-primary`'s name even though it shares its value today) |
| Radius scale | `--radius-xs` (8px) … `--radius-full` (999px) |
| Shadows | `--shadow-sm`/`--shadow-md` (unchanged values, now also used by the new primitives) |
| Type scale | `--text-xs` (12px, the AA floor) … `--text-2xl` (28px) |
| Fonts | `--font-sans`, `--font-serif`, `--font-mono` |

Every token above has a `prefers-color-scheme: dark` counterpart in the existing dark block — the mockup itself has none, so each dark value was chosen to hold the same intent (a soft warning stays legibly amber-on-dark-amber, not the light-mode pair repeated verbatim).

### Primitives (`apps/storefront/src/styles/global.css`, documented at that file's own top)

All ADDITIVE — every class that predates this issue (`.card`, `.cart-count`, `.wishlist-button`, `.stock-badge`, `.label-badge`, `.empty-state`, …) is byte-for-byte unchanged.

| Class | What it is |
| --- | --- |
| `.btn`, `.btn--primary`/`--secondary`/`--quiet`, `.btn--md`/`--sm` | Buttons — brand-filled, outline, text-only; 44/40/36px heights |
| `.pill`, `.pill--success`/`--warning`/`--info`/`--danger`/`--neutral`/`--label` | Small rounded status/label badges over the soft status tokens |
| `.band-inverse` | The dark surface (utility bar, footer) |
| `.field-label`, `.is-mono` | Form label wrapper; monospace value font for a code/phone/postcode input |
| `input[type=…]`, `select`, `textarea` | 42px controls (all product/checkout forms already targeted this height; now token-driven) |
| `.stepper`, `.stepper--lg` | Qty −/n/+ control, 38px and 46px |
| `.radio-card` | A full-width selectable card built from a real `<input type="radio">` + `<label>` |
| `.segmented` | An equal-weight tab/step row, `[aria-current="true"]` marks the active one |
| `.section-title` | A page-section heading with an optional trailing meta/count |

`.card` and `.empty-state` already existed (increment 1) and are reused as-is — this issue does not redefine either.

### Site chrome

- **Utility bar** (`Header.astro`, `toko` group only): "Lacak pesanan", "Berita" (only when the `berita` group is ALSO active in this build), "Akun saya" — on `.band-inverse`. The mockup's free-shipping notice slot is deliberately **not** rendered: it is store-settings-driven copy (`shippingSettings.freeShipping`, `apps/storefront/src/lib/awcms/pemasaran.ts`) this issue does not wire the header's build-time fetch to, and inventing the Indonesian copy instead would be exactly the mistake this repo's own rules warn against.
- **Brand tile**: the site name's first letter, `aria-hidden`, on `--color-primary`, beside the existing wordmark link (`.site-brand`'s accessible name is unchanged).
- **Header tools**: search's "Cari" button, the cart-count pill (`--color-accent`) and the wishlist link were already brand-toned before this issue (increment 1's own `.search-form button`/`.cart-count`) and are unchanged.
- **Footer**: a fourth "Kanal" column (Katalog/Flash Sale/Berita/Program Afiliasi), each entry gated on `isRouteActive` (`apps/storefront/src/config/profil.ts`) exactly like every other profile-aware footer link — a `landing`/`berita`-only build renders none of a channel it has no route for. The footer itself now sits on `.band-inverse`, and its bottom line reads `© YEAR name · Semua harga dalam Rupiah` plus the mockup's own "Bahasa Indonesia · html lang="id"" note.

### Accessibility floor

Nothing in this design system renders text below `--text-xs` (12px) — the mockup's own 10-11px captions (`#94a3b8` at 10px, which fails WCAG AA) become 12px `--text-muted`/`--status-*-fg` throughout. See [`docs/aksesibilitas.md`](aksesibilitas.md) for the contrast and touch-target detail.

## Design system (2026-09 redesign, issue #167) — commerce pages

**Wave 2**, built entirely on issue #166's primitives above — no new token, no new primitive class, only consuming pages restyled. Markup/CSS only: every client contract (`toko-klien.ts`, `keranjang-kontrak.ts`, `wishlist-kontrak.ts`, the checkout quote/order flow) is unchanged, and every class an existing test asserts on was kept.

### Home (`apps/storefront/src/profil/toko/Beranda.astro`)

The CMS slider (`getActiveSliders()`) now renders each slide on the `.band-inverse` surface as a hero card: a `.pill--success` "Slider dikelola CMS" badge, the slide's own title/subtitle, and two real links — a primary CTA to the slide's `linkUrl` (falling back to `/produk` when a slide has none) and a secondary outline CTA to the catalog. The previous single `<a class="slider-slide">` wrapping the whole slide became a `<div>` with two real, separately-focusable links, since a slide is no longer one giant hit target — matching the mockup's own two-CTA composition. The flash-sale strip is now an amber soft band (`--status-warning-bg`/`-fg`); featured/recommended cards are `ProductCard.astro`'s own restyle (next section).

### Product card (`apps/storefront/src/components/katalog/ProductCard.astro`)

Used by home, `/produk`, `/kategori/[slug]`, and product-detail's related list — restyled once. `.card-badges` groups the label/flash/stock pills on one row; `.card-price-row` shows the "was" price + discount percent only when `product.discountPercent > 0` (never a fabricated strike-through — `finalPrice` is already the discounted figure, ADR-0003); `.card-tier-line` shows "Grosir mulai {formatPrice(priceLevel2)}" only when the product actually carries a level-2 price (no invented minimum-quantity number — awcms's product DTO has no such field). The wishlist heart (`.wishlist-button`, a sibling of `.card`, unchanged data-attribute contract) is 44px here via a higher-specificity `.card-wrap .wishlist-button` rule in `katalog.css`, while the bare `global.css` class stays 32px for anything that does not opt in.

### Catalog (`/produk`, `/kategori/[slug]`)

The sidebar filter card and `CategoryTree.astro` rows are restyled — a decorative marker square beside each category row gives it the same at-a-glance shape as the mockup's checkboxes, but it stays a real `<a>` (the issue's own documented fallback: "plain links" when there is no multi-select filtering contract to add without changing `produk-listing.ts`'s client behaviour). Sort/price-range/stock controls use the new `.field-label`/`.is-mono`/`.btn` primitives; the underlying `data-filter-*` selectors `produk-listing.ts` reads are unchanged.

### Product detail (`/product/[slug]`)

Badges group above the title; the price-tier table now sits inside a `.tier-box` (an info-soft card, `--status-info-bg`/`-border`/`-fg`); the qty stepper/add-to-cart carry `.stepper--lg`/`.btn btn--primary` visuals over the same `data-qty-*`/`data-add-to-cart` behaviour; a `[data-wishlist]` button (the same data-attribute shape `ProductCard.astro` uses) now sits beside "Tambah ke Keranjang" — `wishlist-tombol.ts`'s site-wide event delegation wires it up with no script change. Description now precedes the size-chart table (both restyled), and share actions use `.btn` tones. **No per-product reviews list is rendered**: awcms's contract has no `GET …/storefront/reviews` (`openapi/modules/commerce.openapi.yaml` — only an anonymous `POST`, pending moderation), so the page's only real review signal remains the existing rating-average + sold-count line; inventing review cards would mean showing text/authors the CMS never sent.

### Cart (`/keranjang`)

A two-column `.cart-layout` (line cards + voucher on the left, a sticky-on-desktop `.cart-summary` on the right, single column under 900px). `keranjang.ts`'s `renderLines` now builds a `.stepper` −/n/+ control (an `<output>`, not editable by typing — a traded affordance, not a data-flow change) calling the same `updateCartLineQuantity`, plus a right-aligned `.toko-line-sum` from `quoteLine.lineTotal` (never computed client-side). The empty state is the shared `.empty-state` primitive with a "Mulai belanja" CTA.

### Checkout (`/checkout`)

A decorative, **non-interactive** step-pill row (`<span data-step-pill>`, not a `.segmented` tab — a step here is not a shortcut around the form's own required-field validation) sits above the form; `checkout.ts`'s existing `showStep()` now also updates `aria-current` on the matching pill, alongside the real `[data-step]` section it always toggled. Phone/postcode fields carry `.is-mono`. Shipping and payment options — built by the SAME `renderShippingOptions`/`renderPaymentOptions` — are restyled as `.radio-card`-style rows purely via CSS (`.toko-shipping-option`/`[data-payment-options] .toko-field`, the exact class names those functions already assigned).

### Tracking (`/pesanan`)

Phone/order-code inputs are `.is-mono`. The status pill (`pesanan-render.ts`'s `renderOrder`) is now toned by the real order status (`pill--warning` while pending payment, `pill--success` once completed, `pill--danger` if cancelled, …) rather than a fixed colour — the same shared renderer `/akun/pesanan`'s own detail view uses, so that page's status pill gains the same accurate toning for free. The "Bayar sekarang" band shows exactly when the pre-existing `gateway` + `pending_payment` condition (`renderPaymentSection`) is true; nothing about that condition changed.

### Wishlist (`/wishlist`)

An info band states the real sync behaviour (`wishlist-akun-sync.ts` already writes to the account when signed in — not new copy). Each card gets a "Ke keranjang" link beside remove — a real navigation to the product page, **not** a direct `addToCart()`: `WishlistItem` (`wishlist-kontrak.ts`) carries no `minPurchase`/`maxQuantity`/`sku` snapshot, so there is no honest quantity/stock to add without re-fetching, and the product page is where that add already happens correctly.
