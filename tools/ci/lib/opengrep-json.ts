/** opengrep-json.ts — pulling `{ ruleId, path, severity, message }` findings out of an OpenGrep `--json` report. */
import type { SecurityFinding, Severity } from "./baseline.ts";
import { SAST_RULE_ID_PREFIX } from "./opengrep-cli.ts";

interface OpengrepReport {
  results?: Array<{
    check_id?: string;
    path?: string;
    start?: { line?: number };
    extra?: { severity?: string; message?: string };
  }>;
  errors?: Array<{ level?: string; type?: unknown; message?: string; path?: string }>;
  paths?: { scanned?: string[] };
}

export interface OpengrepSummary {
  findings: SecurityFinding[];
  /** Engine/rule errors that mean the scan itself is not trustworthy (level "error"). */
  fatalErrors: string[];
  scannedFiles: number;
}

function toSeverity(raw: string | undefined): Severity {
  const value = (raw ?? "").toUpperCase();
  // Anything the engine reports that is not clearly lower than ERROR counts as ERROR (fail closed).
  if (value === "WARNING" || value === "INFO") return value;
  return "ERROR";
}

/** Strip the config-directory prefix the engine puts in every rule id, so baseline entries stay short and stable. */
export function normalizeRuleId(checkId: string): string {
  return checkId.startsWith(SAST_RULE_ID_PREFIX) ? checkId.slice(SAST_RULE_ID_PREFIX.length) : checkId;
}

export function parseOpengrepReport(text: string): OpengrepSummary {
  const doc = JSON.parse(text) as OpengrepReport;
  const findings: SecurityFinding[] = (doc.results ?? []).map((r) => ({
    ruleId: normalizeRuleId(r.check_id ?? "unknown-rule"),
    path: r.path ?? "(unknown-path)",
    severity: toSeverity(r.extra?.severity),
    message: r.extra?.message ?? "",
    line: r.start?.line
  }));
  const fatalErrors = (doc.errors ?? [])
    .filter((e) => (e.level ?? "").toLowerCase() === "error")
    .map((e) => `${typeof e.type === "string" ? e.type : JSON.stringify(e.type)}${e.path ? ` @ ${e.path}` : ""}: ${(e.message ?? "").slice(0, 200)}`);
  return { findings, fatalErrors, scannedFiles: doc.paths?.scanned?.length ?? 0 };
}
