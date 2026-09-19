/**
 * `awcms_commerce_customer_accounts`/`_otps`/`_sessions` persistence — Issue
 * #87 (C1, part of epic #32; contract #86/ADR-0016). Every function here
 * takes a `tx: Bun.SQL` already inside a tenant-scoped transaction (the same
 * `withTenant`/`withTenantOrThrow` composition-root pattern
 * `customer-directory.ts`/`order-directory.ts` already use — RLS is
 * enforced by `app.current_tenant_id` on the transaction, not re-derived
 * here) and an explicit `tenantId` for the `WHERE` clauses, mirroring every
 * sibling store in this module.
 *
 * ## `consumeOtp` — externally, every failure is ONE generic error
 *
 * `consumeOtp` returns a DISCRIMINATED reason (`invalid`/`expired`/
 * `exhausted`/`consumed`/`missing`) purely so this module's own audit trail
 * and internal logic can tell them apart. Issue #89 (the HTTP layer this
 * repo does not build yet) MUST collapse every one of these into a single
 * generic `OTP_INVALID` response — returning a DIFFERENT status/message per
 * reason would let an attacker distinguish "wrong code" from "code
 * expired" from "too many attempts" from "no such request", each of which
 * narrows the search space for the next guess. Do not leak the reason
 * outside this module.
 *
 * ## Never log/return a hash
 *
 * `code_hash`/`token_hash` never appear in a returned DTO, an audit
 * attribute, or a `console.*` call anywhere in this file — the same
 * discipline `awcms-sensitive-data` requires for `password_hash`. E-mail and
 * phone are masked (`maskIdentifierValue`/`maskPhone`) before they reach any
 * audit attribute.
 */
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { maskIdentifierValue } from "../../profile-identity/domain/identifier";
import { maskPhone } from "../domain/phone-normalisation";
import { findOrCreateCustomerByPhone } from "./customer-directory";
import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  generateOtpCode,
  hashOtpCode
} from "../domain/customer-otp";
import {
  CUSTOMER_SESSION_TTL_SECONDS,
  generateCustomerSessionToken,
  hashCustomerSessionToken
} from "../domain/customer-session-token";
import { resolveHistoryFrom } from "../domain/customer-account-validation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE_ACCOUNT = "customer_account";
const AUDIT_RESOURCE_TYPE_SESSION = "customer_session";

/** A session's `last_seen_at` is only rewritten when it is at least this old — avoids a write on every single request. */
const SESSION_TOUCH_THRESHOLD_SECONDS = 5 * 60;

export type CustomerAccountRecord = {
  id: string;
  customerId: string;
  emailMasked: string;
  status: "active" | "blocked";
  emailVerifiedAt: string | null;
  historyFrom: string;
  lastLoginAt: string | null;
  createdAt: string;
};

type AccountRow = {
  id: string;
  customer_id: string;
  email_normalized: string;
  status: string;
  email_verified_at: Date | null;
  history_from: Date;
  last_login_at: Date | null;
  created_at: Date;
};

function toAccountRecord(row: AccountRow): CustomerAccountRecord {
  return {
    id: row.id,
    customerId: row.customer_id,
    emailMasked: maskIdentifierValue(row.email_normalized, "email"),
    status: row.status as "active" | "blocked",
    emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
    historyFrom: row.history_from.toISOString(),
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString()
  };
}

export async function findAccountByEmail(
  tx: Bun.SQL,
  tenantId: string,
  emailNormalized: string
): Promise<CustomerAccountRecord | null> {
  const rows = (await tx`
    SELECT id, customer_id, email_normalized, status, email_verified_at,
           history_from, last_login_at, created_at
    FROM awcms_commerce_customer_accounts
    WHERE tenant_id = ${tenantId} AND email_normalized = ${emailNormalized}
  `) as AccountRow[];
  return rows[0] ? toAccountRecord(rows[0]) : null;
}

/**
 * D4's conflict check (Issue #89) — is this normalised phone ALREADY bound to
 * an account (any account, this lookup does not care whose)? Joined through
 * `awcms_commerce_customers` because the phone lives there, not on the
 * account row itself (`awcms_commerce_customer_accounts.customer_id` is the
 * only link). A guest checkout row with no account bound to it is NOT a
 * conflict — this is exactly why `createAccountForCustomer` is still safe to
 * call after this returns `null`.
 */
