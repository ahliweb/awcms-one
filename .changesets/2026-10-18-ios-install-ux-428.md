---
bump: minor
type: structure
impact: public
---

# Storefront manifest hardening and iOS Home Screen install help (#428)

The existing `/manifest.webmanifest` is extended, not replaced, for every build profile (`toko`, `berita`, `landing`); ADR-0049 records the decisions.

- The manifest gains a stable `id` (`/`), `lang`, a per-profile `categories` hint and a `short_name` of at most 12 characters; `name` still comes from the site identity, so nothing BjekMart-specific enters the template.
- PNG icons at 192 and 512 (plus a maskable 512) and an `apple-touch-icon` are generated at build time from the site's first letter and theme colour, so `template:init` needs no new rewrite target.
- Every page gets the iOS web-app meta tags and `theme-color` (static markup, no script).
- New opt-in help page `/pasang-aplikasi` for adding the site to an iPhone Home Screen, behind the build flag `PUBLIC_INSTALL_HELP` (off by default; absent from the build when off, with no JavaScript, CSP or SEO impact). It never requests a notification permission and states that a browser tab cannot receive closed-app notifications.
- No service worker and no push subscription are added; the CMS keeps its own admin PWA on its own origin.
