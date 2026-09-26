#!/usr/bin/env bun
/**
 * audit-dokumen.mjs — checks the markdown in this repo, not build output.
 *
 * ## Why this gate exists
 *
 * Nothing else in a Bun/Astro/PostgreSQL stack ever builds markdown, so
 * nothing else ever notices when it lies. A content or type-check gate
 * reads source code and build output; the documents that describe this
 * repo's own decisions — `AGENTS.md`, an ADR, a changeset — sit entirely
 * outside that path. A dead link inside one of them sends a reader (human
 * or agent) to a decision that does not exist, and nothing goes red.
 *
 * This mechanism is adapted from `ahliweb/media-lenterakalteng`'s
 * `packages/gerbang/audit-dokumen.mjs`, which was written after that repo's
 * own ADR index was found listing six decisions that had never existed
 * there while missing nine that did — a state that survived nine further
 * ADRs with nothing catching it, for exactly the reason above. This repo
 * has no `docs/adr/` yet and so no comparable incident of its own; the
 * checks below that depend on one (§2, §3, §5) simply report themselves
 * skipped until it exists, rather than being left out and re-added later
 * under the same pressure that let the original defect stand for months.
 *
 * ## What is checked
 *
 *   1. **Dead relative links.** Every markdown link to a file in this repo
 *      must actually resolve. Resolved from the location of the file that
 *      contains it, which is what makes `.changesets/README.md`'s own rule
 *      ("links are written from `.changesets/`'s point of view") hold with
 *      no special case.
 *   2. **The ADR index is complete in both directions, with no duplicate
 *      rows** — once `docs/adr/` exists. Checked both ways because one
 *      direction alone is not enough: an ADR missing from the table and a
 *      table row pointing at a file that does not exist are two different
 *      defects, and a duplicated row can pass both checks at once (two rows
 *      for one file is still one file on each side) unless rows themselves
 *      are counted, not merely collected into a set.
 *   3. **The index's stated status agrees with the ADR file's own status.**
 *      An unrecognised status word is reported, not silently accepted.
 *   4. **File paths a document names in backticks must exist.** Not links —
 *      a code span like `` `packages/gerbang/lib/git.mjs` ``. Documents in
 *      this repo name files far more often than they link to them, and a
 *      path that used to exist, or is planned but not yet built, reads
 *      exactly like one that does unless something checks. Paths that
 *      genuinely belong to another repo, or describe a workspace this repo
 *      has not built yet, are listed in `EXCLUDED_PATHS` below together
 *      with who they belong to and (where the reason is specific to one
 *      document rather than the whole corpus) which document may cite them.
 *   5. **`ADR-NNNN` citations resolve to their file** — once `docs/adr/`
 *      exists. A citation of another repo's ADR is written with a marker
 *      (`awcms`, "reference repo", or a github link) in the same paragraph
 *      and is skipped; one with neither a local file nor a marker is a
 *      citation to nowhere, the same defect class as a dead link in a form
 *      that never became a link.
 *   6. **Numbers stated in prose agree with the set they claim to count.**
 *      Not every spelled-out number — most do not count anything that
 *      grows. Only a block the author marks explicitly:
 *      `<!-- hitung:mulai key=<slug> source=<spec> --> … <!-- hitung:selesai -->`,
 *      with `source` either `table-rows` (markdown table body rows inside
 *      the block) or `match:<path>:<regex>` (the count of unique capture-1
 *      values of that regex over another file in this repo). Every spelled
 *      number inside a marked block must agree with that count, and a
 *      marked block containing no spelled number at all is reported, not
 *      passed — a marker that guards nothing will rot exactly like the
 *      unmarked prose it was meant to replace.
 *
 * ## What is deliberately NOT checked
 *
 *   - **External URLs.** Checking them needs a network, and a gate that
 *     fails because a third-party site is down is a gate people learn to
 *     ignore.
 *   - **Anchors (`#section`).** Heading slugification differs across
 *     renderers, so checking it means guessing GitHub's own rule. The file
 *     part of an anchored link is still checked; the anchor is discarded.
 *   - **Spelled numbers with no `hitung:` marker.** Deliberate, for the same
 *     reason the marker exists at all: a gate that reddens on every spelled
 *     number is a gate people learn to work around, which is worse than no
 *     gate.
 *   - **`apps/cms/**`.** `ahliweb/awcms`'s own markdown corpus, imported
 *     whole via `git subtree` — its relative links, its own ADR
 *     conventions (a different numbering scheme from this repo's), and its
 *     own `ADR-NNNN` citations are all written for its own tree, not for
 *     sitting under `apps/cms/`. Checking it here would report hundreds of
 *     "violations" that are correct in the tree they were written for. It
 *     has its own gates (`bun run check:cms`).
 *
 * Run: `bun run audit:dokumen`. Needs no build, no network, no `apps/cms`.
 *
 * The first optional argument is the root to check (default `.`), which is
 * what lets `tests/audit-dokumen.test.mjs` run this over a fixture tree and
 * prove each check actually goes red when its defect is reproduced.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { createReporter } from "./lib/reporter.mjs";

const ROOT = process.argv[2] ?? ".";

// Validated before the reporter is built, so an unusable root exits 2 with
// only its own message — the header belongs to a gate that is going to run.
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) {
  console.error(`root "${ROOT}" is not a directory`);
  process.exit(2);
}

const reporter = createReporter("audit:dokumen");

/** Directories never read: not source, or not this repo's own. */
const SKIP = new Set([
  "node_modules",
  ".git",
  ".astro",
  "dist",
  "graphify-out",
  // `.claude/worktrees/<name>` is a PARALLEL git worktree checkout belonging
  // to another agent (a multi-agent session) — its content is not this
  // repo's own documentation and may be at a different point of edit at any
  // moment. Already gitignored; a `git ls-files`-based gate would never see
  // it, but this file walks the filesystem directly and does not honour
  // `.gitignore`, so it is excluded explicitly here too.
  "worktrees"
]);

