-- Commerce - customer-retention read-model projection (Issue #364, ADR-0044;
-- spec `docs/aw-business-platform-metrics.md` section 6; parent epic #280).
--
-- Two tables owned by `commerce`, maintained by the `reporting` module's
-- generic projection engine through the `cursor_table` descriptor `commerce`
-- contributes in its own `module.ts` (`reportingProjections`) - the same
-- mechanism sql/933, sql/998 and sql/945 use, no second analytics store
-- (ADR-0040 D5.2):
--
--   commerce.customer_retention -> awcms_commerce_report_retention_customers
--                                  awcms_commerce_report_retention_restated
--
-- ## Why a per-customer row (and not a daily counter)
--
-- Every other commerce projection is a set of additive day counters. Retention
-- cannot be: a late event moves a customer BETWEEN cohorts (a first purchase
-- is refunded, so the second becomes the first), which no increment can
-- express. Metrics section 6.4 therefore keeps, per tenant and customer, only
-- the two earliest qualifying instants and derives the cohort tallies at read.
-- The sink RECOMPUTES a customer from the order facts each time one of that
-- customer's orders changes (never increments), so a rebuild that replays the
-- same events reaches exactly the same rows as the live pass.
--
--   first_event_at         instant of the earliest qualifying paid order
--   second_event_at        earliest qualifying instant STRICTLY AFTER the first
--                          (NULL = none); "within 90 days" is decided at read
--   qualifying_order_count every qualifying order of the customer (the
--                          "unlinked" walk-in figure needs the count, not two
--                          instants)
--   cohort_month           first day of the Asia/Jakarta calendar month of
--                          first_event_at (derived once, by the sink, through
--                          the same day resolver the sales reports use)
--
-- The row holds no name, phone, e-mail or order id. `customer_id` carries no
-- foreign key: a projection row is a historical fact, and a retention purge of
-- a customer (ten-year ceiling) must neither be blocked by nor invalidate it;
-- the read joins `awcms_commerce_customers` so a blocked or purged customer
-- leaves the denominator at once, and the row itself goes at the next rebuild.
-- The tenant FK and FORCE RLS (WITH CHECK included) are the isolation boundary.
--
-- ## The restatement log
--
-- Metrics section 1.2: a period older than the 35-day restatement window that
-- a late event changed is flagged "restated". That is a statement about WHEN a
-- cohort changed, which a derived table cannot know, so the sink writes one row
-- per cohort month (latest restatement instant) - and only on the live path:
-- it skips the write while a rebuild run is `running`, because a rebuild
-- re-derives every row from nothing and would otherwise "restate" every old
-- cohort. `resetForTenant` leaves this table alone (it is evidence, not a
-- derivation); the rebuild-equals-live comparison is over the customer table.
--
-- ## The source view
--
-- A fully refunded order leaves the cohort, and a refund booked by hand moves
-- `payment_status` without any order-status event. The sink therefore also
-- listens to the payment ledger's settled REVERSAL legs. The engine's cursor
-- must be a NOT NULL insert-time column and its rebuild scan has no
-- `IS NOT NULL` or lag predicate (ADR-0035 D3), so the stream reads a narrow
-- `security_invoker` view exposing only the rows whose `settled_at` is set -
-- the invoking role's own privileges and RLS apply; the view holds no data.
--
-- ## Roles
--
-- `awcms_worker` runs `bun run reporting:projections:refresh`: SELECT, INSERT,
-- UPDATE on both tables, DELETE for the sink's own recompute and the generic
-- data-lifecycle purge (cursor `cohort_month`), SELECT on the view. The rebuild
-- RESET's DELETE runs in the API route's transaction as `awcms_app`
-- (migration 019's default privileges). Mirrored in `WORKER_ROLE_GRANTS`
-- (`scripts/security-readiness.ts`).

CREATE TABLE IF NOT EXISTS awcms_commerce_report_retention_customers (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  customer_id uuid NOT NULL,
  cohort_month date NOT NULL,
  first_event_at timestamptz NOT NULL,
  second_event_at timestamptz,
  qualifying_order_count integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, customer_id),
  CONSTRAINT awcms_commerce_report_retention_customers_count_check
    CHECK (qualifying_order_count >= 1),
  CONSTRAINT awcms_commerce_report_retention_customers_second_check
    CHECK (second_event_at IS NULL OR second_event_at > first_event_at),
  CONSTRAINT awcms_commerce_report_retention_customers_month_check
    CHECK (cohort_month = date_trunc('month', cohort_month::timestamp)::date)
);

-- The cohort-range read and the generic purge engine's (tenant, cursor) filter.
CREATE INDEX IF NOT EXISTS awcms_commerce_report_retention_customers_month_idx
  ON awcms_commerce_report_retention_customers (tenant_id, cohort_month);

ALTER TABLE awcms_commerce_report_retention_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_report_retention_customers FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_report_retention_customers_tenant_isolation
  ON awcms_commerce_report_retention_customers
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_report_retention_restated (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  cohort_month date NOT NULL,
  restated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, cohort_month)
);

ALTER TABLE awcms_commerce_report_retention_restated ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_report_retention_restated FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_report_retention_restated_tenant_isolation
  ON awcms_commerce_report_retention_restated
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE VIEW awcms_commerce_report_src_retention_reversals
  WITH (security_invoker = true) AS
  SELECT id, tenant_id, settled_at, order_id, status
  FROM awcms_commerce_payment_allocations
  WHERE kind = 'reversal' AND status = 'succeeded' AND settled_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_report_retention_customers TO awcms_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_report_retention_restated TO awcms_worker;
GRANT SELECT ON awcms_commerce_report_src_retention_reversals TO awcms_worker;
