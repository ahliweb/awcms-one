/**
 * deps-freshness.ts — the pure half of `bun run deps:freshness` (issue #471).
 *
 * Everything here is a function of its arguments: it parses command output and
 * registry answers that the caller already holds, and it renders a report. No
 * network, no process, no clock, no filesystem — which is what lets
 * `tests/deps-freshness.test.mjs` pin every rule with fixtures and no network.
 * The I/O half is `tools/deps-freshness.ts`.
 *
 * Root-owned equivalent of `apps/cms/scripts/dependency-freshness.ts` (upstream
 * `ahliweb/awcms` #1173/#1181). Root code never imports `apps/cms` internals
 * (AGENTS.md, "Workspace boundaries"), so the approach and the output shape are
 * reused, the code is not. What differs from upstream, on purpose:
 *
 * - **Scope.** Root `package.json`, `apps/storefront` and `packages/*` — never
 *   `apps/cms`, whose dependency set upstream owns and reports on itself.
 * - **More than one workspace.** `bun outdated --filter` prints a `Workspace`
 *   column; every row keeps it.
 * - **A disposition per row** (`candidate` / `held` / `needs-decision`), because
 *   the issue asks for "latest verified, locked, candidate, blocked with owner
 *   rationale" rather than a bare list of drift.
 * - **Image sources** are this repo's: the storefront Dockerfile, the compose
 *   files, the backup Dockerfile and the local-ci tool images, including images
 *   pinned by digest alone (gitleaks) whose tag has to be recovered from the
 *   registry.
 * - **The Bun pin** is compared with the latest Bun *release* (GitHub first, npm
 *   as the fallback) and with the Dockerfile's `ARG BUN_VERSION`.
 *
 * ## UNKNOWN is not a pass
 *
 * Every section is fetched independently and any of them can fail. A failed
 * section is `unknown` with its reason, never "no drift": a report that prints
 * "0 outdated" because it could not reach the registry says the same thing as a
 * repository that is fully current, and only one of those is true.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Section<T> = { status: "ok"; data: T } | { status: "unknown"; reason: string };

export type DriftLevel = "current" | "patch" | "minor" | "major" | "unknown";

/**
 * - `candidate`: a patch/minor (or in-range) update exists — the backlog for the
 *   next atomic upgrade PR.
 * - `held`: a newer version exists and the held-back register records why it is
 *   not taken, with an owner and a review date.
 * - `needs-decision`: a MAJOR is available and nobody has recorded a decision.
 *   Majors need an ADR or a hold; this is the one disposition `--strict` fails on.
 * - `current`: nothing newer.
 */
export type Disposition = "current" | "candidate" | "held" | "needs-decision";

export type OutdatedRow = {
  workspace: string;
  name: string;
  /** `bun outdated` marks dev/peer/optional dependencies in the name column. */
  kind: "prod" | "dev" | "peer" | "optional";
  /** The version in `bun.lock`. */
  current: string;
  /** Newest version that still satisfies the range in package.json. */
  update: string;
  /** Newest version on the registry, whatever the range says. */
  latest: string;
  /** current -> latest. */
  drift: DriftLevel;
  /** True when `update` differs from `current`: a plain `bun update` would move it. */
  inRange: boolean;
  disposition: Disposition;
  /** The register's reason, owner and review date when `disposition` is `held`. */
  holdNote: string | null;
};

export type OutdatedData = { directDependencyCount: number; workspaces: string[]; rows: OutdatedRow[] };

export type OverrideRow = {
  name: string;
  /** The range as written in the root `overrides`. */
  range: string;
  /** The version `bun.lock` resolved it to, or null when the lockfile has no top-level entry. */
  locked: string | null;
  latest: string;
  drift: DriftLevel;
};

export type AdvisoryData = {
  /** High/critical advisories with no recorded exception — what the audit gates block on. */
  blocking: string[];
  informationalCount: number;
  exceptionCount: number;
  bySeverity: Record<string, number>;
};

export type BunPinData = {
  pinned: string;
  /** The `engines.bun` floor, informational. */
  engineFloor: string | null;
  latest: string;
  latestSource: "github" | "npm";
  drift: DriftLevel;
  /** Other places that pin Bun and disagree with `package.json`'s `packageManager`. */
  mismatches: string[];
  /** Why the preferred source was skipped, when it was. */
  note: string | null;
};

export type ImageRef = {
  /** Repo-relative file the reference was read from. */
  file: string;
  /** The reference exactly as written, e.g. `oven/bun:1.4.4-slim`. */
  ref: string;
  image: string;
  tag: string | null;
  digest: string | null;
};

