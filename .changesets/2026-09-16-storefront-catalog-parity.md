---
bump: minor
type: content
impact: public
---

# Storefront catalog parity: home, listing, category, flash sale, product detail

The public storefront now matches mart.borneojek.com's catalog surface end
to end, still static (ADR-0002): a real home page (slider, popular
categories, a flash-sale strip with a live countdown, featured/recommended
products, a promo section, a public-voucher strip, testimonials, recent
news, a promo popup), `/produk` (grid + sidebar, client-side search/filter/
sort/paginate over a build-time JSON index), `/kategori/[slug]`,
`/flash-sale`, and a full `/product/[slug]` (image gallery, tiered pricing,
variant picker, service-form fields, "Tambah ke keranjang", share buttons,
related products, structured data).

Why this shape rather than a thinner slice: increment 1 (issue #5) proved
the stack with a bare catalog grid and a minimal detail page — this closes
the gap to what a shopper on the live site actually sees, using the full
product/category model issue #23 landed and the marketing read models issue
#26 is landing in parallel (every marketing fetch is isolated to
`apps/storefront/src/lib/awcms/pemasaran.ts` and tolerates a 404 until then).

- The `localStorage` cart contract issue #30 builds on:
  `apps/storefront/src/lib/keranjang-kontrak.ts` — key `awcms-one:keranjang:v1`, shape
  `{id, lines, updatedAt}`, event `keranjang:berubah` dispatched on every
  write. Replaces increment-1's placeholder `"cart"` array key.
- Price display moved to `apps/storefront/src/lib/harga.ts`, the only place a price string
  is ever converted to a number — grep-guarded by a unit test over `src/`
  (ADR-0003).
- **The CSP now carries one exemption, derived rather than configured.**
  Product photos live on the CMS's public media origin, which a bare
  `img-src 'self'` blocks silently — correct HTML, green build, broken
  page. `apps/storefront/src/pages/csp.json.ts` writes the origins this build actually
  references to `dist/client/csp.json`; `apps/storefront/server/penyaji.mjs` reads it once
  at startup, re-validates every origin, and widens `img-src` by exactly
  those. A missing or malformed artifact degrades to the baseline policy
  (images stop rendering) rather than to a wider one.
- `BaseLayout.astro` gained a single `head` slot, last in `<head>`, for the
  per-page tags the layout does not model; `/cari` uses it for
  `noindex, follow` alongside the existing `Disallow: /cari` (the two do
  different jobs — one stops the fetch, the other stops the indexing).
