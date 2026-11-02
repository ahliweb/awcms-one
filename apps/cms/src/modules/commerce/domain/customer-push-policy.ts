/**
 * Customer Web Push - the event policy, the generic text catalogue and the pure
 * decisions the fan-out consumer and the dispatcher share (Issue #432, ADR-0048
 * sections 5.4, 5.5, 6.4 to 6.6). Pure: no database, no network, no `process.env`
 * read at module scope, no import of anything that touches either.
 *
 * ## The event-to-purpose map is closed (TS-U1)
 *
 * {@link resolveCustomerPushPolicy} is a lookup in a fixed table. An event type
 * that is not in it produces no push, and no entry names `marketing`: the only
 * purposes reachable are the three transactional ones
 * ({@link CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES}). Marketing push is reserved and
 * has no path here (ADR-0048 Q11, T13).
 *
 * ## The text is generic by construction (TS-U4, I6, T15)
 *
 * A notification travels through the browser vendor's push service and appears
 * on a lock screen. {@link renderCustomerPushText} therefore returns one of six
 * fixed strings (three purposes, two languages) and has no parameter an order
 * code, an amount or a name could arrive through. {@link isCatalogueText} lets
 * the dispatcher refuse, at send time, an outbox row whose text is not one of
 * those six strings, whoever wrote it.
 *
 * ## Eligibility is one function (TS-I4)
 *
 * {@link evaluateSendEligibility} decides, from facts the dispatcher reads in one
 * query, whether a queued message may still be sent. Every predicate of ADR-0048
 * section 5.5 is a branch here, and the unit test flips each one alone.
 */
import {
  COMMERCE_CONVERSATION_STORE_REPLIED_EVENT_TYPE,
  COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
  COMMERCE_ORDER_EXPIRED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EVENT_TYPE,
  COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
  COMMERCE_REFUND_SETTLED_EVENT_TYPE,
  COMMERCE_RETURN_RECORDED_EVENT_TYPE
} from "./commerce-events";
import {
  CUSTOMER_PUSH_DAILY_NOTIFICATION_CAP,
  CUSTOMER_PUSH_HOURLY_NOTIFICATION_CAP,
  CUSTOMER_PUSH_HOUR_MS,
  CUSTOMER_PUSH_DAY_MS,
  CUSTOMER_PUSH_CONSENT_TEXT_VERSION,
  CUSTOMER_PUSH_TARGET_PATHS,
  isTransactionalPurpose,
  type CustomerPushErrorCode,
  type CustomerPushPurpose,
  type CustomerPushStatusReason
} from "./customer-push";

// ---------------------------------------------------------------------------
// Priority, urgency, TTL
// ---------------------------------------------------------------------------

export type CustomerPushPriority = "low" | "normal" | "high";

const HOUR_MS = 60 * 60 * 1000;

/**
 * The longest a push service is asked to hold an undelivered message: four hours,
 * the same bound upstream's provider applies (ADR-0048 section 6.6, "TTL is the
 * lesser of the policy value and the provider's four hours"). A banner about an
 * order that is hours old is noise.
 */
export const CUSTOMER_PUSH_PROVIDER_MAX_TTL_SECONDS = 4 * 60 * 60;

/**
 * RFC 8030 section 5.3 `Urgency` for a queue priority. The queue priority only
 * orders the claim; the header additionally tells the push service whether a
 * device in a power-saving state may be woken for it. `high` is a payment
 * confirmation, a shipped parcel or a store reply; `low` is a completed order
 * (a courtesy, never worth waking a phone).
 */
export type PushUrgency = "high" | "normal" | "low";

export function urgencyForPriority(
  priority: CustomerPushPriority
): PushUrgency {
  return priority;
}

/**
 * The `TTL` header value in seconds: the time left before the message expires,
 * capped at the provider's four hours and never below one second. Called with the
 * send-time clock so a message that waited in the queue asks the push service to
 * hold it for the REMAINING lifetime, not the original one.
 */
