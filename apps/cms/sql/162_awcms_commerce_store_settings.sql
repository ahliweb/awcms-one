-- Issue #26 (part of epic #21) — `awcms_commerce_store_settings`: one row
-- per tenant, `jsonb settings` validated by
-- `domain/store-settings-validation.ts` against a versioned schema (store
-- identity, customer levels, shipping, payment, promo section, meta titles).
--
-- ## Singleton, `tenant_id` IS the primary key
--
-- Same shape `awcms_site_profile` (`sql/135`) uses for exactly the same
-- reason: there is never more than one settings row per tenant, so
-- `tenant_id uuid PRIMARY KEY` both enforces that and gives
-- `application/store-settings-directory.ts`'s upsert
-- (`INSERT ... ON CONFLICT (tenant_id) DO UPDATE`) a natural conflict target
-- — no separate `id`/unique index needed.
--
-- ## Why `jsonb`, not columns
--
-- The settings a store owner configures span store identity, four customer
-- levels, shipping (an open-ended list of alternative services), payment
-- (multiple bank accounts, DP/tax/insurance toggles), a 3-slot promo strip,
-- and per-page meta titles — dozens of nested, occasionally-list-shaped
-- fields that would be dozens of columns (most tenants leave most of them at
-- their default) or a wide sparse table. One validated `jsonb` blob, the
-- same choice `awcms_tenant_settings.feature_flags` already makes at a
-- smaller scale, keeps the schema evolvable (a new field is a
-- `domain/store-settings-validation.ts` change, not a migration) while
-- `jsonb_typeof` still guards the one shape invariant SQL itself can cheaply
-- assert.
--
-- ## Bank account numbers / QRIS payloads live INSIDE this jsonb
--
-- `payment.manualBank.accounts[].accountNumber`/`.accountHolder` and
-- `payment.manualQris.mediaObjectId` are stored here, in the OWNER's own
-- settings blob — `GET /api/v1/commerce/store-settings` (owner,
-- `settings.read`) returns them unmasked (issue #26's own text); the public
-- projection (`GET .../store-settings/public`) and every audit-log line
-- STRIP them before they ever leave `application/store-settings-directory.ts`
-- — see that file's `toPublicRecord`/`changedSections`. There is nothing for
-- RLS or a column-level GRANT to add here: the whole row is already
-- tenant-isolated, and the masking boundary is the APPLICATION's read-model
-- projection, the same boundary every other jsonb-column module in this base
-- draws.
--
-- ## RLS, GRANTs — same conventions as `sql/153`/`sql/161`
--
-- `ENABLE` + `FORCE ROW LEVEL SECURITY`, one tenant-isolation `USING`
-- policy, no per-table GRANT (`sql/019`'s `ALTER DEFAULT PRIVILEGES` already
-- covers it).
--
-- ## `deleted_at` is "reset to defaults", and it is what answers retention
--
-- `DELETE /api/v1/commerce/store-settings` (owner, `settings.update`) does
-- not remove the row — it stamps `deleted_at`, and every reader treats a
-- stamped row as "this tenant has the defaults" while the next `PUT`
-- clears the stamp and replaces the blob. That keeps the singleton shape
-- (`tenant_id` stays the primary key, the upsert still has one conflict
-- target) and gives the row the same two-axis story `sql/153` gives products:
-- a LIVE settings row is `deleted_at IS NULL` and has no natural age limit —
-- a store that set its courier fee two years ago and has been selling under
-- it since is the healthy case, not a stale one — so `commerce/module.ts`'s
-- `dataLifecycle` descriptor uses `cursorColumn: "deleted_at"` (the generic
-- engine's own `deleted_at < $2` predicate is never true for `NULL`, so it is
-- mathematically incapable of reaching a live row) and only a row an owner
-- RESET, and then left reset for the retention window, ever becomes
-- purge-eligible. `awcms_site_profile` (`sql/135`) answers the same
-- question by exemption instead (`BOUNDED_BY_DESIGN`); that ledger is capped
-- and full, and a column the engine can be pointed at is a stronger answer
-- than a sentence in a list.

CREATE TABLE IF NOT EXISTS awcms_commerce_store_settings (
  tenant_id uuid PRIMARY KEY REFERENCES awcms_tenants (id),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_store_settings_is_object
    CHECK (jsonb_typeof(settings) = 'object')
);

COMMENT ON TABLE awcms_commerce_store_settings IS
  'Issue #26 — per-tenant marketing/commerce store settings, one row, jsonb validated by domain/store-settings-validation.ts. GET .../store-settings/public composes the public subset; bank accounts/QRIS media id never leave the owner-only GET.';

-- The (tenant, cursor) composite the generic purge engine filters and
-- orders by — one row per tenant, so it is tiny, but the engine's query
-- shape is the same for every table it serves.
CREATE INDEX IF NOT EXISTS awcms_commerce_store_settings_tenant_deleted_idx
  ON awcms_commerce_store_settings (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_store_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_store_settings_tenant_isolation
  ON awcms_commerce_store_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