export async function findAccountByPhone(
  tx: Bun.SQL,
  tenantId: string,
  phone: string
): Promise<CustomerAccountRecord | null> {
  const rows = (await tx`
    SELECT a.id, a.customer_id, a.email_normalized, a.status,
           a.email_verified_at, a.history_from, a.last_login_at, a.created_at
    FROM awcms_commerce_customer_accounts a
    JOIN awcms_commerce_customers c ON c.id = a.customer_id
    WHERE a.tenant_id = ${tenantId} AND c.tenant_id = ${tenantId}
      AND c.phone = ${phone} AND c.deleted_at IS NULL
  `) as AccountRow[];
  return rows[0] ? toAccountRecord(rows[0]) : null;
}

export async function findAccountById(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<CustomerAccountRecord | null> {
  const rows = (await tx`
    SELECT id, customer_id, email_normalized, status, email_verified_at,
           history_from, last_login_at, created_at
    FROM awcms_commerce_customer_accounts
    WHERE tenant_id = ${tenantId} AND id = ${accountId}
  `) as AccountRow[];
  return rows[0] ? toAccountRecord(rows[0]) : null;
}

export type CreateAccountForCustomerInput = {
  name: string;
  phone: string;
  emailNormalized: string;
  now?: Date;
};

/**
 * ADR-0016 D4 — creates (or reuses) the customer row by normalised phone the
 * same way `findOrCreateCustomerByPhone` already does for guest checkout,
 * then creates the account bound to it with `history_from` resolved by the
 * pure `resolveHistoryFrom` function. Called ONLY after the registration OTP
 * has been verified (the caller — Issue #89's route — is responsible for
 * that ordering); this function does not itself check any OTP.
 */
export async function createAccountForCustomer(
  tx: Bun.SQL,
  tenantId: string,
  input: CreateAccountForCustomerInput,
  correlationId?: string
): Promise<CustomerAccountRecord> {
  const now = input.now ?? new Date();

  // Read the guest row's own state BEFORE `findOrCreateCustomerByPhone`
  // creates/touches it, so `resolveHistoryFrom` sees the row's ORIGINAL
  // `created_at`/`email` — the ones D4 actually asks about — rather than a
  // freshly-inserted row's own `now()`.
  const existingGuestRows = (await tx`
    SELECT email, created_at FROM awcms_commerce_customers
    WHERE tenant_id = ${tenantId} AND phone = ${input.phone} AND deleted_at IS NULL
  `) as { email: string | null; created_at: Date }[];
  const existingGuest = existingGuestRows[0] ?? null;

  const customer = await findOrCreateCustomerByPhone(
    tx,
    tenantId,
    input.name,
    input.phone,
    null,
    correlationId
  );

  const historyFrom = existingGuest
    ? resolveHistoryFrom({
        guestCustomerEmail: existingGuest.email,
        verifiedEmail: input.emailNormalized,
        guestCreatedAt: existingGuest.created_at,
        now
      })
    : now;

  const rows = (await tx`
    INSERT INTO awcms_commerce_customer_accounts (
      tenant_id, customer_id, email_normalized, status,
      email_verified_at, history_from
    )
    VALUES (
      ${tenantId}, ${customer.id}, ${input.emailNormalized}, 'active',
      ${now}, ${historyFrom}
    )
    RETURNING id, customer_id, email_normalized, status, email_verified_at,
              history_from, last_login_at, created_at
  `) as AccountRow[];

  const record = toAccountRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE_ACCOUNT,
    resourceId: record.id,
    message: "Customer account created via e-mail OTP registration.",
    attributes: {
      emailMasked: record.emailMasked,
      phoneMasked: maskPhone(input.phone)
    },
    correlationId
  });

  return record;
}

export type IssuedOtp = {
  code: string;
  expiresAt: string;
};