/**
 * Directories skipped by FULL PATH (relative to `ROOT`), not by name —
 * different from `SKIP` above because "cms" as a bare NAME is too loose to
 * exclude wherever it appears.
 *
 * `apps/cms` is `ahliweb/awcms`, imported whole via `git subtree` — a
 * markdown corpus that belongs to `awcms`: its relative links, its ADR
 * index (a numbering scheme separate from this repo's own), and its
 * `ADR-NNNN` citations are all written for the `awcms` tree, not for
 * sitting under `apps/cms/`. Checking it here would report hundreds of
 * "violations" that are correct in the tree they were actually written
 * for — precisely the failure class `EXCLUDED_PATHS` below exists to
 * prevent, one level higher (a directory, rather than one path). `apps/cms`
 * has its own gates (`bun run check:cms`).
 *
 * `knowledge/generated` is graphify's Obsidian export (issue #11): notes
 * EXTRACTED from source code by `bun run knowledge:obsidian:export`, never
 * authored. Holding them to this gate's rules produces only false positives,
 * and the first one was concrete, not hypothetical (issue #15): the moment
 * `docs/adr/` existed, the ADR-citation check below fired on three generated
 * notes that quote THIS FILE's own illustrative `ADR-0042` example — text
 * that is an example in the source comment, and a bare citation once
 * extraction strips the prose around it. The same applies to every check
 * here: a relative link in a generated note is a wikilink this gate does
 * not parse, and a path a note names that no longer exists is graph
 * staleness, which `bun run audit:graf` deliberately does not police
 * either. Generated output belongs to that gate; the documents this one
 * reads are the ones a person wrote. `knowledge/curated/` and
 * `knowledge/README.md` stay in scope — they are authored.
 */
const SKIP_PATHS = new Set(["apps/cms", "knowledge/generated"]);

function violation(gate, file, message) {
  reporter.violation(gate, file, message);
}

function note(line) {
  reporter.note(line);
}

function join(...parts) {
  return posix.join(...parts);
}

/** Every `.md` under `ROOT`, paths relative to it. */
function markdownFiles(dir = "") {
  const absolute = dir ? join(ROOT, dir) : ROOT;
  /** @type {string[]} */
  const result = [];

  // Dotted directories are NOT skipped wholesale: `.changesets/` carries
  // linked markdown with its own linking rule that needs checking too.
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;

    const relative = dir ? join(dir, entry.name) : entry.name;

    if (entry.isDirectory() && SKIP_PATHS.has(relative)) continue;

    if (entry.isDirectory()) result.push(...markdownFiles(relative));
    else if (entry.name.endsWith(".md")) result.push(relative);
  }

  return result;
}

