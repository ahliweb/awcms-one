/**
 * Shared plumbing for the build-profile tests (issue #137):
 * `profil-routes.test.ts` (the active profile's built pages link only to
 * routes that profile has) and `profil-build-smoke.test.ts` (every profile
 * builds against the stub CMS and its `dist/`, `sitemap-*.xml`,
 * `robots.txt`, feeds and CSP artifact match `src/config/profil.ts`).
 *
 * Not a test file itself (no `.test.` in the name, so `bun test` never
 * collects it) — the same "one helper, many smoke tests" shape
 * `stub-deadline.ts` already has. Everything here is derived from
 * `src/config/profil.ts`/`src/config/routes.ts`, never from a second,
 * hand-typed list of which route belongs where: the tests must fail when
 * the config and the build disagree, not when the config and a test
 * fixture do.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { STUB_START_DEADLINE_MS } from "./stub-deadline";
import {
  excludedRouteKeys,
  activeRouteKeys,
  routePathPrefix,
  type SiteProfile
} from "../src/config/profil";
import { ROUTES, type RouteKey } from "../src/config/routes";

/**
 * One representative built file per group — a page and an endpoint each, so
 * a group's presence/absence is checked on both kinds. Shared between
 * `profil-build-smoke.test.ts` and `scripts/assert-profil-dist.ts` (issue
 * #147's deterministic post-build check over an ALREADY-BUILT `dist/`) so
 * the two never drift into checking a different notion of "this group's
 * files".
 */
export const GROUP_FILES = {
  shared: ["index.html", "kontak.html", "404.html", "robots.txt", "sitemap-index.xml", "csp.json", "manifest.webmanifest", "theme-tokens.css"],
  toko: ["produk.html", "keranjang.html", "checkout.html", "cari.html", "masuk.html", "akun.html", "feed.xml", "product-labels.css", "index/produk.json", "index/wilayah-provinsi.json"],
  berita: ["berita.html", "cari-berita.html", "buletin.html", "video.html", "berita/feed.xml", "index/berita.json", "index/pengalihan-legacy.json", "newsletter/confirm.html"]
} as const;

/** Site-relative paths each group's sitemap sources put in the sitemap (static ones only — the fixtures decide the dynamic ones). */
export const GROUP_SITEMAP_PATHS = {
  shared: [ROUTES.home, ROUTES.contact],
  toko: [ROUTES.products, ROUTES.flashSale],
  berita: [ROUTES.news, ROUTES.video, ROUTES.newsSearch]
} as const;

export const STOREFRONT_ROOT = new URL("../", import.meta.url).pathname;
export const DIST_CLIENT = join(STOREFRONT_ROOT, "dist", "client");

/** Generous: a two-core CI runner building the hybrid site under `bun test`'s own load. */
export const BUILD_TIMEOUT_MS = 90_000;

