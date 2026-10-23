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
 * misbehaves. It is refused while the upstream queue holds a non-terminal row OF
 * COMMERCE for the tenant (issue #449, ADR-0047 D12):
 *
 *   * The upstream queue is shared by every module of the tenant. Counting it
 *     whole made a booking reminder block a commerce rollback, so only the rows
 *     of the templates commerce registered (`COMMERCE_UPSTREAM_TEMPLATE_PLANS`)
 *     count; the rest are reported as `upstreamUnrelated` and never block.
 *   * The rows are read through `whatsapp_delivery`'s own operator read
 *     (`listRecentWhatsappMessages`, per non-terminal status, masked columns
 *     only) - the sanctioned way to look at that queue; commerce still never
 *     selects from its table. A status holding more than the page limit cannot be
 *     attributed row by row, so the remainder is counted AS commerce's (the safe
 *     direction: a rollback that wrongly waits is annoying, one that wrongly
 *     proceeds strands a row) and the evidence says the count is not exact.
 *   * `force` overrides the one case scoping cannot help: commerce's own rows in
 *     `retry_wait` behind the very provider failure that is the reason to roll
 *     back. It bypasses `DRAIN_PENDING` and nothing else, is available only for a
 *     rollback, is audited under its own action (`whatsapp_mode.flip_forced`) with
 *     the counts it bypassed, and the surfaces demand an accountable operator (the
 *     API: the `manage` permission and a recent step-up like any real flip; the
 *     CLI: `--operator`). The bypassed rows are not touched: the upstream
 *     dispatcher keeps working them whatever commerce's mode is, so they still
 *     reach a terminal state (or expire) and a late message is the cost.
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
import {
  listRecentWhatsappMessages,
  summarizeWhatsappQueue,
  type WhatsappMessageStatusValue
} from "../../whatsapp-delivery/application/whatsapp-diagnostics";
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
import { isKnownWhatsappTemplateKey } from "../domain/whatsapp-templates";
import { fetchStoreSettings } from "./store-settings-directory";
import { summarizeLegacyWhatsappQueue } from "./whatsapp-message-directory";
import { lockWhatsappModeExclusive, readWhatsappMode } from "./whatsapp-mode";

export const WHATSAPP_MODE_FLIP_AUDIT_ACTION = "whatsapp_mode.flip";
export const WHATSAPP_MODE_FLIP_REFUSED_AUDIT_ACTION =
  "whatsapp_mode.flip_refused";
/** A rollback that overrode a pending drain (issue #449): its own action so it can be alerted on. */
export const WHATSAPP_MODE_FLIP_FORCED_AUDIT_ACTION =
  "whatsapp_mode.flip_forced";
export const WHATSAPP_MODE_RESOURCE_TYPE = "commerce_whatsapp_mode";
export const WHATSAPP_MODE_EVIDENCE_SCHEMA =
  "awcms.commerce.whatsapp_mode_flip/v1";

const MODULE_KEY = "commerce";
const UPSTREAM_MODULE_KEY = "whatsapp_delivery";

/**
 * What an operator must know about where the channel facts came from (issue
 * #449). `WHATSAPP_ENABLED`, `COMMERCE_WHATSAPP_ENABLED`, `WHATSAPP_PROVIDER` and
 * `WHATSAPP_RECIPIENT_HASH_KEYS` are read from the environment of the process
 * that ran the call, and the dispatchers that will actually send are other
 * processes, often other containers with their own environment.
 */
