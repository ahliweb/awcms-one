/**
 * Permission key constants for `practice_irm` (Issue #270, ADR-0002).
 *
 * Two resources, separately grantable:
 *
 *   - `domains` — the five-domain CANONICAL CONTENT (admin-only, tenant staff
 *     surface). Read/create/update/delete.
 *   - There is DELIBERATELY no admin permission over `practice_sessions`
 *     content. PRD's Major Risks table names "Journal leakage" as a Critical
 *     risk mitigated by "RLS + ABAC + tests + audit" — a session is a
 *     customer's own private journal entry, and this module ships no
 *     tenant-staff read path into it at all (see `module.ts`'s own header
 *     and this module's README, "What this module deliberately does not
 *     do"). Every session route is a customer bearer-session route, gated by
 *     `verifyEntitlement`, never by a tenant permission.
 */
export const PRACTICE_IRM_MODULE_KEY = "practice_irm";
export const PRACTICE_IRM_DOMAINS_ACTIVITY_CODE = "domains";

export const PRACTICE_IRM_DOMAIN_PERMISSIONS = {
  read: "practice_irm.domains.read",
  create: "practice_irm.domains.create",
  update: "practice_irm.domains.update",
  /** Resets a domain back to the built-in default copy — see `practice-irm-domain-content.ts`'s header. */
  delete: "practice_irm.domains.delete"
} as const;
