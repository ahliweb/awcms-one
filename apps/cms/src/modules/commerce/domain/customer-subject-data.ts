/**
 * The registry of everything `commerce` holds about ONE shopper, and what a
 * data-subject request does to each table (Issue #529, ADR-0055 D2/D4). Pure
 * data: no I/O, no imports beyond a type.
 *
 * ## Why a local registry
 *
 * The upstream subject-data engine can only bind a tenant-user, identity or
 * profile id, and a commerce customer is none of them (ADR-0016 D1), so every
 * customer-keyed commerce descriptor is honestly `unreachableBySubject`
 * (ADR-0055 D1). This file is the commerce-owned answer to "which tables hold
 * this shopper, how are they reached, and what happens to them". It is the
 * single source three things read:
 *
 * - the export (`application/customer-subject-export.ts`) walks `SUBJECT_TABLES`
 *   in order, by the key sets it resolved once per request;
 * - the erasure (`application/customer-subject-erasure.ts`) performs exactly the
 *   `delete` and `anonymize` actions declared here (its SQL is explicit per
 *   table, and `tests/commerce-customer-subject-data.test.ts` holds both lists
 *   equal);
 * - the guard test, which parses `sql/` and fails when a NEW commerce table with
 *   a customer, account or order column is in neither this registry nor one of
 *   the two "not answered" lists below, so a table added next year cannot be
 *   silently missing from a shopper's export.
 *
 * ## The three erasure actions
 *
 * - `delete`: the row is personal data with no bookkeeping value (a session, a
 *   saved address, a wishlist line, a campaign recipient, an OTP).
 * - `anonymize`: the row stays (an FK, an order, a thread needs it) but the
 *   named columns are overwritten with a per-row-unique sentinel.
 * - `retain`: the row stays untouched under a recorded legal basis (the
 *   bookkeeping duty) and resolves to the anonymised customer. The basis is
 *   proposed in ADR-0055 and awaits counsel's confirmation.
 *
 * ## What the export never carries
 *
 * `redactedColumns` are removed from the bundle: token and code hashes, client
 * address hashes, push endpoints and keys, provider payload bodies and links.
 * `tests/commerce-customer-subject-data.test.ts` fails when a column whose name
 * looks like a secret is neither redacted nor on the reviewed allow-list.
 */

/** The id sets the export and erasure resolve once per request, then reuse. */
export type SubjectKeySet =
  | "customer"
  | "account"
  | "order"
  | "orderItem"
  | "refund"
  | "document"
  | "conversation"
  | "loyaltyAccount"
  | "storedValueAccount"
  | "quotation"
  | "workOrder";

export type SubjectErasureAction =
  | { action: "delete" }
  | { action: "anonymize"; columns: readonly string[] }
  | { action: "retain"; legalBasis: string }
  /** Handled by a function that owns the table family (push data). */
  | { action: "handled_by"; handler: string };

export type SubjectTable = {
  table: string;
  /** The bundle key the rows appear under. */
  section: string;
  keySet: SubjectKeySet;
  /** The column compared with the key set (`id` for the customer row itself). */
  keyColumn: string;
  /** Removed from the bundle (`to_jsonb(row) - redactedColumns`). */
  redactedColumns: readonly string[];
  /** `false` when another function exports the rows (push data) or none are disclosed. */
  exported: boolean;
  erasure: SubjectErasureAction;
};

const BOOKKEEPING =
  "Bookkeeping and tax record kept for the statutory period (UU KUP 28/2007 art. 28; UU PDP 27/2022 erasure exception); resolves to the anonymised customer. Legal basis to be confirmed by counsel (ADR-0055 D2).";
const LEDGER =
  "Append-only ledger: a row can never be changed or removed, and the balance must stay explainable; resolves to the anonymised customer. Legal basis to be confirmed by counsel (ADR-0055 D2).";

const retain = (legalBasis: string = BOOKKEEPING) =>
  ({ action: "retain", legalBasis }) as const;

