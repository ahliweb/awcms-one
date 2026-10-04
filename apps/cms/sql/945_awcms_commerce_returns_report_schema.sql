-- Commerce - returns & refunds operational-report read-model table (Issue #316,
-- ADR-0035 D1's returns contract; follow-up to #296 and #287).
--
-- ONE dimensional projection table owned by `commerce`, maintained by the
-- `reporting` module's generic projection engine through the `cursor_table`
-- descriptor `commerce` contributes in its own `module.ts`
-- (`reportingProjections`), exactly as sql/998's five tables are:
--
--   commerce.pos_returns_daily -> awcms_commerce_report_returns_daily
--
-- ## Why this file sorts at 945 although the sources are created at 994
--
-- Migrations apply in lexical order and 945 runs BEFORE sql/994 (the returns
-- tables) and sql/970 (the register). This file therefore contains NOTHING that
-- names those tables: no foreign key, no view, no index on a source. A table
-- with plain columns, row-level security and a worker grant can exist before
-- the facts it will one day summarise do; the projection reads its sources only
-- at RUN time, through the engine. That is also why no `security_invoker` view
-- is needed here (the ADR-0035 D3 hazard - a source whose cursor is NULL until
-- the fact happens): every stream reads a source whose cursor is NOT NULL from
-- insert -
--
--   * returns (sql/994)        cursor `created_at`  (index sql/994 already has)
--   * return lines (sql/994)   cursor `created_at`  (append-only, same)
--   * refund legs              cursor `settled_at` of the payment ledger's
--                              REVERSAL row the refund booked, read through the
--                              existing `awcms_commerce_report_src_allocations`
--                              view (sql/998) - a refund's own `settled_at` is
--                              NULL while it is pending, but its reversal row
--                              only exists once the money has moved.
--
-- ## Shape: one long table, additive rows
--
--   section    return       one row per recorded return or exchange; bucket =
--                           `return` | `exchange`; count = returns; amount =
--                           their refund total (goods - discount + shipping)
--              disposition  one row per returned line; bucket = `restock` |
--                           `damaged` | `quarantine`; count = lines; units =
--                           units; amount = the lines' refunded value
--              refund       one row per SETTLED refund leg; bucket = the
--                           tender it went back by; detail = `original_tender`
--                           | `store_credit`; count = legs; amount = money
--
-- "Restocked vs written off" is therefore `disposition = restock` against
-- `disposition = damaged`; `quarantine` is stock held back, neither.
-- Every column except the key is additive, so the three streams that feed the
-- table commute (it does not matter which a pass reaches first), and a rebuild
-- deletes the tenant's rows in the same transaction that resets the cursors.
--
-- ## Dimensions are snapshots, not foreign keys
--
-- `register_id` carries no FK (a register may be retention-purged long after
-- its day's figures must still be rebuildable) and uses the all-zero sentinel
-- for "not taken on a register" because it is part of the primary key. A
-- return and its lines are attributed to the register of the ORIGINAL sale;
-- a refund leg to the register of the session it was paid out in. `detail` is
-- the empty string, not NULL, where a section has no third dimension.
--
-- Money is `numeric(14, 2)`; the application computes every delta in integer
-- cents and hands Postgres a decimal STRING, never a float.
--
-- ## Roles
--
-- `awcms_worker` runs `bun run reporting:projections:refresh`, so it needs
-- SELECT + INSERT + UPDATE (the upsert) plus DELETE for the generic
-- data-lifecycle purge (cursor `day`). It already holds SELECT on every source
-- (sql/942, sql/973, sql/997, sql/998). The rebuild reset's DELETE runs in the
-- API route's transaction as `awcms_app`, which gets its verbs from migration
-- 019's default privileges. Mirrored in `WORKER_ROLE_GRANTS`
-- (`scripts/security-readiness.ts`).
--
-- Retention / subject data: no person column at all - per-day sums and counts
-- (see `domain/operational-report-lifecycle.ts`).

CREATE TABLE IF NOT EXISTS awcms_commerce_report_returns_daily (
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  day date NOT NULL,
  register_id uuid NOT NULL,
  section text NOT NULL,
  bucket text NOT NULL,
  detail text NOT NULL DEFAULT '',
  entry_count integer NOT NULL DEFAULT 0,
  units integer NOT NULL DEFAULT 0,
  amount numeric(14, 2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, register_id, section, bucket, detail),
  CONSTRAINT awcms_commerce_report_returns_daily_section_check
    CHECK (section IN ('return', 'disposition', 'refund')),
  CONSTRAINT awcms_commerce_report_returns_daily_bucket_check
    CHECK (
      (section = 'return' AND bucket IN ('return', 'exchange') AND detail = '')
      OR (section = 'disposition'
          AND bucket IN ('restock', 'damaged', 'quarantine') AND detail = '')
      OR (section = 'refund' AND length(bucket) > 0
          AND detail IN ('original_tender', 'store_credit'))
    )
);

ALTER TABLE awcms_commerce_report_returns_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_report_returns_daily FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_report_returns_daily_tenant_isolation
  ON awcms_commerce_report_returns_daily
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_report_returns_daily TO awcms_worker;
