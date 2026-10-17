/**
 * Offering-to-product links of the booking-commerce adapter (Issue #378,
 * ADR-0045 D1; data model section 4.1): which Booking offering is sold as which
 * service product. Create, list, get and unlink (a status change - no delete).
 *
 * ## What it reads of Booking, and why that is allowed
 *
 * Linking has to know three facts about the offering - its `granularity` (to
 * agree with `quantityBasis`), its `confirmation_mode` (ADR-0045 G9: an
 * `immediate` offering confirms without payment and cannot be sold) and its
 * `status` - and `BookingPort` has no offering read (needs upstream port U1,
 * recorded in ADR-0045). So this file runs ONE read-only `SELECT` of exactly
 * those three columns from `awcms_booking_service_offerings`, constrained by the
 * tenant. It imports nothing from `booking`'s code (the module boundary stays
 * "commerce imports the PORT only"), writes nothing to Booking's tables, and is
 * the only such read; it retires when the port gains an offering read.
 *
 * ## Contract
 *
 * - One active product per offering and one active offering per product (D1);
 *   the product must be a service (D14 `PRODUCT_NOT_SERVICE`); `quantityBasis`
 *   must agree with the offering's granularity (`QUANTITY_BASIS_MISMATCH`).
 * - The adapter acts as the tenant's service-account user (G3): linking is
 *   refused with `BOOKING_SERVICE_ACTOR_NOT_CONFIGURED` until one is set, so the
 *   misconfiguration surfaces at setup and not at the first guest's checkout.
 * - A link creates no price, deposit or policy: price lives on the product (Q1),
 *   deposit on its policy row. A link warns (D6, non-blocking) when neither a
 *   product policy nor a tenant default cancellation policy is active:
 *   `NO_CANCELLATION_POLICY`, "cancellations will refund nothing".
 * - Create and unlink take an `Idempotency-Key` (the contract); both write one
 *   audit event with identifiers and enums only.
 *
 * Every refusal is RETURNED, never thrown; nothing is written before a refusal.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord,
  userIdempotencyActor
} from "../../_shared/idempotency";
import {
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import {
  isOfferingLinkable,
  quantityBasisForGranularity,
  type BookingOfferingLinkStatus,
  type BookingQuantityBasis,
  type CreateOfferingLinkInput
} from "../domain/booking-adapter";
import type { OfferingLinkRefusal } from "./booking-adapter-http";
import { fetchBookingServiceActor } from "./booking-adapter-settings";
import { IdempotencyPayloadMismatchError } from "./order-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_booking_offering_link";
const CREATE_SCOPE = "commerce.booking_offering_links.create";
const UPDATE_SCOPE = "commerce.booking_offering_links.update";
const LIST_PAGE_SIZE = 50;

/** A non-blocking finding returned with a created link (ADR-0045 D6). */
export type OfferingLinkWarning = "NO_CANCELLATION_POLICY";

export type OfferingLinkRecord = {
  id: string;
  offeringId: string;
  productId: string;
  quantityBasis: BookingQuantityBasis;
  status: BookingOfferingLinkStatus;
  unlinkedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreatedOfferingLink = OfferingLinkRecord & {
  warnings: OfferingLinkWarning[];
};

type LinkRow = {
  id: string;
  offering_id: string;
  product_id: string;
  quantity_basis: BookingQuantityBasis;
  status: BookingOfferingLinkStatus;
  unlinked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  created_at_cursor?: string;
};

const iso = (value: Date | string): string => new Date(value).toISOString();

function toRecord(row: LinkRow): OfferingLinkRecord {
  return {
    id: row.id,
    offeringId: row.offering_id,
    productId: row.product_id,
    quantityBasis: row.quantity_basis,
    status: row.status,
    unlinkedAt: row.unlinked_at === null ? null : iso(row.unlinked_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

const LINK_COLUMNS = `id, offering_id, product_id, quantity_basis, status,
  unlinked_at, created_at, updated_at`;

export type CreateOfferingLinkOutcome =
  | { kind: "created" | "replayed"; link: CreatedOfferingLink }
  | { kind: "refused"; refusal: OfferingLinkRefusal };

/**
 * The offering facts the link needs, from Booking's table (see the header).
 * `null` for an unknown, foreign-tenant or soft-deleted offering,
 * indistinguishably.
 */
async function readOfferingFacts(
  tx: Bun.SQL,
  tenantId: string,
  offeringId: string
): Promise<{
  granularity: string;
  confirmationMode: string;
  status: string;
} | null> {
  const rows = (await tx`
    SELECT granularity, confirmation_mode, status
    FROM awcms_booking_service_offerings
    WHERE tenant_id = ${tenantId} AND id = ${offeringId} AND deleted_at IS NULL
  `) as { granularity: string; confirmation_mode: string; status: string }[];
  const row = rows[0];
  if (!row) return null;
  return {
    granularity: row.granularity,
    confirmationMode: row.confirmation_mode,
    status: row.status
  };
}

/** Whether a cancellation policy (the product's, else the tenant default) is active (ADR-0045 D6). */
async function hasActiveCancellationPolicy(
  tx: Bun.SQL,
  tenantId: string,
  productId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 AS present
    FROM awcms_commerce_cancellation_policies
    WHERE tenant_id = ${tenantId} AND status = 'active'
      AND (product_id = ${productId} OR product_id IS NULL)
    LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Links one offering to one service product.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different request.
 */
export async function createOfferingLink(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateOfferingLinkInput,
  idempotencyKey: string,
  correlationId?: string
): Promise<CreateOfferingLinkOutcome> {
  const requestHash = computeRequestHash(input);
  const actor = userIdempotencyActor(actorTenantUserId);
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    idempotencyKey,
    actor
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      link: existing.responseBody as CreatedOfferingLink
    };
  }

  if ((await fetchBookingServiceActor(tx, tenantId)) === null) {
    return { kind: "refused", refusal: "service_actor_not_configured" };
  }

  const offering = await readOfferingFacts(tx, tenantId, input.offeringId);
  if (!offering) return { kind: "refused", refusal: "offering_not_found" };

  const products = (await tx`
    SELECT type FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${input.productId} AND deleted_at IS NULL
  `) as { type: string }[];
  if (!products[0]) return { kind: "refused", refusal: "product_not_found" };
  if (products[0].type !== "service") {
    return { kind: "refused", refusal: "product_not_service" };
  }
  if (!isOfferingLinkable(offering)) {
    return { kind: "refused", refusal: "offering_not_linkable" };
  }
  if (
    quantityBasisForGranularity(offering.granularity) !== input.quantityBasis
  ) {
    return { kind: "refused", refusal: "quantity_basis_mismatch" };
  }

  const rows = (await tx`
    INSERT INTO awcms_commerce_booking_offering_links
      (tenant_id, offering_id, product_id, quantity_basis)
    VALUES (${tenantId}, ${input.offeringId}, ${input.productId}, ${input.quantityBasis})
    ON CONFLICT DO NOTHING
    RETURNING ${tx.unsafe(LINK_COLUMNS)}
  `) as LinkRow[];
  if (!rows[0]) {
    // One of the two partial unique indexes (D1) took the row; say which.
    const byOffering = (await tx`
      SELECT 1 AS present FROM awcms_commerce_booking_offering_links
      WHERE tenant_id = ${tenantId} AND offering_id = ${input.offeringId}
        AND status = 'active'
    `) as unknown[];
    return {
      kind: "refused",
      refusal:
        byOffering.length > 0
          ? "offering_already_linked"
          : "product_already_linked"
    };
  }

  const warnings: OfferingLinkWarning[] = (await hasActiveCancellationPolicy(
    tx,
    tenantId,
    input.productId
  ))
    ? []
    : ["NO_CANCELLATION_POLICY"];
  const link: CreatedOfferingLink = { ...toRecord(rows[0]), warnings };

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.booking_offering_link.created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: link.id,
    message: "Booking offering linked to a service product.",
    attributes: {
      offeringId: link.offeringId,
      productId: link.productId,
      quantityBasis: link.quantityBasis,
      warnings
    },
    correlationId
  });
  await saveIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    idempotencyKey,
    actor,
    requestHash,
    201,
    link
  );
  return { kind: "created", link };
}

