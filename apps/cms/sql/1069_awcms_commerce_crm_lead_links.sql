-- Issue #463 (ADR-0056) - the commerce-owned record that a CRM lead (a
-- `crm_leads` prospect) became a commerce customer, on VERIFIED commerce facts
-- only. This is the whole of the adapter's storage: commerce keeps no copy of the
-- lead (no name, contact, note or stage) and `crm_leads` keeps no copy of the
-- customer (it holds only the opaque `external_customer_ref` a conversion
-- writes). There is no customer master fork: the customer stays one row of
-- `awcms_commerce_customers`.
--
-- ## Shape
--
-- One row per CONFIRMED conversion of one lead to one customer.
--   - `lead_id` is OPAQUE: no foreign key, no read of `awcms_crm_*` (commerce
--     reaches the lead only through `CrmLeadPort`; `crm_leads` is an optional
--     capability, so a database where it is off must still hold this table). The
--     lead is checked to exist in the tenant by the port at link time.
--   - `customer_id` is a composite FK to the customer (tenant-safe). The customer
--     is anonymised, never deleted, by the shopper erasure (ADR-0055), so the row
--     keeps resolving.
--   - `evidence_kind` is the commerce fact the conversion rests on:
--     `customer_registration` (the shopper's e-mail was proven by OTP, so the
--     account has `email_verified_at`) or `paid_order` (an order of that customer
--     that is paid and not cancelled or refunded). `order_id` is set for exactly
--     the second (CHECK) and is a composite FK to the order.
--   - `evidence_ref` is the opaque replay key sent to the port as `evidenceRef`
--     (`commerce:registration:<customer id>` or `commerce:order:<order id>`),
--     UNIQUE per tenant forever: one verified fact converts at most one lead,
--     and a reversed conversion cannot be re-asserted with the same fact.
--   - `conversion_id` is `crm_leads`' conversion id returned by the port (opaque,
--     needed to reverse it).
--   - `lead_first_source_kind` / `lead_first_touch_id` copy the lead's FIRST
--     source touch (immutable upstream) as returned by `readLeadState`, so the
--     `customer.converted` event and any later view can attribute the customer to
--     the channel the prospect first came from without reading the lead again.
--     Both are non-personal references.
--
-- ## States
--
-- `linked` -> `reversal_pending` (the evidence order was cancelled or fully
-- refunded: set by a domain-event consumer running as `awcms_worker`, which holds
-- NO privilege on the `crm_leads` tables (`awcms_crm_leads`, `awcms_crm_lead_conversions`) by upstream design, so it can only FLAG
-- the link) -> `reversed` (a person with the CRM approval permission applied the
-- reversal through the port). A person may also reverse a `linked` row directly.
-- `reversed` is final. A row is never deleted by anyone (a guard trigger refuses
-- it and `awcms_app` is REVOKEd DELETE): it is the evidence of what commerce
-- confirmed and when.
--
-- Staff and actor columns are plain uuid stamps, not foreign keys (`sql/931`'s
-- reasoning): the record of who decided must outlive the account that did.

