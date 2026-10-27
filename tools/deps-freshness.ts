/**
 * deps-freshness.ts — `bun run deps:freshness` (issue #471).
 *
 * A READ-ONLY report of how far the things THIS repository pins have drifted from
 * what their registries publish today:
 *
 * 1. direct dependencies of the root `package.json`, `apps/storefront` and
 *    `packages/*` (`bun outdated`) — never `apps/cms`, which upstream owns;
 * 2. the root `overrides` (npm registry);
 * 3. advisories (`bun audit --json`) over the whole lockfile;
 * 4. the Bun pin against the latest Bun release, and against the storefront
 *    Dockerfile's `ARG BUN_VERSION`;
 * 5. every container image the storefront Dockerfile, the compose files, the
 *    backup Dockerfile and the local-ci / release tools reference;
 * 6. the held-back register, `tools/deps-held-back.json`.
 *
 * ## It changes nothing
 *
 * No lockfile, no `package.json`, no file at all is written unless `--out-json` /
 * `--out-md` name one. Every network call is a GET with a timeout and no
 * credentials. The upgrade itself is a separate, atomic, reviewed PR
 * (docs/alur-kerja-pengembangan.md, "Dependency updates"): a report that also
 * upgraded would be the silent mass update the issue forbids.
 *
 * ## Advisory by default, a gate only on request
 *
 * The exit code is 0 however much drift there is. `--strict` exits 1 when the
 * report is not a trustworthy all-clear (an UNKNOWN section, a blocking advisory,
 * a major with no recorded decision, a mismatched Bun pin, a floating image tag,
 * an expired or stale hold). It is meant for the trusted host's weekly run and for
 * a reviewer before an upgrade PR — NOT for `check` and NOT for a `local-ci/*` leg:
 * registry drift appears on days nobody touched the repository, and a gate that
 * reddens on those days stops being believed.
 *
 * ## Offline, and behind a proxy
 *
 * `fetch` and the `bun` subprocesses honour `HTTPS_PROXY` / `NO_PROXY` natively.
 * A request that fails or times out makes its SECTION `unknown`, never the run
 * (`--offline` skips the registry on purpose, for a deterministic local run).
 *
 * Usage:
 *   bun run deps:freshness                     # markdown report on stdout
 *   bun run deps:freshness -- --json           # machine-readable manifest on stdout
 *   bun run deps:freshness -- --out-json m.json --out-md r.md
 *   bun run deps:freshness -- --strict         # exit 1 unless the report is a clean all-clear
 *   bun run deps:freshness -- --offline        # contact no registry; every network section is UNKNOWN
 *   bun run deps:freshness -- --timeout-ms 8000
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { redact } from "./ci/lib/redact.ts";
import { parseAuditExceptions } from "./ci/lib/audit-exceptions.ts";
import {
  UPSTREAM_OWNED_WORKSPACES,
  analyzeHubTags,
  buildManifest,
  buildOverrideRow,
  bunVersionFromReleaseTag,
  classifyDrift,
  countDirectDependencies,
  engineFloor,
  evaluateAdvisories,
  hubRepository,
  isFloating,
  lockedVersion,
  parseAuditOutput,
  parseComposeImages,
  parseDockerfileArgs,
  parseDockerfileImages,
  parseHeldBack,
  parseOutdatedOutput,
  parseToolImages,
  pinnedBunVersion,
  renderMarkdown,
  type AdvisoryData,
  type BunPinData,
  type HubTag,
  type ImageRef,
  type ImageReport,
  type OverrideRow,
  type RawOutdatedRow,
  type Section
} from "./lib/deps-freshness.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_TIMEOUT_MS = 15_000;

/** Files whose container image references this report reads, and how. */
const DOCKERFILES = ["apps/storefront/Dockerfile", "docker/backup/Dockerfile"];
const COMPOSE_FILES = ["compose.yaml", "compose.production.yaml"];
const TOOL_SOURCES = ["tools/ci/runners", "tools/ci/lib"];

