-- Issue #114 — permission catalog seed for the `campaigns` activity code
-- (contract #106 D9), mirroring `src/modules/commerce/module.ts`'s
-- `permissions` array exactly (see `sql/902`'s header for the full
-- reasoning this migration does not repeat: global catalog, idempotent via
-- `ON CONFLICT DO NOTHING`, existing tenants do not retroactively gain
-- these).
--
-- Three actions, not the usual two: `send` is split from `update` because
-- it is the one action that actually reaches a real inbox/phone — a role
-- trusted to draft/edit a campaign is not automatically trusted to fire (or
-- cancel) it. `send` gates both `POST .../{id}/send` and `POST
-- .../{id}/cancel` — one verb, one high-risk audience, the same choice
-- `commerce-permissions.ts`'s own header gives for `reviews`/
-- `affiliate_commissions`' moderation actions.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'campaigns', 'read', 'Read campaigns and preview their audience count'),
  ('commerce', 'campaigns', 'update', 'Create and edit a draft campaign'),
  ('commerce', 'campaigns', 'send', 'Send or cancel a campaign')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
