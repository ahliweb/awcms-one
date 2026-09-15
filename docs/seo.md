🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](seo.id.md)

# SEO

What `apps/storefront` emits for search engines and link previews, read directly from [`apps/storefront/src/layouts/BaseLayout.astro`](../apps/storefront/src/layouts/BaseLayout.astro) and [`src/pages/product/[slug].astro`](../apps/storefront/src/pages/product/[slug].astro) — the two files responsible for everything below.

## Per-page metadata

Every page renders through `BaseLayout`, which sets: a `<title>` (page title, or `{title} — {siteConfig.name}` when they differ), a `<meta name="description">` truncated to 160 characters, a `<link rel="canonical">` built from `siteConfig.siteUrl` (`SITE_URL`) plus the page's own `canonicalPath`, and Open Graph tags (`og:type` fixed to `"website"`, `og:url`, `og:title`, `og:description`, `og:site_name`, `og:locale` fixed to `id_ID`). There is no `og:image`: `CommerceProduct` carries no product-photo field in this slice (see [`docs/cms.md`](cms.md)), and publishing an `og:image` pointing at a file that does not exist would be worse than omitting the tag.

`og:type` stays `"website"` even on a product page — Open Graph's `"product"` type is only valid alongside its own namespace prefix and `product:price:*` meta tags, neither of which this app declares. The structured price/availability data goes through `Product` JSON-LD instead (below), not through OG meta, so half-implementing the OG product type would be less correct, not more.

## `Product` JSON-LD on the detail page

`src/pages/product/[slug].astro` builds one `Product` node per product:

```json
{
  "@type": "Product",
  "name": "...", "sku": "...", "description": "...", "category": "...",
  "offers": {
    "@type": "Offer",
    "url": "https://mart.borneojek.com/product/...",
    "price": "150000.00",
    "priceCurrency": "IDR",
    "availability": "https://schema.org/InStock"
  }
}
```

`offers.price` is the **raw** `numeric(14,2)` decimal string awcms sends — unformatted, because schema.org's `price` property wants a plain decimal (`"150000.00"`), not a locale-formatted one (`"Rp150.000"`), and Google's structured-data validator rejects the latter. `priceCurrency` is hardcoded `"IDR"`. `availability` is **derived from `stock`** — `InStock` when `stock > 0`, `OutOfStock` otherwise — never carried as a field `apps/cms` could independently disagree with itself about.

## The JSON-LD escaping is a real XSS defence, not a formality

`schema` is built from CMS-supplied strings (a product's `name`, `description`, a category's `name`). `JSON.stringify` escapes quotes and backslashes but **not** `<` — and the HTML *parser*, not the JavaScript engine, ends a `<script>` element at the first `</script>` byte sequence it meets, no matter what `type` attribute the tag carries. A product named `…</script><script>alert(1)</script>` would otherwise close the JSON-LD block early and turn the text after it into real, executing markup: a stored-XSS surface that only the CSP in `apps/storefront/server/penyaji.mjs` (`script-src 'self'`) would stand between it and running — real protection, but not one a page should depend on as the *only* protection.

`BaseLayout.astro`'s `jsonForScript()` closes this by replacing `<`, `>`, and `&` with their `\uXXXX` JSON escapes before the value is written into the page — none of the three is meaningful inside a JSON string, so the escaped form parses back byte-identical, while giving the HTML parser no `<` to ever start a tag with. This is proven by a regression fixture, not merely argued in a comment: `apps/storefront/tests/fixtures/awcms/products.json` carries a fixture named `XSS-REGRESI-01` specifically to exercise this path.

## Canonical URLs and the redirect

Every canonical URL is absolute, built from `SITE_URL`, and matches the live site's URL shape — see [ADR-0005](adr/0005-product-urls-match-the-live-sites-shape.md) and [`docs/routing.md`](routing.md) for the `/product/{slug}` shape and the `/products` → `/` redirect this preserves.

## Not built

A sitemap, an RSS/Atom feed, `robots.txt`, structured data for the catalog listing page itself (only product detail pages carry `Product` JSON-LD), and any SEO surface that would need a runtime request to `apps/cms` — everything above is decided once, at build time.
