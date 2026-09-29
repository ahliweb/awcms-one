-- Issue #270 (IRMbyDUS: practice-irm module, ADR-0002) — `awcms_practice_
-- irm_sessions`: the 12-field practice-session record from PRD §16
-- (`redesign/PRD_IRMbyDUS_v1.0.md`). Follows `sql/936`'s conventions exactly
-- (`ENABLE` + `FORCE ROW LEVEL SECURITY`, one tenant-isolation `USING`
-- policy, `id uuid` PK `DEFAULT gen_random_uuid()`, `created_at`/
-- `updated_at timestamptz DEFAULT now()`, an FK index for every FK column,
-- no per-table GRANT — `sql/019`'s `ALTER DEFAULT PRIVILEGES` already
-- covers `awcms_app`).
--
-- ## Why this migration is numbered 9xx, not below 900
--
-- `owner_customer_id`/`product_id` below are real foreign keys into
-- `awcms_commerce_customers`/`awcms_commerce_products` — tables that only
-- exist once `commerce`'s own `9xx` migrations have run. `db-migrate.ts`
-- applies every `sql/*.sql` file in lexical filename order, so a migration
-- numbered below `commerce`'s would run — and fail with `relation
-- "awcms_commerce_customers" does not exist` — before those tables exist.
-- ADR-0024 extends ADR-0015's `commerce`-only `9xx` allowlist to
-- `practice_irm` for exactly this reason (plus `practice_irm` being
-- local-only to `awcms-one`, same as `commerce`, in the first place).
--
-- ## The 12 fields walk the five domains in order
--
-- `situation`/`emotion`/`intensity`/`body`/`automatic_thought`/`meaning` is
-- IDENTIFY; `neutralize` is NEUTRALIZE; `post_intensity` re-measures after
-- it; `navigate`/`embed`/`reinforce` are their own domains; `reflection`
-- closes the session. See `src/modules/practice-irm/domain/practice-
-- session.ts`'s header for the full mapping.
--
-- ## `intensity`/`post_intensity`: plain integers, 0-10, NOTHING derived
--
-- PRD's Explicit Non-Goals (§38) forbid "clinical scoring"/"psychological
-- profiling"; ADR-0002's Consequences state the rule this CHECK constraint
-- enforces at the database and `domain/practice-session.ts` enforces in
-- code: plain integers, checked for RANGE only, never summed, averaged, or
-- bucketed into a severity label anywhere in this codebase.
-- `tests/practice-session-no-derived-score.test.ts` guards the "anywhere"
-- part.
--
-- ## Entitlement gate: `verifyEntitlement(ownerCustomerId, productId)`, every call
--
-- `product_id` records WHICH commerce product's entitlement unlocked this
-- session at creation time (a customer may hold several IRM products, each
-- with its own practice content) — the same "the row is also the proof of
-- what was paid for" reasoning `sql/936`'s header gives for
-- `awcms_commerce_entitlements.source_order_id`. Every application-layer
-- function in `application/practice-session-directory.ts` re-verifies the
-- entitlement live (no cache) before ANY read or write — a revoked
-- entitlement cuts off session content on the very next call, including
-- history, exactly like `commerce`'s own `verifyEntitlement` behaves for
-- entitlement-check itself.
--
-- ## RLS: tenant isolation only — owner-scoping stays application-level
--
-- Identical shape and identical reasoning to `awcms_commerce_entitlements`
-- (`sql/936`'s own header, itself citing ADR-0016 D1): a customer is not
-- part of this schema's tenant_user/identity/profile/principal RLS
-- vocabulary (there is no `app.current_customer_id` session variable
-- anywhere in this codebase), so a second `USING` clause keyed on the
-- calling customer is not a shape this system has. Owner-scoping for every
-- customer-facing route is enforced the same way
-- `commerce-entitlement-directory.ts`'s `listEntitlementsForCustomer`
-- already enforces it: `owner_customer_id` is read ONLY from the verified
-- bearer session (`requireCustomerSession`, reused directly from `commerce`
-- — see this module's README), never accepted from request input, and
-- every query in `practice-session-directory.ts` filters on it explicitly.
--
-- ## `completed` is immutable
--
-- `draft -> completed` is the only transition (AGENTS.md's posted-data
-- rule); `application/practice-session-directory.ts`'s `updatePracticeSession`
-- refuses once `status = 'completed'`. There is no soft-delete route in
-- this PR — `deleted_at` exists for schema uniformity with the rest of this
-- codebase's tables but no code sets it yet (see this module's README,
-- "known limitations").
CREATE TABLE IF NOT EXISTS awcms_practice_irm_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  owner_customer_id uuid NOT NULL REFERENCES awcms_commerce_customers (id),
  product_id uuid NOT NULL REFERENCES awcms_commerce_products (id),
  status text NOT NULL DEFAULT 'draft',
  situation text,
  emotion text,
  intensity integer,
  body text,
  automatic_thought text,
  meaning text,
  neutralize text,
  post_intensity integer,
  navigate text,
  embed text,
  reinforce text,
  reflection text,
  completed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_practice_irm_sessions_status_check
    CHECK (status IN ('draft', 'completed')),
  -- A completed row must carry when it was completed, and a draft must not
  -- — the two columns are not allowed to disagree with `status`, same
  -- discipline `sql/936`'s `revoked_at` check applies to entitlements.
  CONSTRAINT awcms_practice_irm_sessions_completed_at_check
    CHECK (
      (status = 'draft' AND completed_at IS NULL) OR
      (status = 'completed' AND completed_at IS NOT NULL)
    ),
  -- The one constraint PRD explicitly requires: 0-10 inclusive, and NOTHING
  -- else — no derived scoring/classification anywhere (see this file's own
  -- header).
  CONSTRAINT awcms_practice_irm_sessions_intensity_check
    CHECK (intensity IS NULL OR (intensity >= 0 AND intensity <= 10)),
  CONSTRAINT awcms_practice_irm_sessions_post_intensity_check
    CHECK (post_intensity IS NULL OR (post_intensity >= 0 AND post_intensity <= 10))
);

-- "My sessions" history — newest first, for one customer's one product.
CREATE INDEX IF NOT EXISTS awcms_practice_irm_sessions_tenant_owner_product_idx
  ON awcms_practice_irm_sessions (tenant_id, owner_customer_id, product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_practice_irm_sessions_tenant_idx
  ON awcms_practice_irm_sessions (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_practice_irm_sessions_product_idx
  ON awcms_practice_irm_sessions (product_id);

-- The (tenant, cursor) composite the generic data-lifecycle purge engine
-- filters + orders by (`module.ts`'s `dataLifecycle` descriptor) — see this
-- file's own header on why no code sets `deleted_at` yet.
CREATE INDEX IF NOT EXISTS awcms_practice_irm_sessions_tenant_deleted_idx
  ON awcms_practice_irm_sessions (tenant_id, deleted_at);

ALTER TABLE awcms_practice_irm_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_practice_irm_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_practice_irm_sessions_tenant_isolation
  ON awcms_practice_irm_sessions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
