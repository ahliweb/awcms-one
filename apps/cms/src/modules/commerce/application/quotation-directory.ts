/**
 * Versioned quotations and their conversion into a commerce order (Issue #286,
 * ADR-0029 D5).
 *
 * ## An offer, not a sale
 *
 * A quotation is a priced OFFER to a named customer. Pricing comes from the one
 * quote engine every other surface uses (`buildCartQuote`, called here exactly
 * as `createPosOrder` calls it, self-pickup, with the customer's tier level),
 * and the result is FROZEN into an append-only version: the lines as priced,
 * the totals, the validity, the pricing context and a SHA-256 of all of it. No
 * stock is reserved and nothing is sold. Revising never edits a version - it
 * adds the next one and returns the quotation to `draft`.
 *
 * ## Acceptance pins a version; conversion reuses order creation
 *
 * `accept` pins the CURRENT version (the one the customer was shown) and is
 * refused once that version's validity has passed (the status is persisted
 * `expired` on the first touch that finds it so). `convert` feeds the ordinary
 * POS order path (`createPosOrder`, `allowDue: true`, no tenders): there is
 * exactly one place an order is written. The order is created at TODAY's price
 * and stock; if its total differs from the accepted version's total the whole
 * transaction is rolled back and the caller is told both numbers
 * (`QUOTATION_PRICE_CHANGED`) unless it passed `acceptPriceChange: true` - so
 * a conversion can never silently charge a different amount than was quoted,
 * and the quote never becomes a second price authority. Payment is then taken
 * through the existing payment ledger (ADR-0025), not here.
 *
 * ## Idempotent conversion
 *
 * The header's `converted_order_id` (set once, unique) is the anchor: the row is
 * locked `FOR NO KEY UPDATE`, a quotation already `converted` answers with its
 * existing order (whichever key or actor asks), and the inner order carries a
 * deterministic key derived from the quotation id. Two concurrent conversions
 * serialise on the lock; the loser replays the winner's order.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import {
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";
import { normalizeMoney } from "../domain/price-calculation";
import { normalizePhoneNumber } from "../domain/phone-normalisation";
import type { CartQuoteResult, CustomerLevel } from "../domain/cart-quote";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_QUOTATION_ACCEPTED_EVENT_TYPE,
  COMMERCE_QUOTATION_AGGREGATE_TYPE,
  COMMERCE_QUOTATION_CONVERTED_EVENT_TYPE
} from "../domain/commerce-events";
import {
  REVISABLE_QUOTATION_STATUSES,
  canTransitionQuotation,
  contentHash,
  isQuotationVersionExpired,
  signedDifference,
  totalsDiffer,
  type CartLineInput,
  type ConvertQuotationInput,
  type CreateQuotationInput,
  type QuotationAction,
  type QuotationActionInput,
  type QuotationStatus,
  type ReviseQuotationInput
} from "../domain/documents";
import type { CreatePosOrderInput } from "../domain/pos-order-validation";
import { allocateDocumentNumber } from "./document-numbering";
import { buildCartQuote } from "./cart-quote-service";
import { findOrCreateCustomerByPhone } from "./customer-directory";
import { IdempotencyPayloadMismatchError } from "./order-directory";
import { createPosOrder, type PosOrderRecord } from "./pos-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "quotation";
const PRODUCER_MODULE = "commerce";
const CREATE_SCOPE = "commerce.quotations.create";
const REVISE_SCOPE = "commerce.quotations.revise";
const ACTION_SCOPE_PREFIX = "commerce.quotations.";
const CONVERT_SCOPE = "commerce.quotations.convert";

export const QUOTATION_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type QuotationRecord = {
  id: string;
  number: string;
  /** Effective status: a `sent` quotation whose current version's validity has passed reads `expired`. */
  status: QuotationStatus;
  customerId: string | null;
  customerName: string | null;
  currentVersion: number;
  acceptedVersion: number | null;
  acceptedAt: string | null;
  convertedOrderId: string | null;
  validUntil: string;
  total: string;
  createdAt: string;
  updatedAt: string;
};

export type QuotationVersionLine = {
  productId: string;
  variantId: string | null;
  name: string | null;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
};

