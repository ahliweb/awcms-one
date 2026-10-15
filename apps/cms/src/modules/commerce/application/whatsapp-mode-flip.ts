/**
 * The guarded per-tenant WhatsApp mode flip and its drain report (Issue #393,
 * ADR-0133 section 6 phase 3, ADR-0047 "Cutover"). The ONE writer of
 * `whatsapp_mode` / `whatsapp_mode_changed_at`; the CLI
 * (`scripts/commerce-whatsapp-cutover.ts`) and the admin route
 * (`POST /api/v1/commerce/whatsapp/mode`) both call `flipWhatsappMode` and
 * nothing else, so the rule cannot differ between them
 * (`tests/commerce-whatsapp-upstream-boundary.test.ts` fails if a second file
 * writes the column).
 *
 * ## What it does, inside the caller's tenant transaction
 *
 *   1. takes the EXCLUSIVE mode lock (`lockWhatsappModeExclusive`): every
 *      in-flight enqueue that read the old mode commits first (so its row is
 *      visible to the count below), and every later enqueue waits, then reads
 *      the new mode. This is what makes "two live queues for one tenant never
 *      coexist" a property of the database and not of timing: after the count, a
 *      legacy row for this tenant cannot appear until the transaction ends, and
 *      by then the mode says `upstream`;
 *   2. reads the current mode and the state of BOTH queues;
 *   3. decides (`assessWhatsappFlip`, pure): the queue being left must hold no
 *      non-terminal row, the queue being entered must be able to send, and the
 *      differences between the queues must be acknowledged;
 *   4. unless it is a dry run, writes the mode and one audit event - on a
 *      refusal only the audit event of the refused attempt (`flip_refused`).
 *
 * It never copies a row and never writes a message table: the old dispatcher
 * drains the old queue to a terminal state (it stays, ADR-0047 D3), only new
 * messages enter the new one.
 *
 * ## The reverse flip (`upstream` -> `legacy`)
 *
 * Symmetric, and it is a rollback, so it matters most when the new channel
 * misbehaves: it is refused while the upstream queue holds non-terminal rows for
 * the tenant. The count comes from `summarizeWhatsappQueue`, the `whatsapp_delivery`
 * module's own read for its operator screen - the sanctioned way to look at
 * that queue; commerce never selects from its table. That read is TENANT-wide,
 * not commerce-only, because the module offers no per-template count: a
 * tenant that also queues booking reminders in the upstream queue waits for
 * those too. There is deliberately no override: the rows are drained by the
 * upstream dispatcher regardless of commerce's mode, so waiting is always
 * sufficient, whereas an override would recreate the two-live-queues state the
 * rule exists to prevent. If the upstream dispatcher is down, bringing it up
 * (or letting security messages expire) is the way to a clean rollback.
 *
 * ## Environment
 *
 * The channel checks read the environment of THE PROCESS RUNNING THE FLIP
 * (`WHATSAPP_ENABLED`, `COMMERCE_WHATSAPP_ENABLED`, `WHATSAPP_PROVIDER`,
 * `WHATSAPP_RECIPIENT_HASH_KEYS`). The dispatchers are separate processes: run
 * the CLI with the same environment file as `whatsapp:dispatch`, or the check
 * answers for a deployment that is not the one that will send.
 */
import { randomUUID } from "node:crypto";

import { recordAuditEvent } from "../../logging/application/audit-log";
import { fetchTenantModuleEntry } from "../../module-management/application/tenant-module-lifecycle";
import { summarizeWhatsappQueue } from "../../whatsapp-delivery/application/whatsapp-diagnostics";
import {
  isKnownWhatsappProvider,
  isWhatsappEnabled
} from "../../whatsapp-delivery/domain/whatsapp-config";
import { parseRecipientHashKeys } from "../../whatsapp-delivery/domain/whatsapp-recipient";
import {
  UPSTREAM_TERMINAL_STATUSES,
  assessWhatsappFlip,
  buildQueueDrain,
  validateFlipReason,
  type ChannelFacts,
  type ConsentFacts,
  type FlipBlocker,
  type FlipRefusalCode,
  type FlipWarning,
  type QueueDrain
} from "../domain/whatsapp-cutover";
import { isWhatsappChannelEnabled } from "../domain/whatsapp-config";
import type { WhatsappMode } from "../domain/whatsapp-mode";
import { fetchStoreSettings } from "./store-settings-directory";
import { summarizeLegacyWhatsappQueue } from "./whatsapp-message-directory";
import { lockWhatsappModeExclusive, readWhatsappMode } from "./whatsapp-mode";

