-- Issue #437 (ADR-0045 implementation notes of #386) - which Booking
-- RESOURCE(s) a booking offering link sells. Data model:
-- docs/booking-commerce-adapter-data-model.md section 4.1.
--
-- ## Why a child table and not a nullable column on the link
--
-- `awcms_commerce_booking_offering_links` is frozen by its guard trigger
-- (sql/1035): identity, offering, product and basis never change, and the
-- reservation links point at the row for the rest of its life. A column added
-- there would either need that guard loosened (a link edited after sales) or be
-- write-once at creation. A child table keeps the link table exactly as frozen
-- as #378 made it, lets one offering sell SEVERAL resources (a hotel that sells
-- the same "Deluxe" offering from three rooms; a studio with two interchangeable
-- rooms), and is where the composite, tenant-safe foreign key to the Booking
-- resource lives.
--
-- ## Semantics (M9: existing tenants unchanged)
--
-- A link with NO row here keeps the #386 behaviour: the storefront offers the
-- tenant's active resources of the matching booking mode. A link with one or
-- more rows sells ONLY those resources: the storefront lists them (active ones)
-- and the hold refuses any other resource id. A bound link whose resources have
-- all become inactive is not sold at all - it never falls back to the whole
-- pool, or it would offer another room type.
--
-- ## Mutability
--
-- The rows are written once, with the link. `awcms_app` has no UPDATE and no
-- DELETE (revoked below, and a trigger refuses UPDATE for any other role); an
-- unlinked link keeps its rows so what was sold from which room stays
-- explainable. `awcms_worker` keeps SELECT + DELETE for the retention engine
-- only; `deleted_at` exists for that engine's cursor and this module NEVER sets
-- it. No price, no name, no customer: identifiers and an order only.
--
-- The trigger function pins search_path (the #1046 gate).

CREATE TABLE IF NOT EXISTS awcms_commerce_booking_offering_link_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  offering_link_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_booking_offering_link_resources_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_offering_link_resources_link_fk
    FOREIGN KEY (tenant_id, offering_link_id)
    REFERENCES awcms_commerce_booking_offering_links (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_offering_link_resources_resource_fk
    FOREIGN KEY (tenant_id, resource_id)
    REFERENCES awcms_booking_resources (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_offering_link_resources_pair_key
    UNIQUE (tenant_id, offering_link_id, resource_id),
  CONSTRAINT awcms_commerce_booking_offering_link_resources_sort_check
    CHECK (sort_order BETWEEN 0 AND 1000)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_booking_offering_link_resources_resource_idx
  ON awcms_commerce_booking_offering_link_resources (tenant_id, resource_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_offering_link_resources_tenant_deleted_idx
  ON awcms_commerce_booking_offering_link_resources (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_booking_offering_link_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_booking_offering_link_resources FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_booking_offering_link_resources_tenant_isolation
  ON awcms_commerce_booking_offering_link_resources
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE UPDATE, DELETE ON awcms_commerce_booking_offering_link_resources FROM awcms_app;

CREATE OR REPLACE FUNCTION awcms_commerce_booking_offering_link_resources_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_booking_offering_link_resources_guard$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'awcms_commerce_booking_offering_link_resources is immutable: unlink the offering and link it again with the resources wanted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A resource is bound while the link is created, never to an unlinked link.
  IF NOT EXISTS (
    SELECT 1 FROM awcms_commerce_booking_offering_links l
    WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.offering_link_id
      AND l.status = 'active'
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_booking_offering_link_resources: offering link % is not active',
      NEW.offering_link_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_booking_offering_link_resources_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_booking_offering_link_resources_guard
  ON awcms_commerce_booking_offering_link_resources;
CREATE TRIGGER awcms_commerce_booking_offering_link_resources_guard
  BEFORE INSERT OR UPDATE ON awcms_commerce_booking_offering_link_resources
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_booking_offering_link_resources_guard();

GRANT SELECT, DELETE ON awcms_commerce_booking_offering_link_resources TO awcms_worker;

COMMENT ON TABLE awcms_commerce_booking_offering_link_resources IS
  'Issue #437 (ADR-0045) - the Booking resource(s) a booking offering link sells. No row = the #386 fallback (every active resource of the matching mode). Identifiers and an order only; written once with the link.';
