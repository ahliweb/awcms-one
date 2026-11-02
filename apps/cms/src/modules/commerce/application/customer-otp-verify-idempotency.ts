/**
 * Storage side of the `otp/verify` idempotency contract (Issue #513, work unit
 * B; the pure half is `domain/customer-otp-idempotency.ts`). It reuses the
 * platform's idempotency infrastructure — the `awcms_idempotency_keys` table
 * (FORCE RLS on `tenant_id`, retention purge by `data-lifecycle`, minimal
 * grants), `saveIdempotencyRecord`, the keyed request-hash HMAC and the
 * anonymous actor namespace — instead of a second table. Only the lookup is
 * local, because it must answer "is the record still inside the replay window"
 * (the shared `findIdempotencyRecord` does not expose the age).
 *
 * ## What a row holds, and what it never holds
 *
 * | column            | value                                                       |
 * | ----------------- | ----------------------------------------------------------- |
 * | `tenant_id`       | the tenant (RLS key)                                        |
 * | `request_scope`   | `commerce.customer_otp_verify`                              |
 * | `actor_key`       | `anonymous`                                                 |
 * | `idempotency_key` | HMAC of the client key (NEVER the raw key)                  |
 * | `request_hash`    | HMAC digest of (purpose, identifier, code) — not the code   |
 * | `response_status` | `200`                                                       |
 * | `response_body`   | `{"outcome":"session_issued","accountId":"<uuid>"}`         |
 * | `created_at`      | the replay window's start                                   |
 *
 * No session token, no OTP code, no raw key, no e-mail/phone. A replay therefore
 * has nothing to read a token back from: it issues a NEW session for the account.
 * The key is hashed with the same secret-keyed HMAC family as the request hash
 * (`lib/security/idempotency-hmac.ts`), domain-separated by a different prefix,
 * so a reader of the table cannot recompute either from a guess.
 */
import {
  ANONYMOUS_IDEMPOTENCY_ACTOR,
  computeRequestHash,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import { keyedRequestHash } from "../../../lib/security/idempotency-hmac";
import {
  OTP_VERIFY_IDEMPOTENCY_SCOPE,
  OTP_VERIFY_IDEMPOTENCY_TTL_SECONDS,
  type OtpVerifyIdentity
} from "../domain/customer-otp-idempotency";
import { acquireCustomerAuthLock } from "./customer-account-store";

/** The value stored in `awcms_idempotency_keys.idempotency_key`: an HMAC of the client key, never the key. */
export function hashOtpVerifyIdempotencyKey(key: string): string {
  return keyedRequestHash(`commerce.customer_otp_verify.key\n${key}`);
}

/** HMAC digest of the normalised request (the code is an input, the digest is not reversible without the server secret). */
export function computeOtpVerifyDigest(identity: OtpVerifyIdentity): string {
  return computeRequestHash({
    scope: OTP_VERIFY_IDEMPOTENCY_SCOPE,
    purpose: identity.purpose,
    identifierColumn: identity.identifierColumn,
    identifier: identity.identifierValue,
    code: identity.code
  });
}

export type OtpVerifyRecord =
  | { state: "none" }
  /** A row exists but is older than the replay window: ignored (the request is an ordinary verify) and never overwritten. */
  | { state: "stale" }
  | { state: "fresh"; requestHash: string; accountId: string | null };

/**
 * Serialises every request that carries this key (per tenant): the second
 * concurrent one waits here until the first commits, then finds its record and
 * replays instead of racing it. Held to the end of the transaction.
 */
export async function lockOtpVerifyKey(
  tx: Bun.SQL,
  tenantId: string,
  keyHash: string
): Promise<void> {
  await acquireCustomerAuthLock(tx, tenantId, "otp-verify-key", keyHash);
}

export async function findOtpVerifyRecord(
  tx: Bun.SQL,
  tenantId: string,
  keyHash: string
): Promise<OtpVerifyRecord> {
  const rows = (await tx`
    SELECT request_hash, response_body,
           created_at > now() - make_interval(secs => ${OTP_VERIFY_IDEMPOTENCY_TTL_SECONDS}) AS fresh
    FROM awcms_idempotency_keys
    WHERE tenant_id = ${tenantId}
      AND request_scope = ${OTP_VERIFY_IDEMPOTENCY_SCOPE}
      AND actor_key = ${ANONYMOUS_IDEMPOTENCY_ACTOR}
      AND idempotency_key = ${keyHash}
  `) as {
    request_hash: string;
    response_body: { accountId?: unknown } | null;
    fresh: boolean;
  }[];

  const row = rows[0];
  if (!row) return { state: "none" };
  if (!row.fresh) return { state: "stale" };

  const accountId = row.response_body?.accountId;
  return {
    state: "fresh",
    requestHash: row.request_hash,
    accountId: typeof accountId === "string" ? accountId : null
  };
}

/** Records a successful verify. Callers hold {@link lockOtpVerifyKey}, so the shared helper's lost-race branch is unreachable in practice. */
export async function saveOtpVerifyRecord(
  tx: Bun.SQL,
  tenantId: string,
  keyHash: string,
  requestHash: string,
  accountId: string
): Promise<void> {
  await saveIdempotencyRecord(
    tx,
    tenantId,
    OTP_VERIFY_IDEMPOTENCY_SCOPE,
    keyHash,
    ANONYMOUS_IDEMPOTENCY_ACTOR,
    requestHash,
    200,
    { outcome: "session_issued", accountId }
  );
}
