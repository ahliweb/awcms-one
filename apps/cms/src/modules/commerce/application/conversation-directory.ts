/**
 * `awcms_commerce_conversations` / `awcms_commerce_messages` persistence —
 * the commerce inbox (Issue #111, contract #106 D8). Customer-side functions
 * (`listConversationsForAccount`, `openConversation`,
 * `fetchConversationForAccount`, `postCustomerMessage`) mirror
 * `customer-account-resources.ts`'s own convention: every function takes
 * `tenantId` + `accountId`/`customerId` explicitly (never re-derived) and
 * scopes every query to both — RLS (FORCE on both tables, `sql/927`) is the
 * tenant backstop, the account/customer id is the ownership backstop a
 * bearer session already proved. Store-side functions
 * (`listConversationsForAdmin`, `fetchConversationForAdmin`,
 * `postStoreReply`, `setConversationStatus`) are gated by
 * `commerce.conversations.read|update` at the route, not here.
 *
 * `last_message_at`/`unread_for_store`/`unread_for_customer` are
 * denormalized on `awcms_commerce_conversations` and updated in the SAME
 * statement/transaction as every `awcms_commerce_messages` insert — see
 * `sql/927`'s header for why a join-derived value was rejected.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { enqueueDirectAddressEmail } from "../../email/application/direct-address-notification";
import {
  fetchActiveEmailTemplateByKey,
  seedDefaultEmailTemplates
} from "../../email/application/email-template-directory";
import { registerDerivedEmailTemplateCategory } from "../../email/domain/email-template-categories";
import type { DefaultEmailTemplate } from "../../email/domain/email-default-templates";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  utcMicrosecondTextSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "conversation";

export const CONVERSATION_LIST_DEFAULT_LIMIT = 10;
export const CONVERSATION_LIST_MAX_LIMIT = 50;

// ---------------------------------------------------------------------------
// The reply-notification e-mail template — same auto-seed-on-first-miss
// shape `customer-otp-channel-adapters.ts`'s `ensureCustomerOtpTemplate`
// already established for this module.
// ---------------------------------------------------------------------------

export const CONVERSATION_REPLY_TEMPLATE_KEY =
  "derived.commerce_conversation_reply";

/** The only variables the template may interpolate — `email-template-render.ts` silently drops anything else. */
export const CONVERSATION_REPLY_TEMPLATE_VARIABLES = [
  "name",
  "subject",
  "storeName",
  "link"
] as const;

registerDerivedEmailTemplateCategory(
  CONVERSATION_REPLY_TEMPLATE_KEY,
  CONVERSATION_REPLY_TEMPLATE_VARIABLES
);

export const CONVERSATION_REPLY_DEFAULT_TEMPLATE = {
  name: "Conversation reply",
  subject: {
    en: "New reply from {{storeName}}",
    id: "Balasan baru dari {{storeName}}"
  },
  textBody: {
    en: 'Hi {{name}},\n\n{{storeName}} replied to your message "{{subject}}". View the conversation: {{link}}\n\n{{storeName}}',
    id: 'Halo {{name}},\n\n{{storeName}} membalas pesan Anda "{{subject}}". Lihat percakapan: {{link}}\n\n{{storeName}}'
  }
} as const;

const SEED_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

/** Returns `true` when a template row now exists (seeded here or already present) — same shape as `ensureCustomerOtpTemplate`. */
export async function ensureConversationReplyTemplate(
  tx: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  const existing = await fetchActiveEmailTemplateByKey(
    tx,
    tenantId,
    CONVERSATION_REPLY_TEMPLATE_KEY
  );
  if (existing) return true;

  const template: DefaultEmailTemplate = {
    templateKey: CONVERSATION_REPLY_TEMPLATE_KEY,
    name: CONVERSATION_REPLY_DEFAULT_TEMPLATE.name,
    subjectTemplate: { ...CONVERSATION_REPLY_DEFAULT_TEMPLATE.subject },
    textBodyTemplate: { ...CONVERSATION_REPLY_DEFAULT_TEMPLATE.textBody }
  };
  await seedDefaultEmailTemplates(tx, tenantId, SEED_ACTOR_ID, [template]);

  return (
    (await fetchActiveEmailTemplateByKey(
      tx,
      tenantId,
      CONVERSATION_REPLY_TEMPLATE_KEY
    )) !== null
  );
}

function conversationStorefrontPublicUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  return (env.COMMERCE_STOREFRONT_PUBLIC_URL ?? "").replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

