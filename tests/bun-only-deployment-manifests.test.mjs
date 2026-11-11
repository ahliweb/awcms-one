/**
 * Root deployment and launch manifests start Bun and nothing else (issue #469,
 * ADR-0002 Bun-only). The root-side counterpart of
 * `apps/cms/tests/bun-only-launch-manifests.test.ts`, which covers `apps/cms`
 * only and is upstream-owned: this file never edits it.
 *
 * ## What is enforced
 *
 * Every root manifest is discovered, not listed, so a new compose file,
 * Dockerfile or ops script is covered the day it lands:
 *
 *   - compose files (`compose*.yaml` / `docker-compose*.yaml`, repo root)
 *   - Dockerfiles (`apps/storefront/Dockerfile`, `docker/backup/Dockerfile`, any
 *     other root or package Dockerfile)
 *   - shell, crontab and systemd manifests under `ops/`, `docker/` and
 *     `tools/deploy/`, plus the JS/MJS scripts in those same directories
 *
 * Checks, in order:
 *
 * 1. No Node-ecosystem launcher (`node`, `npm`, `npx`, `pnpm`, `yarn`, `tsx`,
 *    `ts-node`, ...) appears as a command word, a path basename, a container
 *    image (`node:22-alpine`), a shebang, or a quoted command literal in a JS
 *    script.
 * 2. Every `oven/bun` image reference, and every `BUN_VERSION`, `bun@x.y.z` or
 *    `bun-vx.y.z` pin in a manifest, equals the `packageManager` pin read from
 *    the root `package.json`. The version is never written into this file: a
 *    bump in `package.json` moves the expectation with it.
 * 3. The final stage of every Dockerfile is an `oven/bun` image at that pin, and
 *    any CMD/ENTRYPOINT/compose `command` that runs a JS file starts with `bun`.
 *    Compose services are checked the same way through the image or Dockerfile
 *    they build from.
 * 4. Every exemption below still names a real file or service, so a deleted or
 *    renamed manifest cannot leave a stale allow-entry behind.
 *
 * ## What is deliberately allowed (the false-positive guard)
 *
 * - `node:fs`-style built-in specifiers: a `node:` token is an image only when
 *   its tag looks like a version or variant (`node:22`, `node:lts-alpine`).
 * - `NODE_ENV`, `node_modules/...`, `@astrojs/node`: whole-token matching only.
 * - Comments (full-line `#` / `//` and trailing ` # ...`) and the prose lines of
 *   shell scripts (`echo`, `printf`, `log`).
 * - The explicit exemptions listed below, each with its reason.
 *
 * ## What cannot be proved here
 *
 * No image is built and no container is started. The static gate proves what
 * produces the process (the image tag, the final stage's CMD, the compose
 * command). A running-container check (`docker run <image> bun -e
 * 'process.exit(process.versions.bun ? 0 : 1)'`) needs a Docker daemon and is
 * out of scope here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dockerfileStageViolations,
  isPinnedTag,
  jsLaunchViolations,
  jsLiteralViolations,
  launchWords,
  launcherIn,
  launcherViolations,
  pinViolations,
  shebangViolations,
  tokensOf
} from "./support/bun-only-scan.mjs";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

const pkg = JSON.parse(read("package.json"));
/** The exact Bun version this repo pins, read from `packageManager`. */
const PIN = /^bun@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(pkg.packageManager ?? "")?.[1] ?? "";

// ---------------------------------------------------------------------------
// Exemptions. Each entry says why it is not Bun, and is checked for staleness.
// ---------------------------------------------------------------------------

/** Dockerfiles whose final stage is deliberately NOT an `oven/bun` image. */
const EXEMPT_DOCKERFILES = {
  "docker/backup/Dockerfile":
    "bash-only backup runner (issue #213, ADR-0123): FROM postgres:18.6 plus age, rsync and openssh-client, running the upstream apps/cms/deploy/backup/*.sh scripts. No JavaScript process starts in this image, so no Bun runtime is launched. The Node-launcher and bun-pin token rules still apply to it."
};

/**
 * Compose services that are not built from a scanned Dockerfile and run a
 * non-JavaScript image.
 */
const EXEMPT_IMAGE_SERVICES = {
  "compose.yaml#postgres":
    "PostgreSQL server (postgres:18.6): a database process, not a JavaScript launcher",
  "compose.production.yaml#postgres":
    "PostgreSQL server (postgres:18.6): a database process, not a JavaScript launcher"
};

