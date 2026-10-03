/**
 * Work / service orders (Issue #286, ADR-0029 D6): the OPERATIONAL record of a
 * job - what is to be done, for whom, who is doing it, by when, and where it
 * stands.
 *
 * A work order holds no money. If the job is billable the money lives where all
 * money lives: on a commerce order and its payment ledger (ADR-0025). A work
 * order only POINTS at them: `order_id` (attached at creation, once) and the
 * `quotation_id` + `quotation_version` it came from (the ACCEPTED version of an
 * accepted or converted quotation, a composite FK to the real version row). A
 * booking reference is a documented hook, not a column pointing at a table that
 * does not exist.
 *
 * Status moves follow a fixed machine (`LEGAL_WORK_ORDER_TRANSITIONS`, mirrored
 * by a trigger); every move writes an append-only history row in the same
 * transaction and the `work_order.status_changed` domain event. An unknown or
 * other-tenant customer / quotation / order reference is rejected identically
 * (`reference_not_found` naming only the field the caller sent).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import {
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_WORK_ORDER_AGGREGATE_TYPE,
  COMMERCE_WORK_ORDER_STATUS_CHANGED_EVENT_TYPE
} from "../domain/commerce-events";
import {
  canTransitionWorkOrder,
  type CreateWorkOrderInput,
  type WorkOrderPriority,
  type WorkOrderStatus,
  type WorkOrderTransitionInput
} from "../domain/documents";
import { allocateDocumentNumber } from "./document-numbering";
import { IdempotencyPayloadMismatchError } from "./order-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "work_order";
const PRODUCER_MODULE = "commerce";
const CREATE_SCOPE = "commerce.work_orders.create";
const UPDATE_SCOPE = "commerce.work_orders.update";

export const WORK_ORDER_LIST_LIMIT = 50;

export type WorkOrderRecord = {
  id: string;
  number: string;
  title: string;
  description: string | null;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  customerId: string | null;
  quotationId: string | null;
  quotationVersion: number | null;
  orderId: string | null;
  assigneeTenantUserId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdByTenantUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkOrderEventRecord = {
  id: string;
  fromStatus: WorkOrderStatus | null;
  toStatus: WorkOrderStatus;
  note: string | null;
  actorTenantUserId: string;
  createdAt: string;
};

export type WorkOrderDetail = WorkOrderRecord & {
  events: WorkOrderEventRecord[];
};

type Row = {
  id: string;
  number: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  customer_id: string | null;
  quotation_id: string | null;
  quotation_version: number | null;
  order_id: string | null;
  assignee_tenant_user_id: string | null;
  due_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  created_by_tenant_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = `id, number, title, description, status, priority, customer_id, quotation_id,
  quotation_version, order_id, assignee_tenant_user_id, due_at, completed_at, cancelled_at,
  created_by_tenant_user_id, created_at, updated_at`;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toRecord(row: Row): WorkOrderRecord {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status as WorkOrderStatus,
    priority: row.priority as WorkOrderPriority,
    customerId: row.customer_id,
    quotationId: row.quotation_id,
    quotationVersion:
      row.quotation_version === null ? null : Number(row.quotation_version),
    orderId: row.order_id,
    assigneeTenantUserId: row.assignee_tenant_user_id,
    dueAt: iso(row.due_at),
    completedAt: iso(row.completed_at),
    cancelledAt: iso(row.cancelled_at),
    createdByTenantUserId: row.created_by_tenant_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export async function fetchWorkOrder(
  tx: Bun.SQL,
  tenantId: string,
  workOrderId: string
): Promise<WorkOrderDetail | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(COLUMNS)}
    FROM awcms_commerce_work_orders
    WHERE tenant_id = ${tenantId} AND id = ${workOrderId} AND deleted_at IS NULL
  `) as Row[];
  if (!rows[0]) return null;
  const events = (await tx`
    SELECT id, from_status, to_status, note, actor_tenant_user_id, created_at
    FROM awcms_commerce_work_order_events
    WHERE tenant_id = ${tenantId} AND work_order_id = ${workOrderId}
    ORDER BY seq ASC
  `) as {
    id: string;
    from_status: string | null;
    to_status: string;
    note: string | null;
    actor_tenant_user_id: string;
    created_at: Date;
  }[];
  return {
    ...toRecord(rows[0]),
    events: events.map((event) => ({
      id: event.id,
      fromStatus: event.from_status as WorkOrderStatus | null,
      toStatus: event.to_status as WorkOrderStatus,
      note: event.note,
      actorTenantUserId: event.actor_tenant_user_id,
      createdAt: event.created_at.toISOString()
    }))
  };
}

export type WorkOrderListFilters = {
  status?: WorkOrderStatus;
  assigneeTenantUserId?: string;
};
export type WorkOrderListPage = {
  items: WorkOrderRecord[];
  nextCursor: string | null;
};

export async function listWorkOrders(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: WorkOrderListFilters = {}
): Promise<WorkOrderListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const status = filters.status ?? null;
  const assignee = filters.assigneeTenantUserId ?? null;
  const rows = (await tx`
    SELECT ${tx.unsafe(COLUMNS)},
           ${tx.unsafe(keysetCursorCreatedAtSql("w"))} AS created_at_cursor
    FROM awcms_commerce_work_orders w
    WHERE w.tenant_id = ${tenantId} AND w.deleted_at IS NULL
      AND (${status}::text IS NULL OR w.status = ${status})
      AND (${assignee}::uuid IS NULL OR w.assignee_tenant_user_id = ${assignee})
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (w.created_at, w.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY w.created_at DESC, w.id DESC
    LIMIT ${WORK_ORDER_LIST_LIMIT}
  `) as (Row & { created_at_cursor: string })[];
  const last = rows[rows.length - 1];
  return {
    items: rows.map(toRecord),
    nextCursor:
      rows.length === WORK_ORDER_LIST_LIMIT && last
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}

export type CreateWorkOrderOutcome =
  | {
      kind: "reference_not_found";
      field: "customerId" | "quotationId" | "orderId";
    }
  | { kind: "quotation_not_accepted"; status: string }
  | { kind: "created" | "replayed"; workOrder: WorkOrderDetail };

export async function createWorkOrder(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateWorkOrderInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<CreateWorkOrderOutcome> {
  const requestHash = computeRequestHash({
    action: CREATE_SCOPE,
    actorTenantUserId,
    title: input.title,
    description: input.description,
    priority: input.priority,
    customerId: input.customerId,
    quotationId: input.quotationId,
    orderId: input.orderId,
    assigneeTenantUserId: input.assigneeTenantUserId,
    dueAt: input.dueAt ? input.dueAt.toISOString() : null
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      workOrder: existing.responseBody as WorkOrderDetail
    };
  }

  let customerId = input.customerId;
  if (customerId) {
    const rows = (await tx`
      SELECT id FROM awcms_commerce_customers
      WHERE tenant_id = ${tenantId} AND id = ${customerId} AND deleted_at IS NULL
    `) as { id: string }[];
    if (!rows[0]) return { kind: "reference_not_found", field: "customerId" };
  }
  if (input.orderId) {
    const rows = (await tx`
      SELECT id FROM awcms_commerce_orders
      WHERE tenant_id = ${tenantId} AND id = ${input.orderId} AND deleted_at IS NULL
    `) as { id: string }[];
    if (!rows[0]) return { kind: "reference_not_found", field: "orderId" };
  }
  let quotationId: string | null = null;
  let quotationVersion: number | null = null;
  if (input.quotationId) {
    const rows = (await tx`
      SELECT id, status, accepted_version, customer_id
      FROM awcms_commerce_quotations
      WHERE tenant_id = ${tenantId} AND id = ${input.quotationId} AND deleted_at IS NULL
    `) as {
      id: string;
      status: string;
      accepted_version: number | null;
      customer_id: string | null;
    }[];
    const quotation = rows[0];
    if (!quotation)
      return { kind: "reference_not_found", field: "quotationId" };
    if (quotation.accepted_version === null) {
      return { kind: "quotation_not_accepted", status: quotation.status };
    }
    quotationId = quotation.id;
    quotationVersion = Number(quotation.accepted_version);
    customerId = customerId ?? quotation.customer_id;
  }

  // Allocate LAST: nothing fallible sits between here and the insert.
  const allocated = await allocateDocumentNumber(
    tx,
    tenantId,
    "work_order",
    now
  );
  const rows = (await tx`
    INSERT INTO awcms_commerce_work_orders (
      tenant_id, number, title, description, priority, customer_id, quotation_id,
      quotation_version, order_id, assignee_tenant_user_id, due_at,
      created_by_tenant_user_id, created_at, updated_at
    )
    VALUES (
      ${tenantId}, ${allocated.number}, ${input.title}, ${input.description}, ${input.priority},
      ${customerId}, ${quotationId}, ${quotationVersion}, ${input.orderId},
      ${input.assigneeTenantUserId}, ${input.dueAt}, ${actorTenantUserId}, ${now}, ${now}
    )
    RETURNING id
  `) as { id: string }[];
  const workOrderId = rows[0]!.id;
  await tx`
    INSERT INTO awcms_commerce_work_order_events (
      tenant_id, work_order_id, from_status, to_status, actor_tenant_user_id, created_at
    )
    VALUES (${tenantId}, ${workOrderId}, NULL, 'received', ${actorTenantUserId}, ${now})
  `;

  const workOrder = (await fetchWorkOrder(tx, tenantId, workOrderId))!;
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "work_order.create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: workOrderId,
    message: `Work order ${workOrder.number} created.`,
    attributes: {
      number: workOrder.number,
      priority: workOrder.priority,
      quotationId: workOrder.quotationId,
      quotationVersion: workOrder.quotationVersion,
      orderId: workOrder.orderId,
      assigneeTenantUserId: workOrder.assigneeTenantUserId
    },
    correlationId
  });
  await saveIdempotencyRecord(
    tx,
    tenantId,
    CREATE_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    workOrder
  );
  return { kind: "created", workOrder };
}

export type UpdateWorkOrderOutcome =
  | { kind: "not_found" }
  | { kind: "illegal_transition"; from: WorkOrderStatus; to: WorkOrderStatus }
  | { kind: "closed"; status: WorkOrderStatus }
  | { kind: "done" | "replayed"; workOrder: WorkOrderDetail };

export async function updateWorkOrder(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  workOrderId: string,
  input: WorkOrderTransitionInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<UpdateWorkOrderOutcome> {
  const locked = (await tx`
    SELECT ${tx.unsafe(COLUMNS)}
    FROM awcms_commerce_work_orders
    WHERE tenant_id = ${tenantId} AND id = ${workOrderId} AND deleted_at IS NULL
    FOR NO KEY UPDATE
  `) as Row[];
  const current = locked[0];
  if (!current) return { kind: "not_found" };

  const requestHash = computeRequestHash({
    action: UPDATE_SCOPE,
    actorTenantUserId,
    workOrderId,
    status: input.status,
    note: input.note,
    assigneeTenantUserId: input.assigneeTenantUserId,
    dueAt:
      input.dueAt === undefined
        ? undefined
        : input.dueAt
          ? input.dueAt.toISOString()
          : null,
    priority: input.priority
  });
  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    UPDATE_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      workOrder: existing.responseBody as WorkOrderDetail
    };
  }

  const from = current.status as WorkOrderStatus;
  if (from === "completed" || from === "cancelled") {
    return { kind: "closed", status: from };
  }
  const to = input.status ?? from;
  if (
    input.status !== null &&
    input.status !== from &&
    !canTransitionWorkOrder(from, input.status)
  ) {
    return { kind: "illegal_transition", from, to: input.status };
  }

  const assignee =
    input.assigneeTenantUserId === undefined
      ? current.assignee_tenant_user_id
      : input.assigneeTenantUserId;
  const dueAt = input.dueAt === undefined ? current.due_at : input.dueAt;
  const priority = input.priority ?? (current.priority as WorkOrderPriority);
  await tx`
    UPDATE awcms_commerce_work_orders
    SET status = ${to}, assignee_tenant_user_id = ${assignee}, due_at = ${dueAt},
        priority = ${priority},
        completed_at = ${to === "completed" ? now : null},
        cancelled_at = ${to === "cancelled" ? now : null},
        updated_at = ${now}
    WHERE tenant_id = ${tenantId} AND id = ${workOrderId}
  `;

  const statusChanged = to !== from;
  if (statusChanged) {
    await tx`
      INSERT INTO awcms_commerce_work_order_events (
        tenant_id, work_order_id, from_status, to_status, note, actor_tenant_user_id, created_at
      )
      VALUES (${tenantId}, ${workOrderId}, ${from}, ${to}, ${input.note}, ${actorTenantUserId}, ${now})
    `;
  }

  const workOrder = (await fetchWorkOrder(tx, tenantId, workOrderId))!;
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: statusChanged ? "work_order.status" : "work_order.update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: workOrderId,
    message: statusChanged
      ? `Work order ${workOrder.number} moved ${from} -> ${to}.`
      : `Work order ${workOrder.number} updated.`,
    attributes: {
      number: workOrder.number,
      from,
      to,
      priority,
      assigneeTenantUserId: assignee,
      dueAt: iso(dueAt)
    },
    correlationId
  });
  if (statusChanged) {
    await appendDomainEvent(tx, tenantId, {
      eventType: COMMERCE_WORK_ORDER_STATUS_CHANGED_EVENT_TYPE,
      eventVersion: COMMERCE_EVENT_VERSION,
      aggregateType: COMMERCE_WORK_ORDER_AGGREGATE_TYPE,
      aggregateId: workOrderId,
      producerModule: PRODUCER_MODULE,
      correlationId,
      actorTenantUserId,
      payload: {
        workOrderId,
        number: workOrder.number,
        fromStatus: from,
        toStatus: to,
        assigneeTenantUserId: assignee
      }
    });
  }
  await saveIdempotencyRecord(
    tx,
    tenantId,
    UPDATE_SCOPE,
    input.idempotencyKey,
    requestHash,
    200,
    workOrder
  );
  return { kind: "done", workOrder };
}
