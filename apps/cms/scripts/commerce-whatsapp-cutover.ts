#!/usr/bin/env bun
/**
 * commerce-whatsapp-cutover.ts — `bun run commerce:whatsapp:cutover`
 * (Issue #393, ADR-0133 section 6 phase 3, ADR-0047 "Cutover"). Flips ONE
 * tenant's WhatsApp delivery mode between the legacy commerce outbox and the
 * upstream `whatsapp_delivery` queue - only when the queue being left has
 * drained - and prints the evidence record a runbook attaches.
 *
 *   bun run commerce:whatsapp:cutover --tenant <tenant-uuid> --status
 *   bun run commerce:whatsapp:cutover --tenant <uuid> --to upstream --reason "<why>" --dry-run
 *   bun run commerce:whatsapp:cutover --tenant <uuid> --to upstream --reason "<why>" --ack-warnings
 *   bun run commerce:whatsapp:cutover --tenant <uuid> --to legacy   --reason "<why>"
 *
 * Flags:
 *   --tenant <uuid>     the tenant (required)
 *   --status            print the mode and the drain state of both queues, change nothing
 *   --to <mode>         `upstream` or `legacy`
 *   --reason "<text>"   why (required with --to; 500 characters at most; goes into the audit event)
 *   --dry-run           run the whole decision and write NOTHING (no mode change, no audit event)
 *   --ack-warnings      the operator has read the warnings of the dry run; required for a flip
 *                       into `upstream`, which always carries warnings (ADR-0047 known gaps)
 *   --wait <seconds>    keep checking (every 5 s, with dry-run probes that write nothing) until the
 *                       old queue has drained or the time is up, then make the one real attempt;
 *                       0..3600, default 0 (try once). The old dispatcher keeps running meanwhile
 *                       and the tenant keeps enqueueing to the old queue, so on a busy tenant a
 *                       few minutes' patience is the normal way to catch an empty moment.
 *   --from <mode>       refuse (MODE_CHANGED) unless the tenant is currently in this mode
 *   --operator "<name>" a free-text label recorded with the audit event (the CLI has no tenant user)
 *
 * The rule is `flipWhatsappMode` (application/whatsapp-mode-flip.ts), the one
 * function the admin route `POST /api/v1/commerce/whatsapp/mode` calls too. It
 * refuses while the queue being left holds a non-terminal row, while the queue
 * being entered cannot send, and until the warnings are acknowledged; a refusal
 * writes only the audit event of the refused attempt. APPLYING is the default
 * (unlike `commerce:inventory:cutover`, which is dry-run by default) because
 * the flip already needs two deliberate flags to go through - a reason, and for
 * `upstream` the acknowledgement - and a dry run is one flag away.
 *
 * Output: ONE JSON document on stdout (the evidence record, schema
 * `awcms.commerce.whatsapp_mode_flip/v1`), human text on stderr. Exit codes:
 * 0 flipped / would flip / already in that mode / status printed; 1 refused;
 * 2 bad usage. Safe to re-run: a tenant already in the target mode is
 * `unchanged` and nothing is written.
 *
 * ## Environment
 *
 * The channel checks read THIS process's environment (`WHATSAPP_ENABLED`,
 * `COMMERCE_WHATSAPP_ENABLED`, `WHATSAPP_PROVIDER`,
 * `WHATSAPP_RECIPIENT_HASH_KEYS`). The dispatchers are separate processes: run
 * this with the same environment file as `whatsapp:dispatch`, or the check
 * answers for a deployment that is not the one that will send.
 *
 * Runs as the web role (`awcms_app`), like `commerce:inventory:cutover`: it is
 * operator-run, not a scheduled worker job.
 */
import { randomUUID } from "node:crypto";

