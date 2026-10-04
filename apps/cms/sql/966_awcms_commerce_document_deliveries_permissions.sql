-- Issue #295 (ADR-0034) — permission catalog seed for transactional document
-- delivery, mirroring `src/modules/commerce/module.ts`'s `permissions` array
-- exactly (see `sql/902`'s header for the reasoning this migration does not
-- repeat: global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing
-- tenants do not retroactively gain these).
--
-- Deliberately SEPARATE, resource-split keys using existing `AccessAction`
-- verbs only (the upstream-owned union is not widened), none implied by
-- `commerce.documents.*`, `commerce.quotations.*` or `commerce.work_orders.*`
-- (being allowed to READ a receipt is not being allowed to e-mail it to a
-- stranger) and none implied by each other:
--
--   * `commerce.document_deliveries.read`   — the delivery history of a document.
--   * `commerce.document_deliveries.create` — request a delivery (send / re-send)
--     to the recipient the source already names.
--   * `commerce.document_delivery_overrides.create` — send to a recipient the
--     source does NOT name (a typed-in address or number). The exfiltration
--     path of this feature, so it is its own key: a cashier may re-send a
--     receipt to the customer on file without being able to point a customer's
--     purchase history at an arbitrary address.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'document_deliveries', 'read', 'Read the delivery history of a commercial document (Issue #295)'),
  ('commerce', 'document_deliveries', 'create', 'Send or re-send a commercial document to the customer on file by e-mail or WhatsApp (Issue #295)'),
  ('commerce', 'document_delivery_overrides', 'create', 'Send a commercial document to a recipient other than the customer on file (Issue #295)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
