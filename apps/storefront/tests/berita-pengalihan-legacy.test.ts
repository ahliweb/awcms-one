import { describe, expect, test } from "bun:test";
import { buildLegacyRedirectMap, normalizeLegacyPath } from "../src/lib/pengalihan-legacy";

describe("lib/pengalihan-legacy: normalizeLegacyPath", () => {
  test("strips a query string and a trailing slash", () => {
    expect(normalizeLegacyPath("/2024/01/15/judul/?utm=fb")).toBe("/2024/01/15/judul");
  });

  test("leaves the bare root alone", () => {
    expect(normalizeLegacyPath("/")).toBe("/");
  });

  test("decodes percent-encoding", () => {
    expect(normalizeLegacyPath("/news/1-berita%20utama.html")).toBe("/news/1-berita utama.html");
  });

  test("preserves the query for a /video/?video=… source — its whole identity lives in the query, unlike ?utm=fb on a real path", () => {
    expect(normalizeLegacyPath("/video/?video=2-liputan-video-banjir.html")).toBe(
      "/video/?video=2-liputan-video-banjir.html"
    );
    expect(normalizeLegacyPath("/video?video=2-liputan-video-banjir.html")).toBe(
      "/video?video=2-liputan-video-banjir.html"
    );
  });
});

describe("lib/pengalihan-legacy: buildLegacyRedirectMap", () => {
  test("seputarborneo's /news/{id}-{slug}.html shape maps to /berita/{slug}", () => {
    const map = buildLegacyRedirectMap([
      {
        sourcePath: "/news/123-panduan-pemilu-2024.html",
        targetType: "relative_same_tenant",
        target: "/blog/bjekmart/panduan-pemilu-2024"
      }
    ]);
    expect(map["/news/123-panduan-pemilu-2024.html"]).toBe("/berita/panduan-pemilu-2024");
  });

  test("beritasampit's /{yyyy}/{mm}/{dd}/{slug}/ shape maps to /berita/{slug}", () => {
    const map = buildLegacyRedirectMap([
      {
        sourcePath: "/2024/01/15/panduan-pemilu-2024/",
        targetType: "relative_same_tenant",
        target: "/blog/bjekmart/panduan-pemilu-2024"
      }
    ]);
    expect(map["/2024/01/15/panduan-pemilu-2024"]).toBe("/berita/panduan-pemilu-2024");
  });

  test("a verified_external row is skipped — this app never redirects a reader off-site through this map", () => {
    const map = buildLegacyRedirectMap([
      {
        sourcePath: "/news/999-artikel-luar.html",
        targetType: "verified_external",
        target: "https://external.example.test/artikel"
      }
    ]);
    expect(Object.keys(map)).toEqual([]);
  });

  test("a row with no slug segment in its target is skipped, not crashed on", () => {
    const map = buildLegacyRedirectMap([
      { sourcePath: "/news/x.html", targetType: "relative_same_tenant", target: "/" }
    ]);
    expect(Object.keys(map)).toEqual([]);
  });

  test("two DIFFERENT sources may map to the SAME destination", () => {
    const map = buildLegacyRedirectMap([
      { sourcePath: "/news/1-a.html", targetType: "relative_same_tenant", target: "/blog/x/a" },
      { sourcePath: "/2024/01/01/a/", targetType: "relative_same_tenant", target: "/blog/x/a" }
    ]);
    expect(map["/news/1-a.html"]).toBe("/berita/a");
    expect(map["/2024/01/01/a"]).toBe("/berita/a");
  });

  test("the SAME source mapping to two DIFFERENT destinations throws rather than picking a winner silently", () => {
    expect(() =>
      buildLegacyRedirectMap([
        { sourcePath: "/news/1-a.html", targetType: "relative_same_tenant", target: "/blog/x/a" },
        { sourcePath: "/news/1-a.html", targetType: "relative_same_tenant", target: "/blog/x/b" }
      ])
    ).toThrow();
  });

  test("an empty row list yields an empty map, not an error", () => {
    expect(buildLegacyRedirectMap([])).toEqual({});
  });

  test("a slug in videoSlugs resolves to /video/{slug}, not /berita/{slug} (this app never publishes a video post at both)", () => {
    const map = buildLegacyRedirectMap(
      [
        { sourcePath: "/news/1-a.html", targetType: "relative_same_tenant", target: "/blog/x/a" },
        {
          sourcePath: "/video/?video=2-b.html",
          targetType: "relative_same_tenant",
          target: "/blog/x/b"
        }
      ],
      new Set(["b"])
    );
    expect(map["/news/1-a.html"]).toBe("/berita/a");
    expect(map["/video/?video=2-b.html"]).toBe("/video/b");
  });

  test("videoSlugs defaults to empty — every existing call site above keeps its old /berita/{slug} behavior", () => {
    const map = buildLegacyRedirectMap([
      { sourcePath: "/news/1-a.html", targetType: "relative_same_tenant", target: "/blog/x/a" }
    ]);
    expect(map["/news/1-a.html"]).toBe("/berita/a");
  });
});

