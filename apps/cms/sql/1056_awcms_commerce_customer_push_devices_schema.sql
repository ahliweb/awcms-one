-- Issue #430 (ADR-0048, epic: customer Web Push) - the customer device
-- directory and the consent preferences. Commerce-owned (ADR-0048 option C):
-- NOTHING here references an upstream `awcms_push_*` table and no upstream
-- table is written. A customer is not a tenant user, so a customer device lives
-- in its own table, bound to a customer ACCOUNT and to the SESSION that enrolled
-- it, never to `awcms_tenant_users`.
--
-- Next migrations of this feature: 1057 (the thin outbox, for #432), 1058
-- (worker grants and the credential guard), 1059 (the permission).
--
-- ## Credentials exist only while a device is active (ADR-0048 I3)
--
-- `endpoint` (a bearer-grade capability to push to one browser), the Web Push
-- `auth` secret and the `p256dh` public key are present only on an `active`
-- row; every other status destroys them (a CHECK ties the two together, so a
-- row that is not active cannot keep a credential even by a bug). The endpoint
-- and the auth secret are stored as AES-256-GCM envelopes of the shared
-- field-encryption helper (`v2:<keyId>:...`), under the SAME key ring upstream
-- uses for its own auth secrets (`PUSH_AUTH_SECRET_ENCRYPTION_KEYS`) but with a
-- distinct, purpose-bound AAD per column, so a ciphertext copied from one
-- column, row or tenant to another fails authentication:
--
--   endpoint_ciphertext     purpose commerce.customer_push_endpoint
--   auth_secret_ciphertext  purpose commerce.customer_push_auth_secret
--
-- AAD row id = `endpoint_hash` (the row's business key, known before the
-- UPSERT; it never changes). There is NO plaintext credential column.
-- `p256dh_key` is the subscriber's PUBLIC key (RFC 8291 section 3.1): not a
-- secret, kept in the clear exactly as upstream keeps it.
-- `endpoint_masked` (origin + the last six characters) is what every list, log
-- and diagnostic reads.
--
-- ## Ownership
--
-- A device binds one endpoint to one account, one enrolling session and one
-- validated storefront origin. `(tenant_id, endpoint_hash)` is unique: a second
-- account registering the same browser endpoint TRANSFERS the row (an explicit,
-- audited, atomic operation in the application, never an INSERT).
--
-- `session_id` is nullable with `ON DELETE SET NULL (session_id)`: the customer
-- auth purge deletes revoked sessions after seven days, and that must not be
-- blocked by, nor delete, the device row. A device whose session is gone is not
-- deliverable (send-time eligibility, #432) and the maintenance job revokes it.
-- The account FK cascades: an account that is ever deleted takes its devices,
-- preferences and queued messages with it (UU PDP erasure).
--
-- ## Retention (30 days, ADR-0048 Q8)
--
-- `revoked_at` is the moment the credentials were destroyed (the status left
-- `active`) and is the retention cursor: a tombstone (hash + mask only) is kept
-- 30 days, then purged by `commerce:customer-push:maintenance`. NULL while the
-- device is active.
--
-- ## Preferences
--
-- One row per (account, purpose); a withdrawal keeps its row as evidence
-- (`enabled = false`, `revoked_at` set). The closed purposes are the three
-- transactional ones plus the reserved `marketing` (never sent in v1, Q11). The
-- existing `marketing_consent_at` (e-mail/WhatsApp) is NOT reused for push.
--
-- Every trigger function pins `search_path` (the #1046 gate).

-- The composite keys the new tables reference (additive, ADR-0048 section 3).
ALTER TABLE awcms_commerce_customer_accounts
  ADD CONSTRAINT awcms_commerce_customer_accounts_tenant_id_id_key
    UNIQUE (tenant_id, id);

ALTER TABLE awcms_commerce_customer_sessions
  ADD CONSTRAINT awcms_commerce_customer_sessions_tenant_id_id_key
    UNIQUE (tenant_id, id);

CREATE TABLE IF NOT EXISTS awcms_commerce_push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  account_id uuid NOT NULL,
  session_id uuid,
  storefront_origin text NOT NULL,
  endpoint_ciphertext text,
  endpoint_hash text NOT NULL,
  endpoint_masked text NOT NULL,
  p256dh_key text,
  auth_secret_ciphertext text,
  status text NOT NULL DEFAULT 'active',
  status_reason text,
  user_agent_summary text,
  failure_count integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  registered_at timestamptz NOT NULL DEFAULT now(),
  rebound_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_push_devices_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_push_devices_endpoint_key
    UNIQUE (tenant_id, endpoint_hash),
  CONSTRAINT awcms_commerce_push_devices_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES awcms_commerce_customer_accounts (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_push_devices_session_fk
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES awcms_commerce_customer_sessions (tenant_id, id)
    ON DELETE SET NULL (session_id),
  CONSTRAINT awcms_commerce_push_devices_status_check
    CHECK (status IN ('active', 'revoked', 'gone', 'disabled')),
  CONSTRAINT awcms_commerce_push_devices_reason_check
    CHECK (
      status_reason IS NULL OR status_reason IN (
        'customer_removed', 'logout', 'session_ended', 'account_blocked',
        'account_erased', 'endpoint_gone', 'origin_revoked', 'vapid_rotated',
        'kill_switch'
      )
    ),
  -- I3: credentials exist if and only if the device is active.
  CONSTRAINT awcms_commerce_push_devices_credentials_check
    CHECK (
      (status = 'active'
        AND endpoint_ciphertext IS NOT NULL
        AND p256dh_key IS NOT NULL
        AND auth_secret_ciphertext IS NOT NULL
        AND revoked_at IS NULL)
      OR
      (status <> 'active'
        AND endpoint_ciphertext IS NULL
        AND p256dh_key IS NULL
        AND auth_secret_ciphertext IS NULL
        AND revoked_at IS NOT NULL)
    ),
  CONSTRAINT awcms_commerce_push_devices_origin_check
    CHECK (
      storefront_origin ~ '^https?://[^/?#@\s]+$'
      AND length(storefront_origin) <= 255
    ),
  CONSTRAINT awcms_commerce_push_devices_hash_check
    CHECK (endpoint_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT awcms_commerce_push_devices_failure_count_check
    CHECK (failure_count >= 0),
  CONSTRAINT awcms_commerce_push_devices_user_agent_check
    CHECK (user_agent_summary IS NULL OR length(user_agent_summary) <= 120)
);

-- Fan-out: the active devices of one account (#432).
CREATE INDEX IF NOT EXISTS awcms_commerce_push_devices_account_active_idx
  ON awcms_commerce_push_devices (tenant_id, account_id)
  WHERE status = 'active';

-- The FK columns' own indexes (db:fk-index).
CREATE INDEX IF NOT EXISTS awcms_commerce_push_devices_account_idx
  ON awcms_commerce_push_devices (tenant_id, account_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_push_devices_session_idx
  ON awcms_commerce_push_devices (tenant_id, session_id);

-- Retention purge and the session-ended sweep.
CREATE INDEX IF NOT EXISTS awcms_commerce_push_devices_status_revoked_idx
  ON awcms_commerce_push_devices (tenant_id, status, revoked_at);

ALTER TABLE awcms_commerce_push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_push_devices FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_push_devices_tenant_isolation
  ON awcms_commerce_push_devices
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE awcms_commerce_push_devices IS
  'Issue #430 (ADR-0048) - one customer browser push subscription per tenant and endpoint, bound to an account, the enrolling session and a validated storefront origin. Credentials (endpoint, auth secret) are AES-256-GCM envelopes and exist only while status = active.';
COMMENT ON COLUMN awcms_commerce_push_devices.endpoint_ciphertext IS
  'AES-256-GCM envelope of the push endpoint URL (bearer-grade capability); AAD = (commerce.customer_push_endpoint, tenant_id, endpoint_hash). NULL unless active.';
COMMENT ON COLUMN awcms_commerce_push_devices.auth_secret_ciphertext IS
  'AES-256-GCM envelope of the RFC 8291 auth secret; AAD = (commerce.customer_push_auth_secret, tenant_id, endpoint_hash). NULL unless active.';

CREATE TABLE IF NOT EXISTS awcms_commerce_push_preferences (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  account_id uuid NOT NULL,
  purpose text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  consent_text_version text NOT NULL,
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, purpose),
  CONSTRAINT awcms_commerce_push_preferences_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES awcms_commerce_customer_accounts (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_push_preferences_purpose_check
    CHECK (purpose IN (
      'order_updates', 'payment_updates', 'support_replies', 'marketing'
    )),
  CONSTRAINT awcms_commerce_push_preferences_granted_check
    CHECK (NOT enabled OR granted_at IS NOT NULL),
  CONSTRAINT awcms_commerce_push_preferences_version_check
    CHECK (length(consent_text_version) BETWEEN 1 AND 32)
);

-- The FK's own index leads with the primary key's columns already
-- ((tenant_id, account_id, purpose)); this one serves the "my preferences" read.
CREATE INDEX IF NOT EXISTS awcms_commerce_push_preferences_account_idx
  ON awcms_commerce_push_preferences (tenant_id, account_id);

ALTER TABLE awcms_commerce_push_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_push_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_push_preferences_tenant_isolation
  ON awcms_commerce_push_preferences
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE awcms_commerce_push_preferences IS
  'Issue #430 (ADR-0048) - per account and purpose consent for customer push, with the consent text version shown. A withdrawal keeps its row (evidence). Marketing is reserved and never sent in v1.';
