/**
 * The SQL side of CRM segment evaluation (Issue #360, ADR-0042, threat model
 * control C-25).
 *
 * ## Why no SQL text can come from a rule
 *
 * A {@link SegmentNode} reaching this file has already been through
 * `domain/segment-rules.ts`'s validator, so every field and operator is a
 * member of a closed union and every operand is a typed scalar. Each
 * (field, operator) pair below maps to ONE literal template; the operands are
 * BOUND PARAMETERS. The columns a template reads (`c.level`, `f.cnt_all`,
 * `la.balance`, ...) are written into the template itself - never a variable -
 * so there is no identifier, operator or expression position a rule can reach.
 * The `switch` statements are exhaustive over both unions: a new field or
 * operator is a compile error until it gets its own literal template.
 *
 * ## One scan for the order facts (PRD M7)
 *
 * Order count, paid spend and the first/last paid date are not looked up per
 * customer. One grouped scan of the tenant's paid orders (`facts`) computes
 * every figure the rule needs - the all-time ones and up to three windowed
 * variants as FILTERed aggregates in the same pass - and is LEFT JOINed to the
 * customers once. The pass is O(paid orders) whatever the rule's shape, and is
 * skipped entirely when the rule reads no order fact.
 *
 * ## Eligibility is the evaluator's, not the consumer's (C-28)
 *
 * {@link eligibilityPredicate} is applied BEFORE the rule: an erased
 * (soft-deleted) customer, a blocked one and the POS walk-in placeholder are
 * never members, whatever the rule says and whichever consumer asks. `NOT`
 * therefore cannot resurrect them.
 *
 * ## Determinism (C-25 / the server as-of)
 *
 * Every time-relative operand is resolved against the as-of instant the
 * SERVER chose; orders paid after it are not counted. The same rule, the same
 * as-of and the same data give the same result.
 */
import { POS_WALK_IN_CUSTOMER_SENTINEL_PHONE } from "../domain/phone-normalisation";
import type {
  SegmentDateValue,
  SegmentLeaf,
  SegmentNode,
  SegmentRuleStats
} from "../domain/segment-rules";

/** The order statuses that are not revenue. The partial index of `sql/1002` carries `status` so this predicate is index-only. */
const NON_REVENUE_STATUSES = ["cancelled", "expired"] as const;

export type SegmentNeeds = {
  facts: boolean;
  accounts: boolean;
  loyalty: boolean;
};

/** Which joined relations a rule reads, so an unused one is neither joined nor scanned. */
export function segmentNeeds(node: SegmentNode): SegmentNeeds {
  const needs: SegmentNeeds = { facts: false, accounts: false, loyalty: false };
  const visit = (current: SegmentNode): void => {
    switch (current.type) {
      case "and":
      case "or":
        current.children.forEach(visit);
        return;
      case "not":
        visit(current.child);
        return;
      case "leaf":
        switch (current.field) {
          case "has_account":
            needs.accounts = true;
            return;
          case "loyalty_balance":
            needs.loyalty = true;
            return;
          case "order_count":
          case "paid_spend":
          case "last_order_date":
          case "first_order_date":
            needs.facts = true;
            return;
          case "level":
          case "has_email":
          case "customer_since":
            return;
        }
    }
  };
  visit(node);
  return needs;
}

/** The three windowed slots, in the order `stats.windows` lists them. */
function windowSlot(stats: SegmentRuleStats, windowDays: number | null) {
  if (windowDays === null) return "all" as const;
  const index = stats.windows.indexOf(windowDays);
  if (index === 0) return "w0" as const;
  if (index === 1) return "w1" as const;
  if (index === 2) return "w2" as const;
  throw new Error(`Window ${windowDays} is not in the rule's window list.`);
}

type Bound = { asOf: string };

// The type of a `tx` tagged-template fragment (`Bun.SQL`'s call signature is
// overloaded, so `ReturnType<Bun.SQL>` resolves to the identifier helper).
const fragmentOf = (tx: Bun.SQL) => tx`TRUE`;
type Fragment = ReturnType<typeof fragmentOf>;

function dateOperand(tx: Bun.SQL, value: SegmentDateValue, bound: Bound) {
  return value.kind === "at"
    ? tx`${value.at}::timestamptz`
    : tx`(${bound.asOf}::timestamptz - make_interval(days => ${value.daysAgo}::int))`;
}

