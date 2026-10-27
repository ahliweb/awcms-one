-- Issue #430 (ADR-0048) - the thin customer-push outbox and its attempt ledger.
-- #430 creates the TABLES and the repository (insert, cap window, cancel) only;
-- the fan-out consumers, the claim/send/finalize loop and the dispatch job are
-- #432. Nothing here is written by any code path of #430 except the
-- cancellation of queued messages when a device is transferred, revoked or
-- logged out.
--
-- ## Why a second queue (option C, ADR-0048 section 1)
--
-- Upstream's `awcms_push_messages` carries a `NOT NULL recipient_tenant_user_id`
-- and a composite FK to staff subscriptions; a customer recipient cannot be
-- expressed there without a shadow tenant user (impersonation) or an upstream
-- schema change. So `commerce` owns its own outbox, shaped like upstream's and
-- like `awcms_commerce_whatsapp_messages` (sql/925): `queued -> sending ->
-- sent | retry_wait | failed | cancelled | expired`, with `next_attempt_at`
-- doubling as the claim lease. The provider, crypto, retry mapping and circuit
-- breaker are IMPORTED from `push_delivery`, never copied.
--
-- ## The message carries no personal data (ADR-0048 I6, T15)
--
-- `title` and `body` are generic template text (at most 120 and 240
-- characters), `target_path` is one of the fixed storefront paths of the
-- purpose, never an identifier. There is no order id, amount, name or phone on
-- a row. `account_id` is fixed at enqueue and compared with the device's
-- current account at send time (I5): a transferred device cannot deliver the
-- previous owner's message.
--
-- `last_error` and an attempt's `error_message` are CLOSED vocabularies (a
-- lower-case code, enforced here by shape and in the application by a list), so
-- no provider text, endpoint or key can reach a column that a diagnostic reads.
-- `provider_response_snippet` is capped at 500 characters and is pre-redacted
-- by the caller; it is never the payload or the endpoint.
--
-- ## Dedupe and the rate window
--
-- `UNIQUE (tenant_id, dedupe_key)` (value: event id and device id) makes the
-- consumer's INSERT ... ON CONFLICT DO NOTHING one effect per (event, device).
-- The per-account cap (12 per rolling hour, 40 per rolling day) counts rows by
-- `(tenant_id, account_id, created_at)`, indexed below.
--
-- ## Retention (30 days)
--
-- A terminal message (sent, failed, cancelled, expired) and its attempts are
-- purged 30 days after `updated_at` by `commerce:customer-push:maintenance`.
--
-- Both tables cascade from their parents: a device or an account that is
-- removed (erasure, tombstone purge) takes its messages with it.

