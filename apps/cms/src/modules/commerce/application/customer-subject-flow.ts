/**
 * The orchestration of a shopper's data-subject request across its five entry
 * points (Issue #529, ADR-0055 D3): the shopper's own export and erasure on the
 * storefront (bearer session plus a fresh OTP) and, for staff, an export, an
 * erasure REQUEST and the second person's decision. Each function runs inside
 * the caller's RLS-scoped transaction and returns a tagged outcome the route
 * maps to HTTP; none writes a response.
 *
 * ## Ordering rules worth knowing
 *
 * - A refusal is answered BEFORE the one-time code is consumed (the shopper
 *   learns "an order is still open" without burning a code), and re-checked
 *   under the customer row lock inside {@link eraseCustomer}.
 * - An erasure's request row is written in the same transaction as the data
 *   work, so a request is `completed` exactly when the data was changed.
 * - Every disclosure is audited at `critical` with counts, never content.
 * - The export is never stored: a replayed ADMIN export key is a conflict, and
 *   the shopper's export has no key because its code is single-use.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  buildSubjectExport,
  countExportRows,
  type SubjectExportBundle
} from "./customer-subject-export";
import {
  SUBJECT_AUDIT_ACTIONS,
  eraseCustomer,
  findErasureRefusals,
  readCustomerErasureState
} from "./customer-subject-erasure";
import { consumeSubjectOtp } from "./customer-subject-otp";
import {
  decidePendingErasure,
  findSubjectRequestByKey,
  insertSubjectRequest,
  lockSubjectRequest,
  type SubjectRequestRecord
} from "./customer-subject-requests";
import {
  isSeparateChecker,
  type SubjectRefusalCode
} from "../domain/customer-subject-policy";

type Correlation = { correlationId?: string };

// ---------------------------------------------------------------------------
// Storefront (the shopper)
// ---------------------------------------------------------------------------

export type StorefrontExportOutcome =
  | { kind: "otp_invalid" }
  | { kind: "ok"; bundle: SubjectExportBundle; request: SubjectRequestRecord };

export async function storefrontExport(
  tx: Bun.SQL,
  tenantId: string,
  account: { id: string; customerId: string },
  code: string,
  options: Correlation & { now?: Date } = {}
): Promise<StorefrontExportOutcome> {
  const now = options.now ?? new Date();
  const accepted = await consumeSubjectOtp(
    tx,
    tenantId,
    account.id,
    "export",
    code,
    now
  );
  if (!accepted) return { kind: "otp_invalid" };

  const bundle = await buildSubjectExport(
    tx,
    tenantId,
    account.customerId,
    now
  );
  const rowsAffected = countExportRows(bundle);

  const request = await insertSubjectRequest(tx, {
    tenantId,
    customerId: account.customerId,
    accountId: account.id,
    requestType: "export",
    channel: "storefront",
    status: "disclosed",
    rowsAffected,
    correlationId: options.correlationId
  });

  await auditDisclosure(tx, tenantId, request, undefined, options);
  return { kind: "ok", bundle, request };
}

export type StorefrontErasureOutcome =
  | { kind: "otp_invalid" }
  | { kind: "key_conflict" }
  | { kind: "replayed"; request: SubjectRequestRecord }
  | {
      kind: "refused";
      codes: SubjectRefusalCode[];
      request: SubjectRequestRecord;
    }
  | { kind: "erased"; request: SubjectRequestRecord };

export async function storefrontErase(
  tx: Bun.SQL,
  tenantId: string,
  account: { id: string; customerId: string },
  code: string,
  idempotencyKey: string,
  options: Correlation & { now?: Date } = {}
): Promise<StorefrontErasureOutcome> {
  const now = options.now ?? new Date();

  const earlier = await findSubjectRequestByKey(tx, tenantId, idempotencyKey);
  if (earlier) {
    return earlier.customerId === account.customerId &&
      earlier.requestType === "erasure" &&
      earlier.channel === "storefront"
      ? { kind: "replayed", request: earlier }
      : { kind: "key_conflict" };
  }

  const refusals = await findErasureRefusals(tx, tenantId, account.customerId);
  if (refusals.length > 0) {
    return refuse(tx, tenantId, account, refusals, idempotencyKey, options);
  }

  const accepted = await consumeSubjectOtp(
    tx,
    tenantId,
    account.id,
    "erasure",
    code,
    now
  );
  if (!accepted) return { kind: "otp_invalid" };

  const outcome = await eraseCustomer(tx, tenantId, account.customerId, {
    correlationId: options.correlationId
  });
  if (outcome.kind === "not_found") return { kind: "otp_invalid" };
  if (outcome.kind === "refused") {
    return refuse(
      tx,
      tenantId,
      account,
      outcome.codes,
      idempotencyKey,
      options
    );
  }

  const request = await insertSubjectRequest(tx, {
    tenantId,
    customerId: account.customerId,
    accountId: account.id,
    requestType: "erasure",
    channel: "storefront",
    status: "completed",
    idempotencyKey,
    rowsAffected: outcome.rowsAffected,
    retainedSummary: outcome.summary,
    completedAt: now,
    correlationId: options.correlationId
  });
  return { kind: "erased", request };
}

async function refuse(
  tx: Bun.SQL,
  tenantId: string,
  account: { id: string; customerId: string },
  codes: SubjectRefusalCode[],
  idempotencyKey: string,
  options: Correlation
): Promise<StorefrontErasureOutcome> {
  const request = await insertSubjectRequest(tx, {
    tenantId,
    customerId: account.customerId,
    accountId: account.id,
    requestType: "erasure",
    channel: "storefront",
    status: "refused",
    refusalCode: codes[0],
    idempotencyKey,
    correlationId: options.correlationId
  });
  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: "commerce",
    action: SUBJECT_AUDIT_ACTIONS.erasureRefused,
    resourceType: "customer_subject_request",
    resourceId: request.id,
    severity: "warning",
    message: "A shopper's erasure request was refused.",
    attributes: {
      customerId: account.customerId,
      codes,
      channel: "storefront"
    },
    correlationId: options.correlationId
  });
  return { kind: "refused", codes, request };
}

// ---------------------------------------------------------------------------
// Admin (staff on a shopper's behalf)
// ---------------------------------------------------------------------------

export type AdminExportOutcome =
  | { kind: "not_found" }
  | { kind: "key_replayed" }
  | { kind: "ok"; bundle: SubjectExportBundle; request: SubjectRequestRecord };

export async function adminExport(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  customerId: string,
  idempotencyKey: string,
  options: Correlation = {}
): Promise<AdminExportOutcome> {
  const state = await readCustomerErasureState(tx, tenantId, customerId);
  if (!state.exists) return { kind: "not_found" };

  if (await findSubjectRequestByKey(tx, tenantId, idempotencyKey)) {
    return { kind: "key_replayed" };
  }

  const bundle = await buildSubjectExport(tx, tenantId, customerId);
  const request = await insertSubjectRequest(tx, {
    tenantId,
    customerId,
    accountId: null,
    requestType: "export",
    channel: "admin",
    status: "disclosed",
    idempotencyKey,
    requestedByTenantUserId: actorTenantUserId,
    rowsAffected: countExportRows(bundle),
    correlationId: options.correlationId
  });
  await auditDisclosure(tx, tenantId, request, actorTenantUserId, options);
  return { kind: "ok", bundle, request };
}

export type AdminErasureRequestOutcome =
  | { kind: "not_found" }
  | { kind: "replayed"; request: SubjectRequestRecord }
  | { kind: "key_conflict" }
  | {
      kind: "refused";
      codes: SubjectRefusalCode[];
      request: SubjectRequestRecord;
    }
  | { kind: "pending"; request: SubjectRequestRecord };

export async function adminRequestErasure(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  customerId: string,
  reason: string | null,
  idempotencyKey: string,
  options: Correlation = {}
): Promise<AdminErasureRequestOutcome> {
  const state = await readCustomerErasureState(tx, tenantId, customerId);
  if (!state.exists) return { kind: "not_found" };

  const earlier = await findSubjectRequestByKey(tx, tenantId, idempotencyKey);
  if (earlier) {
    return earlier.customerId === customerId &&
      earlier.requestType === "erasure" &&
      earlier.channel === "admin"
      ? { kind: "replayed", request: earlier }
      : { kind: "key_conflict" };
  }

  const refusals = await findErasureRefusals(tx, tenantId, customerId);
  if (refusals.length > 0) {
    const request = await insertSubjectRequest(tx, {
      tenantId,
      customerId,
      accountId: null,
      requestType: "erasure",
      channel: "admin",
      status: "refused",
      refusalCode: refusals[0],
      reason,
      idempotencyKey,
      requestedByTenantUserId: actorTenantUserId,
      correlationId: options.correlationId
    });
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: "commerce",
      action: SUBJECT_AUDIT_ACTIONS.erasureRefused,
      resourceType: "customer_subject_request",
      resourceId: request.id,
      severity: "warning",
      message: "An erasure request for a shopper was refused.",
      attributes: { customerId, codes: refusals, channel: "admin" },
      correlationId: options.correlationId
    });
    return { kind: "refused", codes: refusals, request };
  }

  const request = await insertSubjectRequest(tx, {
    tenantId,
    customerId,
    accountId: null,
    requestType: "erasure",
    channel: "admin",
    status: "pending_approval",
    reason,
    idempotencyKey,
    requestedByTenantUserId: actorTenantUserId,
    correlationId: options.correlationId
  });
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: "commerce",
    action: SUBJECT_AUDIT_ACTIONS.erasureRequested,
    resourceType: "customer_subject_request",
    resourceId: request.id,
    severity: "warning",
    message:
      "An erasure was requested for a shopper and awaits a second person.",
    attributes: { customerId, hasReason: reason !== null },
    correlationId: options.correlationId
  });
  return { kind: "pending", request };
}

export type AdminDecisionOutcome =
  | { kind: "not_found" }
  | { kind: "not_pending"; status: string }
  | { kind: "same_person" }
  | { kind: "lost_race" }
  | {
      kind: "refused";
      codes: SubjectRefusalCode[];
      request: SubjectRequestRecord;
    }
  | { kind: "rejected"; request: SubjectRequestRecord }
  | { kind: "erased"; request: SubjectRequestRecord };

export async function adminDecideErasure(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  requestId: string,
  decision: "approve" | "reject",
  options: Correlation = {}
): Promise<AdminDecisionOutcome> {
  const pending = await lockSubjectRequest(tx, tenantId, requestId);
  if (!pending) return { kind: "not_found" };
  if (
    pending.status !== "pending_approval" ||
    pending.requestType !== "erasure"
  ) {
    // A retry after a lost response: the same checker repeating the decision
    // that already settled this request gets the stored decision back, not a
    // 409. Any other combination is still "not pending".
    if (
      pending.requestType === "erasure" &&
      pending.decidedByTenantUserId === actorTenantUserId
    ) {
      if (decision === "reject" && pending.status === "rejected") {
        return { kind: "rejected", request: pending };
      }
      if (decision === "approve" && pending.status === "completed") {
        return { kind: "erased", request: pending };
      }
    }
    return { kind: "not_pending", status: pending.status };
  }
  if (!isSeparateChecker(pending.requestedByTenantUserId, actorTenantUserId)) {
    return { kind: "same_person" };
  }

  if (decision === "reject") {
    const rejected = await decidePendingErasure(tx, {
      tenantId,
      requestId,
      decidedByTenantUserId: actorTenantUserId,
      decision: "rejected"
    });
    if (!rejected) return { kind: "lost_race" };
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: "commerce",
      action: SUBJECT_AUDIT_ACTIONS.erasureRejected,
      resourceType: "customer_subject_request",
      resourceId: requestId,
      severity: "warning",
      message: "A shopper erasure request was rejected by the second person.",
      attributes: { customerId: pending.customerId },
      correlationId: options.correlationId
    });
    return { kind: "rejected", request: rejected };
  }

  const outcome = await eraseCustomer(tx, tenantId, pending.customerId, {
    actorTenantUserId,
    correlationId: options.correlationId
  });

  if (outcome.kind === "not_found") return { kind: "not_found" };

  if (outcome.kind === "refused") {
    const refused = await decidePendingErasure(tx, {
      tenantId,
      requestId,
      decidedByTenantUserId: actorTenantUserId,
      decision: "refused",
      refusalCode: outcome.codes[0]
    });
    if (!refused) return { kind: "lost_race" };
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: "commerce",
      action: SUBJECT_AUDIT_ACTIONS.erasureRefused,
      resourceType: "customer_subject_request",
      resourceId: requestId,
      severity: "warning",
      message:
        "A pending erasure was refused at approval: the shopper's state changed.",
      attributes: { customerId: pending.customerId, codes: outcome.codes },
      correlationId: options.correlationId
    });
    return { kind: "refused", codes: outcome.codes, request: refused };
  }

  const completed = await decidePendingErasure(tx, {
    tenantId,
    requestId,
    decidedByTenantUserId: actorTenantUserId,
    decision: "completed",
    rowsAffected: outcome.rowsAffected,
    retainedSummary: outcome.summary
  });
  // The request row was locked above, so a miss here is a broken invariant, not
  // a race. The data work has been written in this transaction: throw so the
  // route's transaction rolls ALL of it back rather than commit an erasure with
  // no request row to say it happened.
  if (!completed) {
    throw new Error(
      "customer-subject-flow: the locked pending erasure could not be completed."
    );
  }
  return { kind: "erased", request: completed };
}

async function auditDisclosure(
  tx: Bun.SQL,
  tenantId: string,
  request: SubjectRequestRecord,
  actorTenantUserId: string | undefined,
  options: Correlation
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: "commerce",
    action: SUBJECT_AUDIT_ACTIONS.exported,
    resourceType: "customer_subject_request",
    resourceId: request.id,
    severity: "critical",
    message: "A shopper's personal data was disclosed as an export bundle.",
    attributes: {
      customerId: request.customerId,
      channel: request.channel,
      rowsAffected: request.rowsAffected
    },
    correlationId: options.correlationId
  });
}
