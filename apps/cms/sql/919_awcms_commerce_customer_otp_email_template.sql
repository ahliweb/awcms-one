-- Seeds the `derived.commerce_customer_otp` e-mail template (EN+ID) for
-- every tenant that already exists (Issue #89, contract #86/ADR-0016 D2).
--
-- Why a migration rather than a one-off seed script call like the base
-- categories' `email:templates:seed-defaults`: that command needs an
-- `actorTenantUserId` (a real staff member "created" the template) and is
-- invoked per tenant, by an operator, after the tenant exists. A customer
-- OTP template is not tenant-customized copy an admin is expected to write —
-- it is infrastructure this feature cannot work without, the same way
-- `awcms_commerce_store_settings` ships a default row rather than waiting for
-- an admin to create one. `created_by`/`updated_by` are `uuid NOT NULL` with
-- no FK (sql/014) — a well-known nil UUID is a defensible platform actor for
-- a row nobody, in particular, authored.
--
-- `ON CONFLICT ... DO NOTHING` on the existing partial unique index
-- (`awcms_email_templates_tenant_key_idx`, `sql/014`) makes this re-runnable
-- and never overwrites a tenant that has already customised its own copy of
-- this template (soft-deleted rows do not block a fresh insert, matching
-- every other soft-delete-then-reuse convention in this repo).
--
-- New tenants created AFTER this migration do not get a row from here —
-- `application/customer-otp-channel-adapters.ts`'s `email` adapter answers
-- `sent: false` for a tenant with no active template (audited, not surfaced
-- to the caller, ADR-0016's anti-enumeration rule), and a tenant's
-- provisioning flow is the right place to seed one, not a migration that
-- only ever runs once.
INSERT INTO awcms_email_templates (
  tenant_id, template_key, name, subject_template, text_body_template,
  created_by, updated_by
)
SELECT
  t.id,
  'derived.commerce_customer_otp',
  'Customer OTP',
  '{"en": "Your verification code", "id": "Kode verifikasi Anda"}'::jsonb,
  '{"en": "Your verification code is {{code}}. It expires in {{expiresInMinutes}} minutes.\n\n{{storeName}}", "id": "Kode verifikasi Anda adalah {{code}}. Kode ini kedaluwarsa dalam {{expiresInMinutes}} menit.\n\n{{storeName}}"}'::jsonb,
  '00000000-0000-0000-0000-000000000000'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid
FROM awcms_tenants t
ON CONFLICT (tenant_id, template_key) WHERE deleted_at IS NULL DO NOTHING;