/** Which identifier column an OTP row is keyed by — `"email_normalized"` (Issue #87/#89, the default) or `"phone_normalized"` (Issue #108, `via: "whatsapp"` login only — see `sql/925`'s header). */
export type OtpIdentifierColumn = "email_normalized" | "phone_normalized";

/**
 * Invalidates every previous unconsumed code for this (tenant, identifier,
 * purpose) — a NEW `issueOtp` call always supersedes any code already sent,
 * so a stale, still-valid earlier code can never be replayed once a fresher
 * one exists. `registration` stores the pending registration payload
 * (name/phone) for `purpose: "register"` only; `null` for `purpose:
 * "login"` and for every `phone_normalized`-keyed row (registration stays
 * e-mail-OTP only — ADR-0017 D5).
 *
 * `identifierColumn` defaults to `"email_normalized"` so every existing
 * caller (Issue #87/#89's e-mail-only flow) is unaffected; Issue #108's
 * WhatsApp login path is the only caller that passes `"phone_normalized"`.
 */
export async function issueOtp(
  tx: Bun.SQL,
  tenantId: string,
  identifierValue: string,
  purpose: "login" | "register",
  registration: { name: string; phone: string } | null = null,
  now: Date = new Date(),
  identifierColumn: OtpIdentifierColumn = "email_normalized"
): Promise<IssuedOtp> {
  if (identifierColumn === "phone_normalized") {
    await tx`
      UPDATE awcms_commerce_customer_otps
      SET consumed_at = ${now}
      WHERE tenant_id = ${tenantId}
        AND phone_normalized = ${identifierValue}
        AND purpose = ${purpose}
        AND consumed_at IS NULL
    `;
  } else {
    await tx`
      UPDATE awcms_commerce_customer_otps
      SET consumed_at = ${now}
      WHERE tenant_id = ${tenantId}
        AND email_normalized = ${identifierValue}
        AND purpose = ${purpose}
        AND consumed_at IS NULL
    `;
  }

  const code = generateOtpCode();
  const codeHash = hashOtpCode(code, identifierValue, tenantId);
  const expiresAt = new Date(now.getTime() + OTP_TTL_SECONDS * 1000);
  const registrationJson =
    registration === null ? null : JSON.stringify(registration);
  const emailColumnValue =
    identifierColumn === "email_normalized" ? identifierValue : null;
  const phoneColumnValue =
    identifierColumn === "phone_normalized" ? identifierValue : null;

  await tx`
    INSERT INTO awcms_commerce_customer_otps (
      tenant_id, email_normalized, phone_normalized, purpose, code_hash,
      registration, attempts, expires_at
    )
    VALUES (
      ${tenantId}, ${emailColumnValue}, ${phoneColumnValue}, ${purpose},
      ${codeHash}, ${registrationJson}::jsonb, 0, ${expiresAt}
    )
  `;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: "customer_otp",
    resourceId: undefined,
    message: `Customer OTP issued for ${purpose}.`,
    attributes: {
      identifierMasked:
        identifierColumn === "phone_normalized"
          ? maskPhone(identifierValue)
          : maskIdentifierValue(identifierValue, "email"),
      purpose
    }
  });

  return { code, expiresAt: expiresAt.toISOString() };
}

export type ConsumeOtpResult =
  | {
      ok: true;
      otp: {
        id: string;
        purpose: "login" | "register";
        registration: { name: string; phone: string } | null;
      };
    }
  | {
      ok: false;
      reason: "missing" | "invalid" | "expired" | "exhausted" | "consumed";
    };

/**
 * Verifies + consumes a code in ONE `UPDATE ... RETURNING` — no read then
 * write, so two concurrent guesses against the same row cannot both read
 * `attempts = 4` and both proceed as the 5th (and last) try. The row
 * targeted is the MOST RECENT unconsumed, unexpired one for this
 * (tenant, email, purpose) — `issueOtp` already invalidated every older row,
 * so there is at most one live candidate at a time in the normal case; the
 * `ORDER BY ... LIMIT 1` subquery is defensive, not load-bearing.
 *
 * The single UPDATE always increments `attempts` (even on an ultimately
 * wrong code) and always sets `consumed_at` when it lands on the correct
 * code OR crosses `OTP_MAX_ATTEMPTS` — that second case is what makes
 * "exhausted" durable: the row is dead even if the 6th guess happens to be
 * correct.
 */
