/**
 * Transactional delivery of commercial documents through the EXISTING outboxes
 * (Issue #295, ADR-0034).
 *
 * ## No third notification subsystem
 *
 * Nothing here talks to a provider, retries, backs off or claims a lease. A
 * delivery request turns one immutable source into ONE row in the outbox that
 * already exists for the channel - `awcms_email_messages` (the `email` module,
 * via `enqueueDirectAddressEmail`) or `awcms_commerce_whatsapp_messages`
 * (`enqueueWhatsappMessage`) - in the caller's own transaction, and records the
 * request in `awcms_commerce_document_deliveries`. The two dispatchers
 * (`bun run email:dispatch`, `bun run commerce:whatsapp:dispatch`) call the
 * provider later, outside any transaction, with their own lease, retry and
 * backoff; this module only READS their rows back (joined on the shared
 * `correlation_id`, which is the delivery id) to show a history.
 *
 * ## The freeze point
 *
 * The message is built from the stored source and nothing else:
 *   - a receipt or invoice: the document's `snapshot`, after its SHA-256 has
 *     been re-verified (a mismatch is `DOCUMENT_INTEGRITY_FAILURE`, audited
 *     `critical`, and nothing is sent);
 *   - a quotation: one append-only VERSION row;
 *   - a work order: the live record, read at the request - it has no immutable
 *     snapshot, so the request is its freeze point and the message states only
 *     status and target date.
 * No live order, price or stock row is read. Editing or even cancelling the
 * order after the document was issued cannot change what a re-send says.
 *
 * ## Idempotency, and a re-send
 *
 * `Idempotency-Key` + a hash bound to the actor and the whole request: a replay
 * returns the stored response WITHOUT enqueueing, so a retried request can never
 * double-send. Concurrent same-key requests race on the idempotency insert; the
 * loser throws, its transaction (enqueue included) rolls back. A new key is an
 * explicit new request - a re-send - and writes a new delivery row pointing at
 * the one it repeats. A rolling-window limit per source bounds a stuck client.
 *
 * ## Recipient
 *
 * Defaults to the customer the SOURCE names (a document's snapshot, a
 * quotation's customer, a work order's customer). Anything else is an
 * override, needs `commerce.document_delivery_overrides.create`, and is stored
 * masked like every other recipient. The walk-in sentinel number is never a
 * recipient. This is a TRANSACTIONAL purpose (the customer asked for the
 * document by buying it): campaigns' marketing-consent predicate does not apply,
 * the e-mail suppression list (bounces, complaints, explicit unsubscribes) does.
 */
import { createHash } from "node:crypto";

import { resolveDeclaredBaseUrl } from "../../../lib/http/site-origin";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import { enqueueDirectAddressEmail } from "../../email/application/direct-address-notification";
import {
  fetchActiveEmailTemplateByKey,
  seedDefaultEmailTemplates
} from "../../email/application/email-template-directory";
import type { DefaultEmailTemplate } from "../../email/domain/email-default-templates";
import { fetchSuppressedRecipientHashes } from "../../email/application/suppression-directory";
import {
  hashIdentifierValue,
  maskIdentifierValue
} from "../../profile-identity/domain/identifier";
import {
  COMMERCE_DOCUMENT_AGGREGATE_TYPE,
  COMMERCE_DOCUMENT_DELIVERY_AGGREGATE_TYPE,
  COMMERCE_DOCUMENT_DELIVERY_REQUESTED_EVENT_TYPE,
  COMMERCE_EVENT_VERSION
} from "../domain/commerce-events";
import {
  buildDocumentLinkUrl,
  buildDocumentMessage,
  buildQuotationVersionMessage,
  buildWorkOrderMessage,
  DELIVERY_HISTORY_LIMIT,
  DELIVERY_RATE_LIMIT_MAX,
  DELIVERY_RATE_LIMIT_WINDOW_MINUTES,
  DOCUMENT_DELIVERY_EMAIL_DEFAULT_TEMPLATE,
  DOCUMENT_DELIVERY_EMAIL_TEMPLATE_KEY,
  DOCUMENT_DELIVERY_TEMPLATE_VERSION,
  DOCUMENT_DELIVERY_WHATSAPP_TEMPLATE_KEY,
  generateDocumentLinkToken,
  hashDocumentLinkToken,
  isLinkExpired,
  normalizeRecipient,
  toEmailVariables,
  type DeliveryChannel,
  type DeliveryFailureReason,
  type DeliveryLocale,
  type DeliveryMessage,
  type DeliveryRecipientSource,
  type DeliveryStatus,
  type DeliveryTargetType,
  type OutboxStatus,
  type RequestDeliveryInput
} from "../domain/document-delivery";
import { contentHash, renderDocument } from "../domain/documents";
import { maskPhone } from "../domain/phone-normalisation";
import { normalizeMoney } from "../domain/price-calculation";
import { isWhatsappChannelEnabled } from "../domain/whatsapp-config";
import { fetchDocument } from "./document-directory";
import { IdempotencyPayloadMismatchError } from "./order-directory";
import { fetchStoreSettings } from "./store-settings-directory";
import { enqueueWhatsappMessage } from "./whatsapp-enqueue";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "document_delivery";
const PRODUCER_MODULE = "commerce";
const DELIVERY_SCOPE = "commerce.document_deliveries.request";
const SEED_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type OutboxState = {
  /** The outbox row's own status; `null` when the row is gone (its retention is shorter than ours) or was never created. */
  status: OutboxStatus | null;
  providerMessageId: string | null;
  retryCount: number;
  /** Already redacted by the dispatcher that wrote it; truncated again here. */
  lastError: string | null;
  sentAt: string | null;
};

