-- Issue #360 (ADR-0042, epic #280 Wave B) - CRM segment definitions with
-- immutable, versioned rules (PRD sections 4.5 and 6.1, threat model F8).
--
-- Two tables, and deliberately NO table of members:
--
--   awcms_commerce_segments          the mutable head: a name, a description,
--                                    the number of the latest version, and a
--                                    soft-delete marker (`retired_at`).
--   awcms_commerce_segment_versions  one IMMUTABLE row per version of the rule
--                                    tree. Editing a segment inserts version
--                                    N+1; version N is never updated (the
--                                    trigger below refuses it, and `awcms_app`
--                                    holds no UPDATE or DELETE on the table).
--
-- A segment never stores customer rows (PRD S1): membership is DERIVED by
-- evaluating a version's rules against `awcms_commerce_customers` and its
-- order and loyalty facts, on demand, under the caller's tenant RLS. Nothing
-- here copies a name, a phone or an e-mail.
--
-- ## Delete keeps referenced versions (control C-29)
--
-- Deleting a segment sets `retired_at` on the head; every version row stays,
-- so a past campaign or earn that recorded `(segment_id, version)` can still
-- be explained. `deleted_at` exists on both tables for the generic retention
-- engine's cursor (`commerce/domain/segment-lifecycle.ts`) and this module
-- NEVER sets it, so the purge predicate can never match - the same
-- "practically unreachable" shape the register and expense tables use. Rules
-- are a closed vocabulary of typed scalars (no free text), so keeping them
-- indefinitely retains no personal data.
--
-- The tenant-isolation policy, FORCE RLS, the `(tenant_id, id)` composite
-- unique keys the version FK needs, and an index per foreign key follow the
-- module's other tables (`sql/990`).

CREATE TABLE IF NOT EXISTS awcms_commerce_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  name text NOT NULL,
  description text,
  latest_version integer NOT NULL DEFAULT 1,
  retired_at timestamptz,
  retired_by_tenant_user_id uuid,
  created_by_tenant_user_id uuid NOT NULL,
  updated_by_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_segments_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_segments_name_check
    CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT awcms_commerce_segments_description_check
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 500),
  CONSTRAINT awcms_commerce_segments_latest_version_check
    CHECK (latest_version >= 1),
  CONSTRAINT awcms_commerce_segments_retired_shape_check
    CHECK ((retired_at IS NULL) = (retired_by_tenant_user_id IS NULL))
);

-- A live segment's name is unique per tenant (case-insensitive); a retired
-- segment frees its name.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_segments_tenant_name_key
  ON awcms_commerce_segments (tenant_id, lower(name))
  WHERE retired_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_segments_tenant_idx
  ON awcms_commerce_segments (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_segments_tenant_deleted_idx
  ON awcms_commerce_segments (tenant_id, deleted_at);

-- The admin list: segments, newest first.
CREATE INDEX IF NOT EXISTS awcms_commerce_segments_tenant_created_idx
  ON awcms_commerce_segments (tenant_id, created_at DESC, id DESC);

ALTER TABLE awcms_commerce_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_segments FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_segments_tenant_isolation
  ON awcms_commerce_segments
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- The application never hard-deletes a segment: it retires it.
REVOKE DELETE ON awcms_commerce_segments FROM awcms_app;

-- Identity columns are frozen, the version counter only moves forward, and a
-- retired segment stays retired. The BEGIN/END below are PL/pgSQL block
-- delimiters in a dollar-quoted body, not transaction control (`sql/033`'s
-- precedent).
CREATE OR REPLACE FUNCTION awcms_commerce_segments_guard()
RETURNS trigger AS $awcms_commerce_segments_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.created_by_tenant_user_id IS DISTINCT FROM OLD.created_by_tenant_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_segments row % is frozen: identity and creator never change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.latest_version < OLD.latest_version THEN
    RAISE EXCEPTION
      'awcms_commerce_segments row %: latest_version only moves forward',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.retired_at IS NOT NULL AND (
    NEW.retired_at IS DISTINCT FROM OLD.retired_at
    OR NEW.latest_version IS DISTINCT FROM OLD.latest_version
    OR NEW.name IS DISTINCT FROM OLD.name
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_segments row % is retired and stays retired',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_segments_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_segments_guard
  ON awcms_commerce_segments;
CREATE TRIGGER awcms_commerce_segments_guard
  BEFORE UPDATE ON awcms_commerce_segments
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_segments_guard();

CREATE TABLE IF NOT EXISTS awcms_commerce_segment_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  segment_id uuid NOT NULL,
  version integer NOT NULL,
  rules jsonb NOT NULL,
  node_count integer NOT NULL,
  depth integer NOT NULL,
  created_by_tenant_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_segment_versions_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_segment_versions_segment_fk
    FOREIGN KEY (tenant_id, segment_id)
    REFERENCES awcms_commerce_segments (tenant_id, id),
  CONSTRAINT awcms_commerce_segment_versions_version_key
    UNIQUE (tenant_id, segment_id, version),
  CONSTRAINT awcms_commerce_segment_versions_version_check
    CHECK (version >= 1),
  CONSTRAINT awcms_commerce_segment_versions_rules_check
    CHECK (jsonb_typeof(rules) = 'object'),
  CONSTRAINT awcms_commerce_segment_versions_size_check
    CHECK (pg_column_size(rules) <= 16384),
  CONSTRAINT awcms_commerce_segment_versions_node_count_check
    CHECK (node_count BETWEEN 1 AND 25),
  CONSTRAINT awcms_commerce_segment_versions_depth_check
    CHECK (depth BETWEEN 0 AND 4)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_segment_versions_tenant_idx
  ON awcms_commerce_segment_versions (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_segment_versions_tenant_deleted_idx
  ON awcms_commerce_segment_versions (tenant_id, deleted_at);

-- The FK column's own index: a segment's versions, newest first.
CREATE INDEX IF NOT EXISTS awcms_commerce_segment_versions_segment_idx
  ON awcms_commerce_segment_versions (segment_id, version DESC);

ALTER TABLE awcms_commerce_segment_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_segment_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_segment_versions_tenant_isolation
  ON awcms_commerce_segment_versions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only for the application role. The trigger is the second line: it
-- also stops a role that does hold UPDATE.
REVOKE UPDATE, DELETE ON awcms_commerce_segment_versions FROM awcms_app;

CREATE OR REPLACE FUNCTION awcms_commerce_segment_versions_reject_update()
RETURNS trigger AS $awcms_commerce_segment_versions_reject_update$
BEGIN
  RAISE EXCEPTION
    'awcms_commerce_segment_versions is immutable: an edit is a new version'
    USING ERRCODE = 'restrict_violation';
END;
$awcms_commerce_segment_versions_reject_update$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_segment_versions_reject_update
  ON awcms_commerce_segment_versions;
CREATE TRIGGER awcms_commerce_segment_versions_reject_update
  BEFORE UPDATE ON awcms_commerce_segment_versions
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_segment_versions_reject_update();

COMMENT ON TABLE awcms_commerce_segments IS
  'Issue #360 (ADR-0042) - the mutable head of a CRM segment. Stores no customer rows; membership is derived on demand.';
COMMENT ON TABLE awcms_commerce_segment_versions IS
  'Issue #360 (ADR-0042) - one immutable version of a segment rule tree (closed JSON vocabulary, typed scalars only). Consumers record (segment_id, version).';
