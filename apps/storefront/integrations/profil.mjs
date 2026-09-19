/**
 * The build-profile integration (issue #137, ADR-0018 D3).
 *
 * `src/pages/**` holds only the `shared` page group — the routes every
 * profile serves. Every other page lives under `src/profil/<group>/pages/**`
 * (`<group>` is `toko` or `berita`) with the SAME relative layout it had
 * under `src/pages/` before this issue, and this integration turns each
 * such file into a route — but only when its group is part of the active
 * profile, which it reads from `src/config/profil.ts` (the one module every
 * profile-aware consumer reads; nothing here hardcodes a group a second
 * time).
 *
 * ## How
 *
 * `astro:config:setup` runs once per `astro build`/`astro dev`, before
 * Astro scans `src/pages/` — the earliest hook that offers `injectRoute`.
 * For every file under an active group's `pages/` directory this calls
 * `injectRoute({ pattern, entrypoint })`, where:
 *
 * - `pattern` is the route Astro's own file-based routing would have
 *   derived from the same relative path under `src/pages/` — `index.astro`
 *   folds into its directory (`berita/index.astro` → `/berita`), a page's
 *   extension is dropped (`produk.astro` → `/produk`), an endpoint keeps
 *   its document extension and drops only the module one
 *   (`feed.xml.ts` → `/feed.xml`, `index/wilayah-provinsi.json.ts` →
 *   `/index/wilayah-provinsi.json`), and `[param]` segments pass through
 *   unchanged for Astro to parse.
 * - `entrypoint` is the file's path RELATIVE TO THE PROJECT ROOT
 *   (`./src/profil/toko/pages/produk.astro`) — the form Astro's integration
 *   API documents. Astro resolves it against `config.root`, so it does not
 *   depend on the working directory `astro` was launched from.
 *
 * Files whose name starts with `_` are skipped, as Astro skips them under
 * `src/pages/`; so is any extension Astro would not treat as a page or an
 * endpoint.
 *
 * A group that is NOT active is never walked: its pages are not routes, its
 * `getStaticPaths()`/frontmatter never run, its data is never fetched, and
 * nothing of it reaches `dist/` — which is what makes the excluded-route
 * assertions in `tests/profil-build-smoke.test.ts` true by construction
 * rather than by a runtime guard (ADR-0018 D3's rejected alternative).
 *
 * ## The home page variant
 *
 * `src/pages/index.astro` is shared (every profile has a `/`), but its
 * CONTENT is per profile. It imports `@profil/beranda`, and this
 * integration points that alias (a Vite `resolve.alias` entry) at
 * `src/profil/<profile>/Beranda.astro` for the active profile — so only
 * ONE variant is ever in the module graph. That matters beyond tidiness:
 * Astro collects a page's stylesheets from everything the page imports,
 * statically OR dynamically, so a home page that imported all three
 * variants and picked one at render time would still link every
 * variant's CSS on every profile. With the alias, `toko`'s home page is
 * built from exactly the modules it was built from before this issue.
 *
 * ## What this file must NOT become
 *
 * It has no runtime component and injects no middleware, no script and
 * no page of its own. It never sets `prerender` on an injected route: the
 * project is `output: "static"` and every route inherits that default —
 * `tests/checkout-guard-no-prerender.test.ts` walks `src/profil/**` as
 * well as `src/pages/**` to keep it so.
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { SITE_PROFILE, ACTIVE_GROUPS } from "../src/config/profil";

/** Where a group's page files live, relative to the project root. */
export const PROFIL_ROOT = "src/profil";

/** The import specifier `src/pages/index.astro` uses for its per-profile body. */
export const BERANDA_ALIAS = "@profil/beranda";

const PAGE_EXTENSIONS = new Set([".astro", ".md", ".mdx", ".markdown", ".mdown", ".mkdn", ".mkd", ".mdwn"]);
const ENDPOINT_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs"]);