export type QuotationVersionRecord = {
  version: number;
  validUntil: string;
  currency: string;
  lines: QuotationVersionLine[];
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  customer: { name: string; phone: string } | null;
  pricingContext: Record<string, unknown>;
  notes: string | null;
  contentHash: string;
  createdByTenantUserId: string;
  createdAt: string;
};

export type QuotationDetail = QuotationRecord & {
  versions: QuotationVersionRecord[];
};

type HeaderRow = {
  id: string;
  number: string;
  status: string;
  customer_id: string | null;
  current_version: number;
  accepted_version: number | null;
  accepted_at: Date | null;
  converted_order_id: string | null;
  created_at: Date;
  updated_at: Date;
  v_valid_until: Date;
  v_total: string;
  v_customer: { name?: string } | null;
};

const HEADER_SELECT = `q.id, q.number, q.status, q.customer_id, q.current_version,
  q.accepted_version, q.accepted_at, q.converted_order_id, q.created_at, q.updated_at,
  v.valid_until AS v_valid_until, v.total AS v_total, v.customer AS v_customer`;

const HEADER_FROM = `awcms_commerce_quotations q
  JOIN awcms_commerce_quotation_versions v
    ON v.tenant_id = q.tenant_id AND v.quotation_id = q.id AND v.version = q.current_version`;

