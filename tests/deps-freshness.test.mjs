/**
 * `bun run deps:freshness` (issue #471) — `tools/lib/deps-freshness.ts` (pure)
 * and `tools/deps-freshness.ts` (CLI).
 *
 * No network, anywhere: every registry answer is a fixture under
 * `tests/fixtures/deps-freshness/`, and the one CLI test runs with `--offline`.
 * What these tests pin down is the policy, not the registry:
 *
 *   - UNKNOWN is never a pass (an unreachable registry cannot read as "no drift");
 *   - drift is advisory, `--strict` is the only thing that fails;
 *   - `apps/cms` is never scanned (upstream owns it);
 *   - the report is NOT wired into `check` or into any `local-ci/*` leg.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  UPSTREAM_OWNED_WORKSPACES,
  analyzeHubTags,
  assignDispositions,
  buildManifest,
  buildOverrideRow,
  bunVersionFromReleaseTag,
  classifyDrift,
  classifyTagDrift,
  compareVersions,
  countDirectDependencies,
  engineFloor,
  evaluateAdvisories,
  evaluateHeldBack,
  hubRepository,
  isFloating,
  lockedVersion,
  parseAuditOutput,
  parseComposeImages,
  parseDockerfileArgs,
  parseDockerfileImages,
  parseHeldBack,
  parseImageReference,
  parseOutdatedOutput,
  parseToolImages,
  pinnedBunVersion,
  pickNewestTag,
  rangeFloor,
  renderMarkdown
} from "../tools/lib/deps-freshness.ts";

const FIXTURES = new URL("./fixtures/deps-freshness/", import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES), "utf8");
const json = (name) => JSON.parse(fixture(name));

const TODAY = "2026-10-25";

const HOLD = {
  packageName: "typescript",
  heldVersion: "6.0.3",
  reason: "TypeScript 7 is outside @astrojs/check's supported peer range (^5 || ^6) and the build runs astro check.",
  owner: "ahliweb",
  reviewDate: "2027-01-25"
};

/** Everything fetched and clean — the baseline each test then spoils in one way. */
function input(overrides = {}) {
  return {
    generatedAt: `${TODAY}T10:00:00.000Z`,
    offline: false,
    bunVersionUsed: "1.4.4",
    outdated: { status: "ok", data: { directDependencyCount: 7, workspaces: ["awcms-one"], rows: [] } },
    overrides: { status: "ok", data: [] },
    advisories: {
      status: "ok",
      data: { blocking: [], informationalCount: 0, exceptionCount: 0, bySeverity: {} }
    },
    bun: {
      status: "ok",
      data: {
        pinned: "1.4.4",
        engineFloor: "1.4.4",
        latest: "1.4.4",
        latestSource: "npm",
        drift: "current",
        mismatches: [],
        note: null
      }
    },
    images: [],
    heldBackEntries: [],
    ...overrides
  };
}

describe("versions", () => {
  test("compareVersions orders by major, minor, patch and sorts prereleases below the release", () => {
    assert.equal(compareVersions("1.4.4", "1.4.5"), -1);
    assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
    assert.equal(compareVersions("not-a-version", "1.0.0"), null);
  });

  test("classifyDrift names the largest component that differs; ahead-of-latest is current", () => {
    assert.equal(classifyDrift("7.4.0", "7.4.2"), "patch");
    assert.equal(classifyDrift("7.3.9", "7.4.0"), "minor");
    assert.equal(classifyDrift("6.0.3", "7.0.2"), "major");
    assert.equal(classifyDrift("1.4.5", "1.4.4"), "current");
    assert.equal(classifyDrift("workspace:*", "1.0.0"), "unknown");
  });

  test("tag helpers compare only tags of the same shape and treat a shorter tag as a real signal", () => {
    const tags = ["19", "18.6", "18.4", "18.6-alpine", "latest", "19-alpine"];
    assert.equal(pickNewestTag(tags, "18.4"), "19");
    assert.equal(pickNewestTag(tags, "18.4-alpine"), "19-alpine");
    assert.equal(pickNewestTag(["latest"], "18.4"), null);
    assert.equal(classifyTagDrift("18.4", "18.6"), "minor");
    assert.equal(classifyTagDrift("18.4", "19"), "major");
    assert.equal(classifyTagDrift("18.4", "18.4"), "current");
    assert.equal(classifyTagDrift("latest", "18.4"), "unknown");
  });

  test("Bun pin helpers read exactly the shapes the repo writes", () => {
    assert.equal(pinnedBunVersion("bun@1.4.4"), "1.4.4");
    assert.equal(pinnedBunVersion("bun@^1.4.4"), null);
    assert.equal(pinnedBunVersion(undefined), null);
    assert.equal(engineFloor(">=1.4.4"), "1.4.4");
    assert.equal(engineFloor("1.4.4"), null);
    assert.equal(bunVersionFromReleaseTag("bun-v1.4.4"), "1.4.4");
    assert.equal(bunVersionFromReleaseTag("canary"), null);
    assert.equal(bunVersionFromReleaseTag("bun-v1.4.4-canary"), null);
  });
});

