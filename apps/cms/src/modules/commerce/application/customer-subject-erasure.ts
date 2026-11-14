/**
 * The erasure half of a shopper's data-subject rights (Issue #529, ADR-0055 D2):
 * anonymise the identity, delete what has no bookkeeping value, retain the
 * ledgers, and refuse while the store and the shopper still owe each other
 * something.
 *
 * ## What it does, in one transaction
 *
 * 1. Locks the customer row (`FOR UPDATE`). That lock conflicts with the
 *    `FOR KEY SHARE` an order insert takes on its customer foreign key, so a
 *    checkout racing the erasure waits for it instead of slipping an open order
 *    in after the precondition check.
 * 2. Answers `ALREADY_ERASED` for an erased customer, then checks the refusal
 *    rules ({@link findErasureRefusals}). A refusal changes nothing.
 * 3. Calls `eraseCustomerPushData` (devices, preferences, messages, attempts).
 * 4. DELETES the shopper's sessions (their bearer token dies with them: the next
 *    request answers `401`), one-time codes (by the account's e-mail and the
 *    customer's phone), wishlist lines, saved addresses, campaign recipients and
 *    the retention-projection row.
 * 5. ANONYMISES the customer (name, phone, e-mail), the account (e-mail), the
 *    shopper's review text, the subjects of their conversations and the bodies
 *    of their own messages with per-row-unique sentinels, and marks both rows
 *    `erased_at` with status `blocked` (so every eligibility predicate drops
 *    them; `deleted_at` is deliberately not used, see `sql/1066`).
 * 6. LEAVES the retained families untouched (orders and their children,
 *    payments, documents, returns, refunds, both ledgers, entitlements,
 *    affiliate accounting, quotations, work orders): they resolve to the
 *    now-anonymous customer.
 *
 * Every statement is a plain write in the caller's transaction and none is
 * caught here, so the erasure is all or nothing; the callers' `catch` blocks
 * (routes) re-throw anything they do not map.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { eraseCustomerPushData } from "./customer-push-erasure";
import {
  SUBJECT_TABLES,
  type SubjectTable
} from "../domain/customer-subject-data";
import {
  OPEN_ORDER_STATUSES,
  OPEN_REFUND_STATUSES,
  UNPAID_COMMISSION_STATUSES,
  REQUIRED_RETENTION_NOTICE,
  erasedCustomerName,
  erasedEmail,
  erasedPhone,
  erasedText,
  type SubjectRefusalCode
} from "../domain/customer-subject-policy";

export const SUBJECT_AUDIT_ACTIONS = {
  exported: "commerce.customer_subject.exported",
  erasureRequested: "commerce.customer_subject.erasure_requested",
  erasureRefused: "commerce.customer_subject.erasure_refused",
  erasureRejected: "commerce.customer_subject.erasure_rejected",
  erased: "commerce.customer_subject.erased"
} as const;

type CustomerLockRow = {
  id: string;
  phone: string;
  erased_at: Date | null;
};

type CountRow = { count: number };

export type ErasureSummary = {
  deleted: {
    sessions: number;
    otps: number;
    wishlist: number;
    addresses: number;
    campaignRecipients: number;
    retentionProjection: number;
    push: { devices: number; preferences: number; messages: number };
  };
  anonymised: {
    customer: boolean;
    account: boolean;
    reviews: number;
    conversations: number;
    messages: number;
  };
  retained: {
    /** The bundle keys of the table families left in place. */
    sections: string[];
    orders: number;
    notice: string;
  };
};

export type ErasureOutcome =
  | { kind: "not_found" }
  | { kind: "refused"; codes: SubjectRefusalCode[] }
  | { kind: "erased"; summary: ErasureSummary; rowsAffected: number };