function toRecord(row: HeaderRow, now: Date): QuotationRecord {
  let status = row.status as QuotationStatus;
  if (status === "sent" && isQuotationVersionExpired(row.v_valid_until, now)) {
    status = "expired";
  }
  return {
    id: row.id,
    number: row.number,
    status,
    customerId: row.customer_id,
    customerName: row.v_customer?.name ?? null,
    currentVersion: Number(row.current_version),
    acceptedVersion:
      row.accepted_version === null ? null : Number(row.accepted_version),
    acceptedAt: row.accepted_at ? row.accepted_at.toISOString() : null,
    convertedOrderId: row.converted_order_id,
    validUntil: row.v_valid_until.toISOString(),
    total: normalizeMoney(String(row.v_total)),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

type VersionRow = {
  version: number;
  valid_until: Date;
  currency: string;
  lines: QuotationVersionLine[];
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  customer: { name: string; phone: string } | null;
  pricing_context: Record<string, unknown>;
  notes: string | null;
  content_hash: string;
  created_by_tenant_user_id: string;
  created_at: Date;
};

function toVersionRecord(row: VersionRow): QuotationVersionRecord {
  return {
    version: Number(row.version),
    validUntil: row.valid_until.toISOString(),
    currency: row.currency,
    lines: row.lines,
    subtotal: normalizeMoney(String(row.subtotal)),
    discount: normalizeMoney(String(row.discount)),
    tax: normalizeMoney(String(row.tax)),
    total: normalizeMoney(String(row.total)),
    customer: row.customer,
    pricingContext: row.pricing_context,
    notes: row.notes,
    contentHash: row.content_hash,
    createdByTenantUserId: row.created_by_tenant_user_id,
    createdAt: row.created_at.toISOString()
  };
}

export async function fetchQuotation(
  tx: Bun.SQL,
  tenantId: string,
  quotationId: string,
  now: Date = new Date()
): Promise<QuotationDetail | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(HEADER_SELECT)}
    FROM ${tx.unsafe(HEADER_FROM)}
    WHERE q.tenant_id = ${tenantId} AND q.id = ${quotationId} AND q.deleted_at IS NULL
  `) as HeaderRow[];
  if (!rows[0]) return null;
  const versions = (await tx`
    SELECT version, valid_until, currency, lines, subtotal, discount, tax, total,
           customer, pricing_context, notes, content_hash, created_by_tenant_user_id, created_at
    FROM awcms_commerce_quotation_versions
    WHERE tenant_id = ${tenantId} AND quotation_id = ${quotationId}
    ORDER BY version ASC
  `) as VersionRow[];
  return { ...toRecord(rows[0], now), versions: versions.map(toVersionRecord) };
}

export type QuotationListFilters = { status?: QuotationStatus };
export type QuotationListPage = {
  items: QuotationRecord[];
  nextCursor: string | null;
};

export async function listQuotations(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: QuotationListFilters = {},
  now: Date = new Date()
): Promise<QuotationListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const status = filters.status ?? null;
  const rows = (await tx`
    SELECT ${tx.unsafe(HEADER_SELECT)},
           ${tx.unsafe(keysetCursorCreatedAtSql("q"))} AS created_at_cursor
    FROM ${tx.unsafe(HEADER_FROM)}
    WHERE q.tenant_id = ${tenantId} AND q.deleted_at IS NULL
      AND (
        ${status}::text IS NULL
        OR (${status}::text = 'expired' AND (q.status = 'expired'
            OR (q.status = 'sent' AND v.valid_until <= ${now})))
        OR (${status}::text = 'sent' AND q.status = 'sent' AND v.valid_until > ${now})
        OR (${status}::text NOT IN ('expired', 'sent') AND q.status = ${status}::text)
      )
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (q.created_at, q.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY q.created_at DESC, q.id DESC
    LIMIT ${QUOTATION_LIST_LIMIT}
  `) as (HeaderRow & { created_at_cursor: string })[];
  const last = rows[rows.length - 1];
  return {
    items: rows.map((row) => toRecord(row, now)),
    nextCursor:
      rows.length === QUOTATION_LIST_LIMIT && last
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}

// ---------------------------------------------------------------------------
// Pricing snapshot
// ---------------------------------------------------------------------------

/** Thrown inside the transaction when the priced cart cannot be quoted; the route answers `409 CART_CHANGED`. */
export class QuotationCartError extends Error {
  public readonly quote: CartQuoteResult;
  constructor(quote: CartQuoteResult) {
    super("One or more lines cannot be priced right now.");
    this.name = "QuotationCartError";
    this.quote = quote;
  }
}

/** Thrown INSIDE the conversion's savepoint when the order's total differs from the quoted one; the savepoint rolls the order back and `convertQuotation` turns it into the `price_changed` outcome. */
class QuotationPriceChangedError extends Error {
  public readonly quotedTotal: string;
  public readonly currentTotal: string;
  constructor(quotedTotal: string, currentTotal: string) {
    super("The current price differs from the quoted price.");
    this.name = "QuotationPriceChangedError";
    this.quotedTotal = quotedTotal;
    this.currentTotal = currentTotal;
  }
}

type PricedVersion = {
  lines: QuotationVersionLine[];
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  pricingContext: Record<string, unknown>;
};

async function priceLines(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  lines: CartLineInput[],
  customerLevel: CustomerLevel | null,
  now: Date
): Promise<PricedVersion> {
  const quote = await buildCartQuote(
    tx,
    tenantId,
    mediaPort,
    {
      lines: lines.map((line) => ({
        productId: line.productId,
        variantId: line.variantId,
        quantity: line.quantity,
        serviceFormValues: null
      })),
      shipping: { method: "self_pickup" },
      voucherCode: null,
      insurance: false,
      destination: null,
      customerLevel
    },
    now
  );
  if (!quote.canCheckout) throw new QuotationCartError(quote);
  return {
    lines: quote.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      name: line.name,
      variantName: line.variantName,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal
    })),
    subtotal: quote.subtotal,
    discount: quote.discount,
    tax: quote.tax.amount,
    total: quote.total,
    pricingContext: {
      engine: "cart-quote",
      quotedAt: quote.quotedAt,
      customerLevel,
      taxActive: quote.tax.active,
      taxPercent: quote.tax.percent,
      shippingCost: quote.shipping?.cost ?? "0.00"
    }
  };
}

function levelOf(level: number | null | undefined): CustomerLevel | null {
  return level !== null && level !== undefined && level >= 1 && level <= 4
    ? (level as CustomerLevel)
    : null;
}

async function insertVersion(
  tx: Bun.SQL,
  tenantId: string,
  quotationId: string,
  version: number,
  priced: PricedVersion,
  content: {
    validUntil: Date;
    notes: string | null;
    customer: { name: string; phone: string } | null;
  },
  actorTenantUserId: string,
  now: Date
): Promise<void> {
  const hash = contentHash({
    version,
    validUntil: content.validUntil.toISOString(),
    customer: content.customer,
    notes: content.notes,
    ...priced
  });
  await tx`
    INSERT INTO awcms_commerce_quotation_versions (
      tenant_id, quotation_id, version, valid_until, lines, subtotal, discount, tax, total,
      customer, pricing_context, notes, content_hash, created_by_tenant_user_id, created_at
    )
    VALUES (
      ${tenantId}, ${quotationId}, ${version}, ${content.validUntil}, ${priced.lines}::jsonb,
      ${priced.subtotal}, ${priced.discount}, ${priced.tax}, ${priced.total},
      ${content.customer}::jsonb, ${priced.pricingContext}::jsonb, ${content.notes},
      ${hash}, ${actorTenantUserId}, ${now}
    )
  `;
}

// ---------------------------------------------------------------------------
// Create / revise
// ---------------------------------------------------------------------------

export type CreateQuotationOutcome =
  | { kind: "invalid_phone" }
  | { kind: "created" | "replayed"; quotation: QuotationDetail };

export async function createQuotation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  mediaPort: MediaLibraryPort,
  input: CreateQuotationInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<CreateQuotationOutcome> {
  const requestHash = computeRequestHash({
    action: CREATE_SCOPE,
    actorTenantUserId,
    customer: input.customer,
    lines: input.lines,
    validUntil: input.validUntil.toISOString(),
    notes: input.notes
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      quotation: existing.responseBody as QuotationDetail
    };
  }

  const phone = normalizePhoneNumber(input.customer.phone);
  if (!phone.valid) return { kind: "invalid_phone" };
  const customer = await findOrCreateCustomerByPhone(
    tx,
    tenantId,
    input.customer.name,
    phone.value,
    null,
    correlationId
  );
  const priced = await priceLines(
    tx,
    tenantId,
    mediaPort,
    input.lines,
    levelOf(customer.level),
    now
  );

  // Allocate LAST: nothing fallible sits between here and the inserts.
  const allocated = await allocateDocumentNumber(
    tx,
    tenantId,
    "quotation",
    now
  );
  const headers = (await tx`
    INSERT INTO awcms_commerce_quotations (
      tenant_id, number, customer_id, created_by_tenant_user_id, created_at, updated_at
    )
    VALUES (${tenantId}, ${allocated.number}, ${customer.id}, ${actorTenantUserId}, ${now}, ${now})
    RETURNING id
  `) as { id: string }[];
  const quotationId = headers[0]!.id;
  await insertVersion(
    tx,
    tenantId,
    quotationId,
    1,
    priced,
    {
      validUntil: input.validUntil,
      notes: input.notes,
      customer: { name: input.customer.name, phone: phone.value }
    },
    actorTenantUserId,
    now
  );

  const quotation = (await fetchQuotation(tx, tenantId, quotationId, now))!;
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "quotation.create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: quotationId,
    message: `Quotation ${quotation.number} created, total ${quotation.total}.`,
    attributes: {
      number: quotation.number,
      version: 1,
      total: quotation.total,
      lineCount: priced.lines.length,
      validUntil: quotation.validUntil
    },
    correlationId
  });
  await saveIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    quotation
  );
  return { kind: "created", quotation };
}

export type ReviseQuotationOutcome =
  | { kind: "not_found" }
  | { kind: "not_revisable"; status: QuotationStatus }
  | { kind: "created" | "replayed"; quotation: QuotationDetail };

export async function reviseQuotation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  mediaPort: MediaLibraryPort,
  quotationId: string,
  input: ReviseQuotationInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<ReviseQuotationOutcome> {
  const locked = (await tx`
    SELECT q.status, q.current_version, q.number, c.level
    FROM awcms_commerce_quotations q
    LEFT JOIN awcms_commerce_customers c ON c.tenant_id = q.tenant_id AND c.id = q.customer_id
    WHERE q.tenant_id = ${tenantId} AND q.id = ${quotationId} AND q.deleted_at IS NULL
    FOR NO KEY UPDATE OF q
  `) as {
    status: string;
    current_version: number;
    number: string;
    level: number | null;
  }[];
  const header = locked[0];
  if (!header) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: REVISE_SCOPE,
    actorTenantUserId,
    quotationId,
    lines: input.lines,
    validUntil: input.validUntil.toISOString(),
    notes: input.notes
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    REVISE_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      quotation: existing.responseBody as QuotationDetail
    };
  }

  // A `sent` quotation whose current version lapsed is `expired` in effect;
  // the stored status may still say `sent`, and either may be revised.
  const status = header.status as QuotationStatus;
  if (!REVISABLE_QUOTATION_STATUSES.includes(status)) {
    return { kind: "not_revisable", status };
  }

  const current = (await tx`
    SELECT customer FROM awcms_commerce_quotation_versions
    WHERE tenant_id = ${tenantId} AND quotation_id = ${quotationId}
      AND version = ${header.current_version}
  `) as { customer: { name: string; phone: string } | null }[];
  const priced = await priceLines(
    tx,
    tenantId,
    mediaPort,
    input.lines,
    levelOf(header.level),
    now
  );
  const nextVersion = Number(header.current_version) + 1;
  await insertVersion(
    tx,
    tenantId,
    quotationId,
    nextVersion,
    priced,
    {
      validUntil: input.validUntil,
      notes: input.notes,
      customer: current[0]?.customer ?? null
    },
    actorTenantUserId,
    now
  );
  await tx`
    UPDATE awcms_commerce_quotations
    SET current_version = ${nextVersion}, status = 'draft', updated_at = ${now}
    WHERE tenant_id = ${tenantId} AND id = ${quotationId}
  `;

  const quotation = (await fetchQuotation(tx, tenantId, quotationId, now))!;
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "quotation.revise",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: quotationId,
    message: `Quotation ${quotation.number} revised to version ${nextVersion}, total ${quotation.total}.`,
    attributes: {
      number: quotation.number,
      version: nextVersion,
      total: quotation.total
    },
    correlationId
  });
  await saveIdempotencyRecord(
    tx,
    tenantId,
    REVISE_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    quotation
  );
  return { kind: "created", quotation };
}

// ---------------------------------------------------------------------------
// Send / accept / reject / cancel
// ---------------------------------------------------------------------------

export type QuotationActionOutcome =
  | { kind: "not_found" }
  | { kind: "illegal"; status: QuotationStatus }
  | { kind: "expired"; quotation: QuotationDetail }
  | { kind: "done" | "replayed"; quotation: QuotationDetail };

const ACTION_TARGET: Record<QuotationAction, QuotationStatus> = {
  send: "sent",
  accept: "accepted",
  reject: "rejected",
  cancel: "cancelled"
};

export async function applyQuotationAction(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  quotationId: string,
  action: QuotationAction,
  input: QuotationActionInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<QuotationActionOutcome> {
  const locked = (await tx`
    SELECT q.status, q.current_version, q.number, v.valid_until, v.total
    FROM awcms_commerce_quotations q
    JOIN awcms_commerce_quotation_versions v
      ON v.tenant_id = q.tenant_id AND v.quotation_id = q.id AND v.version = q.current_version
    WHERE q.tenant_id = ${tenantId} AND q.id = ${quotationId} AND q.deleted_at IS NULL
    FOR NO KEY UPDATE OF q
  `) as {
    status: string;
    current_version: number;
    number: string;
    valid_until: Date;
    total: string;
  }[];
  const header = locked[0];
  if (!header) return { kind: "not_found" };

  const scope = `${ACTION_SCOPE_PREFIX}${action}`;
  const requestHash = computeRequestHash({
    action: scope,
    actorTenantUserId,
    quotationId,
    note: input.note
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    scope,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      quotation: existing.responseBody as QuotationDetail
    };
  }

  const from = header.status as QuotationStatus;
  const to = ACTION_TARGET[action];
  const lapsed = isQuotationVersionExpired(header.valid_until, now);

  // A sent offer past its validity cannot be accepted: persist the expiry
  // (a returned 409 still commits it) and say so.
  if (action === "accept" && from === "sent" && lapsed) {
    await tx`
      UPDATE awcms_commerce_quotations SET status = 'expired', updated_at = ${now}
      WHERE tenant_id = ${tenantId} AND id = ${quotationId}
    `;
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "quotation.expire",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: quotationId,
      message: `Quotation ${header.number} version ${header.current_version} lapsed before it was accepted.`,
      attributes: {
        number: header.number,
        version: Number(header.current_version)
      },
      correlationId
    });
    return {
      kind: "expired",
      quotation: (await fetchQuotation(tx, tenantId, quotationId, now))!
    };
  }
  // The stored `sent` of a lapsed offer is `expired` in effect: reject/cancel still work on it.
  if (!canTransitionQuotation(from, to)) {
    return {
      kind: "illegal",
      status: from === "sent" && lapsed ? "expired" : from
    };
  }
  // An offer already past its validity is not worth sending.
  if (action === "send" && lapsed) {
    return { kind: "illegal", status: "expired" };
  }

  if (action === "accept") {
    await tx`
      UPDATE awcms_commerce_quotations
      SET status = 'accepted', accepted_version = current_version, accepted_at = ${now},
          accepted_by_tenant_user_id = ${actorTenantUserId}, decision_note = ${input.note},
          updated_at = ${now}
      WHERE tenant_id = ${tenantId} AND id = ${quotationId}
    `;
  } else {
    await tx`
      UPDATE awcms_commerce_quotations
      SET status = ${to}, decision_note = COALESCE(${input.note}, decision_note), updated_at = ${now}
      WHERE tenant_id = ${tenantId} AND id = ${quotationId}
    `;
  }

  const quotation = (await fetchQuotation(tx, tenantId, quotationId, now))!;
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: `quotation.${action}`,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: quotationId,
    message: `Quotation ${quotation.number} ${to}.`,
    attributes: {
      number: quotation.number,
      from,
      to,
      version: quotation.currentVersion
    },
    correlationId
  });
  if (action === "accept") {
    await appendDomainEvent(tx, tenantId, {
      eventType: COMMERCE_QUOTATION_ACCEPTED_EVENT_TYPE,
      eventVersion: COMMERCE_EVENT_VERSION,
      aggregateType: COMMERCE_QUOTATION_AGGREGATE_TYPE,
      aggregateId: quotationId,
      producerModule: PRODUCER_MODULE,
      correlationId,
      actorTenantUserId,
      payload: {
        quotationId,
        number: quotation.number,
        acceptedVersion: quotation.acceptedVersion,
        total: quotation.total
      }
    });
  }
  await saveIdempotencyRecord(
    tx,
    tenantId,
    scope,
    input.idempotencyKey,
    requestHash,
    200,
    quotation
  );
  return { kind: "done", quotation };
}

// ---------------------------------------------------------------------------
// Convert to an order
// ---------------------------------------------------------------------------

export type ConvertedOrderSummary = {
  id: string;
  orderCode: string;
  status: string;
  paymentStatus: string;
  total: string;
};

export type ConvertedQuotation = {
  quotation: QuotationDetail;
  order: ConvertedOrderSummary;
  /** `true` when this call returned the order an earlier conversion made. */
  alreadyConverted: boolean;
};

export type ConvertQuotationOutcome =
  | { kind: "not_found" }
  | { kind: "not_accepted"; status: QuotationStatus }
  | { kind: "invalid_phone" }
  | { kind: "price_changed"; quotedTotal: string; currentTotal: string }
  | { kind: "converted" | "replayed"; result: ConvertedQuotation };

async function orderSummary(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<ConvertedOrderSummary> {
  const rows = (await tx`
    SELECT id, order_code, status, payment_status, total
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId}
  `) as {
    id: string;
    order_code: string;
    status: string;
    payment_status: string;
    total: string;
  }[];
  const row = rows[0]!;
  return {
    id: row.id,
    orderCode: row.order_code,
    status: row.status,
    paymentStatus: row.payment_status,
    total: normalizeMoney(String(row.total))
  };
}

export async function convertQuotation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  mediaPort: MediaLibraryPort,
  quotationId: string,
  input: ConvertQuotationInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<ConvertQuotationOutcome> {
  const locked = (await tx`
    SELECT status, number, accepted_version, converted_order_id
    FROM awcms_commerce_quotations
    WHERE tenant_id = ${tenantId} AND id = ${quotationId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as {
    status: string;
    number: string;
    accepted_version: number | null;
    converted_order_id: string | null;
  }[];
  const header = locked[0];
  if (!header) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: CONVERT_SCOPE,
    actorTenantUserId,
    quotationId,
    registerId: input.registerId,
    acceptPriceChange: input.acceptPriceChange
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    CONVERT_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      result: existing.responseBody as ConvertedQuotation
    };
  }

  // Already converted - by any key, by anyone: answer with the existing order.
  if (header.status === "converted" && header.converted_order_id) {
    return {
      kind: "replayed",
      result: {
        quotation: (await fetchQuotation(tx, tenantId, quotationId, now))!,
        order: await orderSummary(tx, tenantId, header.converted_order_id),
        alreadyConverted: true
      }
    };
  }
  if (header.status !== "accepted" || header.accepted_version === null) {
    return { kind: "not_accepted", status: header.status as QuotationStatus };
  }

  const versions = (await tx`
    SELECT lines, total, customer
    FROM awcms_commerce_quotation_versions
    WHERE tenant_id = ${tenantId} AND quotation_id = ${quotationId}
      AND version = ${header.accepted_version}
  `) as {
    lines: QuotationVersionLine[];
    total: string;
    customer: { name: string; phone: string } | null;
  }[];
  const accepted = versions[0]!;
  const quotedTotal = normalizeMoney(String(accepted.total));
  if (!accepted.customer) return { kind: "invalid_phone" };

  const orderInput: CreatePosOrderInput = {
    // Deterministic: one inner order per quotation, whoever converts it.
    idempotencyKey: `quotation-convert:${quotationId}`,
    customer: { name: accepted.customer.name, phone: accepted.customer.phone },
    lines: accepted.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity
    })),
    payment: null,
    tenders: [],
    allowDue: true,
    registerId: input.registerId,
    notes: `Quotation ${header.number} v${header.accepted_version}`
  } as CreatePosOrderInput;

  // The order write and the price check share ONE savepoint: a returned
  // failure Response would still COMMIT the surrounding transaction, so a
  // conversion that must not stand is undone by throwing inside the savepoint.
  let order: PosOrderRecord;
  try {
    const inner = await (tx as Bun.TransactionSQL).savepoint(async (sp) => {
      const outcome = await createPosOrder(
        sp,
        tenantId,
        actorTenantUserId,
        mediaPort,
        orderInput,
        now,
        correlationId
      );
      if (outcome.kind === "invalid_phone") return null;
      if (
        !input.acceptPriceChange &&
        totalsDiffer(quotedTotal, outcome.order.total)
      ) {
        throw new QuotationPriceChangedError(quotedTotal, outcome.order.total);
      }
      return outcome.order;
    });
    if (inner === null) return { kind: "invalid_phone" };
    order = inner;
  } catch (error) {
    if (error instanceof QuotationPriceChangedError) {
      return {
        kind: "price_changed",
        quotedTotal: error.quotedTotal,
        currentTotal: error.currentTotal
      };
    }
    throw error;
  }

  await tx`
    UPDATE awcms_commerce_quotations
    SET status = 'converted', converted_order_id = ${order.id}, updated_at = ${now}
    WHERE tenant_id = ${tenantId} AND id = ${quotationId}
  `;

  const result: ConvertedQuotation = {
    quotation: (await fetchQuotation(tx, tenantId, quotationId, now))!,
    order: {
      id: order.id,
      orderCode: order.orderCode,
      status: order.status,
      paymentStatus: order.paymentStatus,
      total: order.total
    },
    alreadyConverted: false
  };
  const priceDelta = signedDifference(quotedTotal, order.total);
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "quotation.convert",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: quotationId,
    message: `Quotation ${header.number} version ${header.accepted_version} converted into order ${order.orderCode}.`,
    attributes: {
      number: header.number,
      acceptedVersion: Number(header.accepted_version),
      orderId: order.id,
      orderCode: order.orderCode,
      quotedTotal,
      orderTotal: order.total,
      priceDelta
    },
    correlationId
  });
  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_QUOTATION_CONVERTED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_QUOTATION_AGGREGATE_TYPE,
    aggregateId: quotationId,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: {
      quotationId,
      number: header.number,
      acceptedVersion: Number(header.accepted_version),
      orderId: order.id,
      orderCode: order.orderCode,
      quotedTotal,
      orderTotal: order.total
    }
  });
  await saveIdempotencyRecord(
    tx,
    tenantId,
    CONVERT_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    result
  );
  return { kind: "converted", result };
}
