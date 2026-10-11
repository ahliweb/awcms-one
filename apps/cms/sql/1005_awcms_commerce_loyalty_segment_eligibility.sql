-- Issue #361 (ADR-0042 amendment, epic #280 Wave B, PRD L1/S3) - a loyalty
-- program version may be restricted to a CRM segment.
--
-- Two nullable columns on `awcms_commerce_loyalty_programs` record WHICH
-- immutable segment version the program used:
--
--   eligibility_segment_id       the segment (head) the program is restricted to
--   eligibility_segment_version  the pinned, immutable version of its rules
--
-- Both are NULL (the default) for "every customer earns", which is exactly
-- today's behaviour, so the migration changes nothing for an existing tenant.
-- Both are set together or not at all, and the pair is a COMPOSITE foreign key
-- to `awcms_commerce_segment_versions (tenant_id, segment_id, version)`: a
-- program can never point at another tenant's segment, nor at a version that
-- does not exist. The reference is RESTRICT (the default): segments are never
-- hard-deleted by the application (delete RETIRES the head and keeps every
-- version), so a past earn stays explainable (threat model C-29).
--
-- ## Immutable once the program leaves draft
--
-- A ledger earn row says "earned under program version N", and the program row
-- says "version N was restricted to segment S version V". If the restriction
-- could be edited after activation, that sentence would stop being true, so a
-- trigger refuses any change to the two columns unless the OLD row is a draft
-- (the same rule the application enforces for every other rule field, here
-- also held below the application). Editing the SEGMENT is a new segment
-- version; it never rewrites what a program recorded.
--
-- ## Worker access
--
-- The domain-event consumer that earns points runs as `awcms_worker`, which
-- already holds SELECT on the segment tables (`sql/1004`), customers, orders,
-- customer accounts and loyalty accounts; nothing more is granted.

ALTER TABLE awcms_commerce_loyalty_programs
  ADD COLUMN IF NOT EXISTS eligibility_segment_id uuid,
  ADD COLUMN IF NOT EXISTS eligibility_segment_version integer;

DO $awcms_loyalty_eligibility$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'awcms_commerce_loyalty_programs_eligibility_pair_check'
  ) THEN
    ALTER TABLE awcms_commerce_loyalty_programs
      ADD CONSTRAINT awcms_commerce_loyalty_programs_eligibility_pair_check
      CHECK (
        (eligibility_segment_id IS NULL) = (eligibility_segment_version IS NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'awcms_commerce_loyalty_programs_eligibility_segment_fk'
  ) THEN
    ALTER TABLE awcms_commerce_loyalty_programs
      ADD CONSTRAINT awcms_commerce_loyalty_programs_eligibility_segment_fk
      FOREIGN KEY (tenant_id, eligibility_segment_id, eligibility_segment_version)
      REFERENCES awcms_commerce_segment_versions (tenant_id, segment_id, version);
  END IF;
END
$awcms_loyalty_eligibility$;

-- The FK columns' own index (partial: most programs are unrestricted).
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_programs_eligibility_segment_idx
  ON awcms_commerce_loyalty_programs (tenant_id, eligibility_segment_id)
  WHERE eligibility_segment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION awcms_commerce_loyalty_programs_eligibility_guard()
RETURNS trigger AS $awcms_commerce_loyalty_programs_eligibility_guard$
BEGIN
  IF OLD.status <> 'draft' AND (
    NEW.eligibility_segment_id IS DISTINCT FROM OLD.eligibility_segment_id
    OR NEW.eligibility_segment_version IS DISTINCT FROM OLD.eligibility_segment_version
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_loyalty_programs row %: the segment restriction is immutable once the version leaves draft',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_loyalty_programs_eligibility_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_loyalty_programs_eligibility_guard
  ON awcms_commerce_loyalty_programs;
CREATE TRIGGER awcms_commerce_loyalty_programs_eligibility_guard
  BEFORE UPDATE ON awcms_commerce_loyalty_programs
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_loyalty_programs_eligibility_guard();

COMMENT ON COLUMN awcms_commerce_loyalty_programs.eligibility_segment_id IS
  'Issue #361 (ADR-0042 amendment) - the CRM segment this program version is restricted to; NULL = every customer earns.';
COMMENT ON COLUMN awcms_commerce_loyalty_programs.eligibility_segment_version IS
  'Issue #361 (ADR-0042 amendment) - the immutable segment version the restriction uses; set together with eligibility_segment_id.';