/**
 * `o.registration` in the `consumeOtp` query below round-trips through this
 * codebase's `Bun.SQL` driver as a raw JSON STRING, not a parsed object —
 * unlike a plain `SELECT` of a `jsonb` column, the `UPDATE … FROM target …
 * RETURNING` shape apparently loses the column's type OID, so the driver
 * falls back to text (confirmed empirically by Issue #89's integration
 * suite, the first caller that ever read a NON-null `registration` back out
 * of this query — #87's own tests never exercised the register path far
 * enough to notice). Defensive on either shape, so a future driver upgrade
 * that starts parsing it correctly does not silently double-parse.
 */
function parseRegistrationColumn(
  value: { name: string; phone: string } | string | null
): { name: string; phone: string } | null {
  if (value === null) return null;
  if (typeof value === "string") {
    return JSON.parse(value) as { name: string; phone: string };
  }
  return value;
}

export async function consumeOtp(
  tx: Bun.SQL,
  tenantId: string,
  identifierValue: string,
  purpose: "login" | "register",
  code: string,
  now: Date = new Date(),
  identifierColumn: OtpIdentifierColumn = "email_normalized"
): Promise<ConsumeOtpResult> {
  const candidateHash = hashOtpCode(code, identifierValue, tenantId);

  const rows = (
    identifierColumn === "phone_normalized"
      ? await tx`
    WITH target AS (
      SELECT id, attempts AS attempts_before FROM awcms_commerce_customer_otps
      WHERE tenant_id = ${tenantId}
        AND phone_normalized = ${identifierValue}
        AND purpose = ${purpose}
        AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    )
    UPDATE awcms_commerce_customer_otps AS o
    SET
      attempts = o.attempts + 1,
      consumed_at = CASE
        WHEN o.code_hash = ${candidateHash} AND o.expires_at > ${now}
             AND o.attempts < ${OTP_MAX_ATTEMPTS} THEN ${now}::timestamptz
        WHEN o.attempts + 1 >= ${OTP_MAX_ATTEMPTS} THEN ${now}::timestamptz
        ELSE NULL
      END
    FROM target
    WHERE o.id = target.id
    RETURNING
      o.id,
      o.purpose,
      o.registration,
      o.code_hash = ${candidateHash} AS code_matched,
      o.expires_at > ${now} AS not_expired,
      target.attempts_before AS attempts_before_this_try,
      o.consumed_at IS NOT NULL AS is_consumed
  `
      : await tx`
    WITH target AS (
      SELECT id, attempts AS attempts_before FROM awcms_commerce_customer_otps
      WHERE tenant_id = ${tenantId}
        AND email_normalized = ${identifierValue}
        AND purpose = ${purpose}
        AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    )
    UPDATE awcms_commerce_customer_otps AS o
    SET
      attempts = o.attempts + 1,
      consumed_at = CASE
        WHEN o.code_hash = ${candidateHash} AND o.expires_at > ${now}
             AND o.attempts < ${OTP_MAX_ATTEMPTS} THEN ${now}::timestamptz
        WHEN o.attempts + 1 >= ${OTP_MAX_ATTEMPTS} THEN ${now}::timestamptz
        ELSE NULL
      END
    FROM target
    WHERE o.id = target.id
    RETURNING
      o.id,
      o.purpose,
      o.registration,
      o.code_hash = ${candidateHash} AS code_matched,
      o.expires_at > ${now} AS not_expired,
      -- o.attempts in RETURNING is the NEW value (already incremented); the
      -- pre-update count must come from the CTE, or the fifth and last allowed
      -- attempt reads as already exhausted even when it matched.
      target.attempts_before AS attempts_before_this_try,
      o.consumed_at IS NOT NULL AS is_consumed
  `
  ) as {
    id: string;
    purpose: "login" | "register";
    registration: { name: string; phone: string } | string | null;
    code_matched: boolean;
    not_expired: boolean;
    attempts_before_this_try: number;
    is_consumed: boolean;
  }[];

  const row = rows[0];
  if (!row) return { ok: false, reason: "missing" };

  const wasAlreadyExhausted = row.attempts_before_this_try >= OTP_MAX_ATTEMPTS;
  const succeeded = row.code_matched && row.not_expired && !wasAlreadyExhausted;

  if (succeeded) {
    return {
      ok: true,
      otp: {
        id: row.id,
        purpose: row.purpose,
        registration: parseRegistrationColumn(row.registration)
      }
    };
  }

  if (wasAlreadyExhausted) return { ok: false, reason: "exhausted" };
  if (!row.not_expired) return { ok: false, reason: "expired" };
  if (row.attempts_before_this_try + 1 >= OTP_MAX_ATTEMPTS)
    return { ok: false, reason: "exhausted" };
  return { ok: false, reason: "invalid" };
}

