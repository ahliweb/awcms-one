-- Issue #286 (epic #281, #280; ADR-0029) — the commerce document lifecycle:
-- held sales, versioned quotations, work orders, immutable numbered
-- receipt/invoice documents, and the per-tenant numbering sequences they share.
-- This issue owns 980-984 in the reserved commerce 9xx range (ADR-0015): 980
-- this schema, 981 permissions, 982 worker grants; 983-984 are held and unused.
--
-- Same conventions as `sql/940`/`sql/970` (not repeated in full):
-- `ENABLE` + `FORCE ROW LEVEL SECURITY`, one tenant-isolation policy with a
-- `WITH CHECK`, `id uuid` PK `DEFAULT gen_random_uuid()`, `numeric(14,2)`
-- money (ADR-0003), an index for every FK column, `text` + `CHECK` for every
-- enumerated column (never a native ENUM), composite `(tenant_id, …)` foreign
-- keys backed by `UNIQUE (tenant_id, id)` so a row of tenant A can never point
-- at a row of tenant B even through a service credential that bypasses RLS.
--
-- ## What each table is — and what none of them is
--
-- None of these tables is a second sales ledger. An ORDER (and its payment
-- allocations, ADR-0025) stays the only monetary authority for a sale. A held
-- sale is a parked CART (no stock reserved, no money); a quotation is an OFFER
-- (versioned, never a sale until converted — and a conversion goes through the
-- ordinary POS order path, `createPosOrder`, so there is exactly one place an
-- order is written); a work order is an OPERATIONAL record (status, assignee,
-- due date), not a financial one; a document is an immutable, numbered
-- SNAPSHOT of an already-finalized order, whose totals are verified equal to
-- the order's at insert time. It is deliberately NOT an accounts-receivable
-- invoice (ADR-0029 D1): no ageing, no due-date tracking, no payment state of
-- its own.
--
--   awcms_commerce_document_sequences  one counter per (tenant, doc_type, year)
--   awcms_commerce_held_sales          parked POS carts (owner, expiry, resume)
--   awcms_commerce_quotations          the quote header (status machine)
--   awcms_commerce_quotation_versions  append-only priced version snapshots
--   awcms_commerce_work_orders         operational work/service orders
--   awcms_commerce_work_order_events   append-only work-order status history
--   awcms_commerce_documents           immutable receipt / invoice snapshots
--
-- ## Numbering is gapless, and why that is true
--
-- A number is allocated by ONE statement (`INSERT … ON CONFLICT DO UPDATE …
-- RETURNING`, `application/document-numbering.ts`) inside the same transaction
-- that inserts the row carrying it. The upsert takes a row lock on the
-- sequence row that is held until commit, so concurrent allocations queue; and
-- because the counter bump and the document insert commit or roll back
-- TOGETHER, a failed insert gives its number back. The result is gapless per
-- (tenant, doc_type, year) as long as allocation is the LAST fallible step
-- before the insert (the application guarantees that). The trigger below makes
-- the counter strictly +1 so no writer can skip or reuse a value, and
-- `awcms_app` cannot DELETE or reset a sequence row (only the retention worker
-- may, and only for a year that is over - `sql/982`).
--
-- ## Retention shape
--
-- The two mutable parents (quotations, work orders) and the quotation versions
-- (referenced by work orders' provenance FK) carry a `deleted_at` that exists
-- ONLY as the retention engine's cursor and is never set (`commerce.orders`'
-- and `sql/970`'s shape): practically unreachable, which keeps every foreign
-- key safe from a purge that would orphan it. Held sales, work-order events
-- and documents key on their own timestamps.
--
-- ## Immutability
--
-- A quotation version, a work-order event and a document can never be updated
-- (a trigger refuses it and `awcms_app` loses UPDATE and DELETE): a revision
-- is a NEW version, a correction is a NEW document. The mutable headers
-- (quotation, work order, held sale) are guarded by triggers that freeze their
-- identity/provenance columns and allow only the legal status moves.

-- A composite-FK anchor for customers (orders already has one, `sql/940`).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_customers_tenant_id_id_key
  ON awcms_commerce_customers (tenant_id, id);

CREATE TABLE IF NOT EXISTS awcms_commerce_document_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  doc_type text NOT NULL,
  period text NOT NULL,
  last_number integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_document_sequences_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_document_sequences_scope_key
    UNIQUE (tenant_id, doc_type, period),
  CONSTRAINT awcms_commerce_document_sequences_type_check
    CHECK (doc_type IN ('quotation', 'work_order', 'receipt', 'invoice')),
  CONSTRAINT awcms_commerce_document_sequences_period_check
    CHECK (period ~ '^[0-9]{4}$'),
  CONSTRAINT awcms_commerce_document_sequences_number_check
    CHECK (last_number >= 0)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_document_sequences_tenant_idx
  ON awcms_commerce_document_sequences (tenant_id);

-- The (tenant, cursor) composite the generic purge engine requires. Retention
-- of a counter is safe by construction: allocation only ever touches the row of
-- the CURRENT UTC year, so a counter not bumped for more than a year (the
-- descriptor's floor is 366 days) belongs to a year that is over and can never
-- be allocated from again - removing it cannot restart a number.
CREATE INDEX IF NOT EXISTS awcms_commerce_document_sequences_tenant_updated_idx
  ON awcms_commerce_document_sequences (tenant_id, updated_at);

ALTER TABLE awcms_commerce_document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_document_sequences FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_document_sequences_tenant_isolation
  ON awcms_commerce_document_sequences
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- The counter moves forward by exactly one, per update, and nothing else about
-- the row ever changes.
CREATE OR REPLACE FUNCTION awcms_commerce_document_sequences_guard()
RETURNS trigger AS $awcms_commerce_document_sequences_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
    OR NEW.period IS DISTINCT FROM OLD.period
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_document_sequences row % identity is frozen', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.last_number IS DISTINCT FROM OLD.last_number + 1 THEN
    RAISE EXCEPTION
      'awcms_commerce_document_sequences row %: the counter only moves forward by exactly one (% -> %)',
      OLD.id, OLD.last_number, NEW.last_number
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_document_sequences_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_document_sequences_guard
  ON awcms_commerce_document_sequences;
CREATE TRIGGER awcms_commerce_document_sequences_guard
  BEFORE UPDATE ON awcms_commerce_document_sequences
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_document_sequences_guard();

REVOKE DELETE ON awcms_commerce_document_sequences FROM awcms_app;

-- Shared append-only guard (one function, reused by the three tables below).
CREATE OR REPLACE FUNCTION awcms_commerce_documents_append_only()
RETURNS trigger AS $awcms_commerce_documents_append_only$
BEGIN
  RAISE EXCEPTION
    '% row % is append-only (a revision or correction is a new row)',
    TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$awcms_commerce_documents_append_only$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Held sales
-- ---------------------------------------------------------------------------
-- A parked POS cart. `cart` is `{ lines: [{ productId, variantId, quantity }],
-- customer: { name, phone } | null, notes }` and nothing else: NO prices (a
-- resumed cart is re-priced by the ordinary quote), NO stock reservation. When
-- the sale leaves `held` the cart is wiped to `{}` (a CHECK pins it) - the
-- customer phone in it is personal data with no reason to outlive the park.
CREATE TABLE IF NOT EXISTS awcms_commerce_held_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  owner_tenant_user_id uuid NOT NULL,
  register_id uuid,
  label text,
  cart jsonb NOT NULL,
  line_count integer NOT NULL,
  status text NOT NULL DEFAULT 'held',
  held_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_held_sales_register_fk
    FOREIGN KEY (tenant_id, register_id)
    REFERENCES awcms_commerce_registers (tenant_id, id),
  CONSTRAINT awcms_commerce_held_sales_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_held_sales_status_check
    CHECK (status IN ('held', 'resumed', 'discarded', 'expired')),
  CONSTRAINT awcms_commerce_held_sales_label_check
    CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 120),
  CONSTRAINT awcms_commerce_held_sales_line_count_check
    CHECK (line_count BETWEEN 1 AND 100),
  CONSTRAINT awcms_commerce_held_sales_expiry_check
    CHECK (expires_at > held_at),
  CONSTRAINT awcms_commerce_held_sales_closed_check
    CHECK ((status = 'held') = (closed_at IS NULL)),
  CONSTRAINT awcms_commerce_held_sales_cart_check
    CHECK (
      (status = 'held' AND jsonb_typeof(cart) = 'object' AND cart <> '{}'::jsonb)
      OR (status <> 'held' AND cart = '{}'::jsonb)
    )
);

