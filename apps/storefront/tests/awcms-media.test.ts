/**
 * `src/lib/awcms/media.ts` (issue #47) — the `media_library` read client.
 * Covers this issue's own Acceptance bullets: chunking at 100 ids,
 * unresolved id -> omitted from the result (never a throw), the per-id
 * memoization cache, `getMediaPublicOrigin`'s `configured`/degrade
 * behaviour, and a PR #65 review finding: a non-uuid id must never be sent
 * to `GET /api/v1/media/objects` at all (that route 400s the WHOLE request
 * over one malformed id — see `resolveMedia`'s own docblock). Same
 * fetch-mocking pattern `tests/wilayah-checkout.test.ts` already
 * established for a sibling `src/lib/awcms/*.ts` client.
 *
 * Every id below is uuid-SHAPED (this file's own `uuid()` helper) precisely
 * because the client now filters anything that is not, before ever calling
 * `fetch` — a fixture using bare strings like `"a"`/`"x"` would exercise
 * only that filter, never the chunking/memoization/unresolved-reporting
 * behaviour it is meant to test.
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

/** A uuid-SHAPED id, distinct per `n` — matches `GET /api/v1/media/objects`'s own `UUID_PATTERN`; not a real v4, which that route does not require either. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

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
    const ids = Array.from({ length: 150 }, (_, i) => uuid(i));
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
    expect(resolved.get(uuid(0))?.publicUrl).toBe(`https://media.example.test/${uuid(0)}.jpg`);
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

    const resolved = await resolveMedia([uuid(1), uuid(1), uuid(2), uuid(1)]);
    expect(callCount).toBe(1);
    expect(resolved.size).toBe(2);
  });
});

describe("resolveMedia: a non-uuid id is filtered out before it is ever sent (PR #65 review finding)", () => {
  test("a non-uuid id never reaches fetch, and resolves to nothing — the uuid-shaped ids in the SAME call still resolve", async () => {
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

    // "legacy-gallery-item-42" is exactly the shape a pre-migration/
    // hand-authored row could carry — GET /api/v1/media/objects would 400
    // the WHOLE request if this were sent alongside a real uuid.
    const resolved = await resolveMedia([uuid(1), "legacy-gallery-item-42", uuid(2)]);

    expect(requestedIdsPerCall).toHaveLength(1);
    expect(requestedIdsPerCall[0]).toEqual([uuid(1), uuid(2)]);
    expect(requestedIdsPerCall[0]).not.toContain("legacy-gallery-item-42");

    expect(resolved.has(uuid(1))).toBe(true);
    expect(resolved.has(uuid(2))).toBe(true);
    expect(resolved.has("legacy-gallery-item-42")).toBe(false);
  });

  test("a call with ONLY non-uuid ids never calls fetch at all", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("fetch should not have been called");
    }) as unknown as typeof fetch;

    const resolved = await resolveMedia(["not-a-uuid", "also-not-one"]);
    expect(called).toBe(false);
    expect(resolved.size).toBe(0);
  });

  test("resolveOneMedia returns null for a non-uuid id, without calling fetch", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("fetch should not have been called");
    }) as unknown as typeof fetch;

    expect(await resolveOneMedia("not-a-uuid")).toBeNull();
    expect(called).toBe(false);
  });
});

describe("resolveMedia: unresolved ids never throw", () => {
  test("an unresolved id is simply absent from the result map", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { items: [rawItem(uuid(1))], unresolved: [uuid(2)] }
        }),
        { headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const resolved = await resolveMedia([uuid(1), uuid(2)]);
    expect(resolved.has(uuid(1))).toBe(true);
    expect(resolved.has(uuid(2))).toBe(false);
    expect(resolved.size).toBe(1);
  });

  test("resolveOneMedia returns null for an id that never resolves, and for null/undefined", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: true, data: { items: [], unresolved: [uuid(9)] } }),
        { headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    expect(await resolveOneMedia(uuid(9))).toBeNull();
    expect(await resolveOneMedia(null)).toBeNull();
    expect(await resolveOneMedia(undefined)).toBeNull();
  });

  test("a 403/404 (module off or permission missing) degrades to nothing resolved, not a throw", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: "FORBIDDEN", message: "no." } }),
        { status: 403, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const resolved = await resolveMedia([uuid(1), uuid(2)]);
    expect(resolved.size).toBe(0);
  });

  test("a genuine transport failure (not 403/404) still throws", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: "INTERNAL", message: "boom" } }),
        { status: 500, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    await expect(resolveMedia([uuid(1)])).rejects.toThrow();
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

    await resolveMedia([uuid(1)]);
    expect(callCount).toBe(1);

    const second = await resolveMedia([uuid(1), uuid(2)]);
    // Only uuid(2) is new; uuid(1) is served from cache.
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
  id: uuid(0),
  publicUrl: `https://media.example.test/${uuid(0)}.jpg`,
  alt: null,
  width: null,
  height: null,
  creditLine: null,
  sourceName: null,
  copyrightStatus: null
};
void _typeCheck;
