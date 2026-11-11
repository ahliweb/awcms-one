/**
 * Package scripts, workspace entrypoints, the storefront build and the queue
 * workers start Bun and nothing else (issue #469, ADR-0002 Bun-only). The
 * sibling of `tests/bun-only-deployment-manifests.test.mjs`, which covers the
 * deployment manifests (compose, Dockerfiles, `ops/`); both share the pure
 * scanners in `tests/support/bun-only-scan.mjs`. `apps/cms` is upstream's tree
 * and has its own gate, `apps/cms/tests/bun-only-launch-manifests.test.ts`:
 * this file only READS `apps/cms` where this repo's deployment points at it,
 * and never edits it.
 *
 * ## What is enforced
 *
 * 1. **Package scripts** of the root, `apps/storefront` (never `apps/cms`) and
 *    every `packages/*` start Bun: each command is `bun ...`, `cd`, `bash
 *    <file>` or `docker ...`; a bare package bin only runs through
 *    `bun --bun <bin>` (without `--bun`, Bun honours the bin's node shebang);
 *    `bun run <name>` names a script that exists; a file a script runs exists
 *    and has no Node shebang. Workspace manifests carry no `bin` with a Node
 *    shebang and no `engines.node` / `volta` runtime selector.
 * 2. **Storefront, all three `SITE_PROFILE` values**: the profile list is read
 *    from `apps/storefront/src/config/profil.ts`; `build`, `check`, `serve`,
 *    `preview` and `start` resolve to Bun commands, the server bundle is built
 *    `--target=bun`, `apps/storefront/Dockerfile` runs every stage on the
 *    pinned `oven/bun` image (its `ARG BUN_VERSION` default equals the root
 *    `packageManager` pin), builds with `bun run build` under `SITE_PROFILE`,
 *    and starts the very command the `serve` script names. The profile builds
 *    local CI and the e2e harness spawn (`tools/ci`, `tests/e2e`) are Bun.
 * 3. **Queue workers as this repo deploys them** (WhatsApp, Mailketing e-mail,
 *    Web Push, and the commerce, Telegram and domain-event dispatchers): each
 *    target is a single `bun scripts/<file>` script in `apps/cms/package.json`
 *    whose file exists with no Node shebang, is scheduled by the generated
 *    `apps/cms/ops/awcms-jobs.crontab` through `$AWCMS_RUN_JOB`, and is routed
 *    by `ops/run-job-compose.sh` to a compose service that builds the `jobs`
 *    stage of `apps/cms/Dockerfile.production`, which descends from the pinned
 *    `oven/bun` image. The wrapper's own last line launches `bun run "$JOB"`.
 * 4. **Every other JS/TS tool** under `tools/` and the storefront's `scripts/`,
 *    `server/`, `integrations/`, `tests/e2e/` and Playwright config has no
 *    Node shebang and no quoted Node-launcher literal; `*.service` units under
 *    `tools/` launch through `bun`.
 *
 * ## What is deliberately allowed (the false-positive guard)
 *
 * `node:*` built-in imports, `@astrojs/node` (the adapter Bun hosts),
 * `NODE_ENV`, `node_modules` paths, and comments or prose that merely mention
 * Node. Whole-token matching only, the same vocabulary as the sibling gate.
 *
 * ## What cannot be proved here
 *
 * No image is built and no container is started. What produces each process is
 * proved statically; that the running container really holds that Bun is the
 * opt-in `bun run deploy:smoke-bun` (tools/deploy/smoke-bun-runtime.sh), whose
 * logic `tests/deploy-smoke-bun-runtime.test.mjs` drives against a stub docker.
 * Running it against the built or pulled images is an operator step
 * (docs/pengujian.md).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dockerInstructions,
  dockerStageChain,
  isPinnedTag,
  spawnLiteralViolations,
  launcherIn,
  launcherViolations,
  packageScriptViolations,
  pinViolations,
  shebangViolations,
  tokensOf
} from "./support/bun-only-scan.mjs";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");
const exists = (rel) => existsSync(join(REPO_ROOT, rel));
const readJson = (rel) => JSON.parse(read(rel));

const rootPackage = readJson("package.json");
/** The exact Bun version this repo pins, read from `packageManager`. */
const PIN = /^bun@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(rootPackage.packageManager ?? "")?.[1] ?? "";

