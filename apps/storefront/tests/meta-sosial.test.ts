import { describe, expect, test } from "bun:test";
import {
  articleSocialMeta,
  listingSocialMeta,
  ogImageMeta,
  postSeoText,
  rubrikPaginationLinks,
  videoSocialMeta,
  youtubeEmbedUrl,
  youtubeMaxresPosterUrl,
  type MetaTag
} from "../src/lib/meta-sosial";
import type { ResolvedMedia } from "../src/lib/awcms/media";
import type { PostDetail } from "../src/lib/berita";

/**
 * `src/lib/meta-sosial.ts` (issue #54, A8) — the pure OG/Twitter builders.
 * The rendered `<meta>` tags on a real page are asserted by
 * `tests/meta-sosial-build-smoke.test.ts`; this file pins the DECISIONS
 * (image precedence, namespace per `og:type`, card kind, prev/next URLs)
 * without a build.
 */

const HERO: ResolvedMedia = {
  id: "00000000-0000-4000-8000-000000000001",
  publicUrl: "https://media.example.test/news/hero.jpg",
  alt: "Peresmian jembatan",
  width: 1600,
  height: 900,
  creditLine: null,
  sourceName: null,
  copyrightStatus: "owned"
};

function post(overrides: Partial<PostDetail> = {}): PostDetail {
  return {
    id: "p1",
    slug: "judul",
    title: "Judul Berita",
    excerpt: "Ringkasan berita.",
    publishedAt: "2026-08-01T02:00:00.000Z",
    updatedAt: "2026-08-02T03:00:00.000Z",
    rubric: { slug: "politik", name: "Politik" },
    tags: [
      { slug: "pilkada", name: "Pilkada" },
      { slug: "ekonomi", name: "Ekonomi" }
    ],
    region: null,
    institutions: [],
    authorByline: null,
    isVideo: false,
    image: HERO,
    video: null,
    bodyPortableText: [],
    metaDescription: null,
    canonicalUrl: null,
    seoTitle: null,
    ...overrides
  };
}

function find(meta: readonly MetaTag[], key: string): string[] {
  return meta
    .filter((tag) => ("property" in tag ? tag.property : tag.name) === key)
    .map((tag) => tag.content);
}

describe("meta-sosial: ogImageMeta", () => {
  test("emits og:image plus width/height/alt when the CMS reported them", () => {
    expect(ogImageMeta(HERO)).toEqual([
      { property: "og:image", content: HERO.publicUrl },
      { property: "og:image:width", content: "1600" },
      { property: "og:image:height", content: "900" },
      { property: "og:image:alt", content: "Peresmian jembatan" }
    ]);
  });

  test("omits a dimension/alt the CMS did not report rather than guessing one", () => {
    const meta = ogImageMeta({ ...HERO, width: null, height: 0, alt: "  " });
    expect(meta).toEqual([{ property: "og:image", content: HERO.publicUrl }]);
  });

  test("null media, or a non-http(s) URL, emits nothing", () => {
    expect(ogImageMeta(null)).toEqual([]);
    expect(ogImageMeta({ ...HERO, publicUrl: "javascript:alert(1)" })).toEqual([]);
    expect(ogImageMeta({ ...HERO, publicUrl: "/relative/path.jpg" })).toEqual([]);
  });
});

describe("meta-sosial: articleSocialMeta", () => {
  test("og:type=article with the full article:* namespace and a large-image card", () => {
    const { ogType, meta } = articleSocialMeta(post());

    expect(ogType).toBe("article");
    expect(find(meta, "og:image")).toEqual([HERO.publicUrl]);
    expect(find(meta, "og:image:width")).toEqual(["1600"]);
    expect(find(meta, "article:published_time")).toEqual(["2026-08-01T02:00:00.000Z"]);
    expect(find(meta, "article:modified_time")).toEqual(["2026-08-02T03:00:00.000Z"]);
    expect(find(meta, "article:section")).toEqual(["Politik"]);
    expect(find(meta, "article:tag")).toEqual(["Pilkada", "Ekonomi"]);
    expect(find(meta, "twitter:card")).toEqual(["summary_large_image"]);
    expect(find(meta, "twitter:title")).toEqual(["Judul Berita"]);
    expect(find(meta, "twitter:description")).toEqual(["Ringkasan berita."]);
    expect(find(meta, "twitter:image")).toEqual([HERO.publicUrl]);

    // Never the video namespace on an article.
    expect(find(meta, "og:video:url")).toEqual([]);
    expect(find(meta, "video:release_date")).toEqual([]);
  });

  test("no resolved image → no og:image/twitter:image and a plain summary card", () => {
    const { meta } = articleSocialMeta(post({ image: null }));

    expect(find(meta, "og:image")).toEqual([]);
    expect(find(meta, "twitter:image")).toEqual([]);
    expect(find(meta, "twitter:card")).toEqual(["summary"]);
  });

  test("an uncategorised, untagged post emits no article:section/article:tag", () => {
    const { meta } = articleSocialMeta(post({ rubric: null, tags: [] }));
    expect(find(meta, "article:section")).toEqual([]);
    expect(find(meta, "article:tag")).toEqual([]);
  });

  test("twitter:title/description follow seoTitle/metaDescription with the page's own precedence, description clamped to 200", () => {
    const longDescription = "d".repeat(260);
    const { meta } = articleSocialMeta(
      post({ seoTitle: "Judul SEO", metaDescription: longDescription })
    );
    expect(find(meta, "twitter:title")).toEqual(["Judul SEO"]);
    expect(find(meta, "twitter:description")[0]).toHaveLength(200);

    expect(postSeoText(post({ seoTitle: "Judul SEO", metaDescription: "Meta" }))).toEqual({
      title: "Judul SEO",
      description: "Meta"
    });
    expect(postSeoText(post({ excerpt: null }))).toEqual({ title: "Judul Berita", description: null });
  });

  test("does NOT pre-escape attribute text — that is the layout's single render boundary", () => {
    const { meta } = articleSocialMeta(
      post({ rubric: { slug: "x", name: 'A & B <"C">' }, tags: [] })
    );
    expect(find(meta, "article:section")).toEqual(['A & B <"C">']);
  });
});

