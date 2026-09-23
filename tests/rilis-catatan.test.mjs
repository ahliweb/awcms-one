/**
 * `tools/rilis-catatan.mjs` and its pure logic,
 * `packages/gerbang/lib/changelog.mjs`.
 *
 * Two layers, tested separately:
 *
 *   1. `changelogSection`/`findChangelogHeadings` directly, against small
 *      fixture strings — precise about WHICH characters end up in a section,
 *      which is easiest to see with a minimal document rather than the real
 *      (2000+ line) `CHANGELOG.md`.
 *   2. The CLI itself, spawned exactly as `.github/workflows/release.yml`
 *      will run it — proving the exit-code/stdout/stderr contract that
 *      workflow depends on, not just the function it calls.
 *
 * A third block reads the REAL root `CHANGELOG.md`, so a future heading that
 * quietly stops matching `## [X.Y.Z] — <date>` fails a test here rather than
 * only being discovered when a tag push publishes a broken Release.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { changelogSection, findChangelogHeadings } from "../packages/gerbang/lib/changelog.mjs";

// Absolute: the CLI tests below run it with `cwd` set to a scratch temp
// directory, so a relative path would resolve against THAT directory (where
// the script does not exist) rather than this repo.
const SCRIPT = resolve("tools/rilis-catatan.mjs");

/** A minimal CHANGELOG.md-shaped document: newest first, exactly like the real one. */
const FIXTURE = `# Changelog

Preamble text that is not a version section.

## [0.3.0] — 2026-03-03

### Third heading

Third body, line one.
Third body, line two.

## [0.2.0] — 2026-02-02

Second body — no subsection at all.

## [0.1.0] — 2026-01-01

First body.
`;

describe("changelogSection — the middle, first, and last section", () => {
  test("a middle version's body stops right before the next heading", () => {
    expect(changelogSection(FIXTURE, "0.2.0")).toBe("Second body — no subsection at all.");
  });

  test("the FIRST heading in the file (the newest version) is bounded by the second heading", () => {
    const body = changelogSection(FIXTURE, "0.3.0");
    expect(body).toBe("### Third heading\n\nThird body, line one.\nThird body, line two.");
    expect(body).not.toContain("[0.2.0]");
  });

  test("the LAST heading in the file (the oldest version) runs to end of file", () => {
    expect(changelogSection(FIXTURE, "0.1.0")).toBe("First body.");
  });

  test("the body is trimmed of the blank lines surrounding it, not just sliced raw", () => {
    const body = changelogSection(FIXTURE, "0.2.0");
    expect(body.startsWith("\n")).toBe(false);
    expect(body.endsWith("\n")).toBe(false);
  });
});

describe("changelogSection — the `v` prefix is optional", () => {
  test("with a `v` prefix", () => {
    expect(changelogSection(FIXTURE, "v0.2.0")).toBe("Second body — no subsection at all.");
  });

  test("without a `v` prefix", () => {
    expect(changelogSection(FIXTURE, "0.2.0")).toBe("Second body — no subsection at all.");
  });
});

describe("changelogSection — a missing version is a clear error, not an empty string", () => {
  test("a well-formed version with no section throws, naming what IS present", () => {
    expect(() => changelogSection(FIXTURE, "9.9.9")).toThrow(
      /no section for version 9\.9\.9.*Versions present: 0\.3\.0, 0\.2\.0, 0\.1\.0/s
    );
  });

  test("an unparseable version argument throws too, rather than matching nothing silently", () => {
    expect(() => changelogSection(FIXTURE, "not-a-version")).toThrow(/is not MAJOR\.MINOR\.PATCH/);
  });

  test("an empty document throws naming that there are no headings at all", () => {
    expect(() => changelogSection("# Changelog\n\nnothing here\n", "0.1.0")).toThrow(
      /no version headings at all/
    );
  });
});

describe("findChangelogHeadings — heading-format drift is refused, not silently mis-split", () => {
  test("a `##` line that drops the brackets and the em dash throws, naming the offending line", () => {
    const drifted = `## [0.2.0] — 2026-02-02\n\nbody\n\n## v0.1.0 - 2026-01-01\n\nother body\n`;
    expect(() => findChangelogHeadings(drifted)).toThrow(/## v0\.1\.0 - 2026-01-01/);
    expect(() => changelogSection(drifted, "0.2.0")).toThrow(/does not match the expected/);
  });

  test("a well-formed document parses to versions in file order, newest first", () => {
    const headings = findChangelogHeadings(FIXTURE);
    expect(headings.map((h) => h.version)).toEqual(["0.3.0", "0.2.0", "0.1.0"]);
  });

  test("CRLF line endings are tolerated — same result as the LF original", () => {
    const crlf = FIXTURE.replace(/\n/g, "\r\n");
    expect(changelogSection(crlf, "0.2.0")).toBe("Second body — no subsection at all.");
  });
});

describe("the real root CHANGELOG.md — a heading-format regression here fails a test, not a release", () => {
  const real = readFileSync("CHANGELOG.md", "utf8");

  test("every heading in the real file still matches the expected format", () => {
    expect(() => findChangelogHeadings(real)).not.toThrow();
  });

  test("v0.1.0 (the very first release, no `.changesets/` convention yet) is still readable", () => {
    const body = changelogSection(real, "v0.1.0");
    expect(body).toContain("Initial workspace scaffolding");
    // Proves the slice does not run past end of its own section by accident —
    // v0.1.0 is last in the file, so this only guards against a body that
    // somehow includes content before its own heading.
    expect(body).not.toContain("## [0.2.0]");
  });
});

/** Spawns the CLI exactly as `.github/workflows/release.yml` will. */
async function run(args, cwd = process.cwd()) {
  const child = Bun.spawn(["bun", SCRIPT, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);
  return { code: await child.exited, stdout, stderr };
}

/** A temp directory holding only a `CHANGELOG.md` built from {@link FIXTURE}. */
function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "rilis-catatan-"));
  writeFileSync(join(dir, "CHANGELOG.md"), FIXTURE);
  return dir;
}

describe("the CLI — the exact contract .github/workflows/release.yml depends on", () => {
  test("prints exactly the section body to stdout, nothing else, exit 0", async () => {
    const dir = fixtureDir();
    try {
      const { code, stdout, stderr } = await run(["0.2.0"], dir);
      expect(code).toBe(0);
      expect(stdout).toBe("Second body — no subsection at all.\n");
      expect(stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the `v` prefix is optional at the CLI too", async () => {
    const dir = fixtureDir();
    try {
      const { code, stdout } = await run(["v0.2.0"], dir);
      expect(code).toBe(0);
      expect(stdout).toBe("Second body — no subsection at all.\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing version exits non-zero with a clear stderr message, and prints nothing to stdout", async () => {
    const dir = fixtureDir();
    try {
      const { code, stdout, stderr } = await run(["9.9.9"], dir);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("no section for version 9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing CHANGELOG.md exits non-zero and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rilis-catatan-empty-"));
    try {
      const { code, stdout, stderr } = await run(["0.1.0"], dir);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("CHANGELOG.md does not exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no version argument at all exits non-zero with a usage message", async () => {
    const dir = fixtureDir();
    try {
      const { code, stderr } = await run([], dir);
      expect(code).toBe(1);
      expect(stderr).toContain("Usage:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--file points the CLI at a differently-named document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rilis-catatan-altfile-"));
    try {
      writeFileSync(join(dir, "OTHER.md"), FIXTURE);
      const { code, stdout } = await run(["0.1.0", "--file", "OTHER.md"], dir);
      expect(code).toBe(0);
      expect(stdout).toBe("First body.\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
