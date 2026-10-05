import { recordAuditEvent } from "../../logging/application/audit-log";
import { applyConsumerEffectOnce } from "../application/consumer-effect";
import type { DomainEventConsumerDefinition } from "../domain/consumer-types";
import {
  INVENTORY_EVENT_VERSION,
  INVENTORY_MOVEMENT_POSTED_EVENT_TYPE,
  SAMPLE_RECORDED_EVENT_TYPE,
  SAMPLE_RECORDED_EVENT_VERSION
} from "../domain/event-type-registry";
import { applyEventActivityProjectionIncrement } from "../../reporting/application/event-activity-projection";
import { EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME } from "../../reporting/domain/projection-keys";
import { grantEntitlementsForPaidOrder } from "../../commerce/application/commerce-entitlement-directory";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EVENT_TYPE
} from "../../commerce/domain/commerce-events";
import {
  earnPointsForPaidOrder,
  reverseEarnForCancelledOrder
} from "../../commerce/application/loyalty-ledger";
import {
  INVENTORY_STOCK_CACHE_PROJECTOR_CONSUMER_NAME,
  projectStockCacheFromMovement
} from "../../commerce/application/commerce-inventory-cache-projector";

/**
 * Two representative consumers ("provide at least two representative
 * consumers: one same-process cross-module consumer; one reporting/
 * read-model projection consumer or test fixture"), both registered against
 * `SAMPLE_RECORDED_EVENT_TYPE` — the same self-contained reference event
 * `event-type-registry.ts` documents. Real producer/consumer modules
 * register their OWN entries here when they start using this runtime
 * (deliberately not done for any existing module in this foundation
 * module).
 *
 * Port note (from awcms-mini): the awcms-mini registry also carries two
 * later-wave consumers projecting into `reporting` and `integration_hub`.
 * **That note is now only half true and the half that changed matters.**
 * `integration_hub` is still absent, so its consumer is still not ported.
 * `reporting` EXISTS, and a third consumer below (see
 * `eventActivityProjectorConsumer`) does import it — lines 8-9 of this file.
 *
 * The first two consumers below remain fully self-contained: the audit
 * projector calls `logging`'s public `recordAuditEvent`, and the
 * activity-rollup projector writes only this module's own
 * `awcms_domain_event_activity_daily` table.
 *
 * ## The import direction is worth knowing before you add a fourth
 *
 * `reporting`'s descriptor declares `domain_event_runtime` as a dependency,
 * while this file imports `reporting`. At MODULE level that is a cycle. It is
 * invisible to `bun run modules:dag:check`, which validates declared
 * dependencies only (`listModules()`, no I/O by design) and therefore cannot
 * see an import that was never declared — and declaring this one truthfully
 * would make that gate fail with a cycle. There is no FILE-level cycle:
 * `reporting` mentions this module only in comments and descriptor strings.
 *
 * Do not "fix" this by adding `reporting` to this module's `dependencies`
 * without deciding the real question first: whether a runtime-level module
 * should know a reporting module at all, or whether this consumer belongs in
 * a composition root outside both.
 */

const AUDIT_PROJECTOR_CONSUMER_NAME = "logging.sample_event_audit_projector";

/**
 * Same-process CROSS-MODULE consumer: reacts to a domain event by calling
 * `logging`'s own public `recordAuditEvent` function (the same cross-module
 * call other modules already make directly — audit logging is foundational
 * infrastructure). Demonstrates real cross-module collaboration driven
 * entirely by the dispatcher, with no direct import between a hypothetical
 * "event source" module and `logging` at the call-site that raised the
 * event.
 */
export const sampleAuditProjectorConsumer: DomainEventConsumerDefinition = {
  name: AUDIT_PROJECTOR_CONSUMER_NAME,
  description:
    "Reference same-process cross-module consumer — projects a sample.recorded domain event into the logging module's audit trail via recordAuditEvent.",
  eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
  eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
  handler: async (tx, event, ctx) => {
    await applyConsumerEffectOnce(
      tx,
      ctx.tenantId,
      AUDIT_PROJECTOR_CONSUMER_NAME,
      event.id,
      async () => {
        await recordAuditEvent(tx, {
          tenantId: ctx.tenantId,
          moduleKey: "domain_event_runtime",
          action: "domain_event_runtime.sample.audit_projected",
          resourceType: "domain_event",
          resourceId: event.id,
          severity: "info",
          message: `Sample domain event projected to audit trail (aggregate ${event.aggregateType}:${event.aggregateId}).`,
          attributes: { eventType: event.eventType },
          correlationId: ctx.correlationId
        });
      }
    );
  }
};