export const WHATSAPP_MODE_FLIP_AUDIT_ACTION = "whatsapp_mode.flip";
export const WHATSAPP_MODE_FLIP_REFUSED_AUDIT_ACTION =
  "whatsapp_mode.flip_refused";
export const WHATSAPP_MODE_RESOURCE_TYPE = "commerce_whatsapp_mode";
export const WHATSAPP_MODE_EVIDENCE_SCHEMA =
  "awcms.commerce.whatsapp_mode_flip/v1";

const MODULE_KEY = "commerce";
const UPSTREAM_MODULE_KEY = "whatsapp_delivery";

export type FlipActor = {
  /** The signed-in operator, or `null` for the CLI (which runs as the deployment, not as a tenant user). */
  tenantUserId: string | null;
  surface: "api" | "cli";
  /** A free-text label the CLI operator gave (`--operator`), recorded as written. */
  operator?: string;
};

export type FlipOptions = {
  /** Why - mandatory, recorded in the audit event and the evidence. */
  reason: string;
  /** The mode the caller believes the tenant is in; a mismatch refuses `MODE_CHANGED`. */
  expected?: WhatsappMode;
  /** The operator has read the warnings. Required for a flip into `upstream`. */
  acknowledgeWarnings?: boolean;
  /** Run the whole decision, write nothing (not even the audit event). */
  dryRun?: boolean;
  correlationId?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

/** What the CLI prints and the route returns: the record a runbook attaches. */
export type FlipEvidence = {
  schema: typeof WHATSAPP_MODE_EVIDENCE_SCHEMA;
  tenantId: string;
  from: WhatsappMode;
  to: WhatsappMode;
  outcome: FlipOutcome;
  dryRun: boolean;
  reason: string;
  at: string;
  surface: FlipActor["surface"];
  operator: string | null;
  queues: { legacy: QueueDrain; upstream: QueueDrain };
  channel: ChannelFacts;
  consent: ConsentFacts;
  blockers: FlipBlocker[];
  warnings: FlipWarning[];
  warningsAcknowledged: boolean;
  refusal: { code: FlipRefusalCode; message: string } | null;
  /** The `awcms_audit_events` row of the flip or of the refused attempt; `null` for a dry run or an unchanged tenant. */
  auditEventId: string | null;
  correlationId: string;
};

/** `would_flip` is a dry run that would have been allowed. */
export type FlipOutcome = "flipped" | "would_flip" | "unchanged" | "refused";

export type FlipResult = { outcome: FlipOutcome; evidence: FlipEvidence };

type Gathered = {
  current: WhatsappMode;
  changedAt: string | null;
  legacy: QueueDrain;
  upstream: QueueDrain;
  channel: ChannelFacts;
  consent: ConsentFacts;
};

function readChangedAt(
  rows: { whatsapp_mode_changed_at: Date | null }[]
): string | null {
  return rows[0]?.whatsapp_mode_changed_at?.toISOString() ?? null;
}

/** The environment-derived half of the channel facts. Pure given `env`. */
export function readChannelFacts(
  env: NodeJS.ProcessEnv,
  upstreamModuleEnabled: boolean
): ChannelFacts {
  const provider = env.WHATSAPP_PROVIDER?.trim() || null;

  return {
    legacyEnabled: isWhatsappChannelEnabled(env),
    upstreamEnabled: isWhatsappEnabled(env),
    upstreamModuleEnabled,
    upstreamHashKeysUsable: parseRecipientHashKeys(env).ok,
    upstreamProvider: provider,
    upstreamProviderKnown: isKnownWhatsappProvider(provider ?? undefined)
  };
}

async function gather(
  tx: Bun.SQL,
  tenantId: string,
  env: NodeJS.ProcessEnv,
  now: Date
): Promise<Gathered> {
  const current = await readWhatsappMode(tx, tenantId);
  const changed = (await tx`
    SELECT whatsapp_mode_changed_at
    FROM awcms_commerce_store_settings
    WHERE tenant_id = ${tenantId}
  `) as { whatsapp_mode_changed_at: Date | null }[];

  const legacy = await summarizeLegacyWhatsappQueue(tx, tenantId);

  const summary = await summarizeWhatsappQueue(tx, tenantId);
  // The queue reports the oldest QUEUED / RETRY_WAIT row, not the oldest
  // `sending` one; a `sending` row is by definition being worked on.
  const upstream = buildQueueDrain(
    summary.countsByStatus,
    UPSTREAM_TERMINAL_STATUSES,
    summary.oldestPendingAt
      ? Math.max(
          0,
          Math.floor(
            (now.getTime() - new Date(summary.oldestPendingAt).getTime()) / 1000
          )
        )
      : null
  );

  const moduleEntry = await fetchTenantModuleEntry(
    tx,
    tenantId,
    UPSTREAM_MODULE_KEY
  );

  const optIns = (await tx`
    SELECT count(*) AS count
    FROM awcms_commerce_customer_accounts
    WHERE tenant_id = ${tenantId}
      AND marketing_consent_at IS NOT NULL AND deleted_at IS NULL
  `) as { count: string | number }[];

  return {
    current,
    changedAt: readChangedAt(changed),
    legacy,
    upstream,
    channel: readChannelFacts(env, moduleEntry?.tenantEnabled ?? false),
    consent: {
      commerceMarketingOptIns: Number(optIns[0]?.count ?? 0),
      upstreamGrantedConsents: summary.grantedConsents
    }
  };
}

/**
 * Writes the mode. A flip into `upstream` also makes sure the settings row is
 * LIVE and holds real settings, the pattern `commerce-inventory-cutover.ts`
 * uses: a row stamped by a "reset to defaults" is hard-purged by the retention
 * engine and would take the mode with it. `fetchStoreSettings` answers the live
 * blob or the defaults, so writing it back changes nothing visible. A flip back
 * to `legacy` only updates: the row exists (the tenant was `upstream`).
 */
async function writeMode(
  tx: Bun.SQL,
  tenantId: string,
  target: WhatsappMode
): Promise<void> {
  if (target === "upstream") {
    const settings = await fetchStoreSettings(tx, tenantId);
    await tx`
      INSERT INTO awcms_commerce_store_settings
        (tenant_id, settings, whatsapp_mode, whatsapp_mode_changed_at)
      VALUES (${tenantId}, ${settings}::jsonb, 'upstream', now())
      ON CONFLICT (tenant_id) DO UPDATE
        SET whatsapp_mode = 'upstream',
            whatsapp_mode_changed_at = now(),
            updated_at = now(),
            settings = CASE
              WHEN awcms_commerce_store_settings.deleted_at IS NULL
                THEN awcms_commerce_store_settings.settings
              ELSE EXCLUDED.settings
            END,
            deleted_at = NULL
    `;
    return;
  }

  await tx`
    UPDATE awcms_commerce_store_settings
    SET whatsapp_mode = 'legacy', whatsapp_mode_changed_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId}
  `;
}

async function recordAndFindAudit(
  tx: Bun.SQL,
  tenantId: string,
  action: string,
  correlationId: string,
  input: Parameters<typeof recordAuditEvent>[1]
): Promise<string | null> {
  await recordAuditEvent(tx, input);

  const rows = (await tx`
    SELECT id FROM awcms_audit_events
    WHERE tenant_id = ${tenantId} AND correlation_id = ${correlationId}
      AND action = ${action}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `) as { id: string }[];

  return rows[0]?.id ?? null;
}

/**
 * Flips the tenant's WhatsApp delivery mode to `target`, or explains why not.
 * Call it inside the tenant transaction; the caller commits on any returned
 * result (a refusal commits its audit event, a dry run commits nothing because
 * it wrote nothing). Never throws for a refusal.
 */
export async function flipWhatsappMode(
  tx: Bun.SQL,
  tenantId: string,
  actor: FlipActor,
  target: WhatsappMode,
  options: FlipOptions
): Promise<FlipResult> {
  const reason = validateFlipReason(options.reason);

  if (!reason.valid) {
    // A programming error: both surfaces validate before they open the
    // transaction. No honest result exists for it.
    throw new TypeError(`flipWhatsappMode: ${reason.message}`);
  }

  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const acknowledgeWarnings = options.acknowledgeWarnings === true;
  const correlationId =
    options.correlationId ?? `commerce-whatsapp-flip-${randomUUID()}`;

  await lockWhatsappModeExclusive(tx, tenantId);

  const facts = await gather(tx, tenantId, env, now);
  const assessment = assessWhatsappFlip({
    current: facts.current,
    target,
    ...(options.expected ? { expected: options.expected } : {}),
    legacy: facts.legacy,
    upstream: facts.upstream,
    channel: facts.channel,
    consent: facts.consent,
    acknowledgeWarnings
  });
  const decision = assessment.decision;

  const outcome: FlipOutcome =
    decision.kind === "refused"
      ? "refused"
      : decision.kind === "unchanged"
        ? "unchanged"
        : dryRun
          ? "would_flip"
          : "flipped";

  const evidence: FlipEvidence = {
    schema: WHATSAPP_MODE_EVIDENCE_SCHEMA,
    tenantId,
    from: facts.current,
    to: target,
    outcome,
    dryRun,
    reason: reason.reason,
    at: now.toISOString(),
    surface: actor.surface,
    operator: actor.operator ?? null,
    queues: { legacy: facts.legacy, upstream: facts.upstream },
    channel: facts.channel,
    consent: facts.consent,
    blockers: assessment.blockers,
    warnings: assessment.warnings,
    warningsAcknowledged: acknowledgeWarnings,
    refusal:
      decision.kind === "refused"
        ? { code: decision.code, message: decision.message }
        : null,
    auditEventId: null,
    correlationId
  };

  if (dryRun || decision.kind === "unchanged") {
    return { outcome, evidence };
  }

  const attributes = {
    from: facts.current,
    to: target,
    reason: reason.reason,
    surface: actor.surface,
    operator: actor.operator ?? null,
    legacyNonTerminal: facts.legacy.nonTerminal,
    upstreamNonTerminal: facts.upstream.nonTerminal,
    warningCodes: assessment.warnings.map((warning) => warning.code),
    warningsAcknowledged: acknowledgeWarnings
  };

  if (decision.kind === "refused") {
    evidence.auditEventId = await recordAndFindAudit(
      tx,
      tenantId,
      WHATSAPP_MODE_FLIP_REFUSED_AUDIT_ACTION,
      correlationId,
      {
        tenantId,
        ...(actor.tenantUserId
          ? { actorTenantUserId: actor.tenantUserId }
          : {}),
        moduleKey: MODULE_KEY,
        action: WHATSAPP_MODE_FLIP_REFUSED_AUDIT_ACTION,
        resourceType: WHATSAPP_MODE_RESOURCE_TYPE,
        resourceId: tenantId,
        severity: "warning",
        message: `A WhatsApp mode flip ${facts.current} -> ${target} was refused (${decision.code}).`,
        attributes: {
          ...attributes,
          refusalCode: decision.code,
          blockerCodes: assessment.blockers.map((blocker) => blocker.code)
        },
        correlationId
      }
    );

    return { outcome, evidence };
  }

  await writeMode(tx, tenantId, target);

  evidence.auditEventId = await recordAndFindAudit(
    tx,
    tenantId,
    WHATSAPP_MODE_FLIP_AUDIT_ACTION,
    correlationId,
    {
      tenantId,
      ...(actor.tenantUserId ? { actorTenantUserId: actor.tenantUserId } : {}),
      moduleKey: MODULE_KEY,
      action: WHATSAPP_MODE_FLIP_AUDIT_ACTION,
      resourceType: WHATSAPP_MODE_RESOURCE_TYPE,
      resourceId: tenantId,
      severity: "warning",
      message: `New WhatsApp messages of the tenant now go to the ${target} queue (was ${facts.current}).`,
      attributes,
      correlationId
    }
  );

  return { outcome, evidence };
}

export type WhatsappModeStatus = {
  mode: WhatsappMode;
  changedAt: string | null;
  queues: { legacy: QueueDrain; upstream: QueueDrain };
  channel: ChannelFacts;
  consent: ConsentFacts;
  /** What a flip to the OTHER mode would face right now (warnings assumed acknowledged, so only blockers decide). */
  flip: {
    to: WhatsappMode;
    allowed: boolean;
    blockers: FlipBlocker[];
    warnings: FlipWarning[];
  };
};

/**
 * The mode and the drain state of both queues (`GET .../whatsapp/mode`, and the
 * CLI's `--status`). Takes NO lock: it reads a snapshot for an operator, and a
 * flip re-reads everything under the exclusive lock before it acts.
 */
export async function readWhatsappModeStatus(
  tx: Bun.SQL,
  tenantId: string,
  options: { env?: NodeJS.ProcessEnv; now?: Date } = {}
): Promise<WhatsappModeStatus> {
  const facts = await gather(
    tx,
    tenantId,
    options.env ?? process.env,
    options.now ?? new Date()
  );
  const to: WhatsappMode = facts.current === "legacy" ? "upstream" : "legacy";
  const assessment = assessWhatsappFlip({
    current: facts.current,
    target: to,
    legacy: facts.legacy,
    upstream: facts.upstream,
    channel: facts.channel,
    consent: facts.consent,
    acknowledgeWarnings: true
  });

  return {
    mode: facts.current,
    changedAt: facts.changedAt,
    queues: { legacy: facts.legacy, upstream: facts.upstream },
    channel: facts.channel,
    consent: facts.consent,
    flip: {
      to,
      allowed: assessment.decision.kind === "allowed",
      blockers: assessment.blockers,
      warnings: assessment.warnings
    }
  };
}