/**
 * Services built from `apps/cms/**` are upstream-owned (`apps/cms` is a git
 * subtree, edited only by upstream). Their launch stage is asserted by
 * `apps/cms/tests/bun-only-launch-manifests.test.ts`, which this root gate
 * cannot edit or duplicate.
 */
const UPSTREAM_BUILD_PREFIX = "apps/cms/";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", ".git", ".astro", "dist", "coverage", "graphify-out", "var"]);
const SCRIPT_DIRS = ["ops/", "docker/", "tools/deploy/"];

/**
 * Test inputs, not deployment manifests: a gate's fixtures are deliberately
 * shaped like a Dockerfile or a compose file (often a WRONG one, to prove the
 * parser refuses it), and nothing deploys them. `tests/fixtures/deps-freshness/`
 * (issue #471) is the first such directory.
 */
function isTestFixture(rel) {
  return rel === "tests/fixtures" || rel.endsWith("/tests/fixtures");
}

function walk(rel = "", out = []) {
  for (const name of readdirSync(join(REPO_ROOT, rel))) {
    const child = rel === "" ? name : `${rel}/${name}`;
    if (SKIP_DIRS.has(name) || child === "apps/cms" || isTestFixture(child)) continue;
    if (statSync(join(REPO_ROOT, child)).isDirectory()) {
      walk(child, out);
    } else {
      out.push(child);
    }
  }
  return out;
}

export function classify(rel) {
  const base = basename(rel);
  if (/^Dockerfile(\..+)?$/.test(base) || /\.Dockerfile$/.test(base)) return "dockerfile";
  if (/^(docker-)?compose([.-].+)?\.ya?ml$/.test(base)) return "compose";
  if (!SCRIPT_DIRS.some((dir) => rel.startsWith(dir))) return null;
  if (/\.(sh|crontab|service)$/.test(base) || base === "Procfile") return "shell";
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(base)) return "script";
  return null;
}

const MANIFESTS = walk()
  .map((file) => ({ file, kind: classify(file) }))
  .filter((manifest) => manifest.kind !== null)
  .sort((a, b) => a.file.localeCompare(b.file));

const DOCKERFILES = MANIFESTS.filter((m) => m.kind === "dockerfile").map((m) => m.file);
const COMPOSE_FILES = MANIFESTS.filter((m) => m.kind === "compose").map((m) => m.file);

function formatViolations(violations) {
  return violations
    .map((v) => `${v.file}${v.line ? `:${v.line}` : ""} [${v.rule}] ${v.detail}`)
    .join("\n");
}