type ConversationRow = {
  id: string;
  subject: string;
  status: "open" | "closed";
  last_message_at: Date;
  unread_for_customer: boolean;
  unread_for_store: boolean;
  created_at: Date;
  customer_id?: string;
  customer_name?: string;
};

/** The storefront's own `Percakapan` contract shape (`akun-klien.ts`) — `unreadForCustomer` travels as 0|1, not a genuine count (`sql/927`'s header). */
export type CustomerConversationRecord = {
  id: string;
  subject: string;
  status: "open" | "closed";
  lastMessageAt: string;
  unreadForCustomer: number;
};

/** The staff list/detail's own shape — carries `customerId`/`customerName` and the STORE's own unread flag, the account's own list never needs either. */
export type AdminConversationRecord = {
  id: string;
  subject: string;
  status: "open" | "closed";
  lastMessageAt: string;
  unreadForStore: number;
  unreadForCustomer: number;
  customerId: string;
  customerName: string;
};

function toCustomerRecord(row: ConversationRow): CustomerConversationRecord {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    lastMessageAt: row.last_message_at.toISOString(),
    unreadForCustomer: row.unread_for_customer ? 1 : 0
  };
}

function toAdminRecord(row: ConversationRow): AdminConversationRecord {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    lastMessageAt: row.last_message_at.toISOString(),
    unreadForStore: row.unread_for_store ? 1 : 0,
    unreadForCustomer: row.unread_for_customer ? 1 : 0,
    customerId: row.customer_id ?? "",
    customerName: row.customer_name ?? ""
  };
}

type MessageRow = {
  id: string;
  sender: "customer" | "store";
  body: string;
  created_at: Date;
};

export type ConversationMessageRecord = {
  id: string;
  sender: "customer" | "store";
  body: string;
  createdAt: string;
};

