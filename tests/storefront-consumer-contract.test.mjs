/**
 * Gate: the storefront's build-time reads are frozen against the OpenAPI bundle
 * (issue #555, ADR-0058 D2, audit F-01 and F-07).
 *
 * No database, no network, no build: it reads the committed bundle in
 * `apps/cms/openapi/`, the frozen fixture and the storefront source, so it runs
 * inside `local-ci/check-toko` through the bare root `bun test`.
 *
 * The first group is the real gate over this repository's state. The second
 * proves each check can actually fail, because a gate that has never been seen
 * red is an assumption (the mutations are made in memory or in a temp tree).
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BUNDLE_PATH,
  FIXTURE_PATH,
  OPERATIONS,
  OUT_OF_BUNDLE,
  PROFILES,
  THEMING_ROUTE_FILE,
  buildSlice,
  compareScanToSlice,
  findContractBreaks,
  findFixtureDrift,
  findUndeclaredQueryParams,
  isAdditiveSuperset,
  operationsForProfile,
  runChecks,
  scanBuildReadSources
} from "../tools/lib/storefront-consumer-contract.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const bundle = Bun.YAML.parse(readFileSync(join(ROOT, BUNDLE_PATH), "utf8"));
const frozen = JSON.parse(readFileSync(join(ROOT, FIXTURE_PATH), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

describe("storefront build-read contract: this repository", () => {
  test("the whole gate is green (fixture, additive superset, query params, source scan)", () => {
    assert.deepEqual(runChecks({ frozen, bundle, root: ROOT }), []);
  });

  test("the fixture is exactly what OPERATIONS and OUT_OF_BUNDLE say (regeneration is deliberate)", () => {
    assert.deepEqual(findFixtureDrift(frozen), []);
  });

  test("every operation is a GET in the bundle and every frozen operation is registered once", () => {
    const keys = OPERATIONS.map((entry) => `${entry.method} ${entry.path}`);
    assert.equal(new Set(keys).size, keys.length, "duplicate operation");
    for (const entry of OPERATIONS) {
      assert.equal(entry.phase, "build");
      assert.equal(entry.method, "GET");
      assert.ok(bundle.paths[entry.path]?.get, `${entry.path} has no GET in the bundle`);
      assert.ok(entry.readers.length > 0, `${entry.path} names no reader`);
    }
  });

  test("the per-profile sets are pinned: landing reads only the shared operations", () => {
    for (const profile of PROFILES) {
      assert.ok(operationsForProfile(OPERATIONS, profile).length > 0, `${profile} has no build read`);
    }
    assert.deepEqual(
      operationsForProfile(OPERATIONS, "landing").map((entry) => entry.path).sort(),
      [
        "/api/v1/blog/pages/public",
        "/api/v1/blog/pages/public/{slug}",
        "/api/v1/commerce/store-settings/public",
        "/api/v1/media/public-origin",
        "/api/v1/site-profile/composed"
      ],
      "landing builds the shared group only; widening this set is a deliberate decision"
    );
    // berita is a subset of toko (toko builds shared + toko + berita groups).
    const toko = new Set(operationsForProfile(OPERATIONS, "toko").map((entry) => entry.path));
    for (const entry of operationsForProfile(OPERATIONS, "berita")) {
      assert.ok(toko.has(entry.path), `${entry.path} is built by berita but not by toko`);
    }
    assert.ok(
      !operationsForProfile(OPERATIONS, "berita").some((entry) => entry.path.startsWith("/api/v1/commerce/products")),
      "berita must not read the catalog"
    );
  });

  test("tokens.css is named explicitly as out of the bundle, with a reason and an alternative check", () => {
    assert.equal(OUT_OF_BUNDLE.length, 1);
    const [theme] = OUT_OF_BUNDLE;
    assert.equal(theme.path, "/theming/{tenantCode}/tokens.css");
    assert.deepEqual(theme.profiles, PROFILES);
    assert.ok(theme.reason.length > 0 && theme.alternativeCheck.length > 0);
    assert.equal(bundle.paths[theme.path], undefined, "tokens.css is now in the bundle: freeze it as an operation instead");
    assert.ok(existsSync(join(ROOT, THEMING_ROUTE_FILE)), `${THEMING_ROUTE_FILE} (the provider route) no longer exists`);
    assert.equal(frozen.paths[theme.path], undefined, "no schema may be invented for tokens.css");
  });

  test("nothing under tests/ or tools/ imports packages/kontrak at runtime, and apps/cms is not imported", () => {
    const sources = [
      readFileSync(join(ROOT, "tools/lib/storefront-consumer-contract.mjs"), "utf8"),
      readFileSync(join(ROOT, "tools/storefront-consumer-contract.mjs"), "utf8")
    ];
    for (const text of sources) {
      assert.doesNotMatch(text, /from\s+["'][^"']*packages\/kontrak/);
      assert.doesNotMatch(text, /from\s+["'][^"']*apps\/cms/);
    }
  });
});

describe("storefront build-read contract: each check can fail", () => {
  function currentSlice(mutate) {
    const copy = clone(bundle);
    mutate(copy);
    return buildSlice(copy, frozen.operations);
  }

  test("adding a field or an enum value is additive and passes", () => {
    const current = currentSlice((b) => {
      const schema = b.components.schemas[Object.keys(frozen.components.schemas)[0]];
      schema.properties = { ...(schema.properties ?? {}), brandNewOptionalField: { type: "string" } };
    });
    assert.deepEqual(findContractBreaks(frozen, current), []);
  });

  test("removing a property the consumer relies on is a break", () => {
    const target = Object.entries(frozen.components.schemas).find(([, schema]) => schema.properties && Object.keys(schema.properties).length > 0);
    assert.ok(target, "expected at least one frozen schema with properties");
    const [name, schema] = target;
    const dropped = Object.keys(schema.properties)[0];
    const current = currentSlice((b) => {
      delete b.components.schemas[name].properties[dropped];
    });
    const breaks = findContractBreaks(frozen, current);
    assert.ok(breaks.some((entry) => entry.includes(`components.schemas.${name}`)), breaks.join("\n"));
  });

  test("retyping a property is a break", () => {
    const target = Object.entries(frozen.components.schemas).find(([, schema]) =>
      Object.values(schema.properties ?? {}).some((property) => property.type === "string")
    );
    assert.ok(target);
    const [name, schema] = target;
    const field = Object.entries(schema.properties).find(([, property]) => property.type === "string")[0];
    const current = currentSlice((b) => {
      b.components.schemas[name].properties[field].type = "number";
    });
    assert.ok(findContractBreaks(frozen, current).length > 0);
  });

  test("a removed operation fails closed when the slice is rebuilt", () => {
    const copy = clone(bundle);
    delete copy.paths["/api/v1/blog/terms"].get;
    assert.throws(() => buildSlice(copy, frozen.operations), /GET \/api\/v1\/blog\/terms is not in/);
  });

  test("a narrowed enum is a break, an extended one is not (set semantics)", () => {
    assert.equal(isAdditiveSuperset(["a", "b"], ["a", "b", "c"]), true);
    assert.equal(isAdditiveSuperset(["a", "b"], ["a"]), false);
    assert.equal(isAdditiveSuperset({ type: "string" }, { type: "string", nullable: true }), true);
    assert.equal(isAdditiveSuperset({ type: "string" }, { type: "integer" }), false);
  });

  test("rewording documentation is not a contract change", () => {
    const current = currentSlice((b) => {
      b.paths["/api/v1/blog/terms"].get.description = "reworded";
      b.paths["/api/v1/blog/terms"].get.summary = "reworded";
    });
    assert.deepEqual(findContractBreaks(frozen, current), []);
  });

  test("a query parameter the bundle stops declaring is reported", () => {
    const copy = clone(bundle);
    const operation = copy.paths["/api/v1/analytics/pages"].get;
    operation.parameters = (operation.parameters ?? []).filter((parameter) => {
      const resolved = parameter.$ref ? copy.components.parameters[parameter.$ref.split("/").pop()] : parameter;
      return resolved?.name !== "range";
    });
    const problems = findUndeclaredQueryParams(copy, OPERATIONS);
    assert.ok(problems.some((entry) => entry.includes('"range"')), problems.join("\n"));
  });

  test("a fixture edited by hand, or an OPERATIONS edit without regeneration, is drift", () => {
    const edited = clone(frozen);
    edited.operations[0].profiles = ["toko"];
    assert.ok(findFixtureDrift(edited).length > 0);
  });
});

describe("storefront build-read contract: the source guard can fail", () => {
  function tree(files) {
    const dir = mkdtempSync(join(tmpdir(), "sfcc-"));
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    return dir;
  }

  const LIB = "apps/storefront/src/lib/awcms";
  const registeredAll = {
    [`${LIB}/profil.ts`]: 'await awcmsGet("/api/v1/site-profile/composed");',
    [`${LIB}/pages.ts`]: 'awcmsGet("/api/v1/blog/pages/public"); awcmsGet(`/api/v1/blog/pages/public/${encodeURIComponent(slug)}`);',
    [`${LIB}/pemasaran.ts`]: [
      'awcmsGet("/api/v1/commerce/store-settings/public");',
      ...["sliders/active", "flash-sales/active", "vouchers/public", "testimonials/active", "popups/active"].map(
        (tail) => `awcmsGet("/api/v1/commerce/${tail}");`
      )
    ].join("\n"),
    [`${LIB}/media.ts`]: 'awcmsGet("/api/v1/media/public-origin"); awcmsGet("/api/v1/media/objects", {});',
    [`${LIB}/blog.ts`]: [
      "/api/v1/blog/posts",
      "/api/v1/blog/terms",
      "/api/v1/blog/institutions",
      "/api/v1/news-portal/ad-placements/active",
      "/api/v1/seo/redirects"
    ]
      .map((path) => `awcmsGet("${path}");`)
      .join("\n"),
    [`${LIB}/analitik.ts`]: 'awcmsGet("/api/v1/analytics/pages");',
    [`${LIB}/wilayah.ts`]: 'awcmsGet("/api/v1/idn-regions/regions");',
    [`${LIB}/wilayah-checkout.ts`]: 'awcmsGet("/api/v1/idn-regions/regions");',
    "apps/storefront/src/lib/catalog.ts": 'awcmsGet("/api/v1/commerce/products"); awcmsGet("/api/v1/commerce/categories");',
    [`${LIB}/theme.ts`]: "const url = `${origin}/theming/${encodeURIComponent(code)}/tokens.css`; fetch(url);"
  };

  function problemsFor(extra = {}, remove = []) {
    const files = { ...registeredAll, ...extra };
    for (const rel of remove) delete files[rel];
    const dir = tree(files);
    try {
      return compareScanToSlice(scanBuildReadSources(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("the synthetic baseline (every registered reader, nothing else) is clean", () => {
    assert.deepEqual(problemsFor(), []);
  });

  test("a new awcmsGet reader file is reported", () => {
    const problems = problemsFor({ [`${LIB}/novo.ts`]: 'awcmsGet("/api/v1/novo/endpoint");' });
    assert.ok(problems.some((entry) => entry.includes("novo.ts") && entry.includes("not a reader")), problems.join("\n"));
  });

  test("a new path in an existing reader is reported", () => {
    const problems = problemsFor({ [`${LIB}/analitik.ts`]: 'awcmsGet("/api/v1/analytics/pages"); awcmsGet("/api/v1/analytics/other");' });
    assert.ok(problems.some((entry) => entry.includes("/api/v1/analytics/other")), problems.join("\n"));
  });

  test("a path named only in a comment is not a read", () => {
    const problems = problemsFor({ [`${LIB}/analitik.ts`]: '// GET /api/v1/x/y\n/** "/api/v1/analytics/legacy" */ awcmsGet("/api/v1/analytics/pages");' });
    assert.deepEqual(problems, []);
  });

  test("an awcms path literal in a page, layout or component is reported", () => {
    const problems = problemsFor({
      "apps/storefront/src/pages/x.astro": '---\nconst r = await fetch(`${base}` + "/api/v1/commerce/leaked");\n---'
    });
    assert.ok(problems.some((entry) => entry.includes("pages/x.astro")), problems.join("\n"));
  });

  test("a reader that stopped reading leaves a stale entry", () => {
    const problems = problemsFor({}, [`${LIB}/analitik.ts`]);
    assert.ok(problems.some((entry) => entry.includes("analitik.ts") && entry.includes("stale")), problems.join("\n"));
  });

  test("a direct fetch() in src/lib/awcms outside theme.ts is reported", () => {
    const problems = problemsFor({ [`${LIB}/analitik.ts`]: 'awcmsGet("/api/v1/analytics/pages"); fetch(u);' });
    assert.ok(problems.some((entry) => entry.includes("calls fetch() directly")), problems.join("\n"));
  });

  test("the real source tree has no stray or unregistered build read", () => {
    assert.deepEqual(compareScanToSlice(scanBuildReadSources(ROOT)), []);
  });
});
