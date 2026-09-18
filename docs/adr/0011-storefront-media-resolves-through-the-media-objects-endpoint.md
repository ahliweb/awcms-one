🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0011-storefront-media-resolves-through-the-media-objects-endpoint.id.md)

# ADR-0011 — The storefront resolves media through `GET /api/v1/media/objects`, and the CSP is derived from what resolved

- **Status:** Accepted
- **Date:** 18 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0002](0002-static-output-with-build-time-fetch-for-the-storefront.md); issues #47, #53, #54, #59; `apps/cms/src/modules/media-library/README.md` §"Media reference resolution"

## Context

Increment 2 shipped a news surface with **no images at all**. Every media-bearing field the CMS returns — a post's `featuredMediaId`, a gallery item's `mediaObjectId`, a video block's `thumbnailMediaObjectId`, an ad placement's creative — is a bare id, and `apps/storefront` had no way to turn one into a URL. `apps/storefront/src/lib/awcms/blog.ts` recorded the reason at the time: constructing `{origin}/{id}` would have been an **invented** URL shape, which this repo's contribution rule forbids. So cards, articles and ad slots rendered text where the reference sites render photographs.

`apps/cms` has had the missing surface since its own Issue #615/#782: `GET /api/v1/media/objects?ids=…` resolves up to 100 ids per call, gated on `media_library.media.read`, returning only `verified`/`attached` objects of one tenant and **reporting** unresolvable ids rather than dropping them.

## Decision

`apps/storefront` resolves every media id through that endpoint at build time (`apps/storefront/src/lib/awcms/media.ts`), with the build credential holding `media_library.media.read`, and **derives its Content-Security-Policy from the URLs that actually resolved** rather than from a configured origin alone.

| | Invent `{origin}/{id}` | Proxy images through `penyaji.mjs` | Resolve via `media/objects` (**chosen**) |
| --- | --- | --- | --- |
| Correctness | guesses a path convention the CMS never promised | correct | correct, and unresolvable ids are reported, not silently dropped |
| Security | can leak an unpublished object's URL shape | a runtime hop that must re-authorise every request | only `verified`/`attached`, one tenant, credential-gated at build time |
| Performance | none at build; broken images for readers | a hop per image on every page view, on a static site | one batched, chunked, de-duplicated call per build; images served straight from the media origin |
| Operational complexity | none | a new runtime responsibility on a server that today only serves files | one permission on the build credential |

## Consequences

- Ids are filtered to uuid shape **before** the call: the route answers `400` for the whole chunk if any id is malformed, so one legacy gallery item would otherwise abort an entire build.
- The CSP artifact (`apps/storefront/src/pages/csp.json.ts`, consumed by `apps/storefront/server/penyaji.mjs`) gains `img-src` for every resolved public URL's origin — not merely the configured media origin — so a row still pointing at a previous media host renders instead of being blocked. Video adds `img-src https://i.ytimg.com` and `frame-src https://www.youtube-nocookie.com`, and only when the build actually contains a video post.
- A YouTube embed is a **click-to-load facade**: poster now, `<iframe>` only after a real click, and `renderPortableText`'s default stays the plain outbound link so a page that does not mount the facade script (or an RSS body) never ships an inert button.
- The same client serves issue #53's ad creatives, #54's `og:image`, and #59's institution emblems; nothing else in the app needs a second media path.
