/**
 * The decision of the guarded per-tenant WhatsApp mode flip (Issue #393,
 * ADR-0133 section 6 phase 3, ADR-0047 "Cutover"). Pure: no database, no
 * environment, no clock - `application/whatsapp-mode-flip.ts` gathers the facts
 * under the exclusive mode lock and this file decides what they mean, so the
 * rule is testable without a database and cannot drift between the two surfaces
 * (the CLI and the admin route both call the one application function).
 *
 * ## The rule, in one sentence
 *
 * A tenant is in exactly one mode at a time (ADR-0133 section 6): the flip to the
 * other mode is allowed only when the queue being LEFT holds no non-terminal row
 * THE CUTOVER MOVES for the tenant, the queue being ENTERED can actually send,
 * and the operator has acknowledged every difference between the two queues that
 * the flip will make visible. Otherwise it is refused and NOTHING is written
 * except the audit of the refused attempt.
 *
 * "The rows the cutover moves" is a scoping rule (issue #449, ADR-0047 D12): the
 * legacy queue is commerce's own, so every row of it counts; the upstream queue
 * is shared by every module of the tenant (a booking reminder is also in it), so
 * only the rows of the templates COMMERCE registered count, and the rest are
 * reported (`upstreamUnrelated`) but never block a rollback. A rollback also has
 * an explicit, audited override (`force`) for the one case scoping cannot help:
 * commerce's own rows stuck in `retry_wait` behind the very provider failure that
 * is the reason for rolling back.
 *
 * ## What "non-terminal" means, per queue
 *
 * The statuses are not the same set in the two tables, and the difference is
 * load-bearing:
 *
 *   * legacy (`awcms_commerce_whatsapp_messages`): `queued`, `sending` are
 *     work; `sent`, `failed` are terminal. A retry returns a row to `queued`
 *     with a later `next_attempt_at` - there is NO `retry_wait` in this table.
 *   * upstream (`awcms_whatsapp_messages`): `queued`, `retry_wait`, `sending`
 *     are work; `sent`, `failed`, `cancelled`, `expired` are terminal.
 *
 * Only the TERMINAL set is written down; every other status counts as work. A
 * status a later migration adds therefore blocks a flip until someone decides it
 * is terminal, which is the safe direction (a flip that wrongly waits is
 * annoying; one that wrongly proceeds leaves a row stranded in a queue nobody
 * will drain).
 */
import type { WhatsappMode } from "./whatsapp-mode";

/** The legacy outbox's terminal statuses - the same set the legacy purge treats as history. */
export const LEGACY_TERMINAL_STATUSES = ["sent", "failed"] as const;

/** The upstream queue's terminal statuses (`awcms_whatsapp_messages_status_check`). */
export const UPSTREAM_TERMINAL_STATUSES = [
  "sent",
  "failed",
  "cancelled",
  "expired"
] as const;

/** One queue's state for the tenant: how many rows per status, and how many are still work. */
export type QueueDrain = {
  countsByStatus: Record<string, number>;
  /** Rows whose status is not terminal for this queue. */
  nonTerminal: number;
  /** Age in whole seconds of the oldest non-terminal row, or `null` when there is none (or the queue cannot say). */
  oldestNonTerminalAgeSeconds: number | null;
};

/** Builds a {@link QueueDrain} from per-status counts. A status absent from `terminal` counts as work. */
export function buildQueueDrain(
  countsByStatus: Record<string, number>,
  terminal: readonly string[],
  oldestNonTerminalAgeSeconds: number | null
): QueueDrain {
  let nonTerminal = 0;
  // Only statuses that hold a row: the upstream summary zero-fills every status,
  // the legacy one lists the groups it found, and the evidence reads the same.
  const present = Object.fromEntries(
    Object.entries(countsByStatus).filter(([, count]) => count > 0)
  );

  for (const [status, count] of Object.entries(present)) {
    if (!terminal.includes(status)) nonTerminal += count;
  }

  return {
    countsByStatus: present,
    nonTerminal,
    oldestNonTerminalAgeSeconds:
      nonTerminal > 0 ? oldestNonTerminalAgeSeconds : null
  };
}