function countColumn(tx: Bun.SQL, slot: ReturnType<typeof windowSlot>) {
  switch (slot) {
    case "all":
      return tx`COALESCE(f.cnt_all, 0)`;
    case "w0":
      return tx`COALESCE(f.cnt_w0, 0)`;
    case "w1":
      return tx`COALESCE(f.cnt_w1, 0)`;
    case "w2":
      return tx`COALESCE(f.cnt_w2, 0)`;
  }
}

function spendColumn(tx: Bun.SQL, slot: ReturnType<typeof windowSlot>) {
  switch (slot) {
    case "all":
      return tx`COALESCE(f.spend_all, 0)`;
    case "w0":
      return tx`COALESCE(f.spend_w0, 0)`;
    case "w1":
      return tx`COALESCE(f.spend_w1, 0)`;
    case "w2":
      return tx`COALESCE(f.spend_w2, 0)`;
  }
}

function compare(
  tx: Bun.SQL,
  left: Fragment,
  op: "eq" | "gt" | "gte" | "lt" | "lte",
  right: Fragment
) {
  switch (op) {
    case "eq":
      return tx`(${left} = ${right})`;
    case "gt":
      return tx`(${left} > ${right})`;
    case "gte":
      return tx`(${left} >= ${right})`;
    case "lt":
      return tx`(${left} < ${right})`;
    case "lte":
      return tx`(${left} <= ${right})`;
  }
}

function leafPredicate(
  tx: Bun.SQL,
  leaf: SegmentLeaf,
  stats: SegmentRuleStats,
  bound: Bound
) {
  switch (leaf.field) {
    case "level": {
      if (leaf.op === "eq") return tx`(c.level = ${leaf.value}::int)`;
      return tx`(c.level = ANY(${tx.array(leaf.value.map(String), "text")}::text[]::int[]))`;
    }
    case "has_account":
      return leaf.value ? tx`(a.id IS NOT NULL)` : tx`(a.id IS NULL)`;
    case "has_email": {
      const present = tx`(c.email IS NOT NULL AND c.email <> '')`;
      return leaf.value ? present : tx`(NOT ${present})`;
    }
    case "customer_since": {
      const operand = dateOperand(tx, leaf.value, bound);
      return leaf.op === "before"
        ? tx`(c.created_at < ${operand})`
        : tx`(c.created_at > ${operand})`;
    }
    case "order_count": {
      const slot = windowSlot(stats, leaf.windowDays);
      return compare(
        tx,
        countColumn(tx, slot),
        leaf.op,
        tx`${leaf.value}::int`
      );
    }
    case "paid_spend": {
      const slot = windowSlot(stats, leaf.windowDays);
      return compare(
        tx,
        spendColumn(tx, slot),
        leaf.op,
        tx`${leaf.value}::numeric`
      );
    }
    case "last_order_date": {
      if (leaf.op === "never") return tx`(f.last_at IS NULL)`;
      const operand = dateOperand(tx, leaf.value, bound);
      return leaf.op === "before"
        ? tx`COALESCE(f.last_at < ${operand}, false)`
        : tx`COALESCE(f.last_at > ${operand}, false)`;
    }
    case "first_order_date": {
      if (leaf.op === "never") return tx`(f.first_at IS NULL)`;
      const operand = dateOperand(tx, leaf.value, bound);
      return leaf.op === "before"
        ? tx`COALESCE(f.first_at < ${operand}, false)`
        : tx`COALESCE(f.first_at > ${operand}, false)`;
    }
    case "loyalty_balance":
      return compare(
        tx,
        tx`COALESCE(la.balance, 0)`,
        leaf.op,
        tx`${String(leaf.value)}::bigint`
      );
  }
}

function nodePredicate(
  tx: Bun.SQL,
  node: SegmentNode,
  stats: SegmentRuleStats,
  bound: Bound
): Fragment {
  switch (node.type) {
    case "leaf":
      return leafPredicate(tx, node, stats, bound);
    case "not":
      return tx`(NOT ${nodePredicate(tx, node.child, stats, bound)})`;
    case "and":
    case "or": {
      const parts = node.children.map((child) =>
        nodePredicate(tx, child, stats, bound)
      );
      let combined = parts[0]!;
      for (let index = 1; index < parts.length; index += 1) {
        combined =
          node.type === "and"
            ? tx`(${combined} AND ${parts[index]!})`
            : tx`(${combined} OR ${parts[index]!})`;
      }
      return combined;
    }
  }
}

