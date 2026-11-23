/**
 * storefront-consumer-contract.mjs — the frozen consumer-contract slice for
 * the storefront's reads (issue #555, ADR-0058 D2).
 *
 * Side-effect free: importing this runs and prints nothing. The CLI is
 * `tools/storefront-consumer-contract.mjs`; the gate is
 * `tests/storefront-consumer-contract.test.mjs` (root `bun test`, so it runs
 * inside `local-ci/check-toko` with no database and no network).
 *
 * ## What it freezes
 *
 * Every operation `apps/storefront` calls while `astro build` runs, per build
 * profile, as the consumed operation objects plus every component they reach
 * (the transitive `$ref` closure, because the interesting breakages happen in
 * the schema, not in the path object). The rule is the one
 * `apps/cms/scripts/api-consumer-contract.ts` applies to `awcms-astro`: the
 * provider may ADD, never remove or narrow what the consumer relies on.
 * `apps/cms` is read-only for this repository (ADR-0024, ADR-0058 D2), so the
 * helpers are re-implemented here, not imported from it.
 *
 * Two small, deliberate differences from that script, both because this
 * slice is checked on every subtree sync rather than once per release:
 *
 *  - It freezes only the METHODS the consumer calls (`GET`), not the whole
 *    path item, so a provider adding a `POST` is not a contract event.
 *  - It drops prose keys (`description`, `summary`, `title`, `example(s)`,
 *    `tags`, `externalDocs`) before comparing, so rewording documentation is
 *    not mistaken for a contract change. Types, enums, `required`, nullability
 *    and declared parameters are all still compared.
 *
 * ## Extending to browser calls (issue #556)
 *
 * Each frozen operation carries `phase: "build"`. #556 adds `phase: "browser"`
 * entries (and per-operation negative cases) to the SAME `OPERATIONS` list and
 * the same fixture; nothing in the checker assumes every entry is a build read
 * except `scanBuildReadSources`, which is the build-phase source guard and
 * stays as it is. A browser-phase scan is a second, sibling function.
 *
 * ## What it does not see (stated so it is not mistaken for guarded)
 *
 *  - The per-profile mapping is hand-reviewed (see `PROFILE_NOTE`); the source
 *    guard proves the SET of operations and readers, not which page group
 *    reaches which one.
 *  - A read whose path is assembled from a value imported from another module,
 *    or a raw `fetch()` against a computed URL outside `src/lib/awcms/`, is
 *    not detected. The guard is a tripwire for the shapes this codebase uses
 *    today, not a parser.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUNDLE_PATH = "apps/cms/openapi/awcms-public-api.openapi.yaml";
export const FIXTURE_PATH = "tests/fixtures/storefront-consumer-contract.json";

export const PROFILES = ["toko", "berita", "landing"];

/** Profile sets an operation may carry. A new set is a deliberate edit here. */
const ALL = ["toko", "berita", "landing"];
const TOKO_BERITA = ["toko", "berita"];
const TOKO = ["toko"];

/**
 * Why a profile set looks the way it does (`apps/storefront/src/config/profil.ts`
 * `PROFILE_GROUPS`): `toko` builds shared + toko + berita, `berita` builds
 * shared + berita, `landing` builds shared only. So an operation reached only
 * from the `berita` group belongs to `toko` and `berita`; one reached only from
 * the `toko` group belongs to `toko`; one reached from a shared page or layout
 * belongs to all three.
 */
export const PROFILE_NOTE =
  "shared group -> all profiles; berita group -> toko+berita; toko group -> toko";

const LIB = "apps/storefront/src/lib";

/**
 * The build-time reads. `readers` are the files under `apps/storefront/src`
 * that issue the call (the source guard compares this to what it finds).
 * `queryParams` are the query parameters the consumer sends; each must stay a
 * declared parameter of the operation in the bundle.
 */
