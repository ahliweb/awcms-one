/**
 * redact.ts — scrub tokens and DSN passwords out of local-ci evidence
 * (leg logs, SARIF payloads, watcher records) before anything is written to
 * the state directory or printed.
 *
 * Reuses the shared root redactor, `packages/gerbang/lib/redact.mjs`
 * (`redactText`/`redactLine`, added by issue #224's `tools/deploy/*.sh`
 * work) — the exact "a helper is declared once" rule `tests/
 * standar-skrip.test.mjs` enforces for `packages/gerbang/lib/`. This module
 * is a thin re-export rather than a second implementation: `apps/cms`'s own
 * `redact()` (issue #205) is `apps/cms`-internal and off-limits to root code
 * per AGENTS.md's workspace-boundary rule, and `packages/gerbang/lib/
 * redact.mjs` is the root-owned equivalent every other root script imports
 * instead of re-declaring the same patterns.
 */
import { redactText } from "../../../packages/gerbang/lib/redact.mjs";

/**
 * Redact anything that looks like a secret from a block of text meant to be
 * written to a log file, a SARIF upload body, or stdout.
 *
 * @param {string} text
 * @returns {string}
 */
export function redact(text: string): string {
  return redactText(text);
}