import { getDatabaseClient } from "../src/lib/database/client";
import { safeErrorDetail } from "../src/lib/logging/error-sanitizer";
import {
  assertUuid,
  withTenantOrThrow
} from "../src/lib/database/tenant-context";
import { validateFlipReason } from "../src/modules/commerce/domain/whatsapp-cutover";
import {
  WHATSAPP_MODES,
  type WhatsappMode
} from "../src/modules/commerce/domain/whatsapp-mode";
import {
  flipWhatsappMode,
  readWhatsappModeStatus
} from "../src/modules/commerce/application/whatsapp-mode-flip";

export type CutoverArgs =
  | { kind: "status"; tenantId: string }
  | {
      kind: "flip";
      tenantId: string;
      to: WhatsappMode;
      reason: string;
      dryRun: boolean;
      acknowledgeWarnings: boolean;
      /** Poll for the drain for at most this many seconds before the real attempt. */
      waitSeconds: number;
      from?: WhatsappMode;
      operator?: string;
    };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const VALUE_FLAGS = [
  "--tenant",
  "--to",
  "--reason",
  "--from",
  "--operator",
  "--wait"
];
export const MAX_WAIT_SECONDS = 3600;
const WAIT_POLL_MS = 5000;
const BOOLEAN_FLAGS = ["--status", "--dry-run", "--ack-warnings"];

function isMode(value: string | undefined): value is WhatsappMode {
  return (WHATSAPP_MODES as readonly string[]).includes(value ?? "");
}

/** Pure; throws {@link UsageError}. */
export function parseCutoverArgs(argv: string[]): CutoverArgs {
  const known = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new UsageError(`${flag} needs a value.`);
    }
    return next;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      if (!known.has(arg)) throw new UsageError(`Unknown flag ${arg}.`);
      if (VALUE_FLAGS.includes(arg)) index += 1;
    } else {
      throw new UsageError(`Unexpected argument "${arg}".`);
    }
  }

  const tenant = value("--tenant");
  if (!tenant) throw new UsageError("--tenant <uuid> is required.");
  let tenantId: string;
  try {
    tenantId = assertUuid(tenant);
  } catch {
    throw new UsageError("--tenant must be a UUID.");
  }

  if (argv.includes("--status")) {
    const other = [...VALUE_FLAGS, ...BOOLEAN_FLAGS].filter(
      (flag) =>
        flag !== "--tenant" && flag !== "--status" && argv.includes(flag)
    );
    if (other.length > 0) {
      throw new UsageError(
        `--status takes only --tenant, not ${other.join(", ")}.`
      );
    }
    return { kind: "status", tenantId };
  }

  const to = value("--to");
  if (!isMode(to)) {
    throw new UsageError("--to must be upstream or legacy.");
  }
  const reason = validateFlipReason(value("--reason"));
  if (!reason.valid) {
    throw new UsageError(`--reason: ${reason.message}`);
  }
  const from = value("--from");
  if (from !== undefined && !isMode(from)) {
    throw new UsageError("--from must be upstream or legacy.");
  }
  const operator = value("--operator")?.trim();
  const waitRaw = value("--wait");
  const waitSeconds = waitRaw === undefined ? 0 : Number(waitRaw);
  if (
    !Number.isInteger(waitSeconds) ||
    waitSeconds < 0 ||
    waitSeconds > MAX_WAIT_SECONDS
  ) {
    throw new UsageError(
      `--wait must be a whole number of seconds from 0 to ${MAX_WAIT_SECONDS}.`
    );
  }

  return {
    kind: "flip",
    tenantId,
    to,
    reason: reason.reason,
    dryRun: argv.includes("--dry-run"),
    acknowledgeWarnings: argv.includes("--ack-warnings"),
    waitSeconds,
    ...(from ? { from } : {}),
    ...(operator ? { operator: operator.slice(0, 120) } : {})
  };
}

