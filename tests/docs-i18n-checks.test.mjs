/**
 * Unit tests for the pure logic behind the documentation translation gates
 * (`packages/gerbang/lib/docs-i18n-checks.mjs`), plus the properties the
 * ledger in `packages/gerbang/check-docs-translation.mjs` has to keep.
 *
 * The direction is the thing worth testing. The staleness marker lives on
 * the MIRROR, recording the hash of the ENGLISH source, so editing English
 * must invalidate the Indonesian. A suite that stayed green with the marker
 * on the other side would be proving nothing about the arrangement this
 * repo actually chose.
 *
 * Run with `bun test`.
 */
import { describe, expect, test } from "bun:test";
import {
  checkMirrorCoverage,
  checkTranslationPair,
  computeSourceHash,
  deriveMirrorPath,
  deriveSourcePath,
  extractRecordedHash,
  isInScope,
  isMirrorInScope
} from "../packages/gerbang/lib/docs-i18n-checks.mjs";
import { DOCS_AWAITING_MIRROR } from "../packages/gerbang/check-docs-translation.mjs";

describe("computeSourceHash", () => {
  test("is deterministic for identical content", () => {
    expect(computeSourceHash("hello world")).toBe(computeSourceHash("hello world"));
  });

  test("differs for different content", () => {
    expect(computeSourceHash("hello world")).not.toBe(computeSourceHash("hello worlds"));
  });

  test("is a sha256 marker value", () => {
    expect(computeSourceHash("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("extractRecordedHash", () => {
  test("reads the marker out of a mirror", () => {
    const hash = computeSourceHash("source");
    expect(extractRecordedHash(`<!-- i18n-source-hash: ${hash} -->\n\n# Doc`)).toBe(hash);
  });

  test("returns null when there is no marker", () => {
    expect(extractRecordedHash("# Doc\n\nNo marker here.")).toBeNull();
  });
});

describe("path derivation", () => {
  test("source -> mirror", () => {
    expect(deriveMirrorPath("docs/adr/README.md")).toBe("docs/adr/README.id.md");
  });

  test("mirror -> source", () => {
    expect(deriveSourcePath("docs/adr/README.id.md")).toBe("docs/adr/README.md");
  });

  /** A mirror is not itself a source; deriving one would produce `X.id.id.md`. */
  test("a mirror has no mirror", () => {
    expect(deriveMirrorPath("docs/adr/README.id.md")).toBeNull();
  });

  test("non-markdown is not a source", () => {
    expect(deriveMirrorPath("packages/gerbang/lib/git.mjs")).toBeNull();
    expect(deriveSourcePath("docs/adr/README.md")).toBeNull();
  });
});

describe("isInScope — which documents the policy governs", () => {
  test("docs and SHOUTING root documents are in scope", () => {
    for (const path of [
      "docs/adr/0001-example-decision.md",
      "docs/architecture/overview.md",
      "README.md",
      "AGENTS.md",
      "CODE_OF_CONDUCT.md",
      ".changesets/README.md"
    ]) {
      expect(isInScope(path)).toBe(true);
    }
  });

  test("a mirror is never itself a source in scope", () => {
    expect(isInScope("docs/adr/README.id.md")).toBe(false);
    expect(isInScope("AGENTS.id.md")).toBe(false);
  });

  test("the append-only record and the ephemeral changesets are out", () => {
    // CHANGELOG.md records what was said when it was said; re-translating
    // it on every release would rewrite the record.
    expect(isInScope("CHANGELOG.md")).toBe(false);

    // An individual changeset is folded into CHANGELOG.md and deleted by
    // `bun run release`, so its mirror would outlive it by one release.
    expect(isInScope(".changesets/2026-09-15-example.md")).toBe(false);

    // ...but the rules document that governs them stays in scope.
    expect(isInScope(".changesets/README.md")).toBe(true);
  });

  test("apps/cms's own markdown is out — that corpus is awcms's to govern", () => {
    expect(isInScope("apps/cms/README.md")).toBe(false);
    expect(isInScope("apps/cms/AGENTS.md")).toBe(false);
    expect(isInScope("apps/cms/docs/adr/0001-example.md")).toBe(false);
  });

  test("non-markdown and non-document markdown are out", () => {
    expect(isInScope("package.json")).toBe(false);
    expect(isInScope("packages/gerbang/lib/git.mjs")).toBe(false);
    expect(isInScope(".github/PULL_REQUEST_TEMPLATE.md")).toBe(false);
  });
});

/**
 * `isMirrorInScope` answers the MIRROR side of the exact same question
 * `isInScope` answers for a source. Both `check-docs-translation.mjs`'s
 * `listMirrors()` and `tools/docs-i18n-stamp.mjs`'s own share this one
 * predicate rather than each carrying its own copy of the scope rule —
 * `ahliweb/media-lenterakalteng` found those two call sites had drifted
 * apart once, with the unfiltered one walking every `.id.md` in the working
 * tree including hundreds belonging to its own embedded `apps/cms`.
 */
describe("isMirrorInScope — the mirror side of isInScope", () => {
  test("a mirror of an in-scope source is in scope", () => {
    expect(isMirrorInScope("docs/adr/README.id.md")).toBe(true);
    expect(isMirrorInScope("AGENTS.id.md")).toBe(true);
  });

  test("apps/cms's own mirrors are out of scope — awcms's, not this repo's", () => {
    expect(isMirrorInScope("apps/cms/README.id.md")).toBe(false);
    expect(isMirrorInScope("apps/cms/AGENTS.id.md")).toBe(false);
  });

  test("a mirror whose source would itself be out of scope is out", () => {
    // CHANGELOG.md is deliberately never mirrored (append-only record); its
    // hypothetical mirror must not be treated as in scope either.
    expect(isMirrorInScope("CHANGELOG.id.md")).toBe(false);
  });

  test("a non-mirror path (no derivable source) is out", () => {
    expect(isMirrorInScope("docs/adr/README.md")).toBe(false);
    expect(isMirrorInScope("packages/gerbang/lib/git.mjs")).toBe(false);
  });
});

describe("checkTranslationPair — is this mirror current?", () => {
  const source = "# Title\n\nEnglish body.\n";
  const hash = computeSourceHash(source);
  const mirror = `<!-- i18n-source-hash: ${hash} -->\n\n# Judul\n`;

  test("accepts a mirror whose marker matches the English source", () => {
    expect(checkTranslationPair("doc.md", source, "doc.id.md", mirror)).toEqual([]);
  });

  /**
   * The direction test. The marker records the hash of the ENGLISH source,
   * so editing English must invalidate the mirror. With the marker on the
   * other side this case would be green, and the copy every reader opens by
   * default would be the copy allowed to drift.
   */
  test("rejects a mirror after the English source changes", () => {
    const problems = checkTranslationPair(
      "doc.md",
      `${source}One more English sentence.\n`,
      "doc.id.md",
      mirror
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe("doc.id.md");
    expect(problems[0]?.message).toContain("stale mirror");
  });

  test("rejects a mirror carrying no marker", () => {
    const problems = checkTranslationPair("doc.md", source, "doc.id.md", "# Judul\n");

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("no <!-- i18n-source-hash");
  });

  /** Reported against the mirror: that is the file which exists to be acted on. */
  test("rejects an orphan mirror whose English source is gone", () => {
    const problems = checkTranslationPair("doc.md", null, "doc.id.md", mirror);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe("doc.id.md");
    expect(problems[0]?.message).toContain("no English source");
  });
});

describe("checkMirrorCoverage — which documents have no mirror at all?", () => {
  test("accepts a document that has its mirror", () => {
    expect(checkMirrorCoverage(["a.md"], new Set(["a.id.md"]), [])).toEqual([]);
  });

  test("accepts an unmirrored document that is on the ledger", () => {
    expect(checkMirrorCoverage(["a.md"], new Set(), ["a.md"])).toEqual([]);
  });

  test("rejects an unmirrored document that is not on the ledger", () => {
    const problems = checkMirrorCoverage(["a.md"], new Set(), []);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("no Indonesian mirror");
  });

  /**
   * The ledger may only SHRINK. An entry whose mirror now exists overstates
   * the debt, and a counter that overstates is a counter nobody believes —
   * which is how a migration stalls while still reading as deliberate.
   */
  test("rejects a ledger entry whose mirror now exists", () => {
    const problems = checkMirrorCoverage(["a.md"], new Set(["a.id.md"]), ["a.md"]);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("may only shrink");
  });

  test("rejects a ledger entry that is not a document in scope", () => {
    const problems = checkMirrorCoverage(["a.md"], new Set(["a.id.md"]), ["gone.md"]);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("not a tracked document in scope");
  });
});

describe("the ledger itself", () => {
  test("starts empty — every governance document ships mirrored from day one", () => {
    expect(DOCS_AWAITING_MIRROR).toEqual([]);
  });

  test("every entry (once any exist) is a document the policy actually governs", () => {
    const outOfScope = DOCS_AWAITING_MIRROR.filter((entry) => !isInScope(entry));
    expect(outOfScope).toEqual([]);
  });

  test("has no duplicate entries", () => {
    expect(DOCS_AWAITING_MIRROR).toHaveLength(new Set(DOCS_AWAITING_MIRROR).size);
  });

  /** Sorted, so a shrinking ledger produces a one-line diff per document. */
  test("is sorted", () => {
    expect(DOCS_AWAITING_MIRROR).toEqual([...DOCS_AWAITING_MIRROR].sort());
  });
});