export const SUBJECT_TABLES: readonly SubjectTable[] = [
  // ---- the customer and what hangs directly off it ----
  {
    table: "awcms_commerce_customers",
    section: "customer",
    keySet: "customer",
    keyColumn: "id",
    redactedColumns: [],
    exported: true,
    erasure: { action: "anonymize", columns: ["name", "phone", "email"] }
  },
  {
    table: "awcms_commerce_customer_addresses",
    section: "addresses",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: [],
    exported: true,
    erasure: { action: "delete" }
  },
  {
    table: "awcms_commerce_wishlists",
    section: "wishlist",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: [],
    exported: true,
    erasure: { action: "delete" }
  },
  {
    table: "awcms_commerce_reviews",
    section: "reviews",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: [],
    exported: true,
    erasure: { action: "anonymize", columns: ["body"] }
  },
  {
    table: "awcms_commerce_campaign_recipients",
    section: "campaignRecipients",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: ["outbox_ref"],
    exported: true,
    erasure: { action: "delete" }
  },
  {
    table: "awcms_commerce_report_retention_customers",
    section: "retentionProjection",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: [],
    exported: true,
    erasure: { action: "delete" }
  },
  {
    table: "awcms_commerce_affiliates",
    section: "affiliate",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: [],
    exported: true,
    erasure: retain(
      "Affiliate commission accounting: the code and rate the commissions were earned under; carries no name, contact or payout detail. Legal basis to be confirmed by counsel (ADR-0055 D2)."
    )
  },
  {
    table: "awcms_commerce_entitlements",
    section: "entitlements",
    keySet: "customer",
    keyColumn: "owner_customer_id",
    redactedColumns: [],
    exported: true,
    erasure: retain(
      "Proof of a purchased entitlement, tied to its paid order; resolves to the anonymised customer. Legal basis to be confirmed by counsel (ADR-0055 D2)."
    )
  },
  {
    table: "awcms_commerce_loyalty_accounts",
    section: "loyaltyAccount",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: [],
    exported: true,
    erasure: retain(LEDGER)
  },
  {
    table: "awcms_commerce_stored_value_accounts",
    section: "storedValueAccounts",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: ["code_hash"],
    exported: true,
    erasure: retain(LEDGER)
  },
  {
    table: "awcms_commerce_quotations",
    section: "quotations",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: [],
    exported: true,
    erasure: retain()
  },
  {
    table: "awcms_commerce_work_orders",
    section: "workOrders",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: [],
    exported: true,
    erasure: retain()
  },
  {
    table: "awcms_commerce_orders",
    section: "orders",
    keySet: "customer",
    keyColumn: "customer_id",
    redactedColumns: [],
    exported: true,
    erasure: retain(
      `${BOOKKEEPING} The order's own address and notes columns are retained with it (ADR-0055 D2: scrubbing them while the document snapshots keep the same text would be incoherent).`
    )
  },
  {
    table: "awcms_commerce_customer_subject_requests",
    section: "subjectRequests",
    keySet: "customer",
    keyColumn: "customer_id",
    // Staff stamps and the staff-typed `reason` stay out of the shopper's bundle.
    redactedColumns: [
      "idempotency_key",
      "requested_by_tenant_user_id",
      "decided_by_tenant_user_id",
      "reason",
      "correlation_id"
    ],
    exported: true,
    erasure: retain(
      "Evidence of the shopper's own data-subject requests and what each one left in place: counts, codes, status and timestamps, plus staff actor stamps and a staff-typed reason that the export omits (ADR-0055 D1)."
    )
  },

  // ---- through the customer account ----
  {
    table: "awcms_commerce_customer_accounts",
    section: "account",
    keySet: "account",
    keyColumn: "id",
    redactedColumns: [],
    exported: true,
    erasure: { action: "anonymize", columns: ["email_normalized"] }
  },
  {
    table: "awcms_commerce_customer_sessions",
    section: "sessions",
    keySet: "account",
    keyColumn: "account_id",
    redactedColumns: ["token_hash", "client_ip_hash"],
    exported: true,
    erasure: { action: "delete" }
  },
  {
    table: "awcms_commerce_conversations",
    section: "conversations",
    keySet: "account",
    keyColumn: "account_id",
    redactedColumns: [],
    exported: true,
    erasure: { action: "anonymize", columns: ["subject"] }
  },
  {
    table: "awcms_commerce_push_devices",
    section: "push",
    keySet: "account",
    keyColumn: "account_id",
    redactedColumns: [],
    exported: false,
    erasure: { action: "handled_by", handler: "eraseCustomerPushData" }
  },
  {
    table: "awcms_commerce_push_preferences",
    section: "push",
    keySet: "account",
    keyColumn: "account_id",
    redactedColumns: [],
    exported: false,
    erasure: { action: "handled_by", handler: "eraseCustomerPushData" }
  },
  {
    table: "awcms_commerce_push_messages",
    section: "push",
    keySet: "account",
    keyColumn: "account_id",
    redactedColumns: [],
    exported: false,
    erasure: { action: "handled_by", handler: "eraseCustomerPushData" }
  },
  {
    table: "awcms_commerce_push_delivery_attempts",
    section: "push",
    keySet: "account",
    keyColumn: "message_id",
    redactedColumns: [],
    exported: false,
    erasure: { action: "handled_by", handler: "eraseCustomerPushData" }
  },

  // ---- through a parent: the loyalty and stored-value accounts ----
  {
    table: "awcms_commerce_loyalty_ledger",
    section: "loyaltyLedger",
    keySet: "loyaltyAccount",
    keyColumn: "account_id",
    redactedColumns: [],
    exported: true,
    erasure: retain(LEDGER)
  },
  {
    table: "awcms_commerce_loyalty_redemptions",
    section: "loyaltyRedemptions",
    keySet: "loyaltyAccount",
    keyColumn: "account_id",
    redactedColumns: [],
    exported: true,
    erasure: retain(LEDGER)
  },
  {
    table: "awcms_commerce_stored_value_ledger",
    section: "storedValueLedger",
    keySet: "storedValueAccount",
    keyColumn: "account_id",
    redactedColumns: [],
    exported: true,
    erasure: retain(LEDGER)
  },

  // ---- through the order ----
  ...(
    [
      ["awcms_commerce_order_items", "orderItems"],
      ["awcms_commerce_order_events", "orderEvents"],
      ["awcms_commerce_payment_allocations", "paymentAllocations"],
      ["awcms_commerce_returns", "returns"],
      ["awcms_commerce_return_lines", "returnLines"],
      ["awcms_commerce_refunds", "refunds"],
      ["awcms_commerce_affiliate_commissions", "affiliateCommissions"],
      ["awcms_commerce_booking_reservation_links", "bookingReservations"],
      ["awcms_commerce_booking_refund_decisions", "bookingRefundDecisions"],
      ["awcms_commerce_booking_reschedules", "bookingReschedules"],
      ["awcms_commerce_report_booking_orders", "bookingRevenueProjection"]
    ] as const
  ).map(([table, section]): SubjectTable => ({
    table,
    section,
    keySet: "order",
    keyColumn: "order_id",
    redactedColumns: [
      "awcms_commerce_booking_reservation_links",
      "awcms_commerce_booking_refund_decisions",
      "awcms_commerce_booking_reschedules"
    ].includes(table)
      ? ["client_key", "request_hash"]
      : [],
    exported: true,
    erasure: retain()
  })),
  {
    table: "awcms_commerce_payment_confirmations",
    section: "paymentConfirmations",
    keySet: "order",
    keyColumn: "order_id",
    redactedColumns: [],
    exported: true,
    erasure: retain()
  },
  {
    table: "awcms_commerce_payment_gateway_sessions",
    section: "paymentGatewaySessions",
    keySet: "order",
    keyColumn: "order_id",
    redactedColumns: ["redirect_url", "raw_status", "provider_ref"],
    exported: true,
    erasure: retain()
  },
  {
    table: "awcms_commerce_payment_events",
    section: "paymentEvents",
    keySet: "order",
    keyColumn: "order_id",
    redactedColumns: ["payload", "event_key", "provider_ref"],
    exported: true,
    erasure: retain()
  },
  {
    table: "awcms_commerce_documents",
    section: "documents",
    keySet: "order",
    keyColumn: "source_id",
    // The snapshot is the issued document itself and is retained unaltered; the
    // bundle carries the document's metadata and totals, not its body.
    redactedColumns: ["snapshot", "content_hash"],
    exported: true,
    erasure: retain(
      `${BOOKKEEPING} A tax or sales document is never rewritten after issue; its snapshot keeps the name and address printed on it.`
    )
  },
  {
    table: "awcms_commerce_commission_submissions",
    section: "commissionSubmissions",
    keySet: "order",
    keyColumn: "order_id",
    // Ids of an order line and an opaque employment: about the staff member's
    // commission, not about the shopper, so it is never disclosed.
    redactedColumns: [],
    exported: false,
    erasure: retain(
      "Evidence of what was submitted to the commission intake for the order line; references an order, never the shopper (ADR-0046 D12)."
    )
  },

  // ---- two hops ----
  {
    table: "awcms_commerce_order_item_components",
    section: "orderItemComponents",
    keySet: "orderItem",
    keyColumn: "order_item_id",
    redactedColumns: [],
    exported: true,
    erasure: retain()
  },
  {
    table: "awcms_commerce_refund_compensations",
    section: "refundCompensations",
    keySet: "refund",
    keyColumn: "refund_id",
    redactedColumns: [],
    exported: true,
    erasure: retain()
  },
  {
    table: "awcms_commerce_document_deliveries",
    section: "documentDeliveries",
    keySet: "document",
    keyColumn: "document_id",
    redactedColumns: ["link_token_hash", "content_hash"],
    exported: true,
    erasure: retain()
  },
  {
    table: "awcms_commerce_messages",
    section: "messages",
    keySet: "conversation",
    keyColumn: "conversation_id",
    redactedColumns: [],
    exported: true,
    // Only the shopper's OWN messages (sender = 'customer') are overwritten; the
    // store's replies stay (they are the store's words, not the shopper's).
    erasure: { action: "anonymize", columns: ["body"] }
  },
  {
    table: "awcms_commerce_quotation_versions",
    section: "quotationVersions",
    keySet: "quotation",
    keyColumn: "quotation_id",
    redactedColumns: ["content_hash"],
    exported: true,
    erasure: retain()
  },
  {
    table: "awcms_commerce_work_order_events",
    section: "workOrderEvents",
    keySet: "workOrder",
    keyColumn: "work_order_id",
    redactedColumns: [],
    exported: true,
    erasure: retain()
  }
];

