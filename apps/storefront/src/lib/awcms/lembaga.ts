/**
 * Institution ("Mitra") convenience reads for issue #28's `/mitra/[slug]` —
 * a thin layer over `src/lib/awcms/blog.ts`'s `getAllInstitutions()` that
 * adds the one thing that file deliberately does not: a region NAME, via
 * `src/lib/awcms/wilayah.ts`.
 *
 * ## No logo — verified, not assumed
 *
 * The issue's mitra bullet asks for "logo, description, latest posts".
 * `RawInstitution` (`src/lib/awcms/blog.ts`, verified against
 * `InstitutionView`/the `sql/131` migration) carries no logo/media field at
 * all. `src/pages/mitra/[slug].astro` renders name/description/posts and
 * omits the logo, the same "render every field that actually exists"
 * choice `src/pages/kontak.astro` already made for a maps iframe/FAQ list
 * neither exists on `site_profile`.
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
import { resolveRegion } from "./wilayah";

export type MitraSummary = {
  slug: string;
  name: string;
  branch: "legislative" | "executive";
  description: string | null;
  regionName: string | null;
};

let mitraCache: Promise<MitraSummary[]> | undefined;

/** Every institution, with its region resolved to a name where possible — fetched once and memoized. */
export function getMitraList(): Promise<MitraSummary[]> {
  mitraCache ??= buildMitraList();
  return mitraCache;
}

async function buildMitraList(): Promise<MitraSummary[]> {
  const institutions = await getAllInstitutions();

  return Promise.all(
    institutions.map(async (institution) => {
      const region = institution.regionCode ? await resolveRegion(institution.regionCode) : null;
      return toMitraSummary(institution, region?.name ?? null);
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
export function toMitraSummary(institution: RawInstitution, regionName: string | null): MitraSummary {
  return {
    slug: institution.slug,
    name: institution.name,
    branch: institution.branch,
    description: institution.description,
    regionName
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
