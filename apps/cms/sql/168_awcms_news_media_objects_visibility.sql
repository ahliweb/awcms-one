-- Issue #268 (IRMbyDUS: media-library private object class + presigned GET)
-- — adds a `visibility` class to `awcms_news_media_objects` (`sql/041`).
-- Next free NON-commerce number after `sql/167` (this repo's reserved
-- commerce range is 900-999 — ADR-0015 in this repo, `commerce-migrations-
-- range.test.ts` — and this migration touches no commerce table, so it lives
-- in the ordinary upstream-owned range instead).
--
-- ## Why `public_url` becomes NULLABLE, not just conditionally unused
--
-- Before this migration, `public_url text NOT NULL` was a promise every row
-- in this table made: "this object has a permanent URL". `media-public-
-- origin.ts`/`media-object-key.ts`'s `buildNewsMediaPublicUrl` and every
-- consumer of `media-library-port-adapter.ts`'s `resolveMediaReferences`
-- (`blog_content`, `commerce`'s product images/size charts/store settings,
-- `seo_distribution`) were written against that invariant. A `visibility`
-- column ALONE — with `public_url` still `NOT NULL` — would force the
-- application layer to invent a placeholder value for a private object's
-- "permanent URL" that must never be served, which is exactly the kind of
-- landmine `application/media-object-directory.ts`'s own header warns
-- against elsewhere in this codebase (a value that LOOKS like every other
-- row's but means something categorically different).
--
-- Making the column nullable, and adding
-- `awcms_news_media_objects_visibility_public_url_check` below, makes the
-- database itself refuse to persist a `('private', <non-null public_url>)`
-- row — the invariant "a private object never has a permanent URL" holds
-- even if a future application-layer bug tries to violate it, not merely by
-- convention. `createPendingNewsMediaObject` (`media-object-directory.ts`)
-- now passes `NULL` for `public_url` on the private path, never a
-- placeholder.
--
-- ## Default `'public'` — every row this table already holds
--
-- Every row created before this migration was, structurally, exactly what
-- `visibility = 'public'` describes today (a permanent, resolvable URL) —
-- so the default backfills existing rows correctly with no data migration
-- needed, and every existing `INSERT`/query that does not yet know about
-- this column keeps its current behavior.
--
-- ## Why an app-layer CHECK on `visibility` too
--
-- `application/media-object-directory.ts`'s `isNewsMediaObjectSafeForPublicReference`
-- and `media-library-port-adapter.ts`'s `resolveMediaReferences`/
-- `isMediaReferenceSafe` are the PRIMARY enforcement point (same "primary
-- enforcement is the application layer, the CHECK is defense in depth"
-- posture `object_key_format_check` in `sql/041` already documents) — this
-- migration's constraint is the second, structural line of defense that
-- holds even if a future code path bypasses that function.

ALTER TABLE awcms_news_media_objects
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public';

ALTER TABLE awcms_news_media_objects
  ALTER COLUMN public_url DROP NOT NULL;

ALTER TABLE awcms_news_media_objects
  ADD CONSTRAINT awcms_news_media_objects_visibility_check
    CHECK (visibility IN ('public', 'private'));

-- A private object never has a permanent public URL; a public object always
-- does (an already-inserted public row's `public_url` is never later
-- cleared). Structural enforcement of FR-LIB-002 ("no permanent public URL
-- for premium content").
ALTER TABLE awcms_news_media_objects
  ADD CONSTRAINT awcms_news_media_objects_visibility_public_url_check
    CHECK (
      (visibility = 'public' AND public_url IS NOT NULL) OR
      (visibility = 'private' AND public_url IS NULL)
    );

-- Issuance-flow lookup shape ("give me this tenant's private, downloadable
-- objects") — highly selective (`visibility = 'private'` is expected to be a
-- small minority of any tenant's registry), so a partial index scoped to it
-- plus the already-excluded soft-deleted rows.
CREATE INDEX IF NOT EXISTS idx_awcms_news_media_objects_tenant_private
  ON awcms_news_media_objects (tenant_id, id)
  WHERE deleted_at IS NULL AND visibility = 'private';