/**
 * Markdown links in a file.
 *
 * Two forms are captured, because this repo uses both: inline
 * `[text](path)` — including images `![alt](path)` — and reference
 * definitions `[label]: path`. Fenced code blocks are stripped first:
 * `docs/` carries example commands and config snippets shaped like links
 * that never are one.
 */
function linksIn(content) {
  const withoutCode = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/(^|[^`])`[^`\n]*`/g, "$1");

  /** @type {string[]} */
  const result = [];

  for (const match of withoutCode.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    result.push(match[1]);
  }
  for (const match of withoutCode.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)) {
    result.push(match[1]);
  }

  return result;
}

/** true for anything that is not a file path in this repo. */
function isExternal(link) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("#") || link === ""
  );
}

function existsAt(path) {
  return existsSync(join(ROOT, path));
}

// ---------------------------------------------------------------------------
// 1. Dead relative links
// ---------------------------------------------------------------------------

function auditLinks(files) {
  let count = 0;

  for (const name of files) {
    const content = readFileSync(join(ROOT, name), "utf8");

    for (const link of new Set(linksIn(content))) {
      if (isExternal(link)) continue;

      // The anchor is discarded; the file part is still checked. A link
      // that is ONLY an anchor already failed `isExternal` above.
      const pathOnly = decodeURI(link.split("#")[0]);
      if (pathOnly === "") continue;

      count += 1;

      // `/docs/x.md` in GitHub markdown means the repo root, not the disk root.
      const target = pathOnly.startsWith("/")
        ? pathOnly.slice(1)
        : posix.normalize(join(posix.dirname(name), pathOnly));

      if (target.startsWith("..")) {
        violation("dead-link", name, `${link} escapes the repo root`);
        continue;
      }

      if (!existsAt(target)) {
        violation("dead-link", name, `points at ${link}, which does not exist`);
      }
    }
  }

  note(`${files.length} markdown file(s), ${count} internal link(s) checked`);
}

// ---------------------------------------------------------------------------
// 2 & 3. ADR index
// ---------------------------------------------------------------------------

/** `- **Status:** Accepted` → `Accepted`; first line only. */
function adrStatus(content) {
  return content.match(/^-\s+\*\*Status:\*\*\s*(.+)$/m)?.[1]?.trim() ?? "";
}

/**
 * ADR file status → the words allowed in the index table's Status column.
 *
 * Mapped rather than compared raw because the ADR file states its status in
 * English while the table may appear in either language: this repo mirrors
 * every governance document into Indonesian, and an ADR index would carry
 * the same table in each language once one exists.
 *
 * Both words are therefore accepted in either file, and that is not a gap
 * left open by accident: this gate's question is "does the table agree with
 * the ADR file's status", not "what language is this table written in" —
 * `audit:translation`, via its source hash, already guards the latter.
 */
const STATUS_EQUIVALENTS = [
  { prefix: "accepted", words: ["Accepted", "Diterima"] },
  { prefix: "proposed", words: ["Proposed", "Diusulkan"] },
  { prefix: "superseded", words: ["Superseded", "Digantikan"] },
  { prefix: "deprecated", words: ["Deprecated", "Usang"] },
  { prefix: "rejected", words: ["Rejected", "Ditolak"] }
];

/**
 * Check ONE index file against the ADRs that actually exist.
 *
 * Called once for the English source and once for the Indonesian mirror, if
 * one exists. The mirror is not a nice-to-have extra: a mirror whose table
 * has fallen one decision behind sends its reader to an incomplete list,
 * and the translation gate would not see it — the hash it checks keeps a
 * mirror the same AGE as its source, not CORRECT against the directory's
 * contents.
 *
 * @param {string} index path to the index file, relative to `ROOT`
 * @param {string[]} adrFiles existing ADR file names, sorted
 * @param {Map<string, string>} fileStatus ADR file name → its own status
 * @param {string} adrDir
 */