describe("lib/pengalihan-legacy: the exporter's QUERY-FREE video key (issue #58 review round 2) — the shape the CMS can actually store", () => {
  test("normalizeLegacyPath passes /video/{id}-{slug}.html through like any other path (nothing to strip, nothing exempt)", () => {
    expect(normalizeLegacyPath("/video/5-banjir-disejumlah-daerah.html")).toBe("/video/5-banjir-disejumlah-daerah.html");
    expect(normalizeLegacyPath("/video/5-banjir-disejumlah-daerah.html?utm=fb")).toBe(
      "/video/5-banjir-disejumlah-daerah.html"
    );
    expect(normalizeLegacyPath("/video/7.html")).toBe("/video/7.html");
  });

  test("buildLegacyRedirectMap keys the synthetic path verbatim and resolves a video slug to /video/{slug}", () => {
    const map = buildLegacyRedirectMap(
      [
        {
          sourcePath: "/video/5-banjir-disejumlah-daerah.html",
          targetType: "relative_same_tenant",
          target: "/blog/borneojek-mart/banjir-disejumlah-daerah"
        },
        {
          sourcePath: "/video/6-video-kedua.html",
          targetType: "relative_same_tenant",
          target: "/blog/borneojek-mart/video-kedua"
        }
      ],
      new Set(["banjir-disejumlah-daerah", "video-kedua"])
    );
    expect(map).toEqual({
      "/video/5-banjir-disejumlah-daerah.html": "/video/banjir-disejumlah-daerah",
      "/video/6-video-kedua.html": "/video/video-kedua"
    });
  });

  test("two video rows never collide on a bare /video key any more — each synthetic key is its own entry, no conflict throw", () => {
    expect(() =>
      buildLegacyRedirectMap(
        [
          { sourcePath: "/video/1-satu.html", targetType: "relative_same_tenant", target: "/blog/x/satu" },
          { sourcePath: "/video/2-dua.html", targetType: "relative_same_tenant", target: "/blog/x/dua" }
        ],
        new Set(["satu", "dua"])
      )
    ).not.toThrow();
  });

  test("what the CMS would have stored for the OLD ?video= form — a bare /video — IS the conflict this key avoids", () => {
    // `normalizeRedirectPath` (apps/cms, without keepQuery) turns every
    // `/video/?video=…` source into `/video`; two such rows with different
    // targets are exactly the throw below.
    expect(() =>
      buildLegacyRedirectMap(
        [
          { sourcePath: "/video", targetType: "relative_same_tenant", target: "/blog/x/satu" },
          { sourcePath: "/video", targetType: "relative_same_tenant", target: "/blog/x/dua" }
        ],
        new Set(["satu", "dua"])
      )
    ).toThrow(/two different destinations/);
  });
});