CREATE TABLE IF NOT EXISTS awcms_commerce_push_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  account_id uuid NOT NULL,
  device_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  event_type text NOT NULL,
  purpose text NOT NULL,
  priority text NOT NULL DEFAULT 'normal',
  tag text NOT NULL,
  dedupe_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  target_path text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  retry_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  expires_at timestamptz NOT NULL,
  last_error text,
  provider_name text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT awcms_commerce_push_messages_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_push_messages_dedupe_key
    UNIQUE (tenant_id, dedupe_key),
  CONSTRAINT awcms_commerce_push_messages_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES awcms_commerce_customer_accounts (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_push_messages_device_fk
    FOREIGN KEY (tenant_id, device_id)
    REFERENCES awcms_commerce_push_devices (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_push_messages_purpose_check
    CHECK (purpose IN ('order_updates', 'payment_updates', 'support_replies')),
  CONSTRAINT awcms_commerce_push_messages_priority_check
    CHECK (priority IN ('low', 'normal', 'high')),
  CONSTRAINT awcms_commerce_push_messages_status_check
    CHECK (status IN (
      'queued', 'sending', 'sent', 'retry_wait', 'failed', 'cancelled', 'expired'
    )),
  CONSTRAINT awcms_commerce_push_messages_title_check
    CHECK (length(title) BETWEEN 1 AND 120),
  CONSTRAINT awcms_commerce_push_messages_body_check
    CHECK (length(body) BETWEEN 1 AND 240),
  -- A same-origin absolute path: starts with one slash, never `//`, `/\`, a
  -- scheme, a query, a fragment or traversal.
  CONSTRAINT awcms_commerce_push_messages_target_path_check
    CHECK (
      target_path ~ '^/[a-z0-9][a-z0-9/_-]*$' AND length(target_path) <= 120
    ),
  CONSTRAINT awcms_commerce_push_messages_tag_check
    CHECK (tag ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT awcms_commerce_push_messages_event_type_check
    CHECK (event_type ~ '^[a-z][a-z0-9_.]{0,127}$'),
  CONSTRAINT awcms_commerce_push_messages_last_error_check
    CHECK (last_error IS NULL OR last_error ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT awcms_commerce_push_messages_retry_count_check
    CHECK (retry_count >= 0)
);

-- Dispatch polling shape (#432): WHERE tenant_id AND status IN (...) AND
-- next_attempt_at <= now() ... FOR UPDATE SKIP LOCKED.
CREATE INDEX IF NOT EXISTS awcms_commerce_push_messages_dispatch_idx
  ON awcms_commerce_push_messages (tenant_id, status, next_attempt_at);

-- The FK columns' own indexes (db:fk-index).
CREATE INDEX IF NOT EXISTS awcms_commerce_push_messages_device_idx
  ON awcms_commerce_push_messages (tenant_id, device_id);

-- The per-account notification cap window (12 per hour, 40 per day).
CREATE INDEX IF NOT EXISTS awcms_commerce_push_messages_account_window_idx
  ON awcms_commerce_push_messages (tenant_id, account_id, created_at DESC);

-- Retention and the aggregate diagnostics.
CREATE INDEX IF NOT EXISTS awcms_commerce_push_messages_retention_idx
  ON awcms_commerce_push_messages (tenant_id, status, updated_at);

ALTER TABLE awcms_commerce_push_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_push_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_push_messages_tenant_isolation
  ON awcms_commerce_push_messages
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE awcms_commerce_push_messages IS
  'Issue #430 (ADR-0048) - the thin customer-push outbox, one row per event and device. Generic template text and a fixed storefront path only; no order data, no identifier. sent = the push service accepted the request, never "delivered" or "read".';

CREATE TABLE IF NOT EXISTS awcms_commerce_push_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  message_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  outcome text NOT NULL,
  provider_name text,
  provider_response_snippet text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_push_delivery_attempts_message_fk
    FOREIGN KEY (tenant_id, message_id)
    REFERENCES awcms_commerce_push_messages (tenant_id, id)
    ON DELETE CASCADE,
  -- A re-claimed expired lease can never double-record one attempt number; the
  -- call site uses ON CONFLICT DO NOTHING.
  CONSTRAINT awcms_commerce_push_delivery_attempts_unique_attempt
    UNIQUE (message_id, attempt_no),
  CONSTRAINT awcms_commerce_push_delivery_attempts_outcome_check
    CHECK (outcome IN ('success', 'failure')),
  CONSTRAINT awcms_commerce_push_delivery_attempts_attempt_no_check
    CHECK (attempt_no > 0),
  CONSTRAINT awcms_commerce_push_delivery_attempts_snippet_check
    CHECK (
      provider_response_snippet IS NULL
      OR length(provider_response_snippet) <= 500
    ),
  CONSTRAINT awcms_commerce_push_delivery_attempts_error_check
    CHECK (error_message IS NULL OR error_message ~ '^[a-z][a-z0-9_]{0,63}$')
);

CREATE INDEX IF NOT EXISTS awcms_commerce_push_delivery_attempts_message_idx
  ON awcms_commerce_push_delivery_attempts (tenant_id, message_id);

-- Retention purge scan path.
CREATE INDEX IF NOT EXISTS awcms_commerce_push_delivery_attempts_created_idx
  ON awcms_commerce_push_delivery_attempts (tenant_id, created_at);

ALTER TABLE awcms_commerce_push_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_push_delivery_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_push_delivery_attempts_tenant_isolation
  ON awcms_commerce_push_delivery_attempts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE awcms_commerce_push_delivery_attempts IS
  'Issue #430 (ADR-0048) - one row per provider attempt of a customer push message. Fixed-vocabulary error, capped pre-redacted snippet; never the payload or the endpoint.';