function auditOneIndex(index, adrFiles, fileStatus, adrDir) {
  const indexContent = readFileSync(join(ROOT, index), "utf8");

  // Every table-row match, AS-IS — including repeats. That is what keeps the
  // count below honest: collecting into a Map by target file merges two rows
  // for one ADR into one entry before anyone can count the difference.
  const allRows = [
    ...indexContent.matchAll(/^\|\s*\[(\d{4})\]\(([^)]+)\)\s*\|([^|]*)\|([^|]*)\|/gm)
  ];

  /** @type {Map<string, { number: string, status: string }>} */
  const rows = new Map();

  for (const match of allRows) {
    rows.set(match[2].trim(), { number: match[1], status: match[4].trim() });
  }

  // 2b. An ADR number recorded more than once. Grouped by NUMBER (not by
  // target file): the defect is two rows claiming the same decision, and a
  // reader has no way to know which applies — even when both point at the
  // same file, the checks below (which collect into a Map first) both pass.
  /** @type {Map<string, number[]>} */
  const rowsPerNumber = new Map();
  for (const match of allRows) {
    const number = match[1];
    const lineNumber = indexContent.slice(0, match.index).split("\n").length;
    const list = rowsPerNumber.get(number);
    if (list) list.push(lineNumber);
    else rowsPerNumber.set(number, [lineNumber]);
  }
  for (const [number, lines] of rowsPerNumber) {
    if (lines.length < 2) continue;
    violation(
      "adr-index",
      index,
      `ADR-${number} appears ${lines.length} times in the table (line(s) ${lines.join(", ")})`
    );
  }

  // Direction 1: every table row points at a file that exists, with a
  // matching number.
  for (const [target, { number }] of rows) {
    if (!adrFiles.includes(target)) {
      violation(
        "adr-index",
        index,
        `row ${number} points at ${target}, which does not exist in ${adrDir}/`
      );
      continue;
    }
    if (!target.startsWith(number)) {
      violation("adr-index", index, `row ${number} points at ${target}`);
    }
  }

  // Direction 2: every ADR that exists is recorded in the table.
  for (const name of adrFiles) {
    if (!rows.has(name)) {
      violation("adr-index", index, `${name} is not recorded in the table`);
    }
  }

  // 3. Table status agrees with the file's own status.
  for (const name of adrFiles) {
    const recorded = rows.get(name);
    if (!recorded) continue;

    const status = fileStatus.get(name) ?? "";

    if (status === "") {
      violation("adr-status", `${adrDir}/${name}`, "no `- **Status:**` line");
      continue;
    }

    const equivalent = STATUS_EQUIVALENTS.find(({ prefix }) =>
      status.toLowerCase().startsWith(prefix)
    );

    if (!equivalent) {
      violation(
        "adr-status",
        `${adrDir}/${name}`,
        `status "${status}" is not recognised — add its equivalent to packages/gerbang/audit-dokumen.mjs`
      );
      continue;
    }

    if (!equivalent.words.some((word) => recorded.status.includes(word))) {
      violation(
        "adr-status",
        index,
        `${name} is status "${status}" but the table says "${recorded.status}"`
      );
    }
  }

  // `allRows.length`, not `rows.size`: the latter is already collected by
  // target file, which is exactly the count that would hide two rows
  // claiming one ADR — "N files, N table rows" over a table that genuinely
  // has N+1 rows.
  note(`adr: ${index} — ${adrFiles.length} file(s), ${allRows.length} table row(s)`);
}

function auditAdrIndex() {
  const adrDir = "docs/adr";
  const index = join(adrDir, "README.md");

  if (!existsSync(join(ROOT, adrDir)) || !existsSync(join(ROOT, index))) {
    note(`adr: ${index} does not exist — ADR index gate SKIPPED (no docs/adr/ yet).`);
    return;
  }

  // `.id.md` mirrors are NOT separate ADRs: `0001-x.id.md` is a translation
  // of `0001-x.md`, not a second decision. Without this exclusion every
  // mirror would be demanded its own table row, and this gate would go red
  // on the first translation that lands.
  const adrFiles = readdirSync(join(ROOT, adrDir))
    .filter((name) => /^\d{4}-.+\.md$/.test(name) && !name.endsWith(".id.md"))
    .sort();

  // Read once, used by both indexes: status belongs to the ADR file, not to
  // whichever table records it.
  /** @type {Map<string, string>} */
  const fileStatus = new Map(
    adrFiles.map((name) => [name, adrStatus(readFileSync(join(ROOT, adrDir, name), "utf8"))])
  );

  const mirror = join(adrDir, "README.id.md");
  const indexes = existsSync(join(ROOT, mirror)) ? [index, mirror] : [index];

  for (const file of indexes) {
    auditOneIndex(file, adrFiles, fileStatus, adrDir);
  }
}

// ---------------------------------------------------------------------------
// 4. File paths a document names must exist
// ---------------------------------------------------------------------------