export type DeliveryRecord = {
  id: string;
  targetType: DeliveryTargetType;
  targetId: string;
  docNumber: string;
  channel: DeliveryChannel;
  purpose: "transactional";
  recipientSource: DeliveryRecipientSource;
  recipientMasked: string;
  locale: DeliveryLocale;
  templateKey: string;
  templateVersion: number;
  contentHash: string;
  status: DeliveryStatus;
  failureReason: DeliveryFailureReason | null;
  resendOfId: string | null;
  /** `true` when a private link was included; the token itself is never stored in the clear nor returned. */
  hasLink: boolean;
  linkExpiresAt: string | null;
  requestedByTenantUserId: string;
  createdAt: string;
  outbox: OutboxState;
};

type DeliveryRow = {
  id: string;
  target_type: string;
  document_id: string | null;
  quotation_version_id: string | null;
  work_order_id: string | null;
  doc_number: string;
  channel: string;
  recipient_source: string;
  recipient_masked: string;
  locale: string;
  template_key: string;
  template_version: number;
  content_hash: string;
  status: string;
  failure_reason: string | null;
  resend_of_id: string | null;
  link_token_hash: string | null;
  link_expires_at: Date | null;
  requested_by_tenant_user_id: string;
  created_at: Date;
};

const COLUMNS = `id, target_type, document_id, quotation_version_id, work_order_id,
  doc_number, channel, recipient_source, recipient_masked, locale, template_key,
  template_version, content_hash, status, failure_reason, resend_of_id,
  link_token_hash, link_expires_at, requested_by_tenant_user_id, created_at`;

const EMPTY_OUTBOX: OutboxState = {
  status: null,
  providerMessageId: null,
  retryCount: 0,
  lastError: null,
  sentAt: null
};

const MAX_ERROR_LENGTH = 200;

function toRecord(
  row: DeliveryRow,
  targetId: string,
  outbox: OutboxState
): DeliveryRecord {
  return {
    id: row.id,
    targetType: row.target_type as DeliveryTargetType,
    targetId,
    docNumber: row.doc_number,
    channel: row.channel as DeliveryChannel,
    purpose: "transactional",
    recipientSource: row.recipient_source as DeliveryRecipientSource,
    recipientMasked: row.recipient_masked,
    locale: row.locale as DeliveryLocale,
    templateKey: row.template_key,
    templateVersion: Number(row.template_version),
    contentHash: row.content_hash,
    status: row.status as DeliveryStatus,
    failureReason: row.failure_reason as DeliveryFailureReason | null,
    resendOfId: row.resend_of_id,
    hasLink: row.link_token_hash !== null,
    linkExpiresAt: row.link_expires_at
      ? row.link_expires_at.toISOString()
      : null,
    requestedByTenantUserId: row.requested_by_tenant_user_id,
    createdAt: row.created_at.toISOString(),
    outbox
  };
}