export function channelEnvironmentNotice(surface: "api" | "cli"): string {
  const where =
    surface === "api"
      ? "the web (CMS) server process that handled this request"
      : "the process running this command";

  return `The channel facts (WHATSAPP_ENABLED, COMMERCE_WHATSAPP_ENABLED, WHATSAPP_PROVIDER, WHATSAPP_RECIPIENT_HASH_KEYS) were read from the environment of ${where}, not from the WhatsApp dispatchers (whatsapp:dispatch, commerce:whatsapp:dispatch) that will send. If their environment differs, a passing check does not prove the channel works: send a test message after the flip.`;
}

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
  /**
   * Roll back although commerce's own rows are still non-terminal in the upstream
   * queue (issue #449). `upstream` -> `legacy` only; the surfaces validate that
   * and name an accountable operator. See the header.
   */
  force?: boolean;
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
  /** `upstream` counts COMMERCE's non-terminal rows only (the ones this cutover moves); `upstreamScope` says what was left out. */
  queues: {
    legacy: QueueDrain;
    upstream: QueueDrain;
    upstreamScope: UpstreamScope;
  };
  channel: ChannelFacts;
  consent: ConsentFacts;
  blockers: FlipBlocker[];
  warnings: FlipWarning[];
  warningsAcknowledged: boolean;
  /** The rollback override: was it asked for, and did it actually bypass a drain that would have blocked? */
  force: { requested: boolean; applied: boolean; bypassedNonTerminal: number };
  /**
   * Where the channel facts above were read, in words. They are the environment
   * of the process that ran this call, which is not the dispatcher's.
   */
  channelEnvironmentNotice: string;
  refusal: { code: FlipRefusalCode; message: string } | null;
  /** The `awcms_audit_events` row of the flip or of the refused attempt; `null` for a dry run or an unchanged tenant. */
  auditEventId: string | null;
  correlationId: string;
};

/** `would_flip` is a dry run that would have been allowed. */
export type FlipOutcome = "flipped" | "would_flip" | "unchanged" | "refused";

export type FlipResult = { outcome: FlipOutcome; evidence: FlipEvidence };

/** How the upstream queue was attributed to commerce (issue #449). */
export type UpstreamScope = {
  /** Non-terminal upstream rows that are NOT commerce's: informational, never a blocker. */
  unrelatedNonTerminal: number;
  /** `false` when a status held more rows than one page and the remainder was counted as commerce's (fail closed). */
  commerceCountExact: boolean;
};

type Gathered = {
  current: WhatsappMode;
  changedAt: string | null;
  legacy: QueueDrain;
  upstream: QueueDrain;
  upstreamScope: UpstreamScope;
  channel: ChannelFacts;
  consent: ConsentFacts;
};

/** One page of the operator read per non-terminal status: far above a healthy queue, bounded for a runaway one. */
export const UPSTREAM_DRAIN_PAGE_LIMIT = 500;

const UPSTREAM_NON_TERMINAL_STATUSES: readonly WhatsappMessageStatusValue[] = [
  "queued",
  "retry_wait",
  "sending"
];

/**
 * The tenant's upstream queue split into the rows of commerce's templates (what
 * this cutover moves) and everyone else's. Counts come from the module's own
 * summary; attribution from its own paged operator read, per non-terminal
 * status. A status with more rows than one page cannot be attributed row by
 * row: the unseen remainder is counted as commerce's (fail closed) and the
 * result says it is not exact. Only NON-TERMINAL rows are attributed: terminal
 * ones are history and are not needed by any decision.
 */
