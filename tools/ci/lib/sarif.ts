/** sarif.ts — pulling `{ ruleId, path, severity, message }` findings out of a CodeQL SARIF file. */
import type { SecurityFinding } from "./baseline.ts";

interface SarifDocument {
  runs?: Array<{
    tool?: { driver?: { rules?: Array<{ id?: string; properties?: { "security-severity"?: string } }> } };
    results?: Array<{
      ruleId?: string;
      message?: { text?: string };
      locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string } } }>;
      properties?: { "security-severity"?: string };
    }>;
  }>;
}

export function parseSarifFindings(sarifText: string): SecurityFinding[] {
  const doc = JSON.parse(sarifText) as SarifDocument;
  const findings: SecurityFinding[] = [];
  for (const runEntry of doc.runs ?? []) {
    const rulesById = new Map<string, number>();
    for (const rule of runEntry.tool?.driver?.rules ?? []) {
      const severity = Number.parseFloat(rule.properties?.["security-severity"] ?? "");
      if (rule.id && Number.isFinite(severity)) rulesById.set(rule.id, severity);
    }
    for (const result of runEntry.results ?? []) {
      const ruleId = result.ruleId ?? "unknown-rule";
      const path = result.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "(unknown-path)";
      const ownSeverity = Number.parseFloat(result.properties?.["security-severity"] ?? "");
      const severity = Number.isFinite(ownSeverity) ? ownSeverity : rulesById.get(ruleId) ?? 0;
      findings.push({ ruleId, path, severity, message: result.message?.text ?? "" });
    }
  }
  return findings;
}
