import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, discoverShadowedHtmlPaths, shadowedHtmlUrl } from "../server/penyaji.mjs";

/**
 * `server/penyaji.mjs`'s shadowed-page rewrite (issue #75) — a NEW file
 * beside `berita-penyaji-legacy.test.ts` (issue #28's own suite), following
 * the same fixture-directory pattern: a synthetic `dist/client/` tree in a
 * temp dir, never a real build. The real-build proof that `GET /berita` and
 * `GET /video` answer 200 through the BUNDLED server lives in
 * `penyaji-bayangan-build-smoke.test.ts`.
 */

/** Writes the shape `astro build` emits under `build.format: "file"` when a landing page also has children. */
function writeFixtureTree(dir: string): void {
  // /berita (shadowed): berita.html beside berita/ holding the articles.
  writeFileSync(join(dir, "berita.html"), "<!doctype html>berita");
  mkdirSync(join(dir, "berita"));
  writeFileSync(join(dir, "berita", "satu.html"), "<!doctype html>satu");
  writeFileSync(join(dir, "berita", "feed.xml"), "<rss/>");

  // /video (shadowed).
  writeFileSync(join(dir, "video.html"), "<!doctype html>video");
  mkdirSync(join(dir, "video"));
  writeFileSync(join(dir, "video", "klip.html"), "<!doctype html>klip");

  // /rubrik/peristiwa (NESTED shadow): rubrik/peristiwa.html beside
  // rubrik/peristiwa/ (its feed and pagination) — /rubrik itself has no
  // rubrik.html, so it is NOT shadowed.
  mkdirSync(join(dir, "rubrik"));
  writeFileSync(join(dir, "rubrik", "peristiwa.html"), "<!doctype html>peristiwa");
  mkdirSync(join(dir, "rubrik", "peristiwa"));
  writeFileSync(join(dir, "rubrik", "peristiwa", "feed.xml"), "<rss/>");
  mkdirSync(join(dir, "rubrik", "peristiwa", "halaman"));
  writeFileSync(join(dir, "rubrik", "peristiwa", "halaman", "2.html"), "<!doctype html>2");

  // /kontak: a plain page with no same-named directory — the adapter's own
  // `.html` fallback already serves it; nothing to rewrite.
  writeFileSync(join(dir, "kontak.html"), "<!doctype html>kontak");

  // /_astro: a directory with no `_astro.html` beside it.
  mkdirSync(join(dir, "_astro"));
  writeFileSync(join(dir, "_astro", "a.css"), "");

  // A directory whose sibling file is NOT `.html` — `index.json` beside
  // `index/` must not count.
  writeFileSync(join(dir, "index.json"), "{}");
  mkdirSync(join(dir, "index"));
  writeFileSync(join(dir, "index", "berita.json"), "[]");
}

describe("server/penyaji: discoverShadowedHtmlPaths against a synthetic dist/client/", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("lists every page whose .html has a same-named directory beside it, at any depth", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-bayangan-test-"));
    writeFixtureTree(dir);
    const clientDir = new URL(`file://${dir}/`);

    const shadowed = discoverShadowedHtmlPaths(clientDir);
    expect([...shadowed].sort()).toEqual(["/berita", "/rubrik/peristiwa", "/video"]);
  });

  test("a directory with no .html sibling, or a non-.html sibling, is never listed", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-bayangan-test-"));
    writeFixtureTree(dir);
    const clientDir = new URL(`file://${dir}/`);

    const shadowed = discoverShadowedHtmlPaths(clientDir);
    expect(shadowed.has("/rubrik")).toBe(false);
    expect(shadowed.has("/_astro")).toBe(false);
    expect(shadowed.has("/index")).toBe(false);
    expect(shadowed.has("/kontak")).toBe(false);
  });

  test("degrades to an empty set when the directory is missing — a fresh checkout with no dist/ yet", () => {
    dir = mkdtempSync(join(tmpdir(), "penyaji-bayangan-test-"));
    const clientDir = new URL(`file://${join(dir, "tidak-ada")}/`);
    expect(discoverShadowedHtmlPaths(clientDir).size).toBe(0);
  });
});

