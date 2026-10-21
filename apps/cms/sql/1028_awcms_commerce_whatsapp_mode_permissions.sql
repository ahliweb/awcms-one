-- Permission catalog rows for the guarded per-tenant WhatsApp mode flip (Issue
-- #393, ADR-0133 section 6 phase 3, downstream ADR-0047 "Cutover"). ONE file, two
-- rows, existing `AccessAction` verbs only (the upstream-owned union is not
-- widened), no table and no data movement. It depends on nothing but
-- `awcms_permissions`, so by ADR-0037 D2 it is safe at `1028` whatever order a
-- fresh or an already-migrated database applies it in.
--
--   commerce.whatsapp_mode.read     read the tenant's WhatsApp mode and the drain
--                                   state of both queues
--                                   (`GET /api/v1/commerce/whatsapp/mode`)
--   commerce.whatsapp_mode.manage   flip the mode or dry-run a flip
--                                   (`POST /api/v1/commerce/whatsapp/mode`;
--                                   high-risk: it moves every OTP, receipt and
--                                   campaign of the tenant to the other queue)
--
-- Neither is implied by `commerce.whatsapp.read` (which lists the legacy outbox)
-- or by `commerce.settings.*`: "may see the messages" is not "may choose which
-- queue sends them". Mirrors `module.ts`'s `permissions` array and
-- `domain/commerce-permissions.ts`'s COMMERCE_WHATSAPP_MODE_* constants;
-- `access:permissions:enforcement:check` fails if a row here has no enforcing
-- route. Existing tenants run `bun run identity-access:permissions:backfill`.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'whatsapp_mode', 'read', 'Read the tenant WhatsApp delivery mode and the drain state of both queues (Issue #393)'),
  ('commerce', 'whatsapp_mode', 'manage', 'Flip the tenant WhatsApp delivery mode between the legacy and upstream queues, or dry-run the flip (Issue #393)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
