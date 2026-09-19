/**
 * removals.mjs — the BjekMart-only artefacts ADR-0018 D4/D5 name as
 * `template:init`'s removal target, listed once so `plan.mjs` and this
 * file's own test can agree on exactly what "removed" means.
 *
 * Every entry is checked for EXISTENCE before being scheduled — a derived
 * repo's second run (or a repo where #139 already relocated the BjekMart
 * seed before this tool ever ran) finds nothing to remove and that step is
 * simply absent from the plan, which is what makes removal idempotent with
 * no extra bookkeeping.
 *
 * **Both layouts, per the issue's own instruction**: #139 (issue, a
 * sibling of this one) is expected to replace `tools/seed-borneojek-mart.ts`
 * with `tools/seed-cms.ts` and move BjekMart's own seed data from
 * `tools/seed-data/*.json` (flat, today's layout) to
 * `tools/seed-data/contoh/borneojek-mart/**` (nested, #139's target layout).
 * Whichever one is on disk when `template:init` runs is removed; the other
 * is simply absent and skipped.
 */

/** Files removed unconditionally, regardless of layout. */
export const ALWAYS_REMOVE_FILES = ["tools/import-seputarborneo.ts", "tests/import-seputarborneo.test.mjs"];

/** Directories reset to absent — ADR-0018 D5's "documented empty state" for the knowledge-graph corpus (see `docs/template.md`'s own note on why absence, not an emptied file, is what `audit:graf` treats as valid). */
export const ALWAYS_REMOVE_DIRS = ["graphify-out", "knowledge/generated"];

/** Today's flat layout: the seeder script plus every BjekMart-specific fixture under `tools/seed-data/*.json`. */
export const OLD_LAYOUT_SEED_SCRIPT = "tools/seed-borneojek-mart.ts";
export const OLD_LAYOUT_SEED_DATA_FILES = [
  "tools/seed-data/categories.json",
  "tools/seed-data/posts-berita.json",
  "tools/seed-data/pages.json",
  "tools/seed-data/ad-placements.json",
  "tools/seed-data/site-profile.json",
  "tools/seed-data/redirects.json",
  "tools/seed-data/posts.json",
  "tools/seed-data/marketing.json",
  "tools/seed-data/rubrik.json",
  "tools/seed-data/institutions.json",
  "tools/seed-data/terms.json",
  "tools/seed-data/orders.json",
  "tools/seed-data/products.json"
];
/** Every asset under here is BjekMart product/ad art (verified by listing the directory; none is generic). */
export const OLD_LAYOUT_SEED_ASSETS_DIR = "tools/seed-assets";

/** #139's target layout, once it lands. */
export const NEW_LAYOUT_SEED_DIR = "tools/seed-data/contoh/borneojek-mart";
