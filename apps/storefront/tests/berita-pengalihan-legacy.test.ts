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
