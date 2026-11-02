/**
 * Storage side of the optional `Idempotency-Key` contract of the mutating
 * storefront endpoints (Issue #513, work unit C; the pure half is
 * `domain/storefront-idempotency.ts`). Like unit B's `otp/verify` it reuses the
 * platform's idempotency infrastructure (the `awcms_idempotency_keys` table:
 * FORCE RLS on `tenant_id`, retention purge by `data-lifecycle`, minimal grants;
 * `saveIdempotencyRecord`; the secret-keyed request-hash HMAC; the anonymous
 * actor namespace) - there is no second table and no migration.
 *
 * ## What a row holds
 *
 * | column            | value                                                                   |
 * | ----------------- | ----------------------------------------------------------------------- |
 * | `tenant_id`       | the tenant (RLS key)                                                    |
 * | `request_scope`   | one scope per route (`STOREFRONT_IDEMPOTENCY_SCOPES`)                   |
 * | `actor_key`       | `anonymous` (the shared namespace; see below)                           |
 * | `idempotency_key` | HMAC of (scope, signed-in account id or `-`, client key) - never the key |
 * | `request_hash`    | HMAC digest of (scope, account id, the request's identifying fields)    |
 * | `response_status` | the original status (`200`/`201`)                                       |
 * | `response_body`   | the route's own small "record" (see each route), never a token          |
 *
 * ## Who can read a record back
 *
 * The lookup address is the HMAC of the key, and for the bearer-secured account
 * routes the signed-in account id is part of that HMAC, so another account (or
 * an anonymous caller) presenting the same key string addresses a different row.
 * For the anonymous order routes the digest carries `(orderCode, phone)` (and
 * for reviews the product too): a request for another order or another phone
 * is `idempotency_conflict`, never the stored answer, and a request for the
 * same pair is one that already proved it holds the pair.
 *
 * ## What the record carries, per route
 *
 * - account routes (address, conversation, message): the route's own `201`
 *   body - the owner's own data, no token, no secret; it is replayed verbatim.
 * - review: `{ id }`.
 * - order cancel / payment confirmation: a marker only. A replay re-reads the
 *   CURRENT public order record (the same `(orderCode, phone)` check as the
 *   ordinary request), so the order's customer details and payment
 *   instructions are never copied into the table.
 */
