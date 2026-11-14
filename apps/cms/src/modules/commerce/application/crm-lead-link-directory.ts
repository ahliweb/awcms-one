/**
 * The CRM lead link (Issue #463, ADR-0056): confirm that a `crm_leads` prospect
 * became a commerce customer on VERIFIED commerce facts, keep commerce's own
 * record of it, and reverse it. This file holds every SQL statement the adapter
 * runs; `CrmLeadPort` (injected, never imported from `crm_leads`) is the only
 * way the lead is read or changed.
 *
 * ## Guarantees
 *
 *   - **No fuzzy matching.** The lead and the customer are named explicitly by a
 *     person holding both permissions; nothing here compares a phone, an e-mail
 *     or a social handle. The customer must exist in the tenant (RLS) and not be
 *     erased; the lead must exist in the tenant (the port reads it under the same
 *     transaction's tenant setting), so a lead or customer of another tenant is
 *     indistinguishable from a missing one.
 *   - **Verified evidence only.** The evidence is read from the database (a
 *     registration the shopper proved by OTP, or a paid order of THAT customer),
 *     never taken from the request. See `domain/crm-lead-link.ts`.
 *   - **No customer master fork.** The only copy of the relationship in commerce
 *     is the opaque link row; the only copy in `crm_leads` is the port's opaque
 *     `externalCustomerRef`. No name, phone or e-mail moves in either direction.
 *   - **Replay is a no-op.** The evidence reference is the key on both sides: a
 *     replayed confirmation returns the existing link and publishes nothing; the
 *     same evidence naming a DIFFERENT lead or customer is `evidence_reused`.
 *   - **The route authorizes and audits.** The port checks nothing and audits
 *     nothing; the route authorizes `crm_leads.conversions.approve` and this file
 *     audits the business action with ids only.
 *
 * Every refusal is a returned outcome that wrote nothing; only a database
 * failure throws.
 */
import type {
  CrmLeadConversionOutcome,
  CrmLeadPort,
  CrmLeadReversalOutcome
} from "../../_shared/ports/crm-lead-port";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import { resolveModuleEnabled } from "../../identity-access/application/auth-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  COMMERCE_CUSTOMER_AGGREGATE_TYPE,
  COMMERCE_CUSTOMER_CONVERTED_EVENT_TYPE,
  COMMERCE_EVENT_VERSION
} from "../domain/commerce-events";
import {
  CRM_LEAD_LINK_LIST_LIMIT,
  customerRef,
  evidenceRefFor,
  orderEvidenceIsReverted,
  reversalEvidenceRef,
  verifyPaidOrderEvidence,
  verifyRegistrationEvidence,
  type CreateCrmLeadLinkInput,
  type CrmLeadLinkEvidenceKind,
  type CrmLeadLinkReversalCause,
  type CrmLeadLinkState,
  type EvidenceVerdict
} from "../domain/crm-lead-link";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_crm_lead_link";
const PRODUCER_MODULE = "commerce";
const CRM_LEADS_MODULE_KEY = "crm_leads";

export type CrmLeadLink = {
  id: string;
  leadId: string;
  customerId: string;
  orderId: string | null;
  evidenceKind: CrmLeadLinkEvidenceKind;
  conversionId: string;
  firstSourceKind: string | null;
  firstTouchId: string | null;
  state: CrmLeadLinkState;
  linkedAt: string;
  reversalCause: CrmLeadLinkReversalCause | null;
  reversalRequestedAt: string | null;
  reversedAt: string | null;
};

type LinkRow = {
  id: string;
  lead_id: string;
  customer_id: string;
  order_id: string | null;
  evidence_kind: CrmLeadLinkEvidenceKind;
  evidence_ref: string;
  conversion_id: string;
  lead_first_source_kind: string | null;
  lead_first_touch_id: string | null;
  state: CrmLeadLinkState;
  linked_at: Date;
  reversal_cause: CrmLeadLinkReversalCause | null;
  reversal_requested_at: Date | null;
  reversed_at: Date | null;
};

const LINK_COLUMNS =
  "id, lead_id, customer_id, order_id, evidence_kind, evidence_ref, conversion_id, lead_first_source_kind, lead_first_touch_id, state, linked_at, reversal_cause, reversal_requested_at, reversed_at";

