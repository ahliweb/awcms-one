-- Issue #268 (IRMbyDUS: media-library private object class + presigned GET)
-- — the TENTH `media_library.media.*` permission, `download`.
--
-- ## Why a new permission, not reuse of `media_library.media.read`
--
-- `media.read` gates metadata (`GET /api/v1/media/objects`,
-- `GET /api/v1/media/objects/list`) — knowing an object exists, its status,
-- its alt text. `download` gates a materially different, higher-value
-- capability: minting a short-lived, credential-bearing URL that serves the
-- actual BYTES of a `visibility: "private"` object, bypassing the object's
-- lack of a permanent public URL entirely for the life of that URL. Folding
-- this into `media.read` would silently hand every read-only integration
-- (including a machine credential, ADR-0049 — `media.read` is explicitly
-- read-only-safe for one) the ability to exfiltrate private-object bytes on
-- demand.
--
-- Reachable from `GET /api/v1/media/objects/{id}/download-url`
-- (`src/pages/api/v1/media/objects/[id]/download-url.ts`), the staff/tenant
-- side of the issuance flow — same "declared and enforced in the same
-- change" rule `media-permissions.ts`'s header states after `attach`/
-- `detach` survived three reviews granted-but-unchecked. This is the ONLY
-- gate on that route: a tenant user holding `media.download` may fetch a
-- signed URL for ANY object (public or private) in their own tenant they can
-- already `media.read` — no commerce entitlement applies to tenant staff,
-- who administer the tenant's own content rather than purchasing it. The
-- CUSTOMER-facing path (`GET /api/v1/commerce/storefront/products/{id}/
-- download`) is entitlement-gated instead (`commerce-entitlement-
-- directory.ts`'s `verifyEntitlement`), not RBAC/ABAC-gated at all — storefront
-- customers sit outside the tenant_user RBAC/ABAC vocabulary entirely
-- (ADR-0016 D1), the same reason `commerce`'s storefront account routes
-- (`storefront/account/entitlements/*`) never call `authorizeInTransaction`
-- either.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('media_library', 'media', 'download',
   'Issue a short-lived presigned GET URL for a media object (public or private) — see media_library.media.read for metadata-only access')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
