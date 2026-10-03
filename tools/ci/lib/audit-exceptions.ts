/**
 * audit-exceptions.ts — the advisories `local-ci/check-toko`'s raw
 * `bun audit --audit-level=low` step knowingly ignores, read from
 * `tools/ci/dependency-audit-exceptions.json`.
 *
 * Root tooling's own copy of the rule `apps/cms/scripts/dependency-audit-
 * exceptions.ts` states for `apps/cms`'s `deps:audit:check` (root code never
 * imports `apps/cms` internals — AGENTS.md's "Workspace boundaries"). Same
 * contract: an `overrides` entry is always tried first; an exception exists
 * only when no published version fixes the advisory, and every entry carries
 * a reason, an owner, and a `reviewDate`. Unlike that gate, this one FAILS
 * once `reviewDate` has passed — an exception nobody re-justified is a
 * vulnerability nobody is looking at any more.
 */

export interface AuditException {
  /** GHSA id exactly as `bun audit --ignore` accepts it, e.g. `GHSA-xxxx-xxxx-xxxx`. */
  advisory: string;
  packageName: string;
  /** What makes it not exploitable HERE — not "low risk". */
  reason: string;
  owner: string;
  /** ISO date (YYYY-MM-DD). Re-justify by then or remove. */
  reviewDate: string;
}

const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse and validate the committed exceptions file.
 *
 * @throws {Error} on a malformed entry — an unparseable list must never be
 *   read as "no exceptions", nor as "ignore everything".
 */
export function parseAuditExceptions(text: string): AuditException[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("dependency-audit-exceptions.json must be a JSON array");
  return parsed.map((raw, index) => {
    const entry = raw as Partial<AuditException>;
    const where = `dependency-audit-exceptions.json[${index}]`;
    if (typeof entry.advisory !== "string" || !GHSA.test(entry.advisory)) {
      throw new Error(`${where}: advisory must be a GHSA id`);
    }
    for (const field of ["packageName", "owner"] as const) {
      if (typeof entry[field] !== "string" || entry[field]!.trim() === "") {
        throw new Error(`${where}: ${field} must be a non-empty string`);
      }
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 40) {
      throw new Error(`${where}: reason must say why it is not exploitable here (>= 40 chars)`);
    }
    if (typeof entry.reviewDate !== "string" || !ISO_DATE.test(entry.reviewDate) || Number.isNaN(Date.parse(entry.reviewDate))) {
      throw new Error(`${where}: reviewDate must be an ISO date (YYYY-MM-DD)`);
    }
    return entry as AuditException;
  });
}

/**
 * The `--ignore=<GHSA>` arguments for `bun audit`, or an error naming every
 * entry whose `reviewDate` is before `today` (UTC, YYYY-MM-DD).
 */
export function auditIgnoreArgs(
  exceptions: readonly AuditException[],
  today: string
): { ok: true; args: string[] } | { ok: false; expired: AuditException[] } {
  const expired = exceptions.filter((entry) => entry.reviewDate < today);
  if (expired.length > 0) return { ok: false, expired };
  return { ok: true, args: exceptions.map((entry) => `--ignore=${entry.advisory}`) };
}