function toLink(row: LinkRow): CrmLeadLink {
  return {
    id: row.id,
    leadId: row.lead_id,
    customerId: row.customer_id,
    orderId: row.order_id,
    evidenceKind: row.evidence_kind,
    conversionId: row.conversion_id,
    firstSourceKind: row.lead_first_source_kind,
    firstTouchId: row.lead_first_touch_id,
    state: row.state,
    linkedAt: new Date(row.linked_at).toISOString(),
    reversalCause: row.reversal_cause,
    reversalRequestedAt: row.reversal_requested_at
      ? new Date(row.reversal_requested_at).toISOString()
      : null,
    reversedAt: row.reversed_at ? new Date(row.reversed_at).toISOString() : null
  };
}

// ---------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------

export type CrmLeadLinkRefusal =
  | { kind: "crm_leads_unavailable" }
  | { kind: "lead_not_found" }
  | { kind: "customer_not_found" }
  | { kind: "order_not_found" }
  | { kind: "evidence_not_verified"; reason: string }
  | {
      kind: "conversion_refused";
      outcome: Exclude<
        CrmLeadConversionOutcome["outcome"],
        "converted" | "replayed" | "not_found"
      >;
    }
  | { kind: "lead_already_linked" }
  | { kind: "evidence_reused" };

export type LinkLeadOutcome =
  | { kind: "linked"; link: CrmLeadLink }
  | { kind: "replayed"; link: CrmLeadLink }
  | CrmLeadLinkRefusal;

type CustomerRow = { id: string; erased_at: Date | null };
type AccountRow = {
  status: string;
  email_verified_at: Date | null;
  deleted_at: Date | null;
};
type OrderRow = {
  customer_id: string;
  status: string;
  payment_status: string;
  deleted_at: Date | null;
};