export type HubTag = { name: string; digest: string | null; lastUpdated: string | null; imageDigests: string[] };

export type ImageData = {
  /** The tag the reference means: written, or recovered from the pinned digest. */
  currentTag: string | null;
  /** Digest the registry reports for that tag today. */
  registryDigest: string | null;
  lastUpdated: string | null;
  /** Newest tag of the same shape (same suffix), or null when none was found. */
  newestTag: string | null;
  drift: DriftLevel;
};

export type ImageReport = ImageRef & { floating: boolean; result: Section<ImageData> };

export type HeldBackEntry = {
  /** What is held, exactly as the registry or `bun outdated` names it. `bun` is the Bun runtime. */
  packageName: string;
  /** The version (or floor) we stay on. */
  heldVersion: string;
  /** Why the newer version is not safe NOW — what was found, not "risk". */
  reason: string;
  owner: string;
  /** ISO date (YYYY-MM-DD). Re-justify by then or remove. */
  reviewDate: string;
};

export type HeldBackStatus = "active" | "expired" | "stale" | "unverified";

export type HeldBackEvaluation = { entry: HeldBackEntry; status: HeldBackStatus; latest: string | null; note: string };

export type FreshnessManifest = {
  generatedAt: string;
  /** Fixed text: this manifest is the output of a read-only command. */
  mode: "read-only";
  offline: boolean;
  bunVersionUsed: string;
  outdated: Section<OutdatedData>;
  overrides: Section<OverrideRow[]>;
  advisories: Section<AdvisoryData>;
  bun: Section<BunPinData>;
  images: ImageReport[];
  heldBack: HeldBackEvaluation[];
  unknownSections: string[];
  strictFailures: string[];
};

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export type Semver = { major: number; minor: number; patch: number; prerelease: string | null };

export function parseSemver(version: string): Semver | null {
  const match = SEMVER.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null
  };
}