/**
 * Paths that may be named even though they do not exist in this repo, each
 * with its reason. This list is what separates a gate from a nuisance: most
 * missing paths are NOT a defect — a document may legitimately describe a
 * workspace this repo has not built yet, or point at a file that belongs to
 * another repository entirely. Without accountable exceptions, this gate
 * would redden every sentence that names a file this repo does not (yet)
 * contain, and the response to that is always the same: someone turns the
 * gate off, and the real defect it exists to catch goes with it.
 *
 * Adding a row: **`reason` must say WHOSE the path is, or WHY it is not
 * here yet.** "Not built yet" is a fine reason as long as it names what
 * will build it (an issue number). "Not written yet" with no such anchor is
 * exactly what this gate exists to find.
 *
 * `onlyIn` (optional, a list of document paths) scopes an entry to the
 * documents that actually have reason to cite it. An entry with no
 * `onlyIn` applies repo-wide — appropriate only when there is no other
 * document in this repo that could mean something different by the same
 * path string.
 */
const EXCLUDED_PATHS = new Map([
  [
    "apps/storefront",
    {
      reason:
        "not built yet — issue #5 (the public Astro storefront: catalog listing + product detail). Named here to describe the planned workspace layout."
    }
  ],
  [
    "packages/kontrak",
    {
      reason:
        "not built yet — issue #6 (the type-only DTO contract package + its import-direction gate). Named here to describe the planned workspace layout."
    }
  ],
  [
    "apps/examples",
    {
      reason:
        "ADR-0018's own rejected alternative (c) — a full-generalisation shape considered and NOT taken for increment 6 (issue #136). Named only to describe the option that was turned down; never built.",
      onlyIn: [
        "docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md",
        "docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md"
      ]
    }
  ],
  [
    "apps/examples/bjekmart",
    {
      reason:
        "ADR-0018's own rejected alternative (c), same as apps/examples above — never built.",
      onlyIn: [
        "docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md",
        "docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md"
      ]
    }
  ],
  [
    "docs/x.md",
    {
      reason:
        "placeholder example path in .changesets/README.md, illustrating how the release script rewrites a relative link when it folds a changeset into CHANGELOG.md — not a real path in this repo.",
      onlyIn: [".changesets/README.md", ".changesets/README.id.md"]
    }
  ],
  [
    "tests/dependabot-config.test.mjs",
    {
      reason:
        "issue #225 (ADR-0021) removed .github/dependabot.yml along with every GitHub Actions workflow, and this test — which existed only to guard that config file's own shape — went with it. CHANGELOG.md's historical entry for issue #180 still names the file it added at the time; CHANGELOG.md is a record of what was true when each entry was written, never rewritten to match the current tree.",
      onlyIn: ["CHANGELOG.md"]
    }
  ],
  [
    "tools/out/seputarborneo/posts.ndjson",
    {
      reason:
        "issue #58 — tools/import-seputarborneo.ts's own export output (blog:legacy:import's NDJSON input, one LegacyImportRecord per line — counts and filenames are all this repo's own docs ever quote, never row content). git-ignored (tools/out/, see .gitignore) since it is regenerated by the exporter itself, never authored — so it never exists in a fresh checkout, only after the exporter has run.",
      onlyIn: ["docs/deployment.md", "docs/deployment.id.md", "docs/kamus-data.md", "docs/kamus-data.id.md"]
    }
  ],
  [
    "tools/out/seputarborneo/videos.ndjson",
    {
      reason: "issue #58 — same as tools/out/seputarborneo/posts.ndjson above, for berita_vid rows.",
      onlyIn: ["docs/deployment.md", "docs/deployment.id.md", "docs/kamus-data.md", "docs/kamus-data.id.md"]
    }
  ],
  [
    "tools/out/seputarborneo/redirects.json",
    {
      reason:
        "issue #58 — the exporter's own bulk POST /api/v1/seo/redirects/import payload. git-ignored, regenerated by the exporter, never authored.",
      onlyIn: ["docs/deployment.md", "docs/deployment.id.md", "docs/kamus-data.md", "docs/kamus-data.id.md"]
    }
  ],
  [
    "tools/out/seputarborneo/site-profile.json",
    {
      reason:
        "issue #58 — the exporter's own config-derived body for PUT /api/v1/site-profile. git-ignored, regenerated by the exporter, never authored.",
      onlyIn: ["docs/deployment.md", "docs/deployment.id.md", "docs/kamus-data.md", "docs/kamus-data.id.md"]
    }
  ]
]);