function toMessageRecord(row: MessageRow): ConversationMessageRecord {
  return {
    id: row.id,
    sender: row.sender,
    body: row.body,
    createdAt: row.created_at.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Customer side
// ---------------------------------------------------------------------------

export type ConversationListPage<T> = { items: T[]; nextCursor: string | null };

/** `GET /account/conversations?cursor=` — newest-activity-first, keyset on `(last_message_at, id)`. */
export async function listConversationsForAccount(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  cursor: KeysetCursor | null,
  limit: number = CONVERSATION_LIST_DEFAULT_LIMIT
): Promise<ConversationListPage<CustomerConversationRecord>> {
  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    CONVERSATION_LIST_MAX_LIMIT
  );
  const cursorSortValue = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT id, subject, status, last_message_at, unread_for_customer,
           unread_for_store, created_at,
           ${tx.unsafe(utcMicrosecondTextSql("last_message_at"))} AS sort_cursor
    FROM awcms_commerce_conversations
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId} AND deleted_at IS NULL
      AND (
        ${cursorSortValue}::timestamptz IS NULL
        OR (last_message_at, id) < (${cursorSortValue}, ${cursorId})
      )
    ORDER BY last_message_at DESC, id DESC
    LIMIT ${boundedLimit}
  `) as (ConversationRow & { sort_cursor: string })[];

  const items = rows.map(toCustomerRecord);
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === boundedLimit && last
      ? encodeKeysetCursor(last.sort_cursor, last.id)
      : null;

  return { items, nextCursor };
}

export { decodeKeysetCursor };

export type OpenConversationResult = {
  conversation: CustomerConversationRecord;
  message: ConversationMessageRecord;
};

/** `POST /account/conversations` — opens a new thread with its first (customer) message, inside one transaction. */
export async function openConversation(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  input: { subject: string; body: string },
  correlationId?: string
): Promise<OpenConversationResult> {
  const conversationRows = (await tx`
    INSERT INTO awcms_commerce_conversations (
      tenant_id, account_id, subject, status, last_message_at,
      unread_for_store, unread_for_customer
    )
    VALUES (${tenantId}, ${accountId}, ${input.subject}, 'open', now(), true, false)
    RETURNING id, subject, status, last_message_at, unread_for_customer, unread_for_store, created_at
  `) as ConversationRow[];
  const conversation = conversationRows[0]!;

  const messageRows = (await tx`
    INSERT INTO awcms_commerce_messages (tenant_id, conversation_id, sender, body)
    VALUES (${tenantId}, ${conversation.id}, 'customer', ${input.body})
    RETURNING id, sender, body, created_at
  `) as MessageRow[];
  const message = messageRows[0]!;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: conversation.id,
    message: "Customer opened a conversation.",
    attributes: { accountId },
    correlationId
  });

  return {
    conversation: toCustomerRecord(conversation),
    message: toMessageRecord(message)
  };
}

export type ConversationThread<TConversation> = {
  conversation: TConversation;
  messages: ConversationMessageRecord[];
};

/** `GET /account/conversations/{id}` — `null` when `id` is not a LIVE conversation owned by this account. Marks the thread read for the CUSTOMER as a side effect, per #106's own contract. */
export async function fetchConversationForAccount(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  conversationId: string
): Promise<ConversationThread<CustomerConversationRecord> | null> {
  const rows = (await tx`
    SELECT id, subject, status, last_message_at, unread_for_customer, unread_for_store, created_at
    FROM awcms_commerce_conversations
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId} AND id = ${conversationId}
      AND deleted_at IS NULL
  `) as ConversationRow[];
  if (rows.length === 0) return null;

  if (rows[0]!.unread_for_customer) {
    await tx`
      UPDATE awcms_commerce_conversations
      SET unread_for_customer = false
      WHERE tenant_id = ${tenantId} AND id = ${conversationId}
    `;
    rows[0]!.unread_for_customer = false;
  }

  const messages = (await tx`
    SELECT id, sender, body, created_at
    FROM awcms_commerce_messages
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}
    ORDER BY created_at ASC, id ASC
  `) as MessageRow[];

  return {
    conversation: toCustomerRecord(rows[0]!),
    messages: messages.map(toMessageRecord)
  };
}

export type PostCustomerMessageOutcome =
  | { kind: "not_found" }
  | { kind: "closed" }
  | { kind: "posted"; message: ConversationMessageRecord };

/** `POST /account/conversations/{id}/messages` — `409 CONVERSATION_CLOSED` once a thread is closed (customers never reopen their own thread; only a store reply does, see {@link postStoreReply}). The caller enforces the 10/h rate limit BEFORE calling this (route-level, `checkSharedRateLimit`) — this function assumes that check already passed. */
export async function postCustomerMessage(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  conversationId: string,
  body: string,
  correlationId?: string
): Promise<PostCustomerMessageOutcome> {
  const conversationRows = (await tx`
    SELECT id, status FROM awcms_commerce_conversations
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId} AND id = ${conversationId}
      AND deleted_at IS NULL
  `) as { id: string; status: string }[];
  if (conversationRows.length === 0) return { kind: "not_found" };
  if (conversationRows[0]!.status === "closed") return { kind: "closed" };

  const messageRows = (await tx`
    INSERT INTO awcms_commerce_messages (tenant_id, conversation_id, sender, body)
    VALUES (${tenantId}, ${conversationId}, 'customer', ${body})
    RETURNING id, sender, body, created_at
  `) as MessageRow[];
  const message = messageRows[0]!;

  await tx`
    UPDATE awcms_commerce_conversations
    SET last_message_at = ${message.created_at}, unread_for_store = true, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${conversationId}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: conversationId,
    message: "Customer posted a message.",
    attributes: { accountId },
    correlationId
  });

  return { kind: "posted", message: toMessageRecord(message) };
}

// ---------------------------------------------------------------------------
// Store (admin) side
// ---------------------------------------------------------------------------

const ADMIN_LIST_COLUMNS = `
  c.id, c.subject, c.status, c.last_message_at, c.unread_for_customer,
  c.unread_for_store, c.created_at, cu.id AS customer_id, cu.name AS customer_name
`;

export type AdminConversationFilter = {
  status?: "open" | "closed";
  unreadForStore?: boolean;
};

