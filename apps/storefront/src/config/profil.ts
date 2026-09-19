/**
 * The build profile (issue #137, ADR-0018 D2/D3) — the ONE module every
 * profile-aware consumer reads from.
 *
 * `SITE_PROFILE` is read once, at build time, through the same `readEnvOr`
 * chain `SITE_URL` uses (`src/lib/env.ts`): `toko` (default — today's
 * BjekMart shape, commerce + news), `berita` (news portal only) or `landing`
 * (company profile: pages + contact). Anything else fails the BUILD with a
 * message naming the variable: a typo that silently fell back to `toko`
 * would ship a commerce site to a deployment that asked for a news one.
 *
 * A profile is a COMPOSITION of page groups: `shared` (every profile),
 * `toko` and `berita`. Page files for a non-shared group live under
 * `src/profil/<group>/pages/**` and are injected as routes by
 * `integrations/profil.mjs` only when their group is active; the shared
 * group stays under `src/pages/**` as ordinary file-based routes. This
 * module never touches the file system — it answers "which groups, which
 * routes, which navigation, which sitemap sources, which feeds, which
 * robots rules, which CSP needs" from `src/config/routes.ts`'s own
 * `ROUTE_GROUPS` annotation, so the integration, the pages, the layouts and
 * the tests all agree because they all ask here.
 *
 * Nothing in this file fetches anything: every export is a constant or a
 * pure function, so `tests/profil-konfig.test.ts` can exercise all three
 * profiles in one `bun test` process without standing up the stub CMS.
 * `src/lib/navigasi-profil.ts` is where the profile's DYNAMIC navigation
 * entries (a `berita` deployment's rubrik list, a `landing` deployment's
 * static pages) are resolved from the CMS at build time.
 */
import { readEnv } from "../lib/env";
import { ROUTES, ROUTE_GROUPS, STATIC_PAGE_SLUGS, type RouteGroup, type RouteKey } from "./routes";

// ---------------------------------------------------------------------------
// Profiles and groups
// ---------------------------------------------------------------------------

export const SITE_PROFILES = ["toko", "berita", "landing"] as const;
export type SiteProfile = (typeof SITE_PROFILES)[number];

/** The profile a build gets when `SITE_PROFILE` is unset — BjekMart's own shape (ADR-0018 D2). */
export const DEFAULT_SITE_PROFILE: SiteProfile = "toko";

/** The environment variable this module reads. Named once so the error message and the docs cannot drift from the code. */
export const SITE_PROFILE_ENV = "SITE_PROFILE";

/** Every group, in the order the matrix lists them. `shared` first because every profile starts from it. */
export const ROUTE_GROUPS_ALL = ["shared", "toko", "berita"] as const satisfies readonly RouteGroup[];

/** The page groups each profile composes — the profile matrix's own "Composition" column (`docs/template.md`). */
export const PROFILE_GROUPS: Record<SiteProfile, readonly RouteGroup[]> = {
  toko: ["shared", "toko", "berita"],
  berita: ["shared", "berita"],
  landing: ["shared"]
};

export function isSiteProfile(value: unknown): value is SiteProfile {
  return typeof value === "string" && (SITE_PROFILES as readonly string[]).includes(value);
}

/**
 * `undefined`/empty → the default; a known name → itself; anything else →
 * a thrown `Error` naming the variable and the accepted values. Exported
 * (rather than inlined into `SITE_PROFILE` below) so the unit test can
 * exercise every branch without mutating `process.env`.
 */
export function resolveSiteProfile(raw: string | undefined): SiteProfile {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_SITE_PROFILE;
  if (isSiteProfile(trimmed)) return trimmed;
  throw new Error(
    `${SITE_PROFILE_ENV}="${raw}" is not a build profile this storefront knows. ` +
      `Use one of: ${SITE_PROFILES.join(", ")} (unset means "${DEFAULT_SITE_PROFILE}").`
  );
}

/** The active profile for THIS build. */
export const SITE_PROFILE: SiteProfile = resolveSiteProfile(readEnv(SITE_PROFILE_ENV));

/** The active profile's groups. */
export const ACTIVE_GROUPS: readonly RouteGroup[] = PROFILE_GROUPS[SITE_PROFILE];

