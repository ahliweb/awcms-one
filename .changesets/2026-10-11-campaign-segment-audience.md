---
bump: minor
type: content
impact: public
---

# Campaigns can target a CRM segment (issue #362)

A campaign can now take a CRM segment as its audience (Wave B of epic #280; PRD S3 and S4; threat-model controls C-12, C-28, C-29), **behind a new per-tenant `campaignSegmentAudience` feature that defaults OFF** (it also needs `campaigns` and `segments`). A tenant that never opens Features sees no change, and existing campaigns and their audience filters behave exactly as before.

Why it is shaped this way (ADR-0042 Amendment): no second customer store. The existing resumable, claimable dispatcher still pages through the recipient ledger; the segment's rule is evaluated under the same bounds as a preview, and the customer's consent, active account and channel address are part of the page query. So membership never implies consent - an opted-out member is refused when the campaign is enqueued and again at dispatch - and walk-in, blocked and erased customers are never targeted, even by a `NOT` rule.

- Migration `sql/1007`: `segment_id`, `segment_version`, `segment_as_of` on `awcms_commerce_campaigns` (composite FK to the immutable segment version). The campaign records the version it was pinned to and the as-of the audience was evaluated at, so a past send is explainable.
- API: `segmentId` / `segmentVersion` on campaign create and update; the campaign preview and send routes evaluate a segment audience within the segment bounds (`422 SEGMENT_TOO_EXPENSIVE`, `429 SEGMENT_EVALUATION_BUSY`, `409 FEATURE_DISABLED`); a count under five is withheld. Choosing a segment needs `commerce.segments.read`; its count needs `commerce.segment_previews.read`. No new permission key.
- Dispatch: a refused page (busy, too expensive, flag off) is deferred and the campaign stays `sending`, never `sent`.
- Admin: a segment picker on the campaign create form (only when the flags are on and the viewer may read segments), the pinned segment and as-of in the detail panel, and a "Send campaigns to a customer segment" toggle in Features.
- Fixed: `PATCH` of a campaign's audience stored the filters as a JSON string, which the dispatcher could not read.
