/**
 * Loyalty eligibility by CRM segment (Issue #361, ADR-0042 amendment, PRD L1).
 *
 * A loyalty program VERSION may be restricted to one immutable segment version
 * (`awcms_commerce_loyalty_programs.eligibility_segment_id` / `_version`,
 * `sql/1005`). At earn time the consumer asks one question - "is THIS customer a
 * member of that segment version?" - and this file answers it.
 *
 * ## Single-customer predicate, not a scan
 *
 * The answer comes from `isCustomerSegmentMember` (`segment-sql.ts`): the very
 * same fixed parameterised templates and the same eligibility predicate a full
 * evaluation uses, narrowed to the customer's primary key and, for the order
 * facts, to that customer's orders. The cost is one customer's history, not the
 * tenant's; there is no advisory-lock slot, no savepoint and no timeout, because
 * a bounded rule over one customer's orders cannot starve the database and an
 * earn consumer must never answer "busy" (it would retry and re-run for
 * nothing).
 *
 * ## As-of is the order's `paid_at` (ADR-0026 D3)
 *
 * Time-relative operands (`windowDays`, `{ daysAgo }`) and the "paid at or
 * before" cut of the order facts are resolved against the order's `paid_at`,
 * not against the instant the consumer happens to run. That makes the decision
 * the same on a replay and on the first delivery for everything the order
 * history determines, and matches "the program version in force at `paid_at`
 * decides". The loyalty balance and the price level are read as they are now:
 * they are not time-travelled, and a rule that reads them is documented as such.
 *
 * ## What eligibility is NOT
 *
 * Membership is never consent (C-28): earning points is not a message, and
 * nothing here reads or changes channel consent. A walk-in placeholder, a
 * blocked or an erased customer is never a member (the evaluator's own
 * predicate), so a `NOT` rule cannot hand them points.
 */
import { resolveSegmentRules } from "./segment-directory";
import { isCustomerSegmentMember } from "./segment-sql";
import type { LoyaltyProgram } from "../domain/loyalty";

export type EligibilityDecision =
  /** The program is not restricted: everyone earns. */
  | { kind: "unrestricted" }
  | {
      kind: "member";
      segmentId: string;
      segmentVersion: number;
    }
  | {
      kind: "not_member";
      segmentId: string;
      segmentVersion: number;
    };

/**
 * Decides whether `customerId` may earn under `program`. Throws when the
 * recorded segment version cannot be loaded or no longer validates: the
 * composite foreign key makes that impossible short of corruption, and failing
 * the consumer (which retries and then dead-letters) is safer than silently
 * awarding or withholding points.
 */
export async function decideProgramEligibility(
  tx: Bun.SQL,
  tenantId: string,
  program: Pick<
    LoyaltyProgram,
    "id" | "eligibilitySegmentId" | "eligibilitySegmentVersion"
  >,
  customerId: string,
  paidAt: Date
): Promise<EligibilityDecision> {
  if (
    program.eligibilitySegmentId === null ||
    program.eligibilitySegmentVersion === null
  ) {
    return { kind: "unrestricted" };
  }
  const resolved = await resolveSegmentRules(
    tx,
    tenantId,
    program.eligibilitySegmentId,
    program.eligibilitySegmentVersion
  );
  if (!resolved) {
    throw new Error(
      `Loyalty program ${program.id} references segment ${program.eligibilitySegmentId} version ${program.eligibilitySegmentVersion}, which cannot be loaded.`
    );
  }
  const member = await isCustomerSegmentMember(tx, {
    tenantId,
    node: resolved.node,
    stats: resolved.stats,
    asOf: paidAt.toISOString(),
    customerId
  });
  return {
    kind: member ? "member" : "not_member",
    segmentId: resolved.segmentId,
    segmentVersion: resolved.version
  };
}
