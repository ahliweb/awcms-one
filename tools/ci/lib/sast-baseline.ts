/**
 * sast-baseline.ts — the one-time ADOPTION baseline of the OpenGrep scan
 * (ADR-0060 D4), and the marker saying it has not been generated yet.
 *
 * The baseline (`tools/ci/security-baseline.json`, see `lib/baseline.ts`) has
 * to come from one full scan of the tree under review. That scan takes longer
 * than a contributor's workstation is allowed to spend on one CI command, so it
 * is run once on the CI server (`bun tools/ci/cli/sast-baseline.ts`), never
 * guessed and never filled in by hand from another repository's triage.
 *
 * Until then `ADOPTION_MARKER_PATH` exists and the baseline is `[]`. While the
 * marker exists the `local-ci/security` leg fails closed, whatever the scan
 * finds, so a tree whose baseline was never generated cannot go green by
 * accident. The generator refuses to run unless both hold (it never ADDS to an
 * existing baseline: the baseline only shrinks), writes every ERROR finding as
 * one `{ruleId, path, reason}` entry and deletes the marker; the reviewer then
 * triages each entry and sets `BASELINE_CEILING` in
 * `tests/local-ci-baseline.test.mjs` to the generated count.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaselineEntry, SecurityFinding } from "./baseline.ts";

/** Present while the adoption baseline has not been generated; deleted by the generator. */
export const ADOPTION_MARKER_PATH = "tools/ci/sast/ADOPTION-BASELINE-PENDING";

export function adoptionBaselinePending(root: string): boolean {
  return existsSync(join(root, ADOPTION_MARKER_PATH));
}

/**
 * Why the generator must not run, or `undefined` when it may: the marker must
 * exist and the committed baseline must be empty. Anything else means a
 * baseline already exists, and a script never adds entries to one.
 */
export function generatorRefusal(markerPresent: boolean, baseline: readonly BaselineEntry[]): string | undefined {
  if (!markerPresent) {
    return `${ADOPTION_MARKER_PATH} is absent: the adoption baseline was already generated. The baseline only shrinks; a new entry is a hand edit with a reason, reviewed in its PR.`;
  }
  if (baseline.length > 0) {
    return `the baseline already holds ${baseline.length} entr${baseline.length === 1 ? "y" : "ies"}; the generator only writes into an empty one.`;
  }
  return undefined;
}

/**
 * One entry per (ruleId, path) among the ERROR findings — the same key the
 * gate matches on (`isBaselined`) — sorted by path then rule. WARNING and
 * INFO findings never block, so they are never baselined.
 */
export function buildAdoptionBaseline(findings: readonly SecurityFinding[], date: string): BaselineEntry[] {
  const groups = new Map<string, { ruleId: string; path: string; lines: number[] }>();
  for (const finding of findings) {
    if (finding.severity !== "ERROR") continue;
    const key = `${finding.path}\u0000${finding.ruleId}`;
    const group = groups.get(key) ?? { ruleId: finding.ruleId, path: finding.path, lines: [] };
    if (finding.line !== undefined) group.lines.push(finding.line);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.path.localeCompare(b.path) || a.ruleId.localeCompare(b.ruleId))
    .map(({ ruleId, path, lines }) => {
      const sorted = [...lines].sort((a, b) => a - b);
      const where = sorted.length > 0 ? `line${sorted.length === 1 ? "" : "s"} ${sorted.join(", ")}` : "line unknown";
      return {
        ruleId,
        path,
        reason: `pre-existing finding at adoption ${date} (${where}); not yet triaged: fix it, or replace this reason with the triage`
      };
    });
}

/**
 * Run `fn` with a fresh temporary directory that is removed afterwards — on
 * success, on a throw, and on SIGTERM/SIGINT (a wrapper that stops the run at
 * its time limit sends SIGTERM). The engine's raw JSON report is an
 * intermediate, not evidence (internal cross-portfolio standard DL-062).
 */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const onSignal = (signal: NodeJS.Signals) => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    return await fn(dir);
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    rmSync(dir, { recursive: true, force: true });
  }
}