async function findLinkByEvidence(
  tx: Bun.SQL,
  tenantId: string,
  evidenceRef: string
): Promise<LinkRow | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(LINK_COLUMNS)}
    FROM awcms_commerce_crm_lead_links
    WHERE tenant_id = ${tenantId} AND evidence_ref = ${evidenceRef}
  `) as LinkRow[];
  return rows[0] ?? null;
}

/**
 * Read the commerce fact the conversion rests on. A customer that does not exist
 * in the tenant, or an order that is not that customer's, is a refusal of its own
 * kind and never a hint about another tenant's rows (RLS filters them first).
 */
async function verifyEvidence(
  tx: Bun.SQL,
  tenantId: string,
  input: CreateCrmLeadLinkInput,
  customer: CustomerRow
): Promise<
  | { ok: true }
  | {
      ok: false;
      refusal: Extract<
        CrmLeadLinkRefusal,
        { kind: "order_not_found" | "evidence_not_verified" }
      >;
    }
> {
  let verdict: EvidenceVerdict;

  if (input.evidenceKind === "customer_registration") {
    const accounts = (await tx`
      SELECT status, email_verified_at, deleted_at
      FROM awcms_commerce_customer_accounts
      WHERE tenant_id = ${tenantId} AND customer_id = ${customer.id}
    `) as AccountRow[];
    const account = accounts[0];
    verdict = verifyRegistrationEvidence(
      account
        ? {
            status: account.status,
            emailVerified: account.email_verified_at !== null,
            deleted: account.deleted_at !== null,
            customerErased: customer.erased_at !== null
          }
        : null
    );
  } else {
    const orders = (await tx`
      SELECT customer_id, status, payment_status, deleted_at
      FROM awcms_commerce_orders
      WHERE tenant_id = ${tenantId} AND id = ${input.orderId}
    `) as OrderRow[];
    const order = orders[0];
    if (!order) {
      return { ok: false, refusal: { kind: "order_not_found" } };
    }
    verdict = verifyPaidOrderEvidence(
      {
        customerId: order.customer_id,
        status: order.status,
        paymentStatus: order.payment_status,
        deleted: order.deleted_at !== null
      },
      customer.id
    );
  }

  return verdict.verified
    ? { ok: true }
    : {
        ok: false,
        refusal: { kind: "evidence_not_verified", reason: verdict.reason }
      };
}

export async function linkLeadToCustomer(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateCrmLeadLinkInput,
  port: CrmLeadPort,
  correlationId?: string
): Promise<LinkLeadOutcome> {
  if (!(await resolveModuleEnabled(tx, tenantId, CRM_LEADS_MODULE_KEY))) {
    return { kind: "crm_leads_unavailable" };
  }

  const state = await port.readLeadState(tx, tenantId, input.leadId);
  if (!state) return { kind: "lead_not_found" };

  const customers = (await tx`
    SELECT id, erased_at
    FROM awcms_commerce_customers
    WHERE tenant_id = ${tenantId} AND id = ${input.customerId}
      AND deleted_at IS NULL
  `) as CustomerRow[];
  const customer = customers[0];
  if (!customer) return { kind: "customer_not_found" };

  const evidenceRef = evidenceRefFor(
    input.evidenceKind,
    input.customerId,
    input.orderId
  )!;

  // Serialise concurrent confirmations of the same lead or the same evidence
  // for the rest of the transaction, so the probes below are authoritative.
  await tx`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:crm_lead_link:${input.leadId}`}, 0)
    )
  `;
  await tx`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${tenantId}:crm_lead_link:${evidenceRef}`}, 0)
    )
  `;

  // A replay: the same evidence naming the same lead and customer returns what
  // was recorded, whatever has happened since (the evidence reference is the
  // key). The same evidence naming another lead or customer is a refusal.
  const prior = await findLinkByEvidence(tx, tenantId, evidenceRef);
  if (prior) {
    return prior.lead_id === input.leadId &&
      prior.customer_id === input.customerId
      ? { kind: "replayed", link: toLink(prior) }
      : { kind: "evidence_reused" };
  }

  // One live link per lead. A conversion reversed in CRM directly leaves the
  // link `linked`: the person reverses the link first, which reconciles it.
  const liveForLead = (await tx`
    SELECT 1 AS one FROM awcms_commerce_crm_lead_links
    WHERE tenant_id = ${tenantId} AND lead_id = ${input.leadId}
      AND state <> 'reversed'
    LIMIT 1
  `) as unknown[];
  if (liveForLead.length > 0) return { kind: "lead_already_linked" };

  const verified = await verifyEvidence(tx, tenantId, input, customer);
  if (!verified.ok) return verified.refusal;

  const outcome = await port.confirmConversion(
    tx,
    tenantId,
    actorTenantUserId,
    {
      leadId: input.leadId,
      expectedVersion: input.expectedVersion,
      externalCustomerRef: customerRef(input.customerId),
      evidenceRef,
      occurredAt: new Date()
    },
    correlationId ?? null
  );

  if (outcome.outcome === "not_found") return { kind: "lead_not_found" };
  if (outcome.outcome === "evidence_reused") return { kind: "evidence_reused" };
  if (outcome.outcome !== "converted" && outcome.outcome !== "replayed") {
    return { kind: "conversion_refused", outcome: outcome.outcome };
  }

  // No unique-violation handling on purpose: the advisory lock and the two
  // probes above make a lost race unreachable, and the conversion the port just
  // recorded lives in THIS transaction, so any failure here must roll the whole
  // request back (a thrown error), never be mapped to a response that commits it.
  const rows = (await tx`
    INSERT INTO awcms_commerce_crm_lead_links
      (tenant_id, lead_id, customer_id, order_id, evidence_kind, evidence_ref,
       conversion_id, lead_first_source_kind, lead_first_touch_id,
       linked_by_tenant_user_id)
    VALUES (
      ${tenantId}, ${input.leadId}, ${input.customerId}, ${input.orderId},
      ${input.evidenceKind}, ${evidenceRef}, ${outcome.conversionId},
      ${state.firstSourceKind}, ${state.firstTouchId}, ${actorTenantUserId}
    )
    RETURNING ${tx.unsafe(LINK_COLUMNS)}
  `) as LinkRow[];

  const link = toLink(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.crm_lead_link.created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: link.id,
    severity: "warning",
    message:
      "A CRM lead was confirmed as a commerce customer on verified commerce evidence.",
    attributes: {
      leadId: link.leadId,
      customerId: link.customerId,
      evidenceKind: link.evidenceKind,
      ...(link.orderId ? { orderId: link.orderId } : {}),
      conversionId: link.conversionId
    },
    correlationId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_CUSTOMER_CONVERTED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_CUSTOMER_AGGREGATE_TYPE,
    aggregateId: link.customerId,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: {
      linkId: link.id,
      customerId: link.customerId,
      leadId: link.leadId,
      conversionId: link.conversionId,
      evidenceKind: link.evidenceKind,
      orderId: link.orderId,
      firstSourceKind: link.firstSourceKind,
      firstTouchId: link.firstTouchId
    }
  });

  return { kind: "linked", link };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listCrmLeadLinks(
  tx: Bun.SQL,
  tenantId: string,
  filter: {
    leadId?: string;
    customerId?: string;
    state?: CrmLeadLinkState;
  } = {}
): Promise<CrmLeadLink[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(LINK_COLUMNS)}
    FROM awcms_commerce_crm_lead_links
    WHERE tenant_id = ${tenantId}
      AND (${filter.leadId ?? null}::uuid IS NULL OR lead_id = ${filter.leadId ?? null}::uuid)
      AND (${filter.customerId ?? null}::uuid IS NULL OR customer_id = ${filter.customerId ?? null}::uuid)
      AND (${filter.state ?? null}::text IS NULL OR state = ${filter.state ?? null}::text)
    ORDER BY linked_at DESC, id DESC
    LIMIT ${CRM_LEAD_LINK_LIST_LIMIT}
  `) as LinkRow[];
  return rows.map(toLink);
}