/** Compose-level check: every service either builds a checked Dockerfile or is exempt. */
function composeViolations(file, text, pin) {
  const violations = [];
  const doc = Bun.YAML.parse(text) ?? {};
  const services = doc.services ?? {};
  for (const [name, service] of Object.entries(services)) {
    const key = `${file}#${name}`;
    const build = typeof service.build === "string" ? { context: service.build } : service.build;

    // Strings a launch is made from: image, command, entrypoint, healthcheck.
    const launchStrings = [
      service.image,
      ...launchWords(service.command),
      ...launchWords(service.entrypoint),
      ...launchWords(service.healthcheck?.test)
    ].filter((value) => typeof value === "string");
    for (const value of launchStrings) {
      for (const token of tokensOf(value)) {
        const bad = launcherIn(token);
        if (bad) violations.push({ file, line: 0, rule: "no-node-launcher", detail: `${key} launches ${bad} ("${token}")` });
      }
    }
    violations.push(...jsLaunchViolations(file, `${key} command`, service.command ?? []));
    violations.push(...jsLaunchViolations(file, `${key} entrypoint`, service.entrypoint ?? []));
    violations.push(...jsLaunchViolations(file, `${key} healthcheck`, service.healthcheck?.test ?? []));

    if (build) {
      const dockerfile = posix.normalize(posix.join(build.context ?? ".", build.dockerfile ?? "Dockerfile"));
      if (dockerfile.startsWith(UPSTREAM_BUILD_PREFIX)) continue;
      if (!DOCKERFILES.includes(dockerfile)) {
        violations.push({ file, line: 0, rule: "bun-final-stage", detail: `${key} builds ${dockerfile}, which this gate does not scan` });
      }
      continue;
    }

    const image = typeof service.image === "string" ? service.image : "";
    if (image.startsWith("oven/bun:")) {
      if (!isPinnedTag(image.slice("oven/bun:".length), pin)) {
        violations.push({ file, line: 0, rule: "bun-pin", detail: `${key} runs ${image}, not oven/bun:${pin}` });
      }
    } else if (!Object.hasOwn(EXEMPT_IMAGE_SERVICES, key)) {
      violations.push({
        file,
        line: 0,
        rule: "bun-final-stage",
        detail: `${key} runs image "${image}": neither oven/bun:${pin} nor an exempted non-JavaScript service`
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("the Bun pin is read from package.json, not hard-coded", () => {
  test("packageManager states an exact bun@X.Y.Z", () => {
    expect(PIN).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("manifest discovery", () => {
  test("skips test fixtures, which are inputs to other gates and are never deployed", () => {
    expect(isTestFixture("tests/fixtures")).toBe(true);
    expect(isTestFixture("apps/storefront/tests/fixtures")).toBe(true);
    expect(isTestFixture("tests/fixtures-not")).toBe(false);
    expect(isTestFixture("docker/fixtures")).toBe(false);
    expect(MANIFESTS.some((m) => m.file.startsWith("tests/fixtures/"))).toBe(false);
  });

  test("finds the root manifests that launch jobs and services today", () => {
    const files = MANIFESTS.map((m) => m.file);
    for (const expected of [
      "compose.yaml",
      "compose.production.yaml",
      "apps/storefront/Dockerfile",
      "docker/backup/Dockerfile",
      "ops/run-job-compose.sh",
      "ops/run-backup-compose.sh",
      "ops/awcms-one-backup.crontab",
      "tools/deploy/deploy-production.sh",
      "tools/deploy/lib/common.sh",
      "tools/deploy/redact-log.mjs"
    ]) {
      expect(files).toContain(expected);
    }
  });

  test("never discovers apps/cms, which is upstream-owned and covered by its own gate", () => {
    expect(MANIFESTS.filter((m) => m.file.startsWith("apps/cms/"))).toEqual([]);
  });
});

describe("every root manifest starts Bun and never a Node-ecosystem launcher", () => {
  for (const { file, kind } of MANIFESTS) {
    test(`${file} (${kind})`, () => {
      const text = read(file);
      let violations;
      if (kind === "script") {
        // JS source: a shebang or a quoted launcher literal only. A bare `node`
        // token in code is an identifier, not a launch; `node:fs` is Bun's own.
        violations = [...shebangViolations(file, text), ...jsLiteralViolations(file, text)];
      } else if (kind === "shell") {
        // Shell prose (`echo`/`printf`/`log`) is skipped, crontab lines are not.
        violations = launcherViolations(file, text, { skipProse: file.endsWith(".sh") });
      } else if (kind === "dockerfile") {
        violations = launcherViolations(file, text);
      } else {
        // Compose: the launch-relevant strings are checked structurally in the
        // compose test below, so prose in environment values never false-fails.
        violations = [];
      }
      expect(formatViolations(violations)).toBe("");
    });
  }
});

describe("every Bun pin in every root manifest equals the packageManager pin", () => {
  for (const { file } of MANIFESTS) {
    test(file, () => {
      expect(formatViolations(pinViolations(file, read(file), PIN))).toBe("");
    });
  }
});

describe("every root Dockerfile's final stage is Bun, and its launcher is bun", () => {
  for (const file of DOCKERFILES) {
    test(file, () => {
      if (Object.hasOwn(EXEMPT_DOCKERFILES, file)) return;
      expect(formatViolations(dockerfileStageViolations(file, read(file), PIN))).toBe("");
    });
  }
});

describe("every root compose service launches Bun, or is an exempted non-JavaScript service", () => {
  for (const file of COMPOSE_FILES) {
    test(file, () => {
      expect(formatViolations(composeViolations(file, read(file), PIN))).toBe("");
    });
  }
});

describe("exemptions are still real (no stale allow-entries)", () => {
  test("every exempt Dockerfile still exists", () => {
    for (const file of Object.keys(EXEMPT_DOCKERFILES)) {
      expect(DOCKERFILES).toContain(file);
    }
  });

  test("every exempt image-only compose service still exists and still has no build", () => {
    for (const key of Object.keys(EXEMPT_IMAGE_SERVICES)) {
      const [file, name] = key.split("#");
      const service = (Bun.YAML.parse(read(file)) ?? {}).services?.[name];
      expect(service, key).toBeDefined();
      expect(service.build, key).toBeUndefined();
    }
  });

  test("the upstream-owned build prefix still exists, so its exemption is not a ghost", () => {
    expect(statSync(join(REPO_ROOT, UPSTREAM_BUILD_PREFIX)).isDirectory()).toBe(true);
  });
});

describe("the scanner itself: positives are caught, false positives are not", () => {
  const FIXTURE_PIN = "9.9.9";
  const flags = (text) => launcherViolations("fixture", text).length > 0;

  test("catches a Node launcher in command position, a path, an image and a shebang", () => {
    expect(flags("npm ci\n")).toBe(true);
    expect(flags("exec node dist/server.js\n")).toBe(true);
    expect(flags("/usr/bin/node worker.mjs\n")).toBe(true);
    expect(flags("FROM node:22-alpine\n")).toBe(true);
    expect(flags("FROM docker.io/library/node:lts\n")).toBe(true);
    expect(flags("RUN npx prisma migrate\n")).toBe(true);
    expect(flags("pnpm start\n")).toBe(true);
    expect(flags("yarn install\n")).toBe(true);
    expect(flags("#!/usr/bin/env node\nconsole.log(1)\n")).toBe(true);
  });

  test("catches a quoted Node launcher literal in JS source", () => {
    expect(jsLiteralViolations("fixture.mjs", 'spawn("npm", ["ci"]);\n').length).toBe(1);
    expect(jsLiteralViolations("fixture.mjs", "const r = `tsx`;\n").length).toBe(1);
  });

  test("allows node: built-in imports, NODE_ENV, node_modules, scoped packages and bun", () => {
    expect(flags("bun -e \"import 'node:fs'\"\n")).toBe(false);
    expect(flags("NODE_ENV=production bun run build\n")).toBe(false);
    expect(flags("cp -r node_modules/.bin/x ./x\n")).toBe(false);
    expect(flags("import '@astrojs/node';\n")).toBe(false);
    expect(flags("RUN bun install --frozen-lockfile\n")).toBe(false);
    expect(jsLiteralViolations("fixture.mjs", "const env = process.env.NODE_ENV;\n")).toEqual([]);
  });

  test("ignores comments and shell prose", () => {
    expect(flags("# npm install is no longer used here\n")).toBe(false);
    expect(flags("bun run db:migrate # not npm\n")).toBe(false);
    expect(launcherViolations("x.sh", 'echo "run npm ci first"\n', { skipProse: true })).toEqual([]);
    expect(jsLiteralViolations("x.mjs", "// spawn('npm') was removed\n")).toEqual([]);
  });

  test("bun-pin: an oven/bun tag other than the pin is caught, and the pin itself is not", () => {
    expect(pinViolations("f", "FROM oven/bun:1.4.3-slim\n", FIXTURE_PIN).length).toBe(1);
    expect(pinViolations("f", "FROM oven/bun:9.9.9-slim AS runtime\n", FIXTURE_PIN)).toEqual([]);
    expect(pinViolations("f", "FROM oven/bun\n", FIXTURE_PIN).length).toBe(1);
  });

  test("bun-pin: a floating ARG default is resolved, and a wrong one is caught", () => {
    const good = "ARG BUN_VERSION=9.9.9\nFROM oven/bun:${BUN_VERSION} AS deps\n";
    const bad = "ARG BUN_VERSION=1.4.3\nFROM oven/bun:${BUN_VERSION} AS deps\n";
    expect(pinViolations("f", good, FIXTURE_PIN)).toEqual([]);
    expect(pinViolations("f", bad, FIXTURE_PIN).length).toBeGreaterThan(0);
  });

  test("bun-pin: a comment that mentions an old tag is not a pin", () => {
    expect(pinViolations("f", "# trivy scan of `oven/bun:1.4.2-slim`\n", FIXTURE_PIN)).toEqual([]);
  });

  test("final stage: a Dockerfile whose last stage is a Node image is caught", () => {
    const text = "FROM oven/bun:9.9.9 AS deps\nFROM node:22-alpine AS runtime\nCMD [\"node\", \"x.js\"]\n";
    const violations = dockerfileStageViolations("f", text, FIXTURE_PIN);
    expect(violations.some((v) => v.rule === "bun-final-stage")).toBe(true);
  });

  test("final stage: a bun CMD that runs a JS file passes, a node CMD does not", () => {
    const ok = 'FROM oven/bun:9.9.9-slim\nCMD ["bun", "dist/server.mjs"]\n';
    const bad = 'FROM oven/bun:9.9.9-slim\nCMD ["node", "dist/server.mjs"]\n';
    expect(dockerfileStageViolations("f", ok, FIXTURE_PIN)).toEqual([]);
    expect(dockerfileStageViolations("f", bad, FIXTURE_PIN).length).toBeGreaterThan(0);
  });
});
