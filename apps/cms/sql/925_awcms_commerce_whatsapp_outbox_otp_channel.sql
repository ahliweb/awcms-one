-- Issue #108 (C2, part of epic #33; contract #106/ADR-0017 D5) — WhatsApp
-- outbox schema, a third `awcms_commerce_customer_otps` identifier column,
-- worker grants, and the `commerce.whatsapp.read` permission. Next free
-- number in the reserved commerce 9xx range (ADR-0015). The sibling worktree
-- for Issue #107 (D3/D4, RajaOngkir + Midtrans) uses `924` independently —
-- the two migrations touch disjoint tables and apply in either order.
--
-- ## Shape mirrors `sql/014`'s email outbox exactly (ADR-0017 D1 — every
-- external provider is a port + adapters inside `commerce`, modelled on
-- `email`)
--
-- `awcms_commerce_whatsapp_messages` is one row per outbound message
-- (`queued -> sending -> sent|failed`, `attempts`/`next_attempt_at` lease —
-- same claim/finalize shape `email-dispatch.ts` already established, reused
-- verbatim by `application/whatsapp-dispatch.ts`).
-- `awcms_commerce_whatsapp_delivery_attempts` is the per-attempt ledger,
-- FK'd to the message row, `UNIQUE (message_id, attempt_no)` so a re-claimed
-- expired lease can never double-record the same attempt number.
--
-- ## `to_phone` is kept in the clear — same reasoning as `customers.phone`
--
-- `sql/913`'s header already establishes why `awcms_commerce_customers.phone`
-- is not hash-only: a provider adapter cannot DELIVER a WhatsApp message
-- knowing only a hash. `to_phone_hash` (lookup/dedup) and `to_phone_masked`
-- (display/log, `+62812***7890`-shaped via `domain/phone-normalisation.ts`'s
-- `maskPhone`) sit alongside it for exactly the reasons
-- `awcms-sensitive-data` requires — every diagnostics/log surface reads
-- `to_phone_masked`, never `to_phone`.
--
-- ## `awcms_commerce_customer_otps` gains a THIRD identifier column
--
-- Issue #89/#87 keyed every OTP row by `email_normalized NOT NULL`. A
-- WhatsApp login OTP has no e-mail at all (D5: "WhatsApp is a login channel
-- for existing accounts", registration stays e-mail-OTP only — see
-- `application/customer-auth.ts`'s header). `phone_normalized` is therefore
-- NULLABLE and `email_normalized`'s own `NOT NULL` is relaxed to a CHECK
-- that at least one of the two identifier columns is populated — a row is
-- always keyed by whichever identifier the request actually used
-- (`application/customer-account-store.ts`'s `issueOtp`/`consumeOtp`, now
-- parameterised over `identifierColumn`).

CREATE TABLE IF NOT EXISTS awcms_commerce_whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  correlation_id text,
  to_phone text NOT NULL,
  to_phone_hash text NOT NULL,
  to_phone_masked text NOT NULL,
  template_key text NOT NULL,
  variables jsonb,
  body_rendered text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  provider_ref text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT awcms_commerce_whatsapp_messages_template_key_format_check
    CHECK (template_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT awcms_commerce_whatsapp_messages_status_check
    CHECK (status IN ('queued', 'sending', 'sent', 'failed'))
);

-- Dispatcher polling query shape, identical to
-- `awcms_email_messages_dispatch_idx`'s own comment: one tenant at a time,
-- WHERE tenant_id = ? AND status IN ('queued') AND (next_attempt_at IS NULL
-- OR next_attempt_at <= now()) ... FOR UPDATE SKIP LOCKED.
-- `next_attempt_at` doubles as the claim lease expiry while
-- status = 'sending' — no separate lease column, same reuse
-- `email-dispatch.ts`/`object-dispatch.ts` already established.
CREATE INDEX IF NOT EXISTS awcms_commerce_whatsapp_messages_dispatch_idx
  ON awcms_commerce_whatsapp_messages (tenant_id, status, next_attempt_at);

-- Admin/diagnostics list view (GET /api/v1/commerce/whatsapp/messages):
-- filter by tenant, optionally by status, newest first.
CREATE INDEX IF NOT EXISTS awcms_commerce_whatsapp_messages_tenant_status_idx
  ON awcms_commerce_whatsapp_messages (tenant_id, status, created_at DESC);

-- Retention purge cursor (`application/whatsapp-queue-purge.ts`).
CREATE INDEX IF NOT EXISTS awcms_commerce_whatsapp_messages_retention_idx
  ON awcms_commerce_whatsapp_messages (tenant_id, status, updated_at);

ALTER TABLE awcms_commerce_whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_whatsapp_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_whatsapp_messages_tenant_isolation
  ON awcms_commerce_whatsapp_messages
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_whatsapp_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  message_id uuid NOT NULL REFERENCES awcms_commerce_whatsapp_messages (id),
  attempt_no integer NOT NULL,
  outcome text NOT NULL,
  provider_name text,
  -- Pre-redacted by the caller before insert — never the provider's raw
  -- response body. Truncated, not full payload retention (same rule
  -- `awcms_email_delivery_attempts.provider_response_snippet` follows).
  provider_response_snippet text,
  error_message text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_whatsapp_delivery_attempts_outcome_check
    CHECK (outcome IN ('success', 'failure')),
  CONSTRAINT awcms_commerce_whatsapp_delivery_attempts_attempt_no_check
    CHECK (attempt_no > 0),
  CONSTRAINT awcms_commerce_whatsapp_delivery_attempts_unique_attempt
    UNIQUE (message_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_whatsapp_delivery_attempts_tenant_idx
  ON awcms_commerce_whatsapp_delivery_attempts (tenant_id, attempted_at DESC);

-- FK index (message_id) for the "all attempts for this message" detail view.
CREATE INDEX IF NOT EXISTS awcms_commerce_whatsapp_delivery_attempts_message_idx
  ON awcms_commerce_whatsapp_delivery_attempts (message_id);

ALTER TABLE awcms_commerce_whatsapp_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_whatsapp_delivery_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_whatsapp_delivery_attempts_tenant_isolation
  ON awcms_commerce_whatsapp_delivery_attempts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `commerce:whatsapp:dispatch` (send) and `commerce:whatsapp:purge`
-- (retention) both run as `awcms_worker` — same split
-- `sql/022`/`sql/127` already made for the email outbox, including the
-- `SELECT` the `ON CONFLICT DO NOTHING` arbiter read needs on the attempts
-- table (sql/127's own header explains why INSERT alone is not enough).
GRANT SELECT, UPDATE, DELETE ON awcms_commerce_whatsapp_messages TO awcms_worker;
GRANT SELECT, INSERT, DELETE ON awcms_commerce_whatsapp_delivery_attempts TO awcms_worker;

-- Third identifier column — see this migration's header.
ALTER TABLE awcms_commerce_customer_otps
  ALTER COLUMN email_normalized DROP NOT NULL;

ALTER TABLE awcms_commerce_customer_otps
  ADD COLUMN IF NOT EXISTS phone_normalized text;

ALTER TABLE awcms_commerce_customer_otps
  ADD CONSTRAINT awcms_commerce_customer_otps_identifier_check
  CHECK (email_normalized IS NOT NULL OR phone_normalized IS NOT NULL);

-- The lookup `issueOtp`/`consumeOtp` do for a phone-keyed row: latest OTP for
-- a given tenant + phone (+ purpose, filtered in the query's own WHERE
-- clause) — mirrors `awcms_commerce_customer_otps_email_created_idx`
-- (sql/917).
CREATE INDEX IF NOT EXISTS awcms_commerce_customer_otps_phone_created_idx
  ON awcms_commerce_customer_otps (tenant_id, phone_normalized, created_at DESC)
  WHERE phone_normalized IS NOT NULL;

-- Permission catalog seed — mirrors `sql/914`'s own idempotent shape.
-- `read`-only: this increment ships one owner route
-- (`GET /api/v1/commerce/whatsapp/messages`, diagnostics), no admin
-- create/update/delete surface over the outbox (a message is only ever
-- created by the enqueue application functions, never directly by an
-- operator).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'whatsapp', 'read', 'Read WhatsApp outbox message diagnostics (masked phone only)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
