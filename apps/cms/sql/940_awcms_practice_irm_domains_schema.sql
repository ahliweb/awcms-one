-- Issue #270 (IRMbyDUS: practice-irm module, ADR-0002 in `web-irmbydus.com`)
-- — `awcms_practice_irm_domains`: the five canonical IRM domains (IDENTIFY /
-- NEUTRALIZE / NAVIGATE / EMBED / REINFORCE) as CMS-EDITABLE content, never a
-- hardcoded string table. Next free number in the shared reserved `9xx`
-- range, immediately after `commerce`'s own migrations (`sql/938`) —
-- ADR-0024 extends ADR-0015's `commerce`-only rule to `practice_irm` too,
-- since it is local-only (`awcms-one`-specific, never in upstream `awcms`)
-- for the same reason `commerce` is, AND (see `sql/941`'s header)
-- `awcms_practice_irm_sessions` has a real FK dependency on `commerce`'s own
-- tables that only exist at `9xx`. Follows `sql/936`'s conventions exactly (`ENABLE`
-- + `FORCE ROW LEVEL SECURITY`, one tenant-isolation `USING` policy, `id
-- uuid` PK `DEFAULT gen_random_uuid()`, `created_at`/`updated_at timestamptz
-- DEFAULT now()`, an FK index for every FK column, no per-table GRANT —
-- `sql/019`'s `ALTER DEFAULT PRIVILEGES` already covers `awcms_app`).
--
-- ## Why this table exists: preventing terminology drift
--
-- PRD's Major Risks table (`redesign/PRD_IRMbyDUS_v1.0.md` §40) names "IRM
-- terminology drift" as High-impact, mitigated by "source-authoritative
-- content review". ADR-0002's Consequences record the rule this table
-- enforces: "IRM content edits happen once, in the CMS admin, not in
-- frontend code." `web-irmbydus.com` renders whatever
-- `GET /api/v1/practice-irm/domains` returns and holds no independent copy
-- of a domain's name/description/copy — so a wording correction ships as one
-- admin edit here, never a frontend deploy.
--
-- ## `deleted_at` means "reset to the built-in default", not "gone"
--
-- Same convention `awcms_commerce_store_settings` established (`sql/910`'s
-- header): the application layer's `DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT`
-- (`src/modules/practice-irm/domain/practice-irm-domain-content.ts`) is the
-- fallback every read path falls back to for a `domain_key` with no LIVE
-- row — so "delete" can never leave the public copy blank, only revert it to
-- the source-authoritative baseline. `DELETE /api/v1/practice-irm/domains/
-- {domainKey}` sets `deleted_at`; nothing in this module issues a real SQL
-- `DELETE` against this table.
--
-- ## RLS: tenant isolation only — this table is NOT customer-owned
--
-- Unlike `awcms_practice_irm_sessions` (`sql/941`), this table is
-- tenant-STAFF-authored content with no customer/owner dimension at all —
-- one tenant-isolation `USING` policy is the whole story here.
CREATE TABLE IF NOT EXISTS awcms_practice_irm_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  domain_key text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  copy text NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_practice_irm_domains_domain_key_check
    CHECK (domain_key IN ('identify', 'neutralize', 'navigate', 'embed', 'reinforce'))
);

-- At most one LIVE row per (tenant, domain_key) — a partial unique index
-- rather than a plain one, since `deleted_at` (a "reset" row) must be free
-- to coexist with a later re-created live row for the same key.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_practice_irm_domains_tenant_key_live_idx
  ON awcms_practice_irm_domains (tenant_id, domain_key)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_practice_irm_domains_tenant_idx
  ON awcms_practice_irm_domains (tenant_id);

-- The (tenant, cursor) composite the generic data-lifecycle purge engine
-- filters + orders by (`module.ts`'s `dataLifecycle` descriptor).
CREATE INDEX IF NOT EXISTS awcms_practice_irm_domains_tenant_deleted_idx
  ON awcms_practice_irm_domains (tenant_id, deleted_at);

ALTER TABLE awcms_practice_irm_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_practice_irm_domains FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_practice_irm_domains_tenant_isolation
  ON awcms_practice_irm_domains
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
