/**
 * Domain-event consumers of the booking-commerce adapter (ADR-0045 D15),
 * declared once here and spread into `module.ts`'s `domainEventConsumers`.
 * EMPTY in Issue #378: the six frozen names
 * (`commerce.booking_expired_order_canceller`,
 * `commerce.booking_cancelled_order_canceller`,
 * `commerce.booking_cancelled_refund_coordinator`,
 * `commerce.booking_order_paid_confirmer`,
 * `commerce.booking_rescheduled_link_reconciler`,
 * `commerce.booking_no_show_decision_recorder`) arrive with the issues that own
 * their handlers, each appending its descriptor HERE.
 *
 * A consumer's name is permanent (it keys delivery rows and the effect ledger;
 * `domain-events:consumers:check` rejects a rename), keeps the default
 * `runtime_effect_once` idempotency, loads its implementation with a lazy
 * `import()` and never calls `applyConsumerEffectOnce` itself. Add the name to
 * `apps/cms/tests/domain-event-consumer-declarations.test.ts` in the same
 * change.
 */
import type { ModuleDomainEventConsumer } from "../../_shared/domain-event-consumer-contract";

export const BOOKING_ADAPTER_CONSUMERS: ModuleDomainEventConsumer[] = [];
