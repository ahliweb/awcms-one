import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import type {
  MediaLibraryPort,
  ResolvedMediaReferenceDTO
} from "../../_shared/ports/media-library-port";
import type {
  CreateTestimonialInput,
  UpdateTestimonialInput
} from "../domain/testimonial-validation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "testimonial";

export const TESTIMONIAL_LIST_LIMIT = 100;

type TestimonialRow = {
  id: string;
  author_name: string;
  author_role: string | null;
  body: string;
  rating: number;
  avatar_media_object_id: string | null;
  is_active: boolean;
  sort_order: number;
};

export type TestimonialRecord = {
  id: string;
  authorName: string;
  authorRole: string | null;
  body: string;
  rating: number;
  avatarMediaObjectId: string | null;
  isActive: boolean;
  sortOrder: number;
};

function toRecord(row: TestimonialRow): TestimonialRecord {
  return {
    id: row.id,
    authorName: row.author_name,
    authorRole: row.author_role,
    body: row.body,
    rating: row.rating,
    avatarMediaObjectId: row.avatar_media_object_id,
    isActive: row.is_active,
    sortOrder: row.sort_order
  };
}

const TESTIMONIAL_COLUMNS = `
  id, author_name, author_role, body, rating, avatar_media_object_id,
  is_active, sort_order
`;

export type TestimonialListPage = {
  items: TestimonialRecord[];
  nextCursor: string | null;
};

export async function listTestimonials(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null
): Promise<TestimonialListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT ${tx.unsafe(TESTIMONIAL_COLUMNS)},
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_testimonials
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${TESTIMONIAL_LIST_LIMIT}
  `) as (TestimonialRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === TESTIMONIAL_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items: rows.map(toRecord), nextCursor };
}

export async function fetchTestimonialById(
  tx: Bun.SQL,
  tenantId: string,
  testimonialId: string
): Promise<TestimonialRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(TESTIMONIAL_COLUMNS)}
    FROM awcms_commerce_testimonials
    WHERE tenant_id = ${tenantId} AND id = ${testimonialId} AND deleted_at IS NULL
  `) as TestimonialRow[];

  return rows[0] ? toRecord(rows[0]) : null;
}

export async function createTestimonial(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateTestimonialInput,
  correlationId?: string
): Promise<TestimonialRecord> {
  const rows = (await tx`
    INSERT INTO awcms_commerce_testimonials (
      tenant_id, author_name, author_role, body, rating,
      avatar_media_object_id, is_active, sort_order
    )
    VALUES (
      ${tenantId}, ${input.authorName}, ${input.authorRole}, ${input.body}, ${input.rating},
      ${input.avatarMediaObjectId}, ${input.isActive}, ${input.sortOrder}
    )
    RETURNING ${tx.unsafe(TESTIMONIAL_COLUMNS)}
  `) as TestimonialRow[];

  const record = toRecord(rows[0]!);

  // `message` names only the fact of creation, never `body`/`authorName`
  // verbatim — the audit log is a durable, less-access-controlled surface
  // than the row itself, and a testimonial's text is exactly the kind of
  // free-form personal content this module's masking discipline keeps out of
  // logs by omission (see `module.ts`'s `subjectData` entry for this table).
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: "Testimonial created.",
    correlationId
  });

  return record;
}

export async function updateTestimonial(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  testimonialId: string,
  input: UpdateTestimonialInput,
  correlationId?: string
): Promise<TestimonialRecord | null> {
  const existing = await fetchTestimonialById(tx, tenantId, testimonialId);
  if (!existing) return null;

  const rows = (await tx`
    UPDATE awcms_commerce_testimonials
    SET
      author_name = ${input.authorName ?? existing.authorName},
      author_role = ${input.authorRole === undefined ? existing.authorRole : input.authorRole},
      body = ${input.body ?? existing.body},
      rating = ${input.rating ?? existing.rating},
      avatar_media_object_id = ${input.avatarMediaObjectId === undefined ? existing.avatarMediaObjectId : input.avatarMediaObjectId},
      is_active = ${input.isActive ?? existing.isActive},
      sort_order = ${input.sortOrder ?? existing.sortOrder},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${testimonialId} AND deleted_at IS NULL
    RETURNING ${tx.unsafe(TESTIMONIAL_COLUMNS)}
  `) as TestimonialRow[];

  if (rows.length === 0) return null;

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: "Testimonial updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return record;
}

export async function deleteTestimonial(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  testimonialId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_testimonials
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${testimonialId} AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: testimonialId,
    severity: "warning",
    message: "Testimonial soft-deleted.",
    correlationId
  });

  return true;
}

export type TestimonialPublicDTO = {
  id: string;
  authorName: string;
  authorRole: string | null;
  body: string;
  rating: number;
  avatar: { url: string; alt: string | null } | null;
  sortOrder: number;
};

/** `GET /api/v1/commerce/testimonials/active` — live, active rows, `avatar` resolved through `MediaLibraryPort` in ONE batched call (only for rows that set one — `avatarMediaObjectId` is optional decoration, unlike a slider's required image). */
export async function listActiveTestimonialsPublic(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort
): Promise<TestimonialPublicDTO[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(TESTIMONIAL_COLUMNS)}
    FROM awcms_commerce_testimonials
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL AND is_active = true
    ORDER BY sort_order, id
  `) as TestimonialRow[];

  if (rows.length === 0) return [];

  const mediaIds = [
    ...new Set(
      rows
        .map((row) => row.avatar_media_object_id)
        .filter((id): id is string => id !== null)
    )
  ];
  const resolvedMedia =
    mediaIds.length > 0
      ? await mediaPort.resolveMediaReferences(tx, tenantId, mediaIds)
      : new Map<string, ResolvedMediaReferenceDTO>();

  return rows.map((row) => {
    const resolved = row.avatar_media_object_id
      ? resolvedMedia.get(row.avatar_media_object_id)
      : undefined;
    return {
      id: row.id,
      authorName: row.author_name,
      authorRole: row.author_role,
      body: row.body,
      rating: row.rating,
      avatar: resolved
        ? { url: resolved.publicUrl, alt: resolved.altText }
        : null,
      sortOrder: row.sort_order
    };
  });
}