function rowTargetId(row: DeliveryRow): string {
  return (row.document_id ?? row.quotation_version_id ?? row.work_order_id)!;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

type Contact = { email: string | null; phone: string | null };

type LoadedSource = {
  /** The id stored in the matching `*_id` column of the delivery row. */
  targetId: string;
  /** Echoed to the caller: the quotation's id for a quotation version (the caller never sees version row ids). */
  publicTargetId: string;
  docNumber: string;
  contact: Contact;
  /** Builds the neutral message, given the locale and an optional private link. */
  build(
    locale: DeliveryLocale,
    link: { url: string; expiresAt: Date } | null
  ): DeliveryMessage;
};

type LoadOutcome =
  | { kind: "ok"; source: LoadedSource }
  | { kind: "not_found" }
  | { kind: "not_deliverable" }
  | { kind: "integrity_failure"; docNumber: string };

async function fetchCustomerContact(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string | null
): Promise<Contact & { name: string | null }> {
  if (!customerId) return { email: null, phone: null, name: null };
  const rows = (await tx`
    SELECT name, phone, email FROM awcms_commerce_customers
    WHERE tenant_id = ${tenantId} AND id = ${customerId} AND deleted_at IS NULL
  `) as { name: string; phone: string; email: string | null }[];
  const row = rows[0];
  return row
    ? { name: row.name, phone: row.phone, email: row.email }
    : { email: null, phone: null, name: null };
}

async function loadSource(
  tx: Bun.SQL,
  tenantId: string,
  input: RequestDeliveryInput
): Promise<LoadOutcome> {
  if (input.targetType === "document") {
    const document = await fetchDocument(tx, tenantId, input.targetId);
    if (!document) return { kind: "not_found" };
    if (contentHash(document.snapshot) !== document.contentHash) {
      return { kind: "integrity_failure", docNumber: document.number };
    }
    const snapshot = document.snapshot;
    return {
      kind: "ok",
      source: {
        targetId: document.id,
        publicTargetId: document.id,
        docNumber: document.number,
        contact: {
          email: snapshot.customer.email,
          phone: snapshot.customer.phone
        },
        build: (locale, link) => buildDocumentMessage(snapshot, locale, link)
      }
    };
  }

  const settings = await fetchStoreSettings(tx, tenantId);

  if (input.targetType === "quotation_version") {
    const rows = (await tx`
      SELECT q.id AS quotation_id, q.number, q.status, q.customer_id,
             v.id AS version_id, v.version, v.valid_until, v.lines, v.subtotal,
             v.discount, v.tax, v.total, v.customer
      FROM awcms_commerce_quotations q
      JOIN awcms_commerce_quotation_versions v
        ON v.tenant_id = q.tenant_id AND v.quotation_id = q.id
       AND v.version = COALESCE(${input.version}::integer, q.current_version)
      WHERE q.tenant_id = ${tenantId} AND q.id = ${input.targetId}
        AND q.deleted_at IS NULL
    `) as {
      quotation_id: string;
      number: string;
      status: string;
      customer_id: string | null;
      version_id: string;
      version: number;
      valid_until: Date;
      lines: {
        name: string | null;
        variantName: string | null;
        quantity: number;
        unitPrice: string;
        lineTotal: string;
      }[];
      subtotal: string;
      discount: string;
      tax: string;
      total: string;
      customer: { name?: string; phone?: string } | null;
    }[];
    const row = rows[0];
    if (!row) return { kind: "not_found" };
    if (row.status === "cancelled") return { kind: "not_deliverable" };
    const account = await fetchCustomerContact(tx, tenantId, row.customer_id);
    const money = (value: string) => normalizeMoney(String(value));
    const version = {
      number: row.number,
      version: Number(row.version),
      validUntil: row.valid_until,
      lines: row.lines,
      subtotal: money(row.subtotal),
      discount: money(row.discount),
      tax: money(row.tax),
      total: money(row.total),
      customerName: row.customer?.name ?? account.name
    };
    return {
      kind: "ok",
      source: {
        targetId: row.version_id,
        publicTargetId: row.quotation_id,
        docNumber: row.number,
        contact: {
          email: account.email,
          phone: row.customer?.phone ?? account.phone
        },
        build: (locale) =>
          buildQuotationVersionMessage(version, settings.storeName, locale)
      }
    };
  }

  const rows = (await tx`
    SELECT id, number, status, customer_id, due_at
    FROM awcms_commerce_work_orders
    WHERE tenant_id = ${tenantId} AND id = ${input.targetId} AND deleted_at IS NULL
  `) as {
    id: string;
    number: string;
    status: string;
    customer_id: string | null;
    due_at: Date | null;
  }[];
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  const account = await fetchCustomerContact(tx, tenantId, row.customer_id);
  const workOrder = {
    number: row.number,
    status: row.status,
    dueAt: row.due_at
  };
  return {
    kind: "ok",
    source: {
      targetId: row.id,
      publicTargetId: row.id,
      docNumber: row.number,
      contact: { email: account.email, phone: account.phone },
      build: (locale) =>
        buildWorkOrderMessage(workOrder, settings.storeName, locale)
    }
  };
}

const TARGET_COLUMN: Record<DeliveryTargetType, string> = {
  document: "document_id",
  quotation_version: "quotation_version_id",
  work_order: "work_order_id"
};

// ---------------------------------------------------------------------------
// Channel availability
// ---------------------------------------------------------------------------

/** Whether the channel's dispatcher would ever send what we enqueue (the same gates the dispatchers use). */
export function isDeliveryChannelEnabled(
  channel: DeliveryChannel,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return channel === "whatsapp"
    ? isWhatsappChannelEnabled(env)
    : env.EMAIL_ENABLED === "true";
}

function resolveLinkBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COMMERCE_DOCUMENT_LINK_BASE_URL?.trim();
  return override && override.length > 0
    ? override
    : resolveDeclaredBaseUrl(env);
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type RequestDeliveryContext = {
  tenantId: string;
  actorTenantUserId: string;
  /** Whether the caller holds `commerce.document_delivery_overrides.create`; only consulted when the input names a recipient. */
  overrideAllowed: boolean;
  now?: Date;
  correlationId?: string;
  env?: NodeJS.ProcessEnv;
};

export type DeniedReason =
  | "OVERRIDE_FORBIDDEN"
  | "CHANNEL_UNAVAILABLE"
  | "RECIPIENT_UNAVAILABLE"
  | "SOURCE_NOT_DELIVERABLE"
  | "DELIVERY_RATE_LIMITED"
  | "DOCUMENT_INTEGRITY_FAILURE";

export type RequestDeliveryOutcome =
  | { kind: "not_found" }
  | { kind: "denied"; reason: DeniedReason }
  | { kind: "not_enqueued"; delivery: DeliveryRecord }
  | { kind: "queued" | "replayed"; delivery: DeliveryRecord };

async function audit(
  tx: Bun.SQL,
  context: RequestDeliveryContext,
  action: string,
  message: string,
  attributes: Record<string, unknown>,
  resourceId?: string,
  severity: "info" | "warning" | "critical" = "info"
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId: context.tenantId,
    actorTenantUserId: context.actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId,
    severity,
    message,
    attributes,
    correlationId: context.correlationId
  });
}

