import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLegacyRedirectMap,
  legacyRedirectLocation,
  createServer
} from "../server/penyaji.mjs";

/**
 * `server/penyaji.mjs`'s additive legacy-redirect hook (issue #28) — a NEW
 * file, per this issue's own instruction not to edit `tests/penyaji.test.ts`
 * (issue #24's own suite). Same fixture-directory pattern that file already
 * uses for `readBuildId`/`discoverCssPreloadPaths`.
 */

describe("server/penyaji: readLegacyRedirectMap", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("reads the map awcms build index/pengalihan-legacy.json wrote", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-legacy-test-"));
    mkdirSync(join(dir, "index"));
    writeFileSync(
      join(dir, "index", "pengalihan-legacy.json"),
      JSON.stringify({ "/news/1-x.html": "/berita/x" })
    );
    const clientDir = new URL(`file://${dir}/`);
    expect(readLegacyRedirectMap(clientDir)).toEqual({ "/news/1-x.html": "/berita/x" });
  });

  test("degrades to {} when the file is missing — a fresh checkout with no dist/ yet", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-legacy-test-"));
    const clientDir = new URL(`file://${dir}/`);
    expect(readLegacyRedirectMap(clientDir)).toEqual({});
  });

  test("degrades to {} on malformed JSON rather than crashing the server at startup", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-legacy-test-"));
    mkdirSync(join(dir, "index"));
    writeFileSync(join(dir, "index", "pengalihan-legacy.json"), "{not json");
    const clientDir = new URL(`file://${dir}/`);
    expect(readLegacyRedirectMap(clientDir)).toEqual({});
  });

  test("degrades to {} when the file holds an array instead of a map", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-legacy-test-"));
    mkdirSync(join(dir, "index"));
    writeFileSync(join(dir, "index", "pengalihan-legacy.json"), "[]");
    const clientDir = new URL(`file://${dir}/`);
    expect(readLegacyRedirectMap(clientDir)).toEqual({});
  });
});

describe("server/penyaji: legacyRedirectLocation", () => {
  const map = { "/news/1-x.html": "/berita/x", "/2024/01/15/y": "/berita/y" };

  test("matches an exact path, ignoring a query string", () => {
    expect(legacyRedirectLocation("/news/1-x.html?utm=fb", map)).toBe("/berita/x");
  });

  test("returns null for a path with no matching rule", () => {
    expect(legacyRedirectLocation("/news/2-y.html", map)).toBeNull();
  });

  test("returns null against an empty map", () => {
    expect(legacyRedirectLocation("/news/1-x.html", {})).toBeNull();
  });

  test("REGRESSION: a beritasampit-shaped request WITH a trailing slash still matches a map key WITHOUT one", () => {
    // src/lib/pengalihan-legacy.ts's normalizeLegacyPath strips a trailing
    // slash when the map is built; path.posix.normalize (normalizedPath,
    // above) does NOT strip one from an incoming request. Missing this
    // case silently drops every beritasampit-shaped legacy URL.
    expect(legacyRedirectLocation("/2024/01/15/y/", map)).toBe("/berita/y");
    expect(legacyRedirectLocation("/2024/01/15/y/?utm=fb", map)).toBe("/berita/y");
  });
});

describe("server/penyaji: the legacy-redirect hook inside createServer", () => {
  function withServer(
    context: Record<string, unknown>,
    run: (baseUrl: string) => Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.statusCode = 200;
        res.end("app handler reached");
      }, context);

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        run(`http://127.0.0.1:${port}`)
          .then(() => server.close(() => resolve()))
          .catch((error) => server.close(() => reject(error)));
      });
    });
  }

  test("a matching legacy path 301s and never reaches the app handler", async () => {
    await withServer(
      { legacyRedirects: { "/news/1-x.html": "/berita/x" } },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/news/1-x.html`, { redirect: "manual" });
        expect(response.status).toBe(301);
        expect(response.headers.get("location")).toBe("/berita/x");
      }
    );
  });

  test("a non-matching path reaches the app handler as usual", async () => {
    await withServer({ legacyRedirects: { "/news/1-x.html": "/berita/x" } }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/berita/lain`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("app handler reached");
    });
  });

  test("no legacyRedirects in context behaves exactly as before this issue", async () => {
    await withServer({}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/news/1-x.html`);
      expect(response.status).toBe(200);
    });
  });
});
