-- Issue #295 (epic #281, ADR-0034) — transactional delivery of commercial
-- documents (receipt, invoice, quotation version, work-order notice) through
-- the EXISTING e-mail and commerce WhatsApp outboxes. This issue owns
-- 965-969 in the reserved commerce 9xx range (ADR-0015): 965 this schema,
-- 966 permissions, 967 worker grants; 968-969 are held and unused.
--
-- ## What this table is — and what it is not
--
-- It is NOT a notification queue. The queue is `awcms_email_messages` (the
-- `email` module's outbox) and `awcms_commerce_whatsapp_messages` (increment
-- 5's), each with its own dispatcher, retry/backoff, lease and provider-call-
-- outside-a-transaction discipline. A delivery row is the REQUEST that put one
-- message into one of those two outboxes: who asked, for which immutable
-- source, on which channel, to which MASKED recipient, rendered from which
-- template version, with which content hash. The outbox row carries the same
-- `correlation_id` (this row's id as text), so the live status / provider
-- message id / retry count / last error are READ from the outbox on demand and
-- never copied here — a copy would drift the moment the dispatcher moved on.
--
-- ## Append-only, and why that is enough
--
-- A delivery row is written once, in the same transaction that enqueued the
-- outbox row, and never updated. A re-send is a NEW row (`resend_of_id` names
-- the one it repeats) — the explicit new request ADR-0034 D4 requires, so a
-- replayed `Idempotency-Key` can never double-send but a staff member can
-- always send again on purpose. `status` is the HAND-OFF outcome only:
-- `queued` (the outbox accepted it) or `not_enqueued` (it did not, with a
-- `failure_reason` — a suppressed address, a missing template). What happened
-- after the hand-off lives in the outbox.
--
-- ## Privacy
--
-- The recipient is stored MASKED only (`d****@example.com`, `+62812****890`):
-- the full address exists exactly where it must (the outbox row the provider
-- reads) and nowhere else, so this table, its audit events and its logs never
-- hold a usable contact. No message body and no customer name is stored either;
-- `content_hash` is the SHA-256 of the exact variables handed to the outbox, so
-- two sends of the same immutable source are provably identical.
--
-- ## Private artifact link
--
-- A delivery may carry an OPAQUE link token (`dl_…`, opt-in): only its SHA-256
-- is stored (`link_token_hash`, unique), with a hard expiry (`link_expires_at`)
-- of at most 168 hours. Never a document id in a URL, never a permanent public
-- URL for a customer-specific receipt.
--
-- ## Why the three source references are a trigger, not foreign keys
--
-- The sources (`awcms_commerce_documents`, `_quotation_versions`,
-- `_work_orders`) are created by `sql/980`, and this issue's reserved range
-- (965-969, ADR-0015) sorts BEFORE it: on a fresh database this file runs
-- first, and a `FOREIGN KEY` to a table that does not exist yet cannot be
-- created. A plpgsql function body is resolved when it RUNS, not when it is
-- created, so `awcms_commerce_document_deliveries_check_target()` below does
-- the equivalent job at insert time: the named source must exist IN THE SAME
-- TENANT (the composite-FK guarantee, held even for a credential that bypasses
-- RLS) and `doc_number` must be that source's real number. What it cannot do
-- is stop a later delete of the source - which no runtime role can do anyway
-- (`awcms_app` has no DELETE on any of the three; only the retention worker,
-- past a one-to-ten-year floor, and this table's own retention is shorter).
-- ADR-0034 D8 records the trade-off and the one-line follow-up (real FKs in a
-- migration numbered after 980) should the range ever be re-cut.
--
-- Same other conventions as `sql/980`: ENABLE + FORCE ROW LEVEL SECURITY with a
-- WITH CHECK, the self-referencing composite foreign key backed by UNIQUE
-- (tenant_id, id), `text` + CHECK for every enumerated column, an index for
-- every reference column.

CREATE TABLE IF NOT EXISTS awcms_commerce_document_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  target_type text NOT NULL,
  -- Exactly one of the three, matching `target_type` (CHECK below). Three real
  -- columns with three real composite FKs, not one polymorphic uuid.
  document_id uuid,
  quotation_version_id uuid,
  work_order_id uuid,
  -- The human-readable number of the source (RCP-…/INV-…/QUO-…/WO-…): a
  -- business identifier, not personal data, kept so the history reads without a join.
  doc_number text NOT NULL,
  channel text NOT NULL,
  purpose text NOT NULL DEFAULT 'transactional',
  recipient_source text NOT NULL,
  recipient_masked text NOT NULL,
  locale text NOT NULL,
  template_key text NOT NULL,
  template_version integer NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL,
  failure_reason text,
  resend_of_id uuid,
  link_token_hash text,
  link_expires_at timestamptz,
  requested_by_tenant_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_document_deliveries_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_document_deliveries_resend_fk
    FOREIGN KEY (tenant_id, resend_of_id)
    REFERENCES awcms_commerce_document_deliveries (tenant_id, id),
  CONSTRAINT awcms_commerce_document_deliveries_target_type_check
    CHECK (target_type IN ('document', 'quotation_version', 'work_order')),
  CONSTRAINT awcms_commerce_document_deliveries_target_check
    CHECK (
      (target_type = 'document'
        AND document_id IS NOT NULL AND quotation_version_id IS NULL AND work_order_id IS NULL)
      OR (target_type = 'quotation_version'
        AND quotation_version_id IS NOT NULL AND document_id IS NULL AND work_order_id IS NULL)
      OR (target_type = 'work_order'
        AND work_order_id IS NOT NULL AND document_id IS NULL AND quotation_version_id IS NULL)
    ),
  CONSTRAINT awcms_commerce_document_deliveries_channel_check
    CHECK (channel IN ('email', 'whatsapp')),
  -- A one-value vocabulary on purpose: this table can never carry a marketing
  -- send (campaigns have their own recipients table and consent predicate).
  CONSTRAINT awcms_commerce_document_deliveries_purpose_check
    CHECK (purpose = 'transactional'),
  CONSTRAINT awcms_commerce_document_deliveries_recipient_source_check
    CHECK (recipient_source IN ('source_customer', 'override')),
  CONSTRAINT awcms_commerce_document_deliveries_recipient_masked_check
    CHECK (char_length(recipient_masked) BETWEEN 1 AND 120),
  CONSTRAINT awcms_commerce_document_deliveries_locale_check
    CHECK (locale IN ('id', 'en')),
  CONSTRAINT awcms_commerce_document_deliveries_template_key_check
    CHECK (template_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT awcms_commerce_document_deliveries_template_version_check
    CHECK (template_version >= 1),
  CONSTRAINT awcms_commerce_document_deliveries_hash_check
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT awcms_commerce_document_deliveries_status_check
    CHECK (status IN ('queued', 'not_enqueued')),
  CONSTRAINT awcms_commerce_document_deliveries_failure_check
    CHECK (
      (status = 'queued' AND failure_reason IS NULL)
      OR (status = 'not_enqueued'
        AND failure_reason IN ('RECIPIENT_SUPPRESSED', 'TEMPLATE_UNAVAILABLE'))
    ),
  CONSTRAINT awcms_commerce_document_deliveries_link_check
    CHECK (
      (link_token_hash IS NULL AND link_expires_at IS NULL)
      OR (link_token_hash ~ '^sha256:[0-9a-f]{64}$'
        AND link_expires_at IS NOT NULL
        AND link_expires_at > created_at
        AND link_expires_at <= created_at + interval '168 hours')
    ),
  -- A private link only makes sense for a document (the only target with an
  -- HTML rendering); the others carry their content in the message itself.
  CONSTRAINT awcms_commerce_document_deliveries_link_target_check
    CHECK (link_token_hash IS NULL OR target_type = 'document')
);

CREATE INDEX IF NOT EXISTS awcms_commerce_document_deliveries_tenant_idx
  ON awcms_commerce_document_deliveries (tenant_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_document_deliveries_document_idx
  ON awcms_commerce_document_deliveries (document_id, created_at DESC)
  WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_document_deliveries_quotation_version_idx
  ON awcms_commerce_document_deliveries (quotation_version_id, created_at DESC)
  WHERE quotation_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_document_deliveries_work_order_idx
  ON awcms_commerce_document_deliveries (work_order_id, created_at DESC)
  WHERE work_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_document_deliveries_resend_idx
  ON awcms_commerce_document_deliveries (resend_of_id)
  WHERE resend_of_id IS NOT NULL;
-- Retention cursor (`commerce/domain/documents-lifecycle.ts`) and the admin
-- "recent deliveries" list.
CREATE INDEX IF NOT EXISTS awcms_commerce_document_deliveries_tenant_created_idx
  ON awcms_commerce_document_deliveries (tenant_id, created_at DESC);
-- The public link lookup: one token, one row.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_document_deliveries_link_hash_key
  ON awcms_commerce_document_deliveries (link_token_hash)
  WHERE link_token_hash IS NOT NULL;

ALTER TABLE awcms_commerce_document_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_document_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_document_deliveries_tenant_isolation
  ON awcms_commerce_document_deliveries
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Same-tenant source existence and number truth (see the header).
CREATE OR REPLACE FUNCTION awcms_commerce_document_deliveries_check_target()
RETURNS trigger AS $awcms_commerce_document_deliveries_check_target$
DECLARE
  source_number text;
BEGIN
  IF NEW.target_type = 'document' THEN
    SELECT number INTO source_number
    FROM awcms_commerce_documents
    WHERE tenant_id = NEW.tenant_id AND id = NEW.document_id
    FOR KEY SHARE;
  ELSIF NEW.target_type = 'quotation_version' THEN
    SELECT q.number INTO source_number
    FROM awcms_commerce_quotation_versions v
    JOIN awcms_commerce_quotations q
      ON q.tenant_id = v.tenant_id AND q.id = v.quotation_id
    WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.quotation_version_id
    FOR KEY SHARE OF v;
  ELSE
    SELECT number INTO source_number
    FROM awcms_commerce_work_orders
    WHERE tenant_id = NEW.tenant_id AND id = NEW.work_order_id
    FOR KEY SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery source % does not exist in tenant %',
      NEW.target_type, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF source_number IS DISTINCT FROM NEW.doc_number THEN
    RAISE EXCEPTION 'delivery doc_number % does not match its source (%)',
      NEW.doc_number, source_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_document_deliveries_check_target$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_document_deliveries_check_target
  ON awcms_commerce_document_deliveries;
CREATE TRIGGER awcms_commerce_document_deliveries_check_target
  BEFORE INSERT ON awcms_commerce_document_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_document_deliveries_check_target();

-- Append-only: a delivery request is written once, never rewritten.
CREATE OR REPLACE FUNCTION awcms_commerce_document_deliveries_append_only()
RETURNS trigger AS $awcms_commerce_document_deliveries_append_only$
BEGIN
  RAISE EXCEPTION
    '% row % is append-only (a re-send is a new row)',
    TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$awcms_commerce_document_deliveries_append_only$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_document_deliveries_append_only
  ON awcms_commerce_document_deliveries;
CREATE TRIGGER awcms_commerce_document_deliveries_append_only
  BEFORE UPDATE ON awcms_commerce_document_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_document_deliveries_append_only();

REVOKE UPDATE, DELETE ON awcms_commerce_document_deliveries FROM awcms_app;

-- The history read joins the commerce WhatsApp outbox on its correlation id
-- (the e-mail outbox is reached through its existing `(tenant_id, category, …)`
-- index, whose category is this feature's template key).
CREATE INDEX IF NOT EXISTS awcms_commerce_whatsapp_messages_correlation_idx
  ON awcms_commerce_whatsapp_messages (tenant_id, correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON TABLE awcms_commerce_document_deliveries IS
  'Issue #295 (ADR-0034) — append-only request to deliver one immutable commercial document (receipt, invoice, quotation version, work-order notice) through the existing e-mail or commerce WhatsApp outbox. Masked recipient only; live status is read from the outbox via correlation_id = id.';