/** The members of a segment are always live, active, real customers - see this file's header. */
function eligibilityPredicate(tx: Bun.SQL, tenantId: string) {
  return tx`c.tenant_id = ${tenantId}
    AND c.deleted_at IS NULL
    AND c.status = 'active'
    AND c.phone <> ${POS_WALK_IN_CUSTOMER_SENTINEL_PHONE}`;
}

function factsJoin(
  tx: Bun.SQL,
  tenantId: string,
  stats: SegmentRuleStats,
  bound: Bound,
  needs: SegmentNeeds
) {
  if (!needs.facts) return tx``;
  const w0 = stats.windows[0] ?? null;
  const w1 = stats.windows[1] ?? null;
  const w2 = stats.windows[2] ?? null;
  return tx`
    LEFT JOIN (
      SELECT o.customer_id,
        count(*)::int AS cnt_all,
        sum(o.total) AS spend_all,
        min(o.paid_at) AS first_at,
        max(o.paid_at) AS last_at,
        (count(*) FILTER (WHERE ${w0}::int IS NOT NULL
          AND o.paid_at > ${bound.asOf}::timestamptz - make_interval(days => ${w0}::int)))::int AS cnt_w0,
        sum(o.total) FILTER (WHERE ${w0}::int IS NOT NULL
          AND o.paid_at > ${bound.asOf}::timestamptz - make_interval(days => ${w0}::int)) AS spend_w0,
        (count(*) FILTER (WHERE ${w1}::int IS NOT NULL
          AND o.paid_at > ${bound.asOf}::timestamptz - make_interval(days => ${w1}::int)))::int AS cnt_w1,
        sum(o.total) FILTER (WHERE ${w1}::int IS NOT NULL
          AND o.paid_at > ${bound.asOf}::timestamptz - make_interval(days => ${w1}::int)) AS spend_w1,
        (count(*) FILTER (WHERE ${w2}::int IS NOT NULL
          AND o.paid_at > ${bound.asOf}::timestamptz - make_interval(days => ${w2}::int)))::int AS cnt_w2,
        sum(o.total) FILTER (WHERE ${w2}::int IS NOT NULL
          AND o.paid_at > ${bound.asOf}::timestamptz - make_interval(days => ${w2}::int)) AS spend_w2
      FROM awcms_commerce_orders o
      WHERE o.tenant_id = ${tenantId}
        AND o.paid_at IS NOT NULL
        AND o.deleted_at IS NULL
        AND o.status <> ALL(${tx.array([...NON_REVENUE_STATUSES], "text")}::text[])
        AND o.paid_at <= ${bound.asOf}::timestamptz
      GROUP BY o.customer_id
    ) f ON f.customer_id = c.id`;
}

function accountsJoin(tx: Bun.SQL, needs: SegmentNeeds) {
  if (!needs.accounts) return tx``;
  return tx`
    LEFT JOIN awcms_commerce_customer_accounts a
      ON a.tenant_id = c.tenant_id AND a.customer_id = c.id AND a.deleted_at IS NULL`;
}

function loyaltyJoin(tx: Bun.SQL, needs: SegmentNeeds) {
  if (!needs.loyalty) return tx``;
  return tx`
    LEFT JOIN awcms_commerce_loyalty_accounts la
      ON la.tenant_id = c.tenant_id AND la.customer_id = c.id`;
}

export type SegmentQueryInput = {
  tenantId: string;
  node: SegmentNode;
  stats: SegmentRuleStats;
  /** ISO instant chosen by the SERVER; never a client value. */
  asOf: string;
};

/**
 * The `FROM ... WHERE ...` tail every evaluation shares (`c` = customers).
 * `reach` (Issue #362) narrows the members to the ones a campaign may message;
 * it is appended AFTER the rule, so it can only ever remove people.
 */
function segmentTail(
  tx: Bun.SQL,
  input: SegmentQueryInput,
  reach: CampaignReach | null = null
) {
  const bound: Bound = { asOf: input.asOf };
  const needs = segmentNeeds(input.node);
  return tx`
    FROM awcms_commerce_customers c
    ${factsJoin(tx, input.tenantId, input.stats, bound, needs)}
    ${accountsJoin(tx, needs)}
    ${loyaltyJoin(tx, needs)}
    ${reach ? reachJoin(tx) : tx``}
    WHERE ${eligibilityPredicate(tx, input.tenantId)}
      AND ${nodePredicate(tx, input.node, input.stats, bound)}
      ${reach ? reachPredicate(tx, input.tenantId, reach) : tx``}`;
}

