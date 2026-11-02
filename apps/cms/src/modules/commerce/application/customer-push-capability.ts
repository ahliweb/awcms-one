/**
 * What the SERVER knows about customer Web Push for this deployment and this
 * request (Issue #430, ADR-0048 section 6.1 "Capability"). Everything the
 * BROWSER knows (Push API present, installed iOS app, permission state) is
 * detected by the storefront (#431).
 *
 * `enabled: false` is a first-class 200 answer, not an error: a deployment with
 * no VAPID key pair (the offline/LAN profile) or a shared storefront/CMS origin
 * is a normal deployment, and the page's job is to hide the control, which it
 * cannot do if this 500s.
 *
 * ## Origins (ADR-0048 6.3, T8, Q3)
 *
 * The service worker and the push subscription live on the STOREFRONT origin. A
 * request is acceptable only when its `Origin` is a cross-origin `https` origin
 * (an `http` loopback origin only when `APP_ENV=development`), already resolved
 * to THIS tenant's active domain by the shared commerce resolver, and different
 * from the CMS/admin origin (`APP_URL`). A same-origin request (storefront and
 * CMS served from one origin) is unsupported in v1: `origin_not_supported`.
 */
import { parseRequestOrigin } from "../../../lib/security/request-origin";
import { resolvePushAuthSecretRing } from "../../push-delivery/domain/push-auth-secret";
import { isPushEnabled } from "../../push-delivery/domain/push-config";
import { parseVapidConfig } from "../../push-delivery/domain/vapid-config";
import {
  CUSTOMER_PUSH_CONSENT_TEXT_VERSION,
  CUSTOMER_PUSH_MAX_DEVICES,
  CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES
} from "../domain/customer-push";
import type { KeyRing } from "../../../lib/security/field-encryption";

export type CustomerPushCapability = {
  enabled: boolean;
  reason: null | "push_not_configured" | "origin_not_supported";
  /** The VAPID public key for `PushManager.subscribe()`; null unless enabled. */
  applicationServerKey: string | null;
  transports: ["web_push"];
  purposes: readonly string[];
  consentTextVersion: string;
  maxDevices: number;
};

export type PushAvailability =
  { ok: true; applicationServerKey: string; ring: KeyRing } | { ok: false };

/**
 * Whether this deployment can store and later send a customer subscription:
 * `PUSH_ENABLED=true`, the `web_push` provider, a valid VAPID key pair and the
 * auth-secret key ring (no plaintext fallback, so no ring means no registration).
 */
export function resolvePushAvailability(
  env: NodeJS.ProcessEnv = process.env
): PushAvailability {
  if (!isPushEnabled(env) || env.PUSH_PROVIDER !== "web_push") {
    return { ok: false };
  }

  const vapid = parseVapidConfig(env);
  const ring = resolvePushAuthSecretRing(env);

  if (!vapid.ok || !ring.ok) return { ok: false };

  return {
    ok: true,
    applicationServerKey: vapid.config.publicKey,
    ring
  };
}

export type StorefrontOriginDecision =
  { ok: true; origin: string } | { ok: false };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The storefront origin a device may be bound to, derived from the request's
 * `Origin` header ONLY. `crossOrigin` is the result of the shared commerce
 * origin classifier (a refused origin never reaches a handler; a same-origin
 * request is not cross-origin). Accepts: `https`, no userinfo/path/query (the
 * shared parser already requires the header to equal its parsed origin), not
 * the CMS/admin origin. Never takes a value from the body.
 */
export function resolveStorefrontOrigin(
  originHeader: string | null,
  crossOrigin: boolean,
  env: NodeJS.ProcessEnv = process.env
): StorefrontOriginDecision {
  if (!crossOrigin) return { ok: false };

  const parsed = parseRequestOrigin(originHeader);
  if (!parsed) return { ok: false };

  const url = new URL(parsed.origin);
  const developmentLoopback =
    env.APP_ENV?.trim().toLowerCase() === "development" &&
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname);

  if (url.protocol !== "https:" && !developmentLoopback) return { ok: false };

  const appUrl = env.APP_URL?.trim();
  if (appUrl) {
    try {
      if (new URL(appUrl).origin === parsed.origin) return { ok: false };
    } catch {
      // An unparseable APP_URL is a configuration error validate-env reports;
      // it cannot make a storefront origin MORE acceptable.
    }
  }

  return { ok: true, origin: parsed.origin };
}

export function buildCustomerPushCapability(
  availability: PushAvailability,
  origin: StorefrontOriginDecision
): CustomerPushCapability {
  const base = {
    transports: ["web_push"] as ["web_push"],
    purposes: CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES,
    consentTextVersion: CUSTOMER_PUSH_CONSENT_TEXT_VERSION,
    maxDevices: CUSTOMER_PUSH_MAX_DEVICES
  };

  if (!availability.ok) {
    return {
      ...base,
      enabled: false,
      reason: "push_not_configured",
      applicationServerKey: null
    };
  }

  if (!origin.ok) {
    return {
      ...base,
      enabled: false,
      reason: "origin_not_supported",
      applicationServerKey: null
    };
  }

  return {
    ...base,
    enabled: true,
    reason: null,
    applicationServerKey: availability.applicationServerKey
  };
}
