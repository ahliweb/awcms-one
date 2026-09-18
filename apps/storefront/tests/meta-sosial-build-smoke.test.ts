import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The OG/Twitter meta build smoke test (issue #54, A8) — its OWN file, per
 * the repo's rule that each issue adds a build-smoke file rather than
 * editing a prior issue's (`tests/berita-build-smoke.test.ts` is #28's).
 * Same shape as every sibling: start the stub CMS, run a REAL `astro
 * build` against it, then read the actual `dist/client/*.html` and assert
 * on the `<head>` that shipped — not on what a builder returned in
 * isolation (`tests/meta-sosial.test.ts` covers that).
 *
 * Two things are proven here that no unit test can:
 *
 * 1. `/berita/{slug}` and `/video/{slug}` carry the article/video OG +
 *    Twitter tags END TO END — `src/lib/meta-sosial.ts` → the page →
 *    `BeritaLayout.astro` → `BaseLayout.astro`'s `ogType`/`meta` props →
 *    HTML, in `<head>` and only there — and a rubrik page's `<head>` is the
 *    one the transferred `head` slot feeds (no `rel="next"` to a page that
 *    does not exist).
 * 2. Every STORE page's Open Graph block is byte-for-byte what it was
 *    before this issue: the six fixed tags, `og:type=website`, and no
 *    `og:image`/`twitter:*` — asserted against a frozen, inline snapshot of
 *    that block (`preIssue54OgBlock` below) rather than a "does not
 *    contain" check, so an accidental seventh tag on a product page fails
 *    loudly. The stub's `logoMediaId` DOES resolve (`tests/fixtures/awcms/
 *    media-objects.json`), which is exactly what makes this snapshot
 *    meaningful: the news LISTING pages gain the logo as `og:image` from
 *    the same build, and the store pages provably do not.
 *
 * Never a false pass: if `bun` cannot be spawned at all, the suite is
 * SKIPPED with a named reason rather than reporting green for a build that
 * never ran.
 */

const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
const TIMEOUT_MS = 60_000;
const SITE_URL = "http://localhost:4321";

function canSpawnBun(): boolean {
  try {
    const proc = Bun.spawnSync(["bun", "--version"]);
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function waitForStub(url: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === 401 || response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`stub-awcms did not answer ${url} in time.`);
}

/** The `<head>` of a built page — everything asserted here must live there, never in `<body>`. */
function headOf(html: string): string {
  const match = html.match(/<head[\s>]([\s\S]*?)<\/head>/i);
  if (!match) throw new Error("no <head> in built HTML");
  return match[1] ?? "";
}

/**
 * Every social/OG `<meta>` in `<head>`, in document order, as
 * `"<key>=<content>"` — `og:*`, `article:*`, `video:*` (keyed by
 * `property`) and `twitter:*` (keyed by `name`). Content is the RAW
 * attribute text as shipped, entities and all, so escaping is asserted on
 * what a crawler's HTML parser actually receives.
 */
function socialMeta(html: string): string[] {
  const head = headOf(html);
  const out: string[] = [];
  const re = /<meta\s+(property|name)="([^"]+)"\s+content="([^"]*)"\s*\/?>/g;
  for (const match of head.matchAll(re)) {
    const key = match[2] ?? "";
    if (/^(og|article|video|twitter):/.test(key)) out.push(`${key}=${match[3] ?? ""}`);
  }
  return out;
}

function relLinks(html: string): string[] {
  const head = headOf(html);
  const out: string[] = [];
  for (const match of head.matchAll(/<link\s+rel="(prev|next)"\s+href="([^"]*)"\s*\/?>/g)) {
    out.push(`${match[1]}=${match[2]}`);
  }
  return out;
}

/**
 * The Open Graph block `BaseLayout.astro` rendered on EVERY page before
 * issue #54 — frozen here, in order, as the snapshot every store page is
 * held to. `title`/`description` are the fixture values the page passes;
 * the layout's own `" — {siteName}"` suffix and `id_ID` are part of the
 * frozen shape.
 */
function preIssue54OgBlock(path: string, title: string, description: string): string[] {
  const siteName = "BjekMart (Stub)";
  return [
    "og:type=website",
    `og:url=${SITE_URL}${path}`,
    `og:title=${title === siteName ? title : `${title} — ${siteName}`}`,
    `og:description=${description}`,
    `og:site_name=${siteName}`,
    "og:locale=id_ID"
  ];
}

describe("build smoke: OG/Twitter meta (issue #54) against the stub CMS", () => {
  if (!canSpawnBun()) {
    test.skip("SKIPPED — this environment cannot spawn `bun` (Bun.spawnSync failed)", () => {});
    return;
  }

  test(
    "article/video pages carry the full OG + Twitter set; store pages' OG block is unchanged",
    async () => {
      const stubPort = 45000 + Math.floor(Math.random() * 4000);
      const distClient = join(STOREFRONT_ROOT, "dist", "client");
      rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });

      const stub = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
        cwd: STOREFRONT_ROOT,
        env: { ...process.env, STUB_PORT: String(stubPort) },
        stdout: "pipe",
        stderr: "pipe"
      });

      try {
        await waitForStub(`http://localhost:${stubPort}/api/v1/blog/posts`, Date.now() + 5000);

        const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
          cwd: STOREFRONT_ROOT,
          env: {
            ...process.env,
            AWCMS_API_URL: `http://localhost:${stubPort}`,
            AWCMS_API_TOKEN: "stub-token",
            SITE_URL,
            PUBLIC_AWCMS_ORIGIN: "https://cms.example.com"
          },
          stdout: "pipe",
          stderr: "pipe"
        });

        if (build.exitCode !== 0) {
          throw new Error(
            `astro build exited ${build.exitCode}\n--- stdout ---\n${build.stdout.toString()}\n--- stderr ---\n${build.stderr.toString()}`
          );
        }

        const read = (...parts: string[]): string =>
          readFileSync(join(distClient, ...parts), "utf8");

        // --- /berita/{slug}: an article with a resolved hero (1600×900,
        // alt text), rubrik Pidana, tag Ekonomi (tests/fixtures/awcms/
        // {blog-posts,blog-terms,media-objects}.json).
        const article = socialMeta(read("berita", "bupati-kobar-resmikan-jembatan-baru.html"));
        expect(article).toEqual([
          "og:type=article",
          `og:url=${SITE_URL}/berita/bupati-kobar-resmikan-jembatan-baru`,
          "og:title=Bupati Kobar Resmikan Jembatan Baru — BjekMart (Stub)",
          "og:description=Bupati Kotawaringin Barat meresmikan jembatan penghubung dua kecamatan.",
          "og:site_name=BjekMart (Stub)",
          "og:locale=id_ID",
          "og:image=https://media.example.test/news/jembatan-kobar-hero.jpg",
          "og:image:width=1600",
          "og:image:height=900",
          "og:image:alt=Bupati Kotawaringin Barat meresmikan jembatan baru didampingi jajaran Pemkab.",
          "article:published_time=2026-08-01T02:00:00.000Z",
          "article:modified_time=2026-08-01T02:00:00.000Z",
          "article:section=Pidana",
          "article:tag=Ekonomi",
          "twitter:card=summary_large_image",
          "twitter:title=Bupati Kobar Resmikan Jembatan Baru",
          "twitter:description=Bupati Kotawaringin Barat meresmikan jembatan penghubung dua kecamatan.",
          "twitter:image=https://media.example.test/news/jembatan-kobar-hero.jpg"
        ]);

        // An article whose featuredMediaId is null: no og:image, no
        // twitter:image, and a plain `summary` card — never a
        // `summary_large_image` card with nothing to show.
        const noImage = socialMeta(read("berita", "panduan-pemilu-2024.html"));
        expect(noImage).not.toContainEqual(expect.stringMatching(/^og:image/));
        expect(noImage).not.toContainEqual(expect.stringMatching(/^twitter:image/));
        expect(noImage).toContain("twitter:card=summary");
        expect(noImage).toContain("article:section=Politik");

        // --- /video/{slug}: the fixture video post has no featuredMediaId,
        // so og:image is the SAME hqdefault poster the card and the facade
        // load (never a maxresdefault YouTube may 404 — PR #70 review);
        // og:video:url is the SAME youtube-nocookie embed the facade loads;
        // the `video` namespace, never `article:*`.
        const video = socialMeta(read("video", "detik-detik-kebakaran-pasar.html"));
        expect(video).toEqual([
          "og:type=video.other",
          `og:url=${SITE_URL}/video/detik-detik-kebakaran-pasar`,
          "og:title=Detik-Detik Kebakaran di Pasar — BjekMart (Stub)",
          "og:description=Video amatir merekam momen kebakaran di pasar tradisional.",
          "og:site_name=BjekMart (Stub)",
          "og:locale=id_ID",
          "og:image=https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
          "og:video:url=https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
          "video:release_date=2026-08-15T04:00:00.000Z",
          "twitter:card=summary_large_image",
          "twitter:title=Detik-Detik Kebakaran di Pasar",
          "twitter:description=Video amatir merekam momen kebakaran di pasar tradisional.",
          "twitter:image=https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
        ]);

        // Exactly ONE og:type per page — the prop REPLACES the fixed tag,
        // it does not add a second one a crawler would have to pick from.
        for (const tags of [article, video]) {
          expect(tags.filter((t) => t.startsWith("og:type=")).length).toBe(1);
        }

        // Every meta tag is in <head>, before the `head` slot's own
        // position — i.e. rendered by the layout's block, not appended by
        // a page — and nothing social-shaped leaked into <body>.
        const articleHtml = read("berita", "bupati-kobar-resmikan-jembatan-baru.html");
        const body = articleHtml.slice(articleHtml.indexOf("<body"));
        expect(body).not.toMatch(/<meta\s+(property|name)="(og|article|twitter):/);

        // --- Listing pages: the stub's logoMediaId resolves
        // (tests/fixtures/awcms/media-objects.json), so the news front
        // page and a rubrik page gain the logo as og:image (+ dimensions/
        // alt) and a `summary` card — through BeritaLayout.astro's own
        // listing default, with og:type still `website`.
        for (const file of [
          ["berita.html"],
          ["rubrik", "peristiwa.html"],
          ["daerah", "kotawaringin-barat.html"],
          ["mitra", "pemkab-kotawaringin-barat.html"]
        ] as const) {
          const tags = socialMeta(read(...file));
          expect(tags).toContain("og:type=website");
          expect(tags).toContain("og:image=https://media.example.test/brand/logo-bjekmart.png");
          expect(tags).toContain("og:image:width=512");
          expect(tags).toContain("og:image:height=512");
          expect(tags).toContain("og:image:alt=Logo BjekMart");
          expect(tags).toContain("twitter:card=summary");
          expect(tags).not.toContainEqual(expect.stringMatching(/^article:/));
        }

        // --- rel=prev/next: every fixture rubrik fits on one page
        // (RUBRIK_PAGE_SIZE = 10, six posts total), so page 1 must carry
        // NEITHER link — a `rel="next"` to a page that does not exist is
        // exactly the broken hint this must never emit. The multi-page
        // shape is pinned by tests/meta-sosial.test.ts's
        // rubrikPaginationLinks cases; the transferred `head` slot itself
        // is proven live below by the page's canonical (same <head>).
        for (const slug of ["peristiwa", "politik", "pidana"]) {
          const html = read("rubrik", `${slug}.html`);
          expect(relLinks(html)).toEqual([]);
          expect(headOf(html)).toContain(`<link rel="canonical" href="${SITE_URL}/rubrik/${slug}"`);
        }

        // --- The store pages' Open Graph block is UNCHANGED: the six
        // pre-issue-54 tags, in order, and nothing else — no og:image (even
        // though the logo resolved in this very build), no twitter:*, no
        // article:*. Fixture titles/descriptions from tests/fixtures/awcms/
        // {products,categories,blog-pages-public-detail,site-profile-
        // composed}.json.
        expect(socialMeta(read("product", "mie-gacoan.html"))).toEqual(
          preIssue54OgBlock(
            "/product/mie-gacoan",
            "Mie Gacoan",
            "Mie pedas legendaris, level cabai bisa disesuaikan."
          )
        );
        expect(socialMeta(read("kategori", "kebutuhan-pokok.html"))).toEqual(
          preIssue54OgBlock(
            "/kategori/kebutuhan-pokok",
            "Kebutuhan Pokok",
            "Produk kategori Kebutuhan Pokok."
          )
        );
        expect(socialMeta(read("produk.html"))).toEqual(
          preIssue54OgBlock(
            "/produk",
            "Semua Produk",
            "Jelajahi seluruh katalog produk BjekMart (Stub)."
          )
        );
        expect(socialMeta(read("halaman", "kebijakan-privasi.html"))).toEqual(
          preIssue54OgBlock(
            "/halaman/kebijakan-privasi",
            "Kebijakan Privasi",
            "Bagaimana kami mengelola data Anda."
          )
        );
        expect(socialMeta(read("index.html"))).toEqual(
          preIssue54OgBlock(
            "/",
            "BjekMart (Stub)",
            "Belanja online hemat, mudah, dan terpercaya (stub)"
          )
        );
        for (const file of ["index.html", "produk.html", join("product", "mie-gacoan.html")]) {
          expect(relLinks(read(file))).toEqual([]);
        }
      } finally {
        stub.kill();
        await stub.exited;
      }
    },
    TIMEOUT_MS
  );
});