/** What the process running the flip knows about whether each channel would actually be serviced. */
export type ChannelFacts = {
  /** `COMMERCE_WHATSAPP_ENABLED` - the gate the legacy dispatcher honours. */
  legacyEnabled: boolean;
  /** `WHATSAPP_ENABLED` - the gate the upstream dispatcher and enqueue honour. */
  upstreamEnabled: boolean;
  /** The tenant has not switched the `whatsapp_delivery` module off (`awcms_tenant_modules`; no row means on). */
  upstreamModuleEnabled: boolean;
  /** `WHATSAPP_RECIPIENT_HASH_KEYS` parses: without it every upstream enqueue is refused `MISCONFIGURED`. */
  upstreamHashKeysUsable: boolean;
  /** `WHATSAPP_PROVIDER` as configured, or `null` when unset. */
  upstreamProvider: string | null;
  /** `WHATSAPP_PROVIDER` names a provider the queue knows (an unknown one fails every row non-retryably). */
  upstreamProviderKnown: boolean;
};

/** The two numbers behind the marketing-consent warning. */
export type ConsentFacts = {
  /** Commerce customer accounts with `marketing_consent_at` set. */
  commerceMarketingOptIns: number;
  /** Granted rows in the upstream consent store. */
  upstreamGrantedConsents: number;
};

export type FlipFacts = {
  current: WhatsappMode;
  target: WhatsappMode;
  /** The mode the caller believes the tenant is in; a mismatch refuses (`MODE_CHANGED`). */
  expected?: WhatsappMode;
  legacy: QueueDrain;
  /** The upstream queue, COMMERCE-originated rows only: the ones this cutover moves. */
  upstream: QueueDrain;
  /** Non-terminal upstream rows of OTHER modules (booking reminders, ...): reported, never blocking. */
  upstreamUnrelated: number;
  channel: ChannelFacts;
  consent: ConsentFacts;
  acknowledgeWarnings: boolean;
  /**
   * Override a pending drain, ROLLBACK ONLY (`target === "legacy"`). It bypasses
   * `DRAIN_PENDING` and nothing else: a rollback into a channel nothing services,
   * a stale `expected` and every other blocker still refuse.
   */
  forceDrain?: boolean;
};

export const FLIP_BLOCKER_CODES = [
  "DRAIN_PENDING",
  "TARGET_DISABLED",
  "TARGET_MODULE_DISABLED",
  "TARGET_HASH_KEYS_UNUSABLE",
  "TARGET_PROVIDER_UNSET"
] as const;

export type FlipBlockerCode = (typeof FLIP_BLOCKER_CODES)[number];

export type FlipBlocker = { code: FlipBlockerCode; message: string };

export const FLIP_WARNING_CODES = [
  "MARKETING_CONSENT_NOT_BRIDGED",
  "META_PROVIDER_TEMPLATE_MISSING",
  "VARIABLES_SINGLE_LINE_CAPPED",
  "RATE_LIMITS_DIFFER"
] as const;

export type FlipWarningCode = (typeof FLIP_WARNING_CODES)[number];

export type FlipWarning = { code: FlipWarningCode; message: string };

export type FlipRefusalCode =
  | "MODE_CHANGED"
  | "DRAIN_PENDING"
  | "TARGET_CHANNEL_UNAVAILABLE"
  | "WARNINGS_NOT_ACKNOWLEDGED";

export type FlipDecision =
  | { kind: "unchanged" }
  | { kind: "allowed" }
  | { kind: "refused"; code: FlipRefusalCode; message: string };

export type FlipAssessment = {
  decision: FlipDecision;
  /** Every reason the flip cannot proceed now, whichever came first. Empty when nothing blocks. */
  blockers: FlipBlocker[];
  /** The drain blocker a `force` overrode, when it actually had something to override; otherwise `null`. */
  overridden: FlipBlocker | null;
  /** Differences the operator must accept before a flip into `upstream`. Empty for a flip into `legacy`. */
  warnings: FlipWarning[];
};

const STATUS_ORDER = [
  "queued",
  "retry_wait",
  "sending",
  "sent",
  "failed",
  "cancelled",
  "expired"
];

