-- Issue #116 (epic #33 C7, contract #106 D6) — the ONE new permission POS
-- needs: `commerce.pos.create`, gating `POST /api/v1/commerce/pos/orders`
-- (the counter-sale write). The history read (`GET .../pos/orders`) is
-- gated on the EXISTING `commerce.orders.read` (`sql/914`'s seed) — the
-- contract's own OpenAPI note states this explicitly, and seeding a second,
-- narrower read permission with nothing distinct to enforce would repeat the
-- "permission with no enforcing code" defect class `commerce-permissions.ts`'s
-- own header warns against.

INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'pos', 'create', 'Create a counter (POS) sale — the only order-creation path that requires a permission at all')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
