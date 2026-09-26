/**
 * baseline.ts — matching a CodeQL SARIF result against the committed
 * security baseline, `tools/ci/security-baseline.json`.
 *
 * The file is seeded once, with this repository's ALREADY-dismissed GitHub
 * code-scanning alerts (each entry's `reason` quotes that alert's own
 * dismissal comment — `gh api repos/ahliweb/awcms-one/code-scanning/alerts`),
 * not left empty: a first local run reproduced exactly those findings, and
 * re-litigating a decision this repository already made once, in a second
 * place, would be busywork rather than triage. It grows further only when a
 * maintainer explicitly triages a genuinely NEW finding and records why it
 * is accepted — never edited to silence a fresh, unseen one. The `security`
 * leg fails on any result whose `security-severity >= 7.0` unless it
 * matches an entry here by `ruleId` + `path` exactly.
 */

export interface BaselineEntry {
  ruleId: string;
  path: string;
  reason: string;
}

export interface SecurityFinding {
  ruleId: string;
  path: string;
  severity: number;
  message: string;
}

/** Parse and validate `security-baseline.json`'s content. Every entry must carry a non-empty `reason` — an entry without one is a defect in the baseline file itself, not a permissive default. */
export function parseBaseline(text: string): BaselineEntry[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("security-baseline.json must be a JSON array.");
  }
  return parsed.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.ruleId !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.reason !== "string" ||
      entry.reason.trim() === ""
    ) {
      throw new Error(
        `security-baseline.json[${index}] must be {ruleId, path, reason} with a non-empty reason.`
      );
    }
    return { ruleId: entry.ruleId, path: entry.path, reason: entry.reason };
  });
}

/** True when `finding` matches a baseline entry by ruleId + path exactly. */
export function isBaselined(finding: SecurityFinding, baseline: readonly BaselineEntry[]): boolean {
  return baseline.some((entry) => entry.ruleId === finding.ruleId && entry.path === finding.path);
}

/**
 * Split findings with `security-severity >= 7.0` into those the baseline
 * excuses and those that must fail the leg.
 */
export function partitionHighSeverityFindings(
  findings: readonly SecurityFinding[],
  baseline: readonly BaselineEntry[],
  threshold = 7.0
): { blocking: SecurityFinding[]; baselined: SecurityFinding[] } {
  const blocking: SecurityFinding[] = [];
  const baselined: SecurityFinding[] = [];
  for (const finding of findings) {
    if (finding.severity < threshold) continue;
    if (isBaselined(finding, baseline)) {
      baselined.push(finding);
    } else {
      blocking.push(finding);
    }
  }
  return { blocking, baselined };
}
