/**
 * baseline.ts — matching an OpenGrep finding against the committed security
 * baseline, `tools/ci/security-baseline.json`.
 *
 * The baseline records findings that were TRIAGED once and accepted, each
 * with a reason (a real triage, not a bulk silence). It may only shrink: the
 * leg fails on any ERROR-severity finding that does not match an entry by
 * `ruleId` + `path` exactly, and `tests/local-ci-baseline.test.mjs` refuses a
 * baseline larger than its recorded ceiling, so adding an entry takes a
 * visible, reviewed change to that ceiling together with a recorded decision.
 * A finding that looks like a genuine security bug is fixed or escalated, never
 * baselined to make the gate pass.
 */

export type Severity = "ERROR" | "WARNING" | "INFO";

export interface BaselineEntry {
  ruleId: string;
  path: string;
  reason: string;
}

export interface SecurityFinding {
  ruleId: string;
  path: string;
  severity: Severity;
  message: string;
  line?: number;
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
 * Split ERROR-severity findings into those the baseline excuses and those
 * that must fail the leg. WARNING and INFO findings never block.
 */
export function partitionBlockingFindings(
  findings: readonly SecurityFinding[],
  baseline: readonly BaselineEntry[]
): { blocking: SecurityFinding[]; baselined: SecurityFinding[]; advisory: SecurityFinding[] } {
  const blocking: SecurityFinding[] = [];
  const baselined: SecurityFinding[] = [];
  const advisory: SecurityFinding[] = [];
  for (const finding of findings) {
    if (finding.severity !== "ERROR") {
      advisory.push(finding);
    } else if (isBaselined(finding, baseline)) {
      baselined.push(finding);
    } else {
      blocking.push(finding);
    }
  }
  return { blocking, baselined, advisory };
}