export function resolveProviderTtlSeconds(expiresAt: Date, now: Date): number {
  const remaining = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);

  return Math.max(
    1,
    Math.min(remaining, CUSTOMER_PUSH_PROVIDER_MAX_TTL_SECONDS)
  );
}

// ---------------------------------------------------------------------------
// The event policy (ADR-0048 section 6.6)
// ---------------------------------------------------------------------------

/** Where the consumer finds the customer: the order, or the conversation. */
export type CustomerPushSubject =
  "order_aggregate" | "payload_order_id" | "conversation_aggregate";

export type CustomerPushPolicy = {
  purpose: CustomerPushPurpose;
  priority: CustomerPushPriority;
  /** The coalescing tag (`^[a-z][a-z0-9_]{0,31}$`): a repeat of the same tag replaces rather than stacks. */
  tag: string;
  /** How long a queued message stays sendable (`expires_at`); a message past it is expired, never sent late. */
  ttlMs: number;
  subject: CustomerPushSubject;
  /** E3: no banner for a cancellation the customer made themselves (they are looking at it). */
  suppressWhenCustomerIsActor: boolean;
};

export type CustomerPushPolicyDecision =
  | { kind: "push"; policy: CustomerPushPolicy }
  | { kind: "none"; reason: "unmapped_event" | "status_not_notified" };

/** `order.status_changed` targets that notify. `paid`, `cancelled` and `expired` have their own events, so they are absent on purpose (no double banner). */
const STATUS_CHANGED_PRIORITY: Readonly<
  Record<string, CustomerPushPriority | undefined>
> = {
  processing: "normal",
  shipped: "high",
  completed: "low"
};

type PolicyRow = Omit<CustomerPushPolicy, "priority"> & {
  priority: CustomerPushPriority;
};

/**
 * One row per event type that can produce a push. Exported only so a test can
 * prove each type is published by the `commerce` descriptor and described in the
 * AsyncAPI file (TS-EVT1): a renamed or removed event turns that test red.
 */
export const CUSTOMER_PUSH_EVENT_POLICY: Readonly<Record<string, PolicyRow>> = {
  // E1 - payment confirmed.
  [COMMERCE_ORDER_PAID_EVENT_TYPE]: {
    purpose: "payment_updates",
    priority: "high",
    tag: "payment",
    ttlMs: 4 * HOUR_MS,
    subject: "order_aggregate",
    suppressWhenCustomerIsActor: false
  },
  // E2 - fulfilment status. The priority depends on the target status; this row
  // carries the default and `resolveCustomerPushPolicy` overrides it.
  [COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE]: {
    purpose: "order_updates",
    priority: "normal",
    tag: "order",
    ttlMs: 12 * HOUR_MS,
    subject: "order_aggregate",
    suppressWhenCustomerIsActor: false
  },
  // E3 - cancelled by staff or the system.
  [COMMERCE_ORDER_CANCELLED_EVENT_TYPE]: {
    purpose: "order_updates",
    priority: "normal",
    tag: "order",
    ttlMs: 4 * HOUR_MS,
    subject: "order_aggregate",
    suppressWhenCustomerIsActor: true
  },
  // E4 - the payment window elapsed.
  [COMMERCE_ORDER_EXPIRED_EVENT_TYPE]: {
    purpose: "payment_updates",
    priority: "normal",
    tag: "payment",
    ttlMs: 4 * HOUR_MS,
    subject: "order_aggregate",
    suppressWhenCustomerIsActor: false
  },
  // E5 - one refund leg settled. The event rides on the RETURN aggregate; the
  // order id is in the payload.
  [COMMERCE_REFUND_SETTLED_EVENT_TYPE]: {
    purpose: "payment_updates",
    priority: "normal",
    tag: "payment",
    ttlMs: 12 * HOUR_MS,
    subject: "payload_order_id",
    suppressWhenCustomerIsActor: false
  },
  // E6 - goods accepted back.
  [COMMERCE_RETURN_RECORDED_EVENT_TYPE]: {
    purpose: "order_updates",
    priority: "normal",
    tag: "order",
    ttlMs: 12 * HOUR_MS,
    subject: "payload_order_id",
    suppressWhenCustomerIsActor: false
  },
  // E7 - the store replied in the customer's inbox (Q4: the new event).
  [COMMERCE_CONVERSATION_STORE_REPLIED_EVENT_TYPE]: {
    purpose: "support_replies",
    priority: "high",
    tag: "support",
    ttlMs: 12 * HOUR_MS,
    subject: "conversation_aggregate",
    suppressWhenCustomerIsActor: false
  }
};

