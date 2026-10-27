/**
 * The customer Web Push provider (Issue #432, ADR-0048 sections 5.6 and 6.4):
 * `push_delivery`'s Web Push adapter, REUSED and not copied, configured per
 * message with what a customer notification needs and the upstream factory takes
 * only per provider:
 *
 *  - the device's stored STOREFRONT origin as the declarative payload's public
 *    origin, so `navigate` is on the storefront and never on `APP_URL` (the CMS);
 *  - a `TTL` of the message's remaining lifetime, capped at four hours;
 *  - the RFC 8030 `Urgency` header, which upstream's provider does not send. It
 *    is added by wrapping the injectable HTTP seam (`PushHttpClient`), the one
 *    place a request header can be set without editing upstream code.
 *
 * Constructing an upstream provider is a few object literals, so one is built per
 * message instead of a cache keyed by (origin, ttl, urgency) that would grow with
 * every distinct remaining TTL. The VAPID signing, the RFC 8291 encryption, the
 * response mapping and the shared circuit breaker all live in the upstream
 * provider and are exercised through it.
 *
 * This is the only commerce file that imports the provider and the outbound HTTP
 * client; the enqueue consumer imports neither (TS-S3).
 */
import type { PushProvider } from "../../push-delivery/domain/push-provider-contract";
import {
  resolvePushPayloadFormat,
  resolvePushPublicOrigin
} from "../../push-delivery/domain/push-payload-format";
import { resolvePushSendTimeoutMs } from "../../push-delivery/domain/push-config";
import { parseVapidConfig } from "../../push-delivery/domain/vapid-config";
import {
  defaultPushHttpClient,
  type PushHttpClient
} from "../../push-delivery/infrastructure/push-http-client";
import { createWebPushProvider } from "../../push-delivery/infrastructure/web-push-provider";
import type { PushUrgency } from "../domain/customer-push-policy";

export type CustomerPushProviderSpec = {
  /** The device's stored, domain-validated storefront origin. */
  storefrontOrigin: string;
  ttlSeconds: number;
  urgency: PushUrgency;
};

export type CustomerPushProviderFactory = (
  spec: CustomerPushProviderSpec
) => PushProvider;

/** Adds `Urgency` to every request the wrapped client sends. */
export function withUrgencyHeader(
  base: PushHttpClient,
  urgency: PushUrgency
): PushHttpClient {
  return (url, request) =>
    base(url, {
      ...request,
      headers: { ...request.headers, Urgency: urgency }
    });
}

export type CustomerPushProviderFactoryOptions = {
  env?: NodeJS.ProcessEnv;
  /** The outbound HTTP seam. Defaults to the SSRF-guarded client; a test passes a stub that talks to a local server. */
  http?: PushHttpClient;
};

/**
 * `null` when the VAPID key pair is not configured (the dispatcher then claims
 * nothing; `resolvePushAvailability` has already refused such a deployment).
 */
export function createCustomerPushProviderFactory(
  options: CustomerPushProviderFactoryOptions = {}
): CustomerPushProviderFactory | null {
  const env = options.env ?? process.env;
  const vapid = parseVapidConfig(env);
  if (!vapid.ok) return null;

  const base = options.http ?? defaultPushHttpClient;
  const timeoutMs = resolvePushSendTimeoutMs(env);
  const payloadFormat = resolvePushPayloadFormat(env);

  return (spec) =>
    createWebPushProvider({
      vapid: vapid.config,
      timeoutMs,
      ttlSeconds: spec.ttlSeconds,
      payloadFormat,
      // `null` for a non-https origin (a development loopback), which keeps the
      // legacy payload; the service worker resolves the fixed path itself.
      publicOrigin: resolvePushPublicOrigin(spec.storefrontOrigin),
      http: withUrgencyHeader(base, spec.urgency)
    });
}
