/**
 * removals.mjs — the BjekMart-only artefacts ADR-0018 D4/D5 name as
 * `template:init`'s removal target, listed once so `plan.mjs` and this
 * file's own test can agree on exactly what "removed" means.
 *
 * Every entry is checked for EXISTENCE before being scheduled — a derived
 * repo's second run (or a repo already past whichever removal it needs)
 * finds nothing to remove and that step is simply absent from the plan,
 * which is what makes removal idempotent with no extra bookkeeping.
 *
 * **Both layouts, handled**: issue #139 landed on `main` while this issue
 * was in flight — `tools/seed-borneojek-mart.ts` is now a one-release
 * DEPRECATION SHIM (not deleted outright), `tools/seed-cms.ts` is the real
 * seeder, and BjekMart's own reference content moved to
 * `tools/seed-data/contoh/borneojek-mart/**`/`tools/seed-assets/`'s
 * top-level files (`tools/seed-assets/profil/**`, #139's OWN neutral
 * per-profile placeholder art, is never touched — only the pre-#139
 * BjekMart-specific files directly under `tools/seed-assets/`). The
 * PRE-#139 flat layout (`tools/seed-data/*.json`) is also still checked and
 * removed, purely defensively, in case this tool ever runs against a tree
 * checked out before #139 landed.
 */

/**
 * Files removed unconditionally, regardless of layout.
 *
 * `tests/seed-profil.test.mjs` (#139) is deliberately NOT in this list —
 * it validates the neutral `tools/seed-data/profil/**` seeds every derived
 * repo KEEPS, not only the BjekMart reference example this run removes.
 * That file guards its own `contoh:borneojek-mart`/deprecation-shim-specific
 * coverage with an existence check (`HAS_CONTOH_SEED`/
 * `HAS_DEPRECATION_SHIM`, skipping cleanly when this tool has already
 * removed what they describe) rather than being removed itself.
 */
export const ALWAYS_REMOVE_FILES = [
  "tools/import-seputarborneo.ts",
  "tests/import-seputarborneo.test.mjs",
  // #139's own one-release deprecation shim — a derived repo has no
  // reference deployment to keep it running for.
  "tools/seed-borneojek-mart.ts"
];

/** Directories reset to absent — ADR-0018 D5's "documented empty state" for the knowledge-graph corpus (see `docs/template.md`'s own note on why absence, not an emptied file, is what `audit:graf` treats as valid). */
export const ALWAYS_REMOVE_DIRS = [
  "graphify-out",
  "knowledge/generated",
  // #139's target layout — the full BjekMart reference example.
  "tools/seed-data/contoh/borneojek-mart"
];

/** The PRE-#139 flat layout: every BjekMart-specific fixture directly under `tools/seed-data/*.json` (defensive only — see this file's own docblock). */
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

/**
 * The BjekMart product/ad art directly under `tools/seed-assets/` (verified
 * by listing the directory) — named individually, NOT the whole directory,
 * because `tools/seed-assets/profil/**` (#139's own neutral per-profile
 * placeholder SVGs) lives one level down in the SAME directory and must
 * never be removed.
 */
export const BJEKMART_SEED_ASSET_FILES = [
  "tools/seed-assets/product-bjekmikro.svg",
  "tools/seed-assets/product-voucher-digital.svg",
  "tools/seed-assets/product-saldo-driver.svg",
  "tools/seed-assets/product-mie-gacoan.svg",
  "tools/seed-assets/product-rutinride.svg",
  "tools/seed-assets/ad-970x250.png",
  "tools/seed-assets/ad-728x90.png",
  "tools/seed-assets/ad-300x250.png",
  "tools/seed-assets/ad-300x600.png"
];
