-- Issue #111 — permission catalog seed for the `conversations` activity code
-- (contract #106 D8), mirroring `src/modules/commerce/module.ts`'s
-- `permissions` array exactly (see `sql/902`'s header for the full
-- reasoning this migration does not repeat: global catalog, idempotent via
-- `ON CONFLICT DO NOTHING`, existing tenants do not retroactively gain
-- these).
--
-- `read`/`update` only — no `create`/`delete` action, deliberately: a
-- conversation is created only through the shopper's own bearer-secured
-- `POST .../account/conversations` (no admin "start a conversation on a
-- customer's behalf" route), and there is no hard-delete route either. Same
-- "no permission with nothing to enforce it" reasoning
-- `commerce-permissions.ts`'s own header already applies to `orders`/
-- `customers`/`affiliates`. `update` also gates the close/reopen status
-- transition and the staff reply.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'conversations', 'read', 'Read customer conversations and their messages'),
  ('commerce', 'conversations', 'update', 'Reply on a conversation and close/reopen it')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