/** The event types the policy knows, in a stable order. */
export const CUSTOMER_PUSH_POLICY_EVENT_TYPES: readonly string[] = Object.keys(
  CUSTOMER_PUSH_EVENT_POLICY
);

/**
 * Maps an event to its push policy, or to "none". Total and closed: an unknown
 * type and a status that is not notified both return `none`, and no row maps to
 * a purpose outside the transactional three (checked by the unit test and
 * re-checked here so a bad edit to the table fails closed).
 */
export function resolveCustomerPushPolicy(
  eventType: string,
  payload: Readonly<Record<string, unknown>>
): CustomerPushPolicyDecision {
  const row = CUSTOMER_PUSH_EVENT_POLICY[eventType];
  if (!row || !isTransactionalPurpose(row.purpose)) {
    return { kind: "none", reason: "unmapped_event" };
  }

  if (eventType === COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE) {
    const to = payload.to;
    const priority =
      typeof to === "string" ? STATUS_CHANGED_PRIORITY[to] : undefined;
    if (!priority) return { kind: "none", reason: "status_not_notified" };
    return { kind: "push", policy: { ...row, priority } };
  }

  return { kind: "push", policy: { ...row } };
}

/** A UUID in canonical text form, the only shape an id read from an event payload is accepted in. */
export function asEventUuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
    ? value.toLowerCase()
    : null;
}

// ---------------------------------------------------------------------------
// The generic text catalogue (ADR-0048 section 6.5)
// ---------------------------------------------------------------------------

export type CustomerPushLocale = "en" | "id";

type CatalogueText = { title: string; body: string };

/**
 * Every string a customer push ever carries. No placeholder, no interpolation:
 * the rendered text IS the template. Title at most 120 and body at most 240
 * characters (the outbox CHECKs). Tenant-editable templates are deferred
 * (ADR-0048 Q9).
 */
export const CUSTOMER_PUSH_TEXT_CATALOGUE: Readonly<
  Record<
    CustomerPushPurpose,
    Readonly<Record<CustomerPushLocale, CatalogueText>>
  >
> = {
  order_updates: {
    en: {
      title: "Your order has an update",
      body: "Open your account to see it."
    },
    id: {
      title: "Pesanan Anda ada pembaruan",
      body: "Buka akun Anda untuk melihatnya."
    }
  },
  payment_updates: {
    en: { title: "Payment update", body: "Open your account to see it." },
    id: {
      title: "Pembaruan pembayaran",
      body: "Buka akun Anda untuk melihatnya."
    }
  },
  support_replies: {
    en: {
      title: "You have a new message from the store",
      body: "Open your inbox to read it."
    },
    id: {
      title: "Anda mendapat pesan baru dari toko",
      body: "Buka kotak masuk Anda untuk membacanya."
    }
  }
};

/** The tenant's default locale reduced to a catalogue language; anything not Indonesian is English. */
export function resolveCustomerPushLocale(
  tenantLocale: string | null | undefined
): CustomerPushLocale {
  return typeof tenantLocale === "string" &&
    tenantLocale.trim().toLowerCase().startsWith("id")
    ? "id"
    : "en";
}