// ---------------------------------------------------------------------------
// Reverse (a person applies it, through the port)
// ---------------------------------------------------------------------------

export type ReverseLinkOutcome =
  | { kind: "reversed"; link: CrmLeadLink }
  | { kind: "not_found" }
  | { kind: "already_reversed" }
  | { kind: "crm_leads_unavailable" }
  | { kind: "conversion_not_found" }
  | { kind: "evidence_reused" }
  | { kind: "input_invalid" };

export async function reverseCrmLeadLink(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  linkId: string,
  port: CrmLeadPort,
  correlationId?: string
): Promise<ReverseLinkOutcome> {
  const locked = (await tx`
    SELECT ${tx.unsafe(LINK_COLUMNS)}
    FROM awcms_commerce_crm_lead_links
    WHERE tenant_id = ${tenantId} AND id = ${linkId}
    FOR UPDATE
  `) as LinkRow[];
  const row = locked[0];
  if (!row) return { kind: "not_found" };
  if (row.state === "reversed") return { kind: "already_reversed" };

  if (!(await resolveModuleEnabled(tx, tenantId, CRM_LEADS_MODULE_KEY))) {
    return { kind: "crm_leads_unavailable" };
  }

  const outcome: CrmLeadReversalOutcome = await port.reverseConversion(
    tx,
    tenantId,
    actorTenantUserId,
    {
      conversionId: row.conversion_id,
      evidenceRef: reversalEvidenceRef(row.id),
      occurredAt: new Date()
    },
    correlationId ?? null
  );

  if (outcome.outcome === "not_found") return { kind: "conversion_not_found" };
  if (outcome.outcome === "evidence_reused") return { kind: "evidence_reused" };
  if (outcome.outcome === "input_invalid") return { kind: "input_invalid" };
  // `already_reversed` on the CRM side means a person reversed it there first:
  // reconcile commerce's record rather than leave the two disagreeing.

  const cause: CrmLeadLinkReversalCause = row.reversal_cause ?? "manual";
  const updated = (await tx`
    UPDATE awcms_commerce_crm_lead_links
    SET state = 'reversed',
        reversal_cause = ${cause},
        reversal_requested_at = COALESCE(reversal_requested_at, now()),
        reversed_at = now(),
        reversed_by_tenant_user_id = ${actorTenantUserId},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${linkId}
    RETURNING ${tx.unsafe(LINK_COLUMNS)}
  `) as LinkRow[];
  const link = toLink(updated[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.crm_lead_link.reversed",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: link.id,
    severity: "warning",
    message:
      "A confirmed lead-to-customer conversion was reversed; the CRM conversion was reversed through the port.",
    attributes: {
      leadId: link.leadId,
      customerId: link.customerId,
      conversionId: link.conversionId,
      cause,
      crmAlreadyReversed: outcome.outcome === "already_reversed"
    },
    correlationId
  });

  return { kind: "reversed", link };
}

// ---------------------------------------------------------------------------
// Flag (the worker's half: it can mark, never reverse)
// ---------------------------------------------------------------------------

export type FlagResult =
  { kind: "flagged"; count: number } | { kind: "skipped"; reason: string };