async function deny(
  tx: Bun.SQL,
  context: RequestDeliveryContext,
  input: RequestDeliveryInput,
  reason: DeniedReason,
  docNumber: string | null = null
): Promise<RequestDeliveryOutcome> {
  await audit(
    tx,
    context,
    "document_delivery.denied",
    `Delivery of ${input.targetType} ${docNumber ?? input.targetId} by ${input.channel} was refused: ${reason}.`,
    {
      reason,
      targetType: input.targetType,
      targetId: input.targetId,
      docNumber,
      channel: input.channel
    },
    undefined,
    reason === "DOCUMENT_INTEGRITY_FAILURE" ? "critical" : "warning"
  );
  return { kind: "denied", reason };
}

async function ensureTransactionalEmailTemplate(
  tx: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  const existing = await fetchActiveEmailTemplateByKey(
    tx,
    tenantId,
    DOCUMENT_DELIVERY_EMAIL_TEMPLATE_KEY
  );
  if (existing) return true;
  const template: DefaultEmailTemplate = {
    templateKey: DOCUMENT_DELIVERY_EMAIL_TEMPLATE_KEY,
    name: DOCUMENT_DELIVERY_EMAIL_DEFAULT_TEMPLATE.name,
    subjectTemplate: { ...DOCUMENT_DELIVERY_EMAIL_DEFAULT_TEMPLATE.subject },
    textBodyTemplate: { ...DOCUMENT_DELIVERY_EMAIL_DEFAULT_TEMPLATE.textBody }
  };
  await seedDefaultEmailTemplates(tx, tenantId, SEED_ACTOR_ID, [template]);
  return (
    (await fetchActiveEmailTemplateByKey(
      tx,
      tenantId,
      DOCUMENT_DELIVERY_EMAIL_TEMPLATE_KEY
    )) !== null
  );
}

