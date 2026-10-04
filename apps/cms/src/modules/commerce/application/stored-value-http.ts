/**
 * The HTTP plumbing the stored-value routes and the two payment routes that can
 * carry a stored-value tender (`POST .../pos/orders`, `POST .../orders/{id}/
 * payments`) share (Issue #288, ADR-0030): the feature gate and the ONE
 * mapping of the typed tender errors to a response, declared once so the three
 * callers cannot drift into three slightly different answers.
 *
 * Every refusal here is decided BEFORE anything is written (see
 * `stored-value-ledger.ts`'s header), so returning a response — which commits
 * the transaction — leaves no partial state behind.
 */
import { created, fail } from "../../_shared/api-response";
import type { AccountMutationOutcome } from "./stored-value-directory";
import type { StoredValueEntryRefusal } from "./stored-value-ledger";
import { requireCommerceFeatureForOwnerRoute } from "./commerce-feature-gate";
import {
  StoredValueInsufficientError,
  StoredValueLookupThrottledError,
  StoredValueNotFoundError,
  StoredValueUnavailableError
} from "./stored-value-tender";

/** `409 FEATURE_DISABLED` while the tenant's `storedValue` feature is off (it defaults OFF), else `null`. */
export function requireStoredValueFeature(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  return requireCommerceFeatureForOwnerRoute(tx, tenantId, "storedValue");
}

/** The response for a stored-value tender refusal; `null` for any other error (the caller rethrows). */
export function storedValueTenderErrorResponse(
  error: unknown
): Response | null {
  if (error instanceof StoredValueNotFoundError) {
    return fail(
      404,
      "STORED_VALUE_NOT_FOUND",
      "The gift card / store credit code was not recognised."
    );
  }
  if (error instanceof StoredValueUnavailableError) {
    return fail(
      409,
      "STORED_VALUE_UNAVAILABLE",
      error.message,
      {},
      { reason: error.reason }
    );
  }
  if (error instanceof StoredValueInsufficientError) {
    return fail(
      409,
      "STORED_VALUE_INSUFFICIENT",
      "The gift card / store credit balance does not cover the amount.",
      {},
      { available: error.available, requested: error.requested }
    );
  }
  if (error instanceof StoredValueLookupThrottledError) {
    return fail(
      429,
      "STORED_VALUE_LOOKUP_THROTTLED",
      error.message,
      {},
      { retryAfterSec: error.retryAfterSec },
      { "Retry-After": String(error.retryAfterSec) }
    );
  }
  return null;
}

/** The response for a refused ledger entry (load / adjust / disable / enable). */
export function refusedEntryResponse(outcome: {
  refusal: StoredValueEntryRefusal;
  available: string;
  ceiling: string | null;
}): Response {
  switch (outcome.refusal) {
    case "ACCOUNT_EXPIRED":
    case "ACCOUNT_LAPSED":
      return fail(
        409,
        "STORED_VALUE_ACCOUNT_EXPIRED",
        "The account has expired; no further entry can be recorded on it."
      );
    case "ACCOUNT_UNAVAILABLE":
      return fail(
        409,
        "STORED_VALUE_ACCOUNT_UNAVAILABLE",
        "The account is disabled and cannot take this entry."
      );
    case "INSUFFICIENT":
      return fail(
        409,
        "STORED_VALUE_INSUFFICIENT",
        "The adjustment would take the balance below zero.",
        {},
        { available: outcome.available }
      );
    case "BALANCE_CEILING":
      return fail(
        409,
        "STORED_VALUE_BALANCE_CEILING",
        "The balance would exceed the program's ceiling.",
        {},
        { ceiling: outcome.ceiling }
      );
    case "NOT_ACTIVE":
      return fail(
        409,
        "STORED_VALUE_STATUS_UNCHANGED",
        "The account is not active."
      );
    case "NOT_DISABLED":
      return fail(
        409,
        "STORED_VALUE_STATUS_UNCHANGED",
        "The account is not disabled."
      );
    case "NOT_LAPSED":
      return fail(
        409,
        "STORED_VALUE_NOT_LAPSED",
        "The account has not reached its expiry."
      );
  }
}

/** One mapping of an {@link AccountMutationOutcome} for load / adjust / status. */
export function accountMutationResponse(
  outcome: AccountMutationOutcome
): Response {
  switch (outcome.kind) {
    case "not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Account not found.");
    case "program_disabled":
      return fail(
        409,
        "STORED_VALUE_PROGRAM_DISABLED",
        "The program for this kind of stored value is disabled; value cannot be added."
      );
    case "refused":
      return refusedEntryResponse(outcome);
    default:
      return created(outcome.body);
  }
}