/**
 * Tables that hold a shopper only by a CONTACT VALUE (an e-mail address or a
 * phone number) and so cannot be reached by a customer id. The erasure deletes
 * the OTPs by the contact it knows; the others are listed in the bundle's
 * `unanswered` section with the reason, and age out through their own retention.
 */
export const CONTACT_MATCHED_TABLES: Readonly<
  Record<string, { reason: string; erasedByContact: boolean }>
> = {
  awcms_commerce_customer_otps: {
    reason:
      "A one-time code row is keyed by the e-mail address or phone number it was sent to and is deleted by the erasure by that contact; it expires within minutes in any case.",
    erasedByContact: true
  },
  awcms_commerce_whatsapp_messages: {
    reason:
      "The outbound WhatsApp message log is keyed by the recipient phone, which commerce can only match through the keyed recipient hash held by the delivery job; it is purged by its own age-based retention and is not rewritten by an erasure.",
    erasedByContact: false
  },
  awcms_commerce_whatsapp_delivery_attempts: {
    reason:
      "Delivery attempts of the WhatsApp messages above: reached only through them, purged by the same retention.",
    erasedByContact: false
  }
};

/**
 * Copies of the shopper's e-mail address in upstream's `awcms_email_messages`
 * (sign-in and data-request codes, order and document-delivery mails, campaign
 * mails). That table belongs to the `email` module and is keyed by recipient
 * address and template, not by a commerce customer, so neither the export nor
 * the erasure reaches it; each row ages out through the e-mail module's own
 * retention. Listed in the bundle's `unanswered` section (ADR-0055 D2/D4); the
 * proper fix is an upstream subject-data hook (ADR-0055 appendix).
 */
