/**
 * reporter.mjs — the finding/report apparatus the audit gates share.
 *
 * ## Why this is a shared module and not two copies
 *
 * `audit-dokumen.mjs` and `audit-rilis.mjs` both need the same twenty lines: a
 * findings array, a notes array, a `violation()` push, and a printer that
 * groups findings by check name and exits 1. Writing that twice from the
 * start would mean any change to gate OUTPUT — a `--format=json` mode for CI
 * annotations, a stable summary line another tool reads, a machine-readable
 * count — has to be made twice and re-made twice on every future gate. This
 * module is adapted from `ahliweb/media-lenterakalteng`'s
 * `packages/gerbang/lib/reporter.mjs`, which consolidated exactly that
 * duplication after it had already spread across three gates there; sharing
 * it here from the outset means this repo never accumulates the copies in
 * the first place.
 *
 * ## Two behaviours that are load-bearing
 *
 *   - **Notes print whatever the outcome.** A gate that runs zero checks and
 *     says nothing is indistinguishable from a gate that ran and found
 *     nothing. Every `note()` line survives to stdout even on the green path.
 *   - **The header prints on construction**, before any check runs. A crash
 *     mid-audit then still produces a stack trace with something above it
 *     naming which gate died.
 *
 * ## What is deliberately NOT here
 *
 *   - **No severity levels.** These gates are binary by design: a finding
 *     reddens the gate. A severity axis invites a "warning" tier, and a
 *     warning that never fails anything is a line nobody reads.
 *   - **No `process.exitCode` assignment.** `finish()` exits, so a gate
 *     cannot accidentally continue past its own verdict and overwrite it.
 */

/** @typedef {{ gate: string, file: string, message: string }} Finding */

/**
 * Render a gate's result. Pure, so the format has a checker that does not
 * need to spawn a subprocess and read stdout.
 *
 * @param {string[]} notes - printed whatever the outcome
 * @param {Finding[]} findings
 * @returns {{ text: string, exitCode: number }}
 */
export function formatReport(notes, findings) {
  const lines = notes.map((note) => `  ${note}`);

  if (findings.length === 0) {
    lines.push("", "OK — no violations.");
    return { text: lines.join("\n"), exitCode: 0 };
  }

  lines.push("", `FAILED — ${findings.length} violation(s):`, "");

  // Grouped by gate so one cause reads as one block rather than as N findings
  // scattered among its siblings. Insertion order is the order the checks
  // ran, which is the order the file declares them.
  /** @type {Map<string, Finding[]>} */
  const byGate = new Map();
  for (const finding of findings) {
    const existing = byGate.get(finding.gate);
    if (existing) existing.push(finding);
    else byGate.set(finding.gate, [finding]);
  }

  for (const [gate, list] of byGate) {
    lines.push(`  [${gate}] ${list.length}`);
    for (const { file, message } of list) lines.push(`    ${file}: ${message}`);
    lines.push("");
  }

  return { text: lines.join("\n"), exitCode: 1 };
}

/**
 * Start a gate's report. Prints the header immediately.
 *
 * @param {string} name - the gate's name, e.g. `"audit:dokumen"`
 * @returns {{
 *   violation: (gate: string, file: string, message: string) => void,
 *   note: (line: string) => void,
 *   count: () => number,
 *   finish: () => never
 * }}
 */
export function createReporter(name) {
  console.log(`-- ${name} --`);

  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const notes = [];

  return {
    violation(gate, file, message) {
      findings.push({ gate, file, message });
    },

    note(line) {
      notes.push(line);
    },

    count() {
      return findings.length;
    },

    /**
     * Print and exit. Never returns, so nothing can run after a verdict and
     * change it.
     */
    finish() {
      const { text, exitCode } = formatReport(notes, findings);
      console.log(text);
      process.exit(exitCode);
    }
  };
}
