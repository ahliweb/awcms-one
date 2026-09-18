-- Issue #87 (C1, part of epic #32; contract #86/ADR-0016) — customer
-- account, OTP and bearer-session schema. Next free number in the reserved
-- commerce 9xx range (ADR-0015, `917` after `sql/916`). Follows `sql/901`'s
-- and `sql/913`'s conventions exactly (`ENABLE` + `FORCE ROW LEVEL
-- SECURITY`, one tenant-isolation `USING` policy, `id uuid` PK `DEFAULT
-- gen_random_uuid()`, `created_at`/`updated_at timestamptz DEFAULT now()`,
-- an FK index for every FK column, no per-table GRANT — `sql/019`'s `ALTER
-- DEFAULT PRIVILEGES` already covers `awcms_app`).
--
-- ## D1 — an account is NOT a password, NOT a principal
--
-- ADR-0016 Decision 1: a customer account is a row in THIS module
-- (`awcms_commerce_customer_accounts`), bound 1:1 to
-- `awcms_commerce_customers` (the existing guest row, Issue #29). There is
-- no `password_hash` column, ever, and no `identity_id`/`principal_id`
-- column linking it to `awcms_identities`/`awcms_principals` — a customer
-- account is not a second admin-side identity, and inventing that link
-- would let a storefront shopper masquerade as (or be confused with) a
-- tenant operator. `customer_id` is `UNIQUE` — one account per customer row,
-- one customer row per account.
--
-- ## D2 — OTP, not a password
--
-- Authentication is a 6-digit e-mail OTP, hashed (`code_hash`, never the
-- raw code — same discipline `awcms-sensitive-data` requires for every
-- secret), 10-minute TTL, 5 attempts, single use
-- (`domain/customer-otp.ts`). `awcms_commerce_customer_otps` carries a
-- `purpose` (`login`/`register`) because the SAME table serves both flows:
-- a `register` OTP additionally stashes the pending registration payload
-- (`registration jsonb` — name/phone, not yet a customer row until the code
-- is verified) so that no account/customer row is created until the e-mail
-- is actually proven to be reachable by whoever asked for it.
--
-- ## D3 — bearer sessions, not JWT
--
-- `awcms_commerce_customer_sessions` stores only `token_hash` (`sha256:`
-- prefixed, `domain/customer-session-token.ts` — a FRESH implementation,
-- not `src/lib/auth/session-token.ts`'s `hashSessionToken`: that dispatcher
-- is shape-precedent only, per Issue #87's own instructions, and mixing a
-- customer bearer into the admin-session hash namespace would let a
-- customer token be looked up in the wrong table by accident). 30-day
-- sliding TTL (`expires_at` advanced by `touchSession`), revoked on logout
-- (`revoked_at`). `client_ip_hash`/`user_agent_summary` are diagnostic only
-- (never a raw IP/UA string — `awcms-sensitive-data`'s masking discipline).
--
-- ## D4 — history_from (pure function, `resolveHistoryFrom`)
--
-- Registration requires name + phone + e-mail. If the phone already exists
-- as a guest customer row, the account BINDS to that row (reusing
-- `findOrCreateCustomerByPhone`'s own row, `application/customer-directory.ts`),
-- and `history_from` becomes that row's `created_at` ONLY IF the guest row's
-- e-mail equals the verified e-mail — otherwise `history_from = now()`. This
-- is an APPLICATION-layer decision (`domain/customer-account-validation.ts`'s
-- `resolveHistoryFrom`); the column here only stores the pure function's
-- result, `NOT NULL` because every account has an unambiguous starting point
-- for "since when do I show this shopper their own order history".
--
-- `deleted_at` is deliberately ABSENT from all three tables: an account is
-- blocked (`status = 'blocked'`), never soft-deleted (there is no admin
-- "restore a customer account" flow in this increment); an OTP/session
-- expires or is consumed/revoked — its own `expires_at`/`consumed_at`/
-- `revoked_at` IS the purge engine's cursor (`commerce:customer-auth:purge`,
-- `module.ts`).
--
-- `awcms_commerce_customer_accounts` DOES still carry a `deleted_at` column,
-- even though nothing in this module's own code ever sets it (a blocked
-- account is `status = 'blocked'`, never soft-deleted) — the same
-- "safe cursor even though it always stays NULL" trick `sql/913`'s
-- `awcms_commerce_orders` already uses (see that migration's header): it
-- exists ONLY so `module.ts`'s `dataLifecycle` descriptor has a real,
-- honest `cursorColumn` to declare (`data-lifecycle:table-coverage:check`
-- requires every table to answer the retention question), while the
-- predicate `deleted_at < $cutoff` can mathematically never match a row
-- that stays `NULL` forever.

CREATE TABLE IF NOT EXISTS awcms_commerce_customer_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  customer_id uuid NOT NULL REFERENCES awcms_commerce_customers (id),
  email_normalized text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  email_verified_at timestamptz,
  history_from timestamptz NOT NULL,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_customer_accounts_status_check
    CHECK (status IN ('active', 'blocked'))
);

-- One account per customer row, one customer row per account (D1).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_customer_accounts_customer_key
  ON awcms_commerce_customer_accounts (tenant_id, customer_id);

-- `email_normalized` (`lower(btrim(...))`, `domain/customer-account-validation.ts`)
-- is unique per tenant among LIVE accounts — "among live rows" here means
-- "among non-blocked" is NOT the qualifier: a blocked account still
-- legitimately owns its own e-mail forever, the same way a live catalog
-- row's unique key stays unique while merely inactive. The `WHERE` clause
-- is kept for symmetry with the rest of this schema's partial-unique
-- convention and because `deleted_at IS NULL` is the literal, honest
-- predicate for "a row that still exists" — this module's own code never
-- actually sets `deleted_at` (see the header), so the predicate is
-- trivially true for every row today.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_customer_accounts_email_key
  ON awcms_commerce_customer_accounts (tenant_id, email_normalized)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_customer_accounts_tenant_idx
  ON awcms_commerce_customer_accounts (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_customer_accounts_tenant_deleted_idx
  ON awcms_commerce_customer_accounts (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_customer_accounts_customer_idx
  ON awcms_commerce_customer_accounts (customer_id);

ALTER TABLE awcms_commerce_customer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_customer_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_customer_accounts_tenant_isolation
  ON awcms_commerce_customer_accounts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_customer_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  email_normalized text NOT NULL,
  purpose text NOT NULL,
  code_hash text NOT NULL,
  registration jsonb,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_customer_otps_purpose_check
    CHECK (purpose IN ('login', 'register')),
  CONSTRAINT awcms_commerce_customer_otps_attempts_check
    CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_customer_otps_tenant_idx
  ON awcms_commerce_customer_otps (tenant_id);

-- The lookup `issueOtp`/`consumeOtp` actually do: latest OTP for a given
-- tenant + e-mail (+ purpose, filtered in the WHERE clause of the query
-- itself since a two-purpose composite index would rarely be selective
-- enough to matter here).
CREATE INDEX IF NOT EXISTS awcms_commerce_customer_otps_email_created_idx
  ON awcms_commerce_customer_otps (tenant_id, email_normalized, created_at DESC);

-- The purge job's own cursor (`commerce:customer-auth:purge`) — every
-- expired OTP regardless of tenant, batched.
CREATE INDEX IF NOT EXISTS awcms_commerce_customer_otps_expires_idx
  ON awcms_commerce_customer_otps (expires_at);

ALTER TABLE awcms_commerce_customer_otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_customer_otps FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_customer_otps_tenant_isolation
  ON awcms_commerce_customer_otps
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_customer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  account_id uuid NOT NULL REFERENCES awcms_commerce_customer_accounts (id),
  token_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  client_ip_hash text,
  user_agent_summary text
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_customer_sessions_token_key
  ON awcms_commerce_customer_sessions (token_hash);

CREATE INDEX IF NOT EXISTS awcms_commerce_customer_sessions_tenant_idx
  ON awcms_commerce_customer_sessions (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_customer_sessions_tenant_account_idx
  ON awcms_commerce_customer_sessions (tenant_id, account_id);

-- The purge job's own cursor for expired (not merely revoked) sessions.
CREATE INDEX IF NOT EXISTS awcms_commerce_customer_sessions_expires_idx
  ON awcms_commerce_customer_sessions (expires_at);

ALTER TABLE awcms_commerce_customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_customer_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_customer_sessions_tenant_isolation
  ON awcms_commerce_customer_sessions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