export function groupsFor(profile: SiteProfile): readonly RouteGroup[] {
  return PROFILE_GROUPS[profile];
}

export function isGroupActive(group: RouteGroup, profile: SiteProfile = SITE_PROFILE): boolean {
  return PROFILE_GROUPS[profile].includes(group);
}

/** The group `routes.ts` annotated `key` with. */
export function routeGroup(key: RouteKey): RouteGroup {
  return ROUTE_GROUPS[key];
}

export function isRouteActive(key: RouteKey, profile: SiteProfile = SITE_PROFILE): boolean {
  return isGroupActive(ROUTE_GROUPS[key], profile);
}

/** Every `ROUTES` key whose group is in `profile` — what `tests/profil-routes.test.ts` builds its allow-list from. */
export function activeRouteKeys(profile: SiteProfile = SITE_PROFILE): RouteKey[] {
  return (Object.keys(ROUTE_GROUPS) as RouteKey[]).filter((key) => isRouteActive(key, profile));
}

/** The `ROUTES` keys whose group is NOT in `profile` — the routes a build of that profile must not link to or emit. */
export function excludedRouteKeys(profile: SiteProfile = SITE_PROFILE): RouteKey[] {
  return (Object.keys(ROUTE_GROUPS) as RouteKey[]).filter((key) => !isRouteActive(key, profile));
}

/**
 * The static path prefix a `ROUTES` entry owns — `/produk` for a plain
 * string, the part before the first parameter for a function (`/kategori/`
 * for `category`). Used by `tests/profil-routes.test.ts` to decide which
 * built `href`s belong to which route without re-implementing routing.
 */
