-- Issue #110 (epic #33, contract #106's D2/D3, ADR-0017) — payment-gateway
-- schema: a hosted-checkout session table, a replay-protected inbound-event
-- ledger (consumed by the webhook INTAKE route, #113, not this issue), and
-- the tenant-scoped webhook-endpoint tokens D2's bootstrap lookup resolves.
-- `orders` also gains two columns recording which gateway/reference paid it.
--
-- Same conventions as `sql/901`'s header (not repeated in full): `ENABLE` +
-- `FORCE ROW LEVEL SECURITY`, one tenant-isolation `USING` policy per table,
-- `id uuid` PK `DEFAULT gen_random_uuid()`, `created_at timestamptz DEFAULT
-- now()`, an index for every FK column.
--
-- ## `awcms_commerce_payment_gateway_sessions`
--
-- ONE row per hosted-checkout attempt. `application/payment-gateway-
-- directory.ts`'s `createGatewaySession` is the only writer: it validates the
-- order and checks for a still-live session in one short transaction, calls
-- the `PaymentGatewayProvider` port with NO transaction open, then persists
-- the result in a second short transaction. `UNIQUE (provider, provider_ref)`
-- is what makes a genuinely concurrent double-create safe — the loser's
-- `INSERT` hits `23505` and the directory re-fetches the winner's row rather
-- than 500ing (`ON CONFLICT` cannot be used here because the conflicting row
-- may belong to a DIFFERENT order under a rare `provider_ref` collision
-- across tenants, which must never silently attach the loser's order to the
-- winner's row — an explicit re-fetch by `provider_ref` catches exactly
-- "same order, same provider_ref" and nothing wider).
--
-- `provider_ref` is `${orderCode}-${attempt}` for the `midtrans` adapter
-- (unique per transaction attempt, never reused even for the same order) and
-- a colon-joined, self-describing string for the `log` adapter (see
-- `infrastructure/log-payment-gateway-provider.ts`). `status` mirrors
-- `PaymentGatewayStatus` (`domain/payment-gateway-provider.ts`): `created` is
-- the row's own initial value (before this migration's own consumers ever
-- see a provider status back), the rest come from a status-mapped provider
-- response.
--
-- ## `awcms_commerce_payment_events`
--
-- The replay-protection ledger contract #106's D2 specifies —
-- `UNIQUE (tenant_id, provider, event_key)` is the guard the webhook INTAKE
-- route (#113) will rely on to treat a redelivered callback as `outcome =
-- 'replay'` rather than double-applying it. This issue only ships the table;
-- nothing here writes to it yet.
--
-- ## `awcms_commerce_webhook_endpoints`
--
-- ONE row per (tenant, provider) endpoint an owner has minted. `token_hash`
-- is the ONLY thing this table ever stores about the secret — the plaintext
-- is generated, returned once, and discarded
-- (`application/webhook-endpoint-directory.ts`), the same discipline
-- `awcms_machine_credentials` already applies (`sql/119` era) to a
-- structurally identical secret.
--
-- ## `awcms_resolve_commerce_webhook_endpoint`
--
-- A SECURITY DEFINER bootstrap read, modelled EXACTLY on `sql/048`'s
-- `awcms_resolve_tenant_domain_lookup` — see that migration's own header for
-- the full "why this is safe under the hardened, role-separated posture"
-- reasoning, not repeated here. The webhook INTAKE route (#113) needs to
-- resolve `tenant_id`/`provider` from an opaque, hashed token BEFORE any
-- tenant context exists — the exact same bootstrap gap `sql/048` closes for
-- a hostname. This migration only adds the function; nothing in this issue's
-- own scope calls it outside its own unit test on the migration's SQL text
-- and the integration test's direct `SELECT` of it.

-- ---------------------------------------------------------------------------
-- awcms_commerce_payment_gateway_sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_payment_gateway_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL REFERENCES awcms_commerce_orders (id),
  provider text NOT NULL,
  provider_ref text NOT NULL,
  redirect_url text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  expires_at timestamptz NOT NULL,
  last_checked_at timestamptz,
  raw_status jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_payment_gateway_sessions_provider_check
    CHECK (provider IN ('midtrans', 'log')),
  CONSTRAINT awcms_commerce_payment_gateway_sessions_status_check
    CHECK (status IN ('created', 'pending', 'paid', 'expired', 'failed', 'refunded'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_payment_gateway_sessions_provider_ref_key
  ON awcms_commerce_payment_gateway_sessions (provider, provider_ref);

CREATE INDEX IF NOT EXISTS awcms_commerce_payment_gateway_sessions_tenant_idx
  ON awcms_commerce_payment_gateway_sessions (tenant_id);

-- `createGatewaySession`'s own "does a live session already exist for this
-- order" read, inside its first transaction.
CREATE INDEX IF NOT EXISTS awcms_commerce_payment_gateway_sessions_order_idx
  ON awcms_commerce_payment_gateway_sessions (tenant_id, order_id);

-- `data-lifecycle:table-coverage:check` requires an index covering both the
-- tenant column and this table's own cursor column (`expires_at`) —
-- `commerce/module.ts`'s `commerce.payment_gateway_sessions` descriptor.
CREATE INDEX IF NOT EXISTS awcms_commerce_payment_gateway_sessions_tenant_expires_idx
  ON awcms_commerce_payment_gateway_sessions (tenant_id, expires_at);

ALTER TABLE awcms_commerce_payment_gateway_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_payment_gateway_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_payment_gateway_sessions_tenant_isolation
  ON awcms_commerce_payment_gateway_sessions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `data-lifecycle:worker-grants:check` — `commerce/module.ts`'s
-- `commerce.payment_gateway_sessions` descriptor is `executionMode:
-- "generic"`/`deletion.mode: "hard_delete"`, so the generic archive/purge
-- engine (which runs as `awcms_worker`) must be able to SELECT candidates
-- and DELETE them, even though no scheduled job calls it yet in this
-- issue's own scope — sql/019's `ALTER DEFAULT PRIVILEGES` only ever
-- granted `awcms_app`.
GRANT SELECT, DELETE ON awcms_commerce_payment_gateway_sessions TO awcms_worker;

-- ---------------------------------------------------------------------------
-- awcms_commerce_payment_events
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  provider text NOT NULL,
  event_key text NOT NULL,
  provider_ref text NOT NULL,
  order_id uuid REFERENCES awcms_commerce_orders (id),
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL,
  CONSTRAINT awcms_commerce_payment_events_provider_check
    CHECK (provider IN ('midtrans', 'log')),
  CONSTRAINT awcms_commerce_payment_events_outcome_check
    CHECK (outcome IN ('applied', 'ignored', 'replay'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_payment_events_tenant_provider_event_key
  ON awcms_commerce_payment_events (tenant_id, provider, event_key);

CREATE INDEX IF NOT EXISTS awcms_commerce_payment_events_tenant_idx
  ON awcms_commerce_payment_events (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_payment_events_order_idx
  ON awcms_commerce_payment_events (order_id)
  WHERE order_id IS NOT NULL;

-- `data-lifecycle:table-coverage:check` requires an index covering both the
-- tenant column and this table's own cursor column (`received_at`) —
-- `commerce/module.ts`'s `commerce.payment_events` descriptor.
CREATE INDEX IF NOT EXISTS awcms_commerce_payment_events_tenant_received_idx
  ON awcms_commerce_payment_events (tenant_id, received_at);

ALTER TABLE awcms_commerce_payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_payment_events FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_payment_events_tenant_isolation
  ON awcms_commerce_payment_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Same `data-lifecycle:worker-grants:check` reasoning as above.
GRANT SELECT, DELETE ON awcms_commerce_payment_events TO awcms_worker;

-- ---------------------------------------------------------------------------
-- awcms_commerce_webhook_endpoints
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  provider text NOT NULL,
  token_hash text NOT NULL,
  label text,
  created_by uuid REFERENCES awcms_tenant_users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT awcms_commerce_webhook_endpoints_provider_check
    CHECK (provider IN ('midtrans'))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_webhook_endpoints_token_hash_key
  ON awcms_commerce_webhook_endpoints (token_hash);

CREATE INDEX IF NOT EXISTS awcms_commerce_webhook_endpoints_tenant_idx
  ON awcms_commerce_webhook_endpoints (tenant_id);

-- `db:fk-index:check` — every FK column needs an index reaching it; neither
-- awcms_commerce_webhook_endpoints_tenant_idx above nor the composite below
-- leads with created_by.
CREATE INDEX IF NOT EXISTS awcms_commerce_webhook_endpoints_created_by_idx
  ON awcms_commerce_webhook_endpoints (created_by);

-- `data-lifecycle:table-coverage:check` requires an index covering both the
-- tenant column and this table's own cursor column (`revoked_at`) —
-- `commerce/module.ts`'s `commerce.webhook_endpoints` descriptor.
CREATE INDEX IF NOT EXISTS awcms_commerce_webhook_endpoints_tenant_revoked_idx
  ON awcms_commerce_webhook_endpoints (tenant_id, revoked_at);

ALTER TABLE awcms_commerce_webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_webhook_endpoints FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_webhook_endpoints_tenant_isolation
  ON awcms_commerce_webhook_endpoints
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Same `data-lifecycle:worker-grants:check` reasoning as above.
GRANT SELECT, DELETE ON awcms_commerce_webhook_endpoints TO awcms_worker;

-- ---------------------------------------------------------------------------
-- orders — which gateway/reference paid this order, if any
-- ---------------------------------------------------------------------------

ALTER TABLE awcms_commerce_orders ADD COLUMN IF NOT EXISTS gateway_provider text;
ALTER TABLE awcms_commerce_orders ADD COLUMN IF NOT EXISTS gateway_ref text;

-- ---------------------------------------------------------------------------
-- awcms_resolve_commerce_webhook_endpoint — SECURITY DEFINER bootstrap read,
-- the same shape as sql/048's awcms_resolve_tenant_domain_lookup (see that
-- migration's header for the full safety reasoning). A dedicated NOLOGIN
-- owner role, an explicit scoped SELECT policy for that role only, a fixed
-- non-sensitive column list (never token_hash itself back out), and EXECUTE
-- restricted to awcms_app.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awcms_webhook_endpoint_bootstrap') THEN
    CREATE ROLE awcms_webhook_endpoint_bootstrap NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO awcms_webhook_endpoint_bootstrap;
GRANT SELECT ON awcms_commerce_webhook_endpoints TO awcms_webhook_endpoint_bootstrap;

CREATE POLICY awcms_commerce_webhook_endpoints_bootstrap_read
  ON awcms_commerce_webhook_endpoints
  FOR SELECT
  TO awcms_webhook_endpoint_bootstrap
  USING (true);

CREATE OR REPLACE FUNCTION awcms_resolve_commerce_webhook_endpoint(
  p_token_hash text
)
RETURNS TABLE (
  tenant_id uuid,
  provider text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT
    e.tenant_id,
    e.provider
  FROM awcms_commerce_webhook_endpoints AS e
  WHERE e.token_hash = p_token_hash
    AND e.revoked_at IS NULL;
$function$;

COMMENT ON FUNCTION awcms_resolve_commerce_webhook_endpoint(text) IS
  'Narrow SECURITY DEFINER bootstrap read for hashed-token -> (tenant_id, provider) lookup before tenant context exists, for the commerce payment-gateway webhook intake route (#113). Owned by the dedicated NOLOGIN awcms_webhook_endpoint_bootstrap role (NOT a superuser), which an explicit FOR SELECT TO awcms_webhook_endpoint_bootstrap USING (true) policy lets read awcms_commerce_webhook_endpoints under FORCE RLS; the same role has no login and no members, so nothing else can act as it. Returns only tenant_id/provider for a non-revoked token hash. Never returns token_hash, label, or created_by. EXECUTE restricted to awcms_app.';

REVOKE ALL ON FUNCTION awcms_resolve_commerce_webhook_endpoint(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION awcms_resolve_commerce_webhook_endpoint(text) TO awcms_app;

ALTER FUNCTION awcms_resolve_commerce_webhook_endpoint(text) OWNER TO awcms_webhook_endpoint_bootstrap;

-- ---------------------------------------------------------------------------
-- Permission catalog seed — commerce.webhook_endpoints.update gates list,
-- create, and revoke alike (contract #106's own OpenAPI note: ONE permission
-- key for the whole owner surface). No `read`-only split: an owner who may
-- see a masked list may also mint/revoke, since the token itself never
-- appears in the list either way (mirrors sql/922's own reasoning for not
-- seeding a permission with nothing distinct to enforce).
-- ---------------------------------------------------------------------------

INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'webhook_endpoints', 'update', 'List, create, and revoke this tenant''s commerce webhook-endpoint tokens')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;

COMMENT ON TABLE awcms_commerce_payment_gateway_sessions IS
  'Issue #110 (contract #106 D3) — one row per hosted-checkout attempt for a gateway-payment order; UNIQUE (provider, provider_ref) makes a concurrent double-create safe.';
COMMENT ON TABLE awcms_commerce_payment_events IS
  'Issue #110/#113 (contract #106 D2) — replay-protection ledger for inbound provider webhooks; UNIQUE (tenant_id, provider, event_key).';
COMMENT ON TABLE awcms_commerce_webhook_endpoints IS
  'Issue #110 (contract #106 D2) — tenant-scoped, hashed opaque tokens addressing the public webhook intake route; the plaintext is shown once at creation and never stored.';
