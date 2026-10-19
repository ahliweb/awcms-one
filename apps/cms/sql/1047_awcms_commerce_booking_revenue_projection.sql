-- Commerce - booking-sourced revenue waterfall, no-show figures and the booking
-- anchor of the retention projection (Issue #389, ADR-0045 amendment note; spec
-- `docs/aw-business-platform-metrics.md` sections 3, 3.7, 6 and 8; parent epic
-- #280, items 10 and 18, commerce half).
--
-- Two NEW tables owned by `commerce`, maintained by the `reporting` module's
-- generic projection engine through the `cursor_table` descriptor
-- `commerce.booking_revenue` that `commerce` contributes in its own `module.ts`
-- (`reportingProjections`, via `application/booking-report-projections.ts`) - the
-- same mechanism sql/933, sql/998, sql/945 and sql/1020 use, no second analytics
-- store (ADR-0040 D5.2):
--
--   commerce.booking_revenue -> awcms_commerce_report_booking_orders
--                               awcms_commerce_report_booking_restated
--
-- and ONE additive change to the retention projection's row (sql/1020), so the
-- booking anchor needs no new store either.
--
-- ## Why a per-order row (and not a daily counter)
--
-- Every other money projection is a set of additive day counters. The booking
-- waterfall cannot be: "uncollected balance (no money moved)" appears when a
-- DECISION (a cancellation, a no-show) closes an order, "paid back" when a
-- ledger LEG settles, and gross when the order is paid - three different
-- streams, each landing on the ORIGINAL paid day (metrics 1.1 rule 5). The sink
-- therefore RECOMPUTES the order's row from its current facts (never increments),
-- so a rebuild that replays the same streams reaches exactly the same rows as the
-- live pass and a late refund restates the original day by construction. The
-- waterfall of a day is a SUM of its rows at read; the stored figures are never
-- rounded (integer cents, `numeric(14,2)`).
--
--   paid_day      Asia/Jakarta calendar day of the order's first paid transition
--                 (`paid_at`); a deposit order recognises its whole gross on the
--                 deposit day (metrics 3.7 rule 1)
--   gross         order `subtotal`; discount is DERIVED from the order's own
--                 identity (subtotal + shipping + insurance + tax - total), so
--                 `net + shipping + insurance + tax = settled + outstanding -
--                 surplus` holds exactly
--   paid_in       sum of succeeded PAYMENT legs; paid_back the succeeded REVERSAL
--                 legs ("of which paid back")
--   uncollected   the unpaid balance of a CLOSED order (cancelled, or a
--                 cancellation or no-show decision exists): leaves on the original
--                 day inside Refunds, "no money moved" (metrics 3.7 rule 3)
--   outstanding   the unpaid balance of an order still open, shown beside the
--                 waterfall (metrics 3.7 rule 2)
--   stays         reservation links that are not superseded (a reschedule's
--                 replacement counts once); no_shows / no_show_retained from the
--                 no-show refund decisions joined THROUGH the order
--
-- The row holds no name, phone, e-mail, customer id or free text. `order_id`
-- carries no foreign key: a projection row is a historical fact and the order
-- retention purge must neither be blocked by nor invalidate it; the tenant FK and
-- FORCE RLS (WITH CHECK included) are the isolation boundary.
--
-- ## The restatement log
--
-- Metrics 1.2: a day older than the 35-day window that a late event changed is
-- flagged "restated". That is a statement about WHEN a day changed, which a
-- derived table cannot know, so the sink writes one row per paid day (latest
-- restatement instant) - on the live path only, never while a rebuild run is
-- `running`, because a rebuild re-derives every row from nothing. `resetForTenant`
-- leaves this table alone (it is evidence, not a derivation).
--
-- ## The source view
--
-- Balance payments and refunds are ledger legs, not order-status events, and the
-- engine's cursor must be a NOT NULL insert-time column whose rebuild scan has no
-- `IS NOT NULL` predicate (ADR-0035 D3). sql/998's allocation view carries no
-- order id and sql/1020's only reversals, so this migration adds a narrow
-- `security_invoker` view exposing the settled legs of BOTH kinds with their
-- order - the invoking role's own privileges and RLS apply; the view holds no data.
--
-- ## The booking anchor of retention (metrics 6.2)
--
-- `first_event_kind` records whether a customer's first qualifying event was an
-- ordinary order or a confirmed booking, and `qualifying_booking_count` how many
-- of the qualifying events are bookings (a stay is ONE event: its reschedule
-- replacement and the supplementary order of a stay that grew are not extra
-- events; a cancelled stay is none). `qualifying_order_count` now counts events.
-- Existing rows keep `order` / 0, which is what they were: a tenant that already
-- sold bookings runs a rebuild of `commerce.customer_retention` once.
--
-- ## Roles
--
-- `awcms_worker` runs `bun run reporting:projections:refresh`: SELECT, INSERT,
-- UPDATE on both new tables, DELETE for the sink's own recompute and the generic
-- data-lifecycle purge (cursors `paid_day` and `day`), SELECT on the view. The
-- rebuild RESET's DELETE runs in the API route's transaction as `awcms_app`
-- (migration 019's default privileges). Mirrored in `WORKER_ROLE_GRANTS`
-- (`scripts/security-readiness.ts`).

CREATE TABLE IF NOT EXISTS awcms_commerce_report_booking_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL,
  paid_day date NOT NULL,
  source_kind text NOT NULL,
  stays integer NOT NULL,
  no_shows integer NOT NULL,
  no_show_retained numeric(14, 2) NOT NULL,
  gross numeric(14, 2) NOT NULL,
  discount numeric(14, 2) NOT NULL,
  shipping numeric(14, 2) NOT NULL,
  insurance numeric(14, 2) NOT NULL,
  tax numeric(14, 2) NOT NULL,
  total numeric(14, 2) NOT NULL,
  paid_in numeric(14, 2) NOT NULL,
  paid_back numeric(14, 2) NOT NULL,
  uncollected numeric(14, 2) NOT NULL,
  outstanding numeric(14, 2) NOT NULL,
  closed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_report_booking_orders_tenant_order_key
    UNIQUE (tenant_id, order_id),
  CONSTRAINT awcms_commerce_report_booking_orders_source_kind_check
    CHECK (source_kind IN ('reservation', 'supplement')),
  CONSTRAINT awcms_commerce_report_booking_orders_counts_check
    CHECK (stays >= 0 AND no_shows >= 0
      AND (source_kind = 'reservation' OR stays = 0)),
  CONSTRAINT awcms_commerce_report_booking_orders_money_check
    CHECK (gross >= 0 AND discount >= 0 AND shipping >= 0 AND insurance >= 0
      AND tax >= 0 AND total >= 0 AND paid_in >= 0 AND paid_back >= 0
      AND uncollected >= 0 AND outstanding >= 0 AND no_show_retained >= 0),
  -- An order is either closed (its unpaid balance left as uncollected) or open
  -- (its unpaid balance is outstanding) - never both, never a balance on neither.
  CONSTRAINT awcms_commerce_report_booking_orders_balance_check
    CHECK ((closed AND outstanding = 0) OR ((NOT closed) AND uncollected = 0))
);

-- The day-range report read and the generic purge engine's (tenant, cursor) filter.
CREATE INDEX IF NOT EXISTS awcms_commerce_report_booking_orders_day_idx
  ON awcms_commerce_report_booking_orders (tenant_id, paid_day);

ALTER TABLE awcms_commerce_report_booking_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_report_booking_orders FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_report_booking_orders_tenant_isolation
  ON awcms_commerce_report_booking_orders
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_report_booking_restated (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  day date NOT NULL,
  restated_at timestamptz NOT NULL,
  CONSTRAINT awcms_commerce_report_booking_restated_tenant_day_key
    UNIQUE (tenant_id, day)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_report_booking_restated_day_idx
  ON awcms_commerce_report_booking_restated (tenant_id, day);

ALTER TABLE awcms_commerce_report_booking_restated ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_report_booking_restated FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_report_booking_restated_tenant_isolation
  ON awcms_commerce_report_booking_restated
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE VIEW awcms_commerce_report_src_booking_legs
  WITH (security_invoker = true) AS
  SELECT id, tenant_id, settled_at, order_id, kind, status
  FROM awcms_commerce_payment_allocations
  WHERE settled_at IS NOT NULL;

-- The booking anchor of the retention projection (metrics 6.2).
ALTER TABLE awcms_commerce_report_retention_customers
  ADD COLUMN IF NOT EXISTS first_event_kind text NOT NULL DEFAULT 'order',
  ADD COLUMN IF NOT EXISTS qualifying_booking_count integer NOT NULL DEFAULT 0;

ALTER TABLE awcms_commerce_report_retention_customers
  ADD CONSTRAINT awcms_commerce_report_retention_customers_kind_check
  CHECK (first_event_kind IN ('order', 'booking')),
  ADD CONSTRAINT awcms_commerce_report_retention_customers_booking_count_check
  CHECK (qualifying_booking_count >= 0
    AND qualifying_booking_count <= qualifying_order_count),
  ADD CONSTRAINT awcms_commerce_report_retention_customers_anchor_check
  CHECK (first_event_kind = 'order' OR qualifying_booking_count >= 1);

COMMENT ON TABLE awcms_commerce_report_booking_orders IS
  'Issue #389 (metrics 3, 3.7, 8) - one derived row per booking-sourced paid order, recomputed from the order, the payment ledger and the adapter refund decisions by the commerce.booking_revenue reporting projection. The day waterfall is a sum of these rows. Holds no customer, name or contact.';
COMMENT ON TABLE awcms_commerce_report_booking_restated IS
  'Issue #389 (metrics 1.2) - when a paid day older than the 35-day window was last restated by a late event; evidence, not a derivation, so a rebuild leaves it alone.';
COMMENT ON COLUMN awcms_commerce_report_retention_customers.first_event_kind IS
  'Issue #389 (metrics 6.2) - whether the customer''s first qualifying event was an ordinary order or a confirmed booking (a paid order carrying a Booking reservation link).';
COMMENT ON COLUMN awcms_commerce_report_retention_customers.qualifying_booking_count IS
  'Issue #389 (metrics 6.2) - how many of qualifying_order_count (qualifying events) are bookings; a stay is one event.';

GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_report_booking_orders TO awcms_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON awcms_commerce_report_booking_restated TO awcms_worker;
GRANT SELECT ON awcms_commerce_report_src_booking_legs TO awcms_worker;
