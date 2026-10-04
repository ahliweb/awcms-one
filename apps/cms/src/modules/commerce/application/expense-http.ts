/**
 * The one HTTP helper the expense routes add to `register-http.ts`'s shared
 * plumbing (Issue #294, ADR-0031): the `expenses` feature gate. The
 * `Idempotency-Key` header, body parsing and the idempotency-error mapping are
 * re-exported from `register-http.ts` rather than declared a second time - ten
 * routes must not drift into ten slightly different answers, and the expense
 * routes are the same kind of route.
 */
import { fail } from "../../_shared/api-response";
import { requireCommerceFeatureForOwnerRoute } from "./commerce-feature-gate";

export {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey
} from "./register-http";

/** `409 FEATURE_DISABLED` while the tenant's `expenses` feature is off, else `null`. */
export function requireExpenseFeature(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  return requireCommerceFeatureForOwnerRoute(tx, tenantId, "expenses");
}

type ExpenseRefusal = { kind: string; status?: string; reason?: string };

/**
 * The ONE mapping from an application-layer refusal to its HTTP answer, so the
 * eleven expense routes cannot drift apart. `null` when the outcome is not a
 * refusal (the caller handles its success kinds).
 */
export function expenseRefusalResponse(
  outcome: ExpenseRefusal
): Response | null {
  switch (outcome.kind) {
    case "not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Expense not found.");
    case "category_not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Expense category not found.");
    case "category_inactive":
      return fail(
        409,
        "EXPENSE_CATEGORY_INACTIVE",
        "The expense category is deactivated and accepts no new expense."
      );
    case "session_not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Register session not found.");
    case "session_not_open":
      return fail(
        409,
        "REGISTER_SESSION_NOT_OPEN",
        "The register session is not open, so it cannot take a drawer expense."
      );
    case "no_open_session":
      return fail(
        409,
        "REGISTER_SESSION_REQUIRED",
        "The expense was paid from a drawer and there is no open session on its register to take the compensating entry."
      );
    case "drawer_requires_cash":
      return fail(
        400,
        "VALIDATION_ERROR",
        "An expense paid from the drawer must be paid in cash.",
        {},
        [
          {
            field: "tenderType",
            message: "tenderType must be cash for a drawer expense."
          }
        ]
      );
    case "not_draft":
      return fail(
        409,
        "EXPENSE_NOT_DRAFT",
        "Only a draft expense can be changed.",
        {},
        {
          status: outcome.status
        }
      );
    case "forbidden":
      return fail(
        403,
        "NOT_EXPENSE_OWNER",
        "Only the person who created this draft, or a supervisor, may change it."
      );
    case "not_postable":
      return fail(
        409,
        "EXPENSE_NOT_POSTABLE",
        "Only a draft expense can be posted.",
        {},
        {
          status: outcome.status
        }
      );
    case "not_pending":
      return fail(
        409,
        "EXPENSE_NOT_PENDING",
        "The expense is not awaiting approval.",
        {},
        { status: outcome.status }
      );
    case "segregation_violation":
      return fail(
        403,
        "SEGREGATION_OF_DUTIES",
        "An expense cannot be approved by the person who created or submitted it.",
        {},
        { reason: outcome.reason }
      );
    case "not_reversible":
      return fail(
        409,
        "EXPENSE_NOT_REVERSIBLE",
        "Only a posted expense can be reversed.",
        {},
        { status: outcome.status }
      );
    case "not_attachable":
      return fail(
        409,
        "EXPENSE_NOT_ATTACHABLE",
        "A receipt can be attached to a draft, posted or reversed expense only.",
        {},
        { status: outcome.status }
      );
    case "receipt_already_attached":
      return fail(
        409,
        "EXPENSE_RECEIPT_ALREADY_ATTACHED",
        "A posted expense already has its receipt, which is never replaced."
      );
    case "media_not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Media object not found.");
    case "media_not_eligible":
      return fail(
        409,
        "EXPENSE_RECEIPT_NOT_ELIGIBLE",
        "A receipt must be a verified private media object that you uploaded."
      );
    case "media_already_used":
      return fail(
        409,
        "EXPENSE_RECEIPT_ALREADY_USED",
        "That media object is already in use as a receipt or a protected download."
      );
    default:
      return null;
  }
}

/** The drawer half: a drawer-paid expense also needs the `register` feature (the session it names is a register session). */
export function requireRegisterFeatureForExpense(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  return requireCommerceFeatureForOwnerRoute(tx, tenantId, "register");
}