CREATE TABLE IF NOT EXISTS awcms_commerce_crm_lead_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  -- A `crm_leads` lead id. OPAQUE: no foreign key, no read, no join.
  lead_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid,
  evidence_kind text NOT NULL,
  evidence_ref text NOT NULL,
  -- The conversion id `crm_leads` returned for this confirmation. OPAQUE.
  conversion_id uuid NOT NULL,
  lead_first_source_kind text,
  lead_first_touch_id uuid,
  state text NOT NULL DEFAULT 'linked',
  linked_by_tenant_user_id uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  reversal_cause text,
  reversal_requested_at timestamptz,
  -- The person whose cancel or refund raised the flag (from the delivered
  -- event's envelope); NULL when a system action raised it.
  reversal_actor_tenant_user_id uuid,
  reversed_at timestamptz,
  reversed_by_tenant_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_crm_lead_links_customer_fk
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES awcms_commerce_customers (tenant_id, id),
  CONSTRAINT awcms_commerce_crm_lead_links_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_crm_lead_links_evidence_kind_check
    CHECK (evidence_kind IN ('customer_registration', 'paid_order')),
  CONSTRAINT awcms_commerce_crm_lead_links_evidence_order_check
    CHECK ((evidence_kind = 'paid_order') = (order_id IS NOT NULL)),
  -- The opaque-reference alphabet `CrmLeadPort` accepts; never a contact value.
  CONSTRAINT awcms_commerce_crm_lead_links_evidence_ref_check
    CHECK (evidence_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT awcms_commerce_crm_lead_links_state_check
    CHECK (state IN ('linked', 'reversal_pending', 'reversed')),
  CONSTRAINT awcms_commerce_crm_lead_links_reversal_cause_check
    CHECK (reversal_cause IS NULL
           OR reversal_cause IN ('order_cancelled', 'order_refunded', 'manual')),
  CONSTRAINT awcms_commerce_crm_lead_links_state_columns_check
    CHECK (
      (state = 'linked'
         AND reversal_requested_at IS NULL AND reversed_at IS NULL
         AND reversed_by_tenant_user_id IS NULL AND reversal_cause IS NULL)
      OR (state = 'reversal_pending'
         AND reversal_requested_at IS NOT NULL AND reversal_cause IS NOT NULL
         AND reversed_at IS NULL AND reversed_by_tenant_user_id IS NULL)
      OR (state = 'reversed'
         AND reversed_at IS NOT NULL AND reversed_by_tenant_user_id IS NOT NULL
         AND reversal_cause IS NOT NULL)
    ),
  CONSTRAINT awcms_commerce_crm_lead_links_evidence_key
    UNIQUE (tenant_id, evidence_ref),
  CONSTRAINT awcms_commerce_crm_lead_links_tenant_id_id_key
    UNIQUE (tenant_id, id)
);

-- A lead has at most one LIVE link (`crm_leads` allows one live conversion per
-- lead as well). A reversed link frees the lead for a correction.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_crm_lead_links_live_lead_key
  ON awcms_commerce_crm_lead_links (tenant_id, lead_id)
  WHERE state <> 'reversed';

-- "Every link of one customer" (the shopper export, the customer view).
CREATE INDEX IF NOT EXISTS awcms_commerce_crm_lead_links_customer_idx
  ON awcms_commerce_crm_lead_links (tenant_id, customer_id);

-- The two flaggers read the live links resting on ONE order.
CREATE INDEX IF NOT EXISTS awcms_commerce_crm_lead_links_order_idx
  ON awcms_commerce_crm_lead_links (tenant_id, order_id)
  WHERE order_id IS NOT NULL;

-- The list ("newest first", optionally one state).
CREATE INDEX IF NOT EXISTS awcms_commerce_crm_lead_links_tenant_linked_idx
  ON awcms_commerce_crm_lead_links (tenant_id, linked_at DESC, id DESC);

ALTER TABLE awcms_commerce_crm_lead_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_crm_lead_links FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_crm_lead_links_tenant_isolation
  ON awcms_commerce_crm_lead_links
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- What may change, and in which order: `linked` -> `reversal_pending` ->
-- `reversed`, or `linked` -> `reversed`. Who and what the row joins never
-- changes; `reversed` is final; nothing is ever deleted.
CREATE OR REPLACE FUNCTION awcms_commerce_crm_lead_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $awcms_commerce_crm_lead_links_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'awcms_commerce_crm_lead_links: a link is evidence of a confirmed conversion and is reversed, never deleted (Issue #463)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.lead_id IS DISTINCT FROM OLD.lead_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.evidence_kind IS DISTINCT FROM OLD.evidence_kind
     OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
     OR NEW.conversion_id IS DISTINCT FROM OLD.conversion_id
     OR NEW.lead_first_source_kind IS DISTINCT FROM OLD.lead_first_source_kind
     OR NEW.lead_first_touch_id IS DISTINCT FROM OLD.lead_first_touch_id
     OR NEW.linked_by_tenant_user_id IS DISTINCT FROM OLD.linked_by_tenant_user_id
     OR NEW.linked_at IS DISTINCT FROM OLD.linked_at THEN
    RAISE EXCEPTION
      'awcms_commerce_crm_lead_links: what a link joins and its evidence never change (Issue #463)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.state = 'reversed' THEN
    RAISE EXCEPTION
      'awcms_commerce_crm_lead_links: a reversed link is final (Issue #463)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state
     AND NOT (
       (OLD.state = 'linked' AND NEW.state IN ('reversal_pending', 'reversed'))
       OR (OLD.state = 'reversal_pending' AND NEW.state = 'reversed')
     ) THEN
    RAISE EXCEPTION
      'awcms_commerce_crm_lead_links: % -> % is not a legal transition (Issue #463)',
      OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_crm_lead_links_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_crm_lead_links_guard
  ON awcms_commerce_crm_lead_links;
CREATE TRIGGER awcms_commerce_crm_lead_links_guard
  BEFORE UPDATE OR DELETE ON awcms_commerce_crm_lead_links
  FOR EACH ROW EXECUTE FUNCTION awcms_commerce_crm_lead_links_guard();

REVOKE DELETE, TRUNCATE ON awcms_commerce_crm_lead_links FROM awcms_app;

-- `awcms_worker` runs the two flaggers in `domain-events:dispatch`. It may read
-- the links and FLAG one (state, the reversal cause, who raised it, when): it can
-- never create a link, mark one reversed (that is the person's act through the
-- port) or touch what a link joins. The state column is in the grant because the
-- flag IS a state change; the guard trigger and the CHECK above bound which.
GRANT SELECT ON awcms_commerce_crm_lead_links TO awcms_worker;
GRANT UPDATE (state, reversal_cause, reversal_requested_at,
              reversal_actor_tenant_user_id, updated_at)
  ON awcms_commerce_crm_lead_links TO awcms_worker;
