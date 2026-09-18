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
  CreateSliderInput,
  UpdateSliderInput
} from "../domain/slider-validation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "slider";

export const SLIDER_LIST_LIMIT = 100;

/** `mediaObjectId` does not resolve to a live, verified, same-tenant media object — same reasoning as `product-image-directory.ts`'s `ProductImageMediaReferenceInvalidError`, since a slider's `media_object_id` is `NOT NULL` — the row IS the reference (`sql/909`'s header). */
export class SliderMediaReferenceInvalidError extends Error {
  constructor() {
    super(
      "mediaObjectId does not reference a live, verified media object in this tenant."
    );
    this.name = "SliderMediaReferenceInvalidError";
  }
}

type SliderRow = {
  id: string;
  title: string;
  subtitle: string | null;
  media_object_id: string;
  link_url: string | null;
  button_text: string | null;
  sort_order: number;
  is_active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
};

export type SliderRecord = {
  id: string;
  title: string;
  subtitle: string | null;
  mediaObjectId: string;
  linkUrl: string | null;
  buttonText: string | null;
  sortOrder: number;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

function toRecord(row: SliderRow): SliderRecord {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    mediaObjectId: row.media_object_id,
    linkUrl: row.link_url,
    buttonText: row.button_text,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    startsAt: row.starts_at ? row.starts_at.toISOString() : null,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null
  };
}

const SLIDER_COLUMNS = `
  id, title, subtitle, media_object_id, link_url, button_text, sort_order,
  is_active, starts_at, ends_at
`;

export type SliderListPage = {
  items: SliderRecord[];
  nextCursor: string | null;
};

export async function listSliders(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null
): Promise<SliderListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT ${tx.unsafe(SLIDER_COLUMNS)},
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_sliders
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${SLIDER_LIST_LIMIT}
  `) as (SliderRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === SLIDER_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items: rows.map(toRecord), nextCursor };
}

export async function fetchSliderById(
  tx: Bun.SQL,
  tenantId: string,
  sliderId: string
): Promise<SliderRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(SLIDER_COLUMNS)}
    FROM awcms_commerce_sliders
    WHERE tenant_id = ${tenantId} AND id = ${sliderId} AND deleted_at IS NULL
  `) as SliderRow[];

  return rows[0] ? toRecord(rows[0]) : null;
}

/** @throws {SliderMediaReferenceInvalidError} `mediaObjectId` is not a live, verified, same-tenant media object. */
export async function createSlider(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateSliderInput,
  mediaPort: MediaLibraryPort,
  correlationId?: string
): Promise<SliderRecord> {
  const safe = await mediaPort.isMediaReferenceSafe(
    tx,
    tenantId,
    input.mediaObjectId
  );
  if (!safe) throw new SliderMediaReferenceInvalidError();

  const rows = (await tx`
    INSERT INTO awcms_commerce_sliders (
      tenant_id, title, subtitle, media_object_id, link_url, button_text,
      sort_order, is_active, starts_at, ends_at
    )
    VALUES (
      ${tenantId}, ${input.title}, ${input.subtitle}, ${input.mediaObjectId},
      ${input.linkUrl}, ${input.buttonText}, ${input.sortOrder}, ${input.isActive},
      ${input.startsAt}, ${input.endsAt}
    )
    RETURNING ${tx.unsafe(SLIDER_COLUMNS)}
  `) as SliderRow[];

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: `Slider created: ${record.title}.`,
    correlationId
  });

  return record;
}

/** @throws {SliderMediaReferenceInvalidError} `mediaObjectId` is set and is not a live, verified, same-tenant media object. */
export async function updateSlider(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  sliderId: string,
  input: UpdateSliderInput,
  mediaPort: MediaLibraryPort,
  correlationId?: string
): Promise<SliderRecord | null> {
  const existing = await fetchSliderById(tx, tenantId, sliderId);
  if (!existing) return null;

  if (input.mediaObjectId !== undefined) {
    const safe = await mediaPort.isMediaReferenceSafe(
      tx,
      tenantId,
      input.mediaObjectId
    );
    if (!safe) throw new SliderMediaReferenceInvalidError();
  }

  const rows = (await tx`
    UPDATE awcms_commerce_sliders
    SET
      title = ${input.title ?? existing.title},
      subtitle = ${input.subtitle === undefined ? existing.subtitle : input.subtitle},
      media_object_id = ${input.mediaObjectId ?? existing.mediaObjectId},
      link_url = ${input.linkUrl === undefined ? existing.linkUrl : input.linkUrl},
      button_text = ${input.buttonText === undefined ? existing.buttonText : input.buttonText},
      sort_order = ${input.sortOrder ?? existing.sortOrder},
      is_active = ${input.isActive ?? existing.isActive},
      starts_at = ${input.startsAt === undefined ? (existing.startsAt ? new Date(existing.startsAt) : null) : input.startsAt},
      ends_at = ${input.endsAt === undefined ? (existing.endsAt ? new Date(existing.endsAt) : null) : input.endsAt},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${sliderId} AND deleted_at IS NULL
    RETURNING ${tx.unsafe(SLIDER_COLUMNS)}
  `) as SliderRow[];

  if (rows.length === 0) return null;

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: "Slider updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return record;
}

export async function deleteSlider(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  sliderId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_sliders
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${sliderId} AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: sliderId,
    severity: "warning",
    message: "Slider soft-deleted.",
    correlationId
  });

  return true;
}

export type SliderPublicDTO = {
  id: string;
  title: string;
  subtitle: string | null;
  image: {
    url: string | null;
    alt: string | null;
    width: number | null;
    height: number | null;
  };
  linkUrl: string | null;
  buttonText: string | null;
  sortOrder: number;
};

/** `GET /api/v1/commerce/sliders/active` — live, active, in-window rows, `image` resolved through `MediaLibraryPort` in ONE batched call. */
export async function listActiveSlidersPublic(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  now: Date
): Promise<SliderPublicDTO[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(SLIDER_COLUMNS)}
    FROM awcms_commerce_sliders
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND is_active = true
      AND (starts_at IS NULL OR starts_at <= ${now})
      AND (ends_at IS NULL OR ends_at >= ${now})
    ORDER BY sort_order, id
  `) as SliderRow[];

  if (rows.length === 0) return [];

  const mediaIds = [...new Set(rows.map((row) => row.media_object_id))];
  const resolvedMedia = await mediaPort.resolveMediaReferences(
    tx,
    tenantId,
    mediaIds
  );

  return rows.map((row) => {
    const resolved: ResolvedMediaReferenceDTO | undefined = resolvedMedia.get(
      row.media_object_id
    );
    return {
      id: row.id,
      title: row.title,
      subtitle: row.subtitle,
      image: {
        url: resolved?.publicUrl ?? null,
        alt: resolved?.altText ?? null,
        width: resolved?.width ?? null,
        height: resolved?.height ?? null
      },
      linkUrl: row.link_url,
      buttonText: row.button_text,
      sortOrder: row.sort_order
    };
  });
}