type EnqueueOutcome =
  { enqueued: true } | { enqueued: false; reason: DeliveryFailureReason };

async function enqueueEmail(
  tx: Bun.SQL,
  tenantId: string,
  address: string,
  message: DeliveryMessage,
  correlationId: string,
  locale: DeliveryLocale
): Promise<EnqueueOutcome> {
  const variables = toEmailVariables(message.variables);
  const attempt = () =>
    enqueueDirectAddressEmail(
      tx,
      tenantId,
      DOCUMENT_DELIVERY_EMAIL_TEMPLATE_KEY,
      address,
      variables,
      correlationId,
      locale
    );
  let result = await attempt();
  if (!result.enqueued) {
    // Either the tenant has no template yet (seed it, try once more) or the
    // address is suppressed (a retry cannot help). Telling them apart: after a
    // successful seed, a second miss can only be the suppression list.
    const seeded = await ensureTransactionalEmailTemplate(tx, tenantId);
    if (!seeded) return { enqueued: false, reason: "TEMPLATE_UNAVAILABLE" };
    result = await attempt();
    if (!result.enqueued) {
      const suppressed = await fetchSuppressedRecipientHashes(tx, tenantId);
      return {
        enqueued: false,
        reason: suppressed.has(hashIdentifierValue(address))
          ? "RECIPIENT_SUPPRESSED"
          : "TEMPLATE_UNAVAILABLE"
      };
    }
  }
  return { enqueued: true };
}

