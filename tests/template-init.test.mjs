/**
 * tests/template-init.test.mjs — issue #138.
 *
 * Coverage:
 *
 *  1. `--dry-run` plan, against THIS repo's own tree (read-only — never
 *     writes, so this needs no temp copy).
 *  2. A full run in a temp copy, for EACH profile — every tracked (and
 *     freshly-added, untracked) file copied, every workspace's own
 *     `node_modules` SYMLINKED rather than reinstalled. One profile
 *     (`toko`) additionally runs the copy's own FULL trailing gate chain
 *     for real (`docs:i18n:stamp`, `audit:dokumen`, `audit:translation`,
 *     `audit:rilis`, `bun test`) and must pass; the other two are checked
 *     at the plan/apply level, since a real `bun test` here spawns a real
 *     `astro build` per storefront build-smoke file — the per-profile
 *     version of that same proof is `template-init-smoke.yml`'s own CI job.
 *     Every run's rewrite targets are scanned for no BjekMart-specific
 *     string left in ADR-0018 D4's own named brand surface.
 *  3. Idempotency: a second run with identical flags is a no-op; a third
 *     run with one different flag rewrites only what changed.
 *  4. Dirty-tree refusal without `--yes`.
 *  5. Missing required flags exits `2` in non-interactive mode.
 *
 * Every full-run test is skipped, loudly, when `git`/`bun` cannot be
 * spawned in this environment — never a silent false pass.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildPlan, describePlan, isEmptyPlan } from "../tools/template-init/plan.mjs";
import { main } from "../tools/template-init/run.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

const BASE_FLAGS = [
  "--nama",
  "Toko Contoh",
  "--slug",
  "toko-contoh",
  "--domain",
  "toko-contoh.id",
  "--profil",
  "toko",
  "--warna-primer",
  "#0ea5e9",
  "--kontak-email",
  "owner@toko-contoh.id"
];

function canSpawn(cmd) {
  try {
    return Bun.spawnSync([cmd, "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

const HAS_GIT = canSpawn("git");
const HAS_BUN = canSpawn("bun");

/**
 * Every file that WOULD be tracked once committed — cached + untracked
 * (minus anything `.gitignore`'d), the same `git ls-files` shape
 * `tools/docs-i18n-stamp.mjs`'s own `listMirrors()` uses and for the same
 * reason: a file created in the SAME change as this test run (this tool's
 * own new files, on this very branch) must be in the copy, not only what
 * has already been committed.
 */
function listTrackedFiles() {
  return execSync("git ls-files --cached --others --exclude-standard", {
    cwd: REPO_ROOT,
    encoding: "utf8"
  })
    .split("\n")
    .filter(Boolean)
    .filter(
      // THIS test file is deliberately excluded from the copy. The `toko`
      // leg below runs the copy's own real trailing gate chain, which
      // includes a real `bun test` — bare `bun test` collects every test
      // file under the copy, which would include a copy of THIS file,
      // recursively re-running the whole suite (and its own temp copies)
      // a second time inside the first copy. Worse: by the time that
      // inner `bun test` runs, `template:init` has already DELETED files
      // this same test's `git ls-files --cached` still lists as tracked
      // (a real `unlinkSync`, never a `git rm`, inside a copy that is
      // never re-committed) — so the inner run's own `makeTempCopy()`
      // then fails trying to copy something gone. Excluding this one file
      // means the copy's `bun test` exercises every OTHER root gate test
      // for real, without also re-running (and re-breaking) itself.
      (file) => file !== "tests/template-init.test.mjs"
    );
}

const tempDirs = [];

/**
 * A throwaway copy of every tracked file, a symlinked `node_modules`, and
 * its own tiny git repo (so `git status --porcelain`/`rev-parse HEAD` — both
 * of which `run.mjs` itself calls — have something real to answer).
 */
