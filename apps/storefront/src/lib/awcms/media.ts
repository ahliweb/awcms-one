/**
 * The `media_library` read client (issue #47) — batch-resolves a media
 * object id to its public reference (URL, alt text, dimensions, credit), and
 * reads the deployment's media public origin for the CSP artifact
 * (`src/pages/csp.json.ts`). Same discipline as every other file in
 * `src/lib/awcms/`: this is the ONE place that knows a path, a query
 * parameter, or an envelope key for these two resources — everything above
 * it (`src/lib/berita.ts`, `src/lib/portable-text.ts`, then every page) gets
 * a plain, already-resolved `ResolvedMedia` back, never an id it has to
 * chase down itself.
 *
 * ## Every shape below is read from the route/application code, not the
 * issue text alone
 *
 * - `GET /api/v1/media/objects?ids=<uuid>,<uuid>` —
 *   `apps/cms/src/pages/api/v1/media/objects/index.ts`. At most 100 ids per
 *   call (`MAX_IDS` there); a caller that sends more gets a 400, so this
 *   file chunks rather than ever sending more. Envelope: `ok({ items,
 *   unresolved })`, verified field-by-field against `ResolvedMediaReference
 *   DTO` (`_shared/ports/media-library-port.ts`): `publicUrl`, `altText`,
 *   `mimeType`, `width`, `height`, `sizeBytes`, `creditLine`, `sourceName`,
 *   `copyrightStatus`. This app only ever renders `publicUrl`/`altText`/
 *   `width`/`height`/`creditLine`/`sourceName`/`copyrightStatus` — `mimeType`
 *   and `sizeBytes` have no reader here, so `ResolvedMedia` below does not
 *   carry them.
 * - `GET /api/v1/media/public-origin` —
 *   `apps/cms/src/pages/api/v1/media/public-origin.ts`. The ONE verified,
 *   purpose-built source for the media host `src/pages/csp.json.ts` widens
 *   `img-src` with — that route's own docblock explains why reading the
 *   origin off an already-resolved `publicUrl` does not work for a build
 *   with zero images. `configured: false` (an LAN/offline deployment with no
 *   public media bucket) is a real, valid state, not an error — the CSP
 *   artifact simply omits the entry.
 *
 * ## Unresolved ids are rendered as no image, never a broken `<img>`
 *
 * An id that does not resolve (unknown, cross-tenant, soft-deleted, or not
 * yet verified — `apps/cms`'s own docblock) comes back in the route's
 * `unresolved` array. `resolveMedia` below simply omits it from the returned
 * map; every caller (`src/lib/berita.ts`) already treats "not in the map" as
 * "no image", the same degrade `src/lib/awcms/blog.ts`'s ad placements and
 * institutions already use for their own missing-data cases. The FIRST time
 * a given id is reported unresolved, it is logged once (`console.warn`) so a
 * genuinely broken CMS reference is visible in a build log rather than
 * silently swallowed — logged once, not once per call, because the same
 * dangling id can legitimately be referenced by many posts in one build.
 *
 * ## Memoisation
 *
 * A resolved id is cached for the rest of this build — the SAME per-build
 * memoisation shape `src/lib/awcms/blog.ts` uses for its whole-resource
 * fetches, just keyed per id instead of per resource. In practice
 * `src/lib/berita.ts` calls `resolveMedia` exactly once, with every id the
 * whole build's posts reference, batched and chunked here — but the cache
 * makes a second caller (or a second `resolveMedia` call with an overlapping
 * id set) free rather than a silent second network round trip.
 */
import { AwcmsApiError, awcmsGet } from "./client";

const MEDIA_OBJECTS_PATH = "/api/v1/media/objects";
const MEDIA_PUBLIC_ORIGIN_PATH = "/api/v1/media/public-origin";

/** `GET /api/v1/media/objects` accepts at most this many ids per call (`MAX_IDS`, that route's own file) — sending more is a 400, not a partial success. */
const MAX_IDS_PER_CALL = 100;

/**
 * One media object, trimmed to the fields this app ever renders — verified
 * against `ResolvedMediaReferenceDTO` (`_shared/ports/media-library-port.ts`,
 * `apps/cms`). `creditLine`/`sourceName`/`copyrightStatus` are `null`
 * whenever the underlying object's rights are not `'verified'` (that DTO's
 * own fail-closed rule) — this app never sees the difference between "no
 * credit was ever entered" and "a credit exists but is not verified yet",
 * which is the point: nothing here can print an unverified credit.
 */
export type ResolvedMedia = {
  id: string;
  publicUrl: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  creditLine: string | null;
  sourceName: string | null;
  copyrightStatus:
    | "unknown"
    | "owned"
    | "licensed"
    | "public_domain"
    | "permission_granted"
    | "fair_use"
    | null;
};

type RawResolvedMediaItem = {
  id: string;
  publicUrl: string;
  altText: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  creditLine: string | null;
  sourceName: string | null;
  copyrightStatus: ResolvedMedia["copyrightStatus"];
};

