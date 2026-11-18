-- Issue #463 (ADR-0056 D6) - permission catalog rows for the CRM lead link. One
-- activity code, `crm_lead_links`, mirroring
-- `src/modules/commerce/domain/crm-lead-link.ts` and `module.ts`'s `permissions`
-- array. Global catalog, idempotent via `ON CONFLICT DO NOTHING`; existing roles
-- do not retroactively gain them (see `sql/914`'s header), an administrator
-- grants them.
--
--   * `read`    - list the links of the tenant (opaque ids and states).
--   * `create`  - confirm a lead's conversion to a customer on a verified
--                 commerce fact. The caller must ALSO hold
--                 `crm_leads.conversions.approve`: the port performs no access
--                 check, so the route authorizes both.
--   * `approve` - apply a reversal of a link (HIGH-RISK) through the port; the
--                 caller must also hold `crm_leads.conversions.approve`.
--
-- Existing `AccessAction` verbs only, so the upstream-owned union is not widened.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'crm_lead_links', 'read', 'List which CRM leads were confirmed as commerce customers, with the verified evidence kind and the link state (Issue #463)'),
  ('commerce', 'crm_lead_links', 'create', 'Confirm a CRM lead as a commerce customer on a verified commerce fact (a confirmed registration or a paid order); also requires crm_leads.conversions.approve (Issue #463)'),
  ('commerce', 'crm_lead_links', 'approve', 'Reverse a confirmed lead-to-customer link and its CRM conversion after the evidence order was cancelled or refunded; also requires crm_leads.conversions.approve (Issue #463)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