// ---------------------------------------------------------------------------
// Campaign reach (Issue #362, ADR-0042 Amendment, threat model C-12 / C-28)
// ---------------------------------------------------------------------------

/** What a campaign adds on top of segment membership: a channel and, for a dispatch page, the recipients already recorded. */
export type CampaignReach = {
  channel: "email" | "whatsapp";
  /** When set, customers already recorded as recipients of this campaign are skipped - the resume cursor. */
  campaignId: string | null;
};

/**
 * Membership is NOT consent. The customer's own account is joined here, under
 * its own alias (`ca`) so it cannot be confused with the rule's optional `a`
 * join, and the predicate below requires the opt-in timestamp. A customer with
 * no account has no consent and is structurally unreachable.
 */
function reachJoin(tx: Bun.SQL) {
  return tx`
    JOIN awcms_commerce_customer_accounts ca
      ON ca.tenant_id = c.tenant_id AND ca.customer_id = c.id`;
}

function reachPredicate(tx: Bun.SQL, tenantId: string, reach: CampaignReach) {
  const channelIsEmail = reach.channel === "email";
  return tx`
      AND ca.deleted_at IS NULL
      AND ca.status = 'active'
      AND ca.marketing_consent_at IS NOT NULL
      AND (
        (${channelIsEmail} AND ca.email_normalized IS NOT NULL AND ca.email_normalized <> '')
        OR (NOT ${channelIsEmail} AND c.phone IS NOT NULL AND c.phone <> '')
      )
      ${
        reach.campaignId
          ? tx`AND NOT EXISTS (
        SELECT 1 FROM awcms_commerce_campaign_recipients r
        WHERE r.tenant_id = ${tenantId} AND r.campaign_id = ${reach.campaignId}
          AND r.customer_id = c.id
      )`
          : tx``
      }`;
}

export type CampaignAudienceRow = {
  customer_id: string;
  name: string;
  phone: string;
  email: string | null;
};

/** How many members of the segment the campaign may message (consent, status, channel address). */
export async function countSegmentCampaignAudience(
  tx: Bun.SQL,
  input: SegmentQueryInput,
  channel: CampaignReach["channel"]
): Promise<number> {
  const rows = (await tx`
    SELECT count(*)::int AS total
    ${segmentTail(tx, input, { channel, campaignId: null })}
  `) as { total: number }[];
  return Number(rows[0]?.total ?? 0);
}

/** One page (ascending customer id) of the messageable members not yet recorded for `campaignId`. */
export async function selectSegmentCampaignAudiencePage(
  tx: Bun.SQL,
  input: SegmentQueryInput,
  reach: { channel: CampaignReach["channel"]; campaignId: string },
  limit: number
): Promise<CampaignAudienceRow[]> {
  return (await tx`
    SELECT c.id AS customer_id, c.name, c.phone, ca.email_normalized AS email
    ${segmentTail(tx, input, reach)}
    ORDER BY c.id ASC
    LIMIT ${limit}
  `) as CampaignAudienceRow[];
}

/** How many customers the rule matches. */
export async function countSegmentMatches(
  tx: Bun.SQL,
  input: SegmentQueryInput
): Promise<number> {
  const rows = (await tx`
    SELECT count(*)::int AS total
    ${segmentTail(tx, input)}
  `) as { total: number }[];
  return Number(rows[0]?.total ?? 0);
}

export type SegmentMemberRow = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  level: number;
};

/** One keyset page (ascending customer id) of the matches. */
export async function selectSegmentMatches(
  tx: Bun.SQL,
  input: SegmentQueryInput,
  afterId: string | null,
  limit: number
): Promise<SegmentMemberRow[]> {
  const rows = (await tx`
    SELECT c.id, c.name, c.phone, c.email, c.level
    ${segmentTail(tx, input)}
      AND (${afterId}::uuid IS NULL OR c.id > ${afterId}::uuid)
    ORDER BY c.id ASC
    LIMIT ${limit}
  `) as SegmentMemberRow[];
  return rows.map((row) => ({ ...row, level: Number(row.level) }));
}