function makeTempCopy() {
  const dir = mkdtempSync(join(tmpdir(), "template-init-test-"));
  tempDirs.push(dir);

  for (const file of listTrackedFiles()) {
    const dest = join(dir, file);
    mkdirSync(dirname(dest), { recursive: true });
    // `copyFileSync`, not `cpSync`: the latter stats the DESTINATION first
    // (to decide whether it may overwrite), and hitting that stat on a path
    // whose parent directory was itself just created a moment ago has been
    // observed to throw ENOENT instead of the "does not exist yet" it
    // means — a plain byte copy has no such check to race.
    copyFileSync(join(REPO_ROOT, file), dest);
  }

  // Bun's isolated installs give several workspace members their OWN
  // `node_modules` alongside the root one — every one that exists in this
  // repo's real install is symlinked in, not only the root, or `astro`
  // (apps/storefront's own binary) resolves to nothing in the copy.
  for (const rel of ["node_modules", "apps/storefront/node_modules", "apps/cms/node_modules", "packages/kontrak/node_modules"]) {
    const src = join(REPO_ROOT, rel);
    if (existsSync(src)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      symlinkSync(src, join(dir, rel), "dir");
    }
  }

  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "template-init test"', { cwd: dir });
  execSync("git add -A", { cwd: dir });
  execSync('git commit -q -m "initial"', { cwd: dir });

  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("template:init — dry-run plan", () => {
  test("prints a plan and touches nothing in this repo's own tree", async () => {
    const before = readFileSync(join(REPO_ROOT, "package.json"), "utf8");
    const exitCode = await main([...BASE_FLAGS, "--dry-run"], { root: REPO_ROOT, isTTY: false });
    const after = readFileSync(join(REPO_ROOT, "package.json"), "utf8");

    expect(exitCode).toBe(0);
    expect(after).toBe(before);
  });

  test("the plan names every flag-driven rewrite target", () => {
    const plan = buildPlan({
      root: REPO_ROOT,
      flags: {
        nama: "Toko Contoh",
        slug: "toko-contoh",
        domain: "toko-contoh.id",
        profil: "toko",
        warnaPrimer: "#0ea5e9",
        warnaSekunder: "#096892",
        warnaAksen: "#f59e0b",
        kontakEmail: "owner@toko-contoh.id"
      },
      today: "2026-09-20",
      originSha: "deadbeef"
    });
    const text = describePlan(plan);
    expect(text).toContain("apps/storefront/src/config/site.ts");
    expect(text).toContain("compose.yaml");
    expect(text).toContain("README.md");
  });

  test("missing required flags exits 2 in non-interactive mode", async () => {
    const exitCode = await main(["--nama", "Toko Contoh"], { root: REPO_ROOT, isTTY: false });
    expect(exitCode).toBe(2);
  });

  test("refuses package.json.name === \"awcms-one\" without --yes", async () => {
    const exitCode = await main(BASE_FLAGS, { root: REPO_ROOT, isTTY: false });
    expect(exitCode).toBe(3);
  });
});

describe("template:init — full run in a temp copy", () => {
  if (!HAS_GIT || !HAS_BUN) {
    test.skip("SKIPPED — this environment cannot spawn git/bun", () => {});
  } else {
    // Only ONE profile runs the FULL trailing gate chain here (including a
    // real `bun test`, which spawns a real `astro build` per storefront
    // build-smoke file — genuinely slow, minutes rather than seconds). The
    // other two profiles are checked at the plan/apply level (every
    // rewrite/removal this run makes, still for real, still against a real
    // temp copy) without paying that cost three times over in this unit
    // suite — the per-PROFILE full gate-chain proof (SITE_PROFILE=<p> bun
    // run build, then root bun test) is `.github/workflows/
    // template-init-smoke.yml`'s own job, matrixed, inside its own
    // 15-minute CI budget, which is the more appropriate place to pay this
    // cost three times over.
    const FULL_GATE_PROFILE = "toko";
    for (const profil of ["toko", "berita", "landing"]) {
      const runGates = profil === FULL_GATE_PROFILE;
      test(
        `--profil ${profil}: rewrites, removes, and resets` + (runGates ? " — and the copy's own gates pass" : ""),
        async () => {
          const dir = makeTempCopy();
          const flags = [
            "--nama",
            "Toko Contoh",
            "--slug",
            "toko-contoh",
            "--domain",
            "toko-contoh.id",
            "--profil",
            profil,
            "--warna-primer",
            "#0ea5e9",
            "--kontak-email",
            "owner@toko-contoh.id",
            "--yes"
          ];

          const exitCode = await main(flags, { root: dir, isTTY: false, skipInstall: true, skipGates: !runGates });
          expect(exitCode).toBe(0);

          const originPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
          const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
          expect(pkg.name).toBe("toko-contoh");
          expect(pkg.version).toBe("0.1.0");
          expect(pkg.awcmsOne.templateVersion).toBe(originPkg.version);

          // Only the actual VALUES this tool rewrites are asserted clean —
          // historical code COMMENTS in this file ("BjekMart's own emerald
          // brand colors", from issue #24) are prose, not data, and are out
          // of `template:init`'s scope by the same reasoning
          // `docs/template.md`'s "What 'no BjekMart string left' actually
          // means" section states for the whole tree.
          const siteTs = readFileSync(join(dir, "apps/storefront/src/config/site.ts"), "utf8");
          const identityDescription = {
            toko: "Belanja online hemat, mudah, dan terpercaya di Toko Contoh",
            berita: "Berita terpercaya dari Toko Contoh",
            landing: "Solusi tepercaya dari Toko Contoh"
          }[profil];
          expect(siteTs).toContain('name: "Toko Contoh"');
          expect(siteTs).toContain(`description: "${identityDescription}"`);
          expect(siteTs).toContain('contactEmail: "owner@toko-contoh.id"');
          expect(siteTs).toContain('primary: "#0ea5e9"');

          // Grep-style scan, scoped to the files where `template:init`
          // rewrites the ENTIRE brand-bearing surface with no legitimate
          // historical prose left beside it — NOT the whole tree, and not
          // even every D4-named file.
          //
          // **Deviation from the issue's own informal restatement, decided
          // here and stated plainly**: issue #138's description asks this
          // scan to cover the WHOLE tree, finding no BjekMart-specific
          // string anywhere outside `CHANGELOG.md`/`docs/adr/**`. ADR-0018
          // D4 — the actual, reviewed contract this branch was told to
          // implement "exactly" — instead names a SHORT, closed list of
          // files `template:init` rewrites, explicitly rejecting (D4's own
          // "Rejected" paragraph) the alternative of hunting the whole tree
          // for brand text with no closed list to check against. Within
          // that closed list itself, `apps/storefront/src/config/site.ts`,
          // `.env.example`, and `README*.md` all carry genuine HISTORICAL
          // prose alongside the values this tool rewrites (a code comment
          // explaining why `DEFAULT_THEME_COLORS` was originally BjekMart's
          // emerald palette, an env-var docblock for the seputarborneo
          // importer this run also removes, an increment-by-increment
          // narrative elsewhere in the README) — checked directly with
          // `toContain` assertions above instead, on the exact VALUES this
          // tool controls. `package.json`, `compose.yaml`, and
          // `SUPPORT*.md` have no such prose: every word in them is either
          // this tool's own rewritten output or was never BjekMart-specific
          // to begin with, so a full-file scan is the right check there.
          const scanTargets = ["package.json", "compose.yaml", "SUPPORT.md", "SUPPORT.id.md"];
          let scan = "";
          try {
            scan = execSync(
              `grep -lIE 'borneojek|BjekMart|seputarborneo|mart\\.borneojek' ${scanTargets.join(" ")}`,
              { cwd: dir, encoding: "utf8" }
            ).trim();
          } catch (error) {
            // grep exits 1 when it finds nothing at all — that IS the pass.
            if (error.status !== 1) throw error;
          }
          expect(scan).toBe("");

          for (const removed of [
            "tools/seed-borneojek-mart.ts",
            "tools/seed-data/contoh/borneojek-mart",
            "tools/import-seputarborneo.ts",
            "tests/import-seputarborneo.test.mjs",
            "graphify-out",
            "knowledge/generated"
          ]) {
            expect(existsSync(join(dir, removed))).toBe(false);
          }

          // #139's own neutral per-profile placeholder art must survive —
          // only the pre-existing BjekMart-specific files directly under
          // tools/seed-assets/ are removal targets (see removals.mjs).
          expect(existsSync(join(dir, "tools/seed-assets/profil"))).toBe(true);
          expect(existsSync(join(dir, "tools/seed-assets/product-bjekmikro.svg"))).toBe(false);

          // db:seed:cms now seeds the deployment's OWN chosen profile by
          // default, not BjekMart's reference example.
          const pkgAfter = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
          expect(pkgAfter.scripts["db:seed:cms"]).toBe(`bun tools/seed-cms.ts --profil ${profil}`);
          expect(pkgAfter.scripts["import:seputarborneo"]).toBeUndefined();

          const seedCmsTs = readFileSync(join(dir, "tools/seed-cms.ts"), "utf8");
          expect(seedCmsTs).toContain(`let profil = ${JSON.stringify(profil)};`);
        },
        90_000
      );
    }
  }
});

describe("template:init — idempotency", () => {
  if (!HAS_GIT || !HAS_BUN) {
    test.skip("SKIPPED — this environment cannot spawn git/bun", () => {});
  } else {
    test(
      "a second run with identical flags is a no-op; a third with a different flag rewrites only that",
      async () => {
        const dir = makeTempCopy();
        const flags = [...BASE_FLAGS, "--yes"];

        const first = await main(flags, { root: dir, isTTY: false, skipInstall: true, skipGates: true });
        expect(first).toBe(0);
        execSync("git add -A && git commit -q -m first --allow-empty", { cwd: dir });

        const planSecond = buildPlan({
          root: dir,
          flags: {
            nama: "Toko Contoh",
            slug: "toko-contoh",
            domain: "toko-contoh.id",
            profil: "toko",
            warnaPrimer: "#0ea5e9",
            warnaSekunder: "#096892",
            warnaAksen: "#f59e0b",
            kontakEmail: "owner@toko-contoh.id"
          },
          today: "2026-09-20",
          originSha: "deadbeef"
        });
        expect(isEmptyPlan(planSecond)).toBe(true);

        const second = await main(flags, { root: dir, isTTY: false, skipInstall: true, skipGates: true });
        expect(second).toBe(0);

        const third = await main(
          [
            "--nama",
            "Toko Baru",
            "--slug",
            "toko-contoh",
            "--domain",
            "toko-contoh.id",
            "--profil",
            "toko",
            "--warna-primer",
            "#0ea5e9",
            "--kontak-email",
            "owner@toko-contoh.id",
            "--yes"
          ],
          { root: dir, isTTY: false, skipInstall: true, skipGates: true }
        );
        expect(third).toBe(0);
        const siteTs = readFileSync(join(dir, "apps/storefront/src/config/site.ts"), "utf8");
        expect(siteTs).toContain('name: "Toko Baru"');

        // The one-time reset must NOT have run again: package.json's
        // version stays 0.1.0, not re-derived from a "current" version that
        // no longer exists once already 0.1.0.
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        expect(pkg.version).toBe("0.1.0");
      },
      30_000
    );
  }
});

describe("template:init — dirty working tree", () => {
  if (!HAS_GIT || !HAS_BUN) {
    test.skip("SKIPPED — this environment cannot spawn git/bun", () => {});
  } else {
    test("refuses without --yes, proceeds with --yes", async () => {
      const dir = makeTempCopy();
      writeFileSync(join(dir, "README.md"), `${readFileSync(join(dir, "README.md"), "utf8")}\n`);

      const refused = await main(BASE_FLAGS, { root: dir, isTTY: false, skipInstall: true, skipGates: true });
      expect(refused).toBe(3);

      const proceeded = await main([...BASE_FLAGS, "--yes"], { root: dir, isTTY: false, skipInstall: true, skipGates: true });
      expect(proceeded).toBe(0);
    }, 30_000);
  }
});
