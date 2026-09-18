/**
 * `src/lib/awcms/analitik.ts` (issue #49) — the `visitor_analytics` read
 * client behind the sidebar's "Terpopuler". Covers the issue's own
 * Acceptance bullet ("Terpopuler mapping + fallback"): the path → slug
 * mapping and its query-string folding, the ranking/top-up rule, the
 * whole-list fallback when nothing maps, and the fetch's own contract
 * (`range=7d` on the wire, memoized once per build, 403/404 degrade to
 * "no data", anything else still fails the build). Same fetch-mocking
 * pattern `tests/awcms-media.test.ts` established for a sibling
 * `src/lib/awcms/*.ts` client.
 *
 * Distinct from `tests/analitik.test.ts`, which is issue #56's BROWSER
 * beacon (`src/scripts/analitik.ts`, the write side of the same module).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getTopPaths,
  hitungTayangPerSlug,
  pilihTerpopuler,
  resetAnalitikCacheForTests,
  slugDariPath,
  TERPOPULER_RANGE,
  type TopPath
} from "../src/lib/awcms/analitik";
import { AwcmsApiError } from "../src/lib/awcms/client";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_URL = process.env.AWCMS_API_URL;
const ORIGINAL_API_TOKEN = process.env.AWCMS_API_TOKEN;

beforeEach(() => {
  process.env.AWCMS_API_URL = "http://awcms.test";
  process.env.AWCMS_API_TOKEN = "test-token";
  resetAnalitikCacheForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_API_URL === undefined) delete process.env.AWCMS_API_URL;
  else process.env.AWCMS_API_URL = ORIGINAL_API_URL;
  if (ORIGINAL_API_TOKEN === undefined) delete process.env.AWCMS_API_TOKEN;
  else process.env.AWCMS_API_TOKEN = ORIGINAL_API_TOKEN;
  resetAnalitikCacheForTests();
});

// ---------------------------------------------------------------------------
// slugDariPath — which `path_sanitized` values name a post
// ---------------------------------------------------------------------------

describe("slugDariPath", () => {
  test("maps both post URL shapes and nothing else", () => {
    expect(slugDariPath("/berita/jembatan-baru")).toBe("jembatan-baru");
    expect(slugDariPath("/video/kebakaran-pasar")).toBe("kebakaran-pasar");

    // The front page, the feed, archives, and store paths never name a post.
    expect(slugDariPath("/berita")).toBeNull();
    expect(slugDariPath("/berita/")).toBeNull();
    expect(slugDariPath("/berita/feed.xml")).toBe("feed.xml"); // a slug-shaped path; it simply matches no post
    expect(slugDariPath("/rubrik/politik")).toBeNull();
    expect(slugDariPath("/tag/pilkada")).toBeNull();
    expect(slugDariPath("/product/kopi")).toBeNull();
    expect(slugDariPath("/")).toBeNull();
    expect(slugDariPath("/berita/a/b")).toBeNull(); // deeper than a post URL
  });

  test("drops the surviving query string and fragment, tolerates one trailing slash", () => {
    expect(slugDariPath("/berita/jembatan-baru?utm_source=whatsapp&fbclid=x")).toBe("jembatan-baru");
    expect(slugDariPath("/berita/jembatan-baru#komentar")).toBe("jembatan-baru");
    expect(slugDariPath("/berita/jembatan-baru/")).toBe("jembatan-baru");
    expect(slugDariPath("/berita/jembatan-baru/?x=1")).toBe("jembatan-baru");
  });

  test("percent-decodes a non-ASCII slug and survives a malformed escape", () => {
    expect(slugDariPath("/berita/kopi%20luwak")).toBe("kopi luwak");
    expect(slugDariPath("/berita/%E2%82")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hitungTayangPerSlug — sums every path variant of one post
// ---------------------------------------------------------------------------

describe("hitungTayangPerSlug", () => {
  test("folds query-string variants of one post into one count and skips non-post paths", () => {
    const paths: TopPath[] = [
      { name: "/", count: 400 },
      { name: "/berita/a", count: 70 },
      { name: "/berita/b", count: 60 },
      { name: "/berita/a?utm_source=wa", count: 20 },
      { name: "/video/c", count: 15 },
      { name: "/rubrik/politik", count: 10 }
    ];

    const perSlug = hitungTayangPerSlug(paths);
    expect([...perSlug.entries()]).toEqual([
      ["a", 90],
      ["b", 60],
      ["c", 15]
    ]);
  });

  test("ignores a row with a non-positive, non-finite or non-string payload", () => {
    const perSlug = hitungTayangPerSlug([
      { name: "/berita/a", count: 0 },
      { name: "/berita/b", count: Number.NaN },
      { name: "/berita/c", count: -3 },
      { name: 42 as unknown as string, count: 10 },
      { name: "/berita/d", count: 1 }
    ]);
    expect([...perSlug.entries()]).toEqual([["d", 1]]);
  });
});

// ---------------------------------------------------------------------------
// pilihTerpopuler — ranking, top-up, whole-list fallback
// ---------------------------------------------------------------------------

const post = (slug: string) => ({ slug });
const newestFirst = [post("n1"), post("n2"), post("n3"), post("n4"), post("n5"), post("n6")];

describe("pilihTerpopuler", () => {
  test("ranks by pageviews, highest first, and never returns more than `limit`", () => {
    const counts = new Map([
      ["n3", 50],
      ["n1", 10],
      ["n5", 99],
      ["n6", 20]
    ]);
    expect(pilihTerpopuler(newestFirst, newestFirst, counts, 3).map((p) => p.slug)).toEqual([
      "n5",
      "n3",
      "n6"
    ]);
  });

  test("a tie keeps the candidates' own (newest-first) order", () => {
    const counts = new Map([
      ["n4", 7],
      ["n2", 7],
      ["n6", 7]
    ]);
    expect(pilihTerpopuler(newestFirst, newestFirst, counts, 3).map((p) => p.slug)).toEqual([
      "n2",
      "n4",
      "n6"
    ]);
  });

  test("tops up from the latest list, skipping posts already ranked, when fewer than `limit` have any views", () => {
    const counts = new Map([["n4", 3]]);
    expect(pilihTerpopuler(newestFirst, newestFirst, counts, 4).map((p) => p.slug)).toEqual([
      "n4",
      "n1",
      "n2",
      "n3"
    ]);
  });

  test("falls back to exactly the first `limit` of the latest list when nothing maps (module off / 403 / no traffic)", () => {
    expect(pilihTerpopuler(newestFirst, newestFirst, new Map(), 5).map((p) => p.slug)).toEqual([
      "n1",
      "n2",
      "n3",
      "n4",
      "n5"
    ]);

    // A count for a slug no candidate has (a deleted or never-published
    // post) is not a mapped post either.
    const orphan = new Map([["tidak-pernah-terbit", 180]]);
    expect(pilihTerpopuler(newestFirst, newestFirst, orphan, 2).map((p) => p.slug)).toEqual(["n1", "n2"]);
  });

  test("candidates and the latest list may differ (video posts rank; the top-up stays non-video)", () => {
    const video = post("v1");
    const counts = new Map([["v1", 30]]);
    expect(
      pilihTerpopuler([...newestFirst, video], newestFirst, counts, 2).map((p) => p.slug)
    ).toEqual(["v1", "n1"]);
  });

  test("a non-positive limit is an empty list", () => {
    expect(pilihTerpopuler(newestFirst, newestFirst, new Map([["n1", 5]]), 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getTopPaths — the wire contract and its degrade
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** Replaces `globalThis.fetch` for one test — `awcmsGet` always passes a `URL`, which `handler` receives parsed. */
function mockFetch(handler: (url: URL) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL | Request) =>
    handler(new URL(input instanceof Request ? input.url : String(input)))) as unknown as typeof fetch;
}

