#!/usr/bin/env bun
/**
 * deploy-preflight.mjs — `bun run deploy:preflight` (issue #150).
 *
 * ## What this checks, and what it delegates
 *
 * This is the ROOT half of the production preflight — workspace-agnostic,
 * exactly like every other root-owned gate (see AGENTS.md's "Workspace
 * boundaries"). It checks the shape of `apps/storefront`'s own BUILD env —
 * `SITE_PROFILE`, the public origins, and that `AWCMS_API_TOKEN` (a
 * build-time-only, read-only credential; see ADR-0002/ADR-0007 and the
 * `awcms-one-storefront` skill) never leaks into a `PUBLIC_*` variable or,
 * with `--dist`, into a built `apps/storefront/dist/` artefact.
 *
 * It does NOT re-implement `apps/cms`'s own production checks (DB role, RLS,
 * providers, migrations) — it spawns `bun run commerce:deploy:preflight`
 * inside `apps/cms` (argv array, never a shell string — this repo's own
 * `tests/standar-skrip.test.mjs` enforces exactly that discipline for every
 * root script that reaches git or a subprocess) and folds its exit code in.
 *
 * Usage:
 *   bun run deploy:preflight [--file <path>] [--live] [--production] [--dist]
 *
 *   --file <path>   Read env from this file instead of process.env (passed
 *                    through to apps/cms's own preflight unchanged).
 *   --live          Ask apps/cms's preflight to connect to DATABASE_URL and
 *                    verify RLS/role/migration-ledger facts for real.
 *   --production    Apply the production ruleset even if SITE_PROFILE/
 *                    APP_ENV do not themselves say "production" — useful to
 *                    dry-run a file before it is copied into place.
 *   --dist          Additionally scan a built apps/storefront/dist/ for the
 *                    literal value of AWCMS_API_TOKEN.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReporter } from "../packages/gerbang/lib/reporter.mjs";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

function parseArgs(argv) {
  const fileIndex = argv.indexOf("--file");
  return {
    file: fileIndex >= 0 ? argv[fileIndex + 1] : undefined,
    live: argv.includes("--live"),
    production: argv.includes("--production"),
    dist: argv.includes("--dist")
  };
}

/** Same `KEY=value` shape apps/cms's own env-file readers use. */
function parseEnvFile(source) {
  /** @type {Record<string, string>} */
  const bag = {};
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    bag[key] = value;
  }
  return bag;
}

async function loadEnv(file) {
  if (!file) return { ...process.env };
  const source = await readFile(file, "utf8");
  return parseEnvFile(source);
}

export function isHttpsUrl(value) {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** A crude but useful "this looks like a real secret, not a label" heuristic — long, high-entropy-looking strings only. Never used to REJECT a value silently; only to flag a `PUBLIC_*` variable that should not hold one. */
export function looksLikeToken(value) {
  if (!value || value.length < 20) return false;
  return /^[A-Za-z0-9_\-.]+$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

const VALID_PROFILES = ["toko", "berita", "landing"];

export function checkStorefrontEnvShape(env, production, report) {
  const profile = env.SITE_PROFILE;
  if (!profile) {
    report.note(`SITE_PROFILE is not set (checks below assume "toko" is the eventual default).`);
  } else if (!VALID_PROFILES.includes(profile)) {
    report.violation(
      "storefront-env",
      "SITE_PROFILE",
      `"${profile}" is not one of ${VALID_PROFILES.join("/")}.`
    );
  } else {
    report.note(`SITE_PROFILE=${profile} — valid.`);
  }

  for (const name of ["SITE_URL", "PUBLIC_AWCMS_ORIGIN"]) {
    const value = env[name];
    if (production) {
      if (!isHttpsUrl(value)) {
        report.violation(
          "storefront-env",
          name,
          `must be a valid https:// URL in production (got ${value ? `"${value}"` : "unset"}).`
        );
      } else {
        report.note(`${name} is a valid https URL.`);
      }
    } else if (value && !isHttpsUrl(value)) {
      report.note(`${name}="${value}" is not https — allowed outside production.`);
    }
  }

  const apiUrl = env.AWCMS_API_URL;
  if (apiUrl) {
    if (production && !isHttpsUrl(apiUrl)) {
      report.violation("storefront-env", "AWCMS_API_URL", `must be https in production (got "${apiUrl}").`);
    } else {
      report.note(`AWCMS_API_URL="${apiUrl}" present.`);
    }
  } else if (production) {
    report.violation("storefront-env", "AWCMS_API_URL", "must be set in production.");
  }

  const apiToken = env.AWCMS_API_TOKEN;
  if (!apiToken) {
    if (production) {
      report.violation("storefront-env", "AWCMS_API_TOKEN", "must be set in production (build-time only, never PUBLIC_*).");
    } else {
      report.note("AWCMS_API_TOKEN is not set — fine outside a real build.");
    }
  } else if (apiToken.startsWith("PUBLIC_")) {
    report.violation(
      "storefront-env",
      "AWCMS_API_TOKEN",
      "value itself begins with \"PUBLIC_\" — looks like a misassigned public variable name, not a token."
    );
  } else {
    report.note("AWCMS_API_TOKEN present and not PUBLIC_-prefixed.");
  }

  // No PUBLIC_* variable's VALUE looks like a token — a PUBLIC_ variable is
  // bundled into the built, browser-served artefact by Astro's own
  // convention, so a token-shaped value there is a leak by construction,
  // independent of which specific variable it is.
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("PUBLIC_")) continue;
    if (key === "PUBLIC_GA_ID") continue; // a GA4 measurement id is meant to be public and short; skip explicitly rather than let it coincidentally match.
    if (looksLikeToken(value)) {
      report.violation(
        "storefront-env",
        key,
        `is a PUBLIC_* variable whose value looks like a credential/token (${value.length} chars, alnum+separators) — PUBLIC_* is bundled into the browser-served build.`
      );
    }
  }
}

