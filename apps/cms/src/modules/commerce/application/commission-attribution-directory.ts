/**
 * Employee-commission attribution: the tenant's settings and the staff links
 * (Issue #391, ADR-0046). The ONLY writer of `awcms_commerce_commission_settings`
 * and `awcms_commerce_commission_staff_links`; `application/commission-attribution.ts`
 * (the order-paid consumer) only reads them.
 *
 * Both writes are high-risk administrator decisions about who is paid, so each
 * one is audited at `warning` with the identifiers that make it reviewable (a
 * login id and an employment id are opaque uuids; no name, no amount, no
 * contact). Neither is idempotent through a key store because each is already
 * idempotent by state: a settings `PUT` is an upsert, a second link for a login
 * that has a live one is `409`, and retiring a retired link is `409`.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  COMMISSION_DEFAULT_SOURCE_TYPE,
  type CommissionSettingsInput,
  type CreateStaffLinkInput
} from "../domain/commission-attribution";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_commission_attribution";
const POSTGRES_UNIQUE_VIOLATION = "23505";

/** Hard cap on one list answer: a tenant has a handful of staff, not thousands. */
export const COMMISSION_STAFF_LINK_LIST_LIMIT = 200;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type CommissionSettings = {
  enabled: boolean;
  ruleKey: string | null;
  sourceType: string;
  /** `null` while the tenant has never saved settings (the defaults are in force). */
  updatedAt: string | null;
};

type SettingsRow = {
  enabled: boolean;
  rule_key: string | null;
  source_type: string;
  updated_at: Date | string;
};

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/** The defaults in force for a tenant that has never saved settings: OFF, no rule. */
export const DEFAULT_COMMISSION_SETTINGS: CommissionSettings = {
  enabled: false,
  ruleKey: null,
  sourceType: COMMISSION_DEFAULT_SOURCE_TYPE,
  updatedAt: null
};

export async function fetchCommissionSettings(
  tx: Bun.SQL,
  tenantId: string
): Promise<CommissionSettings> {
  const rows = (await tx`
    SELECT enabled, rule_key, source_type, updated_at
    FROM awcms_commerce_commission_settings
    WHERE tenant_id = ${tenantId}
  `) as SettingsRow[];
  const row = rows[0];
  if (!row) return DEFAULT_COMMISSION_SETTINGS;
  return {
    enabled: row.enabled,
    ruleKey: row.rule_key,
    sourceType: row.source_type,
    updatedAt: toIso(row.updated_at)
  };
}

export async function saveCommissionSettings(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CommissionSettingsInput,
  correlationId?: string
): Promise<CommissionSettings> {
  const before = await fetchCommissionSettings(tx, tenantId);
  const rows = (await tx`
    INSERT INTO awcms_commerce_commission_settings
      (tenant_id, enabled, rule_key, source_type, updated_by_tenant_user_id)
    VALUES (${tenantId}, ${input.enabled}, ${input.ruleKey}, ${input.sourceType}, ${actorTenantUserId})
    ON CONFLICT (tenant_id) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        rule_key = EXCLUDED.rule_key,
        source_type = EXCLUDED.source_type,
        updated_by_tenant_user_id = EXCLUDED.updated_by_tenant_user_id,
        updated_at = now()
    RETURNING enabled, rule_key, source_type, updated_at
  `) as SettingsRow[];
  const row = rows[0]!;
  const settings: CommissionSettings = {
    enabled: row.enabled,
    ruleKey: row.rule_key,
    sourceType: row.source_type,
    updatedAt: toIso(row.updated_at)
  };

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.commission.settings_updated",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: tenantId,
    severity: "warning",
    message: "Employee-commission attribution settings changed.",
    attributes: {
      before: {
        enabled: before.enabled,
        ruleKey: before.ruleKey,
        sourceType: before.sourceType
      },
      after: {
        enabled: settings.enabled,
        ruleKey: settings.ruleKey,
        sourceType: settings.sourceType
      }
    },
    correlationId
  });

  return settings;
}