describe("bun outdated parsing", () => {
  test("rows keep workspace, kind, locked / in-range / latest and a drift level", () => {
    const rows = parseOutdatedOutput(fixture("bun-outdated.txt"));
    assert.equal(rows.length, 5);

    const astro = rows.find((row) => row.name === "astro");
    assert.deepEqual(
      { workspace: astro.workspace, kind: astro.kind, current: astro.current, update: astro.update, latest: astro.latest },
      { workspace: "@awcms-one/storefront", kind: "prod", current: "7.4.0", update: "7.4.2", latest: "7.4.2" }
    );
    assert.equal(astro.drift, "patch");
    assert.equal(astro.inRange, true);

    const ts = rows.find((row) => row.name === "typescript");
    assert.equal(ts.kind, "dev");
    assert.equal(ts.drift, "major");
    assert.equal(ts.inRange, false, "6.0.3 is already the newest version the range allows");
  });

  test("a bare banner means nothing is outdated", () => {
    assert.deepEqual(parseOutdatedOutput(fixture("bun-outdated-clean.txt")), []);
  });

  test("anything that is not the table or the banner throws — a format change must surface as UNKNOWN, not as 'all current'", () => {
    assert.throws(() => parseOutdatedOutput("error: failed to resolve registry\n"), /unexpected output/);
    assert.throws(() => parseOutdatedOutput("| a | b |\n"), /unexpected/);
    // A table from `bun outdated` WITHOUT --filter has no Workspace column.
    assert.throws(
      () => parseOutdatedOutput("| Package | Current | Update | Latest |\n| astro | 7.4.0 | 7.4.2 | 7.4.2 |\n"),
      /unexpected/
    );
  });
});

describe("dispositions", () => {
  const rows = parseOutdatedOutput(fixture("bun-outdated.txt"));
  const hold = evaluateHeldBack([HOLD], TODAY, () => "7.0.2");

  test("in-range patch/minor is a candidate; a held major is held; an undecided major needs a decision", () => {
    const byName = Object.fromEntries(assignDispositions(rows, hold).map((row) => [row.name, row]));
    assert.equal(byName.astro.disposition, "candidate");
    assert.equal(byName["@astrojs/check"].disposition, "candidate");
    assert.equal(byName.typescript.disposition, "held");
    assert.match(byName.typescript.holdNote, /owner ahliweb, review by 2027-01-25/);
    assert.equal(byName["left-pad"].disposition, "needs-decision");
  });

  test("a stale hold no longer covers the row", () => {
    const stale = evaluateHeldBack([HOLD], TODAY, () => "6.0.3");
    assert.equal(stale[0].status, "stale");
    const row = assignDispositions(rows, stale).find((r) => r.name === "typescript");
    assert.equal(row.disposition, "needs-decision");
  });
});

describe("root overrides", () => {
  test("lockedVersion reads the top-level lockfile entry, scoped names included, and ignores nested copies", () => {
    const lock = fixture("bun.lock.txt");
    assert.equal(lockedVersion(lock, "sharp"), "0.35.5");
    assert.equal(lockedVersion(lock, "@scope/pkg"), "2.0.1");
    assert.equal(lockedVersion(lock, "shell-quote"), "1.12.0", "the nested astro/shell-quote copy is not the top-level one");
    assert.equal(lockedVersion(lock, "missing"), null);
  });

  test("rangeFloor and buildOverrideRow fall back to the range floor when the lockfile has no entry", () => {
    assert.equal(rangeFloor("^0.35.5"), "0.35.5");
    assert.equal(rangeFloor("workspace:*"), null);
    assert.equal(buildOverrideRow("smol-toml", "^1.9.0", "1.9.0", "1.9.1").drift, "patch");
    assert.equal(buildOverrideRow("x", "^1.0.0", null, "2.0.0").drift, "major");
    assert.equal(buildOverrideRow("x", "latest", null, "2.0.0").drift, "unknown");
  });
});