/** `GET /api/v1/commerce/conversations?status=&unread=&cursor=` — newest-activity-first. */
export async function listConversationsForAdmin(
  tx: Bun.SQL,
  tenantId: string,
  filter: AdminConversationFilter,
  cursor: KeysetCursor | null,
  limit: number = CONVERSATION_LIST_DEFAULT_LIMIT
): Promise<ConversationListPage<AdminConversationRecord>> {
  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    CONVERSATION_LIST_MAX_LIMIT
  );
  const cursorSortValue = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const statusFilter = filter.status ?? null;
  const unreadFilter = filter.unreadForStore ?? null;

  const rows = (await tx`
    SELECT ${tx.unsafe(ADMIN_LIST_COLUMNS)},
           ${tx.unsafe(utcMicrosecondTextSql("c.last_message_at"))} AS sort_cursor
    FROM awcms_commerce_conversations c
    JOIN awcms_commerce_customer_accounts a ON a.id = c.account_id AND a.tenant_id = c.tenant_id
    JOIN awcms_commerce_customers cu ON cu.id = a.customer_id AND cu.tenant_id = c.tenant_id
    WHERE c.tenant_id = ${tenantId} AND c.deleted_at IS NULL
      AND (${statusFilter}::text IS NULL OR c.status = ${statusFilter})
      AND (${unreadFilter}::boolean IS NULL OR c.unread_for_store = ${unreadFilter})
      AND (
        ${cursorSortValue}::timestamptz IS NULL
        OR (c.last_message_at, c.id) < (${cursorSortValue}, ${cursorId})
      )
    ORDER BY c.last_message_at DESC, c.id DESC
    LIMIT ${boundedLimit}
  `) as (ConversationRow & { sort_cursor: string })[];

  const items = rows.map(toAdminRecord);
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === boundedLimit && last
      ? encodeKeysetCursor(last.sort_cursor, last.id)
      : null;

  return { items, nextCursor };
}