export async function requestDocumentDelivery(
  tx: Bun.SQL,
  context: RequestDeliveryContext,
  input: RequestDeliveryInput
): Promise<RequestDeliveryOutcome> {
  const { tenantId, actorTenantUserId } = context;
  const now = context.now ?? new Date();
  const env = context.env ?? process.env;

  // 1. A replay answers from the store and enqueues NOTHING. The request hash
  //    binds the actor and every field that changes what would be sent.
  const requestHash = computeRequestHash({
    action: DELIVERY_SCOPE,
    actorTenantUserId,
    targetType: input.targetType,
    targetId: input.targetId,
    version: input.version,
    channel: input.channel,
    locale: input.locale,
    recipient:
      input.recipientOverride === null
        ? null
        : createHash("sha256").update(input.recipientOverride).digest("hex"),
    includeLink: input.includeLink,
    linkTtlHours: input.includeLink ? input.linkTtlHours : null
  });
  const stored = await findIdempotencyRecord(
    tx,
    tenantId,
    DELIVERY_SCOPE,
    input.idempotencyKey
  );
  if (stored) {
    if (stored.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      delivery: stored.responseBody as DeliveryRecord
    };
  }

  // 2. The override is the exfiltration path: refused BEFORE the source is
  //    even read, so a caller without the key learns nothing about whether the
  //    id exists.
  if (input.recipientOverride !== null && !context.overrideAllowed) {
    return deny(tx, context, input, "OVERRIDE_FORBIDDEN");
  }

  // 3. The source: an unknown id and another tenant's id are the same answer.
  const loaded = await loadSource(tx, tenantId, input);
  if (loaded.kind === "not_found") return { kind: "not_found" };
  if (loaded.kind === "integrity_failure") {
    return deny(
      tx,
      context,
      input,
      "DOCUMENT_INTEGRITY_FAILURE",
      loaded.docNumber
    );
  }
  if (loaded.kind === "not_deliverable") {
    return deny(tx, context, input, "SOURCE_NOT_DELIVERABLE");
  }
  const { source } = loaded;

  // 4. The channel must be one a dispatcher will actually service.
  if (!isDeliveryChannelEnabled(input.channel, env)) {
    return deny(tx, context, input, "CHANNEL_UNAVAILABLE", source.docNumber);
  }

  // 5. The recipient: the override, else what the source itself names.
  const recipientSource: DeliveryRecipientSource =
    input.recipientOverride === null ? "source_customer" : "override";
  const recipient =
    input.recipientOverride ??
    normalizeRecipient(
      input.channel,
      (input.channel === "email"
        ? source.contact.email
        : source.contact.phone) ?? ""
    );
  if (!recipient) {
    return deny(tx, context, input, "RECIPIENT_UNAVAILABLE", source.docNumber);
  }

  // 6. A rolling-window bound per source.
  const column = TARGET_COLUMN[input.targetType];
  const since = new Date(
    now.getTime() - DELIVERY_RATE_LIMIT_WINDOW_MINUTES * 60_000
  );
  const recent = (await tx`
    SELECT count(*)::int AS n, (array_agg(id ORDER BY created_at DESC, id DESC))[1] AS last_id
    FROM awcms_commerce_document_deliveries
    WHERE tenant_id = ${tenantId}
      AND ${tx.unsafe(column)} = ${source.targetId}
      AND created_at > ${since}
  `) as { n: number; last_id: string | null }[];
  if (Number(recent[0]!.n) >= DELIVERY_RATE_LIMIT_MAX) {
    return deny(tx, context, input, "DELIVERY_RATE_LIMITED", source.docNumber);
  }
  const previous = (await tx`
    SELECT id FROM awcms_commerce_document_deliveries
    WHERE tenant_id = ${tenantId}
      AND ${tx.unsafe(column)} = ${source.targetId}
      AND channel = ${input.channel}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `) as { id: string }[];

  // 7. Build, enqueue, record. The id is chosen first because the outbox row
  //    must carry it as its correlation id.
  const deliveryId = crypto.randomUUID();
  let link: { url: string; expiresAt: Date; hash: string } | null = null;
  if (input.includeLink) {
    const token = generateDocumentLinkToken();
    const expiresAt = new Date(now.getTime() + input.linkTtlHours * 3_600_000);
    link = {
      url: buildDocumentLinkUrl(resolveLinkBaseUrl(env), token),
      expiresAt,
      hash: hashDocumentLinkToken(token)
    };
  }
  const message = source.build(
    input.locale,
    link ? { url: link.url, expiresAt: link.expiresAt } : null
  );

  let enqueue: EnqueueOutcome;
  const recipientMasked =
    input.channel === "whatsapp"
      ? maskPhone(recipient)
      : maskIdentifierValue(recipient, "email");
  let templateKey: string;
  if (input.channel === "email") {
    templateKey = DOCUMENT_DELIVERY_EMAIL_TEMPLATE_KEY;
    enqueue = await enqueueEmail(
      tx,
      tenantId,
      recipient,
      message,
      deliveryId,
      input.locale
    );
  } else {
    templateKey = DOCUMENT_DELIVERY_WHATSAPP_TEMPLATE_KEY;
    await enqueueWhatsappMessage(tx, {
      tenantId,
      toPhone: recipient,
      templateKey: DOCUMENT_DELIVERY_WHATSAPP_TEMPLATE_KEY,
      variables: message.variables,
      correlationId: deliveryId
    });
    enqueue = { enqueued: true };
  }

  const status: DeliveryStatus = enqueue.enqueued ? "queued" : "not_enqueued";
  const failureReason = enqueue.enqueued ? null : enqueue.reason;
  // The link only exists if the message that carries it was enqueued.
  const storedLink = enqueue.enqueued ? link : null;

  const rows = (await tx`
    INSERT INTO awcms_commerce_document_deliveries (
      id, tenant_id, target_type, ${tx.unsafe(column)}, doc_number, channel,
      recipient_source, recipient_masked, locale, template_key, template_version,
      content_hash, status, failure_reason, resend_of_id, link_token_hash,
      link_expires_at, requested_by_tenant_user_id, created_at
    )
    VALUES (
      ${deliveryId}, ${tenantId}, ${input.targetType}, ${source.targetId},
      ${source.docNumber}, ${input.channel}, ${recipientSource}, ${recipientMasked},
      ${input.locale}, ${templateKey}, ${DOCUMENT_DELIVERY_TEMPLATE_VERSION},
      ${message.contentHash}, ${status}, ${failureReason},
      ${previous[0]?.id ?? null}, ${storedLink ? storedLink.hash : null},
      ${storedLink ? storedLink.expiresAt : null}, ${actorTenantUserId}, ${now}
    )
    RETURNING ${tx.unsafe(COLUMNS)}
  `) as DeliveryRow[];
  const delivery = toRecord(
    rows[0]!,
    source.publicTargetId,
    enqueue.enqueued ? { ...EMPTY_OUTBOX, status: "queued" } : EMPTY_OUTBOX
  );

  await audit(
    tx,
    context,
    enqueue.enqueued ? "document_delivery.request" : "document_delivery.denied",
    enqueue.enqueued
      ? `${input.targetType} ${source.docNumber} queued for delivery by ${input.channel} to ${recipientMasked}.`
      : `Delivery of ${input.targetType} ${source.docNumber} by ${input.channel} was not enqueued: ${failureReason}.`,
    {
      deliveryId,
      targetType: input.targetType,
      targetId: source.publicTargetId,
      docNumber: source.docNumber,
      channel: input.channel,
      recipientSource,
      recipientMasked,
      status,
      reason: failureReason,
      templateVersion: DOCUMENT_DELIVERY_TEMPLATE_VERSION,
      contentHash: message.contentHash,
      withLink: storedLink !== null
    },
    deliveryId,
    enqueue.enqueued ? "info" : "warning"
  );
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_DOCUMENT_DELIVERY_REQUESTED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_DOCUMENT_DELIVERY_AGGREGATE_TYPE,
    aggregateId: deliveryId,
    producerModule: PRODUCER_MODULE,
    correlationId: context.correlationId,
    actorTenantUserId,
    payload: {
      deliveryId,
      targetType: input.targetType,
      targetId: source.publicTargetId,
      docNumber: source.docNumber,
      channel: input.channel,
      status,
      failureReason
    }
  });

  if (!enqueue.enqueued) {
    // Not stored under the key: once the address is un-suppressed, the same
    // request must be able to succeed.
    return { kind: "not_enqueued", delivery };
  }
  await saveIdempotencyRecord(
    tx,
    tenantId,
    DELIVERY_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    delivery
  );
  return { kind: "queued", delivery };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type DeliveryHistoryFilter = {
  targetType: DeliveryTargetType;
  /** The source id as the caller knows it (a quotation's id for a quotation version). */
  targetId: string;
};