/** -1 / 0 / 1, or null when either side is not a semver. Prereleases sort below their release. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/** How far `current` is behind `latest`. Ahead-of-latest is `current` (a pinned canary is not drift). */
export function classifyDrift(current: string, latest: string): DriftLevel {
  const left = parseSemver(current);
  const right = parseSemver(latest);
  if (!left || !right) return "unknown";
  if (compareVersions(current, latest) !== -1) return "current";
  if (left.major !== right.major) return "major";
  if (left.minor !== right.minor) return "minor";
  return "patch";
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/**
 * Workspaces this report never scans. `apps/cms` is `ahliweb/awcms` embedded via
 * `git subtree`: upstream owns its dependency set and ships its own
 * `deps:freshness`, and a root report that listed its drift would invite exactly
 * the version-update PR against the subtree that AGENTS.md forbids.
 */
export const UPSTREAM_OWNED_WORKSPACES: readonly string[] = ["apps/cms"];

/** `dependencies` + `devDependencies` + `optionalDependencies` that are real registry packages. */
export function countDirectDependencies(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): number {
  return [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]
    .flatMap((group) => Object.values(group ?? {}))
    .filter((range) => !range.startsWith("workspace:")).length;
}

// ---------------------------------------------------------------------------
// bun outdated
// ---------------------------------------------------------------------------

const TABLE_RULE = /^\|[-|]+\|$/;
const KIND_SUFFIX = /\s+\((dev|peer|optional)\)\s*$/;

export type RawOutdatedRow = Omit<OutdatedRow, "disposition" | "holdNote">;

/**
 * Parses the box-drawn table `bun outdated --filter …` prints (Bun 1.4.4 has no
 * `--json` for it, so the table is the contract). It throws on anything that is
 * not that table or the bare banner: a format change has to surface as UNKNOWN,
 * never as an empty — and therefore "all current" — report.
 *
 * A banner with no table at all means nothing is outdated.
 */
export function parseOutdatedOutput(stdout: string): RawOutdatedRow[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  const tableLines = lines.filter((line) => line.startsWith("|"));
  const otherLines = lines.filter((line) => !line.startsWith("|") && !/^bun outdated v\S+/.test(line));

  if (otherLines.length > 0) {
    throw new Error(`unexpected output from \`bun outdated\`: ${otherLines[0]?.slice(0, 200)}`);
  }
  if (tableLines.length === 0) return [];

  const rows: RawOutdatedRow[] = [];
  let sawHeader = false;

  for (const line of tableLines) {
    if (TABLE_RULE.test(line)) continue;

    const cells = line
      .slice(1, line.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());

    if (cells.length !== 5) throw new Error(`unexpected \`bun outdated\` row: ${line.slice(0, 200)}`);

    const [rawName, current, update, latest, workspace] = cells as [string, string, string, string, string];

    if (rawName === "Package") {
      if (current !== "Current" || update !== "Update" || latest !== "Latest" || workspace !== "Workspace") {
        throw new Error(`unexpected \`bun outdated\` header: ${line}`);
      }
      sawHeader = true;
      continue;
    }
    if (!sawHeader) throw new Error("`bun outdated` table has no header row.");

    const kindMatch = KIND_SUFFIX.exec(rawName);
    rows.push({
      workspace,
      name: rawName.replace(KIND_SUFFIX, ""),
      kind: (kindMatch?.[1] ?? "prod") as OutdatedRow["kind"],
      current,
      update,
      latest,
      drift: classifyDrift(current, latest),
      inRange: update !== current
    });
  }

  if (!sawHeader) throw new Error("`bun outdated` table has no header row.");
  return rows;
}

/**
 * Decide what each drifting row means. A row whose *range-reachable* version
 * (`update`) is already within a minor of `latest` is a candidate for the next
 * atomic PR; a gap of a whole major between what the range allows and what the
 * registry ships needs a human decision, and "held" is that decision on record.
 */
export function assignDispositions(rows: readonly RawOutdatedRow[], held: readonly HeldBackEvaluation[]): OutdatedRow[] {
  return rows.map((row) => {
    const hold = held.find((entry) => entry.entry.packageName === row.name && entry.status !== "stale");

    if (row.drift === "current") return { ...row, disposition: "current", holdNote: null };

    if (hold) {
      return {
        ...row,
        disposition: "held",
        holdNote: `${hold.entry.reason} (owner ${hold.entry.owner}, review by ${hold.entry.reviewDate})`
      };
    }

    const gap = classifyDrift(row.update, row.latest);
    return { ...row, disposition: gap === "major" ? "needs-decision" : "candidate", holdNote: null };
  });
}

// ---------------------------------------------------------------------------
// Root overrides
// ---------------------------------------------------------------------------

/** The version `bun.lock` resolved a top-level package to, or null when it has no such entry. */
export function lockedVersion(lockText: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = new RegExp(`^\\s+"${escaped}": \\["${escaped}@([^"]+)"`, "m").exec(lockText);
  return match?.[1] ?? null;
}

/** `^0.35.5` / `~1.2.3` / `1.2.3` / `>=1.2.3` -> `0.35.5`. Anything stranger is null. */
export function rangeFloor(range: string): string | null {
  const match = /^(?:[\^~]|>=)?\s*(\d+\.\d+\.\d+)$/.exec(range.trim());
  return match?.[1] ?? null;
}

export function buildOverrideRow(name: string, range: string, locked: string | null, latest: string): OverrideRow {
  const basis = locked ?? rangeFloor(range);
  return { name, range, locked, latest, drift: basis ? classifyDrift(basis, latest) : "unknown" };
}

// ---------------------------------------------------------------------------
// bun audit
// ---------------------------------------------------------------------------

export type AuditAdvisory = { id?: unknown; url?: unknown; title?: unknown; severity?: unknown };
export type AuditReport = Record<string, AuditAdvisory[]>;

/** Parses `bun audit --json` stdout. Throws on anything that is not a report. */
export function parseAuditOutput(stdout: string): AuditReport {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) throw new Error("`bun audit --json` printed nothing");

  // Bun can prefix stdout with banner lines; the report is the JSON object.
  const start = trimmed.indexOf("{");
  if (start === -1) throw new Error(`output is not JSON: ${trimmed.slice(0, 200)}`);

  const parsed: unknown = JSON.parse(trimmed.slice(start));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("output is not a report object");
  }
  return parsed as AuditReport;
}

/**
 * Same blocking rule the audit gates apply (`bun audit --audit-level=low` in the
 * check/security legs, with `tools/ci/dependency-audit-exceptions.json`): a
 * high/critical advisory without a recorded exception blocks; the rest is
 * informational. Reported here so the freshness report and the gates cannot
 * disagree about what is blocking.
 */
