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
import { resolveModuleEnabled } from "../../identity-access/application/auth-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  COMMISSION_DEFAULT_SOURCE_TYPE,
  commissionReadinessState,
  decideSettingsChange,
  isLineFullyReturned,
  type CommissionReadinessState,
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

export type CommissionReadiness = {
  state: CommissionReadinessState;
  hrCommissionModuleEnabled: boolean;
  lastSubmittedAt: string | null;
};

/**
 * What the settings answer says about the path to the ledger (ADR-0046 D12).
 * Commerce may not read a commission or payroll table, so this is the module
 * registry's answer plus commerce's own submission record - it cannot tell
 * whether the intake switch is on, and says so (the docs and the OpenAPI name
 * `hr_commission`'s own settings route) instead of guessing.
 */
export async function fetchCommissionReadiness(
  tx: Bun.SQL,
  tenantId: string,
  settings: CommissionSettings
): Promise<CommissionReadiness> {
  const hrCommissionModuleEnabled = await resolveModuleEnabled(
    tx,
    tenantId,
    "hr_commission"
  );
  const lastSubmittedAt = await fetchLastSubmissionAt(tx, tenantId);
  return {
    state: commissionReadinessState({
      enabled: settings.enabled,
      hrCommissionModuleEnabled,
      lastSubmittedAt
    }),
    hrCommissionModuleEnabled,
    lastSubmittedAt
  };
}

function settingsLockKey(tenantId: string): string {
  return `commerce.commission.settings|${tenantId}`;
}

/**
 * The tenant-scoped advisory lock that makes "settings fixed while an
 * attribution is in flight" true. The consumer takes it SHARED before it reads
 * the settings and holds it to the end of its transaction (so concurrent
 * deliveries do not block each other); the settings update takes it EXCLUSIVE,
 * so it waits for every in-flight attribution and every later one waits for it.
 * Same shape as `commerce-inventory.ts`'s mode lock.
 */
export async function lockCommissionSettings(
  tx: Bun.SQL,
  tenantId: string,
  exclusive: boolean
): Promise<void> {
  const key = settingsLockKey(tenantId);
  if (exclusive) {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  } else {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
  }
}

/**
 * Records that accruals have been reported under this `(sourceType, ruleKey)`
 * pair, in the caller's (the consumer's) transaction. Idempotent.
 */
export async function recordAttributedSource(
  tx: Bun.SQL,
  tenantId: string,
  sourceType: string,
  ruleKey: string
): Promise<void> {
  await tx`
    INSERT INTO awcms_commerce_commission_attributed_sources
      (tenant_id, source_type, rule_key)
    VALUES (${tenantId}, ${sourceType}, ${ruleKey})
    ON CONFLICT (tenant_id, source_type, rule_key) DO NOTHING
  `;
}

/**
 * A per-order, transaction-scoped advisory lock taken by BOTH the attributor and
 * the reversers before they read the order (issue #449, ADR-0046 D11). Without
 * it a delayed attributor and a reverser for the same order can interleave: the
 * attributor reads "not fully returned", the return completes, the reverser runs
 * its void against an accrual that does not exist yet, and the attributor then
 * accrues the line - an accrual nothing ever voids. With it the second of the
 * two always sees the first's committed effect. Exclusive in both directions:
 * the work under it is short and per order, so nothing contends on it.
 */