describe("getTopPaths", () => {
  test("calls GET /api/v1/analytics/pages with range=7d and unwraps `pages`", async () => {
    const seen: URL[] = [];
    mockFetch((url) => {
      seen.push(url);
      return jsonResponse({
        success: true,
        data: { range: "7d", pages: [{ name: "/berita/a", count: 3 }] }
      });
    });

    const pages = await getTopPaths();

    expect(pages).toEqual([{ name: "/berita/a", count: 3 }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.pathname).toBe("/api/v1/analytics/pages");
    expect(seen[0]!.searchParams.get("range")).toBe(TERPOPULER_RANGE);
    expect(TERPOPULER_RANGE).toBe("7d");
  });

  test("is fetched once per build — a second call reuses the memoized answer", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      return jsonResponse({ success: true, data: { range: "7d", pages: [] } });
    });

    await getTopPaths();
    await getTopPaths();
    expect(calls).toBe(1);
  });

  test.each([
    [403, "MODULE_DISABLED"],
    [403, "ACCESS_DENIED"],
    [404, "NOT_FOUND"]
  ])("degrades a %d %s to an empty list — the sidebar then renders 'latest'", async (status, code) => {
    mockFetch(() => jsonResponse({ success: false, error: { code, message: "refused" } }, status));

    expect(await getTopPaths()).toEqual([]);
  });

  test("any other failure still fails the build (5xx is not 'no data')", async () => {
    mockFetch(() => jsonResponse({ success: false, error: { code: "INTERNAL", message: "boom" } }, 500));

    await expect(getTopPaths()).rejects.toBeInstanceOf(AwcmsApiError);
  });

  test("a `pages` that is not an array is treated as no data, never a crash in the sidebar", async () => {
    mockFetch(() => jsonResponse({ success: true, data: { range: "7d", pages: null } }));

    expect(await getTopPaths()).toEqual([]);
  });
});