function formatViolations(violations) {
  return violations.map((v) => `${v.file}${v.line ? `:${v.line}` : ""} [${v.rule}] ${v.detail}`).join("\n");
}

/** First line of a file when it is a `#!` line, else null. Reads at most one file. */
function shebangOf(rel) {
  const text = read(rel);
  return text.startsWith("#!") ? text.split("\n", 1)[0] : null;
}

/** The scripts of the package at `dir` (repo-relative), or null. */
function scriptsOf(dir) {
  const rel = posix.join(dir, "package.json");
  return exists(rel) ? (readJson(rel).scripts ?? {}) : null;
}

const SCRIPT_CONTEXT = { scriptsOf, exists, shebangOf };

// ---------------------------------------------------------------------------
// Workspace discovery: root + apps/* (not apps/cms) + packages/*
// ---------------------------------------------------------------------------

/** `apps/cms` is upstream's own tree and has its own launch-manifest gate. */
const UPSTREAM_OWNED = "apps/cms";

function workspaceDirs() {
  const dirs = [""];
  for (const pattern of rootPackage.workspaces ?? []) {
    const parent = pattern.replace(/\/\*$/, "");
    for (const name of readdirSync(join(REPO_ROOT, parent))) {
      const dir = `${parent}/${name}`;
      if (dir === UPSTREAM_OWNED) continue;
      if (statSync(join(REPO_ROOT, dir)).isDirectory() && exists(`${dir}/package.json`)) dirs.push(dir);
    }
  }
  return dirs.sort();
}

const WORKSPACES = workspaceDirs();
const manifestPath = (dir) => (dir === "" ? "package.json" : `${dir}/package.json`);

// ---------------------------------------------------------------------------
// 1. Package scripts and workspace entrypoints
// ---------------------------------------------------------------------------

