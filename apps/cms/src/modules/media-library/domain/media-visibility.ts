/**
 * Media object visibility class (Issue #268, IRMbyDUS: media-library private
 * object class + presigned GET). Pure — no I/O.
 *
 * `"public"` is the ONLY class this registry had before this issue: every
 * row got a permanent `public_url` (`media-object-key.ts`'s
 * `buildNewsMediaPublicUrl`), built once at `createPendingNewsMediaObject`
 * time from the trusted, server-side `NEWS_MEDIA_R2_PUBLIC_BASE_URL`, and
 * every consumer (`media-library-port-adapter.ts`'s `resolveMediaReferences`,
 * `blog_content`'s reference-validation gates, the admin browse/picker
 * surfaces) treated that as a given.
 *
 * `"private"` is the new class this issue adds: a `visibility: "private"`
 * object NEVER gets a `public_url` at all — `sql/880`'s CHECK constraint
 * enforces `visibility = 'private' IMPLIES public_url IS NULL` at the schema
 * level, not merely as an application-layer convention, so a future bug
 * cannot silently persist a permanent URL for one. The only way to read a
 * private object's bytes is a short-lived presigned GET
 * (`infrastructure/media-r2-client.ts`'s `presignDownloadUrl`), issued
 * through an entitlement-gated flow (`commerce`'s
 * `commerce-entitlement-directory.ts`) — see
 * `docs/adr/0004-protected-pdf-private-storage-architecture.md`
 * (`web-irmbydus.com`) and FR-LIB-002/003/004.
 *
 * ## Every call site that used to assume "public" must now check this
 *
 * Adding a value here is cheap; the actual work of this issue is finding
 * every place that read `publicUrl`/called `isNewsMediaObjectSafeForPublicReference`
 * assuming the answer was always a public URL, and gating it on
 * `visibility === "public"` too. `isNewsMediaObjectSafeForPublicReference`
 * (`application/media-object-directory.ts`) now REQUIRES this value as a
 * second, non-defaulted parameter — a compile error at every call site is
 * what forces each one to be looked at, rather than a default that would
 * let a call site silently keep the old (unsafe-for-private) behavior.
 */
export const MEDIA_VISIBILITIES = ["public", "private"] as const;

export type MediaVisibility = (typeof MEDIA_VISIBILITIES)[number];

export function isMediaVisibility(value: unknown): value is MediaVisibility {
  return (
    typeof value === "string" &&
    (MEDIA_VISIBILITIES as readonly string[]).includes(value)
  );
}
