🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0049-install-metadata-is-derived-at-build-time-and-the-ios-help-page-is-opt-in.id.md)

# ADR-0049 — Install metadata is derived at build time, and the iOS install-help page is opt-in

- **Status:** Accepted
- **Date:** 18 October 2026
- **Decision maker:** ahliweb
- **Related:** issue [#428](https://github.com/ahliweb/awcms-one/issues/428); [ADR-0002](0002-static-output-with-build-time-fetch-for-the-storefront.md) (static output); [ADR-0018](0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) (template, profiles and what `template:init` rewrites); push subscription is owned by [#429](https://github.com/ahliweb/awcms-one/issues/429), [#430](https://github.com/ahliweb/awcms-one/issues/430) and [#431](https://github.com/ahliweb/awcms-one/issues/431), not by this ADR

## Context

`/manifest.webmanifest` existed since issue #24 with a single SVG icon, no `id`, a name copied from the site identity and no iOS metadata. iOS 16.4 and later runs a site added to the Home Screen as a standalone web app, and only that form can ever receive web push, so an installable, branded, correctly identified storefront is the precondition for the push issues. Three questions needed a durable answer because every derived repository inherits it: where the PNG icons come from without making `template:init` rewrite a binary, what the installed app's identity is, and how an optional install-help page exists without costing a build that does not want it.

## Decision

**D1 — The manifest is extended, never duplicated.** One manifest, built by the pure `buildManifest()` in `apps/storefront/src/lib/pwa-manifest.ts`, served by the existing `manifest.webmanifest.ts`. It gains `id`, `lang`, `categories` and PNG icons; `name` and `short_name` still come from `getSiteIdentity()` (CMS, `SITE_NAME`, or the `DEFAULT_IDENTITY` that `template:init` rewrites), so nothing BjekMart-specific is added to the generic template.

**D2 — `id` is `"/"`, `scope` and `start_url` are `"/"`.** The id resolves against the origin, so two sites, profiles or tenants are different installed apps because their origins differ; keeping it independent of `start_url` and of the profile means a later change to either does not orphan existing installs. Everything stays on the storefront origin. This app registers no service worker **by default**; the CMS keeps its own `/admin` PWA and `/push-sw.js` on its own origin, and a service worker is never registered cross-origin. *(Amended by issue #431: a build with the opt-in `PUBLIC_CUSTOMER_PUSH` flag adds exactly one push-only worker of its own at `/sw-notifikasi.js`, as [ADR-0048](0048-customer-web-push-identity-subscription-and-cross-origin-contract.md) decides; without the flag this sentence is still literally true.)*

**D3 — The PNG icons are generated at build time from the site name's first letter and the theme primary colour.** `apps/storefront/src/lib/pwa-ikon.ts` is a dependency-free PNG encoder; `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable-512.png` and `/apple-touch-icon.png` are prerendered endpoints. Options considered:

| Option | Verdict |
| --- | --- |
| Commit PNGs rasterised from `favicon.svg` | Rejected: `template:init` cannot rasterise, so a derived repo would ship BjekMart's mark until someone replaces them by hand. |
| Add an image library (for example `sharp`) to rasterise the SVG | Rejected: a native build-time dependency and a new supply-chain surface for four small files. |
| **Derive from `identity.name` and `theme.primary`** | **Chosen:** both are already rewritten by `template:init` or set by the CMS, so there is no new rewrite target and nothing to forget. The trade is a plain letter-on-colour mark rather than a logo; a deployment that wants its own art replaces the endpoints. |

The `maskable` and the Apple icons are full-bleed (iOS paints transparent pixels black and rounds the corners itself); the `any` icons have transparent rounded corners.

**D4 — iOS metadata is static `<head>` markup in `BaseLayout.astro`:** `apple-touch-icon`, `theme-color`, `mobile-web-app-capable`, `apple-mobile-web-app-capable`, `apple-mobile-web-app-title` (the manifest `short_name`) and `apple-mobile-web-app-status-bar-style=default`. No script, no CSP effect.

**D5 — The install-help page is behind `PUBLIC_INSTALL_HELP`, off by default.** Only an explicit `1`, `true`, `on` or `yes` turns it on, read at build time in `apps/storefront/src/lib/pasang-aplikasi.ts`. On, `integrations/profil.mjs` injects `/pasang-aplikasi` from `src/install/` (outside `src/pages/`, so it is routed only when on), the footers link to it, and one same-origin module detects standalone mode. Off, none of that exists: no route, no link, no script, no sitemap entry, and the CSP artifact is identical either way (the script is same-origin). The page is `noindex` and is deliberately not in `ROUTES`, so it never enters navigation, sitemaps or the profile matrices. It never requests a permission and never subscribes to push; it states that a browser tab cannot receive notifications once closed.

## Consequences

- Every profile (`toko`, `berita`, `landing`) ships a valid manifest and real PNGs; `tests/pwa-manifest*.test.ts` and the e2e suite pin that.
- A deployment cannot get a logo icon without replacing the icon endpoints; the CMS-uploaded favicon (`faviconMediaId`) is still not resolved at build time, as before.
- The flag is a per-deployment build choice, like `PUBLIC_GA_ID`; turning it on needs a rebuild.
- Real-device behaviour (iOS Home Screen install, Chrome install prompt) is verified by hand; the automated suite covers the contract, not the platforms.