export const UPSTREAM_CONTACT_COPIES: Readonly<Record<string, string>> = {
  awcms_email_messages:
    "Outbound e-mail (sign-in and data-request codes, order and document mails, campaign mails) is stored by the e-mail module under the recipient address; commerce cannot match it to you by customer id, so it is not in this bundle and an erasure does not rewrite it. It is removed by the e-mail module's own retention."
};

const catalog =
  "Catalog or storefront content authored by staff; it names no shopper.";
const staffOnly =
  "Staff-side configuration or cash-register record; its actor stamps are staff, and it names no shopper.";
const aggregate =
  "An aggregate projection (counts and sums by day, product or tender); it carries no customer or order identifier.";

/**
 * Every other commerce table, with the reason it is not about one shopper. A
 * table that gains a customer, account or order column must move out of this
 * list into `SUBJECT_TABLES` (the guard test refuses otherwise).
 */
export const NOT_ABOUT_A_CUSTOMER: Readonly<Record<string, string>> = {
  awcms_commerce_attribute_definitions: catalog,
  awcms_commerce_booking_offering_link_resources: catalog,
  awcms_commerce_booking_offering_links: catalog,
  awcms_commerce_bundle_components: catalog,
  awcms_commerce_campaigns:
    "A campaign's own content and schedule, authored by staff; its recipients are covered through the recipients table.",
  awcms_commerce_cancellation_policies: catalog,
  awcms_commerce_cancellation_policy_windows: catalog,
  awcms_commerce_catalog_import_batches: catalog,
  awcms_commerce_categories: catalog,
  awcms_commerce_commission_attributed_sources:
    "Two codes and a timestamp per (source type, rule key); traceable to no person (ADR-0046).",
  awcms_commerce_commission_settings: staffOnly,
  awcms_commerce_commission_staff_links: staffOnly,
  awcms_commerce_courier_destinations:
    "A public lookup of courier destination codes; no shopper.",
  awcms_commerce_document_sequences:
    "The document numbering counters; no shopper.",
  awcms_commerce_expense_categories: staffOnly,
  awcms_commerce_expenses: staffOnly,
  awcms_commerce_flash_sale_products: catalog,
  awcms_commerce_flash_sales: catalog,
  awcms_commerce_held_sales:
    "A cart a cashier parked at the till; keyed by the cashier and register, not by a customer.",
  awcms_commerce_loyalty_programs: catalog,
  awcms_commerce_loyalty_redemption_settings: catalog,
  awcms_commerce_popups: catalog,
  awcms_commerce_product_attribute_values: catalog,
  awcms_commerce_product_deposit_policies: catalog,
  awcms_commerce_product_images: catalog,
  awcms_commerce_product_variants: catalog,
  awcms_commerce_products: catalog,
  awcms_commerce_protected_media_links: catalog,
  awcms_commerce_register_close_lines: staffOnly,
  awcms_commerce_register_close_requests: staffOnly,
  awcms_commerce_register_corrections: staffOnly,
  awcms_commerce_register_movements: staffOnly,
  awcms_commerce_register_sessions: staffOnly,
  awcms_commerce_registers: staffOnly,
  awcms_commerce_report_booking_restated: aggregate,
  awcms_commerce_report_cash_up_tenders: aggregate,
  awcms_commerce_report_expense_daily: aggregate,
  awcms_commerce_report_loyalty_daily: aggregate,
  awcms_commerce_report_retention_restated: aggregate,
  awcms_commerce_report_returns_daily: aggregate,
  awcms_commerce_report_stored_value_daily: aggregate,
  awcms_commerce_report_tender_daily: aggregate,
  awcms_commerce_sales_by_category: aggregate,
  awcms_commerce_sales_by_product: aggregate,
  awcms_commerce_sales_daily: aggregate,
  awcms_commerce_segment_versions:
    "A segment's rule definition; membership is evaluated on demand from live customers and is never stored.",
  awcms_commerce_segments:
    "A segment's definition and name; membership is evaluated on demand and never stored.",
  awcms_commerce_shipping_rates: catalog,
  awcms_commerce_sliders: catalog,
  awcms_commerce_store_settings: catalog,
  awcms_commerce_stored_value_programs: catalog,
  awcms_commerce_testimonials:
    "Free text a store owner typed to publish; the author is not a customer record and no id links it to one, so it cannot be matched to a shopper.",
  awcms_commerce_vouchers: catalog,
  awcms_commerce_webhook_endpoints: staffOnly
};