function toResolvedMedia(raw: RawResolvedMediaItem): ResolvedMedia {
  return {
    id: raw.id,
    publicUrl: raw.publicUrl,
    alt: raw.altText,
    width: raw.width,
    height: raw.height,
    creditLine: raw.creditLine,
    sourceName: raw.sourceName,
    copyrightStatus: raw.copyrightStatus
  };
}

function isExpectedRefusal(error: unknown): error is AwcmsApiError {
  return (
    error instanceof AwcmsApiError &&
    (error.status === 403 || error.status === 404)
  );
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

/** Resolved-so-far, keyed by id — see file header's "Memoisation". */
const resolvedCache = new Map<string, ResolvedMedia>();
/** Ids the CMS has already reported unresolved, so a second reference to the same dangling id neither re-fetches nor re-logs. */
const unresolvedIds = new Set<string>();

/**
 * Batch-resolves `ids` (duplicates and empty strings dropped) to their
 * public reference. Never throws for an individual unresolved id — only a
 * genuine transport/authorization failure (anything that is not a 403/404,
 * which degrades to "resolve nothing") reaches the caller as a throw, the
 * same posture `src/lib/awcms/blog.ts` already applies to its own optional
 * reads (ad placements, institutions).
 */
export async function resolveMedia(
  ids: Iterable<string | null | undefined>
): Promise<ReadonlyMap<string, ResolvedMedia>> {
  const distinct = [
    ...new Set(
      [...ids].filter((id): id is string => typeof id === "string" && id.length > 0)
    )
  ];

  const toFetch = distinct.filter(
    (id) => !resolvedCache.has(id) && !unresolvedIds.has(id)
  );

  for (const idsChunk of chunk(toFetch, MAX_IDS_PER_CALL)) {
    try {
      const { items, unresolved } = await awcmsGet<{
        items: RawResolvedMediaItem[];
        unresolved: string[];
      }>(MEDIA_OBJECTS_PATH, { ids: idsChunk.join(",") });

      for (const item of items) resolvedCache.set(item.id, toResolvedMedia(item));

      for (const id of unresolved) {
        if (!unresolvedIds.has(id)) {
          console.warn(
            `[media] media object ${id} did not resolve to a public reference ` +
              `(unknown, cross-tenant, soft-deleted, or not yet verified) — ` +
              `rendering no image wherever it is referenced.`
          );
        }
        unresolvedIds.add(id);
      }
    } catch (error) {
      // A 403/404 means this tenant/deployment cannot read media_library at
      // all (the permission is missing, or the module is off) — the same
      // "optional editorial inventory" degrade `blog.ts` already applies to
      // ad placements: every id in this chunk renders as no image rather
      // than failing the whole build over supplementary imagery.
      if (!isExpectedRefusal(error)) throw error;
      for (const id of idsChunk) unresolvedIds.add(id);
    }
  }

  const result = new Map<string, ResolvedMedia>();
  for (const id of distinct) {
    const resolved = resolvedCache.get(id);
    if (resolved) result.set(id, resolved);
  }
  return result;
}

/** Convenience for a single id (a post's `featuredMediaId`, say) — `null` for a `null` id or one that did not resolve. */
export async function resolveOneMedia(
  id: string | null | undefined
): Promise<ResolvedMedia | null> {
  if (!id) return null;
  const resolved = await resolveMedia([id]);
  return resolved.get(id) ?? null;
}

/** The shape `GET /api/v1/media/public-origin` answers — mirrors `MediaPublicOrigin` (`apps/cms`'s `domain/media-public-origin.ts`) field for field. */
export type MediaPublicOrigin = {
  configured: boolean;
  origin: string | null;
  baseUrl: string | null;
};

const UNCONFIGURED: MediaPublicOrigin = { configured: false, origin: null, baseUrl: null };

let mediaPublicOriginCache: Promise<MediaPublicOrigin> | undefined;

/**
 * The media host `src/pages/csp.json.ts` widens `img-src` with — fetched
 * once and memoized for the whole build (same shape as every other
 * once-per-build read in `src/lib/awcms/`). A 403/404 degrades to
 * `UNCONFIGURED`, the same state the route itself reports for a deployment
 * with no public media bucket — this app cannot tell "the module refused"
 * from "there is genuinely nothing to widen the policy for", and treating
 * both as "add no origin" is the fail-closed direction (see `apps/cms`'s own
 * docblock: a wrong-but-present origin in a CSP header is worse than none).
 */
export function getMediaPublicOrigin(): Promise<MediaPublicOrigin> {
  mediaPublicOriginCache ??= fetchMediaPublicOrigin();
  return mediaPublicOriginCache;
}

async function fetchMediaPublicOrigin(): Promise<MediaPublicOrigin> {
  try {
    return await awcmsGet<MediaPublicOrigin>(MEDIA_PUBLIC_ORIGIN_PATH);
  } catch (error) {
    if (isExpectedRefusal(error)) return UNCONFIGURED;
    throw error;
  }
}

/** Test/build seam: drops every memoized/cached state in this file. */
export function resetMediaCachesForTests(): void {
  resolvedCache.clear();
  unresolvedIds.clear();
  mediaPublicOriginCache = undefined;
}
