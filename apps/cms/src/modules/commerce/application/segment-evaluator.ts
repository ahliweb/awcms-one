/**
 * Bounded, read-only evaluation of a CRM segment (Issue #360, ADR-0042,
 * threat model control C-26).
 *
 * ## What bounds an evaluation
 *
 * 1. The RULE is bounded before it gets here (`domain/segment-rules.ts`:
 *    depth, node count, children, windows, bytes).
 * 2. CONCURRENCY: a transaction-scoped advisory try-lock per tenant slot and
 *    per actor. An evaluation that cannot take a slot is `busy` (HTTP 429) and
 *    never queues - a burst of previews cannot hold the pool. The locks are
 *    released with the transaction, so a crash cannot leak one.
 * 3. TIME: `statement_timeout` is set for the evaluation inside a SAVEPOINT. A
 *    statement that exceeds it is cancelled by the database and the answer is
 *    the stable `too_expensive` outcome (HTTP 422 `SEGMENT_TOO_EXPENSIVE`);
 *    the savepoint rolls back, so the tenant transaction stays usable and the
 *    setting is restored.
 * 4. SIZE: every list is a bounded keyset page; the sample is capped; an
 *    export is capped. The count is a single aggregate.
 *
 * ## The as-of timestamp (C-25)
 *
 * Chosen here, from the server clock the route passes in, and returned with
 * the result. No caller supplies it; a consumer that needs a past instant
 * records the one it was given.
 *
 * Evaluation runs on the caller's tenant transaction, so RLS scopes every row;
 * the tenant id is also an explicit predicate in every query (belt and braces).
 */
import { createHash } from "node:crypto";

import {
  SEGMENT_EVALUATION_LIMITS,
  toMemberDto,
  type SegmentMemberDto
} from "../domain/segment";
import {
  suppressSmallCount,
  type SegmentCount,
  type SegmentNode,
  type SegmentRuleStats
} from "../domain/segment-rules";
import {
  countSegmentMatches,
  selectSegmentMatches,
  type SegmentQueryInput
} from "./segment-sql";

const SEGMENT_EVAL_LOCK_NAMESPACE = 604_918_360;

function lockKey(label: string): number {
  return (
    createHash("sha256").update(label).digest().readUInt32BE(0) & 0x7fffffff
  );
}

export type SegmentEvaluationContext = {
  tenantId: string;
  actorTenantUserId: string;
  /** The server clock for this request (`defineTenantRoute`'s `now`). */
  now: Date;
};

export type BoundedOutcome<T> =
  | { kind: "ok"; value: T; asOf: string; elapsedMs: number }
  | { kind: "busy" }
  | { kind: "too_expensive" };

async function takeSlot(
  tx: Bun.SQL,
  label: string,
  slots: number
): Promise<boolean> {
  for (let slot = 0; slot < slots; slot += 1) {
    const rows = (await tx`
      SELECT pg_try_advisory_xact_lock(
        ${SEGMENT_EVAL_LOCK_NAMESPACE}::int,
        ${lockKey(`${label}|${slot}`)}::int
      ) AS acquired
    `) as { acquired: boolean }[];
    if (rows[0]?.acquired) return true;
  }
  return false;
}

/**
 * Runs `work` under every bound above. `work` receives a connection that is
 * inside the savepoint: it must do its reads on THAT, not on `tx`.
 */
