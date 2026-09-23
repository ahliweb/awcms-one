/**
 * The "key pages" table every issue #183 spec (`aksesibilitas.e2e.ts`,
 * `responsif.e2e.ts`, `screenshots.e2e.ts`) walks, per build profile. One
 * shared list so the three specs cannot silently drift into checking a
 * different notion of "key page" for the same profile — the same
 * "one place every profile-aware consumer reads from" rule
 * `src/config/profil.ts`'s own docblock states for the real app.
 *
 * Not a test file itself (no `.test.`/`.e2e.` in the name, so neither the
 * root `bun test` nor `bun run test:e2e` ever collects it directly) — the
 * same "helper, not a suite" shape `ports.ts` and `stub-lifecycle.ts`
 * already have.
 *
 * Every page is chosen by the SAME `isGroupActive`/`ROUTE_GROUPS`
 * composition `src/config/profil.ts` uses to decide what a real build
 * includes — never a hand-typed "if profile is X" branch that could drift
 * from what `astro build` (via `global-setup.ts`) actually produced:
 *
 *   - `toko`   (shared + toko + berita): home, product listing, product
 *              detail, login, account, news listing, article detail,
 *              contact, one static CMS page.
 *   - `berita` (shared + berita): home, news listing, article detail,
 *              contact, one static CMS page.
 *   - `landing` (shared only): home, contact, one static CMS page — this
 *              IS "landing's own pages", since landing composes nothing
 *              else.
 *
 * Every slug is read from the SAME committed fixtures
 * `scripts/stub-awcms.mjs` serves during this harness's build — never a
 * hand-typed guess a future fixture edit could silently turn into a 404
 * these specs would then be asserting against without ever noticing.
 */
import { isGroupActive, resolveSiteProfile, type SiteProfile } from "../../src/config/profil";
import { ROUTES } from "../../src/config/routes";
import blogPagesFixture from "../fixtures/awcms/blog-pages-public.json";
import blogPostsFixture from "../fixtures/awcms/blog-posts.json";
import productsFixture from "../fixtures/awcms/products.json";

export type KeyPage = { name: string; path: string };

/** The profile THIS Playwright run targets — the same resolution `src/config/profil.ts`'s own `SITE_PROFILE` export uses, so a spec and the build it is visiting can never disagree about which profile is active. */
export const ACTIVE_PROFILE: SiteProfile = resolveSiteProfile(process.env.SITE_PROFILE);

/** The first item's `slug` — every fixture used here is a small, hand-curated list committed for exactly this purpose, so "the first one" is a real, stable page, not an arbitrary sample. */
function firstSlug(items: ReadonlyArray<{ slug: string }>, label: string): string {
  const slug = items[0]?.slug;
  if (!slug) throw new Error(`Fixture for "${label}" has no items to derive a slug from — tests/fixtures/awcms/ may have changed shape.`);
  return slug;
}

/** Every key page for `profile`. */
export function keyPagesFor(profile: SiteProfile): KeyPage[] {
  const pages: KeyPage[] = [{ name: "home", path: ROUTES.home }];

  if (isGroupActive("toko", profile)) {
    const productSlug = firstSlug(productsFixture.items, "products");
    pages.push(
      { name: "product-listing", path: ROUTES.products },
      { name: "product-detail", path: `/product/${productSlug}` },
      { name: "login", path: ROUTES.login },
      { name: "account", path: ROUTES.account }
    );
  }

  if (isGroupActive("berita", profile)) {
    const articleSlug = firstSlug(blogPostsFixture.posts, "blog posts");
    pages.push(
      { name: "news-listing", path: ROUTES.news },
      { name: "article-detail", path: ROUTES.article(articleSlug) }
    );
  }

  // `halaman/[slug]` is `shared` — every profile builds it, and it is the
  // whole of "landing's own pages" once `home`/`contact` are already listed.
  const staticPageSlug = firstSlug(blogPagesFixture.pages, "static pages");
  pages.push({ name: "contact", path: ROUTES.contact }, { name: "static-page", path: ROUTES.page(staticPageSlug) });

  return pages;
}

/** The active profile's key pages. */
export const KEY_PAGES: KeyPage[] = keyPagesFor(ACTIVE_PROFILE);
