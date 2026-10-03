-- Issue #291 — the durable identity of an APPLIED catalog CSV import.
--
-- A dry-run writes nothing at all, so it has no row here. An apply is
-- all-or-nothing (one savepoint inside the request transaction): either every
-- row lands and exactly one batch row is written in the same transaction, or
-- nothing lands and no row exists. So a row's mere presence means "this file
-- was applied in full", and there is no `status` column to disagree with that.
--
-- `idempotency_key_hash` is the SHA-256 of the caller's `Idempotency-Key`
-- (never the raw key, doc 10's masking rule). The shared
-- `awcms_idempotency_keys` store is what replays a retried request; this
-- unique index is the second, structural guard — even if the replay record
-- were lost, the same key cannot apply twice for one tenant.
--
-- `file_sha256` binds the batch to the exact bytes that were validated, so an
-- operator (or auditor) can prove which file produced which change and the
-- apply endpoint can refuse a file that differs from the one a dry-run
-- reviewed (`expectedSha256`).

CREATE TABLE IF NOT EXISTS awcms_commerce_catalog_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  file_sha256 text NOT NULL,
  idempotency_key_hash text NOT NULL,
  row_count integer NOT NULL,
  created_count integer NOT NULL,
  updated_count integer NOT NULL,
  unchanged_count integer NOT NULL,
  actor_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_catalog_import_batches_counts_check
    CHECK (
      row_count >= 0 AND created_count >= 0 AND updated_count >= 0
      AND unchanged_count >= 0
      AND created_count + updated_count + unchanged_count = row_count
    ),
  CONSTRAINT awcms_commerce_catalog_import_batches_sha_check
    CHECK (file_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_catalog_import_batches_tenant_key_key
  ON awcms_commerce_catalog_import_batches (tenant_id, idempotency_key_hash);

CREATE INDEX IF NOT EXISTS awcms_commerce_catalog_import_batches_tenant_idx
  ON awcms_commerce_catalog_import_batches (tenant_id);

-- The (tenant, cursor) composite the generic purge engine filters + orders by
-- (`created_at` cursor: an append-only audit-shaped table).
CREATE INDEX IF NOT EXISTS awcms_commerce_catalog_import_batches_tenant_created_idx
  ON awcms_commerce_catalog_import_batches (tenant_id, created_at);

ALTER TABLE awcms_commerce_catalog_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_catalog_import_batches FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_catalog_import_batches_tenant_isolation
  ON awcms_commerce_catalog_import_batches
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Retention purge (`data-lifecycle:archive-purge`, as `awcms_worker`) —
-- `commerce/module.ts`'s `commerce.catalog_import_batches` descriptor.
GRANT SELECT, DELETE ON awcms_commerce_catalog_import_batches TO awcms_worker;