/** Prefixes that mark a code span as this repo's own file path. */
const PATH_PREFIXES = [
  "src/",
  "scripts/",
  "server/",
  "tests/",
  "public/",
  "docs/",
  "infra/",
  "apps/",
  "packages/",
  "tools/",
  // knowledge/ (issue #11): the federated Graphify + Obsidian workflow's own
  // docs and generated/curated output. Added the same way every other
  // top-level source directory is — a path named in backticks under it
  // should exist, same as any other.
  "knowledge/"
];

function auditNamedPaths(files) {
  let checked = 0;
  const used = new Set();

  for (const name of files) {
    const content = readFileSync(join(ROOT, name), "utf8").replace(/```[\s\S]*?```/g, "");

    for (const match of content.matchAll(/`([A-Za-z0-9_./*-]+)`/g)) {
      const path = match[1];

      if (!PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;

      // A path ending `/` names a STANDARD SHAPE (a directory layout), not a
      // specific file this repo must contain; `*` is a glob, not a path.
      // Both are skipped, and that is stated so it does not read as guarded.
      if (path.endsWith("/") || path.includes("*")) continue;

      const excluded = EXCLUDED_PATHS.get(path);
      if (excluded && (!excluded.onlyIn || excluded.onlyIn.includes(name))) {
        // Recorded "used" only when its scope genuinely matches — an
        // `onlyIn` entry cited OUTSIDE its document falls through to the
        // check below (treated as an ordinary path) WITHOUT marking the
        // entry used, so the "exceptions used" summary does not lie about
        // which document actually relies on it.
        used.add(path);
        continue;
      }

      checked += 1;

      if (!existsAt(path)) {
        violation("named-path", name, `names \`${path}\`, which does not exist in this repo`);
      }
    }
  }

  // An exception no longer cited is an exception that has stopped being
  // read, and then quietly covers a path that eventually really is gone.
  // Enforced by `tests/audit-dokumen.test.mjs`, NOT here — the list belongs
  // to this repo, while this gate must stay correct over any tree it is
  // pointed at (a test fixture, or a derived repo with different documents).
  note(`paths: ${checked} span(s) checked, ${used.size}/${EXCLUDED_PATHS.size} exception(s) used`);
}

// ---------------------------------------------------------------------------
// 5. ADR-NNNN citations resolve to their file
// ---------------------------------------------------------------------------

/**
 * Marks a citation as belonging to another repository. Read over the
 * paragraph window around the citation. **The marker convention is
 * intentional, not incidental**: an ADR citation naming `awcms` (this
 * repo's own embedded `apps/cms`), a "reference repo", or a github.com link
 * in the same paragraph is treated as an external citation and skipped;
 * anything else naming `ADR-NNNN` with no local file is a citation to
 * nowhere.
 *
 * @param {string} window
 * @returns {boolean}
 */
function marksAnotherRepo(window) {
  return /awcms|reference repo|github\.com/.test(window);
}

function auditAdrCitations(files) {
  const adrDir = "docs/adr";

  if (!existsSync(join(ROOT, adrDir))) {
    note("adr citations: docs/adr/ does not exist — ADR citation gate SKIPPED.");
    return;
  }

  // `.id.md` mirrors contribute no numbers — mirroring an orphaned mirror
  // would silently patch over a hole this gate exists to find.
  const localNumbers = new Set(
    readdirSync(join(ROOT, adrDir))
      .filter((name) => !name.endsWith(".id.md"))
      .map((name) => name.match(/^(\d{4})-.+\.md$/)?.[1])
      .filter(Boolean)
  );

  let checked = 0;
  let local = 0;
  let external = 0;

  for (const name of files) {
    // Fenced code blocks are stripped (examples and snippets); inline code
    // spans are NOT: `ADR-0042` inside a backtick is a citation, not an
    // example.
    const content = readFileSync(join(ROOT, name), "utf8").replace(/```[\s\S]*?```/g, "");

    // A paragraph is a block between blank lines. A markdown table is one
    // paragraph, so a header naming the other repo marks every row beneath it.
    for (const paragraph of content.split(/\n\s*\n/)) {
      for (const match of paragraph.matchAll(/ADR-(\d{4})/g)) {
        checked += 1;
        const number = match[1];

        if (localNumbers.has(number)) {
          local += 1;
          continue;
        }

        if (marksAnotherRepo(paragraph)) {
          external += 1;
          continue;
        }

        violation(
          "adr-citation",
          name,
          `cites ADR-${number}, which does not resolve to ${adrDir}/${number}-*.md and is not marked as belonging to another repo (\`awcms\`, "reference repo", or a github link in the same paragraph)`
        );
      }
    }
  }

  note(`adr citations: ${checked} checked, ${local} local, ${external} marked external`);
}

// ---------------------------------------------------------------------------
// 6. Linked counts — a prose claim agrees with the set it counts
// ---------------------------------------------------------------------------

/**
 * Every `<!-- hitung:mulai ... -->` … `<!-- hitung:selesai -->` block in one
 * file, with its attributes.
 *
 * @param {string} content
 * @returns {{ key: string|undefined, source: string|undefined, ignore: string|undefined, content: string }[]}
 */
function countedBlocksIn(content) {
  const result = [];
  const blockRegex = /<!--\s*hitung:mulai([^>]*?)-->([\s\S]*?)<!--\s*hitung:selesai\s*-->/g;

  for (const match of content.matchAll(blockRegex)) {
    /** @type {Record<string, string>} */
    const attrs = {};
    for (const pair of match[1].matchAll(/(\w+)=(\S+)/g)) {
      attrs[pair[1]] = pair[2];
    }
    result.push({
      key: attrs.key,
      source: attrs.source,
      ignore: attrs.ignore,
      content: match[2]
    });
  }

  return result;
}

/**
 * A valid `source=` in parsed form, or `null` when it is not recognised.
 *
 * `match:<path>:<regex>` is split on the FIRST TWO colons only — after
 * `match` and after the path — because the regex itself may legitimately
 * contain a colon (inside a character class, or a non-capturing group).
 *
 * @param {string} spec
 */
function parseSource(spec) {
  if (spec === "table-rows") return { kind: "table-rows" };

  if (spec.startsWith("match:")) {
    const rest = spec.slice("match:".length);
    const colon = rest.indexOf(":");
    if (colon === -1) return null;

    const path = rest.slice(0, colon);
    const pattern = rest.slice(colon + 1);
    if (!path || !pattern) return null;

    return { kind: "match", path, pattern };
  }

  return null;
}

/**
 * Markdown table BODY rows inside a block — header and separator
 * (`| --- | --- |`) discarded, multiple tables inside one block summed.
 *
 * Grouped by RUN of consecutive lines whose trimmed form starts with `|`,
 * so a blank line between two tables in the same block does not blend them
 * into one.
 *
 * @param {string} blockContent
 */
function countTableRows(blockContent) {
  const lines = blockContent.split("\n");
  let total = 0;
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].trim().startsWith("|")) {
      i += 1;
      continue;
    }

    let j = i;
    while (j < lines.length && lines[j].trim().startsWith("|")) j += 1;

    const group = lines.slice(i, j);
    // group[0] is the header; group[1] is the separator row ONLY when its
    // content is entirely `|`, `-`, `:`, and spaces — otherwise this group
    // is not a GFM-shaped table and the whole group counts as body rows.
    const hasSeparator = group.length > 1 && /^[\s|:-]+$/.test(group[1].trim());
    const bodyStart = hasSeparator ? 2 : 1;

    total += Math.max(0, group.length - bodyStart);
    i = j;
  }

  return total;
}

