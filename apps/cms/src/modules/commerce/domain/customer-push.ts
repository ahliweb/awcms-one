/**
 * Customer Web Push - the closed vocabularies, the limits and the rate-window
 * arithmetic (Issue #430, ADR-0048). Pure: no database, no network, no
 * `process.env` read at module scope.
 *
 * Every number the owner may want to tune with usage data (ADR-0048 Q7) is a
 * named constant HERE, in one module, so a change is a one-line diff and never a
 * schema change.
 *
 * ## Closed purposes
 *
 * `order_updates`, `payment_updates`, `support_replies` are transactional;
 * `marketing` is RESERVED (a preference row may exist, nothing is ever sent for
 * it in v1, ADR-0048 Q11). Transactional consent never implies marketing
 * consent, and the existing `marketing_consent_at` (e-mail/WhatsApp) is not
 * reused for push.
 */

export const CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES = [
  "order_updates",
  "payment_updates",
  "support_replies"
] as const;

export type CustomerPushPurpose =
  (typeof CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES)[number];

/** Every purpose a preference row may carry; `marketing` is reserved and never sent. */
export const CUSTOMER_PUSH_PURPOSES = [
  ...CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES,
  "marketing"
] as const;

export type CustomerPushStoredPurpose = (typeof CUSTOMER_PUSH_PURPOSES)[number];

export function isTransactionalPurpose(
  value: unknown
): value is CustomerPushPurpose {
  return (
    typeof value === "string" &&
    (CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES as readonly string[]).includes(value)
  );
}

/**
 * The fixed storefront paths a click may open, one per purpose (ADR-0048
 * section 6.5). A click target is NEVER taken from a request or an event; it is
 * this path joined to the device's stored, validated storefront origin at send
 * time. No identifier, query or fragment.
 */
export const CUSTOMER_PUSH_TARGET_PATHS: Readonly<
  Record<CustomerPushPurpose, string>
> = {
  order_updates: "/akun/pesanan",
  payment_updates: "/akun/pesanan",
  support_replies: "/akun/pesan"
};

export const CUSTOMER_PUSH_DEVICE_STATUSES = [
  "active",
  "revoked",
  "gone",
  "disabled"
] as const;

export type CustomerPushDeviceStatus =
  (typeof CUSTOMER_PUSH_DEVICE_STATUSES)[number];

/** The closed vocabulary of `status_reason` (mirrors the CHECK in sql/1056). */
export const CUSTOMER_PUSH_STATUS_REASONS = [
  "customer_removed",
  "logout",
  "session_ended",
  "account_blocked",
  "account_erased",
  "endpoint_gone",
  "origin_revoked",
  "vapid_rotated",
  "kill_switch"
] as const;

export type CustomerPushStatusReason =
  (typeof CUSTOMER_PUSH_STATUS_REASONS)[number];

export const CUSTOMER_PUSH_MESSAGE_STATUSES = [
  "queued",
  "sending",
  "sent",
  "retry_wait",
  "failed",
  "cancelled",
  "expired"
] as const;

export type CustomerPushMessageStatus =
  (typeof CUSTOMER_PUSH_MESSAGE_STATUSES)[number];

/** Statuses after which a message never moves again (the retention purge touches only these). */
export const CUSTOMER_PUSH_TERMINAL_MESSAGE_STATUSES = [
  "sent",
  "failed",
  "cancelled",
  "expired"
] as const;

/**
 * The closed vocabulary of `last_error` / `error_message`. A free-text provider
 * message never reaches a column a diagnostic reads (ADR-0048 T11).
 */
export const CUSTOMER_PUSH_ERROR_CODES = [
  "device_transferred",
  "device_revoked",
  "logout",
  "account_blocked",
  "session_ended",
  "account_erased",
  "expired",
  "not_eligible",
  "provider_rejected",
  "provider_unavailable",
  "endpoint_gone",
  "config_unavailable"
] as const;

