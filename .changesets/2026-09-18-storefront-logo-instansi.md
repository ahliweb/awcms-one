---
bump: minor
type: content
impact: public
---

# Logo Instansi — an institution's emblem beside the article it filed

Issue #59 (C1), the last of its three steps. seputarborneo.com v2.3.0 lets
an editor attach a regency's emblem to an ARTICLE; here every such article
is already filed under that regency's institution, so the emblem hangs off
the institution instead — upstream awcms#806's `logo_media_id`/`logo_alt`,
carried in by the `apps/cms` subtree pull (step 2, PR #68), resolved
through issue #47's media client.

- `/berita/{slug}` renders the emblem as a float beside the opening
  paragraph, linked to that institution's own page, with no background or
  border (an emblem is nearly always a transparent PNG/SVG — upstream's
  2.3.2 release removed those decorations for the same reason).
- `/mitra/{slug}` shows the same emblem on the institution's landing page,
  which until now rendered only a name, a description and a post list.
- One upload serves every article of that institution and changing it
  updates them all — the property seputarborneo's own "satu logo dipakai
  berulang" rule was after, with one source of truth instead of a per-post
  picker that can disagree with the channel the article is filed under.
- An article with no institution, an institution with no emblem, or a
  stale media id renders nothing at all: no empty frame, no broken image.

Only felt while developing: `RawInstitution.logoMediaId`/`logoAlt` are
OPTIONAL, so a build pointed at an `apps/cms` older than the subtree pull
renders no emblem rather than crashing on a missing property; every
emblem in the list resolves in the same batched `resolveMedia` call the
post images already use.
