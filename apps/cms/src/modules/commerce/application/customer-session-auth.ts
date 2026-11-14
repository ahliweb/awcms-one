/**
 * The bearer guard every `customerBearer`-secured storefront route calls
 * (Issue #89, contract #86/ADR-0016 D3) — parses `Authorization: Bearer
 * cs_…`, looks up a LIVE session (`customer-account-store.ts`'s
 * `findSessionByTokenHash`, which already joins the owning account), touches
 * it (sliding TTL, at most once per `SESSION_TOUCH_THRESHOLD_SECONDS`), and
 * returns either the account or `{ok: false}` for a missing/invalid/expired
 * bearer (`401 UNAUTHENTICATED`).
 *
 * Deliberately does NOT special-case a blocked account — it still returns
 * `ok: true` with `account.status === "blocked"`, because what a blocked
 * account may still do differs per route: `me` (GET/PATCH) answers
 * `403 ACCOUNT_BLOCKED` on it, but `logout` does not — a blocked shopper
 * revoking their own still-live session is exactly the one thing this
 * endpoint should never refuse. Each route decides; this guard only answers
 * "is there a live session, and whose is it".
 *
 * This file does NOT name `awcms_sessions` (the STAFF session table) —
 * `identity:session-readers:check` is keyed to that literal string and has
 * nothing to say about `awcms_commerce_customer_sessions`, a fifth,
 * independent namespace (see `domain/customer-session-token.ts`'s own header
 * for why that separation is deliberate).
 */
import {
  findSessionByTokenHash,
  touchSession,
  type CustomerAccountRecord
} from "./customer-account-store";
import {
  hashCustomerSessionToken,
  looksLikeCustomerSessionToken
} from "../domain/customer-session-token";

export type CustomerSessionAuthResult =
  | { ok: true; account: CustomerAccountRecord; sessionId: string }
  | { ok: false; reason: "unauthenticated" };

/**
 * The read-only half of `requireCustomerSession`: is there a LIVE session for
 * the bearer on this request, in THIS tenant, and whose is it. Nothing is
 * written (no sliding-TTL touch), so the pre-body authentication boundary
 * (`lib/auth/customer-bearer-body-authentication.ts`) can call it without
 * making an unauthenticated-or-not decision cost a write.
 */
export async function findLiveCustomerSession(
  request: Request,
  tx: Bun.SQL,
  tenantId: string,
  now: Date = new Date()
): Promise<{ account: CustomerAccountRecord; sessionId: string } | null> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const token = match?.[1]?.trim();

  if (!token || !looksLikeCustomerSessionToken(token)) return null;

  const session = await findSessionByTokenHash(
    tx,
    hashCustomerSessionToken(token),
    now,
    tenantId
  );

  return session ? { account: session.account, sessionId: session.id } : null;
}

/**
 * `tenantId` is required (not re-derived from the session row) because the
 * caller is already inside a `withPublicCommerceTenant`-resolved
 * transaction — a token has to belong to THIS tenant's account, not merely
 * be a live token somewhere, which is exactly what `touchSession`'s own
 * `tenant_id = ` predicate enforces on the write half; the read half is
 * scoped by RLS on `tx` already (FORCE RLS on both tables).
 */
export async function requireCustomerSession(
  request: Request,
  tx: Bun.SQL,
  tenantId: string,
  now: Date = new Date()
): Promise<CustomerSessionAuthResult> {
  const session = await findLiveCustomerSession(request, tx, tenantId, now);

  if (!session) {
    return { ok: false, reason: "unauthenticated" };
  }

  await touchSession(tx, tenantId, session.sessionId, now);

  return { ok: true, account: session.account, sessionId: session.sessionId };
}