export async function runBoundedEvaluation<T>(
  tx: Bun.SQL,
  context: SegmentEvaluationContext,
  work: (db: Bun.SQL, asOf: string) => Promise<T>,
  options: { statementTimeoutMs?: number } = {}
): Promise<BoundedOutcome<T>> {
  const tenantSlot = await takeSlot(
    tx,
    `tenant|${context.tenantId}`,
    SEGMENT_EVALUATION_LIMITS.tenantConcurrency
  );
  if (!tenantSlot) return { kind: "busy" };
  const actorSlot = await takeSlot(
    tx,
    `actor|${context.tenantId}|${context.actorTenantUserId}`,
    SEGMENT_EVALUATION_LIMITS.actorConcurrency
  );
  if (!actorSlot) return { kind: "busy" };

  const asOf = context.now.toISOString();
  const started = performance.now();
  try {
    const value = await (tx as Bun.TransactionSQL).savepoint(async (sp) => {
      const previous = (await sp`
        SELECT current_setting('statement_timeout') AS value
      `) as { value: string }[];
      await sp`
        SELECT set_config(
          'statement_timeout',
          ${String(options.statementTimeoutMs ?? SEGMENT_EVALUATION_LIMITS.statementTimeoutMs)},
          true
        )
      `;
      const result = await work(sp, asOf);
      await sp`
        SELECT set_config('statement_timeout', ${previous[0]?.value ?? "0"}, true)
      `;
      return result;
    });
    return {
      kind: "ok",
      value,
      asOf,
      elapsedMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    if (
      error instanceof Error &&
      // 57014 query_canceled: the statement timeout fired.
      String((error as { errno?: unknown }).errno) === "57014"
    ) {
      return { kind: "too_expensive" };
    }
    throw error;
  }
}

type EvaluationRules = { node: SegmentNode; stats: SegmentRuleStats };

function queryInput(
  context: SegmentEvaluationContext,
  rules: EvaluationRules,
  asOf: string
): SegmentQueryInput {
  return {
    tenantId: context.tenantId,
    node: rules.node,
    stats: rules.stats,
    asOf
  };
}

export type SegmentPreviewResult = {
  asOf: string;
  count: SegmentCount;
  /** Present only when the caller may read members; bounded and not pageable. */
  sample: SegmentMemberDto[] | null;
  elapsedMs: number;
};

/**
 * Count (small-group suppressed, C-27) and - when the caller holds the member
 * and customer read permissions - a bounded sample.
 */
export async function previewSegment(
  tx: Bun.SQL,
  context: SegmentEvaluationContext,
  rules: EvaluationRules,
  options: { includeSample: boolean }
): Promise<
  | { kind: "ok"; preview: SegmentPreviewResult }
  | { kind: "busy" }
  | { kind: "too_expensive" }
> {
  const outcome = await runBoundedEvaluation(tx, context, async (db, asOf) => {
    const input = queryInput(context, rules, asOf);
    const count = await countSegmentMatches(db, input);
    const sample = options.includeSample
      ? (
          await selectSegmentMatches(
            db,
            input,
            null,
            SEGMENT_EVALUATION_LIMITS.sampleSize
          )
        ).map(toMemberDto)
      : null;
    return { count, sample };
  });
  if (outcome.kind !== "ok") return outcome;
  return {
    kind: "ok",
    preview: {
      asOf: outcome.asOf,
      count: suppressSmallCount(outcome.value.count),
      sample: outcome.value.sample,
      elapsedMs: outcome.elapsedMs
    }
  };
}

export type SegmentMembersPage = {
  asOf: string;
  items: SegmentMemberDto[];
  /** The last customer id of a full page, else null. */
  lastId: string | null;
  hasMore: boolean;
};

/** One keyset page of members (ascending customer id). */
export async function listSegmentMembersPage(
  tx: Bun.SQL,
  context: SegmentEvaluationContext,
  rules: EvaluationRules,
  afterId: string | null,
  limit: number
): Promise<
  | { kind: "ok"; page: SegmentMembersPage }
  | { kind: "busy" }
  | { kind: "too_expensive" }
> {
  const outcome = await runBoundedEvaluation(tx, context, async (db, asOf) => {
    const rows = await selectSegmentMatches(
      db,
      queryInput(context, rules, asOf),
      afterId,
      limit + 1
    );
    return rows;
  });
  if (outcome.kind !== "ok") return outcome;
  const hasMore = outcome.value.length > limit;
  const visible = hasMore ? outcome.value.slice(0, limit) : outcome.value;
  return {
    kind: "ok",
    page: {
      asOf: outcome.asOf,
      items: visible.map(toMemberDto),
      lastId: hasMore ? (visible[visible.length - 1]?.id ?? null) : null,
      hasMore
    }
  };
}

/**
 * Every member up to `maxRows`, for the CSV. `truncated` is true when more
 * existed - the export says so rather than cutting silently.
 */
export async function exportSegmentMembers(
  tx: Bun.SQL,
  context: SegmentEvaluationContext,
  rules: EvaluationRules,
  maxRows: number
): Promise<
  | {
      kind: "ok";
      asOf: string;
      members: SegmentMemberDto[];
      truncated: boolean;
    }
  | { kind: "busy" }
  | { kind: "too_expensive" }
> {
  const outcome = await runBoundedEvaluation(tx, context, async (db, asOf) =>
    selectSegmentMatches(
      db,
      queryInput(context, rules, asOf),
      null,
      maxRows + 1
    )
  );
  if (outcome.kind !== "ok") return outcome;
  const truncated = outcome.value.length > maxRows;
  const rows = truncated ? outcome.value.slice(0, maxRows) : outcome.value;
  return {
    kind: "ok",
    asOf: outcome.asOf,
    members: rows.map(toMemberDto),
    truncated
  };
}
