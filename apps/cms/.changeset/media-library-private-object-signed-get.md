---
"awcms": minor
---

feat(media-library): private object visibility class + presigned GET issuance (Issue #268, IRMbyDUS)

`awcms_news_media_objects` gains a `visibility` column (`public`/`private`, `sql/168`) — a `private` object never derives a permanent `public_url` (`public_url` is now nullable, with a CHECK enforcing `visibility = 'private' IMPLIES public_url IS NULL` at the schema level, not just by convention). Every call site that used to assume every object was public was updated to check `visibility` too: `isNewsMediaObjectSafeForPublicReference` (`media-object-directory.ts`) now requires `visibility` as a second, non-defaulted parameter, and `media-library-port-adapter.ts`'s `resolveMediaReferences`/`isMediaReferenceSafe`, `blog_content`'s `ad-placement-directory.ts`/`ad-placement-reference-validation.ts`/`homepage-section-reference-validation.ts`, and `scripts/blog-ads-ingest.ts` were all updated to pass it. `POST /api/v1/media/news-images/upload-sessions` gains an optional `visibility` field (default `public`) — the only way to create a private object.

`infrastructure/media-r2-client.ts` gains `presignDownloadUrl` — a presigned GET, TTL-clamped server-side to at most 900 seconds (`NEWS_MEDIA_R2_MAX_PRESIGNED_DOWNLOAD_TTL_SECONDS`, `media-r2-config.ts`, mirroring the existing upload-TTL bounding pattern) regardless of what a caller requests.

Two issuance surfaces implement `Authentication → Authorization → Entitlement Verification → signed GET URL`:

- `GET /api/v1/media/objects/{id}/download-url` (`media_library`) — the STAFF/tenant-user side: Authentication (session) → Authorization (ABAC, the new `media_library.media.download` permission, `sql/169`) → signed URL. Works for either visibility class; no commerce entitlement applies (staff administer the tenant's own content, they do not purchase it).
- `GET /api/v1/commerce/storefront/products/{productId}/download` (`commerce`) — the CUSTOMER side: Authentication (customer bearer session) → Authorization (the blocked-account gate every other bearer-secured storefront route already applies — customers sit outside the tenant_user RBAC/ABAC vocabulary, ADR-0016 D1) → Entitlement Verification (`verifyEntitlement`, resolving the gated media object from a new `awcms_commerce_protected_media_links` table, `sql/939`, never from a caller-supplied media object id) → signed URL. Missing entitlement is `403 ENTITLEMENT_REQUIRED` with no `url` field anywhere in the body — never a broken link, never a URL of any kind. `PUT/DELETE /api/v1/commerce/products/{id}/protected-media` (gated on `commerce.products.update`) manages the link.

Every issuance decision that reaches a real object is audited (`media.download`, `logging/application/audit-log.ts`) — success and entitlement-denial alike, since issuance (not the R2 GET itself) is the auditable moment.

Directly implements FR-LIB-002/003/004: no permanent public URL for protected content, and the full auth → authz → entitlement → temporary-access chain.