/** `queued=2, sending=1` - the non-terminal part of a drain, for a message. Pure. */
export function describeNonTerminal(
  drain: QueueDrain,
  terminal: readonly string[]
): string {
  return Object.entries(drain.countsByStatus)
    .filter(([status, count]) => count > 0 && !terminal.includes(status))
    .sort(
      ([a], [b]) =>
        (STATUS_ORDER.indexOf(a) + 1 || 99) -
        (STATUS_ORDER.indexOf(b) + 1 || 99)
    )
    .map(([status, count]) => `${status}=${count}`)
    .join(", ");
}

function drainBlocker(facts: FlipFacts): FlipBlocker | null {
  const leaving = facts.target === "upstream" ? facts.legacy : facts.upstream;
  const terminal =
    facts.target === "upstream"
      ? LEGACY_TERMINAL_STATUSES
      : UPSTREAM_TERMINAL_STATUSES;

  if (leaving.nonTerminal === 0) return null;

  const queue = facts.target === "upstream" ? "legacy" : "upstream";
  const scope =
    facts.target === "upstream"
      ? "for this tenant"
      : "of commerce for this tenant";
  const unrelated =
    facts.target === "legacy" && facts.upstreamUnrelated > 0
      ? ` (${facts.upstreamUnrelated} non-terminal message(s) of other modules are not counted)`
      : "";
  const age =
    leaving.oldestNonTerminalAgeSeconds === null
      ? ""
      : `; the oldest is ${leaving.oldestNonTerminalAgeSeconds}s old`;

  return {
    code: "DRAIN_PENDING",
    message: `The ${queue} queue still holds ${leaving.nonTerminal} non-terminal message(s) ${scope} (${describeNonTerminal(leaving, terminal)})${age}${unrelated}. A tenant is in exactly one mode at a time: wait for the ${queue} dispatcher to take them to a terminal state, then run the flip again.${facts.target === "legacy" ? " If the upstream provider is failing and the rows will not drain, a rollback can be forced (force / --force): it is audited and leaves those rows to the upstream dispatcher." : ""}`
  };
}

/**
 * Why the queue being ENTERED could not send. A flip into a channel nothing
 * services would silently stop every OTP of the tenant, which is worse than
 * refusing; each of these is a deployment fact the operator can fix.
 */
function channelBlockers(facts: FlipFacts): FlipBlocker[] {
  const { channel } = facts;

  if (facts.target === "legacy") {
    return channel.legacyEnabled
      ? []
      : [
          {
            code: "TARGET_DISABLED",
            message:
              "COMMERCE_WHATSAPP_ENABLED is not true in this process: the legacy dispatcher claims nothing, so a flip back to legacy would stop every WhatsApp message of the tenant."
          }
        ];
  }

  const blockers: FlipBlocker[] = [];

  if (!channel.upstreamEnabled) {
    blockers.push({
      code: "TARGET_DISABLED",
      message:
        "WHATSAPP_ENABLED is not true in this process: the upstream queue refuses every enqueue and its dispatcher claims nothing, so a flip would stop every WhatsApp message of the tenant."
    });
  }
  if (!channel.upstreamModuleEnabled) {
    blockers.push({
      code: "TARGET_MODULE_DISABLED",
      message:
        "The whatsapp_delivery module is switched off for this tenant. Enable it first (tenant module management)."
    });
  }
  if (!channel.upstreamHashKeysUsable) {
    blockers.push({
      code: "TARGET_HASH_KEYS_UNUSABLE",
      message:
        "WHATSAPP_RECIPIENT_HASH_KEYS is missing or malformed in this process: the upstream queue refuses every enqueue as MISCONFIGURED."
    });
  }
  if (!channel.upstreamProviderKnown) {
    blockers.push({
      code: "TARGET_PROVIDER_UNSET",
      message:
        "WHATSAPP_PROVIDER is missing or not a known provider (log, fonnte, meta): the upstream dispatcher would fail every message without retrying."
    });
  }

  return blockers;
}

/**
 * The differences between the two queues that a flip INTO `upstream` makes
 * visible (ADR-0047 "Known gaps"). None is a fault, none can be fixed by this
 * change, and each changes what a shopper or the owner sees, so the operator
 * acknowledges them rather than discovering them.
 */
