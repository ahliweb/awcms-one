/**
 * tests/template-tanpa-starsender.test.mjs - issue #466 (acceptance item 1).
 *
 * The template must stay provider-neutral: a tenant's default WhatsApp provider
 * (StarSender or Meta) is DEPLOYMENT/PRODUCT configuration, never a default of
 * every derivation. StarSender is an unofficial gateway and is off unless an
 * operator turns it on AND a tenant acknowledges its risk. So:
 *
 *   1. In the template itself, no env example, compose file, shell script, Dockerfile or ops host file assigns
 *      `WHATSAPP_PROVIDER=starsender` or `WHATSAPP_STARSENDER_ENABLED=true`, and
 *      no provider key is committed.
 *   2. After `template:init` for EACH of the three profiles (in a throwaway copy),
 *      the same holds on the rewritten tree.
 *   3. None of the neutral seed profiles under `tools/seed-data/profil/**` names
 *      StarSender, a WhatsApp provider key or a real phone number or e-mail.
 *
 * Fixtures are never live traffic: nothing here reaches a network.
 */
import { afterEach, describe as bunDescribe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { gitRunOrThrow } from "../packages/gerbang/lib/git.mjs";
import { scanForPii } from "../tools/lib/seed-profil.mjs";
import { main } from "../tools/template-init/run.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PROFILES = ["toko", "berita", "landing"];

/**
 * Template-only, like tests/template-init.test.mjs: `template:init`'s own trailing
 * `bun test` runs this file inside the repository it has just initialised
 * (package name no longer "awcms-one"), where re-running `template:init` on a
 * copy would test a repository that is no longer the template.
 */
const PKG_NAME = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
).name;
const describe = PKG_NAME === "awcms-one" ? bunDescribe : bunDescribe.skip;