/** The customer's erasure state, without locking (used by the dry-run check). */
export async function readCustomerErasureState(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<{ exists: boolean; erased: boolean }> {
  const rows = (await tx`
    SELECT id, phone, erased_at FROM awcms_commerce_customers
    WHERE tenant_id = ${tenantId} AND id = ${customerId}
  `) as CustomerLockRow[];
  const row = rows[0];
  return { exists: !!row, erased: !!row?.erased_at };
}

/**
 * Every refusal that applies, in a stable order. Read-only. `ALREADY_ERASED` is
 * reported alone: nothing else is worth saying about an erased customer.
 */
export async function findErasureRefusals(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<SubjectRefusalCode[]> {
  const state = await readCustomerErasureState(tx, tenantId, customerId);
  if (state.erased) return ["ALREADY_ERASED"];

  const codes: SubjectRefusalCode[] = [];

  const openOrders = (await tx`
    SELECT count(*)::int AS count FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
      AND deleted_at IS NULL
      AND status = ANY(${tx.array([...OPEN_ORDER_STATUSES], "text")}::text[])
  `) as CountRow[];
  if ((openOrders[0]?.count ?? 0) > 0) codes.push("OPEN_ORDER");

  const openBookings = (await tx`
    SELECT count(*)::int AS count
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_commerce_orders o
      ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    WHERE l.tenant_id = ${tenantId} AND o.customer_id = ${customerId}
      AND l.status = 'active' AND l.deleted_at IS NULL
      AND o.status NOT IN ('cancelled', 'expired')
  `) as CountRow[];
  if ((openBookings[0]?.count ?? 0) > 0) codes.push("OPEN_BOOKING");

  const storedValue = (await tx`
    SELECT count(*)::int AS count FROM awcms_commerce_stored_value_accounts
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
      AND deleted_at IS NULL AND status <> 'expired' AND balance > 0
  `) as CountRow[];
  if ((storedValue[0]?.count ?? 0) > 0) codes.push("STORED_VALUE_BALANCE");

  const pendingRefunds = (await tx`
    SELECT (
      (SELECT count(*) FROM awcms_commerce_refunds r
        JOIN awcms_commerce_orders o
          ON o.tenant_id = r.tenant_id AND o.id = r.order_id
        WHERE r.tenant_id = ${tenantId} AND o.customer_id = ${customerId}
          AND r.status = ANY(${tx.array([...OPEN_REFUND_STATUSES], "text")}::text[]))
      +
      (SELECT count(*) FROM awcms_commerce_returns rt
        JOIN awcms_commerce_orders o
          ON o.tenant_id = rt.tenant_id AND o.id = rt.order_id
        WHERE rt.tenant_id = ${tenantId} AND o.customer_id = ${customerId}
          AND rt.status = 'open')
    )::int AS count
  `) as CountRow[];
  if ((pendingRefunds[0]?.count ?? 0) > 0) codes.push("PENDING_REFUND");

  const unpaidCommission = (await tx`
    SELECT count(*)::int AS count
    FROM awcms_commerce_affiliate_commissions c
    JOIN awcms_commerce_affiliates a ON a.id = c.affiliate_id
    WHERE c.tenant_id = ${tenantId} AND a.customer_id = ${customerId}
      AND c.deleted_at IS NULL
      AND c.status = ANY(${tx.array([...UNPAID_COMMISSION_STATUSES], "text")}::text[])
  `) as CountRow[];
  if ((unpaidCommission[0]?.count ?? 0) > 0) {
    codes.push("UNPAID_AFFILIATE_PAYOUT");
  }

  return codes;
}

/** The bundle keys of every table family an erasure leaves in place. */
export function retainedSections(): string[] {
  const sections = new Set<string>();
  for (const entry of SUBJECT_TABLES as readonly SubjectTable[]) {
    if (entry.erasure.action === "retain") sections.add(entry.section);
  }
  return [...sections];
}

async function count(rows: PromiseLike<unknown>): Promise<number> {
  return ((await rows) as unknown[]).length;
}

/**
 * Runs the erasure. The caller has authenticated the request (shopper session
 * plus a fresh OTP, or an approving second person) and recorded the request
 * row; this does the data work and writes one audit event with COUNTS only.
 */
export async function eraseCustomer(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  options: { actorTenantUserId?: string; correlationId?: string } = {}
): Promise<ErasureOutcome> {
  const locked = (await tx`
    SELECT id, phone, erased_at FROM awcms_commerce_customers
    WHERE tenant_id = ${tenantId} AND id = ${customerId}
    FOR UPDATE
  `) as CustomerLockRow[];
  const customer = locked[0];
  if (!customer) return { kind: "not_found" };

  const refusals = await findErasureRefusals(tx, tenantId, customerId);
  if (refusals.length > 0) return { kind: "refused", codes: refusals };

  const accounts = (await tx`
    SELECT id, email_normalized FROM awcms_commerce_customer_accounts
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
    FOR UPDATE
  `) as { id: string; email_normalized: string }[];
  const account = accounts[0] ?? null;

  // ---- delete ----
  const push = account
    ? await eraseCustomerPushData(
        tx,
        tenantId,
        account.id,
        options.correlationId
      )
    : { devices: 0, preferences: 0, messages: 0 };

  const sessions = account
    ? await count(tx`
        DELETE FROM awcms_commerce_customer_sessions
        WHERE tenant_id = ${tenantId} AND account_id = ${account.id}
        RETURNING id`)
    : 0;

  // Codes are keyed by contact value: the account's e-mail and the customer's phone.
  const otps = account
    ? await count(tx`
        DELETE FROM awcms_commerce_customer_otps
        WHERE tenant_id = ${tenantId}
          AND (email_normalized = ${account.email_normalized}
               OR phone_normalized = ${customer.phone})
        RETURNING id`)
    : await count(tx`
        DELETE FROM awcms_commerce_customer_otps
        WHERE tenant_id = ${tenantId} AND phone_normalized = ${customer.phone}
        RETURNING id`);

  const wishlist = await count(tx`
    DELETE FROM awcms_commerce_wishlists
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
    RETURNING id`);
  const addresses = await count(tx`
    DELETE FROM awcms_commerce_customer_addresses
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
    RETURNING id`);
  const campaignRecipients = await count(tx`
    DELETE FROM awcms_commerce_campaign_recipients
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
    RETURNING id`);
  const retentionProjection = await count(tx`
    DELETE FROM awcms_commerce_report_retention_customers
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
    RETURNING customer_id`);

  // ---- anonymise the text the shopper wrote ----
  const reviews = await count(tx`
    UPDATE awcms_commerce_reviews
    SET body = ${erasedText()}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
    RETURNING id`);

  let conversations = 0;
  let messages = 0;
  if (account) {
    conversations = await count(tx`
      UPDATE awcms_commerce_conversations
      SET subject = ${erasedText()}, updated_at = now()
      WHERE tenant_id = ${tenantId} AND account_id = ${account.id}
      RETURNING id`);
    messages = await count(tx`
      UPDATE awcms_commerce_messages
      SET body = ${erasedText()}
      WHERE tenant_id = ${tenantId} AND sender = 'customer'
        AND conversation_id IN (
          SELECT id FROM awcms_commerce_conversations
          WHERE tenant_id = ${tenantId} AND account_id = ${account.id}
        )
      RETURNING id`);
  }

  // ---- anonymise the identity (after the contact-keyed deletes above) ----
  if (account) {
    await tx`
      UPDATE awcms_commerce_customer_accounts
      SET email_normalized = ${erasedEmail(account.id)},
          status = 'blocked',
          erased_at = now(),
          updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${account.id}`;
  }
  await tx`
    UPDATE awcms_commerce_customers
    SET name = ${erasedCustomerName()},
        phone = ${erasedPhone(customerId)},
        email = NULL,
        status = 'blocked',
        erased_at = now(),
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${customerId}`;

  const orderCount = (await tx`
    SELECT count(*)::int AS count FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
  `) as CountRow[];

  const summary: ErasureSummary = {
    deleted: {
      sessions,
      otps,
      wishlist,
      addresses,
      campaignRecipients,
      retentionProjection,
      push
    },
    anonymised: {
      customer: true,
      account: account !== null,
      reviews,
      conversations,
      messages
    },
    retained: {
      sections: retainedSections(),
      orders: orderCount[0]?.count ?? 0,
      notice: REQUIRED_RETENTION_NOTICE
    }
  };

  const rowsAffected =
    sessions +
    otps +
    wishlist +
    addresses +
    campaignRecipients +
    retentionProjection +
    push.devices +
    push.preferences +
    push.messages +
    reviews +
    conversations +
    messages +
    1 +
    (account ? 1 : 0);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: options.actorTenantUserId,
    moduleKey: "commerce",
    action: SUBJECT_AUDIT_ACTIONS.erased,
    resourceType: "customer_subject_request",
    resourceId: customerId,
    severity: "critical",
    message: "A shopper's personal data was erased (anonymised and deleted).",
    attributes: { customerId, rowsAffected, summary },
    correlationId: options.correlationId
  });

  return { kind: "erased", summary, rowsAffected };
}
