/**
 * Institution ("Mitra") convenience reads for issue #28's `/mitra/[slug]` —
 * a thin layer over `src/lib/awcms/blog.ts`'s `getAllInstitutions()` that
 * adds the one thing that file deliberately does not: a region NAME, via
 * `src/lib/awcms/wilayah.ts`.
 *
 * ## The logo, as of issue #59
 *
 * Issue #28 recorded here that `RawInstitution` carried no logo field at
 * all, so `/mitra/[slug]` rendered name/description/posts and no emblem.
 * That is no longer true: upstream awcms#806 added `logo_media_id`/
 * `logo_alt` to `awcms_blog_institutions` and exposed them on
 * `/api/v1/blog/institutions`, and this repo received them through the
 * `apps/cms` subtree pull (#59 step 2). `MitraSummary` therefore carries a
 * RESOLVED emblem (`logoMediaId` → `resolveMedia`, issue #47's client), and
 * both `/mitra/[slug]` and the article page render it.
 *
 * Both fields stay OPTIONAL on `RawInstitution`: a build pointed at an
 * `apps/cms` older than that pull gets no field at all and must render no
 * emblem rather than crash.
 *
 * ## No Pemprov/DPRD/Pemkab/Pemko field
 *
 * The issue's reference IA names these four institution "types", but
 * `InstitutionView` only ever carries `branch: "legislative" | "executive"`
 * — verified against `institution-validation.ts`. Those four labels are an
 * editorial naming CONVENTION inside `name`/`slug` ("DPRD Kapuas", "Pemkab
 * Kapuas"), not a modeled field this app can group by. `/mitra/[slug]`
 * groups institutions by `branch` only, and shows the CMS-authored `name`
 * verbatim for the rest.
 */
import { getAllInstitutions, type RawInstitution } from "./blog";
import { resolveMedia, type ResolvedMedia } from "./media";
import { resolveRegion } from "./wilayah";

export type MitraSummary = {
  slug: string;
  name: string;
  branch: "legislative" | "executive";
  description: string | null;
  regionName: string | null;
  /** The institution's emblem, resolved to a public URL — `null` when it has none, or when a stale id resolves to nothing. */
  logo: ResolvedMedia | null;
  /** Alt text for the emblem; `null` means decorative beside the name it sits next to. */
  logoAlt: string | null;
};

let mitraCache: Promise<MitraSummary[]> | undefined;

/** Every institution, with its region resolved to a name where possible — fetched once and memoized. */
export function getMitraList(): Promise<MitraSummary[]> {
  mitraCache ??= buildMitraList();
  return mitraCache;
}

async function buildMitraList(): Promise<MitraSummary[]> {
  const institutions = await getAllInstitutions();

  // One batched resolve for every emblem in the list — the same posture
  // `src/lib/berita.ts` takes for post images, and the reason this is not
  // done inside the per-institution map below.
  const logoById = await resolveMedia(
    institutions.map((i) => i.logoMediaId).filter((id): id is string => Boolean(id))
  );

  return Promise.all(
    institutions.map(async (institution) => {
      const region = institution.regionCode ? await resolveRegion(institution.regionCode) : null;
      return toMitraSummary(
        institution,
        region?.name ?? null,
        institution.logoMediaId ? logoById.get(institution.logoMediaId) ?? null : null
      );
    })
  );
}

/**
 * Pure — `RawInstitution` + an already-resolved region name → `MitraSummary`.
 * Split out from the async region lookup above specifically so this
 * mapping is unit-testable with no network
 * (`tests/berita-rubrik.test.ts`'s "institution slug mapping" coverage):
 * unlike a region (`src/lib/berita.ts`'s `toRegionRef`, which DERIVES a
 * slug from a name because the CMS issues none), an institution's `slug`
 * passes through completely unchanged — verified here rather than assumed.
 */
export function toMitraSummary(
  institution: RawInstitution,
  regionName: string | null,
  logo: ResolvedMedia | null = null
): MitraSummary {
  return {
    slug: institution.slug,
    name: institution.name,
    branch: institution.branch,
    description: institution.description,
    regionName,
    logo,
    logoAlt: institution.logoAlt ?? null
  };
}

/** One institution by slug, from the same cached list — never a second request per institution (`src/lib/catalog.ts`'s established rule). */
export async function getMitraBySlug(slug: string): Promise<MitraSummary | null> {
  const list = await getMitraList();
  return list.find((m) => m.slug === slug) ?? null;
}

/** Test/build seam. */
export function resetLembagaCacheForTests(): void {
  mitraCache = undefined;
}
