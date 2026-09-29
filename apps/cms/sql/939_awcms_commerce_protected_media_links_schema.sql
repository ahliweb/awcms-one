-- Issue #268 (IRMbyDUS: media-library private object class + presigned GET),
-- depends on #267/sql/936 (entitlements) and this issue's own `sql/168`
-- (media visibility). Next free number in the reserved commerce 9xx range
-- after `sql/938` (ADR-0015 in this repo — this migration adds a COMMERCE
-- table, `awcms_commerce_protected_media_links`, so it belongs in this range
-- rather than the ordinary upstream-owned one `sql/168`/`sql/169` use).
--
-- `awcms_commerce_protected_media_links` — the ONE fact this issue's
-- customer-facing download flow needs that neither existing table states:
-- which `visibility = 'private'` media object is THE protected content a
-- given product's entitlement gates.
--
-- ## Why a separate table, not a column on `awcms_commerce_products`
--
-- `awcms_commerce_products` already carries loose media references
-- (`size_chart_media_id`, `sql/904`) as plain nullable FK columns threaded
-- through the full product create/update/validation/view stack
-- (`product-directory.ts`/`product-validation.ts`). Doing the same here
-- would mean widening that entire stack (and its OpenAPI schema, and every
-- existing test asserting the product shape) for a field only the download
-- issuance path reads — real scope for a capability this issue does not
-- otherwise touch. A dedicated table keeps the blast radius to exactly the
-- one directory (`commerce/application/protected-media-directory.ts`) and
-- one route (`GET /api/v1/commerce/storefront/products/{id}/download`) that
-- actually need this fact.
--
-- ## Why this lives in `commerce`, not `media_library`
--
-- `media_library/module.ts`'s own header is explicit: "media must never
-- depend on its own consumers" (ADR-0036). A column/table naming a specific
-- COMMERCE product from inside `media_library` would be exactly that
-- inversion. `commerce` already declares `media_library` as a dependency
-- (Issue #23, product images) — the FK below is the same, already-precedented
-- direction (`sql/905`'s `media_object_id uuid NOT NULL REFERENCES
-- awcms_news_media_objects (id)`), not a new one.
--
-- ## One protected object per product (MVP) — a UNIQUE index, not a cap in
-- code
--
-- IRMbyDUS's MVP scope (ADR referenced above) is one protected PDF per
-- digital product. The unique index on `(tenant_id, product_id)` enforces
-- "at most one link per product" at the schema level; a product needing more
-- than one protected file is a real, later feature (multiple ordered
-- attachments), not a silent multi-row accumulation this table would
-- otherwise allow by omission.
--
-- ## No FK from `media_object_id` requiring `visibility = 'private'`
--
-- PostgreSQL CHECK constraints cannot reference another table, so "the
-- linked object must be private" is enforced in
-- `protected-media-directory.ts`'s application code (fail-closed: a link
-- pointing at a public object is treated as a misconfiguration and refused
-- at issuance time, never silently served), not here.
--
-- ## RLS / GRANT
--
-- Same shape as `sql/936`'s `awcms_commerce_entitlements`: `ENABLE` +
-- `FORCE`, one tenant-isolation `USING` policy, no per-table GRANT
-- (`sql/019`'s `ALTER DEFAULT PRIVILEGES` already covers `awcms_app`).

CREATE TABLE IF NOT EXISTS awcms_commerce_protected_media_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  product_id uuid NOT NULL REFERENCES awcms_commerce_products (id),
  media_object_id uuid NOT NULL REFERENCES awcms_news_media_objects (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_protected_media_links_product_key
  ON awcms_commerce_protected_media_links (tenant_id, product_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_protected_media_links_tenant_idx
  ON awcms_commerce_protected_media_links (tenant_id);

-- FK index — `media_object_id` is looked up directly by nothing today, but
-- every other FK column in this schema carries one (doc 10 convention) and a
-- future "which products does this media object gate" admin lookup will
-- need it.
CREATE INDEX IF NOT EXISTS awcms_commerce_protected_media_links_media_idx
  ON awcms_commerce_protected_media_links (tenant_id, media_object_id);

-- The (tenant, cursor) composite `commerce/module.ts`'s `dataLifecycle`
-- descriptor for this table requires — the generic purge engine's own
-- cursor-based filter/order shape (`data-lifecycle:table-coverage:check`).
CREATE INDEX IF NOT EXISTS awcms_commerce_protected_media_links_tenant_updated_idx
  ON awcms_commerce_protected_media_links (tenant_id, updated_at);

ALTER TABLE awcms_commerce_protected_media_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_protected_media_links FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_protected_media_links_tenant_isolation
  ON awcms_commerce_protected_media_links
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `awcms_worker` least-privilege role (sql/022) — `commerce/module.ts`'s
-- `dataLifecycle` descriptor for this table declares `executionMode:
-- "generic"`, and the generic purge/archive engine (`data-lifecycle:archive-
-- purge`) runs as `awcms_worker`: SELECT for its candidate-selection scan,
-- DELETE for the `hard_delete` mode that descriptor declares. Same shape
-- `sql/936`'s `awcms_commerce_entitlements` grant states for its own
-- (unreachable in practice, reachable here) hard-delete descriptor.
GRANT SELECT, DELETE ON awcms_commerce_protected_media_links TO awcms_worker;
