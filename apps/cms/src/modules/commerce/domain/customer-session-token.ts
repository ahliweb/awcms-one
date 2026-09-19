import { createHash, randomBytes } from "node:crypto";

/**
 * Customer bearer session tokens (Issue #87, C1, contract #86/ADR-0016 D3).
 * Pure — no database, no I/O beyond the platform CSPRNG.
 *
 * Same construction as `src/lib/auth/session-token.ts`/`reset-token.ts` — 32
 * CSPRNG bytes, base64url; `sha256:` + hex digest — but a FRESH, independent
 * implementation, not a reuse of that module's `hashSessionToken`. Issue
 * #87 is explicit that `src/lib/auth` is shape-precedent only and must not
 * be imported from here: that dispatcher's job is to tell apart the admin
 * SESSION/machine-credential/tenant-selection/delegated-access namespaces
 * (ADR-0049/ADR-0088/ADR-0090), and a customer bearer token is deliberately
 * a FIFTH, entirely separate namespace stored in its own table
 * (`awcms_commerce_customer_sessions`) — routing it through the admin-side
 * dispatcher would risk a customer token being looked up against (or
 * confused with) an admin session by a future maintainer who assumes
 * `hashSessionToken` is the one true session hash in this codebase.
 *
 * The `cs_` prefix (Customer Session) lets `looksLikeCustomerSessionToken`
 * reject an obviously-wrong bearer value BEFORE a database round trip —
 * exactly the same cheap shape check `MACHINE_CREDENTIAL_TOKEN_PREFIX`/
 * `PRINCIPAL_SELECTION_TOKEN_PREFIX` already do on the admin side.
 */

export const CUSTOMER_SESSION_TOKEN_PREFIX = "cs_";

/** 30 days, sliding — ADR-0016 D3. */
export const CUSTOMER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** 32 raw bytes, base64url-encoded — the same length every random-token generator in this codebase uses. */
const TOKEN_RANDOM_BYTES = 32;

/** `base64url(32 bytes)` is always 43 characters (no padding). */
const TOKEN_RANDOM_PART_LENGTH = 43;

export function generateCustomerSessionToken(): string {
  return `${CUSTOMER_SESSION_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString("base64url")}`;
}

export function hashCustomerSessionToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/**
 * Cheap shape check — prefix + exact length — used BEFORE a database
 * lookup so an obviously-wrong `Authorization` header never reaches the
 * `token_hash` index. Not a security boundary by itself (that is
 * `findSessionByTokenHash`'s job); purely an early exit for garbage input.
 */
export function looksLikeCustomerSessionToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(CUSTOMER_SESSION_TOKEN_PREFIX) &&
    value.length ===
      CUSTOMER_SESSION_TOKEN_PREFIX.length + TOKEN_RANDOM_PART_LENGTH
  );
}
