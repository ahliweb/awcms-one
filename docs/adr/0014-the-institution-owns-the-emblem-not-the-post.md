🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0014-the-institution-owns-the-emblem-not-the-post.id.md)

# ADR-0014 — An institution owns its emblem; a post never carries one

- **Status:** Accepted
- **Date:** 18 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0001](0001-git-subtree-with-full-history-for-apps-cms.md), [ADR-0011](0011-storefront-media-resolves-through-the-media-objects-endpoint.md); issue #59; upstream `ahliweb/awcms#806`

## Context

seputarborneo.com v2.3.0 added "Logo Instansi": a regency's emblem attached to an **article** through `berita_red.id_logo`, with a `logo` table, a picker in every news form, and a rule that a logo still in use may not be deleted. The feature exists because a kabupaten's article should carry that kabupaten's mark.

This platform already models the same relationship: every such article is filed under that regency's institution (`awcms_blog_institutions`, the "Mitra" of `/mitra/{slug}`).

## Decision

The emblem hangs off the **institution** (`logo_media_id`/`logo_alt`), not the post. Because `blog_content` is upstream's module, the column was added in `ahliweb/awcms` (#806/#807) and reached this repo through a `git subtree pull` merged with a merge commit; `apps/storefront` renders it beside an article's opening paragraph and on the institution's own page.

| | Per-post picker (port it verbatim) | Additive module in this repo | Per-institution, upstream (**chosen**) |
| --- | --- | --- | --- |
| Editorial effort | an editor picks a logo on every article | same | none — filing the article under its Mitra is already the workflow |
| Consistency | an article can carry a logo that contradicts its channel | same | impossible by construction |
| "One logo reused" | a shared table plus a per-post foreign key | same | one row, one upload, every article of that channel |
| Ownership | patches a subtree this repo does not own | a second logo concept beside `media_library` | the field lives with the entity it describes, upstream, for every awcms site |

## Consequences

- Changing an institution's emblem updates every article of that channel at once — the property seputarborneo's own "satu logo dipakai berulang" rule was after, without a delete-guard, because nothing points at the emblem except the institution itself.
- `logoMediaId`/`logoAlt` are **optional** on the storefront's own type: a build pointed at an `apps/cms` older than the subtree pull renders no emblem rather than crashing.
- An article with no institution, an institution with no emblem, or a stale media id renders nothing — never an empty frame.
- Upstream's side of this also closed a real hole while it was there: `media_library` did not recognise SVG uploads at all, and now recognises **and** scans them (script elements, event handlers, `javascript:`/`data:` URIs after character-reference decoding, any `<!ENTITY`) — an emblem is the one media type most likely to arrive as an SVG.
