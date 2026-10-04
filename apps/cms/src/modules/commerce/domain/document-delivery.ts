/**
 * Transactional delivery of commercial documents - the pure half (Issue #295,
 * ADR-0034). No database, no I/O beyond the platform CSPRNG.
 *
 * ## What lives here
 *
 * - the vocabulary (targets, channels, locales, failure reasons) and the
 *   request validator;
 * - the VERSIONED template contract: one e-mail template key
 *   (`derived.commerce_document`) and one WhatsApp template key
 *   (`commerce.document`), each with the same closed variable list and a
 *   `DOCUMENT_DELIVERY_TEMPLATE_VERSION` that is recorded on every delivery row.
 *   A change to the variable list or to the default wording bumps the version
 *   in the same change, so a delivery row always says which contract produced it;
 * - three message builders, one per target type. Each takes ONLY a frozen
 *   source (a stored document snapshot, a stored quotation version, a work
 *   order read at request time) and returns the variables the outbox will carry.
 *   Nothing here can see a live order: an order edited after the document was
 *   issued cannot change a message, because the order is not an input;
 * - the opaque private-link token (`dl_…`, SHA-256 at rest, hard expiry).
 *
 * ## Money
 *
 * Every amount is a `numeric(14,2)` STRING (ADR-0003), copied verbatim from the
 * stored snapshot. Nothing here parses or recomputes one, so a receipt's total
 * in a message is byte-for-byte the total of the document.
 */
import { createHash, randomBytes } from "node:crypto";

import {
  normalizePhoneNumber,
  POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
} from "./phone-normalisation";
import {
  isRecord,
  validateIdempotencyKey,
  type ValidationError
} from "./payment-allocation";
import {
  canonicalJson,
  isUuid,
  renderDocumentText,
  type DocumentRenderLocale,
  type DocumentSnapshot
} from "./documents";
import { resolveSalesReportDay } from "./sales-report-deltas";

type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const DELIVERY_TARGET_TYPES = [
  "document",
  "quotation_version",
  "work_order"
] as const;
export type DeliveryTargetType = (typeof DELIVERY_TARGET_TYPES)[number];

