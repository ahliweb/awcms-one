---
bump: minor
type: structure
impact: public
---

# apps/storefront: the public catalog and product-detail storefront

Adds the fourth workspace member, `apps/storefront` (issue #5): an Astro app with `output: "static"` that fetches the catalog from `apps/cms` at **build** time and bakes it — the running container holds no API token and never reaches the database. Catalog at `/`, product pages at `/product/{slug}` with no trailing slash, matching the live `mart.borneojek.com` URL shape so indexed URLs, bookmarks, and shared links survive the cutover unchanged; `/products` (with or without a query string) 301s to `/`.

- `price` is carried as the `numeric(14,2)` **string** PostgreSQL emits and formatted only for display with `Intl.NumberFormat`; nothing in the app parses it into money arithmetic.
- The build fails loudly on a non-2xx, a `{success:false}` envelope, a catalog where no product is `active`, or a cursor that never terminates — a storefront that silently publishes an empty catalog is worse than a red build.
- CSP-strict by construction: `inlineStylesheets: "never"` and `assetsInlineLimit: 0`, so no inline `<style>`, `<script>`, or `data:` URI is ever emitted. CMS-supplied `labelColor` badges are compiled into a generated external stylesheet (`product-labels.css`) rather than inline styles, with a WCAG-contrast-chosen foreground.
- JSON-LD is written through an escaper that turns `<`, `>`, `&` into `\uXXXX` after `JSON.stringify` — the HTML parser closes a `<script>` at the first `</script>` regardless of `type`, so a product name containing one would otherwise break out of the data block. A committed fixture (`XSS-REGRESI-01`) guards it.
- The build is reproducible offline against `apps/storefront/scripts/stub-awcms.mjs` + `apps/storefront/tests/fixtures/awcms/`.
- The DTO unions are declared locally for now; issue #6 replaces them with a re-export from `@awcms-one/kontrak`.