/**
 * Mark every `linked` link that rests on `orderId` as `reversal_pending`. Runs as
 * `awcms_worker` (a domain-event consumer), which holds no privilege on any
 * `awcms_crm_*` table, so it cannot reverse a conversion; a person does, through
 * `reverseCrmLeadLink`. Idempotent: only `linked` rows move.
 */
export async function flagLinksForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  cause: CrmLeadLinkReversalCause,
  actorTenantUserId: string | null,
  correlationId?: string
): Promise<FlagResult> {
  const flagged = (await tx`
    UPDATE awcms_commerce_crm_lead_links
    SET state = 'reversal_pending',
        reversal_cause = ${cause},
        reversal_requested_at = now(),
        reversal_actor_tenant_user_id = ${actorTenantUserId},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
      AND state = 'linked'
    RETURNING id
  `) as { id: string }[];

  for (const row of flagged) {
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: row.id,
      correlationId,
      action: "commerce.crm_lead_link.reversal_requested",
      severity: "warning",
      message:
        "The order a lead-to-customer conversion rests on was cancelled or fully refunded; a person must reverse the conversion in CRM.",
      attributes: { cause, orderId }
    });
  }

  return { kind: "flagged", count: flagged.length };
}

/** The cancelling or refunding person, from the delivered event's own envelope. */
async function eventActor(
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

async function hasLiveLinkOnOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 AS one FROM awcms_commerce_crm_lead_links
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND state = 'linked'
    LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

/** Consumer body of `order.cancelled`. */
export async function flagCrmLeadLinksForCancelledOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  eventId: string,
  correlationId?: string
): Promise<FlagResult> {
  if (!(await hasLiveLinkOnOrder(tx, tenantId, orderId))) {
    return { kind: "skipped", reason: "no_live_link" };
  }
  const actor = await eventActor(tx, tenantId, eventId);
  return flagLinksForOrder(
    tx,
    tenantId,
    orderId,
    "order_cancelled",
    actor,
    correlationId
  );
}

/**
 * Consumer body of `refund.settled`: flags only when the return is `completed`
 * (every refund leg settled) and EVERY line of the order is now fully returned.
 * A partial return leaves a real sale, so the conversion stands.
 */
export async function flagCrmLeadLinksForSettledRefund(
  tx: Bun.SQL,
  tenantId: string,
  returnId: string,
  eventId: string,
  correlationId?: string
): Promise<FlagResult> {
  const head = (await tx`
    SELECT order_id, status
    FROM awcms_commerce_returns
    WHERE tenant_id = ${tenantId} AND id = ${returnId}
  `) as { order_id: string; status: string }[];
  const ret = head[0];
  if (!ret) return { kind: "skipped", reason: "return_not_found" };
  if (ret.status !== "completed") {
    return { kind: "skipped", reason: "return_not_settled" };
  }
  if (!(await hasLiveLinkOnOrder(tx, tenantId, ret.order_id))) {
    return { kind: "skipped", reason: "no_live_link" };
  }

  const lines = (await tx`
    SELECT oi.quantity::int AS ordered,
           COALESCE(SUM(rl.quantity), 0)::int AS returned
    FROM awcms_commerce_order_items oi
    LEFT JOIN (
      SELECT rl2.tenant_id, rl2.order_item_id, rl2.quantity
      FROM awcms_commerce_return_lines rl2
      JOIN awcms_commerce_returns r
        ON r.tenant_id = rl2.tenant_id AND r.id = rl2.return_id
           AND r.status = 'completed'
    ) rl ON rl.tenant_id = oi.tenant_id AND rl.order_item_id = oi.id
    WHERE oi.tenant_id = ${tenantId} AND oi.order_id = ${ret.order_id}
    GROUP BY oi.id, oi.quantity
  `) as { ordered: number; returned: number }[];

  const verdict = orderEvidenceIsReverted({
    status: "completed",
    lines: lines.map((line) => ({
      ordered: Number(line.ordered),
      returned: Number(line.returned)
    }))
  });
  if (!verdict.reverted || verdict.cause === null) {
    return { kind: "skipped", reason: "partial_return" };
  }

  const actor = await eventActor(tx, tenantId, eventId);
  return flagLinksForOrder(
    tx,
    tenantId,
    ret.order_id,
    verdict.cause,
    actor,
    correlationId
  );
}