export function renderCustomerPushText(
  purpose: CustomerPushPurpose,
  locale: CustomerPushLocale
): CatalogueText {
  return { ...CUSTOMER_PUSH_TEXT_CATALOGUE[purpose][locale] };
}

/** True when `(title, body)` is exactly one of the catalogue's strings for `purpose`. */
export function isCatalogueText(
  purpose: string,
  title: string,
  body: string
): boolean {
  if (!isTransactionalPurpose(purpose)) return false;

  return (["en", "id"] as const).some((locale) => {
    const text = CUSTOMER_PUSH_TEXT_CATALOGUE[purpose][locale];
    return text.title === title && text.body === body;
  });
}

/**
 * The provider-neutral message for a queued row (TS-U4). The click target is the
 * purpose's fixed path, never the row's value, and `data` carries only the
 * coalescing tag: no order id, no message id, no event id, no amount. Returns
 * `null` when the row is not what this system writes (a text outside the
 * catalogue, a path that is not the purpose's, an unknown purpose), so the
 * dispatcher cancels it instead of sending.
 */
export type QueuedCustomerPushRow = {
  purpose: string;
  title: string;
  body: string;
  targetPath: string;
  tag: string;
};

export type CustomerPushProviderMessage = {
  title: string;
  body: string;
  targetPath: string;
  data: { category: string };
};

export function buildCustomerPushProviderMessage(
  row: QueuedCustomerPushRow
): CustomerPushProviderMessage | null {
  if (!isTransactionalPurpose(row.purpose)) return null;
  if (row.targetPath !== CUSTOMER_PUSH_TARGET_PATHS[row.purpose]) return null;
  if (!isCatalogueText(row.purpose, row.title, row.body)) return null;
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(row.tag)) return null;

  return {
    title: row.title,
    body: row.body,
    targetPath: row.targetPath,
    data: { category: row.tag }
  };
}

// ---------------------------------------------------------------------------
// Origin validity (ADR-0048 6.3: a click opens only the device's stored origin)
// ---------------------------------------------------------------------------

