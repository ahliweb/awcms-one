import { describe, expect, test } from "bun:test";

import {
  getConsumerByName,
  listDomainEventConsumers,
  getConsumersForEventType
} from "../src/modules/domain-event-runtime/infrastructure/consumer-registry";
import { SAMPLE_RECORDED_EVENT_TYPE } from "../src/modules/domain-event-runtime/domain/event-type-registry";
import {
  COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EVENT_TYPE
} from "../src/modules/commerce/domain/commerce-events";

describe("descriptor-built consumer registry", () => {
  test("ships at least two representative consumers", () => {
    expect(listDomainEventConsumers().length).toBeGreaterThanOrEqual(2);
  });

  test("every consumer name is unique", () => {
    const names = listDomainEventConsumers().map((consumer) => consumer.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every consumer declares at least one event type and one event version", () => {
    for (const consumer of listDomainEventConsumers()) {
      expect(consumer.eventTypes.length).toBeGreaterThan(0);
      expect(consumer.eventVersions.length).toBeGreaterThan(0);
    }
  });

  test("every consumer has a non-empty description", () => {
    for (const consumer of listDomainEventConsumers()) {
      expect(consumer.description.length).toBeGreaterThan(0);
    }
  });

  test("getConsumersForEventType returns every consumer subscribed to the sample reference event", () => {
    const declaredSubscribers = listDomainEventConsumers().filter((consumer) =>
      consumer.eventTypes.includes(SAMPLE_RECORDED_EVENT_TYPE)
    );
    const matched = getConsumersForEventType(SAMPLE_RECORDED_EVENT_TYPE);
    expect(matched.length).toBe(declaredSubscribers.length);
    expect(matched.length).toBeGreaterThanOrEqual(2);
  });

  test("getConsumersForEventType returns an empty array for an unregistered event type", () => {
    expect(getConsumersForEventType("awcms.nonexistent.thing")).toEqual([]);
  });

  test("getConsumerByName resolves a known consumer and returns undefined for an unknown one", () => {
    const first = listDomainEventConsumers()[0]!;
    expect(getConsumerByName(first.name)?.name).toBe(first.name);
    expect(getConsumerByName("not-a-real-consumer")).toBeUndefined();
  });

  test("commerce.order_paid_entitlement_grantor (Issue #267, IRMbyDUS) is registered and subscribed to the order-paid event", () => {
    const consumer = getConsumerByName(
      "commerce.order_paid_entitlement_grantor"
    );
    expect(consumer).toBeDefined();
    expect(consumer!.eventTypes).toContain(COMMERCE_ORDER_PAID_EVENT_TYPE);

    const subscribers = getConsumersForEventType(
      COMMERCE_ORDER_PAID_EVENT_TYPE
    );
    expect(subscribers.map((c) => c.name)).toContain(
      "commerce.order_paid_entitlement_grantor"
    );
  });

  test("commerce.order_paid_loyalty_earner and commerce.order_cancelled_loyalty_reverser (Issue #289) are registered against exactly their order events", () => {
    const earner = getConsumerByName("commerce.order_paid_loyalty_earner");
    expect(earner).toBeDefined();
    expect(earner!.eventTypes).toEqual([COMMERCE_ORDER_PAID_EVENT_TYPE]);

    const reverser = getConsumerByName(
      "commerce.order_cancelled_loyalty_reverser"
    );
    expect(reverser).toBeDefined();
    expect(reverser!.eventTypes).toEqual([COMMERCE_ORDER_CANCELLED_EVENT_TYPE]);

    expect(
      getConsumersForEventType(COMMERCE_ORDER_PAID_EVENT_TYPE).map(
        (c) => c.name
      )
    ).toContain("commerce.order_paid_loyalty_earner");
    expect(
      getConsumersForEventType(COMMERCE_ORDER_CANCELLED_EVENT_TYPE).map(
        (c) => c.name
      )
    ).toContain("commerce.order_cancelled_loyalty_reverser");
  });
});