export async function lockCommissionOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`commerce.commission.order|${tenantId}|${orderId}`}, 0))`;
}

/**
 * What has already come back of an order, across all `completed` returns
 * (`isLineFullyReturned`, the reverser's own rule): the lines returned in full,
 * and how many lines are only partly returned. An attributor that runs after the
 * refund reverser must not accrue a fully returned line: the reverser has
 * already run and nothing would ever void the accrual. A partly returned line is
 * accrued whole (the port voids a whole accrual or nothing, D9) and only counted,
 * so the audit row can tell a person.
 */
export async function readReturnedLines(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<{ fullyReturned: Set<string>; partiallyReturned: number }> {
  const rows = (await tx`
    SELECT oi.id,
           oi.quantity::int AS ordered,
           COALESCE(SUM(rl.quantity), 0)::int AS returned
    FROM awcms_commerce_order_items oi
    JOIN awcms_commerce_return_lines rl
      ON rl.tenant_id = oi.tenant_id AND rl.order_item_id = oi.id
    JOIN awcms_commerce_returns r
      ON r.tenant_id = rl.tenant_id AND r.id = rl.return_id
         AND r.order_id = oi.order_id AND r.status = 'completed'
    WHERE oi.tenant_id = ${tenantId} AND oi.order_id = ${orderId}
    GROUP BY oi.id, oi.quantity
  `) as { id: string; ordered: number; returned: number }[];
  const full = rows.filter((row) =>
    isLineFullyReturned(Number(row.ordered), Number(row.returned))
  );
  return {
    fullyReturned: new Set(full.map((row) => row.id)),
    partiallyReturned: rows.length - full.length
  };
}

export type SaveCommissionSettingsOutcome =
  | { kind: "saved"; settings: CommissionSettings }
  | { kind: "source_locked"; fields: ("sourceType" | "ruleKey")[] };

export async function saveCommissionSettings(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CommissionSettingsInput,
  correlationId?: string
): Promise<SaveCommissionSettingsOutcome> {
  await lockCommissionSettings(tx, tenantId, true);
  const before = await fetchCommissionSettings(tx, tenantId);

  const markerRows = (await tx`
    SELECT 1 AS present
    FROM awcms_commerce_commission_attributed_sources
    WHERE tenant_id = ${tenantId}
    LIMIT 1
  `) as unknown[];
  const decision = decideSettingsChange({
    stored: before,
    requested: input,
    attributionsExist: markerRows.length > 0
  });
  if (decision.kind === "source_locked") {
    // The route answers 409 as a RETURNED response, which still commits this
    // transaction, so the refusal's audit row is kept.
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "commerce.commission.settings_refused",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: tenantId,
      severity: "warning",
      message:
        "A change to the commission source identity was refused because accruals already exist.",
      attributes: {
        fields: decision.fields,
        stored: { ruleKey: before.ruleKey, sourceType: before.sourceType },
        requested: { ruleKey: input.ruleKey, sourceType: input.sourceType }
      },
      correlationId
    });
    return decision;
  }

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

  return { kind: "saved", settings };
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

/**
 * The employment a login's counter sales were credited to AT `asOf` - the
 * sale's `paid_at`, never "now" (issue #449, ADR-0046 D11) - or `null` when the
 * login had no staff link then.
 *
 * A link covers the half-open interval `[created_at, retired_at)`, so a retire
 * and a new link written in one transaction (a correction) hand over at that
 * very instant with no overlap and no gap. Resolving the beneficiary at the
 * moment the consumer happens to run would make the answer depend on delivery
 * delay: a link retired or re-pointed between the sale and a delayed delivery
 * would drop the sale or accrue it to the NEW employment. The loyalty earner
 * uses the same as-of (`paid_at`, ADR-0026 D3), and `created_at` / `paid_at` are
 * both the database clock.
 */
export async function findEmploymentLinkedAt(
  tx: Bun.SQL,
  tenantId: string,
  tenantUserId: string,
  asOf: Date
): Promise<{ linkId: string; employmentId: string } | null> {
  const rows = (await tx`
    SELECT id, employment_id
    FROM awcms_commerce_commission_staff_links
    WHERE tenant_id = ${tenantId} AND tenant_user_id = ${tenantUserId}
      AND created_at <= ${asOf}
      AND (retired_at IS NULL OR retired_at > ${asOf})
    ORDER BY created_at DESC, id
    LIMIT 1
  `) as { id: string; employment_id: string }[];
  const row = rows[0];
  return row ? { linkId: row.id, employmentId: row.employment_id } : null;
}

// ---------------------------------------------------------------------------
// Submissions (Issue #391, ADR-0046 D12): what was reported to the intake queue
// ---------------------------------------------------------------------------

export type CommissionSubmission = {
  orderItemId: string;
  employmentId: string;
  sourceType: string;
  ruleKey: string;
};

/**
 * Records that the order line was submitted to the commission intake for the
 * employment, in the CALLER's transaction (the same one that wrote the intake
 * record, so both commit or neither does). Idempotent: a replayed delivery
 * writes nothing. Commerce's OWN state - it never reads the queue or the ledger.
 */
export async function recordSubmission(
  tx: Bun.SQL,
  tenantId: string,
  submission: CommissionSubmission & { orderId: string }
): Promise<void> {
  await tx`
    INSERT INTO awcms_commerce_commission_submissions
      (tenant_id, order_id, order_item_id, employment_id, source_type, rule_key)
    VALUES (${tenantId}, ${submission.orderId}, ${submission.orderItemId},
            ${submission.employmentId}, ${submission.sourceType}, ${submission.ruleKey})
    ON CONFLICT (tenant_id, source_type, order_item_id, employment_id) DO NOTHING
  `;
}

/**
 * Every submission recorded for an order, oldest first. A reversal voids exactly
 * these (never a guess from the staff links, which would queue voids for
 * accruals that never existed and fill the intake exceptions list).
 */
export async function listSubmissionsForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<CommissionSubmission[]> {
  const rows = (await tx`
    SELECT order_item_id, employment_id, source_type, rule_key
    FROM awcms_commerce_commission_submissions
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
    ORDER BY created_at, order_item_id, employment_id
  `) as {
    order_item_id: string;
    employment_id: string;
    source_type: string;
    rule_key: string;
  }[];
  return rows.map((row) => ({
    orderItemId: row.order_item_id,
    employmentId: row.employment_id,
    sourceType: row.source_type,
    ruleKey: row.rule_key
  }));
}

/** When commerce last submitted a line for the tenant; `null` if it never has. */
export async function fetchLastSubmissionAt(
  tx: Bun.SQL,
  tenantId: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT created_at
    FROM awcms_commerce_commission_submissions
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC
    LIMIT 1
  `) as { created_at: Date | string }[];
  const row = rows[0];
  return row ? toIso(row.created_at) : null;
}

/**
 * The person who caused a domain event (`awcms_domain_events.actor_tenant_user_id`,
 * stamped by the producer in the same transaction as the fact). The event
 * envelope does not reach a consumer's handler, so a reverser reads its OWN
 * delivered event's actor here (the worker holds SELECT on the table, sql/022).
 * `null` when the producer had no person (a system action): the intake then
 * answers `actor_required` and a human decides.
 */
export async function fetchEventActor(
  tx: Bun.SQL,
  tenantId: string,
  eventId: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT actor_tenant_user_id
    FROM awcms_domain_events
    WHERE tenant_id = ${tenantId} AND id = ${eventId}
  `) as { actor_tenant_user_id: string | null }[];
  return rows[0]?.actor_tenant_user_id ?? null;
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
