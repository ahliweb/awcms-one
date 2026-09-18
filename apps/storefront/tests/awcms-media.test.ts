/**
 * `src/lib/awcms/media.ts` (issue #47) — the `media_library` read client.
 * Covers this issue's own Acceptance bullets: chunking at 100 ids,
 * unresolved id -> omitted from the result (never a throw), the per-id
 * memoization cache, and `getMediaPublicOrigin`'s `configured`/degrade
 * behaviour. Same fetch-mocking pattern `tests/wilayah-checkout.test.ts`
 * already established for a sibling `src/lib/awcms/*.ts` client.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  resolveMedia,
  resolveOneMedia,
  getMediaPublicOrigin,
  resetMediaCachesForTests,
  type ResolvedMedia
} from "../src/lib/awcms/media";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_URL = process.env.AWCMS_API_URL;
const ORIGINAL_API_TOKEN = process.env.AWCMS_API_TOKEN;

beforeEach(() => {
  process.env.AWCMS_API_URL = "http://awcms.test";
  process.env.AWCMS_API_TOKEN = "test-token";
  resetMediaCachesForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_API_URL === undefined) delete process.env.AWCMS_API_URL;
  else process.env.AWCMS_API_URL = ORIGINAL_API_URL;
  if (ORIGINAL_API_TOKEN === undefined) delete process.env.AWCMS_API_TOKEN;
  else process.env.AWCMS_API_TOKEN = ORIGINAL_API_TOKEN;
  resetMediaCachesForTests();
});

function rawItem(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    publicUrl: `https://media.example.test/${id}.jpg`,
    altText: "Alt text",
    mimeType: "image/jpeg",
    width: 800,
    height: 600,
    sizeBytes: 12345,
    creditLine: null,
    sourceName: null,
    copyrightStatus: null,
    ...overrides
  };
}

describe("resolveMedia: chunking", () => {
  test("sends at most 100 ids per call, in as many calls as needed", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    const requestedIdsPerCall: string[][] = [];

    globalThis.fetch = (async (url: string | URL) => {
      const parsed = new URL(url);
      const requested = (parsed.searchParams.get("ids") ?? "").split(",");
      requestedIdsPerCall.push(requested);
      return new Response(
        JSON.stringify({
          success: true,
          data: { items: requested.map((id) => rawItem(id)), unresolved: [] }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const resolved = await resolveMedia(ids);

    expect(requestedIdsPerCall).toHaveLength(2);
    expect(requestedIdsPerCall[0]).toHaveLength(100);
    expect(requestedIdsPerCall[1]).toHaveLength(50);
    expect(resolved.size).toBe(150);
    expect(resolved.get("id-0")?.publicUrl).toBe("https://media.example.test/id-0.jpg");
  });

  test("de-duplicates ids before chunking — a repeated id costs one resolution, not two", async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: string | URL) => {
      callCount += 1;
      const parsed = new URL(url);
      const requested = (parsed.searchParams.get("ids") ?? "").split(",");
      return new Response(
        JSON.stringify({
          success: true,
          data: { items: requested.map((id) => rawItem(id)), unresolved: [] }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const resolved = await resolveMedia(["a", "a", "b", "a"]);
    expect(callCount).toBe(1);
    expect(resolved.size).toBe(2);
  });
});

describe("resolveMedia: unresolved ids never throw", () => {
  test("an unresolved id is simply absent from the result map", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { items: [rawItem("known")], unresolved: ["missing"] }
        }),
        { headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const resolved = await resolveMedia(["known", "missing"]);
    expect(resolved.has("known")).toBe(true);
    expect(resolved.has("missing")).toBe(false);
    expect(resolved.size).toBe(1);
  });

  test("resolveOneMedia returns null for an id that never resolves, and for null/undefined", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: true, data: { items: [], unresolved: ["x"] } }),
        { headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    expect(await resolveOneMedia("x")).toBeNull();
    expect(await resolveOneMedia(null)).toBeNull();
    expect(await resolveOneMedia(undefined)).toBeNull();
  });

  test("a 403/404 (module off or permission missing) degrades to nothing resolved, not a throw", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: "FORBIDDEN", message: "no." } }),
        { status: 403, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const resolved = await resolveMedia(["a", "b"]);
    expect(resolved.size).toBe(0);
  });

  test("a genuine transport failure (not 403/404) still throws", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: "INTERNAL", message: "boom" } }),
        { status: 500, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    await expect(resolveMedia(["a"])).rejects.toThrow();
  });
});

describe("resolveMedia: memoization", () => {
  test("a second call with an already-resolved id makes no further request for it", async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: string | URL) => {
      callCount += 1;
      const parsed = new URL(url);
      const requested = (parsed.searchParams.get("ids") ?? "").split(",");
      return new Response(
        JSON.stringify({
          success: true,
          data: { items: requested.map((id) => rawItem(id)), unresolved: [] }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    await resolveMedia(["a"]);
    expect(callCount).toBe(1);

    const second = await resolveMedia(["a", "b"]);
    // Only "b" is new; "a" is served from cache.
    expect(callCount).toBe(2);
    expect(second.size).toBe(2);
  });
});

describe("getMediaPublicOrigin", () => {
  test("returns the configured origin, fetched once and memoized", async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({
          success: true,
          data: { configured: true, origin: "https://media.example.test", baseUrl: "https://media.example.test/news" }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const first = await getMediaPublicOrigin();
    const second = await getMediaPublicOrigin();
    expect(first).toEqual({
      configured: true,
      origin: "https://media.example.test",
      baseUrl: "https://media.example.test/news"
    });
    expect(second).toBe(first); // same memoized promise, not a re-fetch.
    expect(callCount).toBe(1);
  });

  test("a 403/404 degrades to UNCONFIGURED, not a throw", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "no." } }),
        { status: 404, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    expect(await getMediaPublicOrigin()).toEqual({ configured: false, origin: null, baseUrl: null });
  });
});

// Type-only compile check: ResolvedMedia carries exactly the fields this app renders.
const _typeCheck: ResolvedMedia = {
  id: "x",
  publicUrl: "https://media.example.test/x.jpg",
  alt: null,
  width: null,
  height: null,
  creditLine: null,
  sourceName: null,
  copyrightStatus: null
};
void _typeCheck;