export function buildFlipWarnings(facts: FlipFacts): FlipWarning[] {
  if (facts.target !== "upstream") return [];

  const warnings: FlipWarning[] = [];
  const { commerceMarketingOptIns, upstreamGrantedConsents } = facts.consent;

  if (commerceMarketingOptIns > upstreamGrantedConsents) {
    warnings.push({
      code: "MARKETING_CONSENT_NOT_BRIDGED",
      message: `${commerceMarketingOptIns} customer account(s) opted into marketing in commerce but the upstream consent store holds ${upstreamGrantedConsents} granted consent(s). Marketing consent is not copied across: a WhatsApp campaign skips every recipient without a granted upstream consent until their numbers are imported.`
    });
  }
  if (facts.channel.upstreamProvider === "meta") {
    warnings.push({
      code: "META_PROVIDER_TEMPLATE_MISSING",
      message:
        "WHATSAPP_PROVIDER is meta, which sends approved templates only, and the commerce templates carry no provider template identity: every commerce message would fail terminally. Fonnte and log are not affected."
    });
  }
  warnings.push({
    code: "VARIABLES_SINGLE_LINE_CAPPED",
    message:
      "The upstream renderer flattens line breaks in a variable and truncates it to 1,000 characters, so a long multi-line document body (a receipt) or campaign body is flattened or cut."
  });
  warnings.push({
    code: "RATE_LIMITS_DIFFER",
    message:
      "The upstream queue limits a recipient to 10 messages an hour (5 for security messages such as the OTP) and the tenant to 2,000 an hour."
  });

  return warnings;
}

/**
 * The whole decision. Order of precedence of the refusal CODE: a stale
 * expectation, then the drain, then the target channel, then unacknowledged
 * warnings; `blockers` lists every blocker regardless, so an evidence record
 * shows the operator everything to fix in one pass instead of one per attempt.
 */
export function assessWhatsappFlip(facts: FlipFacts): FlipAssessment {
  const warnings = buildFlipWarnings(facts);

  if (facts.expected !== undefined && facts.expected !== facts.current) {
    return {
      decision: {
        kind: "refused",
        code: "MODE_CHANGED",
        message: `The tenant is in ${facts.current} mode, not ${facts.expected} as the request expected. Read the mode again before flipping.`
      },
      blockers: [],
      overridden: null,
      warnings
    };
  }

  if (facts.current === facts.target) {
    return {
      decision: { kind: "unchanged" },
      blockers: [],
      overridden: null,
      warnings: []
    };
  }

  const blockers: FlipBlocker[] = [];
  const drain = drainBlocker(facts);
  // `force` is a rollback override: a flip INTO upstream never skips the drain.
  const overridden =
    drain && facts.forceDrain === true && facts.target === "legacy"
      ? drain
      : null;

  if (drain && !overridden) blockers.push(drain);
  blockers.push(...channelBlockers(facts));

  if (blockers.length > 0) {
    const first = blockers[0]!;

    return {
      decision: {
        kind: "refused",
        code:
          first.code === "DRAIN_PENDING"
            ? "DRAIN_PENDING"
            : "TARGET_CHANNEL_UNAVAILABLE",
        message: first.message
      },
      blockers,
      overridden,
      warnings
    };
  }

  if (warnings.length > 0 && !facts.acknowledgeWarnings) {
    return {
      decision: {
        kind: "refused",
        code: "WARNINGS_NOT_ACKNOWLEDGED",
        message: `Flipping to ${facts.target} makes ${warnings.length} difference(s) between the queues visible (${warnings.map((w) => w.code).join(", ")}). Read them, then repeat the request with the acknowledgement.`
      },
      blockers,
      overridden,
      warnings
    };
  }

  return { decision: { kind: "allowed" }, blockers, overridden, warnings };
}

export const FLIP_REASON_MAX_LENGTH = 500;

export type FlipRequestValidation =
  { valid: true; reason: string } | { valid: false; message: string };

/** The reason is mandatory: it is the first line of the audit row and of the runbook's evidence. */
export function validateFlipReason(raw: unknown): FlipRequestValidation {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { valid: false, message: "reason is required." };
  }

  const reason = raw.trim();

  if (reason.length > FLIP_REASON_MAX_LENGTH) {
    return {
      valid: false,
      message: `reason must be at most ${FLIP_REASON_MAX_LENGTH} characters.`
    };
  }

  return { valid: true, reason };
}