export function routePathPrefix(key: RouteKey): string {
  const value = ROUTES[key];
  if (typeof value === "string") return value;
  // Every parameterised route takes a slug first; a sentinel that cannot
  // appear in a real slug marks where the parameter starts.
  const sentinel = "__PARAM__";
  const sample = (value as (a: string, b?: never) => string)(sentinel);
  return sample.slice(0, sample.indexOf(sentinel));
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export type NavItem = { label: string; href: string; route: RouteKey };

/**
 * What the header's primary nav says besides the dynamic entries
 * `src/lib/navigasi-profil.ts` resolves (`berita`'s rubrik list, `landing`'s
 * static pages). Each entry names its `ROUTES` key so the unit test can
 * prove no profile's nav points at a route that profile does not build.
 * `toko`'s list is byte-for-byte the `PRIMARY_NAV` `routes.ts` carried
 * before issue #137 — BjekMart's own header is unchanged.
 */
export const PROFILE_NAV: Record<SiteProfile, readonly NavItem[]> = {
  toko: [
    { label: "Beranda", href: ROUTES.home, route: "home" },
    { label: "Produk", href: ROUTES.products, route: "products" },
    { label: "Flash Sale", href: ROUTES.flashSale, route: "flashSale" },
    { label: "Berita", href: ROUTES.news, route: "news" },
    { label: "Kontak", href: ROUTES.contact, route: "contact" }
  ],
  berita: [
    { label: "Beranda", href: ROUTES.home, route: "home" },
    { label: "Berita", href: ROUTES.news, route: "news" },
    { label: "Video", href: ROUTES.video, route: "video" },
    { label: "Buletin", href: ROUTES.newsletter, route: "newsletter" },
    { label: "Kontak", href: ROUTES.contact, route: "contact" }
  ],
  landing: [
    { label: "Beranda", href: ROUTES.home, route: "home" },
    { label: "Kontak", href: ROUTES.contact, route: "contact" }
  ]
};

/**
 * Which dynamic entries the header ALSO renders, resolved from the CMS at
 * build time by `src/lib/navigasi-profil.ts`: `rubrik` — the top-level
 * rubrik pages (`berita`); `halaman-statis` — every published static page
 * (`landing`); `none` — the static list above is the whole nav (`toko`,
 * whose header is unchanged from before this issue).
 */
export type NavDynamic = "none" | "rubrik" | "halaman-statis";
export const PROFILE_NAV_DYNAMIC: Record<SiteProfile, NavDynamic> = {
  toko: "none",
  berita: "rubrik",
  landing: "halaman-statis"
};

/** The active profile's static primary navigation. */
export const PRIMARY_NAV: readonly NavItem[] = PROFILE_NAV[SITE_PROFILE];

/**
 * The header search form: a product search (`/cari`) when the `toko` group
 * is present, a news search (`/cari-berita`) for a `berita`-only build, and
 * none at all for `landing`, which has nothing to search.
 */
export type SearchSurface = { action: string; label: string; placeholder: string; route: RouteKey };
export const PROFILE_SEARCH: Record<SiteProfile, SearchSurface | null> = {
  toko: { action: ROUTES.search, label: "Cari produk", placeholder: "Cari produk...", route: "search" },
  berita: { action: ROUTES.newsSearch, label: "Cari berita", placeholder: "Cari berita...", route: "newsSearch" },
  landing: null
};
export const SEARCH_SURFACE: SearchSurface | null = PROFILE_SEARCH[SITE_PROFILE];

/**
 * Footer legal/static links per profile (the matrix's own "Footer legal
 * links" row) — each rendered only if `src/lib/awcms/pages.ts` confirms the
 * slug is a live page, exactly as `Footer.astro` always did. `toko`'s six
 * are in the order `routes.ts`'s `FOOTER_PAGE_LINKS` rendered them before.
 */
export type FooterPageLink = { slug: string; label: string };
const FOOTER_LINK = {
  shoppingGuide: { slug: STATIC_PAGE_SLUGS.shoppingGuide, label: "Panduan Belanja" },
  privacyPolicy: { slug: STATIC_PAGE_SLUGS.privacyPolicy, label: "Kebijakan Privasi" },
  termsOfService: { slug: STATIC_PAGE_SLUGS.termsOfService, label: "Syarat & Ketentuan" },
  editorial: { slug: STATIC_PAGE_SLUGS.editorial, label: "Redaksi" },
  mediaGuidelines: { slug: STATIC_PAGE_SLUGS.mediaGuidelines, label: "Pedoman Media Siber" },
  disclaimer: { slug: STATIC_PAGE_SLUGS.disclaimer, label: "Disclaimer" }
} as const satisfies Record<string, FooterPageLink>;

export const PROFILE_FOOTER_PAGE_LINKS: Record<SiteProfile, readonly FooterPageLink[]> = {
  toko: [
    FOOTER_LINK.shoppingGuide,
    FOOTER_LINK.privacyPolicy,
    FOOTER_LINK.termsOfService,
    FOOTER_LINK.editorial,
    FOOTER_LINK.mediaGuidelines,
    FOOTER_LINK.disclaimer
  ],
  berita: [
    FOOTER_LINK.editorial,
    FOOTER_LINK.mediaGuidelines,
    FOOTER_LINK.disclaimer,
    FOOTER_LINK.privacyPolicy,
    FOOTER_LINK.termsOfService
  ],
  landing: [FOOTER_LINK.privacyPolicy, FOOTER_LINK.termsOfService]
};

/** The active profile's footer page links. */
export const FOOTER_PAGE_LINKS: readonly FooterPageLink[] = PROFILE_FOOTER_PAGE_LINKS[SITE_PROFILE];

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

/**
 * Every sitemap source name `src/lib/sitemap-sources.ts` and
 * `src/lib/sitemap-katalog.ts` can register, with the group it belongs to.
 * Those two files register a source only when `isGroupActive(group)`; this
 * table is what lets `tests/profil-build-smoke.test.ts` know which URLs a
 * profile's `sitemap-*.xml` must and must not contain.
 */
export const SITEMAP_SOURCE_GROUPS = {
  "static-routes": "shared",
  "static-pages": "shared",
  "berita-front": "berita",
  "berita-posts": "berita",
  "berita-video": "berita",
  "berita-rubrik": "berita",
  "berita-daerah": "berita",
  "berita-mitra": "berita",
  "berita-tag": "berita",
  "katalog-produk": "toko",
  "katalog-kategori": "toko",
  "katalog-product-detail": "toko"
} as const satisfies Record<string, RouteGroup>;

export type SitemapSourceName = keyof typeof SITEMAP_SOURCE_GROUPS;

export function sitemapSourcesFor(profile: SiteProfile = SITE_PROFILE): SitemapSourceName[] {
  return (Object.keys(SITEMAP_SOURCE_GROUPS) as SitemapSourceName[]).filter((name) =>
    isGroupActive(SITEMAP_SOURCE_GROUPS[name], profile)
  );
}

/** The active profile's sitemap sources. */
export const SITEMAP_SOURCES: readonly SitemapSourceName[] = sitemapSourcesFor(SITE_PROFILE);

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

export type FeedEntry = {
  /** Site-relative path of the feed document. */
  href: string;
  /** The `<link rel="alternate">` title suffix (Indonesian). */
  label: string;
  group: RouteGroup;
};

/**
 * The RSS documents a build can emit. `feed.xml` is the PRODUCT feed
 * (`src/profil/toko/pages/feed.xml.ts`); the posts feed is
 * `berita/feed.xml` (`src/profil/berita/pages/berita/feed.xml.ts`), and
 * every rubrik has its own at `rubrik/<slug>/feed.xml`. See ADR-0018's
 * matrix for why the bare root feed is `toko`'s, not `berita`'s.
 */
export const FEEDS_ALL: readonly FeedEntry[] = [
  { href: "/feed.xml", label: "Produk", group: "toko" },
  { href: ROUTES.news + "/feed.xml", label: "Berita", group: "berita" }
];

export function feedsFor(profile: SiteProfile = SITE_PROFILE): FeedEntry[] {
  return FEEDS_ALL.filter((feed) => isGroupActive(feed.group, profile));
}

/** The active profile's feeds. */
export const FEEDS: readonly FeedEntry[] = feedsFor(SITE_PROFILE);

/**
 * The ONE feed `BaseLayout.astro` advertises in `<head>` as
 * `<link rel="alternate" type="application/rss+xml">` — the first active
 * one, so `toko` keeps advertising `/feed.xml` exactly as it did before
 * this issue, `berita` advertises `/berita/feed.xml`, and `landing` (no
 * feed-worthy content) advertises none.
 */
export const PRIMARY_FEED: FeedEntry | null = FEEDS[0] ?? null;

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/**
 * `Disallow` rules, in the order `robots.txt.ts` has always emitted them,
 * each tagged with the group that owns the path — so `toko`'s output is
 * byte-for-byte what it was, and a profile without a group simply has no
 * line for a path that does not exist in its build. `/api/` is `shared`:
 * this app has no API of its own, but a misconfigured crawler may still
 * probe the path on any deployment.
 */
export const ROBOTS_DISALLOW_ALL: ReadonlyArray<{ path: string; group: RouteGroup }> = [
  { path: ROUTES.cart, group: "toko" },
  { path: ROUTES.checkout, group: "toko" },
  { path: ROUTES.orderTracking, group: "toko" },
  { path: ROUTES.wishlist, group: "toko" },
  { path: ROUTES.search, group: "toko" },
  { path: ROUTES.newsletterConfirm, group: "berita" },
  { path: ROUTES.newsletterUnsubscribe, group: "berita" },
  { path: ROUTES.login, group: "toko" },
  { path: ROUTES.register, group: "toko" },
  { path: ROUTES.account, group: "toko" },
  { path: "/api/", group: "shared" }
];

export function robotsDisallowFor(profile: SiteProfile = SITE_PROFILE): string[] {
  return ROBOTS_DISALLOW_ALL.filter((rule) => isGroupActive(rule.group, profile)).map((rule) => rule.path);
}

/** The active profile's `Disallow` paths. */
export const ROBOTS_DISALLOW: readonly string[] = robotsDisallowFor(SITE_PROFILE);

// ---------------------------------------------------------------------------
// CSP
// ---------------------------------------------------------------------------

/**
 * What `src/pages/csp.json.ts` needs to derive for a profile.
 *
 * `connectAwcmsOrigin` is `true` for EVERY profile — not only `toko`. ADR-
 * 0018's matrix predicted `berita`/`landing` would need no `connect-src`
 * widening, but reading the code says otherwise: the first-party visitor
 * beacon (`src/scripts/analitik.ts`, mounted on every page by
 * `BaseLayout.astro`) POSTs to `PUBLIC_AWCMS_ORIGIN` on every profile, and
 * `berita`'s newsletter form (`src/scripts/buletin.ts`) does too. A build
 * whose CSP forgot that origin would silently drop every analytics beacon
 * — so the origin is added whenever it is needed, which is always. What
 * DOES vary is which content the `img-src`/`frame-src` derivation reads:
 * product/marketing images only when `toko` is active, article media and
 * the YouTube facade origins only when `berita` is.
 */
export type CspNeeds = {
  connectAwcmsOrigin: boolean;
  /** Read `getProducts()`/`getActive*()` marketing data for `img-src`. */
  mediaFromToko: boolean;
  /** Read resolved article media, ad creatives and the video list for `img-src`/`frame-src`. */
  mediaFromBerita: boolean;
};

export function cspNeedsFor(profile: SiteProfile = SITE_PROFILE): CspNeeds {
  return {
    connectAwcmsOrigin: true,
    mediaFromToko: isGroupActive("toko", profile),
    mediaFromBerita: isGroupActive("berita", profile)
  };
}

/** The active profile's CSP needs. */
export const CSP_NEEDS: CspNeeds = cspNeedsFor(SITE_PROFILE);

// ---------------------------------------------------------------------------
// `<head>` extras that belong to a group
// ---------------------------------------------------------------------------

/**
 * Stylesheets `BaseLayout.astro` links for every page but which are
 * generated by a GROUP's own endpoint: `/product-labels.css` is
 * `src/profil/toko/pages/product-labels.css.ts`, so a build without `toko`
 * has no such file to link. `/theme-tokens.css` is `shared` and is linked
 * unconditionally by the layout itself, not listed here.
 */
export const GROUP_STYLESHEETS: ReadonlyArray<{ href: string; group: RouteGroup }> = [
  { href: "/product-labels.css", group: "toko" }
];

export function groupStylesheetsFor(profile: SiteProfile = SITE_PROFILE): string[] {
  return GROUP_STYLESHEETS.filter((sheet) => isGroupActive(sheet.group, profile)).map((sheet) => sheet.href);
}

/** The active profile's group-owned stylesheets. */
export const GROUP_STYLESHEET_HREFS: readonly string[] = groupStylesheetsFor(SITE_PROFILE);

// ---------------------------------------------------------------------------
// One object with everything, for tests and docs
// ---------------------------------------------------------------------------

export type ProfileDescriptor = {
  profile: SiteProfile;
  groups: readonly RouteGroup[];
  nav: readonly NavItem[];
  navDynamic: NavDynamic;
  search: SearchSurface | null;
  footerPageLinks: readonly FooterPageLink[];
  sitemapSources: readonly SitemapSourceName[];
  feeds: readonly FeedEntry[];
  robotsDisallow: readonly string[];
  csp: CspNeeds;
  groupStylesheets: readonly string[];
  activeRoutes: readonly RouteKey[];
  excludedRoutes: readonly RouteKey[];
};

/** Everything above, for any profile — the shape `tests/profil-konfig.test.ts` asserts against. */
export function describeProfile(profile: SiteProfile): ProfileDescriptor {
  return {
    profile,
    groups: PROFILE_GROUPS[profile],
    nav: PROFILE_NAV[profile],
    navDynamic: PROFILE_NAV_DYNAMIC[profile],
    search: PROFILE_SEARCH[profile],
    footerPageLinks: PROFILE_FOOTER_PAGE_LINKS[profile],
    sitemapSources: sitemapSourcesFor(profile),
    feeds: feedsFor(profile),
    robotsDisallow: robotsDisallowFor(profile),
    csp: cspNeedsFor(profile),
    groupStylesheets: groupStylesheetsFor(profile),
    activeRoutes: activeRouteKeys(profile),
    excludedRoutes: excludedRouteKeys(profile)
  };
}

/** The active build's descriptor. */
export const PROFIL_AKTIF: ProfileDescriptor = describeProfile(SITE_PROFILE);
