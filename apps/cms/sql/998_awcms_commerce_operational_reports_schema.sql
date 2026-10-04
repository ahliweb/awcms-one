-- Commerce - POS operational-report read-model projection tables (Issue #296,
-- ADR-0035; parent epic #281).
--
-- Five DIMENSIONAL projection tables owned by `commerce`, maintained by the
-- `reporting` module's generic projection engine (the same mechanism sql/933's
-- three sales-report tables use) through the `cursor_table` descriptors
-- `commerce` contributes in its own `module.ts` (`reportingProjections`):
--
--   commerce.pos_tender_daily       -> awcms_commerce_report_tender_daily
--   commerce.pos_cash_up_variance   -> awcms_commerce_report_cash_up_tenders
--   commerce.pos_expense_daily      -> awcms_commerce_report_expense_daily
--   commerce.pos_loyalty_daily      -> awcms_commerce_report_loyalty_daily
--   commerce.pos_stored_value_daily -> awcms_commerce_report_stored_value_daily
--
-- The engine's own tables (`awcms_reporting_projection_{state,cursors,
-- metrics}`, migration 015) keep carrying the cursor, the freshness
-- bookkeeping and the scalar "rows consumed" counters; these five carry the
-- per-day / per-session money, point and count figures a scalar counter cannot
-- express.
--
-- ## Sources and delta rules (domain/operational-report-deltas.ts is the law)
--
-- Every source is a table that is append-only, or whose relevant fact is
-- written exactly once and frozen by a trigger - the only kind of source the
-- `cursor_table` strategy is correct for (`reporting/README.md` §Projections):
--
--   * payment allocations (sql/940): cursor `settled_at`. A pending gateway leg
--     has no `settled_at` and is invisible until it resolves (the append-only
--     guard lets a row change once, pending -> succeeded/failed, and sets
--     `settled_at` in that same update), so the cursor never has to revisit a
--     row. The index below is partial on `settled_at IS NOT NULL`.
--   * register close requests (sql/970): cursor `decided_at`, only decisions
--     `auto`/`approved`; their `register_close_lines` carry the per-tender
--     expected/counted figures. Register corrections: cursor `created_at`.
--   * expenses (sql/990): TWO streams, `posted_at` and `reversed_at` - each
--     written once and frozen once set (`awcms_commerce_expenses_guard`).
--   * loyalty (sql/950) and stored-value (sql/985) ledgers: cursor
--     `created_at`, append-only by trigger.
--
-- ## Idempotency, rebuild, reconciliation
--
-- Rows are UPSERTED by primary key with additive deltas
-- (`INSERT ... ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x`), inside the
-- engine's own bounded pass transaction, AFTER the (tenant, projection)
-- advisory lock and BEFORE the cursor advance. A rebuild deletes the tenant's
-- rows in the SAME transaction that resets the cursors, then re-derives
-- everything through the identical delta functions; reconciliation recomputes
-- control totals through those same functions and compares them with SUM()
-- over these tables. Every column except the key and the snapshots is
-- additive, so two streams feeding one table (expenses, cash-ups) commute: it
-- does not matter which stream a pass reaches first.
--
-- ## Dimensions are snapshots, not foreign keys
--
-- `register_id`, `category_id` and `cashier_tenant_user_id` carry no FK: a
-- projection row is a HISTORICAL FACT about a day, and a retention purge of a
-- register or an expense category (ten-year ceiling, sql/973 and sql/993) must
-- not be blocked by, or make unrebuildable, the report that mentions it - the
-- posture sql/933 takes for product/category and ADR-0017 D7 records. The
-- tenant FK and FORCE RLS (WITH CHECK included) are the isolation boundary;
-- `register_id` uses the all-zero sentinel for "not taken on a register"
-- because it is part of the primary key. `category_name` is a snapshot for the
-- same reason sales_by_category's is.
--
-- Money is `numeric(14, 2)` like every commerce money column; loyalty points
-- are `bigint`. The application computes each delta in integer cents/points
-- and hands Postgres a decimal STRING, never a float.
--
-- ## Roles
--
-- `awcms_app` receives its verbs from migration 019's default privileges.
-- `awcms_worker` runs `bun run reporting:projections:refresh`, so it needs
-- SELECT + INSERT + UPDATE (the upsert) on all five, plus DELETE for the
-- generic data-lifecycle purge (`commerce.pos_*` dataLifecycle descriptors,
-- cursor `day`). The rebuild RESET's own DELETE runs in the API route's
-- transaction as `awcms_app`. The worker already holds SELECT on every source
-- table (sql/942, sql/951, sql/973, sql/988, sql/993). Mirrored in
-- `WORKER_ROLE_GRANTS` (`scripts/security-readiness.ts`).
--
-- ## Retention / subject data
--
-- Retention: five `dataLifecycle` descriptors in `commerce/module.ts`, the
-- same 3650-day ceiling as the sales projections. Subject data: the loyalty
-- and stored-value tables hold per-day sums with no account or customer; the
-- cash-up table names the cashier of record (a STAFF member, not a customer -
-- the same stamp `awcms_commerce_register_sessions` carries). See
-- `scripts/subject-data-coverage-check.ts`.

CREATE TABLE IF NOT EXISTS awcms_commerce_report_tender_daily (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  day date NOT NULL,
  register_id uuid NOT NULL,
  tender_type text NOT NULL,
  payment_count integer NOT NULL DEFAULT 0,
  payments numeric(14, 2) NOT NULL DEFAULT 0,
  reversal_count integer NOT NULL DEFAULT 0,
  reversals numeric(14, 2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, register_id, tender_type)
);

ALTER TABLE awcms_commerce_report_tender_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_report_tender_daily FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_report_tender_daily_tenant_isolation
  ON awcms_commerce_report_tender_daily
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_report_cash_up_tenders (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  session_id uuid NOT NULL,
  tender_type text NOT NULL,
  register_id uuid NOT NULL,
  cashier_tenant_user_id uuid NOT NULL,
  day date NOT NULL,
  line_count integer NOT NULL DEFAULT 0,
  expected numeric(14, 2) NOT NULL DEFAULT 0,
  counted numeric(14, 2) NOT NULL DEFAULT 0,
  adjustment numeric(14, 2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, session_id, tender_type)
);

-- The day-range read and the generic purge engine's (tenant, cursor) filter.
CREATE INDEX IF NOT EXISTS awcms_commerce_report_cash_up_tenders_day_idx
  ON awcms_commerce_report_cash_up_tenders (tenant_id, day);

ALTER TABLE awcms_commerce_report_cash_up_tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_report_cash_up_tenders FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_report_cash_up_tenders_tenant_isolation
  ON awcms_commerce_report_cash_up_tenders
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_report_expense_daily (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  day date NOT NULL,
  category_id uuid NOT NULL,
  tender_type text NOT NULL,
  category_name text NOT NULL,
  posted_count integer NOT NULL DEFAULT 0,
  posted numeric(14, 2) NOT NULL DEFAULT 0,
  reversed_count integer NOT NULL DEFAULT 0,
  reversed numeric(14, 2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, category_id, tender_type)
);

ALTER TABLE awcms_commerce_report_expense_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_report_expense_daily FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_report_expense_daily_tenant_isolation
  ON awcms_commerce_report_expense_daily
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_report_loyalty_daily (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  day date NOT NULL,
  bucket text NOT NULL,
  entries integer NOT NULL DEFAULT 0,
  points bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, bucket),
  CONSTRAINT awcms_commerce_report_loyalty_daily_bucket_check
    CHECK (bucket IN (
      'earn', 'redeem', 'expire', 'adjustment_up', 'adjustment_down',
      'reversal_up', 'reversal_down'
    ))
);

ALTER TABLE awcms_commerce_report_loyalty_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_report_loyalty_daily FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_report_loyalty_daily_tenant_isolation
  ON awcms_commerce_report_loyalty_daily
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_report_stored_value_daily (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  day date NOT NULL,
  account_kind text NOT NULL,
  bucket text NOT NULL,
  entries integer NOT NULL DEFAULT 0,
  amount numeric(14, 2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, account_kind, bucket),
  CONSTRAINT awcms_commerce_report_stored_value_daily_kind_check
    CHECK (account_kind IN ('gift_card', 'store_credit')),
  CONSTRAINT awcms_commerce_report_stored_value_daily_bucket_check
    CHECK (bucket IN (
      'issue', 'load', 'redeem', 'refund', 'expire', 'adjust_up', 'adjust_down'
    ))
);

ALTER TABLE awcms_commerce_report_stored_value_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_report_stored_value_daily FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_report_stored_value_daily_tenant_isolation
  ON awcms_commerce_report_stored_value_daily
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Cursor indexes on the SOURCE tables the new streams scan. The engine selects
-- `WHERE tenant_id = $1 AND <cursor> >= $2 AND <cursor> <= now() - lag ORDER BY
-- <cursor> LIMIT n`; without a (tenant, cursor) index that is a sequential
-- scan per pass. Partial where the cursor is NULL until the fact happens.
-- Ledgers and corrections already have (tenant_id, created_at) (sql/950, 970,
-- 985).
--
-- ## Why four streams read a VIEW, not the table
--
-- The engine's cursor must be a NOT NULL, insert-time column: its REBUILD scan
-- (`projection-rebuild.ts`) has no `cursor IS NOT NULL` predicate and no lag
-- bound, so a table whose cursor is NULL until a fact happens (a pending leg's
-- `settled_at`, an undecided request's `decided_at`, a draft expense's
-- `posted_at`/`reversed_at`) would hand it a NULL row, `toDate(null)` would
-- reset the cursor to the epoch, and the next pass would re-count everything.
-- The streams therefore read `awcms_commerce_report_src_*` - narrow
-- `security_invoker` views (PostgreSQL 15+: the invoking role's own privileges
-- AND its row-level security apply, exactly as if it had read the table)
-- exposing only the rows whose cursor is set, and only the id, tenant, cursor
-- and the one column a scalar rule matches on. The engine's own reconciliation
-- (`COUNT(*) ... WHERE <match column> = <value>`) reads the same view, so the
-- scalar counters and the rebuild agree with the incremental pass by
-- construction. The views hold no data of their own and carry no person.
CREATE OR REPLACE VIEW awcms_commerce_report_src_allocations
  WITH (security_invoker = true) AS
  SELECT id, tenant_id, settled_at, status
  FROM awcms_commerce_payment_allocations
  WHERE settled_at IS NOT NULL;

CREATE OR REPLACE VIEW awcms_commerce_report_src_close_decisions
  WITH (security_invoker = true) AS
  SELECT id, tenant_id, decided_at, decision
  FROM awcms_commerce_register_close_requests
  WHERE decided_at IS NOT NULL AND decision IN ('auto', 'approved');

CREATE OR REPLACE VIEW awcms_commerce_report_src_expenses_posted
  WITH (security_invoker = true) AS
  SELECT id, tenant_id, posted_at, decision
  FROM awcms_commerce_expenses
  WHERE posted_at IS NOT NULL;

CREATE OR REPLACE VIEW awcms_commerce_report_src_expenses_reversed
  WITH (security_invoker = true) AS
  SELECT id, tenant_id, reversed_at, status
  FROM awcms_commerce_expenses
  WHERE reversed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_payment_allocations_tenant_settled_idx
  ON awcms_commerce_payment_allocations (tenant_id, settled_at)
  WHERE settled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_register_close_requests_tenant_decided_idx
  ON awcms_commerce_register_close_requests (tenant_id, decided_at)
  WHERE decided_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_tenant_posted_idx
  ON awcms_commerce_expenses (tenant_id, posted_at)
  WHERE posted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_tenant_reversed_idx
  ON awcms_commerce_expenses (tenant_id, reversed_at)
  WHERE reversed_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_report_tender_daily TO awcms_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_report_cash_up_tenders TO awcms_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_report_expense_daily TO awcms_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_report_loyalty_daily TO awcms_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_report_stored_value_daily TO awcms_worker;

GRANT SELECT ON awcms_commerce_report_src_allocations TO awcms_worker;
GRANT SELECT ON awcms_commerce_report_src_close_decisions TO awcms_worker;
GRANT SELECT ON awcms_commerce_report_src_expenses_posted TO awcms_worker;
GRANT SELECT ON awcms_commerce_report_src_expenses_reversed TO awcms_worker;