async function main(): Promise<void> {
  let args: CutoverArgs;
  try {
    args = parseCutoverArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`commerce:whatsapp:cutover: ${safeErrorDetail(error)}`);
      console.error(
        'Usage: bun run commerce:whatsapp:cutover --tenant <uuid> (--status | --to upstream|legacy --reason "<why>" [--dry-run] [--ack-warnings] [--wait <seconds>] [--from <mode>] [--operator "<name>"])'
      );
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  const sql = getDatabaseClient();
  const correlationId = `commerce-whatsapp-cutover-${randomUUID()}`;

  /** One tenant transaction: the status read, or one flip attempt (`dryRun` overrides the flag for the polling probes). */
  const attempt = (dryRun: boolean) =>
    withTenantOrThrow(
      sql,
      args.tenantId,
      async (tx) => {
        const tenants = (await tx`
          SELECT 1 FROM awcms_tenants WHERE id = ${args.tenantId}
        `) as unknown[];
        if (tenants.length === 0) {
          return { kind: "no_tenant" as const };
        }

        if (args.kind === "status") {
          return {
            kind: "status" as const,
            status: await readWhatsappModeStatus(tx, args.tenantId)
          };
        }

        return {
          kind: "flip" as const,
          result: await flipWhatsappMode(
            tx,
            args.tenantId,
            {
              tenantUserId: null,
              surface: "cli",
              ...(args.operator ? { operator: args.operator } : {})
            },
            args.to,
            {
              reason: args.reason,
              ...(args.from ? { expected: args.from } : {}),
              acknowledgeWarnings: args.acknowledgeWarnings,
              dryRun,
              correlationId
            }
          )
        };
      },
      { workClass: "background_sync" }
    );

  try {
    // `--wait`: the old dispatcher is still draining while we look, so poll with
    // DRY runs (each its own short transaction, no lock held in between and no
    // audit row per poll), and only when the probe says the drain is over - or
    // the time is up - make the one real attempt that flips or records the
    // refusal.
    if (args.kind === "flip" && args.waitSeconds > 0) {
      const deadline = Date.now() + args.waitSeconds * 1000;

      for (;;) {
        const probe = await attempt(true);
        if (
          probe.kind !== "flip" ||
          probe.result.outcome !== "refused" ||
          probe.result.evidence.refusal?.code !== "DRAIN_PENDING" ||
          Date.now() >= deadline
        ) {
          break;
        }
        const drain =
          args.to === "upstream"
            ? probe.result.evidence.queues.legacy
            : probe.result.evidence.queues.upstream;
        console.error(
          `commerce:whatsapp:cutover waiting for the ${args.to === "upstream" ? "legacy" : "upstream"} queue to drain: ${drain.nonTerminal} non-terminal message(s), ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))}s left.`
        );
        await Bun.sleep(Math.min(WAIT_POLL_MS, deadline - Date.now()));
      }
    }

    const outcome = await attempt(args.kind === "flip" && args.dryRun);

    if (outcome.kind === "no_tenant") {
      console.error("commerce:whatsapp:cutover: the tenant does not exist.");
      process.exitCode = 2;
      return;
    }

    if (outcome.kind === "status") {
      console.log(JSON.stringify(outcome.status, null, 2));
      return;
    }

    const { result } = outcome;
    console.log(JSON.stringify(result.evidence, null, 2));

    switch (result.outcome) {
      case "flipped":
        console.error(
          `commerce:whatsapp:cutover COMMITTED: ${result.evidence.from} -> ${result.evidence.to}. Audit event ${result.evidence.auditEventId}.`
        );
        break;
      case "would_flip":
        console.error(
          `commerce:whatsapp:cutover DRY-RUN: the flip ${result.evidence.from} -> ${result.evidence.to} would be allowed. Nothing was written.`
        );
        break;
      case "unchanged":
        console.error(
          `commerce:whatsapp:cutover: the tenant is already in ${result.evidence.to} mode; nothing to do.`
        );
        break;
      case "refused":
        console.error(
          `commerce:whatsapp:cutover REFUSED (${result.evidence.refusal?.code}): ${result.evidence.refusal?.message}`
        );
        for (const blocker of result.evidence.blockers.slice(1)) {
          console.error(`  also: ${blocker.code}: ${blocker.message}`);
        }
        process.exitCode = 1;
        break;
    }
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