export type CustomerPushErrorCode = (typeof CUSTOMER_PUSH_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Limits (ADR-0048 Q7 - initial values, tunable here without a schema change)
// ---------------------------------------------------------------------------

/** Active devices per customer account (ADR-0048 T10). */
export const CUSTOMER_PUSH_MAX_DEVICES = 5;

/** Notifications per account over a rolling hour / day (ADR-0048 section 5.4). */
export const CUSTOMER_PUSH_HOURLY_NOTIFICATION_CAP = 12;
export const CUSTOMER_PUSH_DAILY_NOTIFICATION_CAP = 40;

export const CUSTOMER_PUSH_HOUR_MS = 60 * 60 * 1000;
export const CUSTOMER_PUSH_DAY_MS = 24 * CUSTOMER_PUSH_HOUR_MS;

/** Tombstones, terminal messages and attempts are kept this long (ADR-0048 Q8). */
export const CUSTOMER_PUSH_RETENTION_DAYS = 30;

/** Request body cap for the push routes (ADR-0048 section 6.2). */
export const CUSTOMER_PUSH_BODY_LIMIT_BYTES = 8 * 1024;

/** Rate limits of the push routes (ADR-0048 section 6.2). Over the limit: 429 with `Retry-After`. */
export const CUSTOMER_PUSH_RATE_LIMITS = {
  /** `POST subscriptions` per client IP / per account, per hour. */
  subscribeIp: { maxAttempts: 30, windowMs: CUSTOMER_PUSH_HOUR_MS },
  subscribeAccount: { maxAttempts: 10, windowMs: CUSTOMER_PUSH_HOUR_MS },
  /** `DELETE` and `PUT preferences` per client IP / per account, per minute. */
  mutateIp: { maxAttempts: 60, windowMs: 60_000 },
  mutateAccount: { maxAttempts: 30, windowMs: 60_000 }
} as const;

/**
 * The version of the consent wording the storefront shows (ADR-0048 Q8): a
 * versioned DRAFT (Indonesian first, then English); counsel's review of the
 * wording is a production-activation gate of the `customerPush` flag (D8), not a
 * gate for building. The server hands the current version to the page in the
 * capability answer and records the version a customer granted under; a request
 * naming any other version is refused (the page was stale).
 */
export const CUSTOMER_PUSH_CONSENT_TEXT_VERSION = "draft-2026-10";

const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

// ---------------------------------------------------------------------------
// The notification cap (rate-window math)
// ---------------------------------------------------------------------------

export type NotificationWindowCounts = {
  /** Messages created for the account in the last hour that still count. */
  lastHour: number;
  /** ... in the last day. */
  lastDay: number;
};

export type NotificationCapDecision =
  | { allowed: true; reason: null }
  | { allowed: false; reason: "hourly_cap" | "daily_cap" };

/**
 * Decides whether one more notification fits under both caps. The counts are
 * messages already queued or sent in the window, so a count equal to the cap
 * means the next one is refused (12 per rolling hour means a 13th is not).
 * The hourly cap is checked first so the reason names the tighter window.
 */
export function evaluateNotificationCap(
  counts: NotificationWindowCounts,
  caps: { hourly: number; daily: number } = {
    hourly: CUSTOMER_PUSH_HOURLY_NOTIFICATION_CAP,
    daily: CUSTOMER_PUSH_DAILY_NOTIFICATION_CAP
  }
): NotificationCapDecision {
  if (counts.lastHour >= caps.hourly) {
    return { allowed: false, reason: "hourly_cap" };
  }
  if (counts.lastDay >= caps.daily) {
    return { allowed: false, reason: "daily_cap" };
  }
  return { allowed: true, reason: null };
}

/** The start of the hourly and daily windows for `now`. */
export function notificationWindowStarts(now: Date): {
  hourStart: Date;
  dayStart: Date;
} {
  return {
    hourStart: new Date(now.getTime() - CUSTOMER_PUSH_HOUR_MS),
    dayStart: new Date(now.getTime() - CUSTOMER_PUSH_DAY_MS)
  };
}

/** Whether another active device fits (`activeOthers` excludes the endpoint being registered). */
export function deviceCapAllows(
  activeOthers: number,
  max: number = CUSTOMER_PUSH_MAX_DEVICES
): boolean {
  return activeOthers < max;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export type FieldError = { field: string; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string
): FieldError[] {
  return Object.keys(source)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({
      field: prefix === "" ? key : `${prefix}.${key}`,
      message: "Unknown field."
    }));
}

/**
 * The strict shape check of the register body (ADR-0048 section 6.1, T2): the
 * browser's `PushSubscription.toJSON()` plus `consent`. Anything else, including
 * `transport`, `accountId`, `tenantId`, `title`, `body`, `navigate`, is refused,
 * so a client can neither choose the principal nor the notification content.
 * Pure shape only: the endpoint host, key sizes and consent values are checked
 * by the semantic validators, which answer 422.
 */
export type RegisterBodyShape = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  consent: { purposes: unknown[]; textVersion: string };
};

export type ShapeResult<T> =
  { ok: true; value: T } | { ok: false; errors: FieldError[] };