describe("bun audit", () => {
  test("high/critical without an exception blocks; an excepted advisory and low severities are informational", () => {
    const report = parseAuditOutput(fixture("bun-audit.json"));
    const result = evaluateAdvisories(report, ["GHSA-ch52-4w7c-c8xp"]);

    assert.equal(result.blocking.length, 1);
    assert.match(result.blocking[0], /left-pad: \[critical\] Prototype pollution/);
    assert.equal(result.informationalCount, 2);
    assert.deepEqual(result.bySeverity, { high: 1, critical: 1, low: 1 });
    assert.equal(result.exceptionCount, 1);
  });

  test("an empty report is a real all-clear, but empty or non-JSON output is not a report", () => {
    assert.deepEqual(evaluateAdvisories(parseAuditOutput("{}"), []).blocking, []);
    assert.throws(() => parseAuditOutput(""), /printed nothing/);
    assert.throws(() => parseAuditOutput("error: network unreachable"), /not JSON/);
  });
});

describe("container image discovery", () => {
  test("parseImageReference splits name, tag and digest and rejects non-images", () => {
    assert.deepEqual(parseImageReference("postgres:18.4"), { image: "postgres", tag: "18.4", digest: null });
    assert.deepEqual(parseImageReference("localhost:5000/team/app:1.0"), {
      image: "localhost:5000/team/app",
      tag: "1.0",
      digest: null
    });
    const digest = `sha256:${"a".repeat(64)}`;
    assert.deepEqual(parseImageReference(`docker.io/zricethezav/gitleaks@${digest}`), {
      image: "docker.io/zricethezav/gitleaks",
      tag: null,
      digest
    });
    assert.equal(parseImageReference("UPPER:1"), null);
    assert.equal(parseImageReference("name@sha256:short"), null);
    assert.equal(parseImageReference("has space:1"), null);
  });

  test("Dockerfile: ARG defaults are substituted; build stages, scratch and unresolved variables are not images", () => {
    assert.deepEqual(parseDockerfileArgs(fixture("Dockerfile")), { BUN_VERSION: "1.4.4", UNUSED: "1" });

    const refs = parseDockerfileImages(fixture("Dockerfile"), "Dockerfile").map((ref) => ref.ref);
    assert.deepEqual(refs, ["oven/bun:1.4.4", "oven/bun:1.4.4-slim", "postgres:latest", "node"]);
  });

  test("compose: literal image values only — interpolated (local build name) values and comments are skipped", () => {
    const refs = parseComposeImages(fixture("compose.yaml"), "compose.yaml").map((ref) => ref.ref);
    assert.deepEqual(refs, ["postgres:18.4", "redis:8.2"]);
  });

  test("tool sources: digest-pinned and numeric-tag images only; comments, prose, ports and hosts are not images", () => {
    const refs = parseToolImages(fixture("tool-runner.ts.txt"), "runner.ts").map((ref) => ref.ref);
    assert.deepEqual(refs, [
      "docker.io/zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
      "postgres:18.4"
    ]);
    assert.deepEqual(parseToolImages('const host = "127.0.0.1:5433";', "x.ts"), [], "no mention of docker, so not read");
  });

  test("floating = no tag, or latest, unless a digest pins it", () => {
    assert.equal(isFloating({ tag: null, digest: null }), true);
    assert.equal(isFloating({ tag: "latest", digest: null }), true);
    assert.equal(isFloating({ tag: "18.4", digest: null }), false);
    assert.equal(isFloating({ tag: null, digest: `sha256:${"a".repeat(64)}` }), false);
  });

  test("hubRepository maps Docker Hub names and refuses every other registry", () => {
    assert.equal(hubRepository("postgres"), "library/postgres");
    assert.equal(hubRepository("oven/bun"), "oven/bun");
    assert.equal(hubRepository("docker.io/zricethezav/gitleaks"), "zricethezav/gitleaks");
    assert.equal(hubRepository("gcr.io/projectsigstore/cosign"), null);
    assert.equal(hubRepository("ghcr.io/ahliweb/awcms-one-cms"), null);
    assert.equal(hubRepository("localhost:5000/app"), null);
  });
});

