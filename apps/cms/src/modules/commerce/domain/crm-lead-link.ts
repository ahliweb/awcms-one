/**
 * The CRM lead link, pure rules (Issue #463, ADR-0056): which commerce facts may
 * confirm that a `crm_leads` prospect became a commerce customer, the opaque
 * references sent to `CrmLeadPort`, the link's state machine and the request
 * validators. No I/O and no imports, so a unit test pins every rule without a
 * database.
 *
 * ## What counts as verified
 *
 * A conversion is confirmed ONLY from a commerce fact read from the database by
 * the server, never from a field the caller states and never from a message
 * receipt:
 *
 *   - `customer_registration`: the shopper completed the e-mail OTP
 *     registration, so the customer's account is live and has `email_verified_at`
 *     (ADR-0016). A guest row created by a checkout, or a customer that only
 *     shares a phone number or an e-mail with the lead, is NOT a registration.
 *   - `paid_order`: an order of THAT customer, paid in full (`payment_status =
 *     'paid'`) and past payment (`paid`, `processing`, `shipped`, `completed`),
 *     not cancelled and not soft-deleted.
 *
 * Which lead belongs to which customer is an explicit, authorised, audited
 * decision of a person holding both permissions. There is no matching on phone,
 * e-mail or social handle anywhere in this module.
 */

export const CRM_LEAD_LINK_EVIDENCE_KINDS = [
  "customer_registration",
  "paid_order"
] as const;
export type CrmLeadLinkEvidenceKind =
  (typeof CRM_LEAD_LINK_EVIDENCE_KINDS)[number];

export const CRM_LEAD_LINK_STATES = [
  "linked",
  "reversal_pending",
  "reversed"
] as const;
export type CrmLeadLinkState = (typeof CRM_LEAD_LINK_STATES)[number];

export const CRM_LEAD_LINK_REVERSAL_CAUSES = [
  "order_cancelled",
  "order_refunded",
  "manual"
] as const;
export type CrmLeadLinkReversalCause =
  (typeof CRM_LEAD_LINK_REVERSAL_CAUSES)[number];

/** Hard cap on one list answer. */
export const CRM_LEAD_LINK_LIST_LIMIT = 100;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCrmLeadLinkUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Opaque references (the alphabet `CrmLeadPort` accepts: A-Za-z0-9._:-, <= 128)
// ---------------------------------------------------------------------------

/** What `crm_leads` stores as `external_customer_ref`: an opaque id, never a name or contact. */
export function customerRef(customerId: string): string {
  return `commerce:customer:${customerId.toLowerCase()}`;
}

/** The replay key of a registration-based conversion: one registration converts at most one lead. */
export function registrationEvidenceRef(customerId: string): string {
  return `commerce:registration:${customerId.toLowerCase()}`;
}

/** The replay key of an order-based conversion: one paid order converts at most one lead. */
export function orderEvidenceRef(orderId: string): string {
  return `commerce:order:${orderId.toLowerCase()}`;
}

/** The replay key of a reversal: one per link. */
export function reversalEvidenceRef(linkId: string): string {
  return `commerce:reversal:${linkId.toLowerCase()}`;
}

export function evidenceRefFor(
  kind: CrmLeadLinkEvidenceKind,
  customerId: string,
  orderId: string | null
): string | null {
  if (kind === "customer_registration") {
    return registrationEvidenceRef(customerId);
  }
  return orderId ? orderEvidenceRef(orderId) : null;
}

// ---------------------------------------------------------------------------
// Verified facts
// ---------------------------------------------------------------------------

/** Order statuses that are past payment and not cancelled (same set the commission attributor uses). */
const PAID_ORDER_STATUSES: readonly string[] = [
  "paid",
  "processing",
  "shipped",
  "completed"
];

export type OrderEvidenceFacts = {
  customerId: string;
  status: string;
  paymentStatus: string;
  deleted: boolean;
};

export type EvidenceVerdict =
  { verified: true } | { verified: false; reason: string };

export function verifyPaidOrderEvidence(
  order: OrderEvidenceFacts,
  customerId: string
): EvidenceVerdict {
  if (order.deleted) return { verified: false, reason: "order_deleted" };
  if (order.customerId !== customerId) {
    // The caller names the customer; the order must be that customer's own.
    return { verified: false, reason: "order_not_of_customer" };
  }
  if (order.paymentStatus !== "paid") {
    return { verified: false, reason: "order_not_paid" };
  }
  if (!PAID_ORDER_STATUSES.includes(order.status)) {
    return { verified: false, reason: "order_not_active" };
  }
  return { verified: true };
}