CREATE INDEX IF NOT EXISTS awcms_commerce_held_sales_tenant_idx
  ON awcms_commerce_held_sales (tenant_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_held_sales_register_idx
  ON awcms_commerce_held_sales (register_id);
-- "My parked sales" and the supervisor list.
CREATE INDEX IF NOT EXISTS awcms_commerce_held_sales_tenant_owner_status_idx
  ON awcms_commerce_held_sales (tenant_id, owner_tenant_user_id, status, held_at DESC);
CREATE INDEX IF NOT EXISTS awcms_commerce_held_sales_tenant_status_idx
  ON awcms_commerce_held_sales (tenant_id, status, expires_at);
-- The (tenant, cursor) composite the generic purge engine requires.
CREATE INDEX IF NOT EXISTS awcms_commerce_held_sales_tenant_held_idx
  ON awcms_commerce_held_sales (tenant_id, held_at);

ALTER TABLE awcms_commerce_held_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_held_sales FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_held_sales_tenant_isolation
  ON awcms_commerce_held_sales
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE FUNCTION awcms_commerce_held_sales_guard()
RETURNS trigger AS $awcms_commerce_held_sales_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.owner_tenant_user_id IS DISTINCT FROM OLD.owner_tenant_user_id
    OR NEW.register_id IS DISTINCT FROM OLD.register_id
    OR NEW.held_at IS DISTINCT FROM OLD.held_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.line_count IS DISTINCT FROM OLD.line_count
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_held_sales row % is frozen: owner, register, expiry and size never change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'held' THEN
    RAISE EXCEPTION 'awcms_commerce_held_sales row % is closed (%)', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status NOT IN ('held', 'resumed', 'discarded', 'expired') THEN
    RAISE EXCEPTION 'awcms_commerce_held_sales row %: illegal status %', OLD.id, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_held_sales_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_held_sales_guard ON awcms_commerce_held_sales;
CREATE TRIGGER awcms_commerce_held_sales_guard
  BEFORE UPDATE ON awcms_commerce_held_sales
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_held_sales_guard();

REVOKE DELETE ON awcms_commerce_held_sales FROM awcms_app;

-- ---------------------------------------------------------------------------
-- Quotations
-- ---------------------------------------------------------------------------
-- Header: status machine + provenance. The priced content lives in the
-- append-only versions below. `accepted_version` pins WHICH version the
-- customer agreed to; `converted_order_id` is the conversion's provenance
-- (quote -> order) and, being set at most once, the idempotency anchor of the
-- conversion.
CREATE TABLE IF NOT EXISTS awcms_commerce_quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  number text NOT NULL,
  customer_id uuid,
  status text NOT NULL DEFAULT 'draft',
  current_version integer NOT NULL DEFAULT 1,
  accepted_version integer,
  accepted_at timestamptz,
  accepted_by_tenant_user_id uuid,
  decision_note text,
  converted_order_id uuid,
  created_by_tenant_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_quotations_customer_fk
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES awcms_commerce_customers (tenant_id, id),
  CONSTRAINT awcms_commerce_quotations_order_fk
    FOREIGN KEY (tenant_id, converted_order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_quotations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_quotations_number_key UNIQUE (tenant_id, number),
  CONSTRAINT awcms_commerce_quotations_status_check
    CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted', 'cancelled')),
  CONSTRAINT awcms_commerce_quotations_version_check
    CHECK (current_version >= 1),
  -- An accepted or converted quotation always names its accepted version; one
  -- that was accepted and then cancelled keeps that record (history); one that
  -- was never accepted has none.
  CONSTRAINT awcms_commerce_quotations_accept_check
    CHECK (
      (status NOT IN ('accepted', 'converted') OR accepted_version IS NOT NULL)
      AND (status NOT IN ('draft', 'sent', 'rejected', 'expired') OR accepted_version IS NULL)
      AND (accepted_version IS NULL) = (accepted_at IS NULL)
      AND (accepted_version IS NULL OR accepted_version <= current_version)
    ),
  CONSTRAINT awcms_commerce_quotations_converted_check
    CHECK ((status = 'converted') = (converted_order_id IS NOT NULL)),
  CONSTRAINT awcms_commerce_quotations_note_check
    CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500)
);