export type IssuedSession = {
  token: string;
  sessionId: string;
  expiresAt: string;
};

export async function issueSession(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  meta: { clientIpHash: string | null; userAgentSummary: string | null } = {
    clientIpHash: null,
    userAgentSummary: null
  },
  now: Date = new Date()
): Promise<IssuedSession> {
  const token = generateCustomerSessionToken();
  const tokenHash = hashCustomerSessionToken(token);
  const expiresAt = new Date(
    now.getTime() + CUSTOMER_SESSION_TTL_SECONDS * 1000
  );

  const rows = (await tx`
    INSERT INTO awcms_commerce_customer_sessions (
      tenant_id, account_id, token_hash, issued_at, expires_at,
      client_ip_hash, user_agent_summary
    )
    VALUES (
      ${tenantId}, ${accountId}, ${tokenHash}, ${now}, ${expiresAt},
      ${meta.clientIpHash}, ${meta.userAgentSummary}
    )
    RETURNING id
  `) as { id: string }[];

  await tx`
    UPDATE awcms_commerce_customer_accounts
    SET last_login_at = ${now}, updated_at = ${now}
    WHERE tenant_id = ${tenantId} AND id = ${accountId}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE_SESSION,
    resourceId: rows[0]!.id,
    message: "Customer session issued."
  });

  return { token, sessionId: rows[0]!.id, expiresAt: expiresAt.toISOString() };
}

export type CustomerSessionRecord = {
  id: string;
  accountId: string;
  expiresAt: string;
  lastSeenAt: string | null;
  account: CustomerAccountRecord;
};

type SessionJoinRow = {
  id: string;
  account_id: string;
  expires_at: Date;
  last_seen_at: Date | null;
  acc_id: string;
  acc_customer_id: string;
  acc_email_normalized: string;
  acc_status: string;
  acc_email_verified_at: Date | null;
  acc_history_from: Date;
  acc_last_login_at: Date | null;
  acc_created_at: Date;
};

/**
 * Looks up a LIVE session (not revoked, not expired) by its token hash and
 * joins the owning account in one query — the caller (Issue #89's auth
 * guard) needs both to authorize a request, and splitting this into two
 * round trips would just be two chances for the two reads to observe
 * different transactions.
 */
export async function findSessionByTokenHash(
  tx: Bun.SQL,
  tokenHash: string,
  now: Date = new Date()
): Promise<CustomerSessionRecord | null> {
  const rows = (await tx`
    SELECT
      s.id, s.account_id, s.expires_at, s.last_seen_at,
      a.id AS acc_id, a.customer_id AS acc_customer_id,
      a.email_normalized AS acc_email_normalized, a.status AS acc_status,
      a.email_verified_at AS acc_email_verified_at,
      a.history_from AS acc_history_from,
      a.last_login_at AS acc_last_login_at, a.created_at AS acc_created_at
    FROM awcms_commerce_customer_sessions s
    JOIN awcms_commerce_customer_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ${tokenHash}
      AND s.revoked_at IS NULL
      AND s.expires_at > ${now}
  `) as SessionJoinRow[];

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    accountId: row.account_id,
    expiresAt: row.expires_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    account: toAccountRecord({
      id: row.acc_id,
      customer_id: row.acc_customer_id,
      email_normalized: row.acc_email_normalized,
      status: row.acc_status,
      email_verified_at: row.acc_email_verified_at,
      history_from: row.acc_history_from,
      last_login_at: row.acc_last_login_at,
      created_at: row.acc_created_at
    })
  };
}

/**
 * Sliding-expiry touch — ONLY writes when `last_seen_at` is missing or older
 * than `SESSION_TOUCH_THRESHOLD_SECONDS`, so a shopper browsing normally
 * does not produce a write on every single request. `expires_at` is
 * advanced by the same TTL every time this DOES write, which is the
 * "sliding" half of D3.
 */
export async function touchSession(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string,
  now: Date = new Date()
): Promise<void> {
  const threshold = new Date(
    now.getTime() - SESSION_TOUCH_THRESHOLD_SECONDS * 1000
  );
  const newExpiresAt = new Date(
    now.getTime() + CUSTOMER_SESSION_TTL_SECONDS * 1000
  );

  await tx`
    UPDATE awcms_commerce_customer_sessions
    SET last_seen_at = ${now}, expires_at = ${newExpiresAt}
    WHERE tenant_id = ${tenantId}
      AND id = ${sessionId}
      AND revoked_at IS NULL
      AND (last_seen_at IS NULL OR last_seen_at < ${threshold})
  `;
}

export async function revokeSession(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string,
  now: Date = new Date()
): Promise<void> {
  await tx`
    UPDATE awcms_commerce_customer_sessions
    SET revoked_at = ${now}
    WHERE tenant_id = ${tenantId} AND id = ${sessionId} AND revoked_at IS NULL
  `;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE_SESSION,
    resourceId: sessionId,
    message: "Customer session revoked."
  });
}

/** Logout-everywhere / account-blocked path — revokes every still-live session for the account. */
export async function revokeAllSessions(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  now: Date = new Date()
): Promise<void> {
  await tx`
    UPDATE awcms_commerce_customer_sessions
    SET revoked_at = ${now}
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId} AND revoked_at IS NULL
  `;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE_SESSION,
    resourceId: accountId,
    message: "All customer sessions revoked."
  });
}

// ---------------------------------------------------------------------------
// commerce:customer-auth:purge — the scheduled job's per-tenant work,
// mirroring `order-directory.ts`'s `expireOrdersForTenant` shape (own
// transaction via `withTenantOrThrow`, bounded DELETE, idempotent — a row
// already deleted is simply absent from the next tick's scan).
// ---------------------------------------------------------------------------

export type PurgeCustomerAuthResult = {
  otpsDeleted: number;
  sessionsDeleted: number;
};

/** Revoked sessions are only purged once they are this old — a freshly revoked session (e.g. "logout on this device") stays queryable for a short grace window. */
const REVOKED_SESSION_PURGE_AFTER_SECONDS = 7 * 24 * 60 * 60;

/**
 * Deletes every expired OTP and every expired/revoked-long-enough-ago
 * session for ONE tenant, bounded per call. `commerce-customer-auth-purge.ts`
 * loops this over every active tenant.
 */
export async function purgeCustomerAuthForTenant(
  sql: Bun.SQL,
  tenantId: string,
  now: Date = new Date(),
  batchLimit = 5000
): Promise<PurgeCustomerAuthResult> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const revokedCutoff = new Date(
        now.getTime() - REVOKED_SESSION_PURGE_AFTER_SECONDS * 1000
      );

      const deletedOtps = (await tx`
        DELETE FROM awcms_commerce_customer_otps
        WHERE id IN (
          SELECT id FROM awcms_commerce_customer_otps
          WHERE tenant_id = ${tenantId} AND expires_at < ${now}
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as { id: string }[];

      const deletedSessions = (await tx`
        DELETE FROM awcms_commerce_customer_sessions
        WHERE id IN (
          SELECT id FROM awcms_commerce_customer_sessions
          WHERE tenant_id = ${tenantId}
            AND (
              expires_at < ${now}
              OR (revoked_at IS NOT NULL AND revoked_at < ${revokedCutoff})
            )
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as { id: string }[];

      return {
        otpsDeleted: deletedOtps.length,
        sessionsDeleted: deletedSessions.length
      };
    },
    { workClass: "background_sync" }
  );
}