describe("server/penyaji: shadowedHtmlUrl", () => {
  const shadowed = new Set(["/berita", "/video", "/rubrik/peristiwa"]);

  test("rewrites a shadowed path to its .html file, keeping the query string", () => {
    expect(shadowedHtmlUrl("/berita", shadowed)).toBe("/berita.html");
    expect(shadowedHtmlUrl("/video", shadowed)).toBe("/video.html");
    expect(shadowedHtmlUrl("/rubrik/peristiwa", shadowed)).toBe("/rubrik/peristiwa.html");
    expect(shadowedHtmlUrl("/berita?utm_source=fb", shadowed)).toBe("/berita.html?utm_source=fb");
  });

  test("leaves the trailing-slash form alone — the adapter 301s /berita/ to /berita itself", () => {
    expect(shadowedHtmlUrl("/berita/", shadowed)).toBeNull();
    expect(shadowedHtmlUrl("/video/?x=1", shadowed)).toBeNull();
  });

  test("leaves every other path alone: children, plain pages, assets, the .html spelling itself", () => {
    expect(shadowedHtmlUrl("/berita/satu", shadowed)).toBeNull();
    expect(shadowedHtmlUrl("/kontak", shadowed)).toBeNull();
    expect(shadowedHtmlUrl("/_astro/a.css", shadowed)).toBeNull();
    expect(shadowedHtmlUrl("/berita.html", shadowed)).toBeNull();
    expect(shadowedHtmlUrl("/", shadowed)).toBeNull();
  });

  test("compares on the normalized path, and emits the normalized spelling", () => {
    // `//berita` and `/x/../berita` are the same directory to the adapter's
    // lstat; the rewrite must agree, and hand it one canonical spelling.
    expect(shadowedHtmlUrl("//berita", shadowed)).toBe("/berita.html");
    expect(shadowedHtmlUrl("/x/../berita", shadowed)).toBe("/berita.html");
    expect(shadowedHtmlUrl("/berita#bagian", shadowed)).toBe("/berita.html");
  });

  test("returns null against an empty set", () => {
    expect(shadowedHtmlUrl("/berita", new Set())).toBeNull();
  });
});

describe("server/penyaji: the shadowed-page rewrite inside createServer", () => {
  function withServer(
    context: Record<string, unknown>,
    run: (baseUrl: string) => Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // The stub app handler echoes the url it was handed — the whole point
      // is what the ADAPTER would see, not what the client sent.
      const server = createServer((req, res) => {
        res.statusCode = 200;
        res.end(`app handler saw ${req.url}`);
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

  const shadowedHtmlPaths = new Set(["/berita", "/video"]);

  test("a shadowed path reaches the app handler as its .html file, with a 200 and no redirect", async () => {
    await withServer({ shadowedHtmlPaths }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/berita?halaman=2`, { redirect: "manual" });
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).toBe("app handler saw /berita.html?halaman=2");
    });
  });

  test("the trailing-slash form is passed through untouched for the adapter's own 301", async () => {
    await withServer({ shadowedHtmlPaths }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/berita/`);
      expect(await response.text()).toBe("app handler saw /berita/");
    });
  });

  test("a child page and a plain page are passed through untouched", async () => {
    await withServer({ shadowedHtmlPaths }, async (baseUrl) => {
      expect(await (await fetch(`${baseUrl}/berita/satu`)).text()).toBe("app handler saw /berita/satu");
      expect(await (await fetch(`${baseUrl}/kontak`)).text()).toBe("app handler saw /kontak");
    });
  });

  test("the /products redirect and a legacy redirect still answer BEFORE the rewrite", async () => {
    await withServer(
      {
        shadowedHtmlPaths: new Set(["/berita", "/video", "/products", "/news/lama"]),
        legacyRedirects: { "/news/lama": "/berita/baru" }
      },
      async (baseUrl) => {
        const products = await fetch(`${baseUrl}/products`, { redirect: "manual" });
        expect(products.status).toBe(301);
        expect(products.headers.get("location")).toBe("/");

        const legacy = await fetch(`${baseUrl}/news/lama`, { redirect: "manual" });
        expect(legacy.status).toBe(301);
        expect(legacy.headers.get("location")).toBe("/berita/baru");
      }
    );
  });

  test("no shadowedHtmlPaths in context behaves exactly as before this issue", async () => {
    await withServer({}, async (baseUrl) => {
      expect(await (await fetch(`${baseUrl}/berita`)).text()).toBe("app handler saw /berita");
    });
  });
});
