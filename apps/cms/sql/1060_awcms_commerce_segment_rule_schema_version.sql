-- Issue #390 (ADR-0051, epic #280 item 7, second half) - the rule schema a CRM
-- segment version was written under, so booking-derived fields can join the
-- closed vocabulary without changing what any stored version means (control
-- C-29).
--
-- ## Why a column and not "the highest schema that happens to validate"
--
-- Rule schema 2 is a strict superset of schema 1, so a schema-1 rule would
-- validate under schema 2 as well. That is exactly why the version has to be
-- STORED: a stored version is re-validated under the schema it was written
-- under (`resolveSegmentRules`), so a version of schema 1 can never gain a field
-- of schema 2 by being read by newer code, and a later schema 3 that changes a
-- field's meaning cannot silently reinterpret a past audience. The column is
-- the version of the grammar, as `version` is the version of the rules.
--
-- ## Old rows
--
-- `DEFAULT 1` is exactly what every existing row is: they were written before
-- schema 2 existed. Adding a column with a constant default is a catalogue-only
-- change on PostgreSQL (no table rewrite, no row UPDATE), so the immutability
-- trigger of `sql/1001` is not involved and `awcms_app` still holds no UPDATE
-- on the table. New versions are inserted with the application's current schema
-- (2 at the time of writing); the application, not the database, decides which
-- schemas it can read, so the CHECK only forbids a nonsensical value and a
-- future schema needs no migration.
--
-- Nothing else changes: no table, no index, no policy. The booking fact scans
-- read tables that already exist, under their own RLS.

ALTER TABLE awcms_commerce_segment_versions
  ADD COLUMN IF NOT EXISTS rule_schema_version integer NOT NULL DEFAULT 1
    CONSTRAINT awcms_commerce_segment_versions_rule_schema_check
    CHECK (rule_schema_version >= 1);

COMMENT ON COLUMN awcms_commerce_segment_versions.rule_schema_version IS
  'Issue #390 (ADR-0051, C-29) - the rule-vocabulary schema this version was written under; it is re-validated under the same schema whenever it is read. 1 = the PRD 6.1 commerce vocabulary, 2 = adds the booking-derived fields.';