export function evaluateAdvisories(report: AuditReport, exceptedAdvisories: readonly string[]): AdvisoryData {
  const excepted = new Set(exceptedAdvisories.map((id) => id.toLowerCase()));
  const bySeverity: Record<string, number> = {};
  const blocking: string[] = [];
  let informationalCount = 0;

  for (const [packageName, advisories] of Object.entries(report)) {
    if (!Array.isArray(advisories)) continue;
    for (const advisory of advisories) {
      const severity = typeof advisory.severity === "string" ? advisory.severity.toLowerCase() : "unknown";
      bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;

      const url = typeof advisory.url === "string" ? advisory.url : "";
      const isExcepted = [...excepted].some((id) => url.toLowerCase().includes(id));
      const title = typeof advisory.title === "string" ? advisory.title : "advisory";

      if ((severity === "high" || severity === "critical") && !isExcepted) {
        blocking.push(`${packageName}: [${severity}] ${title}${url ? ` (${url})` : ""}`);
      } else {
        informationalCount += 1;
      }
    }
  }

  return { blocking, informationalCount, exceptionCount: excepted.size, bySeverity };
}

// ---------------------------------------------------------------------------
// Bun release
// ---------------------------------------------------------------------------

/** `bun-v1.4.4` (the tag `oven-sh/bun` releases carry) -> `1.4.4`; null for anything else. */
export function bunVersionFromReleaseTag(tag: string): string | null {
  const match = /^bun-v(\d+\.\d+\.\d+)$/.exec(tag.trim());
  return match?.[1] ?? null;
}

/** The exact version `packageManager` pins: `bun@1.4.4` -> `1.4.4`. */
export function pinnedBunVersion(packageManager: string | undefined): string | null {
  const match = /^bun@(\d+\.\d+\.\d+)$/.exec((packageManager ?? "").trim());
  return match?.[1] ?? null;
}

/** `>=1.4.4` -> `1.4.4`. */
export function engineFloor(range: string | undefined): string | null {
  const match = /^>=\s*(\d+\.\d+\.\d+)$/.exec((range ?? "").trim());
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Container images
// ---------------------------------------------------------------------------

/** `[registry/]name[:tag][@sha256:digest]`. A colon only starts a tag after the last slash. */
export function parseImageReference(ref: string): { image: string; tag: string | null; digest: string | null } | null {
  const at = ref.indexOf("@");
  const digest = at === -1 ? null : ref.slice(at + 1);
  const nameAndTag = at === -1 ? ref : ref.slice(0, at);

  if (digest !== null && !/^sha256:[0-9a-f]{64}$/.test(digest)) return null;

  const lastSlash = nameAndTag.lastIndexOf("/");
  const colon = nameAndTag.indexOf(":", lastSlash + 1);
  const image = colon === -1 ? nameAndTag : nameAndTag.slice(0, colon);
  const tag = colon === -1 ? null : nameAndTag.slice(colon + 1);

  if (!/^(?:[a-z0-9][a-z0-9.-]*(?::\d+)?\/)*[a-z0-9][a-z0-9._-]*$/.test(image)) return null;
  if (tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(tag)) return null;

  return { image, tag, digest };
}

function toImageRef(file: string, ref: string): ImageRef | null {
  const parsed = parseImageReference(ref);
  return parsed ? { file, ref, ...parsed } : null;
}

/** `ARG NAME=default` lines that appear before the first `FROM` (the only ones `FROM` can use). */
export function parseDockerfileArgs(text: string): Record<string, string> {
  const args: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^FROM\s/i.test(trimmed)) break;
    const match = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s*$/i.exec(trimmed);
    if (match) args[match[1] as string] = (match[2] as string).replace(/^["']|["']$/g, "");
  }
  return args;
}

function substitute(source: string, args: Record<string, string>): string {
  return source.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced, bare) => {
    const value = args[(braced ?? bare) as string];
    return value === undefined ? whole : value;
  });
}

/**
 * `FROM <image>` lines that name a registry image — not a build stage, not
 * `scratch`, not something still holding an unresolved `$VARIABLE`. `ARG`
 * defaults declared before the first `FROM` are substituted, because
 * `FROM oven/bun:${BUN_VERSION}` is the storefront Dockerfile's whole point.
 */
export function parseDockerfileImages(text: string, file: string): ImageRef[] {
  const args = parseDockerfileArgs(text);
  const stages = new Set<string>();
  const refs: ImageRef[] = [];

  for (const line of text.split(/\r?\n/)) {
    const match = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line.trim());
    if (!match) continue;

    const source = substitute(match[1] as string, args);
    const alias = match[2];
    if (alias) stages.add(alias.toLowerCase());

    if (source.toLowerCase() === "scratch" || stages.has(source.toLowerCase()) || source.includes("$")) continue;
    const ref = toImageRef(file, source);
    if (ref) refs.push(ref);
  }
  return refs;
}

/**
 * Literal `image:` values of a compose file. A value that interpolates a
 * variable (`${AWCMS_ONE_CMS_IMAGE:-awcms-one/cms:latest}`) is skipped: it is a
 * local build name the operator overrides, not a pin on a published image.
 */