export async function listDocumentDeliveries(
  tx: Bun.SQL,
  tenantId: string,
  filter: DeliveryHistoryFilter
): Promise<DeliveryRecord[]> {
  let rows: DeliveryRow[];
  if (filter.targetType === "quotation_version") {
    // Every version of the quotation: a revision is a new version, and the
    // history of "what did we send this customer" spans them all.
    rows = (await tx`
      SELECT ${tx.unsafe(COLUMNS)}
      FROM awcms_commerce_document_deliveries
      WHERE tenant_id = ${tenantId}
        AND quotation_version_id IN (
          SELECT id FROM awcms_commerce_quotation_versions
          WHERE tenant_id = ${tenantId} AND quotation_id = ${filter.targetId}
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ${DELIVERY_HISTORY_LIMIT}
    `) as DeliveryRow[];
  } else {
    const column = TARGET_COLUMN[filter.targetType];
    rows = (await tx`
      SELECT ${tx.unsafe(COLUMNS)}
      FROM awcms_commerce_document_deliveries
      WHERE tenant_id = ${tenantId} AND ${tx.unsafe(column)} = ${filter.targetId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${DELIVERY_HISTORY_LIMIT}
    `) as DeliveryRow[];
  }
  if (rows.length === 0) return [];

  const outbox = await readOutboxStates(tx, tenantId, rows);
  return rows.map((row) =>
    toRecord(
      row,
      filter.targetType === "quotation_version"
        ? filter.targetId
        : rowTargetId(row),
      outbox.get(row.id) ?? EMPTY_OUTBOX
    )
  );
}

function truncate(value: string | null): string | null {
  if (value === null) return null;
  return value.length > MAX_ERROR_LENGTH
    ? `${value.slice(0, MAX_ERROR_LENGTH)}...`
    : value;
}