/**
 * The route pattern for a page file at `relativePath` (POSIX separators,
 * relative to its group's `pages/` directory) — pure, exported for
 * `tests/profil-integrasi.test.ts`. Returns `null` for a file Astro would
 * not route (an `_`-prefixed name, an unknown extension).
 */
export function routePatternFor(relativePath) {
  const segments = relativePath.split("/");
  const basename = segments[segments.length - 1];
  if (segments.some((segment) => segment.startsWith("_"))) return null;

  const dot = basename.lastIndexOf(".");
  if (dot === -1) return null;
  const extension = basename.slice(dot);
  const stem = basename.slice(0, dot);

  let leaf;
  if (PAGE_EXTENSIONS.has(extension)) {
    // A page: drop the extension; `index` folds into its directory.
    leaf = stem === "index" ? null : stem;
  } else if (ENDPOINT_EXTENSIONS.has(extension)) {
    // An endpoint: drop only the module extension, keep the document
    // one (`feed.xml.ts` → `feed.xml`, `berita.json.ts` → `berita.json`).
    // A bare `index.ts` endpoint would also fold, matching Astro.
    leaf = stem === "index" ? null : stem;
  } else {
    return null;
  }

  const parts = segments.slice(0, -1);
  if (leaf !== null) parts.push(leaf);
  return "/" + parts.join("/");
}

/** Every routable file under `dir`, as POSIX paths relative to `dir`, sorted for a deterministic build log. */
export function listPageFiles(dir) {
  const result = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        result.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir);
  return result.sort();
}

/**
 * The `{ pattern, entrypoint }` pairs for `groups` under `root` — pure
 * over the file system, exported for the unit test. `entrypoint` is
 * project-root-relative with a leading `./`, exactly what is handed to
 * `injectRoute`.
 */
export function collectInjectedRoutes(root, groups) {
  const routes = [];
  for (const group of groups) {
    if (group === "shared") continue; // `src/pages/**` — Astro's own file-based routing
    const pagesDir = join(root, PROFIL_ROOT, group, "pages");
    for (const file of listPageFiles(pagesDir)) {
      const pattern = routePatternFor(file);
      if (pattern === null) continue;
      routes.push({
        group,
        pattern,
        entrypoint: `./${PROFIL_ROOT}/${group}/pages/${file}`
      });
    }
  }
  return routes;
}

/** The per-profile home variant's path, project-root-relative. */
export function berandaVariantPath(profile) {
  return `${PROFIL_ROOT}/${profile}/Beranda.astro`;
}

/**
 * @returns {import("astro").AstroIntegration}
 */
export default function profil() {
  return {
    name: "awcms-one:profil",
    hooks: {
      "astro:config:setup": ({ config, injectRoute, updateConfig, logger }) => {
        const root = fileURLToPath(config.root);

        const routes = collectInjectedRoutes(root, ACTIVE_GROUPS);
        for (const route of routes) {
          injectRoute({ pattern: route.pattern, entrypoint: route.entrypoint });
        }

        const beranda = join(root, berandaVariantPath(SITE_PROFILE));
        if (!existsSync(beranda)) {
          throw new Error(
            `[awcms-one:profil] SITE_PROFILE="${SITE_PROFILE}" has no home page variant at ${berandaVariantPath(SITE_PROFILE)}.`
          );
        }
        updateConfig({
          vite: {
            resolve: {
              alias: { [BERANDA_ALIAS]: beranda }
            }
          }
        });

        const perGroup = ACTIVE_GROUPS.filter((g) => g !== "shared")
          .map((g) => `${g}=${routes.filter((r) => r.group === g).length}`)
          .join(", ");
        logger.info(
          `SITE_PROFILE=${SITE_PROFILE} — groups [${ACTIVE_GROUPS.join(", ")}], ` +
            `${routes.length} route(s) injected (${perGroup || "none"}), home = ${berandaVariantPath(SITE_PROFILE)}`
        );
      }
    }
  };
}
