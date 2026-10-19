/**
 * The booking-commerce adapter's closed vocabularies and request validation
 * (Issue #378, ADR-0045). Pure - no database, no clock, no I/O.
 *
 * The adapter is a thin layer in `commerce` that sells a Booking reservation as
 * an ordinary commerce order. It reaches Booking through `BookingPort` only (and
 * reads nothing of Booking's tables beyond the one narrow offering lookup in
 * `application/booking-offering-links.ts`); Booking never imports `commerce`.
 * This file holds what the tables of `sql/1035`-`sql/1038` and the routes of
 * this issue share, so the HTTP layer, the directory and the tests cannot drift
 * into different spellings of the same code.
 *
 * ## Error codes (ADR-0045 D14, all `409` unless noted)
 *
 * `OFFERING_NOT_FOUND` (404), `OFFERING_ALREADY_LINKED`, `PRODUCT_ALREADY_LINKED`,
 * `PRODUCT_NOT_SERVICE`, `QUANTITY_BASIS_MISMATCH`, `OFFERING_NOT_LINKABLE`
 * (G9: an `immediate` offering confirms without payment, so it cannot be sold),
 * `BOOKING_SERVICE_ACTOR_NOT_CONFIGURED` (G3), `ALLOW_DP_MANAGED_BY_POLICY` (D5).
 */
import {
  isRecord,
  positiveMoney,
  type ValidationError
} from "./payment-allocation";
import { isUuid } from "./register";
import { MAX_RESOURCES_PER_OFFERING } from "./booking-storefront-reads";

export type { ValidationError };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export const BOOKING_QUANTITY_BASES = ["nights", "booking"] as const;
export type BookingQuantityBasis = (typeof BOOKING_QUANTITY_BASES)[number];

export const BOOKING_OFFERING_LINK_STATUSES = ["active", "unlinked"] as const;
export type BookingOfferingLinkStatus =
  (typeof BOOKING_OFFERING_LINK_STATUSES)[number];

export const BOOKING_RESERVATION_LINK_STATUSES = [
  "active",
  "superseded",
  "released"
] as const;
export type BookingReservationLinkStatus =
  (typeof BOOKING_RESERVATION_LINK_STATUSES)[number];

/**
 * The attention-flag codes (ADR-0045 G7). The superset the whole adapter epic
 * needs, fixed now so no later issue widens the table's CHECK:
 * `deposit_after_expiry` (a deposit settled after the hold lapsed),
 * `confirm_failed` (settlement reached the threshold but the confirm was
 * refused), `rescheduled_externally` and `cancelled_externally_paid` (the
 * reservation was moved or cancelled outside the adapter while money is held).
 */
export const BOOKING_ATTENTION_REASONS = [
  "deposit_after_expiry",
  "confirm_failed",
  "rescheduled_externally",
  "cancelled_externally_paid"
] as const;
export type BookingAttentionReason = (typeof BOOKING_ATTENTION_REASONS)[number];

export const DEPOSIT_POLICY_KINDS = ["percent", "fixed"] as const;
export type DepositPolicyKind = (typeof DEPOSIT_POLICY_KINDS)[number];

export const CANCELLATION_POLICY_STATUSES = [
  "draft",
  "active",
  "retired"
] as const;
export const CANCELLATION_REFUND_BASES = ["whole_stay", "per_night"] as const;
export const NO_SHOW_RETENTIONS = [
  "retain_deposit",
  "retain_all",
  "refund_per_windows"
] as const;
export const REFUND_POLICY_SOURCES = [
  "product",
  "tenant_default",
  "none"
] as const;
export const REFUND_DECISION_TRIGGER_KINDS = [
  "customer_cancel",
  "staff_cancel",
  "no_show"
] as const;
export const REFUND_DECISION_ACTOR_KINDS = [
  "customer",
  "staff",
  "system"
] as const;

/** The Booking offering granularity -> the quantity basis a link to it must carry (Q1). */
export function quantityBasisForGranularity(
  granularity: string
): BookingQuantityBasis | null {
  if (granularity === "stay") return "nights";
  if (granularity === "time") return "booking";
  return null;
}

/**
 * Whether a Booking offering may be sold through the adapter (ADR-0045 G9).
 * An `immediate` offering is confirmed the moment it is held - there is no
 * window in which a payment could decide it - and an inactive offering takes no
 * new bookings. Both are refused at link time with `OFFERING_NOT_LINKABLE`.
 */
export function isOfferingLinkable(offering: {
  confirmationMode: string;
  status: string;
}): boolean {
  return (
    offering.confirmationMode === "hold_then_confirm" &&
    offering.status === "active"
  );
}

// ---------------------------------------------------------------------------
// Offering links
// ---------------------------------------------------------------------------

export type CreateOfferingLinkInput = {
  offeringId: string;
  productId: string;
  quantityBasis: BookingQuantityBasis;
  /**
   * Issue #437 - the Booking resource(s) this link sells, in the order the
   * storefront lists them. EMPTY keeps the #386 fallback (every active resource
   * of the offering's booking mode); at most {@link MAX_RESOURCES_PER_OFFERING}.
   */
  resourceIds: string[];
};

export type UpdateOfferingLinkInput = { status: "unlinked" };