/** Live outbox status per delivery, read from the two outboxes by the shared correlation id. Never written here. */
async function readOutboxStates(
  tx: Bun.SQL,
  tenantId: string,
  rows: DeliveryRow[]
): Promise<Map<string, OutboxState>> {
  const result = new Map<string, OutboxState>();
  const emailIds = rows.filter((r) => r.channel === "email").map((r) => r.id);
  const whatsappIds = rows
    .filter((r) => r.channel === "whatsapp")
    .map((r) => r.id);

  if (emailIds.length > 0) {
    const found = (await tx`
      SELECT correlation_id, status, provider_message_id, retry_count, last_error, sent_at
      FROM awcms_email_messages
      WHERE tenant_id = ${tenantId}
        AND category = ${DOCUMENT_DELIVERY_EMAIL_TEMPLATE_KEY}
        AND correlation_id = ANY(${tx.array(emailIds, "text")}::text[])
    `) as {
      correlation_id: string;
      status: string;
      provider_message_id: string | null;
      retry_count: number;
      last_error: string | null;
      sent_at: Date | null;
    }[];
    for (const row of found) {
      result.set(row.correlation_id, {
        status: row.status as OutboxStatus,
        providerMessageId: row.provider_message_id,
        retryCount: Number(row.retry_count),
        lastError: truncate(row.last_error),
        sentAt: row.sent_at ? row.sent_at.toISOString() : null
      });
    }
  }
  if (whatsappIds.length > 0) {
    const found = (await tx`
      SELECT correlation_id, status, provider_ref, attempts, last_error, sent_at
      FROM awcms_commerce_whatsapp_messages
      WHERE tenant_id = ${tenantId}
        AND correlation_id = ANY(${tx.array(whatsappIds, "text")}::text[])
    `) as {
      correlation_id: string;
      status: string;
      provider_ref: string | null;
      attempts: number;
      last_error: string | null;
      sent_at: Date | null;
    }[];
    for (const row of found) {
      result.set(row.correlation_id, {
        status: row.status as OutboxStatus,
        providerMessageId: row.provider_ref,
        // Both dispatchers count FAILED attempts only (a success never bumps
        // the counter), so `attempts` here and `retry_count` above mean the same.
        retryCount: Number(row.attempts),
        lastError: truncate(row.last_error),
        sentAt: row.sent_at ? row.sent_at.toISOString() : null
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The private link
// ---------------------------------------------------------------------------

export type ResolveLinkOutcome =
  | { kind: "not_found" }
  | { kind: "expired" }
  | { kind: "integrity_failure" }
  | { kind: "ok"; html: string };

/**
 * Resolves an opaque link token to the document's print page. The token is
 * looked up by its SHA-256; an unknown token is `not_found`, a known one past
 * its expiry is `expired`. The rendering is the stored snapshot's, hash
 * re-verified first - the same render contract the staff screen prints from -
 * and the open is audited (no actor, no recipient).
 */
export async function resolveDocumentLink(
  tx: Bun.SQL,
  tenantId: string,
  tokenHash: string,
  now: Date = new Date(),
  correlationId?: string
): Promise<ResolveLinkOutcome> {
  const rows = (await tx`
    SELECT id, document_id, doc_number, locale, link_expires_at
    FROM awcms_commerce_document_deliveries
    WHERE tenant_id = ${tenantId} AND link_token_hash = ${tokenHash}
  `) as {
    id: string;
    document_id: string | null;
    doc_number: string;
    locale: string;
    link_expires_at: Date | null;
  }[];
  const row = rows[0];
  if (!row || !row.document_id || !row.link_expires_at) {
    return { kind: "not_found" };
  }
  if (isLinkExpired(row.link_expires_at, now)) {
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "document_delivery.link_expired",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: row.id,
      severity: "warning",
      message: `An expired private link for ${row.doc_number} was opened.`,
      attributes: { deliveryId: row.id, docNumber: row.doc_number },
      correlationId
    });
    return { kind: "expired" };
  }
  const document = await fetchDocument(tx, tenantId, row.document_id);
  if (!document || contentHash(document.snapshot) !== document.contentHash) {
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "document.integrity_failure",
      resourceType: COMMERCE_DOCUMENT_AGGREGATE_TYPE,
      resourceId: row.document_id,
      severity: "critical",
      message: `Document ${row.doc_number} no longer matches its content hash.`,
      attributes: { number: row.doc_number },
      correlationId
    });
    return { kind: "integrity_failure" };
  }
  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "document_delivery.link_opened",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: row.id,
    message: `The private link for ${row.doc_number} was opened.`,
    attributes: { deliveryId: row.id, docNumber: row.doc_number },
    correlationId
  });
  return {
    kind: "ok",
    html: renderDocument(
      document.snapshot,
      "html",
      row.locale === "en" ? "en" : "id"
    )
  };
}