async function checkDistForToken(env, distDir, report) {
  const token = env.AWCMS_API_TOKEN;
  if (!token) {
    report.note("--dist given but AWCMS_API_TOKEN is not set — nothing to search for, skipping.");
    return;
  }

  let entries;
  try {
    entries = await collectFiles(distDir);
  } catch (error) {
    report.violation("storefront-dist", distDir, `could not be read: ${error.message}`);
    return;
  }

  let scanned = 0;
  for (const filePath of entries) {
    let content;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue; // binary/unreadable file — the token is a plain string, so a file this can't decode as utf8 cannot contain it as text either.
    }
    scanned += 1;
    if (content.includes(token)) {
      report.violation(
        "storefront-dist",
        filePath.slice(distDir.length + 1),
        "contains the literal AWCMS_API_TOKEN value — the build-time credential leaked into the served artefact."
      );
    }
  }

  report.note(`--dist: scanned ${scanned} file(s) under ${distDir} for the AWCMS_API_TOKEN value.`);
}

async function collectFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Spawns `bun run commerce:deploy:preflight` inside apps/cms — argv array, never a shell string. */
function runCmsPreflight(args, report) {
  const cmsArgs = [];
  if (args.file) cmsArgs.push("--file", args.file);
  if (args.live) cmsArgs.push("--live");
  if (args.production) cmsArgs.push("--production");

  const result = Bun.spawnSync(["bun", "run", "commerce:deploy:preflight", ...cmsArgs], {
    cwd: join(REPO_ROOT, "apps/cms"),
    stdout: "pipe",
    stderr: "pipe"
  });

  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();

  if (stdout) for (const line of stdout.split("\n")) report.note(`[apps/cms] ${line}`);
  if (stderr) for (const line of stderr.split("\n")) report.note(`[apps/cms:stderr] ${line}`);

  if (result.exitCode !== 0) {
    report.violation(
      "cms-preflight",
      "apps/cms",
      `bun run commerce:deploy:preflight exited ${result.exitCode} — see the [apps/cms] lines above.`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv(args.file);
  const production = args.production || env.APP_ENV === "production";

  const report = createReporter("deploy:preflight");
  report.note(`env source: ${args.file ? args.file : "process.env"}; production ruleset: ${production ? "yes" : "no"}.`);

  checkStorefrontEnvShape(env, production, report);

  if (args.dist) {
    await checkDistForToken(env, join(REPO_ROOT, "apps/storefront/dist"), report);
  }

  runCmsPreflight(args, report);

  report.finish();
}

if (import.meta.main) {
  await main();
}