/** Names that must never arrive in a body (no client-supplied money, finding X7 and rule 1 of the contract). */
const FORBIDDEN_KEYS = [
  "amount",
  "price",
  "expectedAmount",
  "computedRefund",
  "customerId",
  "customer"
] as const;

function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  errors: ValidationError[]
): void {
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    errors.push({
      field: key,
      message: (FORBIDDEN_KEYS as readonly string[]).includes(key)
        ? `${key} is not accepted: the server derives it.`
        : `${key} is not a known field.`
    });
  }
}

/**
 * `resourceIds` is optional: absent, `null` and `[]` all mean "no binding" (the
 * #386 fallback). Present, it is a list of distinct uuids, at most
 * {@link MAX_RESOURCES_PER_OFFERING}. These are CLIENT ids: the directory still
 * proves each is the tenant's, active and of the offering's booking mode.
 */
function parseResourceIds(value: unknown, errors: ValidationError[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push({
      field: "resourceIds",
      message: "resourceIds must be an array of uuids."
    });
    return [];
  }
  if (value.length > MAX_RESOURCES_PER_OFFERING) {
    errors.push({
      field: "resourceIds",
      message: `resourceIds takes at most ${MAX_RESOURCES_PER_OFFERING} resources.`
    });
    return [];
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isUuid(entry)) {
      errors.push({
        field: `resourceIds[${index}]`,
        message: "Each resource id must be a uuid."
      });
    } else if (seen.has(entry)) {
      errors.push({
        field: `resourceIds[${index}]`,
        message: "A resource can be listed once."
      });
    } else {
      seen.add(entry);
    }
  }
  return errors.length > 0 ? [] : [...seen];
}

export function validateCreateOfferingLinkInput(
  body: unknown
): ValidationResult<CreateOfferingLinkInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  rejectUnknownKeys(
    record,
    ["offeringId", "productId", "quantityBasis", "resourceIds"],
    errors
  );

  if (!isUuid(record.offeringId)) {
    errors.push({ field: "offeringId", message: "offeringId must be a uuid." });
  }
  if (!isUuid(record.productId)) {
    errors.push({ field: "productId", message: "productId must be a uuid." });
  }
  if (
    typeof record.quantityBasis !== "string" ||
    !(BOOKING_QUANTITY_BASES as readonly string[]).includes(
      record.quantityBasis
    )
  ) {
    errors.push({
      field: "quantityBasis",
      message: "quantityBasis must be nights or booking."
    });
  }
  const resourceIds = parseResourceIds(record.resourceIds, errors);
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      offeringId: record.offeringId as string,
      productId: record.productId as string,
      quantityBasis: record.quantityBasis as BookingQuantityBasis,
      resourceIds
    }
  };
}

export function validateUpdateOfferingLinkInput(
  body: unknown
): ValidationResult<UpdateOfferingLinkInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  rejectUnknownKeys(record, ["status"], errors);
  if (record.status !== "unlinked") {
    errors.push({ field: "status", message: "status must be unlinked." });
  }
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { status: "unlinked" } };
}

// ---------------------------------------------------------------------------
// Product deposit policy
// ---------------------------------------------------------------------------

/**
 * `full` is "no deposit": it retires the active policy (removing the row is an
 * update to full payment, access matrix section 3). A percent applies to the
 * line's taxed total; a fixed amount is PER UNIT of quantity (per night for a
 * nightly product) - ADR-0041 D4.
 */
export type SetDepositPolicyInput =
  | { kind: "full" }
  | { kind: "percent"; percent: string }
  | { kind: "fixed"; fixedAmount: string };

const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;

export function validateSetDepositPolicyInput(
  body: unknown
): ValidationResult<SetDepositPolicyInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const kind = record.kind;
  if (kind !== "full" && kind !== "percent" && kind !== "fixed") {
    return {
      valid: false,
      errors: [
        { field: "kind", message: "kind must be full, percent or fixed." }
      ]
    };
  }
  rejectUnknownKeys(
    record,
    kind === "percent"
      ? ["kind", "percent"]
      : kind === "fixed"
        ? ["kind", "fixedAmount"]
        : ["kind"],
    errors
  );

  if (kind === "percent") {
    const raw = record.percent;
    const text =
      typeof raw === "number" && Number.isFinite(raw)
        ? raw.toFixed(2)
        : typeof raw === "string"
          ? raw.trim()
          : "";
    if (!PERCENT_PATTERN.test(text)) {
      errors.push({
        field: "percent",
        message: "percent must be a decimal with at most 2 places."
      });
    } else {
      const numeric = Number.parseFloat(text);
      if (!(numeric > 0 && numeric <= 100)) {
        errors.push({
          field: "percent",
          message: "percent must be greater than 0 and at most 100."
        });
      }
    }
    if (errors.length > 0) return { valid: false, errors };
    const [whole, fraction = ""] = text.split(".");
    return {
      valid: true,
      value: {
        kind: "percent",
        percent: `${Number.parseInt(whole!, 10)}.${(fraction + "00").slice(0, 2)}`
      }
    };
  }

  if (kind === "fixed") {
    const fixedAmount = positiveMoney(
      record.fixedAmount,
      "fixedAmount",
      errors
    );
    if (errors.length > 0) return { valid: false, errors };
    return { valid: true, value: { kind: "fixed", fixedAmount } };
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { kind: "full" } };
}