const ACTIVITY_ROLLUP_CONSUMER_NAME =
  "domain_event_runtime.activity_rollup_projector";

/**
 * Reference READ-MODEL PROJECTION consumer: maintains
 * `awcms_domain_event_activity_daily`, a small denormalized rollup owned
 * entirely by THIS module — proof the dispatcher can drive a real
 * read-optimized aggregate. It writes only this module's own table (no
 * shared-table write across a module boundary), so it stays self-contained
 * and does not depend on any separate reporting module.
 */
export const activityRollupProjectorConsumer: DomainEventConsumerDefinition = {
  name: ACTIVITY_ROLLUP_CONSUMER_NAME,
  description:
    "Reference reporting/read-model projection consumer — maintains a per-tenant/day/event-type activity rollup (awcms_domain_event_activity_daily) for operational dashboards.",
  eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
  eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
  handler: async (tx, event, ctx) => {
    await applyConsumerEffectOnce(
      tx,
      ctx.tenantId,
      ACTIVITY_ROLLUP_CONSUMER_NAME,
      event.id,
      async () => {
        const activityDate = event.occurredAt.toISOString().slice(0, 10);

        await tx`
            INSERT INTO awcms_domain_event_activity_daily
              (tenant_id, activity_date, event_type, event_count)
            VALUES (${ctx.tenantId}, ${activityDate}, ${event.eventType}, 1)
            ON CONFLICT (tenant_id, activity_date, event_type)
            DO UPDATE SET
              event_count = awcms_domain_event_activity_daily.event_count + 1,
              updated_at = now()
          `;
      }
    );
  }
};

/**
 * Reporting module consumer (ported from awcms-mini Issue #753): projects a
 * `sample.recorded` domain event into `reporting`'s own
 * `awcms_reporting_projection_metrics`
 * (`reporting.event_activity_summary`/`sample_recorded_count` counter) via
 * `applyEventActivityProjectionIncrement`. This IS the one deliberate
 * cross-module edge that wires `domain_event_runtime` -> `reporting/
 * application` — safe against an import cycle because `reporting`'s own
 * `application`/`domain` files import nothing back from
 * `domain_event_runtime` (its rebuild path reads `awcms_domain_events` via
 * a plain SQL table name, never a cross-module TypeScript import).
 *
 * Idempotency: `applyConsumerEffectOnce` (this module's own, reused
 * unchanged) guards against a redelivered event double-incrementing the
 * counter; `reporting`'s own `applyEventActivityProjectionIncrement`
 * ADDITIONALLY defers (throws) while a rebuild owns this projection and
 * uses a rebuild watermark to avoid double-counting on retry — see that
 * file's header comment.
 */
export const eventActivityProjectorConsumer: DomainEventConsumerDefinition = {
  name: EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME,
  description:
    "reporting module consumer — projects a sample.recorded domain event into awcms_reporting_projection_metrics' reporting.event_activity_summary/sample_recorded_count counter.",
  eventTypes: [SAMPLE_RECORDED_EVENT_TYPE],
  eventVersions: [SAMPLE_RECORDED_EVENT_VERSION],
  handler: async (tx, event, ctx) => {
    await applyConsumerEffectOnce(
      tx,
      ctx.tenantId,
      EVENT_ACTIVITY_PROJECTOR_CONSUMER_NAME,
      event.id,
      () =>
        applyEventActivityProjectionIncrement(
          tx,
          ctx.tenantId,
          event.occurredAt
        )
    );
  }
};

const ORDER_PAID_ENTITLEMENT_GRANTOR_CONSUMER_NAME =
  "commerce.order_paid_entitlement_grantor";

/**
 * `commerce` module consumer (Issue #267, IRMbyDUS) — the second deliberate
 * cross-module edge in this file, alongside `eventActivityProjectorConsumer`
 * above: `domain_event_runtime` (this file) imports
 * `commerce/application/commerce-entitlement-directory.ts`. Same "worth
 * knowing before you add a fourth/fifth" import-direction note that
 * consumer's own header states — safe against a FILE-level cycle for the
 * identical reason: `commerce-entitlement-directory.ts` imports nothing
 * from `domain_event_runtime` back (it takes an already-open `tx`; only
 * OTHER commerce files, e.g. `order-directory.ts`'s own
 * `appendDomainEvent` call, import this module's `application/` layer, and
 * that is the pre-existing, declared `commerce -> domain_event_runtime`
 * dependency direction, not a new one this consumer creates).
 *
 * Grants one `awcms_commerce_entitlements` row per distinct product on the
 * order that just turned `paid` — see
 * `commerce-entitlement-directory.ts`'s own header for the full grant
 * logic. Idempotency here is `applyConsumerEffectOnce` guarding the whole
 * handler against a REDELIVERED `order.paid` event; the directory
 * function's own `ON CONFLICT (tenant_id, source_order_id, product_id) DO
 * NOTHING` is the second, independent guard against any other path that
 * could re-run the same grant (see `sql/936`'s header). Together: firing
 * the same `order.paid` event twice yields exactly one entitlement row per
 * (order, product), never two.
 */