describe("registry tag analysis (fixtures, no network)", () => {
  test("a tag-pinned image is compared with the newest tag of its own shape", () => {
    const ref = { file: "compose.yaml", ref: "postgres:18.4", image: "postgres", tag: "18.4", digest: null };
    const result = analyzeHubTags(ref, json("hub-tags-postgres.json"));
    assert.equal(result.status, "ok");
    assert.equal(result.data.currentTag, "18.4");
    assert.equal(result.data.newestTag, "19.0", "19.0 is newer than 18.6 and has the same (empty) suffix");
    assert.equal(result.data.drift, "major");
    assert.equal(result.data.registryDigest, "sha256:ccc");
  });

  test("a digest-only pin recovers its tag from the registry and compares from there", () => {
    const digest = "sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
    const ref = { file: "runner.ts", ref: `docker.io/zricethezav/gitleaks@${digest}`, image: "docker.io/zricethezav/gitleaks", tag: null, digest };
    const result = analyzeHubTags(ref, json("hub-tags-gitleaks.json"));
    assert.equal(result.status, "ok");
    assert.equal(result.data.currentTag, "v8.30.1");
    assert.equal(result.data.newestTag, "v8.31.0");
    assert.equal(result.data.drift, "minor");
  });

  test("a digest the registry page does not contain is UNKNOWN, not 'current'", () => {
    const digest = `sha256:${"f".repeat(64)}`;
    const ref = { file: "runner.ts", ref: `x/y@${digest}`, image: "x/y", tag: null, digest };
    const result = analyzeHubTags(ref, json("hub-tags-gitleaks.json"));
    assert.equal(result.status, "unknown");
    assert.match(result.reason, /not among the 4 most recently updated tags/);
  });
});

describe("held-back register", () => {
  test("parseHeldBack accepts a complete entry and rejects every malformed one", () => {
    assert.equal(parseHeldBack(JSON.stringify([HOLD]))[0].packageName, "typescript");
    assert.deepEqual(parseHeldBack("[]"), []);
    assert.throws(() => parseHeldBack("{}"), /JSON array/);
    assert.throws(() => parseHeldBack(JSON.stringify([{ ...HOLD, reason: "risky" }])), /reason/);
    assert.throws(() => parseHeldBack(JSON.stringify([{ ...HOLD, reviewDate: "next spring" }])), /reviewDate/);
    assert.throws(() => parseHeldBack(JSON.stringify([{ ...HOLD, heldVersion: "^6.0.3" }])), /heldVersion/);
    assert.throws(() => parseHeldBack(JSON.stringify([{ ...HOLD, owner: " " }])), /owner/);
  });

  test("evaluateHeldBack: active / expired / stale / unverified", () => {
    assert.equal(evaluateHeldBack([HOLD], TODAY, () => "7.0.2")[0].status, "active");
    assert.equal(evaluateHeldBack([HOLD], "2027-02-01", () => "7.0.2")[0].status, "expired");
    assert.equal(evaluateHeldBack([HOLD], TODAY, () => "6.0.3")[0].status, "stale");
    assert.equal(evaluateHeldBack([HOLD], TODAY, () => "current")[0].status, "stale");
    assert.equal(evaluateHeldBack([HOLD], TODAY, () => undefined)[0].status, "unverified");
  });

  test("the committed register parses and nothing in it has passed its review date", () => {
    const entries = parseHeldBack(readFileSync("tools/deps-held-back.json", "utf8"));
    const today = new Date().toISOString().slice(0, 10);
    const expired = entries.filter((entry) => entry.reviewDate < today).map((entry) => entry.packageName);
    assert.deepEqual(expired, [], `re-justify (new reviewDate) or remove: ${expired.join(", ")}`);
  });
});