export function parseComposeImages(text: string, file: string): ImageRef[] {
  const refs: ImageRef[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*image:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/.exec(line);
    if (!match || (match[1] as string).includes("$")) continue;
    const ref = toImageRef(file, match[1] as string);
    if (ref) refs.push(ref);
  }
  return refs;
}

/**
 * Quoted image references in a tool's source — `"postgres:18.4"`,
 * `"docker.io/zricethezav/gitleaks@sha256:…"`. A string only counts when it is
 * unmistakably an image: a digest, or a tag starting with a digit, on a name that
 * has a letter in it (so `"5432:5432"` and `"127.0.0.1:5433"` do not) and is not
 * `localhost`. Comment lines are ignored. Only files that mention `docker` are
 * read, which keeps `host:8080` strings in unrelated runners out.
 */
export function parseToolImages(text: string, file: string): ImageRef[] {
  if (!/docker/i.test(text)) return [];

  const refs: ImageRef[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    for (const match of line.matchAll(/["']([^"'\s$`]+)["']/g)) {
      const candidate = match[1] as string;
      if (seen.has(candidate)) continue;

      const parsed = parseImageReference(candidate);
      if (!parsed) continue;

      const finalSegment = parsed.image.split("/").pop() as string;
      const looksLikeImage =
        (parsed.digest !== null || (parsed.tag !== null && /^\d/.test(parsed.tag))) &&
        /[a-z]/.test(finalSegment) &&
        finalSegment !== "localhost" &&
        /^[a-z]/.test(parsed.image);
      if (!looksLikeImage) continue;

      seen.add(candidate);
      refs.push({ file, ref: candidate, ...parsed });
    }
  }
  return refs;
}

/** A tag that moves under the operator: no tag at all, or `latest`. A digest pins it regardless. */
export function isFloating(ref: Pick<ImageRef, "tag" | "digest">): boolean {
  if (ref.digest !== null) return false;
  return ref.tag === null || ref.tag === "latest";
}

/** Docker Hub repository for an image name, or null for any other registry. */
export function hubRepository(image: string): string | null {
  const parts = image.split("/");
  if (parts[0] === "docker.io" || parts[0] === "index.docker.io") parts.shift();
  if (parts.length > 1 && /[.:]/.test(parts[0] as string)) return null;
  return parts.length === 1 ? `library/${parts[0]}` : parts.join("/");
}

const TAG_SHAPE = /^(\d+(?:\.\d+)*)(.*)$/;