// ---------------------------------------------------------------------------
// Staff links
// ---------------------------------------------------------------------------

export type CommissionStaffLink = {
  id: string;
  tenantUserId: string;
  employmentId: string;
  createdByTenantUserId: string | null;
  createdAt: string;
  retiredByTenantUserId: string | null;
  retiredAt: string | null;
};

type LinkRow = {
  id: string;
  tenant_user_id: string;
  employment_id: string;
  created_by_tenant_user_id: string | null;
  created_at: Date | string;
  retired_by_tenant_user_id: string | null;
  retired_at: Date | string | null;
};

const LINK_COLUMNS = `id, tenant_user_id, employment_id, created_by_tenant_user_id,
  created_at, retired_by_tenant_user_id, retired_at`;

function toLink(row: LinkRow): CommissionStaffLink {
  return {
    id: row.id,
    tenantUserId: row.tenant_user_id,
    employmentId: row.employment_id,
    createdByTenantUserId: row.created_by_tenant_user_id,
    createdAt: toIso(row.created_at),
    retiredByTenantUserId: row.retired_by_tenant_user_id,
    retiredAt: row.retired_at === null ? null : toIso(row.retired_at)
  };
}

export async function listStaffLinks(
  tx: Bun.SQL,
  tenantId: string,
  options: { includeRetired: boolean }
): Promise<CommissionStaffLink[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(LINK_COLUMNS)}
    FROM awcms_commerce_commission_staff_links
    WHERE tenant_id = ${tenantId}
      ${tx.unsafe(options.includeRetired ? "" : "AND retired_at IS NULL")}
    ORDER BY created_at DESC, id DESC
    LIMIT ${COMMISSION_STAFF_LINK_LIST_LIMIT}
  `) as LinkRow[];
  return rows.map(toLink);
}

/** The employment a login's counter sales are credited to, or `null` when it has no LIVE link. */
export async function findLiveEmploymentForLogin(
  tx: Bun.SQL,
  tenantId: string,
  tenantUserId: string
): Promise<{ linkId: string; employmentId: string } | null> {
  const rows = (await tx`
    SELECT id, employment_id
    FROM awcms_commerce_commission_staff_links
    WHERE tenant_id = ${tenantId} AND tenant_user_id = ${tenantUserId}
      AND retired_at IS NULL
  `) as { id: string; employment_id: string }[];
  const row = rows[0];
  return row ? { linkId: row.id, employmentId: row.employment_id } : null;
}

/**
 * Every employment a login's counter sales were EVER credited to (live or
 * retired, newest first). A reversal needs these, not only the live link: the
 * link may have been retired or re-pointed between the sale and its refund, and
 * the accrual belongs to the employment that was linked when the sale was paid.
 * Voiding a source for an employment that never earned it is a harmless
 * `not_found`.
 */
export async function listEmploymentsEverLinkedToLogin(
  tx: Bun.SQL,
  tenantId: string,
  tenantUserId: string
): Promise<string[]> {
  const rows = (await tx`
    SELECT DISTINCT employment_id, created_at
    FROM awcms_commerce_commission_staff_links
    WHERE tenant_id = ${tenantId} AND tenant_user_id = ${tenantUserId}
    ORDER BY created_at DESC, employment_id
  `) as { employment_id: string }[];
  return rows.map((row) => row.employment_id);
}

/**
 * What a REVERSAL needs from the settings: the source type the accruals were
 * reported under and the person who authorised the adapter (the last tenant
 * user to save the settings), whom the ledger stamps as the voider because a
 * status edge needs a person and an event consumer has none (ADR-0046 D9).
 * `null` when the adapter was never configured: nothing can have been accrued.
 */
export async function fetchCommissionReversalContext(
  tx: Bun.SQL,
  tenantId: string
): Promise<{ sourceType: string; actorTenantUserId: string | null } | null> {
  const rows = (await tx`
    SELECT source_type, updated_by_tenant_user_id
    FROM awcms_commerce_commission_settings
    WHERE tenant_id = ${tenantId}
  `) as { source_type: string; updated_by_tenant_user_id: string | null }[];
  const row = rows[0];
  return row
    ? {
        sourceType: row.source_type,
        actorTenantUserId: row.updated_by_tenant_user_id
      }
    : null;
}

export type CreateStaffLinkOutcome =
  | { kind: "created"; link: CommissionStaffLink }
  /** The login does not exist in this tenant (indistinguishable from another tenant's: nothing to probe). */
  | { kind: "tenant_user_not_found" }
  | { kind: "login_already_linked" }
  | { kind: "employment_already_linked" };

export async function createStaffLink(
  tx: Bun.TransactionSQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateStaffLinkInput,
  correlationId?: string
): Promise<CreateStaffLinkOutcome> {
  const users = (await tx`
    SELECT id FROM awcms_tenant_users
    WHERE tenant_id = ${tenantId} AND id = ${input.tenantUserId}
  `) as { id: string }[];
  if (users.length === 0) return { kind: "tenant_user_not_found" };

  const existing = (await tx`
    SELECT tenant_user_id, employment_id
    FROM awcms_commerce_commission_staff_links
    WHERE tenant_id = ${tenantId} AND retired_at IS NULL
      AND (tenant_user_id = ${input.tenantUserId} OR employment_id = ${input.employmentId})
  `) as { tenant_user_id: string; employment_id: string }[];
  if (existing.some((row) => row.tenant_user_id === input.tenantUserId)) {
    return { kind: "login_already_linked" };
  }
  if (existing.length > 0) return { kind: "employment_already_linked" };

  let rows: LinkRow[];
  try {
    // A savepoint: the unique violation below is swallowed and mapped to an
    // outcome, which must not poison the surrounding tenant transaction.
    rows = (await tx.savepoint(
      async (sp) =>
        await sp`
      INSERT INTO awcms_commerce_commission_staff_links
        (tenant_id, tenant_user_id, employment_id, created_by_tenant_user_id)
      VALUES (${tenantId}, ${input.tenantUserId}, ${input.employmentId}, ${actorTenantUserId})
      RETURNING ${sp.unsafe(LINK_COLUMNS)}
    `
    )) as LinkRow[];
  } catch (error) {
    // A racing request created the same live link between the check and the
    // insert; the partial unique indexes are the authority.
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION
    ) {
      return String(error.constraint).includes("live_user")
        ? { kind: "login_already_linked" }
        : { kind: "employment_already_linked" };
    }
    throw error;
  }

  const link = toLink(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.commission.staff_link_created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: link.id,
    severity: "warning",
    message:
      "A login was linked to the employment that earns its sales commission.",
    attributes: {
      tenantUserId: link.tenantUserId,
      employmentId: link.employmentId
    },
    correlationId
  });

  return { kind: "created", link };
}

export type RetireStaffLinkOutcome =
  | { kind: "retired"; link: CommissionStaffLink }
  | { kind: "not_found" }
  | { kind: "already_retired" };

export async function retireStaffLink(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  linkId: string,
  correlationId?: string
): Promise<RetireStaffLinkOutcome> {
  const rows = (await tx`
    UPDATE awcms_commerce_commission_staff_links
    SET retired_at = now(), retired_by_tenant_user_id = ${actorTenantUserId}
    WHERE tenant_id = ${tenantId} AND id = ${linkId} AND retired_at IS NULL
    RETURNING ${tx.unsafe(LINK_COLUMNS)}
  `) as LinkRow[];

  if (!rows[0]) {
    const existing = (await tx`
      SELECT id FROM awcms_commerce_commission_staff_links
      WHERE tenant_id = ${tenantId} AND id = ${linkId}
    `) as { id: string }[];
    return existing.length > 0
      ? { kind: "already_retired" }
      : { kind: "not_found" };
  }

  const link = toLink(rows[0]);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.commission.staff_link_retired",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: link.id,
    severity: "warning",
    message: "A commission staff link was retired.",
    attributes: {
      tenantUserId: link.tenantUserId,
      employmentId: link.employmentId
    },
    correlationId
  });

  return { kind: "retired", link };
}