describe("manifest and verdict", () => {
  test("everything clean: no strict failure, and the verdict says so", () => {
    const manifest = buildManifest(input());
    assert.deepEqual(manifest.strictFailures, []);
    assert.deepEqual(manifest.unknownSections, []);
    assert.equal(manifest.mode, "read-only");
    assert.match(renderMarkdown(manifest), /Nothing blocks and every check ran/);
  });

  test("drift alone is a backlog, never a strict failure — candidates and held majors do not fail", () => {
    const rows = parseOutdatedOutput(fixture("bun-outdated.txt")).filter((row) => row.name !== "left-pad");
    const manifest = buildManifest(
      input({
        outdated: { status: "ok", data: { directDependencyCount: 7, workspaces: ["w"], rows } },
        heldBackEntries: [HOLD]
      })
    );
    assert.deepEqual(manifest.strictFailures, []);
    assert.match(renderMarkdown(manifest), /candidate/);
    assert.match(renderMarkdown(manifest), /held — /);
  });

  test("an undecided major fails --strict and names how to resolve it", () => {
    const rows = parseOutdatedOutput(fixture("bun-outdated.txt"));
    const manifest = buildManifest(
      input({ outdated: { status: "ok", data: { directDependencyCount: 7, workspaces: ["w"], rows } }, heldBackEntries: [HOLD] })
    );
    assert.equal(manifest.strictFailures.length, 1);
    assert.match(manifest.strictFailures[0], /left-pad 1\.0\.0 -> 2\.0\.0 is a major with no decision/);
    assert.match(manifest.strictFailures[0], /deps-held-back\.json/);
  });

  test("UNKNOWN is never a pass: every unreachable section is listed and fails --strict", () => {
    const manifest = buildManifest(
      input({
        offline: true,
        outdated: { status: "unknown", reason: "registry down" },
        overrides: { status: "unknown", reason: "registry down" },
        advisories: { status: "unknown", reason: "registry down" },
        bun: { status: "unknown", reason: "registry down" },
        images: [
          {
            file: "compose.yaml",
            ref: "postgres:18.4",
            image: "postgres",
            tag: "18.4",
            digest: null,
            floating: false,
            result: { status: "unknown", reason: "registry down" }
          }
        ],
        heldBackEntries: [HOLD]
      })
    );

    assert.equal(manifest.unknownSections.length, 5);
    assert.equal(manifest.strictFailures.length, 5, "one strict failure per UNKNOWN section; the unverified hold adds none");
  });

  test("an unverified hold is not itself a failure (it is the registry being unreachable that is)", () => {
    const manifest = buildManifest(input({ outdated: { status: "unknown", reason: "x" }, heldBackEntries: [HOLD] }));
    assert.deepEqual(manifest.heldBack.map((entry) => entry.status), ["unverified"]);
    assert.deepEqual(manifest.strictFailures, ["bun outdated: UNKNOWN — x"]);
  });

  test("blocking advisories, a mismatched Bun pin, a floating tag and an expired hold each fail --strict", () => {
    const manifest = buildManifest(
      input({
        generatedAt: "2027-02-01T00:00:00.000Z",
        advisories: {
          status: "ok",
          data: { blocking: ["left-pad: [critical] Prototype pollution"], informationalCount: 0, exceptionCount: 0, bySeverity: {} }
        },
        bun: {
          status: "ok",
          data: {
            pinned: "1.4.4",
            engineFloor: "1.4.4",
            latest: "1.4.5",
            latestSource: "github",
            drift: "patch",
            mismatches: ["apps/storefront/Dockerfile `ARG BUN_VERSION=1.4.3` differs from packageManager bun@1.4.4"],
            note: null
          }
        },
        images: [
          {
            file: "apps/storefront/Dockerfile",
            ref: "postgres:latest",
            image: "postgres",
            tag: "latest",
            digest: null,
            floating: true,
            result: { status: "ok", data: { currentTag: "latest", registryDigest: null, lastUpdated: null, newestTag: null, drift: "unknown" } }
          }
        ],
        heldBackEntries: [HOLD]
      })
    );

    const joined = manifest.strictFailures.join("\n");
    assert.match(joined, /advisory: left-pad/);
    assert.match(joined, /Bun pin: apps\/storefront\/Dockerfile/);
    assert.match(joined, /floating tag/);
    assert.match(joined, /held-back typescript: expired/);
  });

  test("the rendered report names the scope, and an UNKNOWN section says it is not a pass", () => {
    const text = renderMarkdown(buildManifest(input({ offline: true, advisories: { status: "unknown", reason: "no network" } })));
    assert.match(text, /\(offline: no registry was contacted\)/);
    assert.match(text, /`apps\/cms` is upstream's/);
    assert.match(text, /\*\*UNKNOWN\*\* — no network\. This is NOT a pass/);
  });

  test("countDirectDependencies counts registry packages and leaves workspace links out", () => {
    assert.equal(
      countDirectDependencies({
        dependencies: { astro: "^7.3.1", "@awcms-one/kontrak": "workspace:*" },
        devDependencies: { typescript: "^6.0.3" }
      }),
      2
    );
    assert.equal(countDirectDependencies({}), 0);
  });
});

describe("scope and wiring", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));

  test("apps/cms is upstream-owned and never scanned", () => {
    assert.ok(UPSTREAM_OWNED_WORKSPACES.includes("apps/cms"));
    const cli = readFileSync("tools/deps-freshness.ts", "utf8");
    assert.match(cli, /UPSTREAM_OWNED_WORKSPACES\.includes\(relative\)/);
    for (const source of ["tools/deps-freshness.ts", "tools/lib/deps-freshness.ts"]) {
      assert.doesNotMatch(
        readFileSync(source, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
        /from ["'][^"']*apps\/cms/,
        `${source} must not import apps/cms internals`
      );
    }
  });

  test("the script exists at the root and is NOT part of check, build or any ci script", () => {
    assert.equal(pkg.scripts["deps:freshness"], "bun tools/deps-freshness.ts");
    for (const name of ["check", "build", "test", "ci", "ci:pr", "ci:watch", "ci:cms", "ci:e2e", "ci:security", "ci:template"]) {
      assert.doesNotMatch(pkg.scripts[name], /deps:freshness|deps-freshness/, `${name} must not run the network report`);
    }
  });

  test("no local-ci runner or leg runs it: it adds no 13th required context and needs no network inside a leg", () => {
    for (const file of ["tools/ci/legs.ts", "tools/ci/runners/check.ts", "tools/ci/runners/security.ts", "tools/ci/runners/check-cms.ts"]) {
      assert.doesNotMatch(readFileSync(file, "utf8"), /deps:freshness|deps-freshness/, file);
    }
  });

  test("the real committed sources yield exactly the image references the docs promise", () => {
    const refs = [
      ...parseDockerfileImages(readFileSync("apps/storefront/Dockerfile", "utf8"), "apps/storefront/Dockerfile"),
      ...parseDockerfileImages(readFileSync("docker/backup/Dockerfile", "utf8"), "docker/backup/Dockerfile"),
      ...parseComposeImages(readFileSync("compose.yaml", "utf8"), "compose.yaml"),
      ...parseComposeImages(readFileSync("compose.production.yaml", "utf8"), "compose.production.yaml"),
      ...parseToolImages(readFileSync("tools/ci/runners/check-cms.ts", "utf8"), "tools/ci/runners/check-cms.ts"),
      ...parseToolImages(readFileSync("tools/ci/runners/security.ts", "utf8"), "tools/ci/runners/security.ts")
    ].map((ref) => `${ref.file} ${ref.ref}`);

    const pin = pinnedBunVersion(pkg.packageManager);
    assert.deepEqual(refs.sort(), [
      "apps/storefront/Dockerfile oven/bun:" + pin,
      "apps/storefront/Dockerfile oven/bun:" + pin + "-slim",
      "compose.production.yaml postgres:18.4",
      "compose.yaml postgres:18.4",
      "docker/backup/Dockerfile postgres:18.4",
      "tools/ci/runners/check-cms.ts postgres:18.4",
      "tools/ci/runners/security.ts docker.io/zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
    ].sort());
  });

  test("the storefront Dockerfile's ARG BUN_VERSION agrees with packageManager (the same check the report runs)", () => {
    assert.equal(parseDockerfileArgs(readFileSync("apps/storefront/Dockerfile", "utf8")).BUN_VERSION, pinnedBunVersion(pkg.packageManager));
  });
});

describe("CLI", () => {
  const run = (...flags) =>
    Bun.spawnSync(["bun", "tools/deps-freshness.ts", "--offline", ...flags], { stdout: "pipe", stderr: "pipe" });

  test("--offline contacts no registry, exits 0 and reports every network section as UNKNOWN", () => {
    const result = run("--json");
    assert.equal(result.exitCode, 0, result.stderr.toString());

    const manifest = JSON.parse(result.stdout.toString());
    assert.equal(manifest.offline, true);
    assert.equal(manifest.mode, "read-only");
    assert.ok(manifest.unknownSections.includes("bun outdated"));
    assert.ok(manifest.unknownSections.includes("bun audit"));
    assert.ok(manifest.unknownSections.includes("Bun pin vs latest release"));
    assert.ok(manifest.images.length >= 6, "the offline parts — image discovery — still ran");
  });

  test("--strict turns the same offline run into exit 1", () => {
    const result = run("--strict");
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout.toString(), /Needs attention/);
  });
});