export const OPERATIONS = [
  op("/api/v1/site-profile/composed", ALL, [], [`${LIB}/awcms/profil.ts`]),
  op("/api/v1/blog/pages/public", ALL, [], [`${LIB}/awcms/pages.ts`]),
  op("/api/v1/blog/pages/public/{slug}", ALL, [], [`${LIB}/awcms/pages.ts`]),
  op("/api/v1/commerce/store-settings/public", ALL, [], [`${LIB}/awcms/pemasaran.ts`]),
  op("/api/v1/media/public-origin", ALL, [], [`${LIB}/awcms/media.ts`]),

  op(
    "/api/v1/blog/posts",
    TOKO_BERITA,
    ["cursor", "limit", "order", "status", "view"],
    [`${LIB}/awcms/blog.ts`]
  ),
  op(
    "/api/v1/blog/terms",
    TOKO_BERITA,
    ["cursor", "limit", "order"],
    [`${LIB}/awcms/blog.ts`]
  ),
  op("/api/v1/blog/institutions", TOKO_BERITA, [], [`${LIB}/awcms/blog.ts`]),
  op("/api/v1/news-portal/ad-placements/active", TOKO_BERITA, [], [`${LIB}/awcms/blog.ts`]),
  op("/api/v1/seo/redirects", TOKO_BERITA, ["cursor", "state"], [`${LIB}/awcms/blog.ts`]),
  op("/api/v1/analytics/pages", TOKO_BERITA, ["range"], [`${LIB}/awcms/analitik.ts`]),
  op("/api/v1/media/objects", TOKO_BERITA, ["ids"], [`${LIB}/awcms/media.ts`]),
  op(
    "/api/v1/idn-regions/regions",
    TOKO_BERITA,
    ["after", "level", "limit", "parentCode"],
    [`${LIB}/awcms/wilayah.ts`, `${LIB}/awcms/wilayah-checkout.ts`]
  ),

  op("/api/v1/commerce/products", TOKO, ["cursor"], [`${LIB}/catalog.ts`]),
  op("/api/v1/commerce/categories", TOKO, ["cursor"], [`${LIB}/catalog.ts`]),
  op("/api/v1/commerce/sliders/active", TOKO, [], [`${LIB}/awcms/pemasaran.ts`]),
  op("/api/v1/commerce/flash-sales/active", TOKO, [], [`${LIB}/awcms/pemasaran.ts`]),
  op("/api/v1/commerce/vouchers/public", TOKO, [], [`${LIB}/awcms/pemasaran.ts`]),
  op("/api/v1/commerce/testimonials/active", TOKO, [], [`${LIB}/awcms/pemasaran.ts`]),
  op("/api/v1/commerce/popups/active", TOKO, [], [`${LIB}/awcms/pemasaran.ts`])
];

/**
 * Build-time reads that are NOT in the OpenAPI bundle (audit F-07). They are
 * named, not given an invented schema: the route answers raw CSS, not the
 * `{ success, data }` envelope, and the bundle does not describe it.
 */
export const OUT_OF_BUNDLE = [
  {
    phase: "build",
    method: "GET",
    path: "/theming/{tenantCode}/tokens.css",
    profiles: ALL,
    readers: [`${LIB}/awcms/theme.ts`],
    reason:
      "The route returns raw text/css and lives outside /api, so it is not in the OpenAPI bundle and api:spec:check does not cover it (audit F-07, reported upstream).",
    alternativeCheck:
      "Existence only: the route file apps/cms/src/pages/theming/[tenantCode]/tokens.css.ts must exist (checked by the gate). Its CSS is parsed leniently by extractThemeToken with a default-palette fallback, so a body change degrades colours rather than failing the build. No schema is claimed."
  }
];

/** The provider-side file whose existence is the alternative check above. */
export const THEMING_ROUTE_FILE = "apps/cms/src/pages/theming/[tenantCode]/tokens.css.ts";

function op(path, profiles, queryParams, readers) {
  return { phase: "build", method: "GET", path, profiles, queryParams, readers };
}

/** `${path}` keys of one operation, for sorting and lookups. */
export function opKey(entry) {
  return `${entry.method} ${entry.path}`;
}

// ---------------------------------------------------------------------------
// Slice construction and the additive-superset rule
// ---------------------------------------------------------------------------

const PROSE_KEYS = new Set(["description", "summary", "title", "example", "examples", "externalDocs", "tags"]);

/**
 * Remove documentation-only keys. A `properties` map is keyed by FIELD names,
 * so a field called `description` there is data, not prose, and is kept.
 */
export function stripProse(value, parentKey = "") {
  if (Array.isArray(value)) return value.map((item) => stripProse(item, parentKey));
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (parentKey !== "properties" && PROSE_KEYS.has(key)) continue;
    out[key] = stripProse(child, key);
  }
  return out;
}

