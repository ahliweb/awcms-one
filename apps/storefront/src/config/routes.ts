/**
 * Every storefront route, named once.
 *
 * Issue #24 owns the shared chrome (header/footer) that links to pages this
 * issue does NOT build — `/produk`, `/kategori/[slug]`, `/flash-sale`,
 * `/berita`, `/rubrik/[slug]`, `/daerah/[slug]`, `/mitra/[slug]`, `/video`,
 * `/keranjang`, `/checkout`, `/wishlist` land in #27/#28/#30. Declaring their
 * URL shape HERE, as constants, is what lets those issues fill the pages in
 * without ever touching `Header.astro`/`Footer.astro`/`BaseLayout.astro`
 * again — the header already points at the right href, it is just a 404
 * until the page exists.
 *
 * `ROUTES` values are functions for a route with a parameter, plain strings
 * otherwise — so a caller can never forget to interpolate a slug.
 */

export const ROUTES = {
  home: "/",
  products: "/produk",
  category: (slug: string): string => `/kategori/${slug}`,
  flashSale: "/flash-sale",
  news: "/berita",
  rubric: (slug: string): string => `/rubrik/${slug}`,
  region: (slug: string): string => `/daerah/${slug}`,
  partner: (slug: string): string => `/mitra/${slug}`,
  video: "/video",
  cart: "/keranjang",
  checkout: "/checkout",
  wishlist: "/wishlist",
  search: "/cari",
  page: (slug: string): string => `/halaman/${slug}`,
  contact: "/kontak"
} as const;

/**
 * Primary navigation, in the order the header renders it. `label` is the
 * copy a reader sees; `href` is resolved from `ROUTES` so a route rename
 * only ever happens in one place.
 *
 * Every target but `/` and `/kontak` (this issue's own pages) is a 404 until
 * #27/#28 land — that is expected, not a bug this issue introduces: the nav
 * itself is what those issues need already in place to "only add pages",
 * per the issue's own framing.
 */
export const PRIMARY_NAV: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Beranda", href: ROUTES.home },
  { label: "Produk", href: ROUTES.products },
  { label: "Flash Sale", href: ROUTES.flashSale },
  { label: "Berita", href: ROUTES.news },
  { label: "Kontak", href: ROUTES.contact }
];

/**
 * Reserved slugs for the six static/legal pages a commerce storefront and an
 * online-news press-council registration both expect — matching the CMS's
 * own reserved-slug convention (`blog_content` pages, see
 * `src/lib/awcms/pages.ts`). The CMS is the source of truth for whether any
 * of these actually exist and are published; the footer renders a link only
 * when `src/lib/awcms/pages.ts` confirms the slug is live (the same
 * "render only what is set" rule the footer already applies to social
 * links).
 *
 * `redaksi` / `pedomanMediaSiber` / `disclaimer` are the three the issue
 * calls out as depending on the news pages existing (#28) — nothing stops an
 * editor from publishing them earlier, and this footer already degrades
 * correctly if they are not there yet, so no separate "news exists" signal
 * is needed beyond "is this page published".
 */
export const STATIC_PAGE_SLUGS = {
  privacyPolicy: "kebijakan-privasi",
  termsOfService: "syarat-dan-ketentuan",
  shoppingGuide: "panduan-belanja",
  editorial: "redaksi",
  mediaGuidelines: "pedoman-media-siber",
  disclaimer: "disclaimer"
} as const;

/** Footer link labels for each reserved slug above, in the order the footer renders them. */
export const FOOTER_PAGE_LINKS: ReadonlyArray<{
  slug: string;
  label: string;
}> = [
  { slug: STATIC_PAGE_SLUGS.shoppingGuide, label: "Panduan Belanja" },
  { slug: STATIC_PAGE_SLUGS.privacyPolicy, label: "Kebijakan Privasi" },
  { slug: STATIC_PAGE_SLUGS.termsOfService, label: "Syarat & Ketentuan" },
  { slug: STATIC_PAGE_SLUGS.editorial, label: "Redaksi" },
  { slug: STATIC_PAGE_SLUGS.mediaGuidelines, label: "Pedoman Media Siber" },
  { slug: STATIC_PAGE_SLUGS.disclaimer, label: "Disclaimer" }
];
