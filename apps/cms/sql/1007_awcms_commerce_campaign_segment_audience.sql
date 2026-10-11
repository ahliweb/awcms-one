-- Issue #362 (ADR-0042 Amendment, epic #280 Wave B; PRD S3/S4; threat model
-- C-12, C-28, C-29) - a campaign may take a CRM segment as its audience.
--
-- Three nullable columns on the EXISTING `awcms_commerce_campaigns` table, no
-- new table and no copy of any customer row:
--
--   segment_id / segment_version  the segment version the campaign was pinned
--                                 to when the draft was written. Versions are
--                                 immutable (sql/1001), so editing the segment
--                                 later never changes what this campaign sends
--                                 to - and a past send stays explainable (C-29).
--   segment_as_of                 the server instant the audience was evaluated
--                                 at. Set ONCE by the dispatcher's claim (the
--                                 first time it picks the campaign up) and kept
--                                 across resumed ticks, so every page of one
--                                 send is evaluated against the same instant and
--                                 the rule's relative windows mean the same
--                                 thing on page 1 and page 40.
--
-- A campaign with no segment (every campaign that existed before this change)
-- has all three NULL and resolves its audience exactly as before.
--
-- The composite foreign key targets the unique (tenant_id, segment_id, version)
-- key of `awcms_commerce_segment_versions`, so a campaign can only point at a
-- version of a segment of ITS OWN tenant (a cross-tenant id fails the key even
-- before RLS) and a referenced version can never be deleted. A NULL segment_id
-- leaves the key unchecked (MATCH SIMPLE), which is what a legacy campaign has.
--
-- `awcms_app` keeps its table-level grant (sql/019's default privileges) and
-- `awcms_worker` already holds SELECT/UPDATE on campaigns (sql/929) and SELECT
-- on both segment tables (sql/1004), which is all the dispatcher needs.

ALTER TABLE awcms_commerce_campaigns
  ADD COLUMN IF NOT EXISTS segment_id uuid,
  ADD COLUMN IF NOT EXISTS segment_version integer,
  ADD COLUMN IF NOT EXISTS segment_as_of timestamptz;

ALTER TABLE awcms_commerce_campaigns
  ADD CONSTRAINT awcms_commerce_campaigns_segment_shape_check
    CHECK (
      (segment_id IS NULL) = (segment_version IS NULL)
      AND (segment_id IS NOT NULL OR segment_as_of IS NULL)
    ),
  ADD CONSTRAINT awcms_commerce_campaigns_segment_version_fk
    FOREIGN KEY (tenant_id, segment_id, segment_version)
    REFERENCES awcms_commerce_segment_versions (tenant_id, segment_id, version);

-- The FK's referencing side, and "which campaigns used this segment version".
CREATE INDEX IF NOT EXISTS awcms_commerce_campaigns_segment_idx
  ON awcms_commerce_campaigns (tenant_id, segment_id, segment_version)
  WHERE segment_id IS NOT NULL;

COMMENT ON COLUMN awcms_commerce_campaigns.segment_id IS
  'Issue #362 (ADR-0042 Amendment) - the CRM segment this campaign targets; NULL for a campaign using the legacy audience filters. Always set together with segment_version.';
COMMENT ON COLUMN awcms_commerce_campaigns.segment_version IS
  'Issue #362 - the immutable segment version the campaign is pinned to (C-29).';
COMMENT ON COLUMN awcms_commerce_campaigns.segment_as_of IS
  'Issue #362 - the server instant the segment audience was evaluated at; set by the dispatcher the first time it claims the campaign and never changed afterwards.';
