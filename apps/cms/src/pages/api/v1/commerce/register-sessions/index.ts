/**
 * `GET|POST /api/v1/commerce/register-sessions` — register sessions (Issue
 * #284, epic #281, ADR-0028). `GET` (`commerce.register_sessions.read`) is the
 * keyset history, newest first, filterable by `registerId`, `status` and
 * `cashier`; `POST` (`commerce.register_sessions.create`, requires
 * `Idempotency-Key`) OPENS a session on a register with a counted opening
 * float - one active (open/closing) session per register, so a second open is
 * `409 REGISTER_SESSION_ALREADY_OPEN` (two genuinely concurrent opens
 * serialise on the register row). Both are gated on the `register` feature.
 */
import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import {
  listRegisterSessions,
  openRegisterSession,
  type RegisterSessionListFilters
} from "../../../../../modules/commerce/application/register-session-directory";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey,
  requireRegisterFeature
} from "../../../../../modules/commerce/application/register-http";
import {
  isUuid,
  REGISTER_SESSION_STATUSES,
  validateOpenSessionInput,
  type OpenSessionInput,
  type RegisterSessionStatus
} from "../../../../../modules/commerce/domain/register";
import { COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedList = {
  cursor: KeysetCursor | null;
  filters: RegisterSessionListFilters;
};

export const GET = defineTenantRoute<PreparedList>({
  workClass: "interactive",
  prepare: ({ url }): PreparedList | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      const decoded = decodeKeysetCursor(cursorParam);
      if (!decoded)
        return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
      cursor = decoded;
    }
    const filters: RegisterSessionListFilters = {};
    const registerId = url.searchParams.get("registerId");
    if (registerId) {
      if (!isUuid(registerId)) {
        return fail(400, "VALIDATION_ERROR", "registerId must be a UUID.");
      }
      filters.registerId = registerId;
    }
    const status = url.searchParams.get("status");
    if (status) {
      if (!(REGISTER_SESSION_STATUSES as readonly string[]).includes(status)) {
        return fail(
          400,
          "VALIDATION_ERROR",
          `status must be one of: ${REGISTER_SESSION_STATUSES.join(", ")}.`
        );
      }
      filters.status = status as RegisterSessionStatus;
    }
    const cashier = url.searchParams.get("cashier");
    if (cashier) {
      if (!isUuid(cashier)) {
        return fail(400, "VALIDATION_ERROR", "cashier must be a UUID.");
      }
      filters.cashierTenantUserId = cashier;
    }
    return { cursor, filters };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireRegisterFeature(tx, tenantId);
    if (gate) return gate;
    return ok(
      await listRegisterSessions(
        tx,
        tenantId,
        prepared.cursor,
        prepared.filters
      )
    );
  }
});

export const POST = defineTenantRoute<OpenSessionInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateOpenSessionInput(body, key.key)
    );
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireRegisterFeature(tx, tenantId);
    if (gate) return gate;
    try {
      const outcome = await openRegisterSession(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      );
      switch (outcome.kind) {
        case "register_not_found":
          return fail(404, "RESOURCE_NOT_FOUND", "Register not found.");
        case "register_inactive":
          return fail(
            409,
            "REGISTER_INACTIVE",
            "The register is deactivated; reactivate it before opening a session."
          );
        case "already_open":
          return fail(
            409,
            "REGISTER_SESSION_ALREADY_OPEN",
            "The register already has an open session.",
            {},
            { activeSessionId: outcome.activeSessionId }
          );
        default:
          // `created` and `replayed` return the SAME 201 body (a replay is a
          // client retry, not a second session).
          return created(outcome.session);
      }
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