/** `GET /api/v1/commerce/conversations/{id}` — `null` for an unknown/other-tenant conversation. Marks the thread read for the STORE as a side effect. */
export async function fetchConversationForAdmin(
  tx: Bun.SQL,
  tenantId: string,
  conversationId: string
): Promise<ConversationThread<AdminConversationRecord> | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(ADMIN_LIST_COLUMNS)}
    FROM awcms_commerce_conversations c
    JOIN awcms_commerce_customer_accounts a ON a.id = c.account_id AND a.tenant_id = c.tenant_id
    JOIN awcms_commerce_customers cu ON cu.id = a.customer_id AND cu.tenant_id = c.tenant_id
    WHERE c.tenant_id = ${tenantId} AND c.id = ${conversationId} AND c.deleted_at IS NULL
  `) as ConversationRow[];
  if (rows.length === 0) return null;

  if (rows[0]!.unread_for_store) {
    await tx`
      UPDATE awcms_commerce_conversations
      SET unread_for_store = false
      WHERE tenant_id = ${tenantId} AND id = ${conversationId}
    `;
    rows[0]!.unread_for_store = false;
  }

  const messages = (await tx`
    SELECT id, sender, body, created_at
    FROM awcms_commerce_messages
    WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}
    ORDER BY created_at ASC, id ASC
  `) as MessageRow[];

  return {
    conversation: toAdminRecord(rows[0]!),
    messages: messages.map(toMessageRecord)
  };
}

/** Account e-mail + display name for the reply-notification e-mail — queried directly (never through `CustomerAccountRecord`, which only ever carries the MASKED e-mail — see `customer-account-store.ts`'s `emailMasked`). */
async function fetchAccountContactForConversation(
  tx: Bun.SQL,
  tenantId: string,
  conversationId: string
): Promise<{ accountId: string; email: string; name: string } | null> {
  const rows = (await tx`
    SELECT a.id AS account_id, a.email_normalized AS email, cu.name AS name
    FROM awcms_commerce_conversations c
    JOIN awcms_commerce_customer_accounts a ON a.id = c.account_id AND a.tenant_id = c.tenant_id
    JOIN awcms_commerce_customers cu ON cu.id = a.customer_id AND cu.tenant_id = c.tenant_id
    WHERE c.tenant_id = ${tenantId} AND c.id = ${conversationId}
  `) as { account_id: string; email: string; name: string }[];
  if (rows.length === 0) return null;
  return {
    accountId: rows[0]!.account_id,
    email: rows[0]!.email,
    name: rows[0]!.name
  };
}

async function tenantStoreName(tx: Bun.SQL, tenantId: string): Promise<string> {
  const rows = (await tx`
    SELECT tenant_name FROM awcms_tenants WHERE id = ${tenantId}
  `) as { tenant_name: string | null }[];
  return rows[0]?.tenant_name ?? "Our store";
}

export type PostStoreReplyOutcome =
  | { kind: "not_found" }
  | { kind: "posted"; message: ConversationMessageRecord };

/**
 * `POST /api/v1/commerce/conversations/{id}/messages` — the staff reply.
 * Implicitly REOPENS a closed conversation (contract's own rule — a store
 * reply is always allowed, unlike a customer's). Enqueues one
 * `derived.commerce_conversation_reply` e-mail through the `email` module's
 * outbox INSIDE this same transaction, auto-seeding the template on first
 * miss exactly like `ensureCustomerOtpTemplate` — a crash between the
 * message insert and the enqueue can never leave one without the other.
 */
export async function postStoreReply(
  tx: Bun.SQL,
  tenantId: string,
  senderTenantUserId: string,
  conversationId: string,
  body: string,
  correlationId?: string
): Promise<PostStoreReplyOutcome> {
  const existingRows = (await tx`
    SELECT id, status FROM awcms_commerce_conversations
    WHERE tenant_id = ${tenantId} AND id = ${conversationId} AND deleted_at IS NULL
  `) as { id: string; status: string }[];
  if (existingRows.length === 0) return { kind: "not_found" };

  const wasClosed = existingRows[0]!.status === "closed";

  const messageRows = (await tx`
    INSERT INTO awcms_commerce_messages (
      tenant_id, conversation_id, sender, sender_tenant_user_id, body
    )
    VALUES (${tenantId}, ${conversationId}, 'store', ${senderTenantUserId}, ${body})
    RETURNING id, sender, body, created_at
  `) as MessageRow[];
  const message = messageRows[0]!;

  const updatedRows = (await tx`
    UPDATE awcms_commerce_conversations
    SET last_message_at = ${message.created_at}, unread_for_customer = true,
        status = 'open', updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${conversationId}
    RETURNING subject
  `) as { subject: string }[];

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: conversationId,
    message: "Store replied to a conversation.",
    attributes: { senderTenantUserId },
    correlationId
  });

  if (wasClosed) {
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "update",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: conversationId,
      message: "Conversation reopened by a store reply.",
      attributes: { senderTenantUserId, reason: "store_reply" },
      correlationId
    });
  }

  const contact = await fetchAccountContactForConversation(
    tx,
    tenantId,
    conversationId
  );
  if (contact) {
    const storeName = await tenantStoreName(tx, tenantId);
    const publicUrl = conversationStorefrontPublicUrl();
    const link = `${publicUrl}/akun/pesan?id=${conversationId}`;
    const variables = {
      name: contact.name,
      subject: updatedRows[0]?.subject ?? "",
      storeName,
      link
    };
    const emailCorrelationId = correlationId ?? crypto.randomUUID();
    const enqueue = () =>
      enqueueDirectAddressEmail(
        tx,
        tenantId,
        CONVERSATION_REPLY_TEMPLATE_KEY,
        contact.email,
        variables,
        emailCorrelationId
      );

    let result = await enqueue();
    if (!result.enqueued) {
      const seeded = await ensureConversationReplyTemplate(tx, tenantId);
      if (seeded) await enqueue();
    }
  }

  return { kind: "posted", message: toMessageRecord(message) };
}

export type SetConversationStatusOutcome =
  | { kind: "not_found" }
  | { kind: "updated"; conversation: AdminConversationRecord };

/** `PATCH /api/v1/commerce/conversations/{id}` — explicit close/reopen by staff (distinct from the implicit reopen a reply performs). */
export async function setConversationStatus(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  conversationId: string,
  status: "open" | "closed",
  correlationId?: string
): Promise<SetConversationStatusOutcome> {
  const rows = (await tx`
    UPDATE awcms_commerce_conversations
    SET status = ${status}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${conversationId} AND deleted_at IS NULL
    RETURNING id
  `) as { id: string }[];
  if (rows.length === 0) return { kind: "not_found" };

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: conversationId,
    message: `Conversation status set to ${status}.`,
    attributes: { actorTenantUserId, status },
    correlationId
  });

  // A plain re-select, NOT `fetchConversationForAdmin` — that function's own
  // side effect (marking the thread read for the store) must not fire just
  // because staff changed its status without opening the thread.
  const rowsAfter = (await tx`
    SELECT ${tx.unsafe(ADMIN_LIST_COLUMNS)}
    FROM awcms_commerce_conversations c
    JOIN awcms_commerce_customer_accounts a ON a.id = c.account_id AND a.tenant_id = c.tenant_id
    JOIN awcms_commerce_customers cu ON cu.id = a.customer_id AND cu.tenant_id = c.tenant_id
    WHERE c.tenant_id = ${tenantId} AND c.id = ${conversationId}
  `) as ConversationRow[];

  return { kind: "updated", conversation: toAdminRecord(rowsAfter[0]!) };
}