describe("meta-sosial: videoSocialMeta", () => {
  const video = { provider: "youtube" as const, videoId: "dQw4w9WgXcQ", thumbnail: "x" };

  test("og:type=video.other, YouTube maxres poster when the post has no featured image, embed URL, video:* namespace", () => {
    const { ogType, meta } = videoSocialMeta(post({ image: null, isVideo: true, video }));

    expect(ogType).toBe("video.other");
    expect(find(meta, "og:image")).toEqual(["https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"]);
    // No dimensions asserted for a poster this app has never fetched.
    expect(find(meta, "og:image:width")).toEqual([]);
    expect(find(meta, "og:video:url")).toEqual(["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]);
    expect(find(meta, "video:release_date")).toEqual(["2026-08-01T02:00:00.000Z"]);
    expect(find(meta, "video:tag")).toEqual(["Pilkada", "Ekonomi"]);
    expect(find(meta, "twitter:card")).toEqual(["summary_large_image"]);
    expect(find(meta, "twitter:image")).toEqual([
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
    ]);

    // Never the article namespace on a video.
    expect(find(meta, "article:published_time")).toEqual([]);
    expect(find(meta, "article:tag")).toEqual([]);
  });

  test("a video post's OWN featured image beats the YouTube poster — same precedence as ArtikelCard", () => {
    const { meta } = videoSocialMeta(post({ isVideo: true, video }));
    expect(find(meta, "og:image")).toEqual([HERO.publicUrl]);
    expect(find(meta, "og:image:width")).toEqual(["1600"]);
    expect(find(meta, "twitter:image")).toEqual([HERO.publicUrl]);
    expect(find(meta, "og:video:url")).toEqual(["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]);
  });

  test("a post with no playable video falls back to the article builder rather than a video.other page with no video", () => {
    const { ogType, meta } = videoSocialMeta(post({ video: null }));
    expect(ogType).toBe("article");
    expect(find(meta, "og:video:url")).toEqual([]);
  });

  test("URL helpers use the fixed CDN/embed conventions the facade itself uses", () => {
    expect(youtubeMaxresPosterUrl("abc")).toBe("https://i.ytimg.com/vi/abc/maxresdefault.jpg");
    expect(youtubeEmbedUrl("abc")).toBe("https://www.youtube-nocookie.com/embed/abc");
  });
});

describe("meta-sosial: listingSocialMeta", () => {
  test("a resolved logo becomes og:image (+ dimensions/alt) with a summary card", () => {
    const logo: ResolvedMedia = {
      ...HERO,
      publicUrl: "https://media.example.test/brand/logo.png",
      alt: "Logo",
      width: 512,
      height: 512
    };
    expect(listingSocialMeta(logo)).toEqual([
      { property: "og:image", content: "https://media.example.test/brand/logo.png" },
      { property: "og:image:width", content: "512" },
      { property: "og:image:height", content: "512" },
      { property: "og:image:alt", content: "Logo" },
      { name: "twitter:card", content: "summary" }
    ]);
  });

  test("no logo emits NOTHING — the page's OG block stays exactly as before", () => {
    expect(listingSocialMeta(null)).toEqual([]);
  });
});

describe("meta-sosial: rubrikPaginationLinks", () => {
  test("a single-page archive emits no links at all", () => {
    expect(rubrikPaginationLinks("politik", 1, 1)).toEqual([]);
    expect(rubrikPaginationLinks("politik", 1, 0)).toEqual([]);
  });

  test("page 1 of many emits only next, pointing at /halaman/2", () => {
    const links = rubrikPaginationLinks("politik", 1, 3);
    expect(links).toHaveLength(1);
    expect(links[0]?.rel).toBe("next");
    expect(links[0]?.href).toMatch(/^https?:\/\/.+\/rubrik\/politik\/halaman\/2$/);
  });

  test("page 2's prev is the BARE rubrik URL, never /halaman/1", () => {
    const links = rubrikPaginationLinks("politik", 2, 3);
    expect(links.map((l) => l.rel)).toEqual(["prev", "next"]);
    expect(links[0]?.href).toMatch(/\/rubrik\/politik$/);
    expect(links[1]?.href).toMatch(/\/rubrik\/politik\/halaman\/3$/);
  });

  test("the last page emits only prev", () => {
    const links = rubrikPaginationLinks("politik", 3, 3);
    expect(links.map((l) => l.rel)).toEqual(["prev"]);
    expect(links[0]?.href).toMatch(/\/rubrik\/politik\/halaman\/2$/);
  });

  test("every href is absolute, like the canonical", () => {
    for (const link of rubrikPaginationLinks("politik", 2, 3)) {
      expect(() => new URL(link.href)).not.toThrow();
    }
  });
});