export type AccountEvidenceFacts = {
  status: string;
  emailVerified: boolean;
  deleted: boolean;
  customerErased: boolean;
};

export function verifyRegistrationEvidence(
  account: AccountEvidenceFacts | null
): EvidenceVerdict {
  if (!account) return { verified: false, reason: "no_account" };
  if (account.customerErased || account.deleted) {
    return { verified: false, reason: "customer_erased" };
  }
  if (account.status !== "active") {
    return { verified: false, reason: "account_not_active" };
  }
  if (!account.emailVerified) {
    return { verified: false, reason: "email_not_verified" };
  }
  return { verified: true };
}

/**
 * Whether the order a conversion rests on no longer stands as a conversion fact:
 * cancelled (or expired), or EVERY line fully returned across completed returns.
 * A partial return leaves a real sale behind, so it never flags a link.
 */
export function orderEvidenceIsReverted(input: {
  status: string;
  lines: readonly { ordered: number; returned: number }[];
}): { reverted: boolean; cause: CrmLeadLinkReversalCause | null } {
  if (input.status === "cancelled" || input.status === "expired") {
    return { reverted: true, cause: "order_cancelled" };
  }
  const fully =
    input.lines.length > 0 &&
    input.lines.every(
      (line) => line.ordered > 0 && line.returned >= line.ordered
    );
  return fully
    ? { reverted: true, cause: "order_refunded" }
    : { reverted: false, cause: null };
}

// ---------------------------------------------------------------------------
// State machine (mirrors the guard trigger of sql/1068)
// ---------------------------------------------------------------------------

export function isLegalLinkTransition(
  from: CrmLeadLinkState,
  to: CrmLeadLinkState
): boolean {
  if (from === "linked") return to === "reversal_pending" || to === "reversed";
  if (from === "reversal_pending") return to === "reversed";
  return false;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export type CrmLeadLinkValidationError = { field: string; message: string };

type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: CrmLeadLinkValidationError[] };

export type CreateCrmLeadLinkInput = {
  leadId: string;
  customerId: string;
  evidenceKind: CrmLeadLinkEvidenceKind;
  orderId: string | null;
  expectedVersion: number;
};

export function validateCreateCrmLeadLinkInput(
  value: unknown
): ValidationResult<CreateCrmLeadLinkInput> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "body must be a JSON object." }]
    };
  }
  const record = value as Record<string, unknown>;
  const allowed = [
    "leadId",
    "customerId",
    "evidenceKind",
    "orderId",
    "expectedVersion"
  ];
  const errors: CrmLeadLinkValidationError[] = Object.keys(record)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({ field: key, message: `${key} is not a known field.` }));

  if (!isCrmLeadLinkUuid(record.leadId)) {
    errors.push({ field: "leadId", message: "leadId must be a UUID." });
  }
  if (!isCrmLeadLinkUuid(record.customerId)) {
    errors.push({ field: "customerId", message: "customerId must be a UUID." });
  }
  const kind = record.evidenceKind;
  if (
    typeof kind !== "string" ||
    !(CRM_LEAD_LINK_EVIDENCE_KINDS as readonly string[]).includes(kind)
  ) {
    errors.push({
      field: "evidenceKind",
      message: `evidenceKind must be ${CRM_LEAD_LINK_EVIDENCE_KINDS.join(" or ")}.`
    });
  } else if (kind === "paid_order" && !isCrmLeadLinkUuid(record.orderId)) {
    errors.push({
      field: "orderId",
      message: "orderId is required (a UUID) for paid_order evidence."
    });
  } else if (
    kind === "customer_registration" &&
    record.orderId !== undefined &&
    record.orderId !== null
  ) {
    errors.push({
      field: "orderId",
      message: "orderId must be omitted for customer_registration evidence."
    });
  }
  if (
    typeof record.expectedVersion !== "number" ||
    !Number.isInteger(record.expectedVersion) ||
    record.expectedVersion < 1
  ) {
    errors.push({
      field: "expectedVersion",
      message: "expectedVersion must be a positive integer."
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      leadId: (record.leadId as string).toLowerCase(),
      customerId: (record.customerId as string).toLowerCase(),
      evidenceKind: kind as CrmLeadLinkEvidenceKind,
      orderId:
        kind === "paid_order" ? (record.orderId as string).toLowerCase() : null,
      expectedVersion: record.expectedVersion as number
    }
  };
}
