import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";
import type {
  CreatePopupInput,
  PopupFrequency,
  UpdatePopupInput
} from "../domain/popup-validation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "popup";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const POPUPS_ONE_ACTIVE_CONSTRAINT =
  "awcms_commerce_popups_one_active_per_tenant";

export const POPUP_LIST_LIMIT = 100;

/** Another live popup already holds `is_active = true` for this tenant — `sql/161`'s partial unique index (`awcms_commerce_popups_one_active_per_tenant`) is the actual invariant; this is its 409 mapping. */
export class PopupAlreadyActiveError extends Error {
  constructor() {
    super(
      "Another popup is already active for this tenant — deactivate it first."
    );
    this.name = "PopupAlreadyActiveError";
  }
}

type PopupRow = {
  id: string;
  title: string;
  body: string | null;
  media_object_id: string | null;
  link_url: string | null;
  button_text: string | null;
  frequency: string;
  is_active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
};

export type PopupRecord = {
  id: string;
  title: string;
  body: string | null;
  mediaObjectId: string | null;
  linkUrl: string | null;
  buttonText: string | null;
  frequency: PopupFrequency;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

function toRecord(row: PopupRow): PopupRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    mediaObjectId: row.media_object_id,
    linkUrl: row.link_url,
    buttonText: row.button_text,
    frequency: row.frequency as PopupFrequency,
    isActive: row.is_active,
    startsAt: row.starts_at ? row.starts_at.toISOString() : null,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null
  };
}

const POPUP_COLUMNS = `
  id, title, body, media_object_id, link_url, button_text, frequency,
  is_active, starts_at, ends_at
`;

export type PopupListPage = { items: PopupRecord[]; nextCursor: string | null };

export async function listPopups(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null
): Promise<PopupListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT ${tx.unsafe(POPUP_COLUMNS)},
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_popups
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${POPUP_LIST_LIMIT}
  `) as (PopupRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === POPUP_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items: rows.map(toRecord), nextCursor };
}

export async function fetchPopupById(
  tx: Bun.SQL,
  tenantId: string,
  popupId: string
): Promise<PopupRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(POPUP_COLUMNS)}
    FROM awcms_commerce_popups
    WHERE tenant_id = ${tenantId} AND id = ${popupId} AND deleted_at IS NULL
  `) as PopupRow[];

  return rows[0] ? toRecord(rows[0]) : null;
}

/** @throws {PopupAlreadyActiveError} `input.isActive` is `true` and another live popup already is. */
export async function createPopup(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreatePopupInput,
  correlationId?: string
): Promise<PopupRecord> {
  let rows: PopupRow[];

  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_popups (
        tenant_id, title, body, media_object_id, link_url, button_text,
        frequency, is_active, starts_at, ends_at
      )
      VALUES (
        ${tenantId}, ${input.title}, ${input.body}, ${input.mediaObjectId},
        ${input.linkUrl}, ${input.buttonText}, ${input.frequency}, ${input.isActive},
        ${input.startsAt}, ${input.endsAt}
      )
      RETURNING ${tx.unsafe(POPUP_COLUMNS)}
    `) as PopupRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === POPUPS_ONE_ACTIVE_CONSTRAINT
    ) {
      throw new PopupAlreadyActiveError();
    }
    throw error;
  }

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: `Popup created: ${record.title}.`,
    correlationId
  });

  return record;
}

/** @throws {PopupAlreadyActiveError} the update would set `isActive: true` while another live popup already is. */
export async function updatePopup(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  popupId: string,
  input: UpdatePopupInput,
  correlationId?: string
): Promise<PopupRecord | null> {
  const existing = await fetchPopupById(tx, tenantId, popupId);
  if (!existing) return null;

  let rows: PopupRow[];

  try {
    rows = (await tx`
      UPDATE awcms_commerce_popups
      SET
        title = ${input.title ?? existing.title},
        body = ${input.body === undefined ? existing.body : input.body},
        media_object_id = ${input.mediaObjectId === undefined ? existing.mediaObjectId : input.mediaObjectId},
        link_url = ${input.linkUrl === undefined ? existing.linkUrl : input.linkUrl},
        button_text = ${input.buttonText === undefined ? existing.buttonText : input.buttonText},
        frequency = ${input.frequency ?? existing.frequency},
        is_active = ${input.isActive ?? existing.isActive},
        starts_at = ${input.startsAt === undefined ? (existing.startsAt ? new Date(existing.startsAt) : null) : input.startsAt},
        ends_at = ${input.endsAt === undefined ? (existing.endsAt ? new Date(existing.endsAt) : null) : input.endsAt},
        updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${popupId} AND deleted_at IS NULL
      RETURNING ${tx.unsafe(POPUP_COLUMNS)}
    `) as PopupRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === POPUPS_ONE_ACTIVE_CONSTRAINT
    ) {
      throw new PopupAlreadyActiveError();
    }
    throw error;
  }

  if (rows.length === 0) return null;

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: "Popup updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return record;
}

export async function deletePopup(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  popupId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_popups
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${popupId} AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: popupId,
    severity: "warning",
    message: "Popup soft-deleted.",
    correlationId
  });

  return true;
}

export type PopupPublicDTO = {
  id: string;
  title: string;
  body: string | null;
  image: { url: string; alt: string | null } | null;
  linkUrl: string | null;
  buttonText: string | null;
  frequency: PopupFrequency;
  startsAt: string | null;
  endsAt: string | null;
};

/** `GET /api/v1/commerce/popups/active` — `null` when none; otherwise the ONE live+active+in-window popup the tenant's own unique index guarantees is unambiguous. */
export async function fetchActivePopupPublic(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  now: Date
): Promise<PopupPublicDTO | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(POPUP_COLUMNS)}
    FROM awcms_commerce_popups
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND is_active = true
      AND (starts_at IS NULL OR starts_at <= ${now})
      AND (ends_at IS NULL OR ends_at >= ${now})
    LIMIT 1
  `) as PopupRow[];

  const row = rows[0];
  if (!row) return null;

  let image: { url: string; alt: string | null } | null = null;
  if (row.media_object_id) {
    const resolved = await mediaPort.resolveMediaReferences(tx, tenantId, [
      row.media_object_id
    ]);
    const entry = resolved.get(row.media_object_id);
    if (entry) image = { url: entry.publicUrl, alt: entry.altText };
  }

  return {
    id: row.id,
    title: row.title,
    body: row.body,
    image,
    linkUrl: row.link_url,
    buttonText: row.button_text,
    frequency: row.frequency as PopupFrequency,
    startsAt: row.starts_at ? row.starts_at.toISOString() : null,
    endsAt: row.ends_at ? row.ends_at.toISOString() : null
  };
}
