/**
 * The header's primary navigation for the active build profile (issue
 * #137) — `src/config/profil.ts`'s static list plus the profile's DYNAMIC
 * entries, resolved from the CMS at build time:
 *
 * - `toko`: the static list only — BjekMart's own five-item header, byte-
 *   for-byte what `Header.astro` rendered before this issue.
 * - `berita`: the top-level rubrik pages (`selectNavUtamaRubrik`, the same
 *   selection the news chrome's own `NavBerita.astro` makes) inserted after
 *   "Berita", so a news-only deployment's store-style header (used by the
 *   shared pages: `/kontak`, `/halaman/*`, `/404`) offers the same sections
 *   the news chrome does.
 * - `landing`: every published static page (`listStaticPages()`), inserted
 *   between "Beranda" and "Kontak" — a company-profile site's whole menu is
 *   its pages.
 *
 * Both fetches are memoized per build by their own modules, so this costs
 * no extra request over what `BaseLayout.astro`/`Footer.astro` already
 * make. `selectPrimaryNav` is the pure half (given already-fetched data),
 * exported for `tests/profil-konfig.test.ts`; `getPrimaryNav` is what
 * `Header.astro` calls.
 */
import {
  PRIMARY_NAV,
  PROFILE_NAV,
  PROFILE_NAV_DYNAMIC,
  SITE_PROFILE,
  type NavItem,
  type SiteProfile
} from "../config/profil";
import { ROUTES } from "../config/routes";
import { getRubrikTree, flattenRubrikTree, type RubrikNode } from "./berita";
import { selectNavUtamaRubrik } from "./navigasi-berita";
import { listStaticPages, type StaticPageSummary } from "./awcms/pages";

export type ResolvedNavItem = { label: string; href: string };

/** Pure: the full nav for `profile`, given whatever dynamic data that profile needs (unused inputs may be empty). */
export function selectPrimaryNav(
  profile: SiteProfile,
  input: { rubrik?: readonly RubrikNode[]; staticPages?: readonly StaticPageSummary[] } = {}
): ResolvedNavItem[] {
  const statik: readonly NavItem[] = PROFILE_NAV[profile];
  const dynamic = PROFILE_NAV_DYNAMIC[profile];

  if (dynamic === "rubrik") {
    const rubrikItems = selectNavUtamaRubrik(input.rubrik ?? []).map((item) => ({
      label: item.label,
      href: item.href
    }));
    return insertAfter(statik, "news", rubrikItems);
  }

  if (dynamic === "halaman-statis") {
    const pageItems = (input.staticPages ?? []).map((page) => ({
      label: page.title,
      href: ROUTES.page(page.slug)
    }));
    return insertAfter(statik, "home", pageItems);
  }

  return statik.map((item) => ({ label: item.label, href: item.href }));
}

function insertAfter(
  statik: readonly NavItem[],
  afterRoute: NavItem["route"],
  extra: readonly ResolvedNavItem[]
): ResolvedNavItem[] {
  const result: ResolvedNavItem[] = [];
  for (const item of statik) {
    result.push({ label: item.label, href: item.href });
    if (item.route === afterRoute) result.push(...extra);
  }
  return result;
}

/** The active profile's nav, dynamic entries fetched. */
export async function getPrimaryNav(): Promise<ResolvedNavItem[]> {
  const dynamic = PROFILE_NAV_DYNAMIC[SITE_PROFILE];

  if (dynamic === "rubrik") {
    const tree = await getRubrikTree();
    return selectPrimaryNav(SITE_PROFILE, { rubrik: flattenRubrikTree(tree) });
  }

  if (dynamic === "halaman-statis") {
    return selectPrimaryNav(SITE_PROFILE, { staticPages: await listStaticPages() });
  }

  return PRIMARY_NAV.map((item) => ({ label: item.label, href: item.href }));
}
