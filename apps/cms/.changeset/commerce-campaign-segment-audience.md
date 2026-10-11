---
"awcms": minor
---

feat(commerce): campaigns can take a CRM segment as their audience (Issue #362, epic #280)

`sql/1007` adds `segment_id`, `segment_version` and `segment_as_of` (all NULL for a legacy campaign) to `awcms_commerce_campaigns`, with a composite foreign key to `awcms_commerce_segment_versions`. The campaign is pinned to a segment version when the draft is written and records the as-of the dispatcher first evaluated it at (stamped once by the claim). Behind the new `features.campaignSegmentAudience` flag (default OFF; also needs `campaigns` and `segments`).

`application/campaign-segment-audience.ts` supplies the dispatcher's segment page resolver: the segment rule runs under `runBoundedEvaluation` and the customer's active account, `marketing_consent_at IS NOT NULL`, channel address and the not-yet-a-recipient resume cursor are appended after the rule in `application/segment-sql.ts` (`CampaignReach`). A refused page is deferred (the campaign stays `sending`). `POST .../campaigns` and `PATCH .../campaigns/{id}` take `segmentId` / `segmentVersion` (needs `commerce.segments.read`); `.../preview` (needs `commerce.segment_previews.read`) and `.../send` evaluate a segment audience within the bounds (`422 SEGMENT_TOO_EXPENSIVE`, `429 SEGMENT_EVALUATION_BUSY`, `409 FEATURE_DISABLED`), and a count under five is withheld. Admin: segment picker on `/admin/commerce-campaigns`, a Features toggle. Fix: `updateCampaign` bound the audience as a JSON string scalar.
