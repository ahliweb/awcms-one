-- Issue #288 (epic #281, ADR-0030) — closed-loop stored value: gift cards and
-- store credit as a LIABILITY ledger. Migrations 985-989 are this issue's
-- slice of the reserved commerce 9xx range (ADR-0015): 985 (this file) the
-- three tables and their guards, 986 the payment-ledger integration, 987 the
-- permission catalog, 988 the retention worker's grants; 989 is held and
-- unused.
--
-- Same conventions as `sql/901`/`sql/936`/`sql/940`/`sql/970` (not repeated in
-- full): ENABLE + FORCE ROW LEVEL SECURITY with one tenant-isolation policy
-- (`USING` + `WITH CHECK`), `id uuid` PK `DEFAULT gen_random_uuid()`,
-- `numeric(14,2)` money (ADR-0003), an index for every FK column, `text` +
-- `CHECK` for every enumerated column, composite `(tenant_id, …)` foreign keys
-- backed by `UNIQUE (tenant_id, id)`.
--
-- ## What this is, and what it is not
--
-- A gift card or a store credit is a promise by the tenant to deliver goods
-- later: money received (or a refund kept) that is NOT yet revenue. This is a
-- ledger of that liability. It is deliberately:
--
--   * CLOSED-LOOP: value can be redeemed ONLY as a tender against this
--     tenant's own orders (`sql/986` adds the `gift_card`/`store_credit`
--     tender types to the payment-allocation ledger). There is no cash-out,
--     no transfer between accounts and no withdrawal — not even a column that
--     could model one. Converting value to cash is a legal/business decision
--     (see ADR-0030 on the e-money boundary) that a future, separately
--     reviewed feature may take; this schema cannot express it.
--   * SEPARATE from loyalty points (#289) and from vouchers/discounts: those
--     are marketing mechanics that reduce a price; this is money owed.
--
-- ## Three tables
--
--   * `awcms_commerce_stored_value_programs` — per-tenant configuration, one
--     row per kind (`gift_card`, `store_credit`): enabled, default expiry in
--     days, whether a refund may go back to the card, an optional balance cap.
--   * `awcms_commerce_stored_value_accounts` — one row per card/credit. The
--     redeemable CODE is never stored: only `code_hash` (sha256 over a
--     tenant-scoped domain string and the normalised code, `sha256:`-prefixed
--     like a customer session token — ADR-0016 D3) and `code_last4` for
--     display. `balance`/`version`/`status` are a PROJECTION of the ledger.
--   * `awcms_commerce_stored_value_ledger` — the append-only facts.
--
-- ## The ledger is the truth; the projection is maintained by the DATABASE
--
-- Every change to a balance is one ledger row, and the BEFORE INSERT trigger
-- `awcms_commerce_stored_value_ledger_apply` is the ONLY thing that moves
-- `balance`/`version`/`status` on the account: it locks the account row
-- (`FOR NO KEY UPDATE`), validates the entry against the account's state and
-- the sign of its kind, refuses anything that would take the balance below
-- zero, assigns the per-account `account_seq` and the running `balance_after`,
-- and updates the projection — all in the inserting transaction. A second
-- guard (`awcms_commerce_stored_value_accounts_guard`) refuses an UPDATE of
-- those columns from anywhere except that trigger (`pg_trigger_depth()`),
-- save for writing `balance`/`version` to exactly what the ledger sums to
-- (a no-op for a consistent account, and what reconcile's repair does), so
-- application code, a script or a bug cannot edit a balance directly.
-- Overdraw is therefore impossible even for a writer that skipped every
-- application check.
--
-- `FOR NO KEY UPDATE`, not `FOR UPDATE` (ADR-0025 D4): an insert that has a
-- foreign key to the account (a payment-allocation row, a ledger row) takes
-- `FOR KEY SHARE` on it, which `FOR UPDATE` conflicts with — two concurrent
-- redemptions that each inserted their allocation first would deadlock.
--
-- ## Append-only, mechanically
--
--   * `awcms_app` loses UPDATE and DELETE on the ledger (the REVOKE at the
--     bottom — `sql/019` granted all four verbs on every table), and a trigger
--     refuses every UPDATE for any role. A correction is a NEW `adjust` row.
--   * An account can never be deleted by `awcms_app`; its identity columns
--     (code hash, kind, program, customer, expiry, issuer) are frozen.
--   * `awcms_worker` keeps SELECT + DELETE (`sql/988`) only for the
--     data-lifecycle engine's ten-year ceiling.
--
-- ## Entry kinds and signs
--
--   issue    > 0   the first entry of an account (exactly one per account)
--   load     > 0   a top-up
--   redeem   < 0   a tender against an order (`allocation_id` required)
--   refund   > 0   a payment-allocation REVERSAL returning value to the
--                  account it came from (`allocation_id` required)
--   adjust   <> 0  a reasoned manual correction (reason required)
--   expire   <= 0  the account lapsed: the whole remaining balance is
--                  released; a zero marker records the lapse of an empty one
--   disable  = 0   a status marker: redemption blocked, balance kept as
--                  liability
--   enable   = 0   disable undone
--
-- `expired` is terminal: no entry of any kind follows it. Releasing a
-- liability is not undone by a script; a goodwill replacement is a new
-- account (an `issue`), which keeps the lapse visible in the books.
--
-- ## Tenant-safe references
--
-- Every reference is a composite FK on `(tenant_id, …)`: ledger -> account,
-- ledger -> payment allocation, account -> program (also pinning the kind via
-- `(tenant_id, id, kind)`), account -> customer. Even an application bug, or a
-- caller holding a credential that bypasses RLS, cannot attach one tenant's
-- entry to another tenant's account.
--
-- ## Retention
--
-- The purge engine deletes whole rows older than a cursor (ten-year ceiling,
-- five-year floor — the fiscal horizon `commerce.payment_allocations` uses).
-- Ledger rows are keyed on `created_at`; accounts and programs on `deleted_at`,
-- which the guard below forbids ever setting, so a live liability is
-- unreachable. The honest consequence is recorded in ADR-0030: an account
-- whose earliest history is purged past the ceiling no longer sums to its
-- projection, and reconcile reports it.

-- A composite-FK target on customers (the loyalty schema, `sql/950`, creates
-- the same index under the same name; IF NOT EXISTS makes the two orders of
-- application equivalent).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_customers_tenant_id_id_key
  ON awcms_commerce_customers (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Programs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_stored_value_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  kind text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  -- Default lifetime of an account issued under this program, counted from
  -- issue; NULL = never expires. A single account may carry its own expiry.
  expiry_days integer,
  -- Whether a reversal of a payment made with this kind of value may return
  -- the value to the account it came from. When false, such a payment cannot
  -- be reversed at all (there is deliberately no cash alternative).
  allow_refund_to_account boolean NOT NULL DEFAULT true,
  -- Optional ceiling on an account's balance (a single-card exposure and
  -- laundering limit). Does not apply to a refund (which only restores value
  -- the account already held).
  max_balance numeric(14, 2),
  updated_by_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_stored_value_programs_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_stored_value_programs_tenant_id_id_kind_key
    UNIQUE (tenant_id, id, kind),
  CONSTRAINT awcms_commerce_stored_value_programs_tenant_kind_key
    UNIQUE (tenant_id, kind),
  CONSTRAINT awcms_commerce_stored_value_programs_kind_check
    CHECK (kind IN ('gift_card', 'store_credit')),
  CONSTRAINT awcms_commerce_stored_value_programs_expiry_check
    CHECK (expiry_days IS NULL OR expiry_days BETWEEN 1 AND 3650),
  CONSTRAINT awcms_commerce_stored_value_programs_max_balance_check
    CHECK (max_balance IS NULL OR max_balance > 0)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_programs_tenant_idx
  ON awcms_commerce_stored_value_programs (tenant_id);

-- The (tenant, cursor) composite the generic purge engine filters + orders by.
CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_programs_tenant_deleted_idx
  ON awcms_commerce_stored_value_programs (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_stored_value_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_stored_value_programs FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_stored_value_programs_tenant_isolation
  ON awcms_commerce_stored_value_programs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- A program is configuration, never deleted by the runtime role; its kind is
-- fixed and `deleted_at` (the retention engine's cursor only) is never set.
REVOKE DELETE ON awcms_commerce_stored_value_programs FROM awcms_app;

-- The BEGIN/END below are PL/pgSQL block delimiters inside a dollar-quoted
-- body, not transaction control — `sql/033`'s precedent (the migration runner
-- strips dollar-quoted blocks before its transaction-control scan).
CREATE OR REPLACE FUNCTION awcms_commerce_stored_value_programs_guard()
RETURNS trigger AS $awcms_commerce_stored_value_programs_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_stored_value_programs row % : kind and deleted_at are fixed (a program is configured, never re-kinded or removed)',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_stored_value_programs_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_stored_value_programs_guard
  ON awcms_commerce_stored_value_programs;
CREATE TRIGGER awcms_commerce_stored_value_programs_guard
  BEFORE UPDATE ON awcms_commerce_stored_value_programs
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_stored_value_programs_guard();

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_stored_value_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  program_id uuid NOT NULL,
  kind text NOT NULL,
  -- `sha256:` + hex over "awcms.stored_value.v1|<tenant id>|<normalised code>".
  -- The plaintext is NEVER stored; it exists only in the response to the
  -- issuing request (and on the receipt the operator prints from it).
  code_hash text NOT NULL,
  -- The last four characters of the normalised code, for display and for an
  -- operator to find a card ("…K7QX"). Four of the twenty-one characters.
  code_last4 text NOT NULL,
  -- Optional ownership/reference. Informational: the code is a bearer
  -- instrument and redemption does not require the customer (ADR-0030).
  customer_id uuid,
  status text NOT NULL DEFAULT 'active',
  -- PROJECTION of the ledger, moved only by the ledger's own trigger.
  balance numeric(14, 2) NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0,
  expires_at timestamptz,
  issued_by_tenant_user_id uuid,
  last_activity_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_stored_value_accounts_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_stored_value_accounts_program_fk
    FOREIGN KEY (tenant_id, program_id, kind)
    REFERENCES awcms_commerce_stored_value_programs (tenant_id, id, kind),
  CONSTRAINT awcms_commerce_stored_value_accounts_customer_fk
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES awcms_commerce_customers (tenant_id, id),
  CONSTRAINT awcms_commerce_stored_value_accounts_kind_check
    CHECK (kind IN ('gift_card', 'store_credit')),
  CONSTRAINT awcms_commerce_stored_value_accounts_status_check
    CHECK (status IN ('active', 'disabled', 'expired')),
  CONSTRAINT awcms_commerce_stored_value_accounts_balance_check
    CHECK (balance >= 0),
  CONSTRAINT awcms_commerce_stored_value_accounts_version_check
    CHECK (version >= 0 AND (version > 0 OR balance = 0)),
  CONSTRAINT awcms_commerce_stored_value_accounts_code_hash_check
    CHECK (code_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT awcms_commerce_stored_value_accounts_code_last4_check
    CHECK (char_length(code_last4) = 4)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_stored_value_accounts_code_hash_key
  ON awcms_commerce_stored_value_accounts (tenant_id, code_hash);

CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_accounts_tenant_idx
  ON awcms_commerce_stored_value_accounts (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_accounts_program_idx
  ON awcms_commerce_stored_value_accounts (program_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_accounts_customer_idx
  ON awcms_commerce_stored_value_accounts (customer_id)
  WHERE customer_id IS NOT NULL;

-- The admin list (newest first) and its kind/status filters.
CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_accounts_tenant_created_idx
  ON awcms_commerce_stored_value_accounts (tenant_id, created_at DESC, id DESC);

-- The expiry sweep's scan: accounts that can still lapse.
CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_accounts_expiry_idx
  ON awcms_commerce_stored_value_accounts (tenant_id, expires_at)
  WHERE expires_at IS NOT NULL AND status <> 'expired';

-- The (tenant, cursor) composite the generic purge engine filters + orders by.
CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_accounts_tenant_deleted_idx
  ON awcms_commerce_stored_value_accounts (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_stored_value_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_stored_value_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_stored_value_accounts_tenant_isolation
  ON awcms_commerce_stored_value_accounts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_stored_value_accounts FROM awcms_app;

-- An account is created empty and active; its first ledger entry (`issue`)
-- is written in the same transaction (the deferred check below).
CREATE OR REPLACE FUNCTION awcms_commerce_stored_value_accounts_insert_guard()
RETURNS trigger AS $awcms_commerce_stored_value_accounts_insert_guard$
BEGIN
  IF NEW.balance <> 0 OR NEW.version <> 0 OR NEW.status <> 'active'
    OR NEW.deleted_at IS NOT NULL OR NEW.last_activity_at IS NOT NULL
  THEN
    RAISE EXCEPTION
      'a stored-value account is created empty and active; its value arrives through an issue ledger entry'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_stored_value_accounts_insert_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_stored_value_accounts_insert_guard
  ON awcms_commerce_stored_value_accounts;
CREATE TRIGGER awcms_commerce_stored_value_accounts_insert_guard
  BEFORE INSERT ON awcms_commerce_stored_value_accounts
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_stored_value_accounts_insert_guard();

-- The projection (`balance`, `version`, `status`, `last_activity_at`,
-- `updated_at`) may change only from inside the ledger's own trigger
-- (`pg_trigger_depth() >= 2`: this trigger fires for the UPDATE the ledger
-- trigger issues), or — for `balance`/`version` ONLY — when the new values
-- are EXACTLY what the account's ledger sums to (`SUM(amount)`, `COUNT(*)`,
-- read under the row lock this UPDATE already holds): the reconcile repair
-- needs no switch, and a wrong value — however it got there — is refused.
-- Identity columns are frozen unconditionally. (No GUC is involved: a
-- migration reads only `app.current_tenant_id`, see
-- `tests/migration-tenant-guc-consistency.test.ts`.)
CREATE OR REPLACE FUNCTION awcms_commerce_stored_value_accounts_guard()
RETURNS trigger AS $awcms_commerce_stored_value_accounts_guard$
DECLARE
  ledger_total numeric(14, 2);
  ledger_count bigint;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.program_id IS DISTINCT FROM OLD.program_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.code_hash IS DISTINCT FROM OLD.code_hash
    OR NEW.code_last4 IS DISTINCT FROM OLD.code_last4
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.issued_by_tenant_user_id IS DISTINCT FROM OLD.issued_by_tenant_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_stored_value_accounts row %: its identity (code, kind, program, customer, expiry, issuer) is fixed once issued',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF pg_trigger_depth() < 2 THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.last_activity_at IS DISTINCT FROM OLD.last_activity_at
    THEN
      RAISE EXCEPTION
        'awcms_commerce_stored_value_accounts row %: status changes only through a ledger entry',
        OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.balance IS DISTINCT FROM OLD.balance
      OR NEW.version IS DISTINCT FROM OLD.version
    THEN
      SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO ledger_total, ledger_count
      FROM awcms_commerce_stored_value_ledger
      WHERE tenant_id = OLD.tenant_id AND account_id = OLD.id;
      IF NEW.balance <> ledger_total OR NEW.version <> ledger_count THEN
        RAISE EXCEPTION
          'awcms_commerce_stored_value_accounts row %: balance is a projection of the ledger and changes only through a ledger entry (or to exactly what the ledger sums to)',
          OLD.id
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$awcms_commerce_stored_value_accounts_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_stored_value_accounts_guard
  ON awcms_commerce_stored_value_accounts;
CREATE TRIGGER awcms_commerce_stored_value_accounts_guard
  BEFORE UPDATE ON awcms_commerce_stored_value_accounts
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_stored_value_accounts_guard();

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_stored_value_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  account_id uuid NOT NULL,
  kind text NOT NULL,
  -- Signed: the change to the account's balance.
  amount numeric(14, 2) NOT NULL,
  -- Assigned by the trigger, under the account lock: the per-account order of
  -- facts (no reliance on timestamps) and the running balance after this one.
  account_seq bigint NOT NULL,
  balance_after numeric(14, 2) NOT NULL,
  -- The payment-allocation row this entry mirrors (`redeem` <-> the payment
  -- leg; `refund` <-> its reversal), NULL for every other kind.
  allocation_id uuid,
  reason text,
  source_key text NOT NULL,
  actor_kind text NOT NULL,
  actor_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Insertion order across the table (a deterministic tiebreak for exports).
  entry_seq bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT awcms_commerce_stored_value_ledger_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_stored_value_ledger_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES awcms_commerce_stored_value_accounts (tenant_id, id),
  CONSTRAINT awcms_commerce_stored_value_ledger_allocation_fk
    FOREIGN KEY (tenant_id, allocation_id)
    REFERENCES awcms_commerce_payment_allocations (tenant_id, id),
  CONSTRAINT awcms_commerce_stored_value_ledger_kind_check
    CHECK (kind IN ('issue', 'load', 'redeem', 'refund', 'adjust', 'expire', 'disable', 'enable')),
  CONSTRAINT awcms_commerce_stored_value_ledger_sign_check
    CHECK (
      (kind IN ('issue', 'load', 'refund') AND amount > 0)
      OR (kind = 'redeem' AND amount < 0)
      OR (kind = 'adjust' AND amount <> 0)
      OR (kind = 'expire' AND amount <= 0)
      OR (kind IN ('disable', 'enable') AND amount = 0)
    ),
  CONSTRAINT awcms_commerce_stored_value_ledger_allocation_kind_check
    CHECK ((kind IN ('redeem', 'refund')) = (allocation_id IS NOT NULL)),
  CONSTRAINT awcms_commerce_stored_value_ledger_balance_after_check
    CHECK (balance_after >= 0),
  CONSTRAINT awcms_commerce_stored_value_ledger_seq_check
    CHECK (account_seq >= 1),
  -- A manual correction and a status change say why.
  CONSTRAINT awcms_commerce_stored_value_ledger_reason_required_check
    CHECK (kind NOT IN ('adjust', 'disable') OR reason IS NOT NULL),
  CONSTRAINT awcms_commerce_stored_value_ledger_reason_check
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT awcms_commerce_stored_value_ledger_source_key_check
    CHECK (char_length(source_key) BETWEEN 1 AND 255),
  CONSTRAINT awcms_commerce_stored_value_ledger_actor_check
    CHECK (
      (actor_kind = 'tenant_user' AND actor_tenant_user_id IS NOT NULL)
      OR (actor_kind = 'system' AND actor_tenant_user_id IS NULL)
    )
);

-- Row-level idempotency: one entry per source key per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_stored_value_ledger_source_key
  ON awcms_commerce_stored_value_ledger (tenant_id, source_key);

-- The per-account order is a fact, never ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_stored_value_ledger_account_seq_key
  ON awcms_commerce_stored_value_ledger (account_id, account_seq);

-- One issue entry per account; one entry per allocation row.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_stored_value_ledger_issue_key
  ON awcms_commerce_stored_value_ledger (account_id)
  WHERE kind = 'issue';

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_stored_value_ledger_allocation_key
  ON awcms_commerce_stored_value_ledger (tenant_id, allocation_id)
  WHERE allocation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_ledger_tenant_idx
  ON awcms_commerce_stored_value_ledger (tenant_id);

-- An account's own history (keyset, oldest first / newest first).
CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_ledger_tenant_account_idx
  ON awcms_commerce_stored_value_ledger (tenant_id, account_id, account_seq);

CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_ledger_allocation_fk_idx
  ON awcms_commerce_stored_value_ledger (allocation_id)
  WHERE allocation_id IS NOT NULL;

-- The liability report's range scan, and the (tenant, cursor) composite the
-- generic purge engine requires.
CREATE INDEX IF NOT EXISTS awcms_commerce_stored_value_ledger_tenant_created_idx
  ON awcms_commerce_stored_value_ledger (tenant_id, created_at);

ALTER TABLE awcms_commerce_stored_value_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_stored_value_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_stored_value_ledger_tenant_isolation
  ON awcms_commerce_stored_value_ledger
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only: no UPDATE for any role (the REVOKE below makes it a privilege
-- error for `awcms_app` too; this trigger covers every other role).
CREATE OR REPLACE FUNCTION awcms_commerce_stored_value_ledger_append_only()
RETURNS trigger AS $awcms_commerce_stored_value_ledger_append_only$
BEGIN
  RAISE EXCEPTION
    'awcms_commerce_stored_value_ledger row % is append-only (a correction is a new adjust entry)',
    OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$awcms_commerce_stored_value_ledger_append_only$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_stored_value_ledger_append_only
  ON awcms_commerce_stored_value_ledger;
CREATE TRIGGER awcms_commerce_stored_value_ledger_append_only
  BEFORE UPDATE ON awcms_commerce_stored_value_ledger
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_stored_value_ledger_append_only();

REVOKE UPDATE, DELETE ON awcms_commerce_stored_value_ledger FROM awcms_app;

-- The single writer of the projection. See the header; every rule is here so
-- that NO caller can bypass it.
CREATE OR REPLACE FUNCTION awcms_commerce_stored_value_ledger_apply()
RETURNS trigger AS $awcms_commerce_stored_value_ledger_apply$
DECLARE
  acct awcms_commerce_stored_value_accounts%ROWTYPE;
  alloc awcms_commerce_payment_allocations%ROWTYPE;
  cap numeric(14, 2);
  now_ts timestamptz := clock_timestamp();
  lapsed boolean;
  usable boolean;
  next_balance numeric(14, 2);
  next_status text;
BEGIN
  SELECT * INTO acct
  FROM awcms_commerce_stored_value_accounts
  WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stored-value account % not found', NEW.account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  lapsed := acct.expires_at IS NOT NULL AND acct.expires_at <= now_ts;
  usable := acct.status = 'active' AND NOT lapsed;
  next_status := acct.status;

  IF acct.status = 'expired' THEN
    RAISE EXCEPTION 'stored-value account % has expired; no entry may follow an expiry', acct.id
      USING ERRCODE = 'restrict_violation', HINT = 'STORED_VALUE_ACCOUNT_EXPIRED';
  END IF;

  CASE NEW.kind
    WHEN 'issue' THEN
      IF acct.version <> 0 THEN
        RAISE EXCEPTION 'an account is issued once, as its first entry'
          USING ERRCODE = 'restrict_violation';
      END IF;
    WHEN 'load', 'redeem', 'refund' THEN
      IF NOT usable THEN
        RAISE EXCEPTION 'stored-value account % is not usable (status %, lapsed %)',
          acct.id, acct.status, lapsed
          USING ERRCODE = 'restrict_violation', HINT = 'STORED_VALUE_ACCOUNT_UNAVAILABLE';
      END IF;
    WHEN 'adjust' THEN
      IF NOT (acct.status = 'disabled' OR usable) THEN
        RAISE EXCEPTION 'stored-value account % cannot be adjusted (status %, lapsed %)',
          acct.id, acct.status, lapsed
          USING ERRCODE = 'restrict_violation', HINT = 'STORED_VALUE_ACCOUNT_UNAVAILABLE';
      END IF;
    WHEN 'expire' THEN
      IF NOT lapsed THEN
        RAISE EXCEPTION 'stored-value account % has not reached its expiry', acct.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF NEW.amount <> -acct.balance THEN
        RAISE EXCEPTION 'an expiry releases the whole remaining balance (%), not %', acct.balance, -NEW.amount
          USING ERRCODE = 'restrict_violation';
      END IF;
      next_status := 'expired';
    WHEN 'disable' THEN
      IF acct.status <> 'active' THEN
        RAISE EXCEPTION 'only an active account can be disabled (status %)', acct.status
          USING ERRCODE = 'restrict_violation';
      END IF;
      next_status := 'disabled';
    WHEN 'enable' THEN
      IF acct.status <> 'disabled' THEN
        RAISE EXCEPTION 'only a disabled account can be enabled (status %)', acct.status
          USING ERRCODE = 'restrict_violation';
      END IF;
      next_status := 'active';
  END CASE;

  -- A redemption / refund mirrors exactly one payment-allocation row, of the
  -- same tender and the same amount, written earlier in this transaction.
  IF NEW.kind IN ('redeem', 'refund') THEN
    SELECT * INTO alloc
    FROM awcms_commerce_payment_allocations
    WHERE tenant_id = NEW.tenant_id AND id = NEW.allocation_id;
    IF NOT FOUND
      OR alloc.stored_value_account_id IS DISTINCT FROM NEW.account_id
      OR alloc.tender_type IS DISTINCT FROM acct.kind
      OR alloc.status <> 'succeeded'
      OR (NEW.kind = 'redeem' AND (alloc.kind <> 'payment' OR NEW.amount <> -alloc.amount))
      OR (NEW.kind = 'refund' AND (alloc.kind <> 'reversal' OR NEW.amount <> alloc.amount))
    THEN
      RAISE EXCEPTION
        'a % entry must mirror a succeeded payment-allocation row of the same account, tender and amount',
        NEW.kind
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  next_balance := acct.balance + NEW.amount;
  IF next_balance < 0 THEN
    RAISE EXCEPTION 'insufficient stored value: balance % cannot cover %', acct.balance, -NEW.amount
      USING ERRCODE = 'check_violation', HINT = 'STORED_VALUE_INSUFFICIENT';
  END IF;

  IF NEW.kind IN ('issue', 'load', 'adjust') AND NEW.amount > 0 THEN
    SELECT max_balance INTO cap
    FROM awcms_commerce_stored_value_programs
    WHERE tenant_id = acct.tenant_id AND id = acct.program_id;
    IF cap IS NOT NULL AND next_balance > cap THEN
      RAISE EXCEPTION 'balance % would exceed the program ceiling %', next_balance, cap
        USING ERRCODE = 'check_violation', HINT = 'STORED_VALUE_BALANCE_CEILING';
    END IF;
  END IF;

  NEW.account_seq := acct.version + 1;
  NEW.balance_after := next_balance;
  NEW.created_at := now_ts;

  UPDATE awcms_commerce_stored_value_accounts
  SET balance = next_balance,
      version = acct.version + 1,
      status = next_status,
      last_activity_at = now_ts,
      updated_at = now_ts
  WHERE tenant_id = acct.tenant_id AND id = acct.id;

  RETURN NEW;
END;
$awcms_commerce_stored_value_ledger_apply$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_stored_value_ledger_apply
  ON awcms_commerce_stored_value_ledger;
CREATE TRIGGER awcms_commerce_stored_value_ledger_apply
  BEFORE INSERT ON awcms_commerce_stored_value_ledger
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_stored_value_ledger_apply();

-- An account that exists at COMMIT has its `issue` entry: a deferred check,
-- so the account row can be inserted first and the entry second inside one
-- transaction, but neither can ever be left without the other.
CREATE OR REPLACE FUNCTION awcms_commerce_stored_value_accounts_issue_check()
RETURNS trigger AS $awcms_commerce_stored_value_accounts_issue_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM awcms_commerce_stored_value_ledger
    WHERE tenant_id = NEW.tenant_id AND account_id = NEW.id AND kind = 'issue'
  ) THEN
    RAISE EXCEPTION 'stored-value account % has no issue ledger entry', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$awcms_commerce_stored_value_accounts_issue_check$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_stored_value_accounts_issue_check
  ON awcms_commerce_stored_value_accounts;
CREATE CONSTRAINT TRIGGER awcms_commerce_stored_value_accounts_issue_check
  AFTER INSERT ON awcms_commerce_stored_value_accounts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_stored_value_accounts_issue_check();

COMMENT ON TABLE awcms_commerce_stored_value_programs IS
  'Issue #288 (ADR-0030) — per-tenant configuration of one kind of closed-loop stored value (gift_card | store_credit).';
COMMENT ON TABLE awcms_commerce_stored_value_accounts IS
  'Issue #288 (ADR-0030) — one gift card / store credit. The redeemable code is NEVER stored (code_hash + code_last4 only). balance/version/status are a projection of the ledger, moved only by the ledger trigger.';
COMMENT ON TABLE awcms_commerce_stored_value_ledger IS
  'Issue #288 (ADR-0030) — append-only liability ledger of closed-loop stored value; every balance change is one signed row; the trigger awcms_commerce_stored_value_ledger_apply is the single writer of the account projection.';
COMMENT ON COLUMN awcms_commerce_stored_value_accounts.code_hash IS
  'sha256: over "awcms.stored_value.v1|<tenant id>|<normalised code>". The plaintext code is returned once at issue time and never stored or logged.';
COMMENT ON COLUMN awcms_commerce_stored_value_ledger.source_key IS
  'Row-level idempotency key, unique per tenant: issue:{key}, load:{key}, adjust:{key}, status:{key}, redeem:{allocation source key}, refund:{allocation source key}, expire:{account id}:{expiry epoch ms}.';
