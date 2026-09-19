-- Issue #114 (part of epic #33 C6; contract #106 D9) — customer campaigns:
-- consent + the mass e-mail/WhatsApp send. Next free number in the reserved
-- commerce 9xx range (ADR-0015, `929` after `sql/928`). Follows `sql/901`'s
-- and `sql/927`'s conventions exactly (see those files' headers for the full
-- reasoning this migration does not repeat): `ENABLE` + `FORCE ROW LEVEL
-- SECURITY`, one tenant-isolation `USING` policy, `id uuid` PK `DEFAULT
-- gen_random_uuid()`, `created_at`/`updated_at timestamptz DEFAULT now()`,
-- an FK index for every FK column, no per-table GRANT to `awcms_app`
-- (`sql/019`'s `ALTER DEFAULT PRIVILEGES` already covers it) but an explicit
-- `GRANT ... TO awcms_worker` for `commerce:campaigns:dispatch`'s own writes.
--
-- ## Consent is load-bearing (ADR-0017 D9)
--
-- `marketing_consent_at` lands on the EXISTING
-- `awcms_commerce_customer_accounts` table (Issue #87/#89), not a new one —
-- consent is a property of an account, the same row `email_normalized`/
-- `status` already live on. A nullable timestamp, not a boolean: `NOT NULL`
-- means "granted at this instant", `NULL` means "never granted (or
-- withdrawn)" — a single column answers both "did they ever consent" and
-- "when", and a campaign's audience resolution
-- (`application/campaign-directory.ts`'s `resolveCampaignAudiencePage`/
-- `countCampaignAudience`) tests it with `IS NOT NULL` alone, never a
-- second "opted_out" flag that could disagree with it. Toggled ONLY by the
-- account itself (`PATCH .../account/me {marketingConsent}` — this
-- migration adds no admin route or permission that lets staff set it for a
-- customer).
--
-- ## `awcms_commerce_campaigns`
--
-- One row per campaign. `audience jsonb` — `{levels: number[], hasAccount:
-- boolean|null, lastOrderSince: string|null}` — is validated at the
-- application boundary (`domain/campaign-validation.ts`), not by a database
-- CHECK: it is a small, evolving filter shape, and the boundary that
-- constructs it already owns its own tests. `subject` is nullable — the
-- OpenAPI contract documents it as "ignored for channel:\"whatsapp\"", so a
-- WhatsApp-channel campaign is never required to carry one.
-- `recipient_count`/`sent_at` start `NULL` on a fresh `draft` and are
-- populated only once the campaign has actually been dispatched
-- (`application/campaign-dispatch.ts`'s FINALIZE phase) — `recipient_count`
-- is NOT re-derived from `awcms_commerce_campaign_recipients` on every read
-- for a `sent` campaign (it IS, cheaply, for a `sending` one — see
-- `campaign-directory.ts#toRecord`'s own `sentCount`), because a finished
-- campaign's own count is a historical fact, not a live query.
--
-- ## `awcms_commerce_campaign_recipients`
--
-- ONE row per resolved recipient — the resumability/audit ledger ADR-0017
-- D9 calls for explicitly: "a partial send is resumable and auditable".
-- `UNIQUE (campaign_id, customer_id)` is what makes the dispatcher's `ON
-- CONFLICT DO NOTHING` insert safe to retry after a crash, and what makes
-- `application/campaign-directory.ts#resolveCampaignAudiencePage`'s own
-- `NOT EXISTS` correct as a resume cursor (a customer already recorded for
-- this campaign is never re-selected). `address_masked` is the masked
-- e-mail/phone ONLY (`maskIdentifierValue`/`maskPhone`,
-- `awcms-sensitive-data`) — the raw address is never written to this table;
-- it lives only in the e-mail/WhatsApp outbox row itself (`outbox_ref`
-- points at it, but this table never joins across modules to fetch it
-- back). `status` is `queued` (recipient row inserted, outbox call not yet
-- attempted — a transient state within `dispatchOnePage`'s own transaction,
-- essentially never observed at rest), `enqueued` (the outbox INSERT
-- succeeded) or `skipped` (no address for the channel, or the e-mail outbox
-- refused it — e.g. suppressed).

ALTER TABLE awcms_commerce_customer_accounts
  ADD COLUMN IF NOT EXISTS marketing_consent_at timestamptz;

CREATE TABLE IF NOT EXISTS awcms_commerce_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  name text,
  channel text NOT NULL,
  subject text,
  body text NOT NULL,
  audience jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  sent_at timestamptz,
  recipient_count integer,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_campaigns_channel_check
    CHECK (channel IN ('email', 'whatsapp')),
  CONSTRAINT awcms_commerce_campaigns_status_check
    CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  CONSTRAINT awcms_commerce_campaigns_body_length_check
    CHECK (char_length(body) BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_campaigns_tenant_idx
  ON awcms_commerce_campaigns (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_campaigns_tenant_deleted_idx
  ON awcms_commerce_campaigns (tenant_id, deleted_at);

-- The staff list's own newest-first keyset scan.
CREATE INDEX IF NOT EXISTS awcms_commerce_campaigns_tenant_created_idx
  ON awcms_commerce_campaigns (tenant_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- `commerce:campaigns:dispatch`'s own CLAIM query.
CREATE INDEX IF NOT EXISTS awcms_commerce_campaigns_dispatch_idx
  ON awcms_commerce_campaigns (tenant_id, status, scheduled_at)
  WHERE deleted_at IS NULL AND status IN ('scheduled', 'sending');

ALTER TABLE awcms_commerce_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_campaigns FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_campaigns_tenant_isolation
  ON awcms_commerce_campaigns
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  campaign_id uuid NOT NULL REFERENCES awcms_commerce_campaigns (id),
  customer_id uuid NOT NULL REFERENCES awcms_commerce_customers (id),
  address_masked text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  outbox_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_campaign_recipients_status_check
    CHECK (status IN ('queued', 'enqueued', 'skipped')),
  CONSTRAINT awcms_commerce_campaign_recipients_unique_campaign_customer
    UNIQUE (campaign_id, customer_id)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_campaign_recipients_tenant_idx
  ON awcms_commerce_campaign_recipients (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_campaign_recipients_campaign_idx
  ON awcms_commerce_campaign_recipients (campaign_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_campaign_recipients_customer_idx
  ON awcms_commerce_campaign_recipients (customer_id);

ALTER TABLE awcms_commerce_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_campaign_recipients FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_campaign_recipients_tenant_isolation
  ON awcms_commerce_campaign_recipients
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `module.ts`'s `commerce.campaigns`/`commerce.campaign_recipients`
-- `dataLifecycle` descriptors both declare `executionMode: "generic"` —
-- `awcms_worker` gets nothing by default (`sql/019`'s `ALTER DEFAULT
-- PRIVILEGES` only ever covered `awcms_app`), same reasoning `sql/928`'s
-- own tail gives.
GRANT SELECT, UPDATE, DELETE ON awcms_commerce_campaigns TO awcms_worker;
GRANT SELECT, INSERT, DELETE ON awcms_commerce_campaign_recipients TO awcms_worker;

COMMENT ON TABLE awcms_commerce_campaigns IS
  'Issue #114 (contract #106 D9) — a consent-gated mass e-mail/WhatsApp send. commerce:campaigns:dispatch (application/campaign-dispatch.ts) fans a sending campaign out into the email/WhatsApp outboxes in pages of 200.';
COMMENT ON TABLE awcms_commerce_campaign_recipients IS
  'Issue #114 (contract #106 D9) — one row per resolved recipient; the resumability/audit ledger a partial send relies on. address_masked only, never a raw e-mail/phone.';
COMMENT ON COLUMN awcms_commerce_customer_accounts.marketing_consent_at IS
  'Issue #114 (contract #106 D9) — non-null means the account holder opted into marketing communication at this instant; null means never opted in (or withdrawn). Toggled only by the account itself via PATCH .../account/me.';