export const DELIVERY_CHANNELS = ["email", "whatsapp"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

export const DELIVERY_LOCALES = ["id", "en"] as const;
export type DeliveryLocale = DocumentRenderLocale;

/** Hand-off outcomes recorded on the delivery row; what happens after lives in the outbox. */
export const DELIVERY_STATUSES = ["queued", "not_enqueued"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_FAILURE_REASONS = [
  "RECIPIENT_SUPPRESSED",
  "TEMPLATE_UNAVAILABLE"
] as const;
export type DeliveryFailureReason = (typeof DELIVERY_FAILURE_REASONS)[number];

export const DELIVERY_RECIPIENT_SOURCES = [
  "source_customer",
  "override"
] as const;
export type DeliveryRecipientSource =
  (typeof DELIVERY_RECIPIENT_SOURCES)[number];

/** The outbox statuses a history entry can report (the union of both outboxes'). */
export const OUTBOX_STATUSES = [
  "queued",
  "sending",
  "sent",
  "failed",
  "retry_wait",
  "cancelled",
  "suppressed"
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

// ---------------------------------------------------------------------------
// The versioned template contract
// ---------------------------------------------------------------------------

/**
 * Bump when the variable list or the default wording changes. Recorded on each
 * delivery row (`template_version`), so history shows which contract rendered it.
 */
export const DOCUMENT_DELIVERY_TEMPLATE_VERSION = 1;

/**
 * The e-mail leg rides the `email` module's BASE extension category
 * `derived.transactional` (variables `userName`, `subject`, `body`,
 * `actionUrl` - `email-template-categories.ts`) rather than a registered
 * `derived.commerce_*` one. A derived category only exists in a process that
 * imported the module registering it, and `bun run email:dispatch` is a
 * separate process that imports no commerce code: with a derived category the
 * dispatcher would filter every variable out and send an empty body
 * (ADR-0034 D3). A base category is registered in every process.
 */
export const DOCUMENT_DELIVERY_EMAIL_TEMPLATE_KEY = "derived.transactional";
export const DOCUMENT_DELIVERY_WHATSAPP_TEMPLATE_KEY = "commerce.document";

/**
 * The neutral message variables every builder returns; each channel maps them
 * onto its own template. `body` is the plain-text rendering of the frozen
 * source; `link` is either empty or one finished line (label, URL, expiry) so
 * neither template has to branch on its presence.
 */
export const DOCUMENT_DELIVERY_TEMPLATE_VARIABLES = [
  "documentLabel",
  "documentNumber",
  "storeName",
  "body",
  "link"
] as const;

/** What `derived.transactional` receives. `actionUrl` carries the finished link line (or an empty string). */
export const DOCUMENT_DELIVERY_EMAIL_VARIABLES = [
  "subject",
  "body",
  "actionUrl"
] as const;

export const DOCUMENT_DELIVERY_EMAIL_DEFAULT_TEMPLATE = {
  name: "Transactional message",
  subject: { en: "{{subject}}", id: "{{subject}}" },
  textBody: {
    en: "{{body}}\n\n{{actionUrl}}",
    id: "{{body}}\n\n{{actionUrl}}"
  }
} as const;

export const DOCUMENT_DELIVERY_WHATSAPP_BODY =
  "{{documentLabel}} {{documentNumber}}\n\n{{body}}\n\n{{link}}\n{{storeName}}";

/** Maps the neutral variables onto `derived.transactional`'s. */
export function toEmailVariables(
  variables: Record<string, string>
): Record<string, string> {
  return {
    subject: `${variables.documentLabel} ${variables.documentNumber} - ${variables.storeName}`,
    body: variables.body ?? "",
    actionUrl: variables.link ?? ""
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const DEFAULT_LINK_TTL_HOURS = 72;
/** Mirrors the `link_expires_at <= created_at + 168 hours` CHECK of `sql/965`. */
export const MAX_LINK_TTL_HOURS = 168;
/** At most this many delivery requests per source per rolling window (any channel, any recipient). */
export const DELIVERY_RATE_LIMIT_MAX = 5;
export const DELIVERY_RATE_LIMIT_WINDOW_MINUTES = 60;
export const DELIVERY_HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export type RequestDeliveryInput = {
  idempotencyKey: string;
  targetType: DeliveryTargetType;
  /** A document id, a quotation id (see `version`) or a work-order id. */
  targetId: string;
  /** Quotation only: which version to send; `null` means the current one. */
  version: number | null;
  channel: DeliveryChannel;
  locale: DeliveryLocale;
  /** A normalised address/number the caller typed, or `null` to use the source's own customer. */
  recipientOverride: string | null;
  includeLink: boolean;
  linkTtlHours: number;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

export function validateRequestDeliveryInput(
  body: unknown,
  idempotencyKey: string
): ValidationResult<RequestDeliveryInput> {
  const record = isRecord(body) ? body : {};
  const errors: ValidationError[] = [];
  const key = validateIdempotencyKey(idempotencyKey, errors);

  if (
    !(DELIVERY_TARGET_TYPES as readonly unknown[]).includes(record.targetType)
  ) {
    errors.push({
      field: "targetType",
      message: `targetType must be one of: ${DELIVERY_TARGET_TYPES.join(", ")}.`
    });
  }
  if (!isUuid(record.targetId)) {
    errors.push({ field: "targetId", message: "targetId must be a UUID." });
  }
  if (!(DELIVERY_CHANNELS as readonly unknown[]).includes(record.channel)) {
    errors.push({
      field: "channel",
      message: `channel must be one of: ${DELIVERY_CHANNELS.join(", ")}.`
    });
  }
  let locale: DeliveryLocale = "id";
  if (record.locale !== undefined && record.locale !== null) {
    if (!(DELIVERY_LOCALES as readonly unknown[]).includes(record.locale)) {
      errors.push({
        field: "locale",
        message: `locale must be one of: ${DELIVERY_LOCALES.join(", ")}.`
      });
    } else {
      locale = record.locale as DeliveryLocale;
    }
  }

  let recipientOverride: string | null = null;
  if (record.recipient !== undefined && record.recipient !== null) {
    if (typeof record.recipient !== "string") {
      errors.push({
        field: "recipient",
        message: "recipient must be a string, or omitted."
      });
    } else if (record.recipient.trim().length > 0) {
      const normalised = normalizeRecipient(
        record.channel as DeliveryChannel,
        record.recipient
      );
      if (normalised === null) {
        errors.push({
          field: "recipient",
          message:
            record.channel === "whatsapp"
              ? "recipient must be a valid phone number."
              : "recipient must be a valid e-mail address."
        });
      } else {
        recipientOverride = normalised;
      }
    }
  }

  let version: number | null = null;
  if (record.version !== undefined && record.version !== null) {
    if (record.targetType !== "quotation_version") {
      errors.push({
        field: "version",
        message: "version applies to a quotation_version target only."
      });
    } else if (
      typeof record.version !== "number" ||
      !Number.isInteger(record.version) ||
      record.version < 1 ||
      record.version > 1000
    ) {
      errors.push({
        field: "version",
        message: "version must be a whole number of at least 1."
      });
    } else {
      version = record.version;
    }
  }

  let includeLink = false;
  if (record.includeLink !== undefined && record.includeLink !== null) {
    if (typeof record.includeLink !== "boolean") {
      errors.push({
        field: "includeLink",
        message: "includeLink must be a boolean."
      });
    } else {
      includeLink = record.includeLink;
    }
  }
  if (includeLink && record.targetType !== "document") {
    errors.push({
      field: "includeLink",
      message:
        "A private link is only available for a receipt or invoice document."
    });
  }

  let linkTtlHours = DEFAULT_LINK_TTL_HOURS;
  if (record.linkTtlHours !== undefined && record.linkTtlHours !== null) {
    if (
      typeof record.linkTtlHours !== "number" ||
      !Number.isInteger(record.linkTtlHours) ||
      record.linkTtlHours < 1 ||
      record.linkTtlHours > MAX_LINK_TTL_HOURS
    ) {
      errors.push({
        field: "linkTtlHours",
        message: `linkTtlHours must be a whole number between 1 and ${MAX_LINK_TTL_HOURS}.`
      });
    } else {
      linkTtlHours = record.linkTtlHours;
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    value: {
      idempotencyKey: key,
      targetType: record.targetType as DeliveryTargetType,
      targetId: record.targetId as string,
      channel: record.channel as DeliveryChannel,
      locale,
      recipientOverride,
      version,
      includeLink,
      linkTtlHours
    }
  };
}

/** Lower-cased address / E.164 number, or `null` when the value is not a usable recipient for the channel. */
export function normalizeRecipient(
  channel: DeliveryChannel,
  raw: string
): string | null {
  const value = raw.trim();
  if (channel === "whatsapp") {
    const phone = normalizePhoneNumber(value);
    if (!phone.valid) return null;
    return phone.value === POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
      ? null
      : phone.value;
  }
  if (value.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type DeliveryMessage = {
  /** The variables the outbox carries: exactly {@link DOCUMENT_DELIVERY_TEMPLATE_VARIABLES}. */
  variables: Record<string, string>;
  /** SHA-256 of {@link canonicalJson} over `variables` - two sends of one source are provably identical. */
  contentHash: string;
};

const DOCUMENT_LABELS: Record<
  DeliveryLocale,
  Record<"receipt" | "invoice" | "quotation" | "work_order", string>
> = {
  id: {
    receipt: "Struk pembayaran",
    invoice: "Faktur penjualan",
    quotation: "Penawaran",
    work_order: "Perintah kerja"
  },
  en: {
    receipt: "Payment receipt",
    invoice: "Sales invoice",
    quotation: "Quotation",
    work_order: "Work order"
  }
};

const LINK_TEXT: Record<
  DeliveryLocale,
  (url: string, until: string) => string
> = {
  id: (url, until) => `Buka dokumen (berlaku sampai ${until}): ${url}`,
  en: (url, until) => `Open the document (valid until ${until}): ${url}`
};

export type LinkLine = { url: string; expiresAt: Date };

function linkLine(locale: DeliveryLocale, link: LinkLine | null): string {
  return link
    ? LINK_TEXT[locale](link.url, resolveSalesReportDay(link.expiresAt))
    : "";
}

function finish(variables: Record<string, string>): DeliveryMessage {
  return {
    variables,
    contentHash: createHash("sha256")
      .update(canonicalJson(variables))
      .digest("hex")
  };
}

/** A receipt or invoice, from its STORED snapshot only. */
export function buildDocumentMessage(
  snapshot: DocumentSnapshot,
  locale: DeliveryLocale,
  link: LinkLine | null
): DeliveryMessage {
  return finish({
    documentLabel: DOCUMENT_LABELS[locale][snapshot.docType],
    documentNumber: snapshot.number,
    storeName: snapshot.seller.name,
    body: renderDocumentText(snapshot, locale).trimEnd(),
    link: linkLine(locale, link)
  });
}

export type QuotationVersionSource = {
  number: string;
  version: number;
  validUntil: Date;
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
  customerName: string | null;
};

const QUOTATION_TEXT: Record<
  DeliveryLocale,
  {
    version: string;
    validUntil: string;
    customer: string;
    subtotal: string;
    discount: string;
    tax: string;
    total: string;
    fallbackItem: string;
  }
> = {
  id: {
    version: "Versi",
    validUntil: "Berlaku sampai",
    customer: "Kepada",
    subtotal: "Subtotal",
    discount: "Diskon",
    tax: "Pajak",
    total: "Total",
    fallbackItem: "Barang"
  },
  en: {
    version: "Version",
    validUntil: "Valid until",
    customer: "To",
    subtotal: "Subtotal",
    discount: "Discount",
    tax: "Tax",
    total: "Total",
    fallbackItem: "Item"
  }
};

/** A quotation VERSION (append-only), from the stored version row. */
export function buildQuotationVersionMessage(
  source: QuotationVersionSource,
  storeName: string,
  locale: DeliveryLocale
): DeliveryMessage {
  const t = QUOTATION_TEXT[locale];
  const out: string[] = [];
  out.push(`${t.version}: ${source.version}`);
  out.push(`${t.validUntil}: ${resolveSalesReportDay(source.validUntil)}`);
  if (source.customerName) out.push(`${t.customer}: ${source.customerName}`);
  out.push("-".repeat(30));
  for (const line of source.lines) {
    const name = line.name ?? t.fallbackItem;
    out.push(line.variantName ? `${name} (${line.variantName})` : name);
    out.push(`  ${line.quantity} x ${line.unitPrice} = ${line.lineTotal}`);
  }
  out.push("-".repeat(30));
  out.push(`${t.subtotal}: ${source.subtotal}`);
  if (source.discount !== "0.00")
    out.push(`${t.discount}: -${source.discount}`);
  if (source.tax !== "0.00") out.push(`${t.tax}: ${source.tax}`);
  out.push(`${t.total}: ${source.total}`);
  return finish({
    documentLabel: DOCUMENT_LABELS[locale].quotation,
    documentNumber: source.number,
    storeName,
    body: out.join("\n"),
    link: ""
  });
}

export type WorkOrderSource = {
  number: string;
  status: string;
  dueAt: Date | null;
};

const WORK_ORDER_STATUS_LABELS: Record<
  DeliveryLocale,
  Record<string, string>
> = {
  id: {
    received: "Diterima",
    scheduled: "Dijadwalkan",
    in_progress: "Sedang dikerjakan",
    on_hold: "Ditunda",
    ready: "Siap diambil",
    completed: "Selesai",
    cancelled: "Dibatalkan"
  },
  en: {
    received: "Received",
    scheduled: "Scheduled",
    in_progress: "In progress",
    on_hold: "On hold",
    ready: "Ready",
    completed: "Completed",
    cancelled: "Cancelled"
  }
};

/**
 * A work-order status notice. A work order is a LIVE record, so the freeze
 * point is the request: the message states the status at that moment. It
 * deliberately carries no title, description, note or assignee - free text a
 * staff member wrote for staff, which is not the customer's to receive by default.
 */
export function buildWorkOrderMessage(
  source: WorkOrderSource,
  storeName: string,
  locale: DeliveryLocale
): DeliveryMessage {
  const status =
    WORK_ORDER_STATUS_LABELS[locale][source.status] ?? source.status;
  const lines = [`Status: ${status}`];
  if (source.dueAt) {
    lines.push(
      `${locale === "id" ? "Target selesai" : "Target date"}: ${resolveSalesReportDay(source.dueAt)}`
    );
  }
  return finish({
    documentLabel: DOCUMENT_LABELS[locale].work_order,
    documentNumber: source.number,
    storeName,
    body: lines.join("\n"),
    link: ""
  });
}

// ---------------------------------------------------------------------------
// The private link
// ---------------------------------------------------------------------------

export const DOCUMENT_LINK_TOKEN_PREFIX = "dl_";
const LINK_TOKEN_RANDOM_BYTES = 32;
/** `base64url(32 bytes)` is always 43 characters. */
const LINK_TOKEN_RANDOM_LENGTH = 43;

export function generateDocumentLinkToken(): string {
  return `${DOCUMENT_LINK_TOKEN_PREFIX}${randomBytes(LINK_TOKEN_RANDOM_BYTES).toString("base64url")}`;
}

export function hashDocumentLinkToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

/** Cheap shape check before any database round trip; not a security boundary. */
export function looksLikeDocumentLinkToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(DOCUMENT_LINK_TOKEN_PREFIX) &&
    value.length ===
      DOCUMENT_LINK_TOKEN_PREFIX.length + LINK_TOKEN_RANDOM_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value.slice(DOCUMENT_LINK_TOKEN_PREFIX.length))
  );
}

/** Where the private link lives, relative to the public base URL. */
export const DOCUMENT_LINK_PATH = "/api/v1/commerce/storefront/document-links/";

export function buildDocumentLinkUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${DOCUMENT_LINK_PATH}${token}`;
}

/** A link is usable strictly before its expiry instant. */
export function isLinkExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