/** Every `#/components/<group>/<name>` reachable from `value`, transitively. */
export function collectRefs(value, components, seen = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, components, seen);
    return seen;
  }
  if (!value || typeof value !== "object") return seen;

  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      const match = /^#\/components\/([^/]+)\/(.+)$/.exec(child);
      if (match && !seen.has(child)) {
        seen.add(child);
        collectRefs(components?.[match[1]]?.[match[2]], components, seen);
      }
      continue;
    }
    collectRefs(child, components, seen);
  }
  return seen;
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The frozen slice (`paths` and `components`) of `bundle` for `operations`. */
export function buildSlice(bundle, operations = OPERATIONS) {
  const bundlePaths = bundle.paths ?? {};
  const bundleComponents = bundle.components ?? {};
  const paths = {};
  const refs = new Set();

  for (const entry of operations) {
    const pathItem = bundlePaths[entry.path];
    const method = entry.method.toLowerCase();

    if (pathItem === undefined || pathItem[method] === undefined) {
      throw new Error(
        `Consumed operation ${opKey(entry)} is not in ${BUNDLE_PATH}. Either the provider removed ` +
          "it, which breaks the storefront build, or OPERATIONS is stale."
      );
    }

    const frozenItem = (paths[entry.path] ??= {});
    // A path-level `parameters` list applies to every method; keep it.
    if (pathItem.parameters !== undefined) frozenItem.parameters = pathItem.parameters;
    frozenItem[method] = pathItem[method];
    collectRefs(frozenItem, bundleComponents, refs);
  }

  const components = {};
  for (const ref of [...refs].sort()) {
    const match = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
    const group = (components[match[1]] ??= {});
    group[match[2]] = bundleComponents[match[1]][match[2]];
  }

  return stripProse({
    paths: sortedObject(Object.entries(paths)),
    components: sortedObject(
      Object.entries(components).map(([group, entries]) => [group, sortedObject(Object.entries(entries))])
    )
  });
}

/** Is `frozen` fully contained in `current`? Added keys pass; a removal or retype does not. */
export function isAdditiveSuperset(frozen, current) {
  if (Array.isArray(frozen)) {
    if (!Array.isArray(current)) return false;
    // Arrays (enum, required, parameters) compare as sets: an added member is additive.
    return frozen.every((item) => current.some((candidate) => isAdditiveSuperset(item, candidate)));
  }
  if (frozen && typeof frozen === "object") {
    if (!current || typeof current !== "object" || Array.isArray(current)) return false;
    return Object.entries(frozen).every(([key, value]) => isAdditiveSuperset(value, current[key]));
  }
  return frozen === current;
}

/** Every frozen path/component the current bundle no longer satisfies. */
export function findContractBreaks(frozen, currentSlice) {
  const breaks = [];

  for (const [pathKey, pathItem] of Object.entries(frozen.paths ?? {})) {
    const now = currentSlice.paths?.[pathKey];
    if (now === undefined) {
      breaks.push(`path ${pathKey} is gone from the bundle`);
      continue;
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (now[method] === undefined) {
        breaks.push(`${method.toUpperCase()} ${pathKey} is gone from the bundle`);
      } else if (!isAdditiveSuperset(operation, now[method])) {
        breaks.push(`${method.toUpperCase()} ${pathKey} changed non-additively`);
      }
    }
    if (pathItem.parameters !== undefined && !isAdditiveSuperset(pathItem.parameters, now.parameters)) {
      breaks.push(`path ${pathKey} parameters changed non-additively`);
    }
  }

  for (const [group, entries] of Object.entries(frozen.components ?? {})) {
    for (const [name, schema] of Object.entries(entries)) {
      const now = currentSlice.components?.[group]?.[name];
      if (now === undefined) {
        breaks.push(`components.${group}.${name} is gone from the bundle`);
      } else if (!isAdditiveSuperset(schema, now)) {
        breaks.push(`components.${group}.${name} changed non-additively`);
      }
    }
  }

  return breaks;
}

/**
 * Query parameters the consumer sends that the bundle no longer declares
 * (looked up through `$ref` to `components.parameters`).
 */
