-- Permission catalog row for the customer-push diagnostics (Issue #430,
-- ADR-0048 Q10). One activity code, `customer_push`, with `read` only: the
-- answer is AGGREGATE counts by status and purpose, never a device, an endpoint,
-- a token or a customer identifier. Mirrors `module.ts`'s `permissions` array
-- and `domain/customer-push-permissions.ts`; `access:permissions:enforcement:check`
-- fails if the row has no enforcing route (`GET /api/v1/commerce/customer-push/diagnostics`).
--
-- There is deliberately NO staff `create`/`update`/`delete`: a device is
-- enrolled and revoked only by the customer who holds it (self-service by
-- construction, ADR-0048 section 4); staff have no screen over customer devices
-- in v1.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'customer_push', 'read', 'Read aggregate customer Web Push diagnostics: counts by status and purpose, no device or customer identifiers (Issue #430)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
