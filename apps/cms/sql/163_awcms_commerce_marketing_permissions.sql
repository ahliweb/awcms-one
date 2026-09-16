-- Issue #26 — permission catalog seed for the marketing-surface activity
-- codes, mirroring `src/modules/commerce/domain/commerce-permissions.ts`'s
-- new constants exactly, one row per entry (a gate checks the two stay in
-- step — see `sql/154`'s header for the full shape/limitation this repeats:
-- global catalog only, existing tenants do not retroactively gain these,
-- idempotent via `ON CONFLICT DO NOTHING`).
--
-- Five CRUD activity codes (no `restore` — issue #26's own API list never
-- names one for these resources, and seeding an unenforced permission is
-- the same defect class `sql/154`'s header already warns against), plus
-- `settings.{read,update}` for the singleton store-settings row (no
-- `create`/`delete` — a singleton is upserted, never created/deleted as a
-- distinct action, the same two-action shape `sql/135`'s `site_profile.
-- profile.{read,update}` uses for the same reason).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'flash_sales', 'read', 'Read flash sale records, including the storefront active/scheduled read model'),
  ('commerce', 'flash_sales', 'create', 'Create flash sale records'),
  ('commerce', 'flash_sales', 'update', 'Update flash sale records, including their product lines'),
  ('commerce', 'flash_sales', 'delete', 'Soft-delete flash sale records'),
  ('commerce', 'vouchers', 'read', 'Read voucher records, including the public voucher list and the validate check'),
  ('commerce', 'vouchers', 'create', 'Create voucher records'),
  ('commerce', 'vouchers', 'update', 'Update voucher records'),
  ('commerce', 'vouchers', 'delete', 'Soft-delete voucher records'),
  ('commerce', 'sliders', 'read', 'Read slider records, including the storefront active read model'),
  ('commerce', 'sliders', 'create', 'Create slider records'),
  ('commerce', 'sliders', 'update', 'Update slider records'),
  ('commerce', 'sliders', 'delete', 'Soft-delete slider records'),
  ('commerce', 'testimonials', 'read', 'Read testimonial records, including the storefront active read model'),
  ('commerce', 'testimonials', 'create', 'Create testimonial records'),
  ('commerce', 'testimonials', 'update', 'Update testimonial records'),
  ('commerce', 'testimonials', 'delete', 'Soft-delete testimonial records'),
  ('commerce', 'popups', 'read', 'Read popup records, including the storefront active read model'),
  ('commerce', 'popups', 'create', 'Create popup records'),
  ('commerce', 'popups', 'update', 'Update popup records'),
  ('commerce', 'popups', 'delete', 'Soft-delete popup records'),
  ('commerce', 'settings', 'read', 'Read this tenant''s store settings, unmasked (bank accounts, QRIS media)'),
  ('commerce', 'settings', 'update', 'Change this tenant''s store settings')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
