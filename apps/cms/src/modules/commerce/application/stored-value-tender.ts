/**
 * Stored value as a payment TENDER (Issue #288, ADR-0030): the three steps a
 * request that carries a gift-card / store-credit code goes through before the
 * payment ledger writes anything.
 *
 *   1. {@link resolveStoredValueAccounts} — plaintext code -> account id, by
 *      the tenant-scoped hash (the code is never stored, so there is nothing
 *      else to look it up by). Throttled per tenant user, and every failure
 *      (a malformed-but-well-checksummed code, an unknown one, one of the other
 *      kind, one of another tenant) is the SAME {@link StoredValueNotFoundError}
 *      — never an oracle for "this code exists elsewhere".
 *   2. {@link preflightStoredValueLegs} — lock every account involved (sorted
 *      by id, so two sales that share cards cannot deadlock) and refuse, with
 *      a typed error, anything that cannot be redeemed in full: disabled,
 *      expired, lapsed, too poor. Run BEFORE the order row exists, so a refusal
 *      leaves nothing behind (a returned response commits; see
 *      `stored-value-ledger.ts`'s header) and the locks it takes are held to
 *      the end of the transaction — nothing can spend the card between this
 *      check and the redemption.
 *   3. `payment-allocation-directory.ts` writes the allocation row and the
 *      mirror ledger entry (`redeemForAllocation`).
 *
 * {@link redactTendersForHash} exists for the idempotency request hash: a
 * hash of the request body must never be a hash OF the code.
 */
import { checkSharedRateLimit } from "../../../lib/security/rate-limit";
import {
  hashStoredValueCode,
  isStoredValueTender,
  type StoredValueKind
} from "../domain/stored-value";
import type { TenderInput } from "../domain/payment-allocation";
import {
  checkStoredValueRedeemable,
  type StoredValueRedeemRefusal
} from "./stored-value-ledger";

/** Lookups per tenant user per minute — a cashier ringing up cards never nears it; a probing script hits it at once. */
export const STORED_VALUE_LOOKUPS_PER_MINUTE = 30;
const LOOKUP_WINDOW_MS = 60_000;

export class StoredValueNotFoundError extends Error {
  constructor() {
    super("The gift card / store credit code was not recognised.");
    this.name = "StoredValueNotFoundError";
  }
}

export class StoredValueUnavailableError extends Error {
  public readonly reason: "UNAVAILABLE" | "EXPIRED";
  constructor(reason: "UNAVAILABLE" | "EXPIRED") {
    super(
      reason === "EXPIRED"
        ? "The gift card / store credit has expired."
        : "The gift card / store credit is not available for redemption."
    );
    this.name = "StoredValueUnavailableError";
    this.reason = reason;
  }
}

export class StoredValueInsufficientError extends Error {
  public readonly available: string;
  public readonly requested: string;
  constructor(available: string, requested: string) {
    super("The gift card / store credit balance does not cover the amount.");
    this.name = "StoredValueInsufficientError";
    this.available = available;
    this.requested = requested;
  }
}

export class StoredValueLookupThrottledError extends Error {
  public readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("Too many gift card / store credit lookups; try again shortly.");
    this.name = "StoredValueLookupThrottledError";
    this.retryAfterSec = retryAfterSec;
  }
}

export type TenderCodeRequest = { tenderType: StoredValueKind; code: string };

/**
 * Resolves each normalised code to its account id, in order.
 *
 * @throws {StoredValueLookupThrottledError} the actor exceeded the lookup budget.
 * @throws {StoredValueNotFoundError} any code that does not resolve to an
 *   account of this tenant and of the tender's kind.
 */
export async function resolveStoredValueAccounts(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  requests: readonly TenderCodeRequest[]
): Promise<string[]> {
  const ids: string[] = [];
  for (const request of requests) {
    const limit = await checkSharedRateLimit(
      `stored-value-lookup:${tenantId}:${actorTenantUserId}`,
      {
        maxAttempts: STORED_VALUE_LOOKUPS_PER_MINUTE,
        windowMs: LOOKUP_WINDOW_MS
      }
    );
    if (!limit.allowed) {
      throw new StoredValueLookupThrottledError(limit.retryAfterSec);
    }
    const rows = (await tx`
      SELECT id, kind
      FROM awcms_commerce_stored_value_accounts
      WHERE tenant_id = ${tenantId}
        AND code_hash = ${hashStoredValueCode(tenantId, request.code)}
        AND deleted_at IS NULL
    `) as { id: string; kind: string }[];
    const row = rows[0];
    if (!row || row.kind !== request.tenderType) {
      throw new StoredValueNotFoundError();
    }
    ids.push(row.id);
  }
  return ids;
}

export type PreflightLeg = {
  accountId: string;
  tenderType: StoredValueKind;
  /** `numeric(14,2)` applied amount. */
  amount: string;
};

/**
 * Locks every account (sorted by id) and refuses, before anything is written,
 * a leg that cannot be redeemed in full. The locks are held to the end of the
 * caller's transaction.
 *
 * @throws {StoredValueNotFoundError | StoredValueUnavailableError | StoredValueInsufficientError}
 */
export async function preflightStoredValueLegs(
  tx: Bun.SQL,
  tenantId: string,
  legs: readonly PreflightLeg[]
): Promise<void> {
  const ordered = [...legs].sort((a, b) =>
    a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0
  );
  for (const leg of ordered) {
    const check = await checkStoredValueRedeemable(tx, tenantId, leg);
    if (!check.ok)
      throw refusalToError(check.refusal, check.available, leg.amount);
  }
}

/** The typed error for a refusal returned by `recordPaymentAllocation` / the preflight. */
export function refusalToError(
  refusal: StoredValueRedeemRefusal,
  available: string,
  requested: string
): Error {
  switch (refusal) {
    case "NOT_FOUND":
    case "KIND_MISMATCH":
      return new StoredValueNotFoundError();
    case "EXPIRED":
      return new StoredValueUnavailableError("EXPIRED");
    case "UNAVAILABLE":
      return new StoredValueUnavailableError("UNAVAILABLE");
    case "INSUFFICIENT":
      return new StoredValueInsufficientError(available, requested);
  }
}

/**
 * The tenders as they may enter an idempotency request hash: the plaintext
 * code replaced by its tenant-scoped hash (so the hash still distinguishes two
 * different cards, and the idempotency table never holds anything derived
 * from the plaintext by a weaker function than the one that protects it).
 * Tenders without a code pass through unchanged, so a pre-existing payload
 * hashes exactly as before.
 */
export function redactTendersForHash(
  tenantId: string,
  tenders: readonly TenderInput[] | null
): unknown[] | undefined {
  if (tenders === null) return undefined;
  return tenders.map((tender) => {
    if (!isStoredValueTender(tender.tenderType) || !tender.storedValueCode) {
      const { storedValueCode: _omit, ...rest } = tender;
      void _omit;
      return rest;
    }
    const { storedValueCode, ...rest } = tender;
    return {
      ...rest,
      storedValueCodeHash: hashStoredValueCode(tenantId, storedValueCode)
    };
  });
}