export function parseRegisterBodyShape(
  body: unknown
): ShapeResult<RegisterBodyShape> {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      errors: [{ field: "body", message: "Body must be a JSON object." }]
    };
  }

  const errors: FieldError[] = unknownKeys(
    body,
    ["endpoint", "keys", "expirationTime", "consent"],
    ""
  );

  if (typeof body.endpoint !== "string") {
    errors.push({ field: "endpoint", message: "endpoint must be a string." });
  }

  const keys = body.keys;
  if (!isPlainObject(keys)) {
    errors.push({ field: "keys", message: "keys must be an object." });
  } else {
    errors.push(...unknownKeys(keys, ["p256dh", "auth"], "keys"));
    if (typeof keys.p256dh !== "string") {
      errors.push({
        field: "keys.p256dh",
        message: "keys.p256dh must be a string."
      });
    }
    if (typeof keys.auth !== "string") {
      errors.push({
        field: "keys.auth",
        message: "keys.auth must be a string."
      });
    }
  }

  if (
    body.expirationTime !== undefined &&
    body.expirationTime !== null &&
    typeof body.expirationTime !== "number"
  ) {
    errors.push({
      field: "expirationTime",
      message: "expirationTime must be a number or null."
    });
  }

  const consent = body.consent;
  if (!isPlainObject(consent)) {
    errors.push({ field: "consent", message: "consent must be an object." });
  } else {
    errors.push(
      ...unknownKeys(consent, ["purposes", "textVersion"], "consent")
    );
    if (!Array.isArray(consent.purposes)) {
      errors.push({
        field: "consent.purposes",
        message: "consent.purposes must be an array."
      });
    }
    if (typeof consent.textVersion !== "string") {
      errors.push({
        field: "consent.textVersion",
        message: "consent.textVersion must be a string."
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const typedKeys = keys as Record<string, string>;
  const typedConsent = consent as {
    purposes: unknown[];
    textVersion: string;
  };

  return {
    ok: true,
    value: {
      endpoint: body.endpoint as string,
      keys: { p256dh: typedKeys.p256dh!, auth: typedKeys.auth! },
      consent: typedConsent
    }
  };
}

export type ValidatedConsent = {
  purposes: CustomerPushPurpose[];
  textVersion: string;
};

/**
 * Semantic validation of a registration's consent (422 on failure): at least one
 * purpose, each a distinct TRANSACTIONAL purpose (`marketing` is reserved and
 * refused), and the version the server currently publishes.
 */
export function validateRegisterConsent(consent: {
  purposes: unknown[];
  textVersion: string;
}): ShapeResult<ValidatedConsent> {
  const errors: FieldError[] = [];
  const purposes: CustomerPushPurpose[] = [];

  if (consent.purposes.length === 0) {
    errors.push({
      field: "consent.purposes",
      message: "Choose at least one notification purpose."
    });
  }

  for (const purpose of consent.purposes) {
    if (!isTransactionalPurpose(purpose)) {
      errors.push({
        field: "consent.purposes",
        message: `Unknown or unavailable purpose. Allowed: ${CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES.join(", ")}.`
      });
      break;
    }
    if (!purposes.includes(purpose)) purposes.push(purpose);
  }

  const versionError = checkConsentVersion(
    consent.textVersion,
    "consent.textVersion"
  );
  if (versionError) errors.push(versionError);

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { purposes, textVersion: consent.textVersion } };
}

function checkConsentVersion(
  version: string,
  field: string
): FieldError | null {
  if (!CONSENT_VERSION_PATTERN.test(version)) {
    return { field, message: "textVersion is malformed." };
  }
  if (version !== CUSTOMER_PUSH_CONSENT_TEXT_VERSION) {
    return {
      field,
      message:
        "The consent text has changed. Reload the page and review the current text before turning notifications on."
    };
  }
  return null;
}

export type PreferenceChange = {
  purpose: CustomerPushPurpose;
  enabled: boolean;
};

export type ValidatedPreferences = {
  changes: PreferenceChange[];
  textVersion: string | null;
};

/**
 * `PUT .../push/preferences` body: `{ purposes: { <purpose>: boolean, ... },
 * textVersion? }`. Only the listed purposes change. Turning a purpose ON needs
 * the current `textVersion` (consent is recorded with the wording shown);
 * turning one OFF never does (a withdrawal must always be possible). Unknown
 * keys and the reserved `marketing` purpose are refused.
 */
export function parsePreferencesBody(
  body: unknown
): ShapeResult<ValidatedPreferences> {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      errors: [{ field: "body", message: "Body must be a JSON object." }]
    };
  }

  const errors = unknownKeys(body, ["purposes", "textVersion"], "");
  const purposes = body.purposes;
  const changes: PreferenceChange[] = [];

  if (!isPlainObject(purposes)) {
    errors.push({ field: "purposes", message: "purposes must be an object." });
  } else if (Object.keys(purposes).length === 0) {
    errors.push({
      field: "purposes",
      message: "Name at least one purpose."
    });
  } else {
    for (const [purpose, enabled] of Object.entries(purposes)) {
      if (!isTransactionalPurpose(purpose)) {
        errors.push({
          field: `purposes.${purpose}`,
          message: `Unknown or unavailable purpose. Allowed: ${CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES.join(", ")}.`
        });
      } else if (typeof enabled !== "boolean") {
        errors.push({
          field: `purposes.${purpose}`,
          message: "Must be true or false."
        });
      } else {
        changes.push({ purpose, enabled });
      }
    }
  }

  let textVersion: string | null = null;
  if (body.textVersion !== undefined) {
    if (typeof body.textVersion !== "string") {
      errors.push({
        field: "textVersion",
        message: "textVersion must be a string."
      });
    } else {
      textVersion = body.textVersion;
    }
  }

  if (changes.some((change) => change.enabled)) {
    if (textVersion === null) {
      errors.push({
        field: "textVersion",
        message: "textVersion is required when turning a purpose on."
      });
    } else {
      const versionError = checkConsentVersion(textVersion, "textVersion");
      if (versionError) errors.push(versionError);
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { changes, textVersion } };
}
