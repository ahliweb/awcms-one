/**
 * Admin CRUD for the five canonical IRM domains (Issue #270, ADR-0002). Every
 * function here is a plain tenant-scoped query — RLS (tenant isolation only,
 * `sql/940`) is the only access boundary at the database layer; the
 * `practice_irm.domains.*` permission gate happens at the route
 * (`defineTenantRoute`'s `authorize`), same division of labour every other
 * admin CRUD surface in this codebase uses.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT,
  PRACTICE_IRM_DOMAIN_KEYS,
  type PracticeIrmDomainContent,
  type PracticeIrmDomainKey
} from "../domain/practice-irm-domain-content";

const AUDIT_MODULE_KEY = "practice_irm";
const AUDIT_RESOURCE_TYPE = "practice_irm_domain";

type DomainRow = {
  id: string;
  domain_key: string;
  name: string;
  description: string;
  copy: string;
  display_order: number;
  created_at: string;
  updated_at: string;
};

function toDomainContent(row: DomainRow): PracticeIrmDomainContent {
  return {
    id: row.id,
    domainKey: row.domain_key as PracticeIrmDomainKey,
    name: row.name,
    description: row.description,
    copy: row.copy,
    displayOrder: row.display_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Every LIVE (`deleted_at IS NULL`) row for this tenant, keyed by
 * `domain_key` — never more than five, so no pagination.
 */
async function fetchLiveDomainRows(
  tx: Bun.SQL,
  tenantId: string
): Promise<Map<PracticeIrmDomainKey, DomainRow>> {
  const rows = (await tx`
    SELECT id, domain_key, name, description, copy, display_order,
      created_at, updated_at
    FROM awcms_practice_irm_domains
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
  `) as DomainRow[];

  const map = new Map<PracticeIrmDomainKey, DomainRow>();
  for (const row of rows) {
    map.set(row.domain_key as PracticeIrmDomainKey, row);
  }
  return map;
}

/**
 * Synthesises a fallback entry for a domain key with no live row — see
 * `practice-irm-domain-content.ts`'s header: the built-in copy, never
 * persisted, `id` is a deterministic placeholder so a client can tell a
 * fallback apart from a real row if it needs to.
 */
function defaultDomainContent(
  domainKey: PracticeIrmDomainKey
): PracticeIrmDomainContent {
  const fallback = DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT[domainKey];
  return {
    id: `default:${domainKey}`,
    domainKey,
    name: fallback.name,
    description: fallback.description,
    copy: fallback.copy,
    displayOrder: fallback.displayOrder,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z"
  };
}

/**
 * All five domains, in canonical order — every key that has no live tenant
 * row falls back to the built-in default (`practice-irm-domain-content.ts`'s
 * header). This is the ONE read path both the admin screen and the
 * customer-facing content route use, so the two can never disagree about
 * what a domain currently says.
 */
export async function listPracticeIrmDomains(
  tx: Bun.SQL,
  tenantId: string
): Promise<PracticeIrmDomainContent[]> {
  const liveRows = await fetchLiveDomainRows(tx, tenantId);

  return PRACTICE_IRM_DOMAIN_KEYS.map((domainKey) => {
    const row = liveRows.get(domainKey);
    return row ? toDomainContent(row) : defaultDomainContent(domainKey);
  });
}

export async function getPracticeIrmDomain(
  tx: Bun.SQL,
  tenantId: string,
  domainKey: PracticeIrmDomainKey
): Promise<PracticeIrmDomainContent> {
  const liveRows = await fetchLiveDomainRows(tx, tenantId);
  const row = liveRows.get(domainKey);
  return row ? toDomainContent(row) : defaultDomainContent(domainKey);
}

export type CreatePracticeIrmDomainInput = {
  domainKey: PracticeIrmDomainKey;
  name: string;
  description: string;
  copy: string;
  displayOrder: number;
};

export type CreatePracticeIrmDomainResult =
  | { kind: "created"; domain: PracticeIrmDomainContent }
  | { kind: "already_exists" };

/**
 * Creates the tenant's own row for a domain key that currently has none (or
 * whose previous row was deleted — see this module's README on why "delete"
 * means "reset to default", not "gone forever"). Fails `already_exists` if a
 * LIVE row is already there — the caller should `update` instead.
 */
