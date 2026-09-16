---
bump: minor
type: structure
impact: public
---

# Storefront cart, checkout, order tracking, and wishlist

The storefront can now place a real order while staying 100% static
(ADR-0002 intact): no `prerender = false`, no runtime credential. This is
the architecture revision tracked at
https://github.com/ahliweb/awcms-one/issues/31 (to be recorded there as an
ADR — draft text is in this change's own pull request description): the
browser calls the CMS's anonymous, cross-origin storefront commerce
endpoints directly (`/api/v1/commerce/storefront/*`, issue #29's own
contract — awcms ADR-0103/0107/0118's established pattern, the same one the
newsletter form, site search, and comments already use), the CMS resolves
the tenant from the request `Origin`, and answers with CORS — never a
cookie, never a bearer token.

- **`PUBLIC_AWCMS_ORIGIN`** — the one new build-time variable, deliberately
  `PUBLIC_`-prefixed (an origin is not a secret) unlike `AWCMS_API_TOKEN`.
  `apps/storefront/src/lib/awcms/toko-origin.ts` validates it and is called
  from `apps/storefront/src/pages/csp.json.ts` — a page every build
  unconditionally prerenders — so an unset or malformed value **fails the
  build**, naming the variable, rather than shipping a checkout page that
  silently posts nowhere. The CSP's `connect-src` gains exactly this one
  origin, via the SAME artifact mechanism issue #27 built for `img-src`
  (`csp-asal-media.ts`'s `connectSrc` field, unused until now) — no second
  mechanism.
- **`apps/storefront/src/lib/toko-klien.ts`** — one function per endpoint
  (quote, create order, track, confirm payment, upload-session/finalize,
  cancel, review), every request `mode: "cors"` / `credentials: "omit"` /
  only a `Content-Type` header, envelope unwrapped into a typed
  `TokoApiError` carrying `code`/`details` (field errors, a fresh quote on
  `CART_CHANGED`, `Retry-After` on `RATE_LIMITED`).
- **`/keranjang`** — renders the `localStorage` cart (issue #27's contract),
  re-quotes it live, flags stale price/stock/min-purchase inline (never
  silently corrects), voucher code, quantity/remove, "Lanjut ke checkout".
- **`/checkout`** — one page, five progressively-disclosed steps (contact →
  address → shipping → payment → review); address regions come from
  `apps/storefront/src/lib/awcms/wilayah-checkout.ts`, baked at BUILD time
  into `/index/wilayah-{provinsi,kabupaten-*,kecamatan-*}.json`
  (`PUBLIC_WILAYAH_PROVINSI`, default every Kalimantan province) rather than
  the national ~90,000-village dataset; `VALIDATION_ERROR.details[].field`
  maps to an inline error next to the field it names.
- **`/pesanan`** — order tracking by `?kode=`; the phone comes from
  `sessionStorage` or a form, **never the URL**; status timeline, payment
  instructions while `pending_payment`, a countdown to `expiresAt`, a
  payment-confirmation form, cancel while cancellable.
- **`/wishlist`** — `localStorage`-only; `ProductCard.astro` gains an
  additive `[data-wishlist]` heart button, wired site-wide by
  `apps/storefront/src/scripts/wishlist-tombol.ts` (imported once from
  `Header.astro`, the same way the cart-count script already is).
- Every script above is an external module; every page has a `<noscript>`
  fallback offering a WhatsApp order link
  (`apps/storefront/src/lib/wa-fallback.ts`), is keyboard-reachable, uses
  `aria-live="polite"` for quote/status updates, and carries
  `noindex, follow` via the `head` slot issue #27 added.
- `apps/storefront/scripts/stub-awcms.mjs` (local/CI verification only,
  never shipped) gains a small in-memory state machine for the same
  storefront endpoints, built against the identical #29⇄#30 contract
  document the CMS agent implements in parallel — plus proper
  `level`/`parentCode` filtering for `/api/v1/idn-regions/regions`, which
  the fixture's second province/district rows now need.
- Browser-level Playwright coverage (`apps/storefront/tests/e2e/`, run by
  its own `bun run test:e2e` inside `apps/storefront` — never the root
  `bun test`) exercises add-to-cart → quote → checkout → tracking, and the
  neutral not-found state for a wrong phone.

Deviation from the issue's literal file naming: the cart page's script is
`apps/storefront/src/scripts/keranjang.ts` (matching every other page-level
script's location), not the src/lib-rooted path one line of the issue body
named for it — every interactive script in this app already lives under
`apps/storefront/src/scripts/`, and the issue's own "every script is an
external module" sentence agrees with that location, not the one-off
mention.