export function canSpawnBun(): boolean {
  try {
    return Bun.spawnSync(["bun", "--version"]).exitCode === 0;
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

/**
 * Starts the stub CMS on a random port, runs `astro build` for `profile`
 * into `dist/`, stops the stub. Throws (with the build's own output) on a
 * non-zero exit — never a silent pass.
 */
export async function buildProfile(profile: SiteProfile): Promise<void> {
  const stubPort = 41000 + Math.floor(Math.random() * 4000);
  rmSync(join(STOREFRONT_ROOT, "dist"), { recursive: true, force: true });

  const stub = Bun.spawn(["bun", "scripts/stub-awcms.mjs"], {
    cwd: STOREFRONT_ROOT,
    env: { ...process.env, STUB_PORT: String(stubPort) },
    stdout: "pipe",
    stderr: "pipe"
  });

  try {
    await waitForStub(`http://localhost:${stubPort}/api/v1/commerce/products`, Date.now() + STUB_START_DEADLINE_MS);

    const build = Bun.spawnSync(["bun", "--bun", "astro", "build"], {
      cwd: STOREFRONT_ROOT,
      env: {
        ...process.env,
        AWCMS_API_URL: `http://localhost:${stubPort}`,
        AWCMS_API_TOKEN: "stub-token",
        SITE_URL: "http://localhost:4321",
        PUBLIC_AWCMS_ORIGIN: "https://cms.example.com",
        SITE_PROFILE: profile
      },
      stdout: "pipe",
      stderr: "pipe"
    });

    if (build.exitCode !== 0) {
      throw new Error(
        `astro build (SITE_PROFILE=${profile}) exited ${build.exitCode}\n--- stdout ---\n${build.stdout.toString()}\n--- stderr ---\n${build.stderr.toString()}`
      );
    }
  } finally {
    stub.kill();
    await stub.exited;
  }
}

/** Every file under `dir`, as POSIX paths relative to it. */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else result.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return result.sort();
}

/** Every built `.html` file, relative to `dist/client/`, excluding Astro's own assets. */
export function listBuiltHtml(): string[] {
  return listFiles(DIST_CLIENT).filter((file) => file.endsWith(".html") && !file.startsWith("_astro/"));
}

/**
 * Every site-relative URL a built page points at — `href`, `src`, `action`
 * and `data-*-url`-style attributes — with query string and fragment
 * stripped. Only same-origin, leading-slash values: `mailto:`, `tel:`,
 * `https://…`, `#anchor` are not routes of this site.
 */
export function collectInternalLinks(html: string): string[] {
  const links = new Set<string>();
  for (const match of html.matchAll(/\s(?:href|src|action|data-[a-z-]*url)=["']([^"']+)["']/gi)) {
    const raw = match[1] ?? "";
    if (!raw.startsWith("/") || raw.startsWith("//")) continue;
    const path = raw.split(/[?#]/)[0] ?? "";
    if (path) links.add(path);
  }
  return [...links].sort();
}

/** Does `path` fall under the route `key` (its static prefix, segment-aware)? */
export function pathBelongsToRoute(path: string, key: RouteKey): boolean {
  const prefix = routePathPrefix(key).split(/[?#]/)[0] ?? "";
  if (prefix === "/") return path === "/";
  if (prefix.endsWith("/")) return path.startsWith(prefix) || path === prefix.slice(0, -1);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The route keys of `profile`'s EXCLUDED groups that `path` would belong to — empty means the link is fine. */
export function excludedRoutesHit(path: string, profile: SiteProfile): RouteKey[] {
  // A path that belongs to an ACTIVE route is fine even if an excluded
  // route shares a prefix with it (`/berita/feed.xml` under `article` vs.
  // the `toko`-only root `/feed.xml`; `/cari-berita` vs. `/cari` is already
  // segment-safe, but the rule is stated once here for every such pair).
  if (activeRouteKeys(profile).some((key) => pathBelongsToRoute(path, key))) return [];
  return excludedRouteKeys(profile).filter((key) => pathBelongsToRoute(path, key));
}

/** Whether `dist/client/` serves `path` under `build.format: "file"` + `trailingSlash: "never"`. */
export function distServes(path: string): boolean {
  if (path === "/") return existsSync(join(DIST_CLIENT, "index.html"));
  const relativePath = path.slice(1);
  return (
    existsSync(join(DIST_CLIENT, relativePath)) ||
    existsSync(join(DIST_CLIENT, `${relativePath}.html`)) ||
    existsSync(join(DIST_CLIENT, relativePath, "index.html"))
  );
}

/** `<loc>` values of every `sitemap-<n>.xml` in `dist/client/`, as site-relative paths. */
export function readSitemapPaths(): string[] {
  const paths: string[] = [];
  for (const file of listFiles(DIST_CLIENT)) {
    if (!/^sitemap-\d+\.xml$/.test(file)) continue;
    const xml = readFileSync(join(DIST_CLIENT, file), "utf8");
    for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      paths.push(new URL(match[1] ?? "").pathname);
    }
  }
  return paths.sort();
}

export function readDistText(relativePath: string): string {
  return readFileSync(join(DIST_CLIENT, relativePath), "utf8");
}