import {
  ANONYMOUS_IDEMPOTENCY_ACTOR,
  computeRequestHash,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { keyedRequestHash } from "../../../lib/security/idempotency-hmac";
import {
  STOREFRONT_IDEMPOTENCY_KEY_PATTERN,
  STOREFRONT_IDEMPOTENCY_TTL_SECONDS,
  storefrontDigestsEqual,
  type StorefrontIdempotencyScope
} from "../domain/storefront-idempotency";
import { acquireCustomerAuthLock } from "./customer-account-store";

const AUDIT_MODULE_KEY = "commerce";

/** The value stored in `awcms_idempotency_keys.idempotency_key`: an HMAC, never the client key. */
export function hashStorefrontIdempotencyKey(
  scope: StorefrontIdempotencyScope,
  accountId: string | null,
  key: string
): string {
  return keyedRequestHash(
    `commerce.storefront.key\n${scope}\n${accountId ?? "-"}\n${key}`
  );
}

/** HMAC digest of the request: everything that identifies the target and the content. */
export function computeStorefrontRequestDigest(
  scope: StorefrontIdempotencyScope,
  accountId: string | null,
  request: Record<string, unknown>
): string {
  return computeRequestHash({ scope, accountId, request });
}

export type StorefrontIdempotencySpec = {
  scope: StorefrontIdempotencyScope;
  /** The validated header (`parseStorefrontIdempotencyKey`); `null` = no idempotency, the request simply runs. */
  key: string | null;
  /** The signed-in account for a bearer route; `null` on an anonymous route. */
  accountId: string | null;
  /** Everything that identifies the target and the content (order code, phone, conversation id, body...). */
  request: Record<string, unknown>;
  correlationId?: string;
};

/** What a keyed run produced. `record: null` means "not a success": nothing is stored, so the same key can be retried. */
export type StorefrontExecution<TOutcome, TRecord> = {
  outcome: TOutcome;
  record: TRecord | null;
  /** Status stored with the record (default 201). */
  status?: number;
};

export type StorefrontIdempotentResult<TOutcome, TRecord> =
  /** The key was already used (inside the replay window) by a different request. */
  | { kind: "conflict" }
  /** The same request already succeeded: the stored record, nothing was executed. */
  | { kind: "replayed"; record: TRecord }
  | { kind: "executed"; outcome: TOutcome };

type StoredRow = {
  request_hash: string;
  response_body: unknown;
  fresh: boolean;
};

async function findRecord(
  tx: Bun.SQL,
  tenantId: string,
  scope: StorefrontIdempotencyScope,
  keyHash: string
): Promise<StoredRow | null> {
  const rows = (await tx`
    SELECT request_hash, response_body,
           created_at > now() - make_interval(secs => ${STOREFRONT_IDEMPOTENCY_TTL_SECONDS}) AS fresh
    FROM awcms_idempotency_keys
    WHERE tenant_id = ${tenantId}
      AND request_scope = ${scope}
      AND actor_key = ${ANONYMOUS_IDEMPOTENCY_ACTOR}
      AND idempotency_key = ${keyHash}
  `) as StoredRow[];
  return rows[0] ?? null;
}

/**
 * Runs `execute` once per `(tenant, route, key)`.
 *
 * Without a key it just runs. With one, requests carrying the same key are
 * serialised by an advisory lock held to the end of the transaction (the second
 * concurrent request waits, then finds the first one's committed record and
 * replays instead of racing it), and:
 *
 * - no record: run `execute`; when it reports a `record` (a success), store it;
 * - a fresh record with the SAME digest: `replayed` (and one low-noise audit
 *   row, never the key);
 * - a fresh record with a DIFFERENT digest: `conflict`;
 * - a stale record (older than the replay window): ignored - an ordinary run,
 *   nothing written (a row is never overwritten).
 *
 * `execute` runs inside the caller's transaction; if it throws, the whole
 * transaction (the lock and any partial work) rolls back and nothing is stored.
 */
export async function runStorefrontIdempotent<TOutcome, TRecord>(
  tx: Bun.SQL,
  tenantId: string,
  spec: StorefrontIdempotencySpec,
  execute: () => Promise<StorefrontExecution<TOutcome, TRecord>>
): Promise<StorefrontIdempotentResult<TOutcome, TRecord>> {
  const { key } = spec;
  if (key === null) {
    return { kind: "executed", outcome: (await execute()).outcome };
  }
  if (!STOREFRONT_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new TypeError("idempotencyKey must be a validated key.");
  }

  const keyHash = hashStorefrontIdempotencyKey(spec.scope, spec.accountId, key);
  const digest = computeStorefrontRequestDigest(
    spec.scope,
    spec.accountId,
    spec.request
  );

  await acquireCustomerAuthLock(
    tx,
    tenantId,
    "storefront-idempotency",
    `${spec.scope}:${keyHash}`
  );
  const existing = await findRecord(tx, tenantId, spec.scope, keyHash);

  if (existing && existing.fresh) {
    if (!storefrontDigestsEqual(existing.request_hash, digest)) {
      return { kind: "conflict" };
    }

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "commerce.storefront.idempotency_replayed",
      resourceType: "storefront_request",
      message: "A storefront request was replayed for an idempotency key.",
      attributes: { scope: spec.scope },
      correlationId: spec.correlationId
    });
    return {
      kind: "replayed",
      record: existing.response_body as TRecord
    };
  }

  const execution = await execute();

  if (execution.record !== null && existing === null) {
    await saveIdempotencyRecord(
      tx,
      tenantId,
      spec.scope,
      keyHash,
      ANONYMOUS_IDEMPOTENCY_ACTOR,
      digest,
      execution.status ?? 201,
      execution.record
    );
  }

  return { kind: "executed", outcome: execution.outcome };
}
