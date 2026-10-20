-- Issue #378 (ADR-0045, epic #280 item 15) - the booking-commerce adapter's two
-- link tables: the offering link (which Booking offering is sold as which
-- commerce product) and the reservation link (which Booking reservation was
-- sold on which order line). Data model: docs/booking-commerce-adapter-data-model.md
-- sections 4.1 and 4.2.
--
-- ## What these tables are, and are not
--
-- A link holds IDENTIFIERS and a lifecycle flag, nothing else (ADR-0040 D5.8,
-- D5.9). There is no price, deposit, payment state, party size, date, name,
-- contact or CUSTOMER column on either table: the customer of a reservation is
-- the customer of the ORDER its active link points to (finding X7, ADR-0045 D3),
-- derived by a join and stored nowhere in the adapter. Booking owns the claim on
-- capacity and holds no money; the order and the payment-allocation ledger own
-- the money. The two meet only here, by composite tenant-safe foreign keys.
--
-- ## Composite keys into Booking (ADR-0045 D2)
--
-- `awcms_booking_service_offerings` and `awcms_booking_reservations` both carry
-- `UNIQUE (tenant_id, id)` (sql/180), so the database itself refuses a link to
-- another tenant's offering or reservation. Booking never references back: it
-- stores only the opaque `external_ref_type`/`external_ref` pair, which the
-- adapter writes through the BookingPort.
--
-- ## Mutability
--
-- Offering link: only `status` active -> unlinked (with `unlinked_at`) and
-- `updated_at` ever change; an unlink never touches past orders or reservation
-- links, so the history of what was sold as what survives.
-- Reservation link: only `status` (active -> superseded | released), the
-- `attention_*` triple and `updated_at` change; every other column is a frozen
-- fact. No DELETE for `awcms_app` on either table; `awcms_worker` keeps
-- SELECT + DELETE for the retention engine only (sql/1040). `deleted_at` exists
-- for that engine's cursor and this module NEVER sets it, so the purge predicate
-- cannot match a live row (the shape the segment tables use, sql/1001).
--
-- ## Attention flag (ADR-0045 G7)
--
-- `attention_reason` is a CLOSED code set by a consumer or a job when the two
-- contexts disagree (a deposit after the hold expired, a confirmation that
-- failed, a reservation moved or cancelled outside the adapter). The enum is the
-- superset the whole adapter epic needs, so a later issue never widens a CHECK.
-- The reason stays after it is resolved (`attention_resolved_at`); the operator
-- queue is "reason set and not resolved".
--
-- Every trigger function pins `search_path` (the #1046 gate).

CREATE TABLE IF NOT EXISTS awcms_commerce_booking_offering_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  offering_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity_basis text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  unlinked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_booking_offering_links_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_offering_links_offering_fk
    FOREIGN KEY (tenant_id, offering_id)
    REFERENCES awcms_booking_service_offerings (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_offering_links_product_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES awcms_commerce_products (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_offering_links_basis_check
    CHECK (quantity_basis IN ('nights', 'booking')),
  CONSTRAINT awcms_commerce_booking_offering_links_status_check
    CHECK (status IN ('active', 'unlinked')),
  CONSTRAINT awcms_commerce_booking_offering_links_unlinked_shape_check
    CHECK ((status = 'unlinked') = (unlinked_at IS NOT NULL))
);

-- ADR-0045 D1: one active product per offering and one active offering per
-- product. Relaxing either later is one index drop.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_booking_offering_links_offering_active_key
  ON awcms_commerce_booking_offering_links (tenant_id, offering_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_booking_offering_links_product_active_key
  ON awcms_commerce_booking_offering_links (tenant_id, product_id)
  WHERE status = 'active';

-- The FK columns' own indexes (db:fk-index) and the admin list.
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_offering_links_offering_idx
  ON awcms_commerce_booking_offering_links (tenant_id, offering_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_offering_links_product_idx
  ON awcms_commerce_booking_offering_links (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_offering_links_list_idx
  ON awcms_commerce_booking_offering_links (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_offering_links_tenant_deleted_idx
  ON awcms_commerce_booking_offering_links (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_booking_offering_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_booking_offering_links FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_booking_offering_links_tenant_isolation
  ON awcms_commerce_booking_offering_links
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_booking_offering_links FROM awcms_app;

-- INSERT: the product must be a service (a CHECK cannot read another table, a
-- trigger can; ADR-0045 D14 `PRODUCT_NOT_SERVICE` is the application's answer,
-- this is the backstop). UPDATE: identity columns are frozen and the only legal
-- transition is active -> unlinked, once. The BEGIN/END below are PL/pgSQL block
-- delimiters in a dollar-quoted body, not transaction control (sql/033's
-- precedent).
CREATE OR REPLACE FUNCTION awcms_commerce_booking_offering_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_booking_offering_links_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION
        'awcms_commerce_booking_offering_links: a link is created active'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM awcms_commerce_products p
      WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.product_id
        AND p.type = 'service'
    ) THEN
      RAISE EXCEPTION
        'awcms_commerce_booking_offering_links: product % is not a service product',
        NEW.product_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.offering_id IS DISTINCT FROM OLD.offering_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.quantity_basis IS DISTINCT FROM OLD.quantity_basis
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_booking_offering_links row % is frozen: identity, offering, product and basis never change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'unlinked' AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.unlinked_at IS DISTINCT FROM OLD.unlinked_at
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_booking_offering_links row % is unlinked and stays unlinked',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_booking_offering_links_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_booking_offering_links_guard
  ON awcms_commerce_booking_offering_links;
CREATE TRIGGER awcms_commerce_booking_offering_links_guard
  BEFORE INSERT OR UPDATE ON awcms_commerce_booking_offering_links
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_booking_offering_links_guard();

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_booking_reservation_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  offering_link_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  supersedes_link_id uuid,
  client_key text NOT NULL,
  -- Keyed hash of the request that created the link (ADR-0045 G5): a replay of
  -- the same client key with a different request is a conflict, never a second
  -- reservation. NOT a copy of any field of the request.
  request_hash text NOT NULL,
  attention_reason text,
  attention_at timestamptz,
  attention_resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_booking_reservation_links_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reservation_links_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reservation_links_order_item_fk
    FOREIGN KEY (tenant_id, order_item_id)
    REFERENCES awcms_commerce_order_items (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reservation_links_reservation_fk
    FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES awcms_booking_reservations (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reservation_links_offering_link_fk
    FOREIGN KEY (tenant_id, offering_link_id)
    REFERENCES awcms_commerce_booking_offering_links (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reservation_links_supersedes_fk
    FOREIGN KEY (tenant_id, supersedes_link_id)
    REFERENCES awcms_commerce_booking_reservation_links (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reservation_links_status_check
    CHECK (status IN ('active', 'superseded', 'released')),
  CONSTRAINT awcms_commerce_booking_reservation_links_not_self_check
    CHECK (supersedes_link_id IS NULL OR supersedes_link_id <> id),
  CONSTRAINT awcms_commerce_booking_reservation_links_client_key_check
    CHECK (char_length(client_key) BETWEEN 1 AND 300),
  CONSTRAINT awcms_commerce_booking_reservation_links_request_hash_check
    CHECK (char_length(request_hash) BETWEEN 1 AND 128),
  CONSTRAINT awcms_commerce_booking_reservation_links_attention_reason_check
    CHECK (attention_reason IS NULL OR attention_reason IN (
      'deposit_after_expiry', 'confirm_failed',
      'rescheduled_externally', 'cancelled_externally_paid'
    )),
  CONSTRAINT awcms_commerce_booking_reservation_links_attention_shape_check
    CHECK ((attention_reason IS NULL) = (attention_at IS NULL)),
  CONSTRAINT awcms_commerce_booking_reservation_links_attention_resolved_check
    CHECK (attention_resolved_at IS NULL
      OR (attention_reason IS NOT NULL AND attention_resolved_at >= attention_at))
);

-- A retry of the same hold-plus-order call returns the same link (ADR-0045 G5).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_booking_reservation_links_client_key_key
  ON awcms_commerce_booking_reservation_links (tenant_id, client_key);

-- A reservation has at most one ACTIVE link ("the old reservation is never left
-- linked", A6), and an order line at most one active link.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_booking_reservation_links_reservation_active_key
  ON awcms_commerce_booking_reservation_links (tenant_id, reservation_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_booking_reservation_links_order_item_active_key
  ON awcms_commerce_booking_reservation_links (tenant_id, order_item_id)
  WHERE status = 'active';

-- The FK columns' own indexes (db:fk-index).
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reservation_links_order_idx
  ON awcms_commerce_booking_reservation_links (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reservation_links_reservation_idx
  ON awcms_commerce_booking_reservation_links (tenant_id, reservation_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reservation_links_offering_link_idx
  ON awcms_commerce_booking_reservation_links (tenant_id, offering_link_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reservation_links_supersedes_idx
  ON awcms_commerce_booking_reservation_links (tenant_id, supersedes_link_id)
  WHERE supersedes_link_id IS NOT NULL;
-- order_item_id is also covered by the partial unique above; the FK check on a
-- delete of an order item needs a plain one.
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reservation_links_order_item_idx
  ON awcms_commerce_booking_reservation_links (tenant_id, order_item_id);

-- The operator queue: attention raised and not yet resolved.
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reservation_links_attention_idx
  ON awcms_commerce_booking_reservation_links (tenant_id, attention_reason, attention_at)
  WHERE attention_reason IS NOT NULL AND attention_resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reservation_links_tenant_deleted_idx
  ON awcms_commerce_booking_reservation_links (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_booking_reservation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_booking_reservation_links FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_booking_reservation_links_tenant_isolation
  ON awcms_commerce_booking_reservation_links
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_booking_reservation_links FROM awcms_app;

-- INSERT: the order line belongs to the order (a composite FK cannot say so:
-- `awcms_commerce_order_items` is unique on (tenant_id, id) only). UPDATE: every
-- column but status, the attention triple and updated_at is frozen; a superseded
-- or released link stays so; the attention flag can be raised when none is open
-- and resolved once.
CREATE OR REPLACE FUNCTION awcms_commerce_booking_reservation_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_booking_reservation_links_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION
        'awcms_commerce_booking_reservation_links: a link is created active'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM awcms_commerce_order_items i
      WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.order_item_id
        AND i.order_id = NEW.order_id
    ) THEN
      RAISE EXCEPTION
        'awcms_commerce_booking_reservation_links: order item % does not belong to order %',
        NEW.order_item_id, NEW.order_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
    OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.offering_link_id IS DISTINCT FROM OLD.offering_link_id
    OR NEW.supersedes_link_id IS DISTINCT FROM OLD.supersedes_link_id
    OR NEW.client_key IS DISTINCT FROM OLD.client_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_booking_reservation_links row % is frozen: only status and the attention flag change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'active' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'awcms_commerce_booking_reservation_links row % is % and stays so',
      OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A new attention flag may be raised only when none is open (never set, or
  -- resolved; the CHECKs then force `attention_resolved_at` back to NULL or a
  -- later time); an open flag keeps its reason and time and can only be resolved.
  IF OLD.attention_reason IS NOT NULL AND OLD.attention_resolved_at IS NULL THEN
    IF NEW.attention_reason IS DISTINCT FROM OLD.attention_reason
      OR NEW.attention_at IS DISTINCT FROM OLD.attention_at
    THEN
      RAISE EXCEPTION
        'awcms_commerce_booking_reservation_links row %: an open attention flag is only resolved, never replaced',
        OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$awcms_commerce_booking_reservation_links_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_booking_reservation_links_guard
  ON awcms_commerce_booking_reservation_links;
CREATE TRIGGER awcms_commerce_booking_reservation_links_guard
  BEFORE INSERT OR UPDATE ON awcms_commerce_booking_reservation_links
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_booking_reservation_links_guard();

COMMENT ON TABLE awcms_commerce_booking_offering_links IS
  'Issue #378 (ADR-0045 D1) - which Booking offering is sold as which service product. One active link per offering and per product. Identifiers and a status only; no price, no customer.';
COMMENT ON TABLE awcms_commerce_booking_reservation_links IS
  'Issue #378 (ADR-0045 D3) - which Booking reservation was sold on which order line. Identifiers, a lifecycle flag and an attention flag; the customer is derived through order_id and stored nowhere here.';