export const orderPaidEntitlementGrantorConsumer: DomainEventConsumerDefinition =
  {
    name: ORDER_PAID_ENTITLEMENT_GRANTOR_CONSUMER_NAME,
    description:
      "commerce module consumer — grants one awcms_commerce_entitlements row per distinct product on an order the moment it turns paid (Issue #267, IRMbyDUS).",
    eventTypes: [COMMERCE_ORDER_PAID_EVENT_TYPE],
    eventVersions: [COMMERCE_EVENT_VERSION],
    handler: async (tx, event, ctx) => {
      await applyConsumerEffectOnce(
        tx,
        ctx.tenantId,
        ORDER_PAID_ENTITLEMENT_GRANTOR_CONSUMER_NAME,
        event.id,
        async () => {
          await grantEntitlementsForPaidOrder(
            tx,
            ctx.tenantId,
            event.aggregateId,
            ctx.correlationId
          );
        }
      );
    }
  };

const ORDER_PAID_LOYALTY_EARNER_CONSUMER_NAME =
  "commerce.order_paid_loyalty_earner";
const ORDER_CANCELLED_LOYALTY_REVERSER_CONSUMER_NAME =
  "commerce.order_cancelled_loyalty_reverser";

/**
 * `commerce` module consumer (Issue #289, ADR-0026 D7) — earns loyalty points
 * for the order that just turned `paid`. Same documented `domain_event_runtime
 * -> commerce` module-boundary exception as
 * `orderPaidEntitlementGrantorConsumer` (`tests/module-boundary.test.ts`).
 *
 * UNLIKE the entitlement directory, `loyalty-ledger.ts` publishes a domain
 * event of its own (`loyalty.entry_recorded`), so it imports
 * `application/append-domain-event`, which imports THIS registry
 * (`getConsumersForEventType`) — a file-level import cycle. It is inert: both
 * sides use the other's exports only inside function bodies (never during
 * module evaluation), and ES module live bindings resolve them by call time.
 * Nothing at the top level of either file reads the other.
 *
 * Reads the order's own row — never the event payload, which carries no money
 * — and earns exactly once per order: `applyConsumerEffectOnce` guards the
 * redelivered event, the ledger's `earn:order:<id>` idempotency key guards
 * every other replay path. This consumer is what keeps loyalty OUT of
 * `order-directory.ts`, `pos-directory.ts` and the payment webhook paths: all
 * of them already publish `order.paid`.
 */
export const orderPaidLoyaltyEarnerConsumer: DomainEventConsumerDefinition = {
  name: ORDER_PAID_LOYALTY_EARNER_CONSUMER_NAME,
  description:
    "commerce module consumer — earns loyalty points for an order the moment it turns paid, exactly once per order, from server-side order facts only (Issue #289).",
  eventTypes: [COMMERCE_ORDER_PAID_EVENT_TYPE],
  eventVersions: [COMMERCE_EVENT_VERSION],
  handler: async (tx, event, ctx) => {
    await applyConsumerEffectOnce(
      tx,
      ctx.tenantId,
      ORDER_PAID_LOYALTY_EARNER_CONSUMER_NAME,
      event.id,
      async () => {
        await earnPointsForPaidOrder(
          tx,
          ctx.tenantId,
          event.aggregateId,
          ctx.correlationId
        );
      }
    );
  }
};

/**
 * `commerce` module consumer (Issue #289, ADR-0026 D6) — writes the
 * compensating `reversal` entry for the earn of an order that was cancelled
 * after it had been paid. Never deletes the earn. A no-op for an order that
 * never earned (never paid, walk-in, feature off at the time).
 */
export const orderCancelledLoyaltyReverserConsumer: DomainEventConsumerDefinition =
  {
    name: ORDER_CANCELLED_LOYALTY_REVERSER_CONSUMER_NAME,
    description:
      "commerce module consumer — reverses (compensating entry, never a delete) the loyalty points an order earned when that order is cancelled (Issue #289).",
    eventTypes: [COMMERCE_ORDER_CANCELLED_EVENT_TYPE],
    eventVersions: [COMMERCE_EVENT_VERSION],
    handler: async (tx, event, ctx) => {
      await applyConsumerEffectOnce(
        tx,
        ctx.tenantId,
        ORDER_CANCELLED_LOYALTY_REVERSER_CONSUMER_NAME,
        event.id,
        async () => {
          await reverseEarnForCancelledOrder(
            tx,
            ctx.tenantId,
            event.aggregateId,
            new Date(),
            ctx.correlationId
          );
        }
      );
    }
  };