export async function createPracticeIrmDomain(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreatePracticeIrmDomainInput,
  correlationId?: string
): Promise<CreatePracticeIrmDomainResult> {
  const existing = (await tx`
    SELECT id FROM awcms_practice_irm_domains
    WHERE tenant_id = ${tenantId} AND domain_key = ${input.domainKey}
      AND deleted_at IS NULL
  `) as { id: string }[];

  if (existing.length > 0) return { kind: "already_exists" };

  const rows = (await tx`
    INSERT INTO awcms_practice_irm_domains
      (tenant_id, domain_key, name, description, copy, display_order)
    VALUES
      (${tenantId}, ${input.domainKey}, ${input.name}, ${input.description},
       ${input.copy}, ${input.displayOrder})
    RETURNING id, domain_key, name, description, copy, display_order,
      created_at, updated_at
  `) as DomainRow[];

  const domain = toDomainContent(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "practice_irm.domain.created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: domain.id,
    message: `Practice IRM domain "${domain.domainKey}" content created.`,
    attributes: { domainKey: domain.domainKey },
    correlationId
  });

  return { kind: "created", domain };
}

export type UpdatePracticeIrmDomainInput = {
  name?: string;
  description?: string;
  copy?: string;
  displayOrder?: number;
};

export type UpdatePracticeIrmDomainResult =
  { kind: "updated"; domain: PracticeIrmDomainContent } | { kind: "not_found" };

/**
 * Updates the tenant's LIVE row for `domainKey`. `not_found` when there is
 * none yet — the caller should `create` first (this never auto-creates,
 * so an update can never silently seed a row nobody asked for).
 */
export async function updatePracticeIrmDomain(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  domainKey: PracticeIrmDomainKey,
  input: UpdatePracticeIrmDomainInput,
  correlationId?: string
): Promise<UpdatePracticeIrmDomainResult> {
  const existingRows = (await tx`
    SELECT id, domain_key, name, description, copy, display_order,
      created_at, updated_at
    FROM awcms_practice_irm_domains
    WHERE tenant_id = ${tenantId} AND domain_key = ${domainKey}
      AND deleted_at IS NULL
  `) as DomainRow[];

  const existing = existingRows[0];
  if (!existing) return { kind: "not_found" };

  const nextName = input.name ?? existing.name;
  const nextDescription = input.description ?? existing.description;
  const nextCopy = input.copy ?? existing.copy;
  const nextDisplayOrder = input.displayOrder ?? existing.display_order;

  const rows = (await tx`
    UPDATE awcms_practice_irm_domains
    SET name = ${nextName}, description = ${nextDescription},
      copy = ${nextCopy}, display_order = ${nextDisplayOrder}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${existing.id}
    RETURNING id, domain_key, name, description, copy, display_order,
      created_at, updated_at
  `) as DomainRow[];

  const domain = toDomainContent(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "practice_irm.domain.updated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: domain.id,
    message: `Practice IRM domain "${domain.domainKey}" content updated.`,
    attributes: { domainKey: domain.domainKey },
    correlationId
  });

  return { kind: "updated", domain };
}

export type DeletePracticeIrmDomainResult =
  { kind: "deleted" } | { kind: "not_found" };

/**
 * Resets `domainKey` back to the built-in default — sets `deleted_at`, a
 * status flip never a row removal, exactly `awcms_commerce_store_settings`'
 * own "deleted means reset" convention (`sql/910`). The next read
 * (`listPracticeIrmDomains`/`getPracticeIrmDomain`) falls straight back to
 * `DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT` — the public copy is NEVER left
 * blank, only reverted to the source-authoritative baseline.
 */
export async function deletePracticeIrmDomain(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  domainKey: PracticeIrmDomainKey,
  correlationId?: string
): Promise<DeletePracticeIrmDomainResult> {
  const rows = (await tx`
    UPDATE awcms_practice_irm_domains
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND domain_key = ${domainKey}
      AND deleted_at IS NULL
    RETURNING id
  `) as { id: string }[];

  const deleted = rows[0];
  if (!deleted) return { kind: "not_found" };

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "practice_irm.domain.reset",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: deleted.id,
    message: `Practice IRM domain "${domainKey}" content reset to default.`,
    attributes: { domainKey },
    correlationId
  });

  return { kind: "deleted" };
}
