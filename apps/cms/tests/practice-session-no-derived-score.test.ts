/**
 * Guards PRD's Explicit Non-Goals (§38, "no clinical scoring, no
 * psychological profiling") and ADR-0002's Consequences ("intensity/
 * post-intensity fields are stored as plain integers 0-10 with no derived
 * scoring logic anywhere") against future drift — not just today's
 * correctness. `domain/practice-session.ts`'s own header states that
 * `isValidIntensityValue` is the ONLY function this module may have that
 * touches `intensity`/`postIntensity`; this test statically scans every
 * source file the module owns for signs a second one grew there.
 *
 * Deliberately a source scan, not a behavioural test: the whole point is to
 * catch a helper that COULD be added (a two-line `averageIntensity`, a
 * `classifySeverity`) before it ships, which a call-the-function test cannot
 * do for a function that does not exist yet.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { stripComments } from "../scripts/lib/source-text";

const MODULE_ROOTS = [
  path.join(import.meta.dir, "..", "src", "modules", "practice-irm"),
  path.join(import.meta.dir, "..", "src", "pages", "api", "v1", "practice-irm")
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".astro")) {
      out.push(full);
    }
  }
  return out;
}

const files = MODULE_ROOTS.flatMap(listTsFiles);

/**
 * A DECLARATION (function/const/let/type/interface/class) whose name signals
 * a derived judgement about the raw 0-10 value, rather than a plain range
 * check or pass-through. Deliberately anchored to a declaration keyword
 * rather than matching anywhere in the file — this module's own doc
 * comments legitimately use words like "severity"/"bucket" IN PROSE to
 * explain what is forbidden and why (see `practice-session.ts`'s header),
 * and a plain substring scan would flag that explanation as the violation
 * it is warning against. Case-insensitive.
 */
const FORBIDDEN_DECLARATION_PATTERNS = [
  /\b(function|const|let|var|type|interface|class)\s+\w*severity\w*/i,
  /\b(function|const|let|var|type|interface|class)\s+\w*score\w*/i,
  /\b(function|const|let|var|type|interface|class)\s+\w*scoring\w*/i,
  /\b(function|const|let|var|type|interface|class)\s+\w*classif\w*/i,
  /\b(function|const|let|var|type|interface|class)\s+\w*diagnos\w*/i,
  /\b(function|const|let|var|type|interface|class)\s+\w*bucket\w*/i,
  /\b(function|const|let|var|type|interface|class)\s+\w*profil(e|ing)\w*/i
];

/**
 * Arithmetic combining `intensity`/`postIntensity`/`post_intensity` with
 * another operand — a sum, a difference, a product (an average's numerator
 * always sums or differences its operands first). A plain range check
 * (`>= 0`, `<= 10`) does not match this: it compares, never combines two
 * operands with `+ - *`.
 *
 * `/` is deliberately EXCLUDED from the operator set: this codebase's own
 * prose (error messages, doc comments) routinely writes the natural-language
 * pairing `intensity/postIntensity` ("intensity, and separately,
 * postIntensity") with a slash and no arithmetic meaning at all, and that
 * false positive is not worth chasing for a division op that would almost
 * always be preceded by the `+`/`-` this pattern already catches (an
 * average's numerator is a sum or a difference before it is ever divided).
 */
const ARITHMETIC_ON_INTENSITY =
  /(intensity|postIntensity|post_intensity)\s*[-+*]\s*[^=]|[^=]\s*[-+*]\s*(intensity|postIntensity|post_intensity)/i;

describe("no derived score/classification on intensity/postIntensity (Issue #270)", () => {
  test("at least the expected module files were actually scanned", () => {
    // A guard against a refactor silently moving these files somewhere this
    // test no longer looks — if this count drops to zero the test above
    // would trivially "pass" having scanned nothing.
    expect(files.length).toBeGreaterThan(5);
  });

  test("no function/variable/type declaration in this module suggests a derived score or classification", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const content = stripComments(readFileSync(file, "utf-8"));
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        for (const pattern of FORBIDDEN_DECLARATION_PATTERNS) {
          if (pattern.test(line)) {
            offenders.push(
              `${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`
            );
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  test("intensity/postIntensity are never combined via arithmetic anywhere in this module", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const content = stripComments(readFileSync(file, "utf-8"));
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        if (ARITHMETIC_ON_INTENSITY.test(line)) {
          offenders.push(
            `${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  test("the domain module's own header still states the single-function rule (documentation drift guard)", () => {
    const domainFile = path.join(
      import.meta.dir,
      "..",
      "src",
      "modules",
      "practice-irm",
      "domain",
      "practice-session.ts"
    );
    const content = readFileSync(domainFile, "utf-8");
    expect(content).toContain("isValidIntensityValue");
    expect(content.toLowerCase()).toContain(
      "no derived scoring logic anywhere"
    );
  });
});