function compareParts(a: readonly number[], b: readonly number[]): -1 | 0 | 1 {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Newest tag of the same shape as `currentTag` (same non-numeric suffix, so
 * `1.4.4-slim` is compared only with other `-slim` tags) from a tag list. Tags
 * with fewer segments (`18`, `1.4`) take part: `19` is a real major signal.
 */
export function pickNewestTag(tags: readonly string[], currentTag: string): string | null {
  const current = TAG_SHAPE.exec(currentTag);
  if (!current) return null;

  const suffix = current[2] ?? "";
  let best: { tag: string; parts: number[] } | null = null;

  for (const tag of tags) {
    const match = TAG_SHAPE.exec(tag);
    if (!match || (match[2] ?? "") !== suffix) continue;

    const parts = (match[1] as string).split(".").map(Number);
    if (!best || compareParts(parts, best.parts) === 1) best = { tag, parts };
  }
  return best?.tag ?? null;
}

/** Drift between two numeric tags (`18.4` -> `18.5` is minor, `18.4` -> `19` is major). */
export function classifyTagDrift(currentTag: string, newestTag: string): DriftLevel {
  const current = TAG_SHAPE.exec(currentTag);
  const newest = TAG_SHAPE.exec(newestTag);
  if (!current || !newest) return "unknown";

  const a = (current[1] as string).split(".").map(Number);
  const b = (newest[1] as string).split(".").map(Number);

  if (compareParts(a, b) !== -1) return "current";
  if ((a[0] ?? 0) !== (b[0] ?? 0)) return "major";
  if ((a[1] ?? 0) !== (b[1] ?? 0)) return "minor";
  return "patch";
}

/**
 * Given the tag list Docker Hub returned for a repository, say where `ref`
 * stands. For a tag-pinned image the tag is the reference's own; for an image
 * pinned by digest alone (gitleaks) the tag is *recovered* — the most specific
 * numeric tag whose digest equals the pinned one — because "which release is
 * this digest" is exactly what a reviewer needs and the digest does not say.
 */
export function analyzeHubTags(ref: ImageRef, tags: readonly HubTag[]): Section<ImageData> {
  let currentTag = ref.tag;

  if (ref.digest !== null) {
    const matched = tags.filter((tag) => tag.digest === ref.digest || tag.imageDigests.includes(ref.digest as string));
    const numeric = matched
      .map((tag) => tag.name)
      .filter((name) => TAG_SHAPE.test(name) || /^v\d/.test(name))
      .sort((a, b) => b.length - a.length);
    currentTag = ref.tag ?? numeric[0] ?? null;

    if (matched.length === 0) {
      return {
        status: "unknown",
        reason: `the pinned digest is not among the ${tags.length} most recently updated tags on the registry`
      };
    }
  }

  if (currentTag === null) {
    return { status: "unknown", reason: "no tag to compare against" };
  }

  const comparable = (name: string) => name.replace(/^v/, "");
  const names = tags.map((tag) => tag.name);
  const prefixV = currentTag.startsWith("v");
  const newest = pickNewestTag(
    names.filter((name) => name.startsWith("v") === prefixV).map(comparable),
    comparable(currentTag)
  );
  const newestTag = newest === null ? null : prefixV ? `v${newest}` : newest;
  const own = tags.find((tag) => tag.name === currentTag);

  return {
    status: "ok",
    data: {
      currentTag,
      registryDigest: own?.digest ?? (ref.digest !== null ? ref.digest : null),
      lastUpdated: own?.lastUpdated ?? null,
      newestTag,
      drift: newestTag ? classifyTagDrift(comparable(currentTag), comparable(newestTag)) : "unknown"
    }
  };
}

// ---------------------------------------------------------------------------
// Held-back register
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse and validate `tools/deps-held-back.json`. An unparseable register must
 * never be read as "no holds" — every drifting major would then look undecided —
 * nor as "hold everything", so a malformed entry throws.
 */
export function parseHeldBack(text: string): HeldBackEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("deps-held-back.json must be a JSON array");

  return parsed.map((raw, index) => {
    const entry = raw as Partial<HeldBackEntry>;
    const where = `deps-held-back.json[${index}]`;

    for (const field of ["packageName", "owner"] as const) {
      if (typeof entry[field] !== "string" || entry[field]!.trim() === "") {
        throw new Error(`${where}: ${field} must be a non-empty string`);
      }
    }
    if (typeof entry.heldVersion !== "string" || parseSemver(entry.heldVersion) === null) {
      throw new Error(`${where}: heldVersion must be an exact semver`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 40) {
      throw new Error(`${where}: reason must say what was found and why the newer version is not safe now (>= 40 chars)`);
    }
    if (
      typeof entry.reviewDate !== "string" ||
      !ISO_DATE.test(entry.reviewDate) ||
      Number.isNaN(Date.parse(entry.reviewDate))
    ) {
      throw new Error(`${where}: reviewDate must be an ISO date (YYYY-MM-DD)`);
    }
    return entry as HeldBackEntry;
  });
}

/**
 * `resolveLatest` answers "what is the newest version of this?" — a version
 * string, `"current"` when the dependency is known to be fully up to date, or
 * `undefined` when that could not be established (the registry section was
 * UNKNOWN). Pure, so the tests feed it a table.
 */
export function evaluateHeldBack(
  entries: readonly HeldBackEntry[],
  today: string,
  resolveLatest: (packageName: string) => string | "current" | undefined
): HeldBackEvaluation[] {
  return entries.map((entry) => {
    const latest = resolveLatest(entry.packageName);

    if (entry.reviewDate < today) {
      return {
        entry,
        status: "expired",
        latest: latest && latest !== "current" ? latest : null,
        note: `review date ${entry.reviewDate} has passed — re-justify with a new date or remove the entry`
      };
    }
    if (latest === undefined) {
      return {
        entry,
        status: "unverified",
        latest: null,
        note: "the registry could not be reached, so whether the hold is still behind is unknown"
      };
    }
    if (latest === "current") {
      return {
        entry,
        status: "stale",
        latest: null,
        note: "the dependency is no longer behind the registry — remove the entry"
      };
    }

    const order = compareVersions(entry.heldVersion, latest);
    if (order !== null && order >= 0) {
      return {
        entry,
        status: "stale",
        latest,
        note: `held ${entry.heldVersion} is not behind latest ${latest} — remove the entry`
      };
    }
    return { entry, status: "active", latest, note: `held at ${entry.heldVersion}, latest ${latest}` };
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export type ManifestInput = {
  generatedAt: string;
  offline: boolean;
  bunVersionUsed: string;
  outdated: Section<{ directDependencyCount: number; workspaces: string[]; rows: RawOutdatedRow[] }>;
  overrides: Section<OverrideRow[]>;
  advisories: Section<AdvisoryData>;
  bun: Section<BunPinData>;
  images: ImageReport[];
  heldBackEntries: readonly HeldBackEntry[];
};

export function buildManifest(input: ManifestInput): FreshnessManifest {
  const today = input.generatedAt.slice(0, 10);
  const rawRows = input.outdated.status === "ok" ? input.outdated.data.rows : null;

  const heldBack = evaluateHeldBack(input.heldBackEntries, today, (packageName) => {
    if (packageName === "bun") return input.bun.status === "ok" ? input.bun.data.latest : undefined;
    if (!rawRows) return undefined;
    // The highest `latest` across workspaces; a package `bun outdated` does not list is up to date.
    const latests = rawRows.filter((row) => row.name === packageName).map((row) => row.latest);
    if (latests.length === 0) return "current";
    return latests.reduce((best, version) => (compareVersions(version, best) === 1 ? version : best));
  });

  const outdated: Section<OutdatedData> =
    input.outdated.status === "ok"
      ? {
          status: "ok",
          data: { ...input.outdated.data, rows: assignDispositions(input.outdated.data.rows, heldBack) }
        }
      : input.outdated;

  const unknownSections: string[] = [];
  const strictFailures: string[] = [];

  const note = (label: string, section: Section<unknown>) => {
    if (section.status === "unknown") {
      unknownSections.push(label);
      strictFailures.push(`${label}: UNKNOWN — ${section.reason}`);
    }
  };

  note("bun outdated", outdated);
  note("root overrides", input.overrides);
  note("bun audit", input.advisories);
  note("Bun pin vs latest release", input.bun);
  for (const image of input.images) note(`image ${image.ref} (${image.file})`, image.result);

  if (outdated.status === "ok") {
    for (const row of outdated.data.rows) {
      if (row.disposition === "needs-decision") {
        strictFailures.push(
          `${row.workspace}: ${row.name} ${row.current} -> ${row.latest} is a major with no decision — open the upgrade PR/ADR or record a hold in tools/deps-held-back.json`
        );
      }
    }
  }
  if (input.advisories.status === "ok") {
    for (const violation of input.advisories.data.blocking) strictFailures.push(`advisory: ${violation}`);
  }
  if (input.bun.status === "ok") {
    for (const mismatch of input.bun.data.mismatches) strictFailures.push(`Bun pin: ${mismatch}`);
  }
  for (const image of input.images) {
    if (image.floating) {
      strictFailures.push(`image ${image.ref} (${image.file}): floating tag — pin an exact version (and a digest where it is a tool image)`);
    }
  }
  for (const entry of heldBack) {
    if (entry.status === "expired" || entry.status === "stale") {
      strictFailures.push(`held-back ${entry.entry.packageName}: ${entry.status} — ${entry.note}`);
    }
  }

  return {
    generatedAt: input.generatedAt,
    mode: "read-only",
    offline: input.offline,
    bunVersionUsed: input.bunVersionUsed,
    outdated,
    overrides: input.overrides,
    advisories: input.advisories,
    bun: input.bun,
    images: input.images,
    heldBack,
    unknownSections,
    strictFailures
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function unknownLine(reason: string): string {
  return `**UNKNOWN** — ${reason}. This is NOT a pass: the check did not run.`;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderMarkdown(manifest: FreshnessManifest): string {
  const out: string[] = [];

  out.push("# Dependency freshness report");
  out.push("");
  out.push(
    `Generated ${manifest.generatedAt} with Bun ${manifest.bunVersionUsed}` +
      (manifest.offline ? " (offline: no registry was contacted)" : "") +
      ". Read-only: nothing was installed, upgraded or written. " +
      "Scope: root `package.json`, `apps/storefront`, `packages/*`, the Bun pin and the container images; `apps/cms` is upstream's (`ahliweb/awcms`). " +
      "An UNKNOWN section means that check could not run — it is never a pass."
  );
  out.push("");

  out.push("## Direct dependencies (`bun outdated`)");
  out.push("");
  if (manifest.outdated.status === "unknown") {
    out.push(unknownLine(manifest.outdated.reason));
  } else {
    const { rows, directDependencyCount, workspaces } = manifest.outdated.data;
    out.push(
      `${rows.length} of ${directDependencyCount} direct dependencies are behind the registry (workspaces: ${workspaces.join(", ")}).`
    );
    if (rows.length > 0) {
      out.push("");
      out.push("| Workspace | Package | Kind | Locked | In-range update | Latest | Drift | Disposition |");
      out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const row of rows) {
        out.push(
          `| ${cell(row.workspace)} | ${cell(row.name)} | ${row.kind} | ${row.current} | ${row.inRange ? row.update : "—"} | ${row.latest} | ${row.drift} | ${row.disposition}${row.holdNote ? ` — ${cell(row.holdNote)}` : ""} |`
        );
      }
    }
  }
  out.push("");

  out.push("## Root `overrides`");
  out.push("");
  if (manifest.overrides.status === "unknown") {
    out.push(unknownLine(manifest.overrides.reason));
  } else if (manifest.overrides.data.length === 0) {
    out.push("No overrides.");
  } else {
    out.push("| Package | Range | Locked | Latest | Drift |");
    out.push("| --- | --- | --- | --- | --- |");
    for (const row of manifest.overrides.data) {
      out.push(`| ${row.name} | \`${row.range}\` | ${row.locked ?? "—"} | ${row.latest} | ${row.drift} |`);
    }
  }
  out.push("");

  out.push("## Advisories (`bun audit`, whole lockfile)");
  out.push("");
  if (manifest.advisories.status === "unknown") {
    out.push(unknownLine(manifest.advisories.reason));
  } else {
    const data = manifest.advisories.data;
    const severities = Object.entries(data.bySeverity)
      .map(([severity, count]) => `${count} ${severity}`)
      .join(", ");
    out.push(
      data.blocking.length === 0
        ? `No unhandled high/critical advisory (${data.exceptionCount} registered exception(s)). ` +
            (severities ? `All advisories: ${severities}.` : "No advisories at all.")
        : `${data.blocking.length} blocking finding(s):`
    );
    for (const violation of data.blocking) out.push(`- ${violation}`);
  }
  out.push("");

  out.push("## Bun runtime pin");
  out.push("");
  if (manifest.bun.status === "unknown") {
    out.push(unknownLine(manifest.bun.reason));
  } else {
    const { pinned, latest, latestSource, drift, engineFloor: floor, mismatches, note: sourceNote } = manifest.bun.data;
    out.push(`Pinned \`${pinned}\` (\`packageManager\`), latest Bun release \`${latest}\` (${latestSource}) — drift: ${drift}.`);
    if (floor) out.push(`\`engines.bun\` floor: \`>=${floor}\`.`);
    if (sourceNote) out.push(sourceNote);
    for (const mismatch of mismatches) out.push(`- MISMATCH: ${mismatch}`);
  }
  out.push("");

  out.push("## Container images");
  out.push("");
  if (manifest.images.length === 0) {
    out.push("No image references found.");
  } else {
    out.push("| File | Reference | Resolved tag | Newest same-shape tag | Drift | Floating |");
    out.push("| --- | --- | --- | --- | --- | --- |");
    for (const image of manifest.images) {
      const shown = `\`${cell(image.ref.length > 60 ? `${image.ref.slice(0, 40)}…${image.ref.slice(-12)}` : image.ref)}\``;
      if (image.result.status === "unknown") {
        out.push(`| ${image.file} | ${shown} | **UNKNOWN** | ${cell(image.result.reason)} | — | ${image.floating ? "yes" : "no"} |`);
        continue;
      }
      const data = image.result.data;
      out.push(
        `| ${image.file} | ${shown} | ${data.currentTag ?? "unknown"} | ${data.newestTag ?? "unknown"} | ${data.drift} | ${image.floating ? "yes" : "no"} |`
      );
    }
  }
  out.push("");

  out.push("## Held-back register (`tools/deps-held-back.json`)");
  out.push("");
  if (manifest.heldBack.length === 0) {
    out.push("No entries.");
  } else {
    out.push("| Package | Held | Latest | Status | Owner | Review by | Note |");
    out.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const entry of manifest.heldBack) {
      out.push(
        `| ${entry.entry.packageName} | ${entry.entry.heldVersion} | ${entry.latest ?? "unknown"} | ${entry.status} | ${entry.entry.owner} | ${entry.entry.reviewDate} | ${cell(entry.note)} |`
      );
    }
  }
  out.push("");

  out.push("## Verdict");
  out.push("");
  if (manifest.strictFailures.length === 0) {
    out.push("Nothing blocks and every check ran. Drift above is the backlog for atomic upgrade PRs.");
  } else {
    out.push("Needs attention (`--strict` fails on these):");
    for (const failure of manifest.strictFailures) out.push(`- ${failure}`);
  }
  out.push("");

  return out.join("\n");
}