export function findUndeclaredQueryParams(bundle, operations = OPERATIONS) {
  const problems = [];

  for (const entry of operations) {
    const pathItem = bundle.paths?.[entry.path];
    const operation = pathItem?.[entry.method.toLowerCase()];
    if (!operation) continue; // reported by buildSlice / findContractBreaks

    const declared = new Set();
    for (const parameter of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
      const resolved = parameter?.$ref
        ? bundle.components?.parameters?.[/^#\/components\/parameters\/(.+)$/.exec(parameter.$ref)?.[1]]
        : parameter;
      if (resolved?.in === "query" && typeof resolved.name === "string") declared.add(resolved.name);
    }

    for (const name of entry.queryParams) {
      if (!declared.has(name)) problems.push(`${opKey(entry)} no longer declares query parameter "${name}"`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

export const FIXTURE_NOTICE =
  "FROZEN: the storefront's build-time reads (issue #555, ADR-0058). Generated by `bun run contract:storefront:generate`; do NOT hand-edit. Regenerating is a DELIBERATE act that means the contract changed and the storefront must change with it; say why in the PR. Additive provider changes need no regeneration: the check is a subset assertion.";

/** The complete fixture object for `bundle`. */
export function buildFixture(bundle) {
  const operations = [...OPERATIONS].sort((a, b) => (opKey(a) < opKey(b) ? -1 : 1));
  return {
    _frozen: FIXTURE_NOTICE,
    schemaVersion: 1,
    consumer: "apps/storefront",
    bundle: BUNDLE_PATH,
    profileNote: PROFILE_NOTE,
    operations,
    outOfBundle: OUT_OF_BUNDLE,
    ...buildSlice(bundle, operations)
  };
}

export function serializeFixture(fixture) {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** Operations a profile builds. */
export function operationsForProfile(fixtureOrOps, profile) {
  const list = Array.isArray(fixtureOrOps) ? fixtureOrOps : fixtureOrOps.operations;
  return list.filter((entry) => entry.profiles.includes(profile));
}

// ---------------------------------------------------------------------------
// The source guard (build phase)
// ---------------------------------------------------------------------------

const SRC = "apps/storefront/src";
/** Browser-only code: a request there is a browser call (issue #556), not a build read. */
const BROWSER_DIRS = [`${SRC}/scripts`];
/** Where a build read must not appear except through a registered reader. */
const RENDER_DIRS = ["pages", "profil", "layouts", "components", "install", "push"].map((dir) => `${SRC}/${dir}`);

function walk(root, dir, out = []) {
  let names;
  try {
    names = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) walk(root, rel, out);
    else if (/\.(ts|mjs|js|astro)$/.test(name)) out.push(rel);
  }
  return out;
}

/** Comments removed, so a path named in a docblock is not mistaken for a read. */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(\s)\/\/\s.*$/gm, "$1");
}

/** `/api/v1/...` and `/theming/...` string/template literals, `${...}` normalised to `{param}`. */
export function extractPathLiterals(code) {
  const found = new Set();
  // The leading `}` covers `${origin}/theming/...`, the one shape that has no opening quote.
  for (const match of code.matchAll(/(?:["'`]|\})(\/(?:api\/v1|theming)\/[^"'`\s?]*)["'`?]/g)) {
    found.add(match[1].replace(/\$\{[^}]*\}/g, "{param}"));
  }
  return found;
}

/** Map a normalised literal onto a frozen path template (`{param}` matches any `{name}`). */
function samePath(literal, template) {
  const normalise = (value) => value.replace(/\{[^}]*\}/g, "{param}");
  return normalise(literal) === normalise(template);
}

/**
 * Scan the storefront source for build-time reads.
 *
 * Returns `{ readerFiles, literalsByFile, renderStrays, fetchInAwcmsLib }`:
 *  - `readerFiles`: files outside the browser dirs that call `awcmsGet` (other
 *    than the client itself) or contain a `/theming/` literal;
 *  - `literalsByFile`: the path literals in each of those files;
 *  - `renderStrays`: awcms path literals in a render directory (pages, layouts,
 *    components, ...), where there must be none;
 *  - `fetchInAwcmsLib`: files under `src/lib/awcms/` that call `fetch(`.
 */
export function scanBuildReadSources(root) {
  const files = walk(root, SRC).filter((rel) => !BROWSER_DIRS.some((dir) => rel.startsWith(`${dir}/`)));
  const readerFiles = [];
  const literalsByFile = {};
  const renderStrays = [];
  const fetchInAwcmsLib = [];

  for (const rel of files) {
    if (rel === `${SRC}/lib/awcms/client.ts`) continue;

    const code = stripComments(readFileSync(join(root, rel), "utf8"));
    const literals = extractPathLiterals(code);
    const callsAwcms = /\bawcmsGet\s*[<(]/.test(code);
    const readsTheming = [...literals].some((literal) => literal.startsWith("/theming/"));

    if (rel.startsWith(`${SRC}/lib/awcms/`) && /\bfetch\s*\(/.test(code)) fetchInAwcmsLib.push(rel);

    if (callsAwcms || readsTheming) {
      readerFiles.push(rel);
      literalsByFile[rel] = [...literals].sort();
    } else if (literals.size > 0 && RENDER_DIRS.some((dir) => rel.startsWith(`${dir}/`))) {
      renderStrays.push({ file: rel, literals: [...literals].sort() });
    }
  }

  return { readerFiles, literalsByFile, renderStrays, fetchInAwcmsLib };
}

/**
 * Compare a scan with the frozen operations. Returns human-readable problems;
 * empty means the source and the slice agree.
 */
export function compareScanToSlice(scan, operations = OPERATIONS, outOfBundle = OUT_OF_BUNDLE) {
  const problems = [];
  const all = [...operations, ...outOfBundle];
  const registeredReaders = new Set(all.flatMap((entry) => entry.readers));

  for (const file of scan.readerFiles) {
    if (!registeredReaders.has(file)) {
      problems.push(
        `${file} reads awcms at build time but is not a reader of any frozen operation. ` +
          "Add its operation(s) to OPERATIONS in tools/lib/storefront-consumer-contract.mjs and regenerate."
      );
    }
  }

  for (const file of registeredReaders) {
    if (!scan.readerFiles.includes(file)) {
      problems.push(`${file} is registered as a reader but no longer reads awcms at build time (stale entry).`);
    }
  }

  for (const [file, literals] of Object.entries(scan.literalsByFile)) {
    for (const literal of literals) {
      const registered = all.some(
        (entry) => entry.readers.includes(file) && samePath(literal, entry.path)
      );
      if (!registered) {
        problems.push(
          `${file} reads ${literal} at build time, which is not frozen for that file. ` +
            "Freeze it (OPERATIONS, then regenerate) with a reason in the PR."
        );
      }
    }
  }

  for (const entry of all) {
    for (const file of entry.readers) {
      const literals = scan.literalsByFile[file] ?? [];
      if (scan.readerFiles.includes(file) && !literals.some((literal) => samePath(literal, entry.path))) {
        problems.push(`${opKey(entry)} is frozen but ${file} no longer names that path (stale entry).`);
      }
    }
  }

  for (const stray of scan.renderStrays) {
    problems.push(
      `${stray.file} names an awcms path (${stray.literals.join(", ")}) outside the registered readers. ` +
        "Build-time reads go through src/lib/awcms/ or src/lib/catalog.ts so they can be frozen."
    );
  }

  for (const file of scan.fetchInAwcmsLib) {
    if (!outOfBundle.some((entry) => entry.readers.includes(file))) {
      problems.push(`${file} calls fetch() directly but is not a registered out-of-bundle reader.`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Everything the gate asserts, in one place (CLI and test both call this)
// ---------------------------------------------------------------------------

/** The fixture must say exactly what OPERATIONS and OUT_OF_BUNDLE say. */
export function findFixtureDrift(frozen) {
  const problems = [];
  const sorted = [...OPERATIONS].sort((a, b) => (opKey(a) < opKey(b) ? -1 : 1));
  if (JSON.stringify(frozen.operations) !== JSON.stringify(sorted)) {
    problems.push(
      "the fixture's operations differ from OPERATIONS. Re-freeze deliberately: " +
        'bun run contract:storefront:generate --reason "<why>".'
    );
  }
  if (JSON.stringify(frozen.outOfBundle) !== JSON.stringify(OUT_OF_BUNDLE)) {
    problems.push("the fixture's outOfBundle list differs from OUT_OF_BUNDLE (regenerate deliberately).");
  }
  return problems;
}

/** Run every check; returns problems, empty when green. `root` is the repo root. */
export function runChecks({ frozen, bundle, root }) {
  const problems = [...findFixtureDrift(frozen)];

  let current;
  try {
    current = buildSlice(bundle, frozen.operations);
  } catch (error) {
    problems.push(error.message);
  }
  if (current) problems.push(...findContractBreaks(frozen, current));

  problems.push(...findUndeclaredQueryParams(bundle, frozen.operations));
  problems.push(...compareScanToSlice(scanBuildReadSources(root)));
  return problems;
}