async function readUpstreamDrain(
  tx: Bun.SQL,
  tenantId: string,
  now: Date
): Promise<{
  drain: QueueDrain;
  scope: UpstreamScope;
  grantedConsents: number;
}> {
  const summary = await summarizeWhatsappQueue(tx, tenantId);
  const commerceCounts: Record<string, number> = {};
  let unrelated = 0;
  let exact = true;
  let oldestCommerceMs: number | null = null;

  for (const status of UPSTREAM_NON_TERMINAL_STATUSES) {
    const total = summary.countsByStatus[status];
    if (total === 0) continue;

    const page = await listRecentWhatsappMessages(tx, tenantId, {
      status,
      limit: UPSTREAM_DRAIN_PAGE_LIMIT
    });
    let commerce = 0;

    for (const message of page.messages) {
      if (isKnownWhatsappTemplateKey(message.templateKey)) {
        commerce += 1;
        const created = new Date(message.createdAt).getTime();
        if (
          status !== "sending" &&
          (oldestCommerceMs === null || created < oldestCommerceMs)
        ) {
          oldestCommerceMs = created;
        }
      } else {
        unrelated += 1;
      }
    }
    if (page.hasMore) {
      // Not attributable: count the remainder as commerce's.
      exact = false;
      commerce += Math.max(0, total - page.messages.length);
    }
    if (commerce > 0) commerceCounts[status] = commerce;
  }

  return {
    drain: buildQueueDrain(
      commerceCounts,
      UPSTREAM_TERMINAL_STATUSES,
      oldestCommerceMs === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - oldestCommerceMs) / 1000))
    ),
    scope: { unrelatedNonTerminal: unrelated, commerceCountExact: exact },
    grantedConsents: summary.grantedConsents
  };
}

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

  const upstreamRead = await readUpstreamDrain(tx, tenantId, now);

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
    upstream: upstreamRead.drain,
    upstreamScope: upstreamRead.scope,
    channel: readChannelFacts(env, moduleEntry?.tenantEnabled ?? false),
    consent: {
      commerceMarketingOptIns: Number(optIns[0]?.count ?? 0),
      upstreamGrantedConsents: upstreamRead.grantedConsents
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
  const force = options.force === true;

  if (force && target !== "legacy") {
    // A programming error: both surfaces refuse it as a usage error first. A
    // flip INTO upstream never skips the drain.
    throw new TypeError(
      "flipWhatsappMode: force applies to a rollback (target legacy) only."
    );
  }
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
    acknowledgeWarnings,
    upstreamUnrelated: facts.upstreamScope.unrelatedNonTerminal,
    forceDrain: force
  });
  const decision = assessment.decision;
  const forced = assessment.overridden !== null;

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
    queues: {
      legacy: facts.legacy,
      upstream: facts.upstream,
      upstreamScope: facts.upstreamScope
    },
    channel: facts.channel,
    consent: facts.consent,
    blockers: assessment.blockers,
    warnings: assessment.warnings,
    warningsAcknowledged: acknowledgeWarnings,
    force: {
      requested: force,
      applied: forced,
      bypassedNonTerminal: forced ? facts.upstream.nonTerminal : 0
    },
    channelEnvironmentNotice: channelEnvironmentNotice(actor.surface),
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
    upstreamUnrelatedNonTerminal: facts.upstreamScope.unrelatedNonTerminal,
    upstreamCountExact: facts.upstreamScope.commerceCountExact,
    forced,
    ...(forced ? { bypassedNonTerminal: facts.upstream.nonTerminal } : {}),
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

  const action = forced
    ? WHATSAPP_MODE_FLIP_FORCED_AUDIT_ACTION
    : WHATSAPP_MODE_FLIP_AUDIT_ACTION;

  evidence.auditEventId = await recordAndFindAudit(
    tx,
    tenantId,
    action,
    correlationId,
    {
      tenantId,
      ...(actor.tenantUserId ? { actorTenantUserId: actor.tenantUserId } : {}),
      moduleKey: MODULE_KEY,
      action,
      resourceType: WHATSAPP_MODE_RESOURCE_TYPE,
      resourceId: tenantId,
      severity: "warning",
      message: forced
        ? `New WhatsApp messages of the tenant now go to the ${target} queue (was ${facts.current}); the rollback was FORCED over ${facts.upstream.nonTerminal} non-terminal commerce message(s) still in the upstream queue.`
        : `New WhatsApp messages of the tenant now go to the ${target} queue (was ${facts.current}).`,
      attributes,
      correlationId
    }
  );

  return { outcome, evidence };
}

export type WhatsappModeStatus = {
  mode: WhatsappMode;
  changedAt: string | null;
  queues: {
    legacy: QueueDrain;
    upstream: QueueDrain;
    upstreamScope: UpstreamScope;
  };
  /** Where `channel` was read (see {@link channelEnvironmentNotice}); the web process, not the dispatchers. */
  channelEnvironmentNotice: string;
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
  options: {
    env?: NodeJS.ProcessEnv;
    now?: Date;
    surface?: FlipActor["surface"];
  } = {}
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
    upstreamUnrelated: facts.upstreamScope.unrelatedNonTerminal,
    channel: facts.channel,
    consent: facts.consent,
    acknowledgeWarnings: true
  });

  return {
    mode: facts.current,
    changedAt: facts.changedAt,
    queues: {
      legacy: facts.legacy,
      upstream: facts.upstream,
      upstreamScope: facts.upstreamScope
    },
    channelEnvironmentNotice: channelEnvironmentNotice(
      options.surface ?? "api"
    ),
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