type PackageJson = {
  name?: string;
  packageManager?: string;
  engines?: { bun?: string };
  workspaces?: string[];
  overrides?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type Options = { offline: boolean; timeoutMs: number };

function errorText(error: unknown): string {
  // Registry/process errors can echo a URL or header; redact before it reaches a report.
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, relative), "utf8")) as T;
}

function readText(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

// ---------------------------------------------------------------------------
// Network and process plumbing (not unit-tested; everything it feeds is)
// ---------------------------------------------------------------------------

/** GET, read-only, no credentials, bounded by a timeout. */
async function fetchJson(url: string, options: Options): Promise<unknown> {
  if (options.offline) throw new Error("offline mode: the registry was not contacted");

  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(options.timeoutMs),
    headers: { accept: "application/json", "user-agent": "awcms-one-deps-freshness" }
  });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return response.json();
}

async function run(command: string[], options: Options) {
  const proc = Bun.spawn(command, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    // Bounded, and killed rather than left hanging when the registry is unreachable.
    timeout: Math.max(options.timeoutMs * 4, 60_000),
    env: { ...process.env, NO_COLOR: "1" }
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, exitCode: await proc.exited };
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/** The root plus every `apps/*` / `packages/*` member except upstream-owned ones. */
function discoverWorkspaces(): { names: string[]; manifests: PackageJson[] } {
  const root = readJson<PackageJson>("package.json");
  const manifests: PackageJson[] = [root];

  for (const pattern of root.workspaces ?? []) {
    if (!pattern.endsWith("/*")) continue;
    const base = pattern.slice(0, -2);
    for (const entry of readdirSync(path.join(ROOT, base), { withFileTypes: true })) {
      const relative = `${base}/${entry.name}`;
      if (!entry.isDirectory() || UPSTREAM_OWNED_WORKSPACES.includes(relative)) continue;
      if (!existsSync(path.join(ROOT, relative, "package.json"))) continue;
      manifests.push(readJson<PackageJson>(`${relative}/package.json`));
    }
  }

  return { names: manifests.map((manifest) => manifest.name ?? "").filter(Boolean), manifests };
}

async function collectOutdated(options: Options) {
  if (options.offline) {
    return { status: "unknown", reason: "offline mode: the registry was not contacted" } as const;
  }
  try {
    const { names, manifests } = discoverWorkspaces();
    // `--no-cache` so a manifest cached last week cannot make the report say "current".
    const filters = names.flatMap((name) => ["--filter", name]);
    const result = await run(["bun", "outdated", "--no-cache", ...filters], options);
    const combined = `${result.stdout}\n${result.stderr}`;

    if (result.exitCode !== 0 || /^error:/m.test(combined)) {
      const firstError =
        combined.split(/\r?\n/).find((line) => line.startsWith("error:")) ?? `exit ${result.exitCode}`;
      return { status: "unknown", reason: `\`bun outdated\` failed (${errorText(firstError)})` } as const;
    }

    const rows: RawOutdatedRow[] = parseOutdatedOutput(result.stdout);
    const directDependencyCount = manifests.reduce((sum, manifest) => sum + countDirectDependencies(manifest), 0);

    return { status: "ok", data: { directDependencyCount, workspaces: names, rows } } as const;
  } catch (error) {
    return { status: "unknown", reason: errorText(error) } as const;
  }
}

async function collectOverrides(options: Options): Promise<Section<OverrideRow[]>> {
  try {
    const overrides = readJson<PackageJson>("package.json").overrides ?? {};
    const lock = readText("bun.lock");
    const rows: OverrideRow[] = [];

    for (const [name, range] of Object.entries(overrides)) {
      const body = (await fetchJson(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, options)) as {
        version?: unknown;
      };
      if (typeof body.version !== "string") throw new Error(`npm answer for ${name} has no \`version\``);
      rows.push(buildOverrideRow(name, range, lockedVersion(lock, name), body.version));
    }
    return { status: "ok", data: rows };
  } catch (error) {
    return { status: "unknown", reason: errorText(error) };
  }
}

async function collectAdvisories(options: Options): Promise<Section<AdvisoryData>> {
  if (options.offline) return { status: "unknown", reason: "offline mode: the registry was not contacted" };
  try {
    const result = await run(["bun", "audit", "--json"], options);
    // Exit code is not the signal (it is 1 whenever any advisory exists): the body is.
    const report = parseAuditOutput(result.stdout);
    const exceptionsPath = "tools/ci/dependency-audit-exceptions.json";
    const exceptions = existsSync(path.join(ROOT, exceptionsPath))
      ? parseAuditExceptions(readText(exceptionsPath)).map((entry) => entry.advisory)
      : [];
    return { status: "ok", data: evaluateAdvisories(report, exceptions) };
  } catch (error) {
    return { status: "unknown", reason: `\`bun audit --json\` produced no report (${errorText(error)})` };
  }
}

async function collectBun(options: Options): Promise<Section<BunPinData>> {
  const root = readJson<PackageJson>("package.json");
  const pinned = pinnedBunVersion(root.packageManager);
  if (!pinned) return { status: "unknown", reason: "package.json `packageManager` is not `bun@X.Y.Z`" };

  // Offline checks: other places that pin Bun must agree with `packageManager`.
  const mismatches: string[] = [];
  const dockerfileArg = parseDockerfileArgs(readText("apps/storefront/Dockerfile")).BUN_VERSION;
  if (dockerfileArg !== undefined && dockerfileArg !== pinned) {
    mismatches.push(`apps/storefront/Dockerfile \`ARG BUN_VERSION=${dockerfileArg}\` differs from packageManager bun@${pinned}`);
  }

  let latest: string | null = null;
  let latestSource: BunPinData["latestSource"] = "github";
  const failures: string[] = [];

  try {
    const release = (await fetchJson("https://api.github.com/repos/oven-sh/bun/releases/latest", options)) as {
      tag_name?: unknown;
    };
    latest = typeof release.tag_name === "string" ? bunVersionFromReleaseTag(release.tag_name) : null;
    if (latest === null) throw new Error("GitHub's latest-release answer has no `bun-vX.Y.Z` tag");
  } catch (error) {
    failures.push(`GitHub releases: ${errorText(error)}`);
  }

  if (latest === null) {
    try {
      const body = (await fetchJson("https://registry.npmjs.org/bun/latest", options)) as { version?: unknown };
      if (typeof body.version !== "string") throw new Error("npm answer has no `version`");
      latest = body.version;
      latestSource = "npm";
    } catch (error) {
      failures.push(`npm registry: ${errorText(error)}`);
    }
  }

  if (latest === null) {
    return { status: "unknown", reason: `could not read the latest Bun (pinned ${pinned}): ${failures.join("; ")}` };
  }

  return {
    status: "ok",
    data: {
      pinned,
      engineFloor: engineFloor(root.engines?.bun),
      latest,
      latestSource,
      drift: classifyDrift(pinned, latest),
      mismatches,
      note: failures.length > 0 ? `Preferred source skipped — ${failures.join("; ")}.` : null
    }
  };
}

function listSourceFiles(directory: string): string[] {
  const absolute = path.join(ROOT, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute)
    .filter((name) => /\.(ts|mjs)$/.test(name))
    .map((name) => `${directory}/${name}`);
}

function collectImageRefs(): ImageRef[] {
  const refs: ImageRef[] = [];
  for (const file of DOCKERFILES) if (existsSync(path.join(ROOT, file))) refs.push(...parseDockerfileImages(readText(file), file));
  for (const file of COMPOSE_FILES) if (existsSync(path.join(ROOT, file))) refs.push(...parseComposeImages(readText(file), file));
  for (const directory of TOOL_SOURCES) {
    for (const file of listSourceFiles(directory)) refs.push(...parseToolImages(readText(file), file));
  }
  return refs;
}

async function fetchHubTags(repository: string, tag: string | null, options: Options): Promise<HubTag[]> {
  const suffix = tag ? (/^v?\d+(?:\.\d+)*(.*)$/.exec(tag)?.[1] ?? "") : "";
  const name = suffix ? `&name=${encodeURIComponent(suffix)}` : "";
  const base = `https://hub.docker.com/v2/repositories/${repository}/tags`;
  const toTags = (results: unknown): HubTag[] =>
    (Array.isArray(results) ? results : [])
      .map((entry: { name?: unknown; digest?: unknown; last_updated?: unknown; images?: { digest?: unknown }[] }) => ({
        name: typeof entry.name === "string" ? entry.name : "",
        digest: typeof entry.digest === "string" ? entry.digest : null,
        lastUpdated: typeof entry.last_updated === "string" ? entry.last_updated : null,
        imageDigests: (entry.images ?? []).map((image) => image.digest).filter((d): d is string => typeof d === "string")
      }))
      .filter((entry) => entry.name !== "");

  const list = (await fetchJson(`${base}?page_size=100&ordering=last_updated${name}`, options)) as { results?: unknown };
  const tags = toTags(list.results);

  // The pinned tag itself must be present even when it fell off the "recently updated" page.
  if (tag && !tags.some((entry) => entry.name === tag)) {
    const own = await fetchJson(`${base}/${encodeURIComponent(tag)}`, options);
    tags.push(...toTags([own]));
  }
  return tags;
}

async function collectImages(options: Options): Promise<ImageReport[]> {
  const refs = collectImageRefs();
  // One registry round-trip per distinct reference, however many files name it.
  const cache = new Map<string, Promise<ImageReport["result"]>>();

  return Promise.all(
    refs.map(async (ref): Promise<ImageReport> => {
      const floating = isFloating(ref);
      const repository = hubRepository(ref.image);

      if (!repository) {
        return { ...ref, floating, result: { status: "unknown", reason: "not a Docker Hub image; this report only queries Docker Hub" } };
      }

      const key = ref.ref;
      if (!cache.has(key)) {
        cache.set(
          key,
          fetchHubTags(repository, ref.tag, options).then(
            (tags) => analyzeHubTags(ref, tags),
            (error): ImageReport["result"] => ({ status: "unknown", reason: errorText(error) })
          )
        );
      }
      return { ...ref, floating, result: await (cache.get(key) as Promise<ImageReport["result"]>) };
    })
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const timeoutArg = Number(argValue(args, "--timeout-ms"));
  const options: Options = {
    offline: args.includes("--offline"),
    timeoutMs: Number.isFinite(timeoutArg) && timeoutArg > 0 ? timeoutArg : DEFAULT_TIMEOUT_MS
  };

  const [outdated, overrides, advisories, bun, images] = await Promise.all([
    collectOutdated(options),
    collectOverrides(options),
    collectAdvisories(options),
    collectBun(options),
    collectImages(options)
  ]);

  const manifest = buildManifest({
    generatedAt: new Date().toISOString(),
    offline: options.offline,
    bunVersionUsed: Bun.version,
    outdated,
    overrides,
    advisories,
    bun,
    images,
    heldBackEntries: parseHeldBack(readText("tools/deps-held-back.json"))
  });

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const markdown = renderMarkdown(manifest);

  const outJson = argValue(args, "--out-json");
  const outMd = argValue(args, "--out-md");
  if (outJson) writeFileSync(outJson, json);
  if (outMd) writeFileSync(outMd, markdown);

  process.stdout.write(args.includes("--json") ? json : markdown);

  if (args.includes("--strict") && manifest.strictFailures.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
