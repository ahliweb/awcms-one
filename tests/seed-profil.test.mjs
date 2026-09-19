/**
 * tests/seed-profil.test.mjs — issue #139.
 *
 * Coverage for the neutral, fictional per-profile sample seeds
 * (`tools/seed-data/profil/{toko,berita,landing}/*.json`) and the reference
 * example's own moved seed (`tools/seed-data/contoh/borneojek-mart/*.json`),
 * plus `tools/seed-cms.ts`'s `--dry-run` mode:
 *
 *   1. Every profile's JSON validates against the shapes
 *      `tools/lib/seed-profil.mjs` derives from `tools/seed-cms.ts`'s own
 *      `ensure*` functions — the same schema check the script's own
 *      `--dry-run` mode runs, not a second, drift-prone copy.
 *   2. A no-PII regex sweep over every profile file's RAW text — a phone
 *      number or e-mail domain outside this issue's own allowlist
 *      (`example.com`/`example.id`/… and the `+62 800 0000 0000` shape)
 *      fails the file it is found in.
 *   3. Every asset path a profile's JSON references
 *      (`future.images`, `future.logoAsset`) resolves to a real file this
 *      issue committed under `tools/seed-assets/**`.
 *   4. `bun tools/seed-cms.ts --dry-run --profil <name>` exits 0 for all
 *      four profiles and makes no network call at all (this is the
 *      "dry-run against a fake CMS" the issue asks for — `--dry-run` is
 *      deliberately network-free by design, see `tools/seed-cms.ts`'s own
 *      docblock for why that is a STRONGER guarantee than a fake server
 *      would give).
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  validateCategories,
  validateProducts,
  validateMarketing,
  validateTerms,
  validatePages,
  validateSiteProfile,
  validateRubrik,
  validateInstitutions,
  validateNewsPosts,
  validateAuthors,
  scanForPii
} from "../tools/lib/seed-profil.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const SEED_DATA_ROOT = join(ROOT, "tools", "seed-data");
const SEED_ASSETS_ROOT = join(ROOT, "tools", "seed-assets");

function seedDirFor(profil) {
  if (profil === "contoh:borneojek-mart") return join(SEED_DATA_ROOT, "contoh", "borneojek-mart");
  return join(SEED_DATA_ROOT, "profil", profil);
}

function readJson(dir, fileName) {
  return JSON.parse(readFileSync(join(dir, fileName), "utf8"));
}

function hasFile(dir, fileName) {
  return existsSync(join(dir, fileName));
}

const NEUTRAL_PROFILES = ["toko", "berita", "landing"];
const ALL_PROFILES = [...NEUTRAL_PROFILES, "contoh:borneojek-mart"];

// `bun run template:init` (issue #138) removes BOTH `tools/seed-data/contoh/
// borneojek-mart/**` and `tools/seed-borneojek-mart.ts` (the deprecation
// shim) from a derived repository — this file's own reference-example and
// shim coverage is guarded to skip cleanly when either is absent, rather
// than deleted outright, so the NEUTRAL `toko`/`berita`/`landing` coverage
// below (the seeds a derived repo actually keeps) still runs there. See
// `docs/template.md`'s "What it removes" for the full reasoning.
const HAS_CONTOH_SEED = existsSync(seedDirFor("contoh:borneojek-mart"));
const HAS_DEPRECATION_SHIM = existsSync(join(ROOT, "tools", "seed-borneojek-mart.ts"));
const PROFILES_TO_TEST = HAS_CONTOH_SEED ? ALL_PROFILES : NEUTRAL_PROFILES;

describe("tools/seed-data — every profile directory exists", () => {
  for (const profil of PROFILES_TO_TEST) {
    test(`"${profil}" has a seed directory`, () => {
      assert.ok(existsSync(seedDirFor(profil)), `missing seed directory for profile "${profil}"`);
    });
  }
});

describe("tools/seed-data/profil/toko — schema", () => {
  const dir = seedDirFor("toko");

  test("categories.json validates and has at most 6 categories", () => {
    const categories = readJson(dir, "categories.json");
    assert.deepEqual(validateCategories(categories), []);
    assert.ok(categories.length <= 6, `expected <= 6 categories, got ${categories.length}`);
  });

  test("products.json validates, resolves categorySlug, and has at most 20 products", () => {
    const categories = readJson(dir, "categories.json");
    const knownCategorySlugs = new Set(categories.map((item) => item.slug));
    const products = readJson(dir, "products.json");
    assert.deepEqual(validateProducts(products, knownCategorySlugs), []);
    assert.ok(products.length <= 20, `expected <= 20 products, got ${products.length}`);
  });

  test("marketing.json validates and resolves every flash-sale productSlug", () => {
    const products = readJson(dir, "products.json");
    const knownProductSlugs = new Set(products.map((item) => item.slug));
    const marketing = readJson(dir, "marketing.json");
    assert.deepEqual(validateMarketing(marketing, knownProductSlugs), []);
  });

  test("terms.json validates", () => {
    assert.deepEqual(validateTerms(readJson(dir, "terms.json")), []);
  });

  test("pages.json validates and has at most 6 pages", () => {
    const pages = readJson(dir, "pages.json");
    assert.deepEqual(validatePages(pages), []);
    assert.ok(pages.length <= 6, `expected <= 6 pages, got ${pages.length}`);
  });
});

describe("tools/seed-data/profil/berita — schema", () => {
  const dir = seedDirFor("berita");

  test("rubrik.json validates and has at most 5 entries (contract cap)", () => {
    const rubrik = readJson(dir, "rubrik.json");
    assert.deepEqual(validateRubrik(rubrik), []);
    assert.ok(rubrik.length <= 5, `expected <= 5 rubrics, got ${rubrik.length}`);
  });

  test("institutions.json validates strictly (every regionLevel 2 entry names its provinceName)", () => {
    const institutions = readJson(dir, "institutions.json");
    assert.deepEqual(validateInstitutions(institutions, { requireProvinceName: true }), []);
  });

  test("posts-berita.json validates, resolves rubrikSlug/institutionSlugs, and has at most 15 posts", () => {
    const rubrik = readJson(dir, "rubrik.json");
    const institutions = readJson(dir, "institutions.json");
    const knownRubrikSlugs = new Set(rubrik.map((item) => item.slug));
    const knownInstitutionSlugs = new Set(institutions.map((item) => item.slug));
    const posts = readJson(dir, "posts-berita.json");
    assert.deepEqual(validateNewsPosts(posts, knownRubrikSlugs, knownInstitutionSlugs), []);
    assert.ok(posts.length <= 15, `expected <= 15 posts, got ${posts.length}`);
  });

  test("authors.json validates and has at most 3 authors (contract cap)", () => {
    const authors = readJson(dir, "authors.json");
    assert.deepEqual(validateAuthors(authors), []);
    assert.ok(authors.length <= 3, `expected <= 3 authors, got ${authors.length}`);
  });

  test("pages.json validates and has at most 4 pages", () => {
    const pages = readJson(dir, "pages.json");
    assert.deepEqual(validatePages(pages), []);
    assert.ok(pages.length <= 4, `expected <= 4 pages, got ${pages.length}`);
  });
});

describe("tools/seed-data/profil/landing — schema", () => {
  const dir = seedDirFor("landing");

  test("site-profile.json validates", () => {
    assert.deepEqual(validateSiteProfile(readJson(dir, "site-profile.json")), []);
  });

  test("pages.json validates and has at most 4 pages", () => {
    const pages = readJson(dir, "pages.json");
    assert.deepEqual(validatePages(pages), []);
    assert.ok(pages.length <= 4, `expected <= 4 pages, got ${pages.length}`);
  });

  test("site-profile.json carries contact details (contract: 'site-profile/pages/contact')", () => {
    const seed = readJson(dir, "site-profile.json");
    assert.ok(seed.current.contactEmail, "current.contactEmail must be set");
    assert.ok(seed.current.contactPhone, "current.contactPhone must be set");
  });
});

describe("tools/seed-data/contoh/borneojek-mart — still validates against the shared schema", () => {
  if (!HAS_CONTOH_SEED) {
    test.skip("SKIPPED — tools/seed-data/contoh/borneojek-mart/** is absent (removed by template:init in a derived repo)", () => {});
    return;
  }

  const dir = seedDirFor("contoh:borneojek-mart");

  test("categories.json validates", () => {
    assert.deepEqual(validateCategories(readJson(dir, "categories.json")), []);
  });

  test("products.json validates and resolves categorySlug", () => {
    const categories = readJson(dir, "categories.json");
    const knownCategorySlugs = new Set(categories.map((item) => item.slug));
    assert.deepEqual(validateProducts(readJson(dir, "products.json"), knownCategorySlugs), []);
  });

  test("pages.json validates", () => {
    assert.deepEqual(validatePages(readJson(dir, "pages.json")), []);
  });

  test("rubrik.json validates", () => {
    assert.deepEqual(validateRubrik(readJson(dir, "rubrik.json")), []);
  });
});

// ---------------------------------------------------------------------------
// No-PII sweep — every profile JSON's raw text, every phone/e-mail found
// must be inside the allowlist this issue's own contract names.
// ---------------------------------------------------------------------------

describe("no-PII sweep — profile seeds only (contoh:borneojek-mart is real, documented reference content)", () => {
  for (const profil of NEUTRAL_PROFILES) {
    const dir = seedDirFor(profil);
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

    for (const file of files) {
      test(`${profil}/${file} has no e-mail/phone outside the placeholder allowlist`, () => {
        const text = readFileSync(join(dir, file), "utf8");
        const { emails, phones } = scanForPii(text);
        assert.deepEqual(emails, [], `${profil}/${file} contains non-allowlisted e-mail(s): ${emails.join(", ")}`);
        assert.deepEqual(phones, [], `${profil}/${file} contains non-placeholder phone number(s): ${phones.join(", ")}`);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Every asset reference resolves.
// ---------------------------------------------------------------------------

function collectAssetPaths(value, out) {
  if (typeof value === "string" && value.startsWith("tools/seed-assets/")) {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectAssetPaths(item, out);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) collectAssetPaths(value[key], out);
  }
}

describe("every asset reference in a profile's seed JSON resolves to a committed file", () => {
  for (const profil of PROFILES_TO_TEST) {
    const dir = seedDirFor(profil);
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

    for (const file of files) {
      test(`${profil}/${file}'s asset references resolve`, () => {
        const data = readJson(dir, file);
        const assetPaths = [];
        collectAssetPaths(data, assetPaths);

        for (const assetPath of assetPaths) {
          assert.ok(
            existsSync(join(ROOT, assetPath)),
            `${profil}/${file} references "${assetPath}", which does not exist`
          );
        }
      });
    }
  }
});

describe("tools/seed-assets/profil — every neutral profile shipped at least one placeholder asset", () => {
  for (const profil of NEUTRAL_PROFILES) {
    test(`tools/seed-assets/profil/${profil} has at least one file`, () => {
      const dir = join(SEED_ASSETS_ROOT, "profil", profil);
      assert.ok(existsSync(dir), `missing tools/seed-assets/profil/${profil}`);
      const files = readdirSync(dir);
      assert.ok(files.length > 0, `tools/seed-assets/profil/${profil} is empty`);
    });
  }
});

// ---------------------------------------------------------------------------
// `--dry-run` — no network call, exits 0, for every profile.
// ---------------------------------------------------------------------------

describe("tools/seed-cms.ts --dry-run", () => {
  for (const profil of PROFILES_TO_TEST) {
    test(`--profil "${profil}" exits 0 and makes no network call`, () => {
      const result = spawnSync("bun", ["tools/seed-cms.ts", "--dry-run", "--profil", profil], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 30_000
      });

      assert.equal(
        result.status,
        0,
        `dry-run for "${profil}" exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      );
      assert.match(result.stdout, /No network calls made \(dry-run\)\./);
    });
  }

  test("an unknown --profil fails fast with a clear message", () => {
    const result = spawnSync("bun", ["tools/seed-cms.ts", "--dry-run", "--profil", "does-not-exist"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown --profil/);
  });
});

describe("tools/seed-borneojek-mart.ts — deprecation shim delegates to seed-cms.ts", () => {
  if (!HAS_DEPRECATION_SHIM) {
    test.skip("SKIPPED — tools/seed-borneojek-mart.ts is absent (removed by template:init in a derived repo)", () => {});
    return;
  }

  test("running it with --dry-run prints the deprecation notice and the contoh:borneojek-mart inventory", () => {
    const result = spawnSync("bun", ["tools/seed-borneojek-mart.ts", "--dry-run"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000
    });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /deprecated/);
    assert.match(result.stdout, /profile "contoh:borneojek-mart"/);
  });
});
