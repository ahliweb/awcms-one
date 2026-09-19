🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md)

# ADR-0007 — Cart, checkout and order tracking stay static; the browser calls the CMS's anonymous commerce endpoints directly

- **Status:** Accepted
- **Date:** 16 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0002](0002-static-output-with-build-time-fetch-for-the-storefront.md) (left intact by this decision); [ADR-0009](0009-guest-checkout-by-order-code-and-phone.md); [issue #21](https://github.com/ahliweb/awcms-one/issues/21) (amendment comment); [issue #29](https://github.com/ahliweb/awcms-one/issues/29); [issue #30](https://github.com/ahliweb/awcms-one/issues/30); `apps/cms/docs/adr/` ADR-0049 (machine credentials are read-only), ADR-0103/0107/0118 (anonymous cross-origin endpoints for statically built sites) — `ahliweb/awcms`'s own numbering space, carried by the subtree embed

## Context

ADR-0002 made the storefront fully static and said that the moment checkout exists a runtime read must be argued separately. Increment 2 builds checkout, so this is that argument — and it went through two rounds.

The first plan was a hybrid: keep the site static, make cart/checkout/tracking the only `prerender = false` routes, and have `apps/storefront/server/penyaji.mjs` proxy them to `apps/cms` with a runtime machine credential scoped to `commerce.storefront.*`. Two facts in `apps/cms` overturned it:

1. **Machine credentials are read-only by construction** (`apps/cms`'s own ADR-0049; `identity_access`'s README: "the `read` action only, enforced before permissions are consulted"). A storefront token could never create an order — not by policy, by code.
2. **The family already has an answer for a statically built site that must write.** The anonymous newsletter, site-search and comments endpoints (`apps/cms`'s own ADR-0103, ADR-0107, ADR-0118) resolve the tenant from the request's `Origin` through `awcms_tenant_domains` — never from a header the caller controls — answer the `OPTIONS` preflight, echo the allowed origin verbatim (never `*`), send `Vary: Origin` on every response, grant no credentials, rate-limit per IP, and answer neutrally wherever a distinguishing response would leak. That pattern exists precisely because "the host of a request from a statically built site is this CMS" (its own words), i.e. for exactly this storefront.

| | A. Everything server-rendered | B. Static + SSR proxy with a scoped credential (first plan) | C. Static; browser calls anonymous commerce endpoints cross-origin (**chosen**) | D. "Checkout" is a WhatsApp message |
| --- | --- | --- | --- | --- |
| Security | live credential + DB path on every page | a runtime credential in the container — and one that awcms would not let write anyway | **no credential anywhere**; the CMS's hardened anonymous-write surface (Origin-bound tenant, rate limits, idempotency, neutral responses) | none, and no order either |
| Performance / scalability | every page rendered | static pages static; proxy hop per cart action | static pages static and CDN-cacheable; cart calls go browser→CMS with no middle hop | static |
| SEO | every crawl depends on the CMS | static | static; cart/checkout/tracking are `noindex` by nature | static |
| Accessibility / UX | — | forms work without JS | checkout needs JavaScript — as the reference site (an Inertia SPA) already does; the cart page carries a no-JS fallback (WhatsApp order link with the summary prefilled); keyboard/screen-reader support is unaffected | fine, no order state |
| Maintainability | ADR-0002's invariants gone | a second rendering mode + an enumerated route list to police | **ADR-0002 unchanged**; `penyaji.mjs` unchanged except one `connect-src` entry; one client module talks to the CMS | nothing transactional built |
| Compatibility with the CMS | fine | fights ADR-0049 | uses the pattern the CMS built for this case | — |
| Operational complexity | one server that must be up | a runtime handler + a credential to rotate | one public origin to register in `awcms_tenant_domains` | none |
| Long-term | boundary erodes by default | a list to keep short | accounts (#32) arrive as more anonymous-then-authenticated endpoints on the same rails | dead end |

## Decision

`apps/storefront` stays `output: "static"` with **no** `prerender = false` route and **no** runtime credential — a unit test (`apps/storefront/tests/checkout-guard-no-prerender.test.ts`) asserts that no file under `apps/storefront/src/pages` opts out of prerendering. Cart, checkout and order tracking are static pages whose client-side JavaScript calls `https://<cms>/api/v1/commerce/storefront/*` directly. Those endpoints (issue #29) are built on `newsletter/application/public-newsletter-tenant.ts` + `domain/newsletter-cors.ts`'s pattern: tenant from `Origin`, preflight, echoed origin, `Vary: Origin`, per-IP and per-phone rate limits, an idempotency key on order creation (the cart's client-generated UUID, reused as the request's idempotency key), and one neutral 404 for "unknown order" and "wrong phone" alike.

The CMS origin is the only new configuration: `PUBLIC_AWCMS_ORIGIN`, deliberately `PUBLIC_`-prefixed (it is an origin, not a secret — the same value every media URL already reveals), validated at build time and baked into the CSP's `connect-src` via the same derived-artifact mechanism ADR-0002 already built for `img-src` (`csp-asal-media.ts` / `dist/client/csp.json`, re-validated by `apps/storefront/server/penyaji.mjs` at startup — see `docs/arsitektur.md`). `AWCMS_API_TOKEN` stays build-time and read-only; nothing after the build reads any `AWCMS_*` variable.

## Consequences

- Price and stock on the static pages remain as fresh as the last build (ADR-0002's stated trade). The cart page re-quotes every line against the CMS before checkout, so a stale static price never becomes an order line; a changed price is shown, never silently corrected.
- The storefront container never sees an order, a phone number, or a payment instruction — those travel browser ↔ CMS directly, `mode: "cors"` / `credentials: "omit"`. Nothing customer-related is stored in the storefront, and its logs cannot contain PII by construction.
- The seeded tenant must have its storefront origins registered in `awcms_tenant_domains` (`mart.borneojek.com` and `http://localhost:4321` for development, per `tools/seed-borneojek-mart.ts`); an unregistered origin gets the neutral refusal, which is the intended failure mode.
- Customer accounts (#32) added authenticated endpoints beside these anonymous ones, on the same static-page-plus-browser-call rails this ADR already established — **as built**, the session strategy was an opaque bearer token in `localStorage` (`customerBearer`), not the BFF handoff pattern this ADR once flagged as the starting point; see [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D3 for the argument and why a cookie-based approach was rejected specifically because of this ADR's own cross-origin commitment.