-- One order per quotation, ever: the mechanical backstop of the idempotent
-- conversion (and the reverse lookup "which quote produced this order").
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_quotations_order_key
  ON awcms_commerce_quotations (tenant_id, converted_order_id)
  WHERE converted_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_quotations_tenant_idx
  ON awcms_commerce_quotations (tenant_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_quotations_customer_idx
  ON awcms_commerce_quotations (customer_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_quotations_order_idx
  ON awcms_commerce_quotations (converted_order_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_quotations_tenant_status_idx
  ON awcms_commerce_quotations (tenant_id, status, created_at DESC);
-- The (tenant, cursor) composite the generic purge engine requires.
CREATE INDEX IF NOT EXISTS awcms_commerce_quotations_tenant_deleted_idx
  ON awcms_commerce_quotations (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_quotations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_quotations_tenant_isolation
  ON awcms_commerce_quotations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Legal moves: draft -> sent | cancelled; sent -> accepted | rejected |
-- expired | cancelled; accepted -> converted | cancelled; a REVISION (the
-- version counter +1, status back to draft) is allowed from draft, sent and
-- expired; rejected, converted and cancelled are terminal.
CREATE OR REPLACE FUNCTION awcms_commerce_quotations_guard()
RETURNS trigger AS $awcms_commerce_quotations_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.created_by_tenant_user_id IS DISTINCT FROM OLD.created_by_tenant_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_quotations row % is frozen: number, customer and creator never change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.current_version IS DISTINCT FROM OLD.current_version THEN
    IF NEW.current_version <> OLD.current_version + 1
      OR OLD.status NOT IN ('draft', 'sent', 'expired')
      OR NEW.status <> 'draft'
    THEN
      RAISE EXCEPTION
        'awcms_commerce_quotations row %: a revision adds exactly one version to a draft/sent/expired quotation and returns it to draft', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.accepted_version IS NOT NULL
    AND (NEW.accepted_version IS DISTINCT FROM OLD.accepted_version
      OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
      OR NEW.accepted_by_tenant_user_id IS DISTINCT FROM OLD.accepted_by_tenant_user_id)
  THEN
    RAISE EXCEPTION
      'awcms_commerce_quotations row %: the accepted version is pinned', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.converted_order_id IS NOT NULL
    AND NEW.converted_order_id IS DISTINCT FROM OLD.converted_order_id
  THEN
    RAISE EXCEPTION
      'awcms_commerce_quotations row %: the conversion provenance is set once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('sent', 'cancelled'))
    OR (OLD.status = 'sent' AND NEW.status IN ('accepted', 'rejected', 'expired', 'cancelled'))
    OR (OLD.status = 'accepted' AND NEW.status IN ('converted', 'cancelled'))
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_quotations row %: illegal status transition % -> %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_quotations_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_quotations_guard ON awcms_commerce_quotations;
CREATE TRIGGER awcms_commerce_quotations_guard
  BEFORE UPDATE ON awcms_commerce_quotations
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_quotations_guard();

REVOKE DELETE ON awcms_commerce_quotations FROM awcms_app;

CREATE TABLE IF NOT EXISTS awcms_commerce_quotation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  quotation_id uuid NOT NULL,
  version integer NOT NULL,
  valid_until timestamptz NOT NULL,
  currency text NOT NULL DEFAULT 'IDR',
  lines jsonb NOT NULL,
  subtotal numeric(14, 2) NOT NULL,
  discount numeric(14, 2) NOT NULL DEFAULT 0,
  tax numeric(14, 2) NOT NULL DEFAULT 0,
  total numeric(14, 2) NOT NULL,
  customer jsonb,
  pricing_context jsonb NOT NULL,
  notes text,
  content_hash text NOT NULL,
  created_by_tenant_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_quotation_versions_quotation_fk
    FOREIGN KEY (tenant_id, quotation_id)
    REFERENCES awcms_commerce_quotations (tenant_id, id),
  CONSTRAINT awcms_commerce_quotation_versions_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_quotation_versions_version_key
    UNIQUE (tenant_id, quotation_id, version),
  CONSTRAINT awcms_commerce_quotation_versions_version_check
    CHECK (version >= 1),
  CONSTRAINT awcms_commerce_quotation_versions_validity_check
    CHECK (valid_until > created_at),
  CONSTRAINT awcms_commerce_quotation_versions_lines_check
    CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 100),
  CONSTRAINT awcms_commerce_quotation_versions_money_check
    CHECK (subtotal >= 0 AND discount >= 0 AND tax >= 0 AND total >= 0),
  CONSTRAINT awcms_commerce_quotation_versions_currency_check
    CHECK (currency = 'IDR'),
  CONSTRAINT awcms_commerce_quotation_versions_hash_check
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT awcms_commerce_quotation_versions_notes_check
    CHECK (notes IS NULL OR char_length(notes) BETWEEN 1 AND 1000)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_quotation_versions_tenant_idx
  ON awcms_commerce_quotation_versions (tenant_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_quotation_versions_quotation_idx
  ON awcms_commerce_quotation_versions (quotation_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_quotation_versions_tenant_deleted_idx
  ON awcms_commerce_quotation_versions (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_quotation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_quotation_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_quotation_versions_tenant_isolation
  ON awcms_commerce_quotation_versions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP TRIGGER IF EXISTS awcms_commerce_quotation_versions_append_only
  ON awcms_commerce_quotation_versions;
CREATE TRIGGER awcms_commerce_quotation_versions_append_only
  BEFORE UPDATE ON awcms_commerce_quotation_versions
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_documents_append_only();

REVOKE UPDATE, DELETE ON awcms_commerce_quotation_versions FROM awcms_app;

-- ---------------------------------------------------------------------------
-- Work orders
-- ---------------------------------------------------------------------------
-- Operational only: no money column at all. `quotation_id` + `quotation_version`
-- is the provenance of a work order created from an accepted quotation (a
-- composite FK to the VERSION row, so the pair is real); `order_id` is the
-- commerce order it fulfils, attached at creation or later, once. A booking
-- reference is a documented hook, not a column pointing at a table that does
-- not exist (ADR-0029 D6).
CREATE TABLE IF NOT EXISTS awcms_commerce_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  number text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'received',
  priority text NOT NULL DEFAULT 'normal',
  customer_id uuid,
  quotation_id uuid,
  quotation_version integer,
  order_id uuid,
  assignee_tenant_user_id uuid,
  due_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_by_tenant_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_work_orders_customer_fk
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES awcms_commerce_customers (tenant_id, id),
  CONSTRAINT awcms_commerce_work_orders_quotation_version_fk
    FOREIGN KEY (tenant_id, quotation_id, quotation_version)
    REFERENCES awcms_commerce_quotation_versions (tenant_id, quotation_id, version),
  CONSTRAINT awcms_commerce_work_orders_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_work_orders_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_work_orders_number_key UNIQUE (tenant_id, number),
  CONSTRAINT awcms_commerce_work_orders_status_check
    CHECK (status IN ('received', 'scheduled', 'in_progress', 'on_hold', 'ready', 'completed', 'cancelled')),
  CONSTRAINT awcms_commerce_work_orders_priority_check
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT awcms_commerce_work_orders_title_check
    CHECK (char_length(title) BETWEEN 1 AND 160),
  CONSTRAINT awcms_commerce_work_orders_description_check
    CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 2000),
  CONSTRAINT awcms_commerce_work_orders_provenance_check
    CHECK ((quotation_id IS NULL) = (quotation_version IS NULL)),
  CONSTRAINT awcms_commerce_work_orders_closed_check
    CHECK (
      (status = 'completed') = (completed_at IS NOT NULL)
      AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS awcms_commerce_work_orders_tenant_idx
  ON awcms_commerce_work_orders (tenant_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_work_orders_customer_idx
  ON awcms_commerce_work_orders (customer_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_work_orders_quotation_idx
  ON awcms_commerce_work_orders (quotation_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_work_orders_order_idx
  ON awcms_commerce_work_orders (order_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_work_orders_tenant_status_idx
  ON awcms_commerce_work_orders (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS awcms_commerce_work_orders_tenant_assignee_idx
  ON awcms_commerce_work_orders (tenant_id, assignee_tenant_user_id, status);
CREATE INDEX IF NOT EXISTS awcms_commerce_work_orders_tenant_deleted_idx
  ON awcms_commerce_work_orders (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_work_orders FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_work_orders_tenant_isolation
  ON awcms_commerce_work_orders
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Legal moves: received -> scheduled | in_progress | cancelled; scheduled ->
-- in_progress | on_hold | cancelled; in_progress -> on_hold | ready |
-- cancelled; on_hold -> in_progress | cancelled; ready -> completed |
-- in_progress; completed and cancelled are terminal. Provenance and number are
-- frozen; `order_id` may be attached once (NULL -> value).
CREATE OR REPLACE FUNCTION awcms_commerce_work_orders_guard()
RETURNS trigger AS $awcms_commerce_work_orders_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.number IS DISTINCT FROM OLD.number
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.quotation_id IS DISTINCT FROM OLD.quotation_id
    OR NEW.quotation_version IS DISTINCT FROM OLD.quotation_version
    OR NEW.created_by_tenant_user_id IS DISTINCT FROM OLD.created_by_tenant_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_work_orders row % is frozen: number, customer, provenance and creator never change', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'awcms_commerce_work_orders row %: the order link is set once', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'awcms_commerce_work_orders row % is % and immutable', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'received' AND NEW.status IN ('scheduled', 'in_progress', 'cancelled'))
    OR (OLD.status = 'scheduled' AND NEW.status IN ('in_progress', 'on_hold', 'cancelled'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('on_hold', 'ready', 'cancelled'))
    OR (OLD.status = 'on_hold' AND NEW.status IN ('in_progress', 'cancelled'))
    OR (OLD.status = 'ready' AND NEW.status IN ('completed', 'in_progress'))
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_work_orders row %: illegal status transition % -> %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_work_orders_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_work_orders_guard ON awcms_commerce_work_orders;
CREATE TRIGGER awcms_commerce_work_orders_guard
  BEFORE UPDATE ON awcms_commerce_work_orders
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_work_orders_guard();

REVOKE DELETE ON awcms_commerce_work_orders FROM awcms_app;

-- `seq` is the history's ORDER: two moves recorded with the same instant (a
-- clock tick is a millisecond; a retry can land in the same one) must still
-- read back in the order they happened, and a random uuid cannot say that.
CREATE TABLE IF NOT EXISTS awcms_commerce_work_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  work_order_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text,
  actor_tenant_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_work_order_events_work_order_fk
    FOREIGN KEY (tenant_id, work_order_id)
    REFERENCES awcms_commerce_work_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_work_order_events_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_work_order_events_status_check
    CHECK (
      to_status IN ('received', 'scheduled', 'in_progress', 'on_hold', 'ready', 'completed', 'cancelled')
      AND (from_status IS NULL OR from_status IN ('received', 'scheduled', 'in_progress', 'on_hold', 'ready', 'completed', 'cancelled'))
    ),
  CONSTRAINT awcms_commerce_work_order_events_note_check
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_work_order_events_tenant_idx
  ON awcms_commerce_work_order_events (tenant_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_work_order_events_work_order_idx
  ON awcms_commerce_work_order_events (work_order_id, seq);
CREATE INDEX IF NOT EXISTS awcms_commerce_work_order_events_tenant_created_idx
  ON awcms_commerce_work_order_events (tenant_id, created_at);

ALTER TABLE awcms_commerce_work_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_work_order_events FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_work_order_events_tenant_isolation
  ON awcms_commerce_work_order_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP TRIGGER IF EXISTS awcms_commerce_work_order_events_append_only
  ON awcms_commerce_work_order_events;
CREATE TRIGGER awcms_commerce_work_order_events_append_only
  BEFORE UPDATE ON awcms_commerce_work_order_events
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_documents_append_only();

REVOKE UPDATE, DELETE ON awcms_commerce_work_order_events FROM awcms_app;

-- ---------------------------------------------------------------------------
-- Documents (commercial receipt / invoice)
-- ---------------------------------------------------------------------------
-- An immutable, numbered snapshot of ONE finalized order. `source_type` /
-- `source_id` / `source_version` is the provenance triple: today only an order
-- (`source_version` is 1 - an order's lines and totals are written once and
-- never revised, so the order IS its own single version); the vocabulary is a
-- CHECK so a future source (a final quotation version, a settled work order)
-- widens it in its own migration. One receipt and one invoice per order
-- (`documents_source_key`): issuing is idempotent by construction, and the
-- order row is locked while issuing so the loser of a race never consumes a
-- number. `snapshot` is the render input - seller, customer, lines, totals and
-- the payments as they stood at issue time; `content_hash` is its SHA-256, so
-- any later tampering is detectable. The money columns are a frozen COPY of
-- the order's (a trigger verifies equality at insert): the order stays the
-- authority and the document never carries a payment state of its own.
CREATE TABLE IF NOT EXISTS awcms_commerce_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  doc_type text NOT NULL,
  number text NOT NULL,
  source_type text NOT NULL DEFAULT 'order',
  source_id uuid NOT NULL,
  source_version integer NOT NULL DEFAULT 1,
  currency text NOT NULL DEFAULT 'IDR',
  subtotal numeric(14, 2) NOT NULL,
  discount numeric(14, 2) NOT NULL,
  shipping_cost numeric(14, 2) NOT NULL,
  insurance_fee numeric(14, 2) NOT NULL,
  tax numeric(14, 2) NOT NULL,
  total numeric(14, 2) NOT NULL,
  snapshot jsonb NOT NULL,
  content_hash text NOT NULL,
  issued_by_tenant_user_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_documents_order_fk
    FOREIGN KEY (tenant_id, source_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_documents_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_documents_number_key UNIQUE (tenant_id, number),
  CONSTRAINT awcms_commerce_documents_source_key
    UNIQUE (tenant_id, doc_type, source_type, source_id),
  CONSTRAINT awcms_commerce_documents_type_check
    CHECK (doc_type IN ('receipt', 'invoice')),
  CONSTRAINT awcms_commerce_documents_source_type_check
    CHECK (source_type IN ('order')),
  CONSTRAINT awcms_commerce_documents_source_version_check
    CHECK (source_version >= 1),
  CONSTRAINT awcms_commerce_documents_currency_check
    CHECK (currency = 'IDR'),
  CONSTRAINT awcms_commerce_documents_money_check
    CHECK (subtotal >= 0 AND discount >= 0 AND shipping_cost >= 0
      AND insurance_fee >= 0 AND tax >= 0 AND total >= 0),
  CONSTRAINT awcms_commerce_documents_snapshot_check
    CHECK (jsonb_typeof(snapshot) = 'object'),
  CONSTRAINT awcms_commerce_documents_hash_check
    CHECK (content_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS awcms_commerce_documents_tenant_idx
  ON awcms_commerce_documents (tenant_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_documents_source_idx
  ON awcms_commerce_documents (source_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_documents_tenant_type_issued_idx
  ON awcms_commerce_documents (tenant_id, doc_type, issued_at DESC);
CREATE INDEX IF NOT EXISTS awcms_commerce_documents_tenant_created_idx
  ON awcms_commerce_documents (tenant_id, created_at);

ALTER TABLE awcms_commerce_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_documents_tenant_isolation
  ON awcms_commerce_documents
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- The money columns must equal the source order's, and a document cannot be
-- issued for an order that never took effect (cancelled / expired). A receipt
-- additionally needs an order whose cached payment status is `paid`.
CREATE OR REPLACE FUNCTION awcms_commerce_documents_match_source()
RETURNS trigger AS $awcms_commerce_documents_match_source$
DECLARE
  src record;
BEGIN
  SELECT subtotal, discount, voucher_discount, shipping_cost, insurance_fee, tax, total,
         status, payment_status
  INTO src
  FROM awcms_commerce_orders
  WHERE tenant_id = NEW.tenant_id AND id = NEW.source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document source order % does not exist', NEW.source_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF src.subtotal IS DISTINCT FROM NEW.subtotal
    OR (src.discount + src.voucher_discount) IS DISTINCT FROM NEW.discount
    OR src.shipping_cost IS DISTINCT FROM NEW.shipping_cost
    OR src.insurance_fee IS DISTINCT FROM NEW.insurance_fee
    OR src.tax IS DISTINCT FROM NEW.tax
    OR src.total IS DISTINCT FROM NEW.total
  THEN
    RAISE EXCEPTION
      'document % money does not match its source order %: a document is a copy of the order, never a second authority',
      NEW.number, NEW.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF src.status IN ('cancelled', 'expired') THEN
    RAISE EXCEPTION 'order % is % and cannot be documented', NEW.source_id, src.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.doc_type = 'receipt' AND src.payment_status <> 'paid' THEN
    RAISE EXCEPTION 'a receipt needs a fully paid order (order % is %)', NEW.source_id, src.payment_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_documents_match_source$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_documents_match_source ON awcms_commerce_documents;
CREATE TRIGGER awcms_commerce_documents_match_source
  BEFORE INSERT ON awcms_commerce_documents
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_documents_match_source();

DROP TRIGGER IF EXISTS awcms_commerce_documents_append_only ON awcms_commerce_documents;
CREATE TRIGGER awcms_commerce_documents_append_only
  BEFORE UPDATE ON awcms_commerce_documents
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_documents_append_only();

REVOKE UPDATE, DELETE ON awcms_commerce_documents FROM awcms_app;

COMMENT ON TABLE awcms_commerce_document_sequences IS
  'Issue #286 (ADR-0029) — per (tenant, doc_type, year) counter for gapless human-readable document numbers; strictly +1 per update, allocated in the same transaction as the numbered row.';
COMMENT ON TABLE awcms_commerce_held_sales IS
  'Issue #286 (ADR-0029) — a parked POS cart (no prices, no stock reservation) with an owner and an expiry; the cart is wiped when the sale leaves held.';
COMMENT ON TABLE awcms_commerce_quotations IS
  'Issue #286 (ADR-0029) — quotation header: status machine, pinned accepted version, conversion provenance (converted_order_id, set once).';
COMMENT ON TABLE awcms_commerce_quotation_versions IS
  'Issue #286 (ADR-0029) — append-only priced version snapshots of a quotation (lines, totals, validity, pricing context, content hash).';
COMMENT ON TABLE awcms_commerce_work_orders IS
  'Issue #286 (ADR-0029) — operational work/service order: status machine, assignee, due date, optional quotation-version and order provenance. Holds no money.';
COMMENT ON TABLE awcms_commerce_work_order_events IS
  'Issue #286 (ADR-0029) — append-only work-order status history.';
COMMENT ON TABLE awcms_commerce_documents IS
  'Issue #286 (ADR-0029) — immutable numbered receipt/invoice snapshot of one finalized order; a frozen copy of the order''s money, verified at insert. Not an accounts-receivable invoice.';