/**
 * `commerce` module consumer (Issue #282, ADR-0038 D4) - the third deliberate
 * `domain_event_runtime -> commerce` edge in this file (same documented
 * exception as the two above; `tests/module-boundary.test.ts`). It keeps
 * commerce's `stock` write-through cache true when a movement is posted by
 * something other than commerce (a receipt, an adjustment, a transfer).
 *
 * Re-reads the CURRENT ledger balance through `InventoryLedgerPort` instead of
 * trusting the payload, acts only for a tenant in `ledger` mode, the sales
 * location and a `commerce.*` item - see the projector's own header. A LOCAL
 * DIVERGENCE from upstream's file: on a subtree-sync conflict keep both
 * lineages and re-run `tests/integration/commerce-inventory-adapter`.
 */
export const inventoryStockCacheProjectorConsumer: DomainEventConsumerDefinition =
  {
    name: INVENTORY_STOCK_CACHE_PROJECTOR_CONSUMER_NAME,
    description:
      "commerce module consumer - refreshes the stock write-through cache of a commerce product or variant when an inventory movement is posted at the store's sales location by something other than commerce (Issue #282).",
    eventTypes: [INVENTORY_MOVEMENT_POSTED_EVENT_TYPE],
    eventVersions: [INVENTORY_EVENT_VERSION],
    handler: async (tx, event, ctx) => {
      await applyConsumerEffectOnce(
        tx,
        ctx.tenantId,
        INVENTORY_STOCK_CACHE_PROJECTOR_CONSUMER_NAME,
        event.id,
        async () => {
          await projectStockCacheFromMovement(tx, ctx.tenantId, event.payload);
        }
      );
    }
  };

const BASE_DOMAIN_EVENT_CONSUMERS: readonly DomainEventConsumerDefinition[] = [
  sampleAuditProjectorConsumer,
  activityRollupProjectorConsumer,
  eventActivityProjectorConsumer,
  orderPaidEntitlementGrantorConsumer,
  orderPaidLoyaltyEarnerConsumer,
  orderCancelledLoyaltyReverserConsumer,
  inventoryStockCacheProjectorConsumer
];

/**
 * The static consumer registry ("a static consumer registry owned by
 * reviewed source code") — every REAL entry is added by reviewed source
 * code (`BASE_DOMAIN_EVENT_CONSUMERS` above), never a dynamic/
 * database-driven registration. `application/append-domain-event.ts` fans
 * out delivery rows from this list at PUBLISH time;
 * `application/dispatch-domain-events.ts` iterates it at DISPATCH time.
 *
 * `export let` (not `const`) so `registerDomainEventConsumerForTests` below
 * can append a deliberately-failing fake consumer for a single test's
 * duration (retry/backoff/dead-letter scenarios need a handler that
 * reliably throws — neither of the two real consumers ever does). A
 * reassignment here is a LIVE ES module binding — every other module that
 * imports `DOMAIN_EVENT_CONSUMERS` sees the update.
 */
export let DOMAIN_EVENT_CONSUMERS: readonly DomainEventConsumerDefinition[] =
  BASE_DOMAIN_EVENT_CONSUMERS;

/** Test-only. Appends `consumer` to the registry for the remainder of the current test file/process — call `resetDomainEventConsumersForTests()` (typically in `afterEach`) to restore the base two real consumers. Never called from production code. */
export function registerDomainEventConsumerForTests(
  consumer: DomainEventConsumerDefinition
): void {
  DOMAIN_EVENT_CONSUMERS = [...DOMAIN_EVENT_CONSUMERS, consumer];
}

/** Test-only. Restores the registry to exactly the two real, reviewed consumers. */
export function resetDomainEventConsumersForTests(): void {
  DOMAIN_EVENT_CONSUMERS = BASE_DOMAIN_EVENT_CONSUMERS;
}

export function getConsumersForEventType(
  eventType: string
): readonly DomainEventConsumerDefinition[] {
  return DOMAIN_EVENT_CONSUMERS.filter((consumer) =>
    consumer.eventTypes.includes(eventType)
  );
}

export function getConsumerByName(
  name: string
): DomainEventConsumerDefinition | undefined {
  return DOMAIN_EVENT_CONSUMERS.find((consumer) => consumer.name === name);
}