/**
 * The ACTUAL count a `source=` promises, or an error message when it
 * cannot be counted.
 *
 * @param {{ kind: string, path?: string, pattern?: string }} parsedSource
 * @param {string} blockContent
 * @returns {{ n: number } | { error: string }}
 */
function actualCount(parsedSource, blockContent) {
  if (parsedSource.kind === "table-rows") {
    return { n: countTableRows(blockContent) };
  }

  const { path, pattern } = parsedSource;

  if (!existsAt(path)) {
    return { error: `\`match:\` source points at \`${path}\`, which does not exist` };
  }

  let regex;
  try {
    regex = new RegExp(pattern, "g");
  } catch {
    return { error: `\`match:\` source has an invalid regex: \`${pattern}\`` };
  }

  const targetContent = readFileSync(join(ROOT, path), "utf8");
  const uniqueValues = new Set();
  for (const match of targetContent.matchAll(regex)) {
    if (match[1] !== undefined) uniqueValues.add(match[1]);
  }

  return { n: uniqueValues.size };
}

/**
 * A block's prose, ready to scan for spelled numbers: fenced code and table
 * rows are dropped ENTIRELY (that is the deliberate boundary — a spelled
 * number inside a table row is never checked), inline code spans and
 * markdown link targets are stripped while their text survives.
 *
 * @param {string} blockContent
 */