/** Assignments that would switch a derivation onto StarSender (commented-out `# NAME=...` lines are documentation, not configuration). */
const FORBIDDEN_ASSIGNMENTS = [
  /^\s*(?:-\s*)?(?:export\s+)?WHATSAPP_PROVIDER\s*[=:]\s*["']?(?:\$\{[A-Z0-9_]+:?-)?starsender/im,
  /^\s*(?:-\s*)?(?:export\s+)?WHATSAPP_STARSENDER_ENABLED\s*[=:]\s*["']?(?:\$\{[A-Z0-9_]+:?-)?true/im,
  /^\s*(?:-\s*)?(?:export\s+)?COMMERCE_WHATSAPP_PROVIDER\s*[=:]\s*["']?(?:\$\{[A-Z0-9_]+:?-)?starsender/im,
];

/** A provider key or token with a value: `NAME=<non-empty>` for any WhatsApp provider secret. */
const PROVIDER_KEY_ASSIGNMENT =
  /^\s*(?:-\s*)?(?:export\s+)?((?:WHATSAPP|COMMERCE_WHATSAPP|COMMERCE_FONNTE|COMMERCE_META_WA|STARSENDER|FONNTE)[A-Z0-9_]*(?:TOKEN|API_KEY|DEVICE_KEY|SECRET)[A-Z0-9_]*)\s*[=:]\s*["']?(?:\$\{[A-Z0-9_]+:?-)?([^\s"'#}]+)/gim;

const ENV_LIKE = /(^|\/)(\.env(\.[a-z]+)?|compose(\.[a-z]+)?\.ya?ml)$/;

function listFiles(root) {
  return gitRunOrThrow(
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  )
    .split("\n")
    .filter(Boolean)
    .filter((file) => existsSync(join(root, file)));
}

/** Shell scripts, Dockerfiles and ops host files assign environment too; tests and this file only mention the names. */
const SCRIPT_LIKE =
  /(^|\/)(Dockerfile[^/]*|[^/]+\.sh|ops\/[^/]+\.(?:env[^/]*|service|timer|cron[^/]*))$/;

function configFiles(root) {
  return listFiles(root).filter(
    (file) =>
      ENV_LIKE.test(file) ||
      file.endsWith(".env.example") ||
      SCRIPT_LIKE.test(file),
  );
}

/** @returns {string[]} human-readable violations in the given config files */
function scanConfig(root, files) {
  const violations = [];

  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");

    for (const pattern of FORBIDDEN_ASSIGNMENTS) {
      if (pattern.test(text)) violations.push(`${file}: ${pattern}`);
    }

    for (const match of text.matchAll(PROVIDER_KEY_ASSIGNMENT)) {
      // Plain `${VAR}` / `$VAR` interpolation (no default) and `changeme`-style placeholders carry no key.
      // A `${VAR:-default}` default IS a value and is checked like any other (the regex captured it).
      if (
        /^\$\{?[A-Z_]+/.test(match[2]) ||
        /^(changeme|change-me|replace-me|your-|<)/i.test(match[2])
      )
        continue;
      violations.push(`${file}: ${match[1]} carries a value`);
    }
  }

  return violations;
}

describe("the template itself ships no StarSender default and no provider key", () => {
  const files = configFiles(REPO_ROOT);

  test("the scan covers the root env example, apps/cms's env example and both compose files", () => {
    for (const expected of [
      ".env.example",
      "apps/cms/.env.example",
      "compose.yaml",
      "compose.production.yaml",
    ]) {
      expect(files).toContain(expected);
    }
  });

  test("no env example or compose file selects StarSender or carries a provider key", () => {
    expect(scanConfig(REPO_ROOT, files)).toEqual([]);
  });

  test("apps/cms's env example documents the StarSender switch as OFF", () => {
    const text = readFileSync(join(REPO_ROOT, "apps/cms/.env.example"), "utf8");

    expect(text).toMatch(/^# WHATSAPP_STARSENDER_ENABLED=false$/m);
  });
});

describe("the neutral seed profiles name no provider, no real number and no real address", () => {
  const seedRoot = join(REPO_ROOT, "tools/seed-data/profil");

  function jsonFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);

      return statSync(path).isDirectory()
        ? jsonFiles(path)
        : name.endsWith(".json")
          ? [path]
          : [];
    });
  }

  for (const profile of PROFILES) {
    test(`${profile}: no StarSender, provider key, real phone number or real e-mail`, () => {
      const files = jsonFiles(join(seedRoot, profile));

      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const text = readFileSync(file, "utf8");
        const where = relative(REPO_ROOT, file);

        expect(
          /starsender|fonnte|WHATSAPP_PROVIDER|device[_-]?key/i.test(text),
          `${where} names a provider`,
        ).toBe(false);
        expect(
          scanForPii(text),
          `${where} carries a real phone number or e-mail`,
        ).toEqual({ emails: [], phones: [] });
      }
    });
  }
});

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length)
    rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function canSpawn(cmd) {
  try {
    return Bun.spawnSync([cmd, "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

function makeTempCopy() {
  const dir = mkdtempSync(join(tmpdir(), "template-starsender-test-"));
  tempDirs.push(dir);

  for (const file of listFiles(REPO_ROOT)) {
    const dest = join(dir, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(REPO_ROOT, file), dest);
  }

  for (const rel of [
    "node_modules",
    "apps/storefront/node_modules",
    "apps/cms/node_modules",
    "packages/kontrak/node_modules",
  ]) {
    const src = join(REPO_ROOT, rel);

    if (existsSync(src)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      symlinkSync(src, join(dir, rel), "dir");
    }
  }

  gitRunOrThrow(dir, "init", "-q");
  gitRunOrThrow(dir, "config", "user.email", "test@example.com");
  gitRunOrThrow(dir, "config", "user.name", "template-starsender test");
  gitRunOrThrow(dir, "add", "-A");
  gitRunOrThrow(dir, "commit", "-q", "-m", "initial");

  return dir;
}

describe("template:init leaves every profile provider-neutral", () => {
  if (!canSpawn("git") || !canSpawn("bun")) {
    test.skip("SKIPPED - this environment cannot spawn git/bun", () => {});
  } else {
    for (const profil of PROFILES) {
      test(`--profil ${profil}: the rewritten tree selects no StarSender and ships no provider key`, async () => {
        const dir = makeTempCopy();
        const exitCode = await main(
          [
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
            "--yes",
          ],
          {
            root: dir,
            isTTY: false,
            skipInstall: true,
            skipGates: true,
            testScope: "root",
          },
        );

        expect(exitCode).toBe(0);

        const files = configFiles(dir);

        expect(files).toContain(".env.example");
        expect(scanConfig(dir, files)).toEqual([]);

        // The brand surface it rewrites carries no phone number it did not get from a flag.
        const siteTs = readFileSync(
          join(dir, "apps/storefront/src/config/site.ts"),
          "utf8",
        );

        expect(siteTs).toContain("contactPhone: null,");
        expect(siteTs.toLowerCase()).not.toContain("starsender");

        // Broad scan: no rewritten config file or neutral seed file carries a phone number.
        for (const file of [
          ...configFiles(dir),
          ...listFiles(dir).filter((f) =>
            f.startsWith("tools/seed-data/profil/"),
          ),
        ]) {
          expect(
            scanForPii(readFileSync(join(dir, file), "utf8")).phones,
            `${file} carries a phone number after init`,
          ).toEqual([]);
        }
      }, 120000);
    }
  }
});
