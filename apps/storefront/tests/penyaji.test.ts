import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import {
  applyHeaders,
  createServer,
  cacheControlFor,
  isProductsRedirect,
  isHealthzRequest,
  readBuildId,
  discoverCssPreloadPaths,
  preloadLinkHeaderValue,
  SECURITY_HEADERS,
  CSP
} from "../server/penyaji.mjs";

describe("server/penyaji: pure helpers", () => {
  test("cacheControlFor is immutable for _astro assets, revalidate-on-use for pages", () => {
    expect(cacheControlFor("/_astro/app.abc123.css")).toContain("immutable");
    expect(cacheControlFor("/kontak")).toContain("must-revalidate");
  });

  test("isProductsRedirect matches /products regardless of query string", () => {
    expect(isProductsRedirect("/products")).toBe(true);
    expect(isProductsRedirect("/products?category_slug=x")).toBe(true);
    expect(isProductsRedirect("/produk")).toBe(false);
  });

  test("isHealthzRequest matches only the exact path", () => {
    expect(isHealthzRequest("/healthz")).toBe(true);
    expect(isHealthzRequest("/healthz/")).toBe(false);
    expect(isHealthzRequest("/api/healthz")).toBe(false);
  });

  test("preloadLinkHeaderValue joins paths as rel=preload;as=style entries", () => {
    expect(preloadLinkHeaderValue(["/_astro/a.css", "/_astro/b.css"])).toBe(
      "</_astro/a.css>; rel=preload; as=style, </_astro/b.css>; rel=preload; as=style"
    );
    expect(preloadLinkHeaderValue([])).toBe("");
  });
});

describe("server/penyaji: build-id + CSS discovery against a fixture dist/client/", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("readBuildId reads and trims dist/client/build-id.txt", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-test-"));
    writeFileSync(join(dir, "build-id.txt"), "abc1234\n");
    const clientDir = new URL(`file://${dir}/`);
    expect(readBuildId(clientDir)).toBe("abc1234");
  });

  test("readBuildId degrades to 'unknown' when the file is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-test-"));
    const clientDir = new URL(`file://${dir}/`);
    expect(readBuildId(clientDir)).toBe("unknown");
  });

  test("discoverCssPreloadPaths lists only .css files under _astro/, sorted", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-test-"));
    mkdirSync(join(dir, "_astro"));
    writeFileSync(join(dir, "_astro", "b.css"), "");
    writeFileSync(join(dir, "_astro", "a.css"), "");
    writeFileSync(join(dir, "_astro", "script.js"), "");
    const clientDir = new URL(`file://${dir}/`);
    expect(discoverCssPreloadPaths(clientDir)).toEqual(["/_astro/a.css", "/_astro/b.css"]);
  });

  test("discoverCssPreloadPaths degrades to an empty list when the directory is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-test-"));
    const clientDir = new URL(`file://${dir}/`);
    expect(discoverCssPreloadPaths(clientDir)).toEqual([]);
  });
});

describe("server/penyaji: HTTP behaviour (no real dist/ build needed)", () => {
  function withServer(
    context: Record<string, unknown>,
    run: (baseUrl: string) => Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.statusCode = 200;
        res.end("ok");
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

  test("every security header is sent, and Server/X-Powered-By are stripped", async () => {
    await withServer({}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/kontak`);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(response.headers.get(name)).toBe(value);
      }
      expect(response.headers.get("content-security-policy")).toBe(CSP);
      expect(response.headers.has("server")).toBe(false);
      expect(response.headers.has("x-powered-by")).toBe(false);
    });
  });

  test("GET /healthz answers { ok: true, build } with no-store, before the app handler runs", async () => {
    await withServer({ buildId: "test-build-42" }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/healthz`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({ ok: true, build: "test-build-42" });
    });
  });

  test("GET /healthz reports 'unknown' when no buildId was provided", async () => {
    await withServer({}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/healthz`);
      const body = await response.json();
      expect(body.build).toBe("unknown");
    });
  });

  test("/products redirects 301, and never reaches the app handler", async () => {
    await withServer({}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/products?category_slug=x`, { redirect: "manual" });
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe("/");
    });
  });

  test("Link: rel=preload is sent on a page response when CSS paths are configured, never on an _astro/* asset response", async () => {
    await withServer({ cssPreloadLinks: ["/_astro/app.css"] }, async (baseUrl) => {
      const page = await fetch(`${baseUrl}/kontak`);
      expect(page.headers.get("link")).toBe("</_astro/app.css>; rel=preload; as=style");

      const asset = await fetch(`${baseUrl}/_astro/app.css`);
      expect(asset.headers.has("link")).toBe(false);
    });
  });

  test("no Link header at all when no CSS paths are configured", async () => {
    await withServer({}, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/kontak`);
      expect(response.headers.has("link")).toBe(false);
    });
  });
});

// `applyHeaders` is also reachable directly against a bare node:http response
// object, for the one assertion that needs to inspect a header BEFORE the
// handler has a chance to overwrite it (Cache-Control precedence).
describe("server/penyaji: applyHeaders order", () => {
  test("sets Cache-Control before any handler runs, so a later explicit set (e.g. /healthz) can still override it", () => {
    const res = new http.ServerResponse(new http.IncomingMessage(null as never));
    applyHeaders({ url: "/healthz" } as never, res);
    expect(res.getHeader("cache-control")).toContain("must-revalidate");
  });
});
