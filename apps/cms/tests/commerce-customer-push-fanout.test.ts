/**
 * Customer Web Push fan-out - the pure rules (Issue #432, ADR-0048 sections 5.4
 * to 5.6 and 6.4 to 6.6). No database. Named after the ADR's regression handles
 * where one applies:
 *
 *   TS-U1   the event-to-purpose map is closed and has no path to `marketing`
 *   TS-U4   the rendered text is the catalogue text; nothing from an order
 *   TS-EVT1 every event the policy names is published by the `commerce`
 *           descriptor, registered with the runtime and described in AsyncAPI
 *   TS-S3   static: the enqueue consumer imports no provider, transport or
 *           credential code
 *   TS-I4   (the pure half) each send-time predicate, flipped alone, makes the
 *           message ineligible
 *
 * Plus: the cap arithmetic at send time, the backoff schedule, the TTL and
 * `Urgency` headers on a real provider driven against a stub HTTP client, the
 * provider-snippet redaction and the outcome classification.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { resetProviderCircuitBreakersForTests } from "../src/lib/database/circuit-breaker";
import { stripComments } from "../scripts/lib/source-text";
import { commerceModule } from "../src/modules/commerce/module";
import {
  CUSTOMER_PUSH_CONSENT_TEXT_VERSION,
  CUSTOMER_PUSH_DAILY_NOTIFICATION_CAP,
  CUSTOMER_PUSH_HOURLY_NOTIFICATION_CAP,
  CUSTOMER_PUSH_ERROR_CODES,
  CUSTOMER_PUSH_TARGET_PATHS,
  CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES
} from "../src/modules/commerce/domain/customer-push";
import {
  COMMERCE_CONVERSATION_STORE_REPLIED_EVENT_TYPE,
  COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
  COMMERCE_ORDER_EXPIRED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EVENT_TYPE,
  COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
  COMMERCE_REFUND_SETTLED_EVENT_TYPE,
  COMMERCE_RETURN_RECORDED_EVENT_TYPE
} from "../src/modules/commerce/domain/commerce-events";
import {
  CUSTOMER_PUSH_EVENT_POLICY,
  CUSTOMER_PUSH_MIN_DEFERRAL_MS,
  CUSTOMER_PUSH_POLICY_EVENT_TYPES,
  CUSTOMER_PUSH_PROVIDER_MAX_TTL_SECONDS,
  CUSTOMER_PUSH_TEXT_CATALOGUE,
  asEventUuid,
  buildCustomerPushProviderMessage,
  classifyProviderResult,
  evaluateSendCap,
  evaluateSendEligibility,
  isCatalogueText,
  isStorefrontOriginStillValid,
  renderCustomerPushText,
  resolveCustomerPushLocale,
  resolveCustomerPushPolicy,
  resolveProviderTtlSeconds,
  sanitizeProviderSnippet,
  urgencyForPriority,
  type SendEligibilityFacts
} from "../src/modules/commerce/domain/customer-push-policy";
import {
  createCustomerPushProviderFactory,
  withUrgencyHeader
} from "../src/modules/commerce/infrastructure/customer-push-provider";
import { isRegisteredDomainEventType } from "../src/modules/domain-event-runtime/domain/event-type-registry";
import { evaluatePushRetry } from "../src/modules/push-delivery/domain/push-retry";
import type {
  PushHttpClient,
  PushHttpRequest
} from "../src/modules/push-delivery/infrastructure/push-http-client";

const ROOT = join(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// TS-U1 / TS-EVT1 - the event policy
// ---------------------------------------------------------------------------

describe("TS-U1 the event-to-purpose map is closed", () => {
  test("every row maps to one of the three transactional purposes; none reaches marketing", () => {
    expect(CUSTOMER_PUSH_POLICY_EVENT_TYPES.length).toBeGreaterThanOrEqual(7);
    for (const [eventType, row] of Object.entries(CUSTOMER_PUSH_EVENT_POLICY)) {
      expect(
        (CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES as readonly string[]).includes(
          row.purpose
        ),
        eventType
      ).toBe(true);
      expect(row.purpose as string).not.toBe("marketing");
    }
  });

  test("an unknown event type produces no push", () => {
    for (const eventType of [
      "awcms.commerce.order.created",
      "awcms.commerce.payment.recorded",
      "awcms.commerce.loyalty.entry_recorded",
      "awcms.commerce.voucher.redeemed",
      "awcms.commerce.flash_sale.started",
      "awcms.commerce.quotation.accepted",
      "marketing.campaign.sent",
      ""
    ]) {
      expect(resolveCustomerPushPolicy(eventType, {})).toEqual({
        kind: "none",
        reason: "unmapped_event"
      });
    }
  });

  test("E1 to E7 map to the ADR's purposes, priorities, tags and TTLs", () => {
    const hour = 3_600_000;
    const expected: [string, string, string, string, number][] = [
      [COMMERCE_ORDER_PAID_EVENT_TYPE, "payment_updates", "high", "payment", 4],
      [
        COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
        "order_updates",
        "normal",
        "order",
        4
      ],
      [
        COMMERCE_ORDER_EXPIRED_EVENT_TYPE,
        "payment_updates",
        "normal",
        "payment",
        4
      ],
      [
        COMMERCE_REFUND_SETTLED_EVENT_TYPE,
        "payment_updates",
        "normal",
        "payment",
        12
      ],
      [
        COMMERCE_RETURN_RECORDED_EVENT_TYPE,
        "order_updates",
        "normal",
        "order",
        12
      ],
      [
        COMMERCE_CONVERSATION_STORE_REPLIED_EVENT_TYPE,
        "support_replies",
        "high",
        "support",
        12
      ]
    ];
    for (const [eventType, purpose, priority, tag, hours] of expected) {
      const decision = resolveCustomerPushPolicy(eventType, {});
      expect(decision.kind, eventType).toBe("push");
      if (decision.kind !== "push") continue;
      expect(decision.policy.purpose).toBe(purpose as never);
      expect(decision.policy.priority).toBe(priority as never);
      expect(decision.policy.tag).toBe(tag);
      expect(decision.policy.ttlMs).toBe(hours * hour);
    }
  });

  test("E2 notifies only processing, shipped and completed, with their own priority; paid, cancelled and expired have their own events", () => {
    const priorityOf = (to: unknown) => {
      const decision = resolveCustomerPushPolicy(
        COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
        { to }
      );
      return decision.kind === "push" ? decision.policy.priority : null;
    };
    expect(priorityOf("shipped")).toBe("high");
    expect(priorityOf("processing")).toBe("normal");
    expect(priorityOf("completed")).toBe("low");
    for (const to of ["paid", "cancelled", "expired", "pending_payment", 7]) {
      expect(priorityOf(to)).toBeNull();
    }
    expect(
      resolveCustomerPushPolicy(COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE, {})
    ).toEqual({ kind: "none", reason: "status_not_notified" });
  });

  test("only a customer cancellation is suppressed for its customer (E3), and only E3", () => {
    const suppressing = Object.entries(CUSTOMER_PUSH_EVENT_POLICY)
      .filter(([, row]) => row.suppressWhenCustomerIsActor)
      .map(([eventType]) => eventType);
    expect(suppressing).toEqual([COMMERCE_ORDER_CANCELLED_EVENT_TYPE]);
  });

  test("TTLs never exceed the policy's twelve hours and TTL tags fit the outbox CHECK", () => {
    for (const row of Object.values(CUSTOMER_PUSH_EVENT_POLICY)) {
      expect(row.ttlMs).toBeLessThanOrEqual(12 * 3_600_000);
      expect(row.tag).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    }
  });

  test("a subject id read from an event payload must be a UUID", () => {
    expect(asEventUuid("3F2504E0-4F89-41D3-9A0C-0305E82C3301")).toBe(
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
    );
    for (const bad of [
      "",
      "not-a-uuid",
      "3f2504e0-4f89-41d3-9a0c-0305e82c33010",
      "1; DROP TABLE x",
      null,
      undefined,
      42,
      {}
    ]) {
      expect(asEventUuid(bad)).toBeNull();
    }
  });
});

describe("TS-EVT1 every policy event exists", () => {
  const asyncapi = readFileSync(
    join(ROOT, "asyncapi/awcms-domain-events.asyncapi.yaml"),
    "utf8"
  );

  test("each is published by the commerce descriptor, registered with the runtime and described in AsyncAPI", () => {
    const publishes = new Set(commerceModule.events?.publishes ?? []);
    for (const eventType of CUSTOMER_PUSH_POLICY_EVENT_TYPES) {
      expect(publishes.has(eventType), `publishes ${eventType}`).toBe(true);
      expect(
        isRegisteredDomainEventType(eventType, "1.0"),
        `registry ${eventType}`
      ).toBe(true);
      expect(asyncapi, `asyncapi ${eventType}`).toContain(`  ${eventType}:\n`);
    }
  });

  test("the enqueuer consumer is declared once and subscribes to exactly the policy's events", () => {
    const consumers = (commerceModule.domainEventConsumers ?? []).filter(
      (consumer) => consumer.name === "commerce.customer_push_enqueuer"
    );
    expect(consumers).toHaveLength(1);
    const consumer = consumers[0]!;
    expect([...consumer.eventTypes].sort()).toEqual(
      [...CUSTOMER_PUSH_POLICY_EVENT_TYPES].sort()
    );
    expect([...consumer.eventVersions]).toEqual(["1.0"]);
    // Default idempotency: the registry wraps `handle` in the once-per-effect guard.
    expect(consumer.idempotency).toBeUndefined();
  });

  test("the new store_replied event is described as ids-only and published", () => {
    expect(COMMERCE_CONVERSATION_STORE_REPLIED_EVENT_TYPE).toBe(
      "awcms.commerce.conversation.store_replied"
    );
    const channel = asyncapi.slice(
      asyncapi.indexOf("  awcms.commerce.conversation.store_replied:\n")
    );
    expect(channel.slice(0, 900)).toContain("`conversationId` only");
  });
});

// ---------------------------------------------------------------------------
// TS-U4 - the catalogue and the payload builder
// ---------------------------------------------------------------------------

describe("TS-U4 the text is generic by construction", () => {
  test("the catalogue has exactly three purposes in two languages, within the outbox caps, with no digit or placeholder", () => {
    expect(Object.keys(CUSTOMER_PUSH_TEXT_CATALOGUE).sort()).toEqual(
      [...CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES].sort()
    );
    for (const byLocale of Object.values(CUSTOMER_PUSH_TEXT_CATALOGUE)) {
      expect(Object.keys(byLocale).sort()).toEqual(["en", "id"]);
      for (const text of Object.values(byLocale)) {
        expect(text.title.length).toBeGreaterThan(0);
        expect(text.title.length).toBeLessThanOrEqual(120);
        expect(text.body.length).toBeGreaterThan(0);
        expect(text.body.length).toBeLessThanOrEqual(240);
        expect(`${text.title} ${text.body}`).not.toMatch(/\d/);
        expect(`${text.title} ${text.body}`).not.toMatch(/[{}<>$#]/);
      }
    }
  });

  test("rendering takes a purpose and a locale and nothing else, so no order data can arrive", () => {
    // The function has two parameters; there is no third through which an order
    // code, an amount or a name could be interpolated.
    expect(renderCustomerPushText.length).toBe(2);
    expect(renderCustomerPushText("payment_updates", "en")).toEqual({
      title: "Payment update",
      body: "Open your account to see it."
    });
    expect(renderCustomerPushText("support_replies", "id").title).toBe(
      "Anda mendapat pesan baru dari toko"
    );
  });

  test("the tenant locale picks Indonesian only for an Indonesian locale; anything else is English", () => {
    expect(resolveCustomerPushLocale("id")).toBe("id");
    expect(resolveCustomerPushLocale("id-ID")).toBe("id");
    expect(resolveCustomerPushLocale(" ID ")).toBe("id");
    for (const other of ["en", "en-US", "ms", "", null, undefined, "xx"]) {
      expect(resolveCustomerPushLocale(other)).toBe("en");
    }
  });

  test("only catalogue text passes: a changed word, a number or an order code does not", () => {
    const text = renderCustomerPushText("order_updates", "en");
    expect(isCatalogueText("order_updates", text.title, text.body)).toBe(true);
    expect(
      isCatalogueText(
        "order_updates",
        renderCustomerPushText("order_updates", "id").title,
        renderCustomerPushText("order_updates", "id").body
      )
    ).toBe(true);
    expect(isCatalogueText("payment_updates", text.title, text.body)).toBe(
      false
    );
    expect(
      isCatalogueText("order_updates", `${text.title} #ORD-1234`, text.body)
    ).toBe(false);
    expect(isCatalogueText("order_updates", text.title, "Rp 150.000")).toBe(
      false
    );
    expect(isCatalogueText("marketing", text.title, text.body)).toBe(false);
  });

  test("the provider message is the catalogue text on the purpose's fixed path, with the tag as its only data", () => {
    const text = renderCustomerPushText("support_replies", "en");
    const message = buildCustomerPushProviderMessage({
      purpose: "support_replies",
      ...text,
      targetPath: CUSTOMER_PUSH_TARGET_PATHS.support_replies,
      tag: "support"
    });
    expect(message).toEqual({
      title: text.title,
      body: text.body,
      targetPath: "/akun/pesan",
      data: { category: "support" }
    });
    // No identifier of any kind in what is sent.
    expect(JSON.stringify(message)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}|order|amount|rp\s?\d/i
    );
  });

  test("a tampered row is refused: other path, off-catalogue text, marketing, an unknown or malformed tag", () => {
    const text = renderCustomerPushText("order_updates", "en");
    const base = {
      purpose: "order_updates",
      ...text,
      targetPath: "/akun/pesanan",
      tag: "order"
    };
    expect(buildCustomerPushProviderMessage(base)).not.toBeNull();
    for (const tampered of [
      { ...base, targetPath: "/akun/pesanan?id=1" },
      { ...base, targetPath: "//evil.test/x" },
      { ...base, targetPath: "/akun/pesan" },
      { ...base, targetPath: "https://evil.test/akun/pesanan" },
      { ...base, title: "Your order ORD-1 shipped" },
      { ...base, purpose: "marketing" },
      { ...base, purpose: "nope" },
      { ...base, tag: "Order Tag!" }
    ]) {
      expect(buildCustomerPushProviderMessage(tampered)).toBeNull();
    }
  });

  test("the error vocabulary the dispatcher writes is lower-case snake_case and closed", () => {
    for (const code of CUSTOMER_PUSH_ERROR_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
    for (const code of [
      "consent_withdrawn",
      "origin_revoked",
      "rate_limited",
      "endpoint_gone",
      "provider_rejected",
      "provider_unavailable"
    ]) {
      expect(
        (CUSTOMER_PUSH_ERROR_CODES as readonly string[]).includes(code)
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// TTL and urgency
// ---------------------------------------------------------------------------

describe("TTL and urgency", () => {
  const now = new Date("2026-10-25T12:00:00.000Z");

  test("the TTL is the time left, capped at four hours and never below one second", () => {
    expect(
      resolveProviderTtlSeconds(new Date(now.getTime() + 12 * 3_600_000), now)
    ).toBe(CUSTOMER_PUSH_PROVIDER_MAX_TTL_SECONDS);
    expect(CUSTOMER_PUSH_PROVIDER_MAX_TTL_SECONDS).toBe(14_400);
    expect(
      resolveProviderTtlSeconds(new Date(now.getTime() + 90_000), now)
    ).toBe(90);
    expect(resolveProviderTtlSeconds(new Date(now.getTime() + 100), now)).toBe(
      1
    );
    expect(
      resolveProviderTtlSeconds(new Date(now.getTime() - 5_000), now)
    ).toBe(1);
  });

  test("the queue priority is the RFC 8030 urgency", () => {
    expect(urgencyForPriority("high")).toBe("high");
    expect(urgencyForPriority("normal")).toBe("normal");
    expect(urgencyForPriority("low")).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// TS-I4 (pure half) - send-time eligibility
// ---------------------------------------------------------------------------

const NOW = new Date("2026-10-25T12:00:00.000Z");
const ORIGIN = "https://shop.example.test";
const ADMIN = "https://cms.example.test";
const TEXT = renderCustomerPushText("order_updates", "en");

function goodFacts(): SendEligibilityFacts {
  return {
    message: {
      accountId: "acc-1",
      purpose: "order_updates",
      title: TEXT.title,
      body: TEXT.body,
      targetPath: "/akun/pesanan",
      tag: "order",
      expiresAt: new Date(NOW.getTime() + 3_600_000)
    },
    device: { status: "active", accountId: "acc-1", storefrontOrigin: ORIGIN },
    session: {
      revokedAt: null,
      expiresAt: new Date(NOW.getTime() + 86_400_000)
    },
    account: { status: "active", emailVerifiedAt: NOW, deletedAt: null },
    customerStatus: "active",
    preference: {
      enabled: true,
      consentTextVersion: CUSTOMER_PUSH_CONSENT_TEXT_VERSION
    },
    domainHostnames: new Set(["shop.example.test"]),
    adminOrigin: ADMIN
  };
}

describe("TS-I4 send-time eligibility (pure)", () => {
  test("a message with every predicate true is eligible", () => {
    expect(evaluateSendEligibility(goodFacts(), NOW)).toEqual({
      eligible: true
    });
  });

  type Flip = [
    string,
    (facts: SendEligibilityFacts) => void,
    {
      outcome: "cancel" | "expire";
      error: string;
      tombstone: { status: string; reason: string } | null;
    }
  ];

  const flips: Flip[] = [
    [
      "the message is past its expiry",
      (f) => {
        f.message.expiresAt = new Date(NOW.getTime() - 1);
      },
      { outcome: "expire", error: "expired", tombstone: null }
    ],
    [
      "the message expires exactly now",
      (f) => {
        f.message.expiresAt = new Date(NOW.getTime());
      },
      { outcome: "expire", error: "expired", tombstone: null }
    ],
    [
      "the text is not catalogue text",
      (f) => {
        f.message.title = "Order ORD-2026 shipped";
      },
      { outcome: "cancel", error: "not_eligible", tombstone: null }
    ],
    [
      "the target path is not the purpose's",
      (f) => {
        f.message.targetPath = "/akun/pesan";
      },
      { outcome: "cancel", error: "not_eligible", tombstone: null }
    ],
    [
      "the purpose is marketing",
      (f) => {
        f.message.purpose = "marketing";
      },
      { outcome: "cancel", error: "not_eligible", tombstone: null }
    ],
    [
      "the device is gone from the table",
      (f) => {
        f.device = null;
      },
      { outcome: "cancel", error: "device_revoked", tombstone: null }
    ],
    [
      "the device is revoked",
      (f) => {
        f.device!.status = "revoked";
      },
      { outcome: "cancel", error: "device_revoked", tombstone: null }
    ],
    [
      "the device is gone",
      (f) => {
        f.device!.status = "gone";
      },
      { outcome: "cancel", error: "device_revoked", tombstone: null }
    ],
    [
      "the device now belongs to another account (I5)",
      (f) => {
        f.device!.accountId = "acc-2";
      },
      { outcome: "cancel", error: "device_transferred", tombstone: null }
    ],
    [
      "the account is blocked",
      (f) => {
        f.account!.status = "blocked";
      },
      {
        outcome: "cancel",
        error: "account_blocked",
        tombstone: { status: "revoked", reason: "account_blocked" }
      }
    ],
    [
      "the customer row is blocked",
      (f) => {
        f.customerStatus = "blocked";
      },
      {
        outcome: "cancel",
        error: "account_blocked",
        tombstone: { status: "revoked", reason: "account_blocked" }
      }
    ],
    [
      "the account was erased",
      (f) => {
        f.account!.deletedAt = NOW;
      },
      {
        outcome: "cancel",
        error: "account_blocked",
        tombstone: { status: "revoked", reason: "account_blocked" }
      }
    ],
    [
      "the account row is gone",
      (f) => {
        f.account = null;
      },
      {
        outcome: "cancel",
        error: "account_blocked",
        tombstone: { status: "revoked", reason: "account_blocked" }
      }
    ],
    [
      "the e-mail is not verified",
      (f) => {
        f.account!.emailVerifiedAt = null;
      },
      { outcome: "cancel", error: "not_eligible", tombstone: null }
    ],
    [
      "the enrolling session was revoked (logout)",
      (f) => {
        f.session!.revokedAt = new Date(NOW.getTime() - 1000);
      },
      {
        outcome: "cancel",
        error: "session_ended",
        tombstone: { status: "revoked", reason: "session_ended" }
      }
    ],
    [
      "the enrolling session expired",
      (f) => {
        f.session!.expiresAt = new Date(NOW.getTime());
      },
      {
        outcome: "cancel",
        error: "session_ended",
        tombstone: { status: "revoked", reason: "session_ended" }
      }
    ],
    [
      "the session row was purged",
      (f) => {
        f.session = null;
      },
      {
        outcome: "cancel",
        error: "session_ended",
        tombstone: { status: "revoked", reason: "session_ended" }
      }
    ],
    [
      "the preference was turned off",
      (f) => {
        f.preference!.enabled = false;
      },
      { outcome: "cancel", error: "consent_withdrawn", tombstone: null }
    ],
    [
      "there is no preference row",
      (f) => {
        f.preference = null;
      },
      { outcome: "cancel", error: "consent_withdrawn", tombstone: null }
    ],
    [
      "the consent wording is no longer the current version",
      (f) => {
        f.preference!.consentTextVersion = "draft-2020-01";
      },
      { outcome: "cancel", error: "consent_withdrawn", tombstone: null }
    ],
    [
      "the origin is no longer one of the tenant's domains",
      (f) => {
        f.domainHostnames = new Set(["other.example.test"]);
      },
      {
        outcome: "cancel",
        error: "origin_revoked",
        tombstone: { status: "disabled", reason: "origin_revoked" }
      }
    ],
    [
      "the origin is the CMS/admin origin",
      (f) => {
        f.device!.storefrontOrigin = ADMIN;
        f.domainHostnames = new Set(["cms.example.test"]);
      },
      {
        outcome: "cancel",
        error: "origin_revoked",
        tombstone: { status: "disabled", reason: "origin_revoked" }
      }
    ]
  ];

  for (const [label, mutate, expected] of flips) {
    test(`flipped alone: ${label}`, () => {
      const facts = goodFacts();
      mutate(facts);
      const verdict = evaluateSendEligibility(facts, NOW);
      expect(verdict.eligible).toBe(false);
      if (verdict.eligible) return;
      expect(verdict.outcome).toBe(expected.outcome);
      expect(verdict.error).toBe(expected.error as never);
      expect(verdict.tombstone).toEqual(expected.tombstone as never);
    });
  }

  test("the origin check matches hostnames case-insensitively and rejects a malformed origin", () => {
    const hosts = new Set(["shop.example.test"]);
    expect(
      isStorefrontOriginStillValid("https://SHOP.example.test", hosts, ADMIN)
    ).toBe(true);
    expect(
      isStorefrontOriginStillValid(
        "https://shop.example.test:8443",
        hosts,
        null
      )
    ).toBe(true);
    expect(isStorefrontOriginStillValid("not an origin", hosts, null)).toBe(
      false
    );
    expect(isStorefrontOriginStillValid("https://evil.test", hosts, null)).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// The cap at send time
// ---------------------------------------------------------------------------

describe("the send-time cap (12 per rolling hour, 40 per rolling day, per notification)", () => {
  const now = new Date("2026-10-25T12:00:00.000Z");
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60_000);
  const sent = (minutes: number[]) =>
    minutes.map((m, index) => ({
      eventId: `event-${index}`,
      firstSentAt: minutesAgo(m)
    }));

  test("the named constants are the ADR's", () => {
    expect(CUSTOMER_PUSH_HOURLY_NOTIFICATION_CAP).toBe(12);
    expect(CUSTOMER_PUSH_DAILY_NOTIFICATION_CAP).toBe(40);
  });

  test("11 sent in the hour: the 12th is allowed; 12 sent: the 13th is deferred", () => {
    expect(
      evaluateSendCap(sent([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), "new", now)
    ).toEqual({ allowed: true });

    const twelve = sent([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 58]);
    const decision = evaluateSendCap(twelve, "new", now);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("hourly_cap");
    // The oldest counted notification (58 minutes ago) leaves the hour in 2 minutes.
    expect(decision.retryAt.getTime()).toBe(
      minutesAgo(58).getTime() + 3_600_000
    );
  });

  test("an event that already holds a slot never trips the cap on its own (a later device of the same notification)", () => {
    const twelve = sent([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 58]);
    expect(evaluateSendCap(twelve, "event-3", now)).toEqual({ allowed: true });
  });

  test("a notification older than an hour no longer counts against the hourly cap", () => {
    const old = sent(Array.from({ length: 12 }, (_, i) => 61 + i));
    expect(evaluateSendCap(old, "new", now)).toEqual({ allowed: true });
  });

  test("40 in the day: deferred to when the oldest leaves the 24 hour window", () => {
    const forty = sent(Array.from({ length: 40 }, (_, i) => 120 + i * 30));
    const decision = evaluateSendCap(forty, "new", now);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("daily_cap");
    expect(decision.retryAt.getTime()).toBe(
      minutesAgo(120 + 39 * 30).getTime() + 24 * 3_600_000
    );
  });

  test("both windows full: the later release decides, and a release already due still waits the minimum", () => {
    const hourFull = sent([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const tooSoon = evaluateSendCap(hourFull, "new", now, {
      hourly: 12,
      daily: 40
    });
    expect(tooSoon.allowed).toBe(false);
    if (tooSoon.allowed) return;
    expect(tooSoon.retryAt.getTime()).toBeGreaterThanOrEqual(
      now.getTime() + CUSTOMER_PUSH_MIN_DEFERRAL_MS
    );

    // 12 in the last hour AND the daily window full: the day releases later.
    const both = [
      ...sent([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      ...Array.from({ length: 28 }, (_, i) => ({
        eventId: `old-${i}`,
        firstSentAt: minutesAgo(600 + i * 10)
      }))
    ];
    const decision = evaluateSendCap(both, "new", now);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe("daily_cap");
  });

  test("custom caps are honoured (the cap is a parameter, not a literal)", () => {
    const three = sent([1, 2, 3]);
    expect(
      evaluateSendCap(three, "new", now, { hourly: 3, daily: 40 }).allowed
    ).toBe(false);
    expect(
      evaluateSendCap(three, "new", now, { hourly: 4, daily: 40 }).allowed
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe("exponential backoff and the retry budget", () => {
  const now = new Date("2026-10-25T12:00:00.000Z");

  test("the delay doubles from one minute and is capped at fifteen", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((retry) => {
      const evaluation = evaluatePushRetry(retry, 10, now);
      expect(evaluation.eligible).toBe(true);
      return (evaluation.nextAttemptAt!.getTime() - now.getTime()) / 60_000;
    });
    expect(delays).toEqual([1, 2, 4, 8, 15, 15, 15]);
  });

  test("retries stop at the budget (default three): the fourth failure is terminal", () => {
    expect(evaluatePushRetry(2, 3, now).eligible).toBe(true);
    expect(evaluatePushRetry(3, 3, now).eligible).toBe(false);
    expect(evaluatePushRetry(0, 0, now).eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider outcome, snippet redaction
// ---------------------------------------------------------------------------

describe("provider outcome classification", () => {
  test("acceptance, a gone subscription, a retryable and a permanent failure", () => {
    expect(classifyProviderResult({ ok: true })).toEqual({ kind: "accepted" });
    expect(
      classifyProviderResult({
        ok: false,
        error: "410: gone",
        retryable: false,
        subscriptionGone: true
      }).kind
    ).toBe("gone");
    expect(
      classifyProviderResult({ ok: false, error: "503: busy", retryable: true })
        .kind
    ).toBe("retry");
    expect(
      classifyProviderResult({
        ok: false,
        error: "VAPID rejected (403)",
        retryable: false
      }).kind
    ).toBe("permanent");
  });

  test("a gone result wins over retryable", () => {
    expect(
      classifyProviderResult({
        ok: false,
        error: "404",
        retryable: true,
        subscriptionGone: true
      }).kind
    ).toBe("gone");
  });

  test("the stored snippet carries no URL, no token-like run, no newline, and at most 500 characters", () => {
    const endpoint =
      "https://fcm.googleapis.com/fcm/send/dev1:APA91bSECRETTOKEN12345678901234567890xyz";
    const snippet = sanitizeProviderSnippet(
      `410: the subscription ${endpoint}\nfailed with token ${"A".repeat(60)} and\t\tmore`
    );
    expect(snippet).not.toContain("fcm.googleapis.com");
    expect(snippet).not.toContain("SECRETTOKEN");
    expect(snippet).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(snippet).not.toMatch(/[\n\t]/);
    expect(snippet).toContain("[url]");
    expect(snippet).toContain("[redacted]");
    expect(
      sanitizeProviderSnippet("x ".repeat(2000)).length
    ).toBeLessThanOrEqual(500);
    expect(sanitizeProviderSnippet("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The provider: TTL, Urgency and the storefront origin, against a stub client
// ---------------------------------------------------------------------------

function makeVapid(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256"
  });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(pub.x!, "base64url"),
      Buffer.from(pub.y!, "base64url")
    ]).toString("base64url"),
    privateKey: priv.d!
  };
}

function makeSubscriber(): { p256dh: string; auth: string } {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    p256dh: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x!, "base64url"),
      Buffer.from(jwk.y!, "base64url")
    ]).toString("base64url"),
    auth: randomBytes(16).toString("base64url")
  };
}

describe("the customer provider (reuses the upstream Web Push provider)", () => {
  const vapid = makeVapid();
  const env = {
    PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
    PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
    PUSH_VAPID_SUBJECT: "mailto:ops@example.test"
  } as NodeJS.ProcessEnv;
  const subscriber = makeSubscriber();
  const target = {
    transport: "web_push" as const,
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    endpointMasked: "https://fcm.googleapis.com/…/abc",
    p256dhKey: subscriber.p256dh,
    authSecret: subscriber.auth
  };

  function capture(status = 201) {
    const requests: { url: string; request: PushHttpRequest }[] = [];
    const http: PushHttpClient = async (url, request) => {
      requests.push({ url, request });
      return { ok: true, status, body: "" };
    };
    return { requests, http };
  }

  test("no VAPID pair: no factory, so the dispatcher claims nothing", () => {
    expect(createCustomerPushProviderFactory({ env: {} as never })).toBeNull();
  });

  test("a send carries the TTL of the remaining lifetime and the Urgency header", async () => {
    resetProviderCircuitBreakersForTests();
    const { requests, http } = capture();
    const factory = createCustomerPushProviderFactory({ env, http })!;

    const result = await factory({
      storefrontOrigin: "https://shop.example.test",
      ttlSeconds: 5400,
      urgency: "high"
    }).send(target, {
      title: "Payment update",
      body: "Open your account to see it.",
      targetPath: "/akun/pesanan",
      data: { category: "payment" }
    });

    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    const { url, request } = requests[0]!;
    expect(url).toBe(target.endpoint);
    expect(request.headers.TTL).toBe("5400");
    expect(request.headers.Urgency).toBe("high");
    expect(request.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(request.headers.Authorization).toStartWith("vapid t=");
    // The body is ciphertext: none of the text travels in the clear.
    expect(
      Buffer.from(request.body as Uint8Array).toString("latin1")
    ).not.toContain("Payment");
  });

  test("each urgency is sent as given, per message", async () => {
    resetProviderCircuitBreakersForTests();
    const { requests, http } = capture();
    const factory = createCustomerPushProviderFactory({ env, http })!;
    for (const urgency of ["high", "normal", "low"] as const) {
      await factory({
        storefrontOrigin: "https://shop.example.test",
        ttlSeconds: 60,
        urgency
      }).send(target, { title: "t", body: "b", targetPath: "/akun/pesanan" });
    }
    expect(requests.map((r) => r.request.headers.Urgency)).toEqual([
      "high",
      "normal",
      "low"
    ]);
  });

  test("a 410 from the push service maps to a gone subscription; a 503 to a retryable failure", async () => {
    resetProviderCircuitBreakersForTests();
    const gone = capture(410);
    const goneResult = await createCustomerPushProviderFactory({
      env,
      http: gone.http
    })!({
      storefrontOrigin: "https://shop.example.test",
      ttlSeconds: 60,
      urgency: "normal"
    }).send(target, { title: "t", body: "b", targetPath: "/akun/pesanan" });
    expect(goneResult.ok).toBe(false);
    if (!goneResult.ok) expect(goneResult.subscriptionGone).toBe(true);

    resetProviderCircuitBreakersForTests();
    const busy = capture(503);
    const busyResult = await createCustomerPushProviderFactory({
      env,
      http: busy.http
    })!({
      storefrontOrigin: "https://shop.example.test",
      ttlSeconds: 60,
      urgency: "normal"
    }).send(target, { title: "t", body: "b", targetPath: "/akun/pesanan" });
    expect(busyResult.ok).toBe(false);
    if (!busyResult.ok) {
      expect(busyResult.retryable).toBe(true);
      expect(busyResult.subscriptionGone).toBeUndefined();
    }
    resetProviderCircuitBreakersForTests();
  });

  test("withUrgencyHeader adds the header and keeps the others", async () => {
    let seen: PushHttpRequest | null = null;
    const wrapped = withUrgencyHeader(async (_url, request) => {
      seen = request;
      return { ok: true, status: 201, body: "" };
    }, "low");
    await wrapped("https://x.test/", {
      method: "POST",
      headers: { TTL: "9" },
      body: "x",
      timeoutMs: 1
    });
    expect(seen!.headers).toEqual({ TTL: "9", Urgency: "low" });
  });
});

// ---------------------------------------------------------------------------
// TS-S3 - the consumer is a database-only file
// ---------------------------------------------------------------------------

function importSpecifiers(file: string): string[] {
  const code = stripComments(readFileSync(file, "utf8"));
  return [...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
    (match) => match[1]!
  );
}

describe("TS-S3 the enqueue consumer reaches no network, provider or credential code", () => {
  const enqueue = join(
    ROOT,
    "src/modules/commerce/application/customer-push-enqueue.ts"
  );
  const facts = join(
    ROOT,
    "src/modules/commerce/application/customer-push-facts.ts"
  );

  test("customer-push-enqueue.ts and customer-push-facts.ts import no push_delivery code but the config flag", () => {
    for (const file of [enqueue, facts]) {
      const specifiers = importSpecifiers(file);
      expect(specifiers.length).toBeGreaterThan(0);
      const pushImports = specifiers.filter((s) => s.includes("push-delivery"));
      for (const specifier of pushImports) {
        expect(specifier).toEndWith("push-delivery/domain/push-config");
      }
      for (const specifier of specifiers) {
        expect(specifier).not.toMatch(
          /web-push|provider|http-client|ssrf|vapid|auth-secret|field-encryption|customer-push-(dispatch|devices|secrets|provider|capability)/
        );
      }
    }
  });

  test("neither file makes a network call or reads a secret", () => {
    for (const file of [enqueue, facts]) {
      const code = stripComments(readFileSync(file, "utf8"));
      expect(code).not.toMatch(
        /\bfetch\(|XMLHttpRequest|WebSocket|ssrfSafeFetch/
      );
      expect(code).not.toMatch(/PUSH_VAPID|PUSH_AUTH_SECRET|_ciphertext/);
    }
  });

  test("the policy module (pure) imports nothing from push_delivery, the database or the network", () => {
    const specifiers = importSpecifiers(
      join(ROOT, "src/modules/commerce/domain/customer-push-policy.ts")
    );
    expect(specifiers.sort()).toEqual(["./commerce-events", "./customer-push"]);
  });

  test("the dispatcher is the file that sends: it, and only it among the application files, imports the provider factory", () => {
    const dir = join(ROOT, "src/modules/commerce/application");
    const importers = [
      "customer-push-dispatch",
      "customer-push-enqueue",
      "customer-push-devices",
      "customer-push-outbox",
      "customer-push-maintenance",
      "customer-push-http",
      "customer-push-facts"
    ].filter((name) =>
      importSpecifiers(join(dir, `${name}.ts`)).some((s) =>
        s.endsWith("infrastructure/customer-push-provider")
      )
    );
    expect(importers).toEqual(["customer-push-dispatch"]);
  });
});

describe("the dispatcher never sends inside a transaction", () => {
  test("the provider call sits outside every withTenantOrThrow callback", () => {
    const code = stripComments(
      readFileSync(
        join(
          ROOT,
          "src/modules/commerce/application/customer-push-dispatch.ts"
        ),
        "utf8"
      )
    );
    // `provider.send` appears once, in `attemptSend`, which is called from the
    // loop and never from inside `prepareSend` / `finalize` / `claim`.
    expect(code.match(/provider\.send\(/g)).toHaveLength(1);
    const attempt = code.slice(code.indexOf("async function attemptSend"));
    expect(attempt.indexOf("provider.send(")).toBeGreaterThan(0);
    for (const name of ["claim", "prepareSend", "finalize", "releaseUnsent"]) {
      const start = code.indexOf(`async function ${name}(`);
      const end = code.indexOf("\nasync function ", start + 10);
      expect(code.slice(start, end === -1 ? undefined : end)).not.toContain(
        "provider.send("
      );
    }
  });
});
