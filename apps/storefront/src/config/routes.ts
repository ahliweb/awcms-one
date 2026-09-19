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
  // --- issue #28: news surface — one article/rubrik/tag/etc. constant each,
  // added here (rather than restructuring anything above) so #27's own
  // additions to this same object merge without conflict.
  /** A single article's own page — distinct from `news` (`/berita`, the front page) above. */
  article: (slug: string): string => `/berita/${slug}`,
  rubric: (slug: string): string => `/rubrik/${slug}`,
  /**
   * `page` defaults to `2` (never `1` — page 1 lives at bare `ROUTES.rubric`,
   * see `src/lib/berita.ts`'s pagination docblock) SOLELY so this function's
   * arity matches every other single-slug `ROUTES` entry: `tests/
   * routes.test.ts` (issue #24, outside this issue's file ownership) and
   * `tests/berita-guard-no-news-route.test.ts` both iterate `ROUTES` generically
   * and call every function value with ONE argument — TypeScript cannot call a
   * UNION of differently-shaped function types with an argument list that
   * does not satisfy every member, so a strictly-2-argument function here
   * breaks type-checking for both call sites even though neither one cares
   * what the second argument defaults to. Every real caller of this
   * function (`src/lib/berita.ts`, the `/rubrik/[slug]/halaman/[n]` pages)
   * always passes `page` explicitly.
   */
  rubricPage: (slug: string, page = 2): string => `/rubrik/${slug}/halaman/${page}`,
  region: (slug: string): string => `/daerah/${slug}`,
  partner: (slug: string): string => `/mitra/${slug}`,
  video: "/video",
  videoArticle: (slug: string): string => `/video/${slug}`,
  tag: (slug: string): string => `/tag/${slug}`,
  author: (slug: string): string => `/penulis/${slug}`,
  /** `mm` defaults for the same arity reason `rubricPage`'s `page` does — see its docblock. Every real caller passes both segments explicitly. */
  archive: (yyyy: string, mm = "01"): string => `/arsip/${yyyy}/${mm}`,
  newsSearch: "/cari-berita",
  cart: "/keranjang",
  checkout: "/checkout",
  wishlist: "/wishlist",
  search: "/cari",
  page: (slug: string): string => `/halaman/${slug}`,
  contact: "/kontak",
  // --- issue #88 (S1, part of #32): customer accounts. Only `login`,
  // `register`, and `account` get a PAGE in this issue — `Header.astro`'s
  // "Masuk"/account link is the one place `login`/`account` are read today.
  // `accountOrders`/`accountOrder`/`accountAddresses`/`accountReviews`/
  // `accountAffiliate` are declared now, with no page behind them yet, so
  // `/akun`'s own navigation cards (S2/S3) and any other page that wants to
  // link there can point at a named constant instead of a hand-typed path —
  // the same "declare the shape now, fill the page in later" precedent
  // `routes.ts`'s own top-of-file docblock already set for #27/#28/#30.
  // `accountWishlist` is deliberately NOT a new constant: it is the
  // already-existing `ROUTES.wishlist` (`/wishlist`), unchanged.
  /** `/masuk` — e-mail OTP sign-in. */
  login: "/masuk",
  /** `/daftar` — name + phone + e-mail OTP registration. */
  register: "/daftar",
  /** `/akun` — the signed-in dashboard shell. */
  account: "/akun",
  /** Lands in S2 — declared now so the account dashboard's nav card and the header can link at it. */
  accountOrders: "/akun/pesanan",
  /** A single account order — `kode` is percent-encoded, mirroring `toko-klien.ts`'s own `getOrder`. Lands in S2. */
  accountOrder: (kode: string): string => `/akun/pesanan?kode=${encodeURIComponent(kode)}`,
  /** Lands in S2. */
  accountAddresses: "/akun/alamat",
  /** Lands in S3. */
  accountReviews: "/akun/ulasan",
  /** Lands in S3 (issue #86's affiliate program). */
  accountAffiliate: "/akun/afiliasi"
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