describe("package scripts and workspace entrypoints start Bun", () => {
  test("the Bun pin is read from package.json, not hard-coded", () => {
    expect(PIN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("discovery finds the root, the storefront and every package, and never apps/cms", () => {
    expect(WORKSPACES).toContain("");
    expect(WORKSPACES).toContain("apps/storefront");
    expect(WORKSPACES).toContain("packages/gerbang");
    expect(WORKSPACES).toContain("packages/kontrak");
    expect(WORKSPACES).not.toContain(UPSTREAM_OWNED);
  });

  for (const dir of WORKSPACES) {
    const file = manifestPath(dir);
    test(`${file} scripts`, () => {
      const scripts = readJson(file).scripts ?? {};
      expect(formatViolations(packageScriptViolations(file, dir, scripts, SCRIPT_CONTEXT))).toBe("");
    });

    test(`${file} selects no Node runtime and ships no Node bin`, () => {
      const manifest = readJson(file);
      expect(manifest.volta, `${file} pins a Node toolchain through volta`).toBeUndefined();
      expect(manifest.engines?.node, `${file} declares engines.node`).toBeUndefined();
      const bins = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
      for (const bin of bins) {
        const path = posix.join(dir, bin);
        expect(exists(path), `${file} bin ${bin} does not exist`).toBe(true);
        expect(formatViolations(shebangViolations(path, read(path)))).toBe("");
      }
    });
  }

  test("the root delegates to the storefront with cd and bun run, never a second launcher", () => {
    expect(rootPackage.scripts.build).toBe("cd apps/storefront && bun run build");
    expect(rootPackage.scripts.dev).toBe("cd apps/storefront && bun run dev");
    expect(rootPackage.scripts.serve).toBe("cd apps/storefront && bun run serve");
  });
});

// ---------------------------------------------------------------------------
// 2. The storefront, in all three build profiles
// ---------------------------------------------------------------------------

const STOREFRONT = "apps/storefront";
const storefrontScripts = readJson(`${STOREFRONT}/package.json`).scripts;

/** `export const SITE_PROFILES = ["toko", "berita", "landing"] as const;` */
const PROFILES = [...(/SITE_PROFILES\s*=\s*\[([^\]]*)\]/.exec(read(`${STOREFRONT}/src/config/profil.ts`))?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map(
  (match) => match[1]
);

describe("the storefront builds and serves on Bun in every profile", () => {
  test("the three profiles are the ones this gate is written for", () => {
    expect(PROFILES).toEqual(["toko", "berita", "landing"]);
  });

  test("build, check, serve, preview and start are Bun commands", () => {
    for (const name of ["build", "check", "serve", "preview", "start", "dev"]) {
      expect(storefrontScripts[name], `${STOREFRONT} has no ${name} script`).toBeDefined();
    }
    expect(storefrontScripts.build).toContain("bun --bun astro build");
    expect(storefrontScripts.check).toBe("bun --bun astro check");
    expect(storefrontScripts.serve).toBe("bun dist/server/penyaji.mjs");
    expect(storefrontScripts.preview).toBe("bun run serve");
    expect(storefrontScripts.start).toBe("bun run serve");
  });

  test("the production server bundle is built for Bun, not for Node", () => {
    expect(storefrontScripts["build:penyaji"]).toContain("bun build server/penyaji.mjs");
    expect(storefrontScripts["build:penyaji"]).toContain("--target=bun");
  });

  test("no storefront server or build script starts a Node process", () => {
    for (const rel of ["server/penyaji.mjs", "server/pengalihan-aturan.mjs", "astro.config.mjs", "integrations/profil.mjs"]) {
      const path = `${STOREFRONT}/${rel}`;
      expect(formatViolations([...shebangViolations(path, read(path)), ...spawnLiteralViolations(path, read(path))])).toBe("");
    }
  });

  describe("apps/storefront/Dockerfile", () => {
    const DOCKERFILE = `${STOREFRONT}/Dockerfile`;
    const text = read(DOCKERFILE);
    const instructions = dockerInstructions(text);
    const froms = instructions.filter((instruction) => instruction.keyword === "FROM");

    test("ARG BUN_VERSION defaults to the root packageManager pin", () => {
      const arg = /^ARG\s+BUN_VERSION=(\S+)/m.exec(text.replace(/^\s*#.*$/gm, ""));
      expect(arg?.[1], "no ARG BUN_VERSION default").toBeDefined();
      expect(arg[1]).toBe(PIN);
    });

    test("every stage, not only the last, starts from the pinned oven/bun image", () => {
      expect(froms.length).toBeGreaterThanOrEqual(3);
      for (const from of froms) {
        const [, alias] = /\bAS\s+(\S+)/i.exec(from.args) ?? [];
        expect(alias, `FROM ${from.args} has no stage name`).toBeDefined();
        // A stage built FROM another stage is judged by the external image it ends at.
        const external = dockerStageChain(text, alias).at(-1);
        expect(external.startsWith("oven/bun:"), `stage ${alias} descends from ${external}`).toBe(true);
        expect(isPinnedTag(external.slice("oven/bun:".length), PIN), `stage ${alias} descends from ${external}`).toBe(true);
      }
      expect(formatViolations(pinViolations(DOCKERFILE, text, PIN))).toBe("");
    });

    test("the build stage runs bun run build under the SITE_PROFILE build argument", () => {
      expect(text).toMatch(/^ARG SITE_PROFILE=toko$/m);
      const build = instructions.find((instruction) => instruction.keyword === "RUN" && instruction.args.includes("bun run build"));
      expect(build, "no RUN ... bun run build").toBeDefined();
      expect(build.args).toContain('SITE_PROFILE="${SITE_PROFILE}"');
      // Every command word of every RUN is bun or plain shell plumbing; no launcher.
      expect(formatViolations(launcherViolations(DOCKERFILE, text))).toBe("");
    });

    test("the image starts, and is health-checked by, the command the serve script names", () => {
      const serve = storefrontScripts.serve; // bun dist/server/penyaji.mjs
      const cmd = instructions.filter((instruction) => instruction.keyword === "CMD").at(-1);
      expect(cmd, "no CMD").toBeDefined();
      expect(JSON.parse(cmd.args).join(" ")).toBe(serve);
      const health = instructions.find((instruction) => instruction.keyword === "HEALTHCHECK");
      expect(health?.args).toMatch(/CMD bun -e /);
    });

    test("the final stage drops root", () => {
      const last = instructions.slice(instructions.lastIndexOf(froms.at(-1)));
      expect(last.some((instruction) => instruction.keyword === "USER" && instruction.args === "bun")).toBe(true);
    });
  });

  describe("the harnesses that build each profile spawn Bun", () => {
    test("the e2e build-and-serve helper builds and serves with bun", () => {
      const rel = `${STOREFRONT}/tests/e2e/build-and-serve.ts`;
      const text = read(rel);
      expect(text).toContain('["bun", "--bun", "astro", "build"]');
      expect(text).toContain('["bun", "scripts/write-build-id.mjs"]');
      expect(text).toContain('["bun", "dist/server/penyaji.mjs"]');
      expect(formatViolations(spawnLiteralViolations(rel, text))).toBe("");
    });

    test("every local-ci runner that builds, tests or serves a profile uses bun", () => {
      for (const name of readdirSync(join(REPO_ROOT, "tools/ci/runners")).filter((file) => file.endsWith(".ts"))) {
        const rel = `tools/ci/runners/${name}`;
        expect(formatViolations(spawnLiteralViolations(rel, read(rel))), rel).toBe("");
      }
      const legs = read("tools/ci/legs.ts");
      for (const profile of PROFILES) {
        for (const leg of ["check", "e2e", "template"]) {
          expect(legs, `no local-ci/${leg}-${profile} leg`).toContain(`local-ci/${leg}-${profile}`);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The queue workers as this repository deploys them
// ---------------------------------------------------------------------------

/**
 * WhatsApp (upstream queue and the commerce dispatcher), Mailketing e-mail,
 * Web Push (upstream queue and the customer-push dispatcher), plus the
 * Telegram and domain-event dispatchers they sit beside. Add a target here when
 * a new delivery worker is deployed: removing one from `apps/cms` then fails
 * instead of passing silently.
 */
const WORKER_TARGETS = [
  "whatsapp:dispatch",
  "commerce:whatsapp:dispatch",
  "commerce:campaigns:dispatch",
  "email:dispatch",
  "push:dispatch",
  "commerce:customer-push:dispatch",
  "telegram:dispatch",
  "domain-events:dispatch"
];

const CMS_SCRIPTS = readJson("apps/cms/package.json").scripts;
const CRONTAB = read("apps/cms/ops/awcms-jobs.crontab");
const CRON_TARGETS = new Set(
  [...CRONTAB.matchAll(/^[^#\n].*\$AWCMS_RUN_JOB\s+(\S+)/gm)].map((match) => match[1])
);
const COMPOSE = Bun.YAML.parse(read("compose.production.yaml")).services;
const CMS_DOCKERFILE = read("apps/cms/Dockerfile.production");
const RUN_JOB_COMPOSE = "ops/run-job-compose.sh";

describe("the queue workers launch through Bun, as this repo deploys them", () => {
  for (const target of WORKER_TARGETS) {
    describe(target, () => {
      const script = CMS_SCRIPTS[target];

      test("is one `bun scripts/<file>` command whose entry file exists and is not a Node shebang", () => {
        expect(script, `apps/cms/package.json has no ${target} script`).toBeDefined();
        expect(script).toMatch(/^bun scripts\/[a-z0-9-]+\.ts$/);
        const entry = `apps/cms/${script.slice("bun ".length)}`;
        expect(exists(entry), `${entry} does not exist`).toBe(true);
        expect(formatViolations([...shebangViolations(entry, read(entry)), ...spawnLiteralViolations(entry, read(entry))])).toBe("");
        expect(formatViolations(packageScriptViolations("apps/cms/package.json", "apps/cms", { [target]: script }, SCRIPT_CONTEXT))).toBe("");
      });

      test("is scheduled by the generated crontab through $AWCMS_RUN_JOB", () => {
        expect(CRON_TARGETS.has(target), `apps/cms/ops/awcms-jobs.crontab does not schedule ${target}`).toBe(true);
      });

      test("is routed by ops/run-job-compose.sh to a compose service that exists", () => {
        const result = Bun.spawnSync(["bash", join(REPO_ROOT, RUN_JOB_COMPOSE), target], {
          env: { PATH: process.env.PATH, HOME: process.env.HOME, AWCMS_RUN_JOB_PRINT_SERVICE: "1" },
          stdout: "pipe",
          stderr: "pipe"
        });
        const service = result.stdout.toString().trim();
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(["jobs", "jobs-app"]).toContain(service);
        expect(COMPOSE[service], `compose.production.yaml has no ${service} service`).toBeDefined();
      });
    });
  }

  test("the compose job services build the jobs stage of the upstream Dockerfile, on the pinned Bun image", () => {
    const chain = dockerStageChain(CMS_DOCKERFILE, "jobs");
    expect(chain, "apps/cms/Dockerfile.production has no `jobs` stage").not.toBeNull();
    const external = chain.at(-1);
    expect(external.startsWith("oven/bun:"), `the jobs stage descends from ${external}, not oven/bun`).toBe(true);
    expect(isPinnedTag(external.slice("oven/bun:".length), PIN), `${external} is not Bun ${PIN}`).toBe(true);

    for (const name of ["jobs", "jobs-app", "migrate"]) {
      const service = COMPOSE[name];
      expect(service, `compose.production.yaml has no ${name} service`).toBeDefined();
      expect(service.build?.context).toBe("apps/cms");
      expect(service.build?.dockerfile).toBe("Dockerfile.production");
      expect(service.build?.target).toBe("jobs");
    }
  });

  test("a compose job service sets no command of its own, or one that starts with bun", () => {
    for (const name of ["jobs", "jobs-app", "migrate"]) {
      const command = COMPOSE[name].command;
      if (command === undefined) continue;
      expect(Array.isArray(command) ? command[0] : String(command).split(/\s+/)[0], `${name} command`).toBe("bun");
    }
    expect(COMPOSE.migrate.command).toEqual(["bun", "run", "db:migrate"]);
  });

  test("ops/run-job-compose.sh launches the target as `bun run \"$JOB\"` inside the container", () => {
    const text = read(RUN_JOB_COMPOSE);
    const exec = text.split("\n").find((line) => /^exec docker compose\b/.test(line));
    expect(exec, "no `exec docker compose` line").toBeDefined();
    const words = exec.trim().split(/\s+/);
    const afterService = words.slice(words.lastIndexOf('"$SERVICE"') + 1);
    expect(afterService.slice(0, 3)).toEqual(["bun", "run", '"$JOB"']);
    expect(formatViolations(launcherViolations(RUN_JOB_COMPOSE, text, { skipProse: true }))).toBe("");
  });

  test("the crontab and the compose wrapper schedule no Node launcher on a worker line", () => {
    const workerLines = CRONTAB.split("\n").filter((line) => !line.startsWith("#") && WORKER_TARGETS.some((target) => line.includes(` ${target} `)));
    expect(workerLines.length).toBeGreaterThanOrEqual(WORKER_TARGETS.length);
    expect(formatViolations(launcherViolations("apps/cms/ops/awcms-jobs.crontab", workerLines.join("\n")))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 4. Every other JS/TS tool and unit file
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "dist", ".astro", "seed-data", "seed-assets", "fixtures", "var"]);

function walk(rel, test, out = []) {
  for (const name of readdirSync(join(REPO_ROOT, rel))) {
    if (SKIP_DIRS.has(name)) continue;
    const child = `${rel}/${name}`;
    if (statSync(join(REPO_ROOT, child)).isDirectory()) walk(child, test, out);
    else if (test(child)) out.push(child);
  }
  return out;
}

const JS_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TOOL_SOURCES = [
  ...walk("tools", (file) => JS_SOURCE.test(file)),
  ...["scripts", "server", "integrations", "tests/e2e"].flatMap((dir) => walk(`${STOREFRONT}/${dir}`, (file) => JS_SOURCE.test(file))),
  `${STOREFRONT}/playwright.config.ts`,
  `${STOREFRONT}/astro.config.mjs`
].sort();
const UNIT_FILES = walk("tools", (file) => /\.service$/.test(basename(file))).sort();

describe("every other tool and unit file starts Bun", () => {
  test("discovery is not vacuous", () => {
    expect(TOOL_SOURCES.length).toBeGreaterThan(20);
    expect(TOOL_SOURCES).toContain("tools/ci/runners/check.ts");
    expect(TOOL_SOURCES).toContain(`${STOREFRONT}/server/penyaji.mjs`);
    expect(UNIT_FILES).toContain("tools/ci/systemd/awcms-one-ci-watch.service");
  });

  test("no tool has a Node shebang or a quoted Node-launcher literal", () => {
    const violations = TOOL_SOURCES.flatMap((file) => {
      const text = read(file);
      return [...shebangViolations(file, text), ...spawnLiteralViolations(file, text)];
    });
    expect(formatViolations(violations)).toBe("");
  });

  for (const file of UNIT_FILES) {
    test(`${file} launches through bun`, () => {
      const text = read(file);
      expect(formatViolations(launcherViolations(file, text))).toBe("");
      const execStart = [...text.matchAll(/^ExecStart=(.*)$/gm)].map((match) => match[1]);
      expect(execStart.length).toBeGreaterThan(0);
      for (const line of execStart) {
        const words = line.trim().split(/\s+/).filter((word) => !word.startsWith("-"));
        const launch = words[0].endsWith("/env") ? words[1] : words[0];
        expect(launch.endsWith("bun"), `ExecStart=${line}`).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// The scanners: positives are caught, false positives are not
// ---------------------------------------------------------------------------

describe("the package-script scanner itself", () => {
  const files = new Set(["tools/x.mjs", "run.sh", "apps/storefront/server/s.mjs"]);
  const shebangs = { "tools/node-tool.mjs": "#!/usr/bin/env node" };
  const ctx = {
    scriptsOf: (dir) => (dir === "" ? { serve: "bun x.ts", dev: "bun run serve" } : null),
    exists: (path) => files.has(path) || Object.hasOwn(shebangs, path),
    shebangOf: (path) => shebangs[path] ?? null
  };
  const scan = (script) => packageScriptViolations("package.json", "", { t: script }, ctx);
  const flags = (script) => scan(script).length > 0;
  const rules = (script) => scan(script).map((v) => v.rule);

  test("catches a non-bun launcher at the start of any command", () => {
    expect(flags("node tools/x.mjs")).toBe(true);
    expect(flags("npm run build")).toBe(true);
    expect(flags("npx astro build")).toBe(true);
    expect(flags("pnpm start")).toBe(true);
    expect(flags("tsx tools/x.mjs")).toBe(true);
    expect(flags("bun run serve && yarn install")).toBe(true);
    expect(flags("NODE_ENV=production node tools/x.mjs")).toBe(true);
    expect(rules("astro build")).toEqual(["bun-launcher"]);
  });

  test("catches a bare bin run without --bun (its shebang would start Node)", () => {
    expect(rules("bun astro build")).toEqual(["bun-bin-needs-bun-flag"]);
    expect(rules("bun run astro build")).toEqual(["bun-bin-needs-bun-flag"]);
    expect(rules("bun x playwright test")).toEqual(["bun-bin-needs-bun-flag"]);
  });

  test("catches a missing script or file, and a node shebang on a launched file", () => {
    expect(rules("bun run nope")).toEqual(["bun-bin-needs-bun-flag"]);
    expect(rules("bun tools/missing.mjs")).toEqual(["script-file-exists"]);
    expect(rules("bash gone.sh")).toEqual(["script-file-exists"]);
    expect(rules("bun tools/node-tool.mjs")).toEqual(["no-node-shebang"]);
  });

  test("allows bun commands, --bun bins, cd, bash, docker and a resolved bun run", () => {
    expect(flags("bun --bun astro build")).toBe(false);
    expect(flags("bun run --bun astro check")).toBe(false);
    expect(flags("bun run serve")).toBe(false);
    expect(flags("bun tools/x.mjs")).toBe(false);
    expect(flags("bun test ./tests/")).toBe(false);
    expect(flags("bun install --frozen-lockfile")).toBe(false);
    expect(flags("bun build server/s.mjs --target=bun --outfile dist/s.mjs")).toBe(false);
    expect(flags("bash run.sh")).toBe(false);
    expect(flags("docker compose up -d --wait")).toBe(false);
    expect(flags("bun -e \"import 'node:fs'\"")).toBe(false);
    expect(flags("cd apps/storefront && bun --bun astro dev")).toBe(false);
    expect(flags("NODE_ENV=production bun run serve")).toBe(false);
  });

  test("follows cd when it resolves bun run, and fails when the target package has no such script", () => {
    const withStorefront = {
      ...ctx,
      scriptsOf: (dir) => (dir === "apps/storefront" ? { dev: "bun --bun astro dev" } : null)
    };
    const ok = packageScriptViolations("package.json", "", { dev: "cd apps/storefront && bun run dev" }, withStorefront);
    const bad = packageScriptViolations("package.json", "", { dev: "cd apps/storefront && bun run nope" }, withStorefront);
    expect(ok).toEqual([]);
    expect(bad.map((v) => v.rule)).toEqual(["bun-bin-needs-bun-flag"]);
  });
});

describe("the stage-chain scanner itself", () => {
  const text = [
    "ARG BUN_VERSION=9.9.9",
    "FROM oven/bun:${BUN_VERSION} AS base",
    "FROM base AS deps",
    "FROM deps AS jobs",
    "FROM node:22 AS other"
  ].join("\n");

  test("follows aliases down to the external image with ARG defaults resolved", () => {
    expect(dockerStageChain(text, "jobs")).toEqual(["jobs", "deps", "base", "oven/bun:9.9.9"]);
    expect(dockerStageChain(text, "other")).toEqual(["other", "node:22"]);
  });

  test("answers null for a stage that does not exist", () => {
    expect(dockerStageChain(text, "missing")).toBeNull();
  });

  test("a launcher is recognised through the shared token vocabulary", () => {
    // (the spawn-literal scanner has its own describe block below)
    expect(launcherIn("node")).toBe("node");
    expect(launcherIn("node:fs")).toBeNull();
    expect(tokensOf("bun run build").some((token) => launcherIn(token))).toBe(false);
  });
});

describe("the spawn-literal scanner itself", () => {
  const flags = (text) => spawnLiteralViolations("fixture.ts", text).length > 0;

  test("catches a Node launcher spawned as a command", () => {
    expect(flags('Bun.spawn(["npm", "ci"]);')).toBe(true);
    expect(flags('const r = await run(["node", "x.js"]);')).toBe(true);
    expect(flags('{ name: "t", argv: ["tsx", "x.ts"] }')).toBe(true);
    expect(flags('spawnSync("pnpm", ["start"]);')).toBe(true);
    expect(flags("execSync('yarn install');")).toBe(true);
  });

  test("allows a registry label, bun and node: specifiers, and comments", () => {
    expect(flags('latestSource: "github" | "npm";')).toBe(false);
    expect(flags('source = "npm";')).toBe(false);
    expect(flags('Bun.spawn(["bun", "install"]);')).toBe(false);
    expect(flags('import fs from "node:fs";')).toBe(false);
    expect(flags('// Bun.spawn(["npm", "ci"]) was removed')).toBe(false);
    expect(flags(" * spawnSync('node', args)")).toBe(false);
  });
});