export type UpdateOfferingLinkOutcome =
  | { kind: "not_found" }
  | { kind: "unlinked" | "replayed" | "unchanged"; link: OfferingLinkRecord };

/**
 * Unlinks (active -> unlinked). Past orders and reservation links are untouched
 * (the sold history survives). A link that is already unlinked answers
 * `unchanged` with the stored row and writes nothing.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different request.
 */
export async function unlinkOfferingLink(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  linkId: string,
  idempotencyKey: string,
  correlationId?: string
): Promise<UpdateOfferingLinkOutcome> {
  const requestHash = computeRequestHash({ linkId, status: "unlinked" });
  const actor = userIdempotencyActor(actorTenantUserId);
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    UPDATE_SCOPE,
    idempotencyKey,
    actor
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      link: existing.responseBody as OfferingLinkRecord
    };
  }

  const current = await fetchOfferingLink(tx, tenantId, linkId);
  if (!current) return { kind: "not_found" };
  if (current.status === "unlinked") {
    return { kind: "unchanged", link: current };
  }

  const rows = (await tx`
    UPDATE awcms_commerce_booking_offering_links
    SET status = 'unlinked', unlinked_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${linkId} AND status = 'active'
    RETURNING ${tx.unsafe(LINK_COLUMNS)}
  `) as LinkRow[];
  const link = rows[0] ? toRecord(rows[0]) : current;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.booking_offering_link.unlinked",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: linkId,
    message: "Booking offering unlinked from a service product.",
    attributes: { offeringId: link.offeringId, productId: link.productId },
    correlationId
  });
  await saveIdempotencyRecord(
    tx,
    tenantId,
    UPDATE_SCOPE,
    idempotencyKey,
    actor,
    requestHash,
    200,
    link
  );
  return { kind: "unlinked", link };
}

export async function fetchOfferingLink(
  tx: Bun.SQL,
  tenantId: string,
  linkId: string
): Promise<OfferingLinkRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(LINK_COLUMNS)}
    FROM awcms_commerce_booking_offering_links
    WHERE tenant_id = ${tenantId} AND id = ${linkId}
  `) as LinkRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Links, newest first, keyset paged; `status` narrows to active or unlinked. */
export async function listOfferingLinks(
  tx: Bun.SQL,
  tenantId: string,
  filter: {
    status: BookingOfferingLinkStatus | null;
    cursor: KeysetCursor | null;
  }
): Promise<{ items: OfferingLinkRecord[]; nextCursor: string | null }> {
  const cursorCreatedAt = filter.cursor?.createdAt ?? null;
  const cursorId = filter.cursor?.id ?? null;
  const rows = (await tx`
    SELECT ${tx.unsafe(LINK_COLUMNS)},
      ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_booking_offering_links
    WHERE tenant_id = ${tenantId}
      AND (${filter.status}::text IS NULL OR status = ${filter.status})
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${LIST_PAGE_SIZE + 1}
  `) as LinkRow[];
  const hasMore = rows.length > LIST_PAGE_SIZE;
  const visible = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows;
  const last = visible[visible.length - 1];
  return {
    items: visible.map(toRecord),
    nextCursor:
      hasMore && last?.created_at_cursor
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}
