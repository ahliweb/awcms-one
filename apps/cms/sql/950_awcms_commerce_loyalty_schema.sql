-- Issue #289 (epic #281, OSPOS-inspired capability set) — loyalty & rewards:
-- `awcms_commerce_loyalty_programs`, `awcms_commerce_loyalty_accounts`,
-- `awcms_commerce_loyalty_ledger`. First migration of the 950-954 range this
-- issue reserves inside the commerce 9xx block (ADR-0015); see ADR-0026 in
-- awcms-one for the decisions summarised here.
--
-- ## The ledger is the truth, the account row is a projection
--
-- Points are not a mutable "points" column on a customer. Every change to a
-- customer's balance is one append-only row in `awcms_commerce_loyalty_ledger`;
-- `awcms_commerce_loyalty_accounts.balance` is a PROJECTION of that ledger
-- (`balance = SUM(ledger.points)`), kept in the SAME transaction as each ledger
-- insert under a `FOR UPDATE` lock on the account row, so two concurrent
-- redemptions queue up behind each other and can never overdraw
-- (`application/loyalty-ledger.ts`'s `appendLedgerEntry` is the only writer).
-- A reconcile pass (`commerce:loyalty:reconcile`, and
-- `POST /api/v1/commerce/loyalty/reconcile`) recomputes the sum from the ledger,
-- verifies every row's running `balance_after`, reports drift, and — on an
-- explicit repair request only — rewrites the PROJECTION, never the ledger.
--
-- Points are INTEGERS (`bigint`, bounded well inside JavaScript's safe-integer
-- range by `awcms_commerce_loyalty_ledger_points_range`) — never a float and
-- never money. The earn rule turns an exact `numeric(14,2)` spend into points
-- with integer-cent arithmetic and an explicit FLOOR rounding rule
-- (`domain/loyalty-earn.ts`); a loyalty point is not store credit or a
-- gift-card value (those are separate ledgers, #288).
--
-- ## Programs are versions with effective dates
--
-- A row of `awcms_commerce_loyalty_programs` is one immutable-once-active rule
-- VERSION (`version` is per-tenant and monotonic). `effective_from` /
-- `effective_to` bound when it applies; an earn resolves the version effective
-- at the order's `paid_at` and records its id on the ledger row, so changing
-- the rules later never rewrites history. At most one version is `active` and
-- open at a time — enforced by the activate transaction under a per-tenant
-- advisory lock (`application/loyalty-program-directory.ts`), not by an
-- exclusion constraint (that would need the `btree_gist` extension, which this
-- schema does not otherwise depend on).
--
-- ## Idempotency and tenant-safe references
--
-- Every ledger row carries a per-tenant UNIQUE `idempotency_key`
-- (`earn:order:<orderId>`, `reversal:order:<orderId>`, `expire:<lotEntryId>`,
-- `redeem:<accountId>:<clientKey>`, `adjust:<accountId>:<clientKey>`), so an
-- event replayed, a job re-run or a client retry can never create a second
-- row. Two further partial unique indexes make the structural cases
-- impossible independently of the key: one `reversal` per original entry, one
-- `expire` marker per earn lot.
--
-- References inside this feature are COMPOSITE `(tenant_id, id)` foreign keys,
-- so a row can never point at another tenant's program/account/entry even by a
-- bug in the application layer. That needs `(tenant_id, id)` to be unique on
-- the referenced table; `awcms_commerce_customers` did not have that index yet,
-- so it is added here (additive, `id` is already globally unique). The order a
-- row came from is carried as `source_id uuid` WITHOUT a foreign key on
-- purpose: the ledger must outlive an order that is later purged, and the
-- order is an event source, not an ownership parent.
--
-- ## Append-only, enforced below the application
--
-- * a trigger rejects every UPDATE of a ledger row (no legitimate path exists:
--   corrections are compensating rows);
-- * `awcms_app` is REVOKEd UPDATE and DELETE on the ledger. The only DELETE
--   path is the data-lifecycle retention purge run as `awcms_worker`
--   (`sql/951`), with a five-year floor and a ten-year default
--   (`commerce/module.ts`'s three loyalty `dataLifecycle` descriptors).
--
-- ## Retention, and why the purge cannot orphan anything
--
-- The generic purge engine deletes whole rows older than a cursor. Each table's
-- cursor is chosen so a purge can only ever remove something that is already
-- dead:
--
--   ledger    `created_at`  — rows past the retention window. A `reversal`
--                             references the earn it compensates, so that FK is
--                             `ON DELETE CASCADE`: the pair always goes together
--                             even if a purge batch splits them.
--   accounts  `updated_at`  — an account untouched for the whole window (its
--                             last ledger row is at most that old, so the ledger
--                             purge removes its history first; the account FK is
--                             RESTRICT, so a pass that races ahead simply fails
--                             that batch and succeeds on the next run).
--   programs  `effective_to`— only RETIRED versions older than the window. A
--                             draft or the open active version has
--                             `effective_to IS NULL`, which never satisfies
--                             `< cutoff`, so a live rule is unreachable.
--
-- The one honest consequence: an ACTIVE account whose earliest history is
-- purged no longer sums to its projection, and `reconcile` reports it. Ten
-- years is long enough that this is a deliberate operator choice, not a
-- surprise (see ADR-0026).
--
-- ## Roles
--
-- `awcms_app` receives its verbs from migration 019's default privileges (then
-- the REVOKE below). `awcms_worker` — which runs the domain-event dispatcher,
-- the expiry job and the reconcile job — is granted exactly what those need in
-- `sql/951`.
--
-- RLS: the exact FORCE + single tenant-isolation policy shape of `sql/913`.

-- Tenant-safe composite reference target (see header).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_customers_tenant_id_id_key
  ON awcms_commerce_customers (tenant_id, id);

CREATE TABLE IF NOT EXISTS awcms_commerce_loyalty_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  version integer NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  effective_from timestamptz,
  effective_to timestamptz,
  -- Earn rule: `earn_points_per_unit` points for every WHOLE
  -- `earn_unit_amount` of eligible spend (subtotal minus voucher discount,
  -- never shipping/insurance/tax). The remainder is dropped: rounding is
  -- always FLOOR, recorded so the rule is self-describing.
  earn_unit_amount numeric(14, 2) NOT NULL,
  earn_points_per_unit integer NOT NULL,
  earn_rounding text NOT NULL DEFAULT 'floor',
  min_order_amount numeric(14, 2) NOT NULL DEFAULT 0,
  max_points_per_order integer,
  -- NULL = earned points never expire.
  expiry_days integer,
  notes text,
  created_by_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_loyalty_programs_status_check
    CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT awcms_commerce_loyalty_programs_rounding_check
    CHECK (earn_rounding = 'floor'),
  CONSTRAINT awcms_commerce_loyalty_programs_unit_amount_check
    CHECK (earn_unit_amount > 0),
  CONSTRAINT awcms_commerce_loyalty_programs_points_per_unit_check
    CHECK (earn_points_per_unit BETWEEN 1 AND 1000000),
  CONSTRAINT awcms_commerce_loyalty_programs_min_order_check
    CHECK (min_order_amount >= 0),
  CONSTRAINT awcms_commerce_loyalty_programs_max_points_check
    CHECK (max_points_per_order IS NULL OR max_points_per_order > 0),
  CONSTRAINT awcms_commerce_loyalty_programs_expiry_days_check
    CHECK (expiry_days IS NULL OR expiry_days BETWEEN 1 AND 3650),
  CONSTRAINT awcms_commerce_loyalty_programs_window_check
    CHECK (
      effective_to IS NULL
      OR (effective_from IS NOT NULL AND effective_to > effective_from)
    ),
  -- A draft may have no window yet; anything past draft must have started.
  CONSTRAINT awcms_commerce_loyalty_programs_started_check
    CHECK (status = 'draft' OR effective_from IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_programs_tenant_version_key
  ON awcms_commerce_loyalty_programs (tenant_id, version);

-- Composite reference target for the ledger's `(tenant_id, program_id)` FK.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_programs_tenant_id_id_key
  ON awcms_commerce_loyalty_programs (tenant_id, id);

CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_programs_tenant_idx
  ON awcms_commerce_loyalty_programs (tenant_id);

-- The (tenant, cursor) composite the generic purge engine filters + orders by.
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_programs_tenant_effective_to_idx
  ON awcms_commerce_loyalty_programs (tenant_id, effective_to);

-- "Which version applies at instant T" — the earn path's own lookup.
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_programs_tenant_window_idx
  ON awcms_commerce_loyalty_programs (tenant_id, effective_from DESC)
  WHERE status IN ('active', 'retired');

CREATE TABLE IF NOT EXISTS awcms_commerce_loyalty_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  customer_id uuid NOT NULL,
  -- PROJECTION of the ledger (see header). May be negative: a reversal
  -- claws back points that were already spent (ADR-0026 D6).
  balance bigint NOT NULL DEFAULT 0,
  -- Number of ledger rows written for this account == the highest
  -- `account_seq`. Bumped under the row lock together with `balance`.
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_loyalty_accounts_customer_fk
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES awcms_commerce_customers (tenant_id, id),
  CONSTRAINT awcms_commerce_loyalty_accounts_balance_range
    CHECK (balance BETWEEN -1000000000000 AND 1000000000000),
  CONSTRAINT awcms_commerce_loyalty_accounts_version_check
    CHECK (version >= 0)
);

-- One account per customer per tenant; also the FK index for `customer_fk`.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_accounts_tenant_customer_key
  ON awcms_commerce_loyalty_accounts (tenant_id, customer_id);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_accounts_tenant_id_id_key
  ON awcms_commerce_loyalty_accounts (tenant_id, id);

CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_accounts_tenant_idx
  ON awcms_commerce_loyalty_accounts (tenant_id);

-- Admin list, newest first.
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_accounts_tenant_created_idx
  ON awcms_commerce_loyalty_accounts (tenant_id, created_at DESC, id DESC);

-- The (tenant, cursor) composite the generic purge engine filters + orders by.
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_accounts_tenant_updated_idx
  ON awcms_commerce_loyalty_accounts (tenant_id, updated_at);

CREATE TABLE IF NOT EXISTS awcms_commerce_loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  account_id uuid NOT NULL,
  -- 1, 2, 3, ... per account, assigned under the account row lock; the
  -- authoritative order of an account's history and the key the lot replay
  -- (`domain/loyalty-lots.ts`) walks.
  account_seq bigint NOT NULL,
  kind text NOT NULL,
  -- Signed integer points. `expire` rows may be 0: a lot that was already
  -- fully consumed when it fell due still gets its marker row, so the expiry
  -- scan terminates.
  points bigint NOT NULL,
  balance_after bigint NOT NULL,
  program_id uuid,
  source_type text NOT NULL,
  source_id uuid,
  idempotency_key text NOT NULL,
  reverses_entry_id uuid,
  expires_at timestamptz,
  actor_tenant_user_id uuid,
  reason text,
  correlation_id text,
  -- `clock_timestamp()`, not `now()`: the replay compares an entry's instant
  -- with a lot's `expires_at`, and `now()` would be the START of a
  -- transaction that may have waited on the account lock.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT awcms_commerce_loyalty_ledger_account_fk
    FOREIGN KEY (tenant_id, account_id)
    REFERENCES awcms_commerce_loyalty_accounts (tenant_id, id),
  CONSTRAINT awcms_commerce_loyalty_ledger_program_fk
    FOREIGN KEY (tenant_id, program_id)
    REFERENCES awcms_commerce_loyalty_programs (tenant_id, id),
  CONSTRAINT awcms_commerce_loyalty_ledger_kind_check
    CHECK (kind IN ('earn', 'redeem', 'expire', 'adjustment', 'reversal')),
  CONSTRAINT awcms_commerce_loyalty_ledger_source_type_check
    CHECK (source_type IN ('order', 'expiry', 'redemption', 'manual')),
  CONSTRAINT awcms_commerce_loyalty_ledger_points_range
    CHECK (points BETWEEN -1000000000000 AND 1000000000000),
  CONSTRAINT awcms_commerce_loyalty_ledger_seq_check
    CHECK (account_seq >= 1),
  -- Sign discipline per kind.
  CONSTRAINT awcms_commerce_loyalty_ledger_sign_check
    CHECK (
      (kind = 'earn' AND points > 0)
      OR (kind = 'redeem' AND points < 0)
      OR (kind = 'expire' AND points <= 0)
      OR (kind = 'adjustment' AND points <> 0)
      OR (kind = 'reversal' AND points <> 0)
    ),
  CONSTRAINT awcms_commerce_loyalty_ledger_reversal_target_check
    CHECK ((kind = 'reversal') = (reverses_entry_id IS NOT NULL)),
  CONSTRAINT awcms_commerce_loyalty_ledger_expiry_only_on_earn_check
    CHECK (expires_at IS NULL OR kind = 'earn'),
  CONSTRAINT awcms_commerce_loyalty_ledger_expire_source_check
    CHECK (kind <> 'expire' OR (source_type = 'expiry' AND source_id IS NOT NULL)),
  CONSTRAINT awcms_commerce_loyalty_ledger_order_source_check
    CHECK (source_type <> 'order' OR source_id IS NOT NULL),
  -- A manual adjustment is attributable and explained, always.
  CONSTRAINT awcms_commerce_loyalty_ledger_adjustment_check
    CHECK (
      kind <> 'adjustment'
      OR (actor_tenant_user_id IS NOT NULL
          AND reason IS NOT NULL
          AND length(btrim(reason)) > 0)
    ),
  CONSTRAINT awcms_commerce_loyalty_ledger_key_check
    CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  CONSTRAINT awcms_commerce_loyalty_ledger_reason_check
    CHECK (reason IS NULL OR length(reason) <= 500)
);

-- The idempotency guard: one row per (tenant, key), forever.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_tenant_key_key
  ON awcms_commerce_loyalty_ledger (tenant_id, idempotency_key);

-- An account's history order; also the FK index for `account_fk`.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_account_seq_key
  ON awcms_commerce_loyalty_ledger (tenant_id, account_id, account_seq);

-- Composite reference target for `reverses_fk`.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_tenant_id_id_key
  ON awcms_commerce_loyalty_ledger (tenant_id, id);

-- `reverses_entry_id` -> the earn it compensates. Added AFTER the
-- (tenant_id, id) unique index above because a self-referencing foreign key
-- needs its target index to exist already. CASCADE: a reversal is deleted
-- together with the earn it compensates (see the retention note in the
-- header), so a purge batch can never split the pair.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'awcms_commerce_loyalty_ledger_reverses_fk'
  ) THEN
    ALTER TABLE awcms_commerce_loyalty_ledger
      ADD CONSTRAINT awcms_commerce_loyalty_ledger_reverses_fk
      FOREIGN KEY (tenant_id, reverses_entry_id)
      REFERENCES awcms_commerce_loyalty_ledger (tenant_id, id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- One compensating entry per original entry — independent of the key.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_reverses_key
  ON awcms_commerce_loyalty_ledger (tenant_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

-- One expiry marker per earn lot (`source_id` is the lot's entry id) — also
-- the anti-join the expiry scan uses.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_expire_lot_key
  ON awcms_commerce_loyalty_ledger (tenant_id, source_id)
  WHERE kind = 'expire';

-- FK index for `program_fk`.
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_program_idx
  ON awcms_commerce_loyalty_ledger (tenant_id, program_id)
  WHERE program_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_tenant_idx
  ON awcms_commerce_loyalty_ledger (tenant_id);

-- The expiry job's scan: earn lots that carry an expiry, soonest first.
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_expiring_idx
  ON awcms_commerce_loyalty_ledger (tenant_id, expires_at)
  WHERE kind = 'earn' AND expires_at IS NOT NULL;

-- Per-account history, newest first (admin ledger view, customer history).
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_account_created_idx
  ON awcms_commerce_loyalty_ledger (tenant_id, account_id, created_at DESC, id DESC);

-- (tenant, cursor) composite the generic lifecycle engine requires, and the
-- reporting summary's date-range scan.
CREATE INDEX IF NOT EXISTS awcms_commerce_loyalty_ledger_tenant_created_idx
  ON awcms_commerce_loyalty_ledger (tenant_id, created_at);

-- Append-only: no UPDATE, ever (see header).
CREATE OR REPLACE FUNCTION awcms_commerce_loyalty_ledger_reject_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'awcms_commerce_loyalty_ledger is append-only: corrections are compensating rows'
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS awcms_commerce_loyalty_ledger_no_update
  ON awcms_commerce_loyalty_ledger;
CREATE TRIGGER awcms_commerce_loyalty_ledger_no_update
  BEFORE UPDATE ON awcms_commerce_loyalty_ledger
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_loyalty_ledger_reject_update();

ALTER TABLE awcms_commerce_loyalty_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_loyalty_programs FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_loyalty_programs_tenant_isolation
  ON awcms_commerce_loyalty_programs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE awcms_commerce_loyalty_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_loyalty_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_loyalty_accounts_tenant_isolation
  ON awcms_commerce_loyalty_accounts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE awcms_commerce_loyalty_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_loyalty_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_loyalty_ledger_tenant_isolation
  ON awcms_commerce_loyalty_ledger
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- The request-time role may append to and read the ledger, never rewrite or
-- delete it (see header). Idempotent: REVOKE of a privilege not held is a
-- silent no-op (sql/021's own note).
REVOKE UPDATE, DELETE ON awcms_commerce_loyalty_ledger FROM awcms_app;