/** The hostname of a stored `https://host[:port]` origin, lower-cased; `null` when it does not parse. */
export function originHostname(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Whether a device's stored storefront origin still names one of the tenant's
 * ACTIVE domains and is not the CMS/admin origin. `domainHostnames` holds the
 * normalised hostnames of the tenant's active, non-deleted domains.
 */
export function isStorefrontOriginStillValid(
  origin: string,
  domainHostnames: ReadonlySet<string>,
  adminOrigin: string | null
): boolean {
  const hostname = originHostname(origin);
  if (hostname === null || !domainHostnames.has(hostname)) return false;
  if (adminOrigin !== null && origin === adminOrigin) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Send-time eligibility (ADR-0048 section 5.5, TS-I4)
// ---------------------------------------------------------------------------

export type SendEligibilityFacts = {
  message: {
    accountId: string;
    purpose: string;
    title: string;
    body: string;
    targetPath: string;
    tag: string;
    expiresAt: Date;
  };
  /** The device row the message addresses; `null` when it no longer exists. */
  device: {
    status: string;
    accountId: string;
    storefrontOrigin: string;
  } | null;
  /** The device's enrolling session; `null` when it was purged (or never set). */
  session: { revokedAt: Date | null; expiresAt: Date } | null;
  /** The message's account; `null` when it no longer exists. */
  account: {
    status: string;
    emailVerifiedAt: Date | null;
    deletedAt: Date | null;
  } | null;
  /** The customer row bound to the account; `null` when absent. */
  customerStatus: string | null;
  /** The account's preference for the MESSAGE's purpose; `null` when never set. */
  preference: { enabled: boolean; consentTextVersion: string } | null;
  /** Normalised hostnames of the tenant's active, non-deleted domains. */
  domainHostnames: ReadonlySet<string>;
  /** The CMS/admin origin (`APP_URL`), or `null` when unset or unparseable. */
  adminOrigin: string | null;
};

export type SendTombstone = {
  status: "revoked" | "disabled";
  reason: CustomerPushStatusReason;
};

export type SendEligibility =
  | { eligible: true }
  | {
      eligible: false;
      /** `expire` moves the message to `expired`, `cancel` to `cancelled`. */
      outcome: "cancel" | "expire";
      /** The fixed `last_error` code recorded on the message. */
      error: CustomerPushErrorCode;
      /** The device must also leave `active` (its credentials are destroyed). */
      tombstone: SendTombstone | null;
    };

const CANCEL = (
  error: CustomerPushErrorCode,
  tombstone: SendTombstone | null = null
): SendEligibility => ({
  eligible: false,
  outcome: "cancel",
  error,
  tombstone
});

/**
 * Decides whether a queued message may still be sent. Each branch is one
 * predicate of ADR-0048 section 5.5; the first that fails decides. The tenant
 * gates (commerce module enabled, `customerPush` on, push configured) are checked
 * once per pass by the dispatcher, before it claims anything.
 */
export function evaluateSendEligibility(
  facts: SendEligibilityFacts,
  now: Date
): SendEligibility {
  const { message, device, session, account } = facts;

  // Never send late.
  if (message.expiresAt.getTime() <= now.getTime()) {
    return {
      eligible: false,
      outcome: "expire",
      error: "expired",
      tombstone: null
    };
  }

  // The message itself must be what this system writes: a transactional purpose
  // (marketing is unreachable), the purpose's fixed path, catalogue text.
  if (
    buildCustomerPushProviderMessage({
      purpose: message.purpose,
      title: message.title,
      body: message.body,
      targetPath: message.targetPath,
      tag: message.tag
    }) === null
  ) {
    return CANCEL("not_eligible");
  }

  // The device is active, and I5: its CURRENT account is the message's account.
  if (!device || device.status !== "active") return CANCEL("device_revoked");
  if (device.accountId !== message.accountId) {
    return CANCEL("device_transferred");
  }

  // The account is active, not erased, its customer is not blocked (T12).
  if (
    !account ||
    account.deletedAt !== null ||
    account.status !== "active" ||
    facts.customerStatus === null ||
    facts.customerStatus === "blocked"
  ) {
    return CANCEL("account_blocked", {
      status: "revoked",
      reason: "account_blocked"
    });
  }
  if (account.emailVerifiedAt === null) return CANCEL("not_eligible");

  // The enrolling session is still live (T6, Q5).
  if (
    !session ||
    session.revokedAt !== null ||
    session.expiresAt.getTime() <= now.getTime()
  ) {
    return CANCEL("session_ended", {
      status: "revoked",
      reason: "session_ended"
    });
  }

  // Opt-in: the purpose is explicitly on, under the CURRENT consent wording (T13).
  if (
    !facts.preference ||
    !facts.preference.enabled ||
    facts.preference.consentTextVersion !== CUSTOMER_PUSH_CONSENT_TEXT_VERSION
  ) {
    return CANCEL("consent_withdrawn");
  }

  // The click target's origin is still one of the tenant's domains (6.3).
  if (
    !isStorefrontOriginStillValid(
      device.storefrontOrigin,
      facts.domainHostnames,
      facts.adminOrigin
    )
  ) {
    return CANCEL("origin_revoked", {
      status: "disabled",
      reason: "origin_revoked"
    });
  }

  return { eligible: true };
}

// ---------------------------------------------------------------------------
// The send-time cap (ADR-0048 section 5.4: 12 per rolling hour, 40 per day)
// ---------------------------------------------------------------------------

/** When the first send was accepted for one distinct source event (one notification), whatever the number of devices it fanned out to. */
export type SentNotification = { eventId: string; firstSentAt: Date };

export type SendCapDecision =
  | { allowed: true }
  | { allowed: false; reason: "hourly_cap" | "daily_cap"; retryAt: Date };

/** Never retry sooner than this, so a deferral cannot busy-loop a claim. */
export const CUSTOMER_PUSH_MIN_DEFERRAL_MS = 60 * 1000;

/**
 * The send-side twin of the enqueue cap. A notification is one source event, so
 * fanning an event out to five devices counts once; sending the event's next
 * device never counts against itself. When the account is already at a cap the
 * message is deferred until the oldest counted notification leaves that window,
 * never dropped here (the TTL expires it if the window outlasts it).
 *
 * `sent` holds notifications whose first send was accepted inside the last day.
 */
export function evaluateSendCap(
  sent: readonly SentNotification[],
  eventId: string,
  now: Date,
  caps: { hourly: number; daily: number } = {
    hourly: CUSTOMER_PUSH_HOURLY_NOTIFICATION_CAP,
    daily: CUSTOMER_PUSH_DAILY_NOTIFICATION_CAP
  }
): SendCapDecision {
  if (sent.some((entry) => entry.eventId === eventId)) {
    return { allowed: true };
  }

  const hourStart = now.getTime() - CUSTOMER_PUSH_HOUR_MS;
  const dayStart = now.getTime() - CUSTOMER_PUSH_DAY_MS;

  const times = (since: number) =>
    sent
      .map((entry) => entry.firstSentAt.getTime())
      .filter((time) => time >= since)
      .sort((a, b) => a - b);

  const hourTimes = times(hourStart);
  const dayTimes = times(dayStart);

  const releases: { reason: "hourly_cap" | "daily_cap"; at: number }[] = [];
  if (hourTimes.length >= caps.hourly) {
    releases.push({
      reason: "hourly_cap",
      at: hourTimes[hourTimes.length - caps.hourly]! + CUSTOMER_PUSH_HOUR_MS
    });
  }
  if (dayTimes.length >= caps.daily) {
    releases.push({
      reason: "daily_cap",
      at: dayTimes[dayTimes.length - caps.daily]! + CUSTOMER_PUSH_DAY_MS
    });
  }

  if (releases.length === 0) return { allowed: true };

  // Both windows must have room; the later release wins, and its window names the reason.
  const binding = releases.reduce((a, b) => (b.at > a.at ? b : a));
  return {
    allowed: false,
    reason: binding.reason,
    retryAt: new Date(
      Math.max(binding.at, now.getTime() + CUSTOMER_PUSH_MIN_DEFERRAL_MS)
    )
  };
}

// ---------------------------------------------------------------------------
// Provider outcome classification and the response snippet
// ---------------------------------------------------------------------------

export type ProviderResultShape =
  | { ok: true }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      subscriptionGone?: boolean;
    };

export type ProviderOutcome =
  | { kind: "accepted" }
  | { kind: "gone"; snippet: string }
  | { kind: "retry"; snippet: string }
  | { kind: "permanent"; snippet: string };

const SNIPPET_MAX_CHARS = 500;

/**
 * A provider's free-text error reduced to something safe for the one column that
 * stores it (`provider_response_snippet`, ADR-0048 T11): URLs (an endpoint is a
 * bearer-grade capability) and any long token-like run are replaced, whitespace
 * collapsed, the whole capped at 500 characters. It is a diagnostic aid, not a
 * record; the payload and the endpoint never reach it.
 */
export function sanitizeProviderSnippet(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SNIPPET_MAX_CHARS);
}

/** Maps the upstream provider's result to the four outcomes the dispatcher acts on. */
export function classifyProviderResult(
  result: ProviderResultShape
): ProviderOutcome {
  if (result.ok) return { kind: "accepted" };

  const snippet = sanitizeProviderSnippet(result.error);
  if (result.subscriptionGone) return { kind: "gone", snippet };
  return result.retryable
    ? { kind: "retry", snippet }
    : { kind: "permanent", snippet };
}
