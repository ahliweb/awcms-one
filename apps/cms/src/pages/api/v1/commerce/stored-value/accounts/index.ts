/**
 * `GET|POST /api/v1/commerce/stored-value/accounts` — gift-card / store-credit
 * accounts (Issue #288, ADR-0030). Both gated on the tenant's `storedValue`
 * feature (`409 FEATURE_DISABLED` while it is off).
 *
 * `GET` (`commerce.stored_value.read`) lists accounts newest first, keyset
 * paginated, filterable by `kind`, `status`, `customerId` and `last4` (the last
 * four characters of a code - how an operator finds a card). Every code is
 * MASKED (`•••••••-•••••••-•••ABCD`): the plaintext is never stored.
 *
 * `POST` (`commerce.stored_value.create`, requires `Idempotency-Key`) ISSUES an
 * account: generates a CSPRNG code (100 bits + a check character), stores only
 * its tenant-scoped hash and last four, appends the `issue` ledger entry, and
 * returns the plaintext `code` ONCE, in this response. A replay answers
 * `codeRevealed: false`; a lost code is remedied by disabling the account and
 * issuing a new one. A program that is not enabled refuses (`409
 * STORED_VALUE_PROGRAM_DISABLED`).
 */
import {
  created,
  fail,
  ok
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../../modules/_shared/keyset-pagination";
import {
  issueStoredValueAccount,
  listStoredValueAccounts,
  type StoredValueAccountFilters
} from "../../../../../../modules/commerce/application/stored-value-directory";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey
} from "../../../../../../modules/commerce/application/register-http";
import { requireStoredValueFeature } from "../../../../../../modules/commerce/application/stored-value-http";
import { COMMERCE_STORED_VALUE_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import {
  isStoredValueKind,
  isUuid,
  STORED_VALUE_ACCOUNT_STATUSES,
  validateIssueAccountInput,
  type IssueAccountInput,
  type StoredValueAccountStatus
} from "../../../../../../modules/commerce/domain/stored-value";

type PreparedList = {
  cursor: KeysetCursor | null;
  filters: StoredValueAccountFilters;
};

export const GET = defineTenantRoute<PreparedList>({
  workClass: "interactive",
  prepare: ({ url }): PreparedList | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      cursor = decodeKeysetCursor(cursorParam);
      if (!cursor) return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
    }
    const filters: StoredValueAccountFilters = {};
    const kind = url.searchParams.get("kind");
    if (kind) {
      if (!isStoredValueKind(kind)) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "kind must be gift_card or store_credit."
        );
      }
      filters.kind = kind;
    }
    const status = url.searchParams.get("status");
    if (status) {
      if (
        !(STORED_VALUE_ACCOUNT_STATUSES as readonly string[]).includes(status)
      ) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "status must be active, disabled or expired."
        );
      }
      filters.status = status as StoredValueAccountStatus;
    }
    const customerId = url.searchParams.get("customerId");
    if (customerId) {
      if (!isUuid(customerId)) {
        return fail(400, "VALIDATION_ERROR", "customerId must be a UUID.");
      }
      filters.customerId = customerId;
    }
    const last4 = url.searchParams.get("last4");
    if (last4) {
      if (!/^[A-Za-z0-9]{4}$/.test(last4)) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "last4 must be exactly four characters."
        );
      }
      filters.last4 = last4;
    }
    return { cursor, filters };
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
    action: "read"
  },
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    return ok(
      await listStoredValueAccounts(
        tx,
        tenantId,
        prepared.cursor,
        prepared.filters
      )
    );
  }
});

export const POST = defineTenantRoute<IssueAccountInput>({
  workClass: "interactive",
  prepare: async ({ request, now }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateIssueAccountInput(body, key.key, now)
    );
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
    action: "create"
  },
  handler: async ({ tx, tenantId, auth, prepared, locals, now }) => {
    const gate = await requireStoredValueFeature(tx, tenantId);
    if (gate) return gate;
    try {
      const outcome = await issueStoredValueAccount(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        now,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "program_unavailable":
          return fail(
            409,
            "STORED_VALUE_PROGRAM_DISABLED",
            "The program for this kind of stored value is not enabled."
          );
        case "customer_not_found":
          return fail(404, "RESOURCE_NOT_FOUND", "Customer not found.");
        case "ceiling":
          return fail(
            409,
            "STORED_VALUE_BALANCE_CEILING",
            "The amount exceeds the program's balance ceiling.",
            {},
            { ceiling: outcome.ceiling }
          );
        default:
          return created(outcome.body);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