/** The column-name pattern that marks a likely secret or opaque credential. */
export const SECRET_COLUMN_PATTERN =
  /(hash|secret|token|endpoint|key|payload|ciphertext|auth|redirect_url|raw_status|snapshot)/;

/**
 * Columns whose name matches the pattern above and are nevertheless safe to
 * disclose, each with the reason. Reviewed by hand: a new match must be
 * redacted or added here deliberately.
 */
export const REVIEWED_NOT_SECRET_COLUMNS: Readonly<Record<string, string>> = {
  "awcms_commerce_orders.tax_snapshot_id":
    "the id of the tax snapshot row the order was priced under; an identifier, not a credential",
  "awcms_commerce_loyalty_ledger.idempotency_key":
    "a server-derived business key of the form 'order:<id>:earn'; names no secret and lets the shopper match an entry to its source",
  "awcms_commerce_stored_value_ledger.source_key":
    "a server-derived business key of the entry's source (an order or a refund); not a credential",
  "awcms_commerce_payment_allocations.source_key":
    "a server-derived business key of the allocation's source; not a credential",
  "awcms_commerce_returns.source_key":
    "a server-derived business key of the return; not a credential",
  "awcms_commerce_refunds.source_key":
    "a server-derived business key of the refund; not a credential",
  "awcms_commerce_booking_refund_decisions.source_key":
    "a server-derived business key of the decision; not a credential",
  "awcms_commerce_document_deliveries.template_key":
    "the name of the message template used; a catalogue key, not a credential"
};

export const SUBJECT_TABLE_NAMES: readonly string[] = [
  ...new Set(SUBJECT_TABLES.map((t) => t.table))
];

/** Every table the registry and both lists account for. */
export function allClassifiedTables(): ReadonlySet<string> {
  return new Set([
    ...SUBJECT_TABLE_NAMES,
    ...Object.keys(CONTACT_MATCHED_TABLES),
    ...Object.keys(NOT_ABOUT_A_CUSTOMER)
  ]);
}