function proseFromBlock(blockContent) {
  const withoutFences = blockContent.replace(/```[\s\S]*?```/g, "");
  const withoutTableRows = withoutFences
    .split("\n")
    .filter((line) => !line.trim().startsWith("|"))
    .join("\n");
  const withoutInlineCode = withoutTableRows.replace(/`[^`\n]*`/g, "");

  // `[text](target)` → `text`: the link target is dropped, its text scanned.
  return withoutInlineCode.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** Recognised spelled numbers, one → twenty. */
const NUMBER_WORDS = new Map([
  ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5],
  ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10],
  ["eleven", 11], ["twelve", 12], ["thirteen", 13], ["fourteen", 14],
  ["fifteen", 15], ["sixteen", 16], ["seventeen", 17], ["eighteen", 18],
  ["nineteen", 19], ["twenty", 20]
]);

const NUMBER_WORD_REGEX = new RegExp(`\\b(${[...NUMBER_WORDS.keys()].join("|")})\\b`, "gi");

/**
 * Spelled numbers found in a prose text.
 *
 * @param {string} text
 * @returns {{ word: string, value: number }[]}
 */
function numbersIn(text) {
  const found = [];
  for (const match of text.matchAll(NUMBER_WORD_REGEX)) {
    found.push({ word: match[0], value: NUMBER_WORDS.get(match[0].toLowerCase()) });
  }
  return found;
}

function auditLinkedCounts(files) {
  let blocksChecked = 0;
  let filesWithBlocks = 0;

  for (const name of files) {
    const content = readFileSync(join(ROOT, name), "utf8");
    const blocks = countedBlocksIn(content);
    if (blocks.length === 0) continue;

    filesWithBlocks += 1;

    for (const block of blocks) {
      blocksChecked += 1;

      if (!block.key || !block.source) {
        violation(
          "linked-count",
          name,
          "incomplete `hitung:mulai` marker — `key=` and `source=` are required"
        );
        continue;
      }

      const parsedSource = parseSource(block.source);
      if (!parsedSource) {
        violation(
          "linked-count",
          name,
          `key "${block.key}": source "${block.source}" is not recognised — use \`table-rows\` or \`match:<path>:<regex>\``
        );
        continue;
      }

      const result = actualCount(parsedSource, block.content);
      if ("error" in result) {
        violation("linked-count", name, `key "${block.key}": ${result.error}`);
        continue;
      }

      const { n } = result;
      if (n < 1 || n > 20) {
        violation(
          "linked-count",
          name,
          `key "${block.key}": actual count ${n} is outside the recognised range of spelled numbers (1..20) — add its word to packages/gerbang/audit-dokumen.mjs`
        );
        continue;
      }

      const ignore = new Set(
        (block.ignore ?? "")
          .split(",")
          .map((word) => word.trim().toLowerCase())
          .filter(Boolean)
      );

      const prose = proseFromBlock(block.content);
      const found = numbersIn(prose).filter(
        (item) => !ignore.has(item.word.toLowerCase())
      );

      if (found.length === 0) {
        violation(
          "linked-count",
          name,
          `key "${block.key}": block contains no spelled number to check — a marker guarding nothing will rot`
        );
        continue;
      }

      // One violation per DISTINCT word, not per occurrence: a claim
      // repeated three times in prose is one wrong claim, not three
      // identical violations.
      /** @type {Map<string, { word: string, value: number }>} */
      const uniqueWrong = new Map();
      for (const item of found) {
        if (item.value === n) continue;
        const key = item.word.toLowerCase();
        if (!uniqueWrong.has(key)) uniqueWrong.set(key, item);
      }

      for (const item of uniqueWrong.values()) {
        violation(
          "linked-count",
          name,
          `key "${block.key}": word "${item.word}" (${item.value}) does not match the actual count ${n}`
        );
      }
    }
  }

  note(`linked counts: ${blocksChecked} marked block(s) checked in ${filesWithBlocks} file(s)`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const documents = markdownFiles();

auditLinks(documents);
auditAdrIndex();
auditNamedPaths(documents);
auditAdrCitations(documents);
auditLinkedCounts(documents);

reporter.finish();
