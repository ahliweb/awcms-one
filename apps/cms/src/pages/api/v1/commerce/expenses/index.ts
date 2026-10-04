/**
 * `GET|POST /api/v1/commerce/expenses` — expenses (Issue #294, epic #281,
 * ADR-0031). `GET` (`commerce.expenses.read`) is the keyset history, newest
 * first, filterable by `status`, `categoryId`, `registerSessionId` and an
 * `occurredOn` range (`from`/`to`); `POST` (`commerce.expenses.create`,
 * requires `Idempotency-Key`) records a DRAFT - it touches no register and no
 * cash-up (posting is `.../{id}/post`). A draft that names a
 * `registerSessionId` (paid from that drawer) must be paid in cash and name an
 * OPEN session, and additionally needs the tenant's `register` feature. Both
 * methods are gated on the tenant's `expenses` feature.
 */
import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import {
  createExpenseDraft,
  listExpenses
} from "../../../../../modules/commerce/application/expense-directory";
import {
  expenseRefusalResponse,
  idempotencyErrorResponse,
  readValidatedBody,
  requireExpenseFeature,
  requireIdempotencyKey,
  requireRegisterFeatureForExpense
} from "../../../../../modules/commerce/application/expense-http";
import {
  parseExpenseListFilters,
  validateCreateExpenseInput,
  type CreateExpenseInput,
  type ExpenseListFilters
} from "../../../../../modules/commerce/domain/expense";
import { COMMERCE_EXPENSES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSES_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_EXPENSES_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedList = {
  cursor: KeysetCursor | null;
  filters: ExpenseListFilters;
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
    const filters = parseExpenseListFilters(url.searchParams);
    if (!filters.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Query failed validation.",
        {},
        filters.errors
      );
    }
    return { cursor, filters: filters.value };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    return ok(
      await listExpenses(tx, tenantId, prepared.cursor, prepared.filters)
    );
  }
});

export const POST = defineTenantRoute<CreateExpenseInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateCreateExpenseInput(body, key.key)
    );
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireExpenseFeature(tx, tenantId);
    if (gate) return gate;
    if (prepared.registerSessionId !== null) {
      const registerGate = await requireRegisterFeatureForExpense(tx, tenantId);
      if (registerGate) return registerGate;
    }
    try {
      const outcome = await createExpenseDraft(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      );
      const refusal = expenseRefusalResponse(outcome);
      if (refusal) return refusal;
      // `created` and `replayed` return the SAME 201 body (a replay is a
      // client retry, not a second expense).
      return created(
        (outcome as Extract<typeof outcome, { expense: unknown }>).expense
      );
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
