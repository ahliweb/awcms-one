/**
 * Payment-gateway webhook intake route — unit tests with every dependency
 * mocked (Issue #113). The real, DB-backed behaviour (webhook -> paid,
 * replay-is-a-no-op, reconcile, cross-tenant RLS) is proven against a real
 * Postgres in `tests/integration/commerce-payment-webhook.integration.test.ts`;
 * this file only proves the ROUTE's own gate ordering, driven with a fake
 * Astro context — the same split `analytics-beacon-cors.test.ts` documents
 * for its own public route.
 *
 * `mock.module` mutates the process-wide module registry and does not undo
 * itself — every mock below is restored in `afterEach`, the same discipline
 * `commerce-customer-auth.test.ts` documents.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { APIRoute } from "astro";

import * as realDbClient from "../src/lib/database/client";
import * as realIntake from "../src/modules/commerce/application/payment-webhook-intake";
import * as realResolver from "../src/modules/commerce/infrastructure/payment-gateway-provider-resolver";
import { resetRateLimitForTests } from "../src/lib/security/rate-limit";
import { generateWebhookEndpointToken } from "../src/lib/auth/webhook-endpoint-token";
import type { PaymentGatewayProvider } from "../src/modules/commerce/domain/payment-gateway-provider";

const ORIGINAL_DB_CLIENT = { ...realDbClient };
const ORIGINAL_INTAKE = { ...realIntake };
const ORIGINAL_RESOLVER = { ...realResolver };

const FAKE_SQL = {} as unknown as Bun.SQL;
const VALID_TOKEN = generateWebhookEndpointToken();

function makeRequest(body: unknown, ip: string): Request {
  return new Request(
    "https://cms.example.com/api/v1/commerce/webhooks/midtrans/x",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": ip
      },
      body: JSON.stringify(body)
    }
  );
}

const VALID_MIDTRANS_BODY = {
  order_id: "ORD-1-1",
  status_code: "200",
  gross_amount: "10000.00",
  transaction_status: "settlement",
  fraud_status: null,
  signature_key: "a".repeat(128)
};

function mockProvider(overrides: Partial<PaymentGatewayProvider> = {}) {
  return {
    createSession: async () => {
      throw new Error("must not be called by the webhook route");
    },
    fetchStatus: async () => {
      throw new Error("the webhook route must NEVER call fetchStatus");
    },
    verifyWebhook: async () => ({
      ok: true,
      eventKey: "ORD-1-1:200",
      providerRef: "ORD-1-1",
      status: "paid" as const
    }),
    ...overrides
  } satisfies PaymentGatewayProvider;
}

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.0.0.${ipCounter}`;
}

async function loadRoute(): Promise<{ POST: APIRoute }> {
  // Import fresh each time so the mocks registered just before this call are
  // the ones the route module resolves against.
  return import("../src/pages/api/v1/commerce/webhooks/[provider]/[endpointToken].ts");
}

describe("payment-gateway webhook intake route — gate ordering (Issue #113)", () => {
  beforeEach(() => {
    resetRateLimitForTests();
    mock.module("../src/lib/database/client", () => ({
      ...ORIGINAL_DB_CLIENT,
      getDatabaseClient: () => FAKE_SQL
    }));
  });

  afterEach(() => {
    mock.module("../src/lib/database/client", () => ORIGINAL_DB_CLIENT);
    mock.module(
      "../src/modules/commerce/application/payment-webhook-intake",
      () => ORIGINAL_INTAKE
    );
    mock.module(
      "../src/modules/commerce/infrastructure/payment-gateway-provider-resolver",
      () => ORIGINAL_RESOLVER
    );
  });

  test("the route exports POST only — no GET/PUT/PATCH/DELETE (server-to-server callback, not a browser surface)", async () => {
    const routeModule = (await loadRoute()) as unknown as Record<
      string,
      unknown
    >;
    expect(typeof routeModule.POST).toBe("function");
    expect(routeModule.GET).toBeUndefined();
    expect(routeModule.PUT).toBeUndefined();
    expect(routeModule.PATCH).toBeUndefined();
    expect(routeModule.DELETE).toBeUndefined();
  });

  test("an unknown/unresolved token answers a neutral 404, never calling verifyWebhook or applyVerifiedWebhookEvent", async () => {
    let verifyWebhookCalled = false;
    let applyCalled = false;

    mock.module(
      "../src/modules/commerce/application/payment-webhook-intake",
      () => ({
        ...ORIGINAL_INTAKE,
        // Issue #118 — this suite mocks every dependency; the real
        // implementation would open a genuine `withTenantOrThrow` transaction
        // this file's `FAKE_SQL`/`"tenant-1"` fixtures cannot satisfy.
        isGatewayFeatureEnabledForTenant: async () => true,
        resolveWebhookEndpoint: async () => null,
        applyVerifiedWebhookEvent: async () => {
          applyCalled = true;
          return { kind: "applied", orderAffected: true };
        }
      })
    );
    mock.module(
      "../src/modules/commerce/infrastructure/payment-gateway-provider-resolver",
      () => ({
        ...ORIGINAL_RESOLVER,
        resolvePaymentGatewayProvider: () =>
          mockProvider({
            verifyWebhook: async () => {
              verifyWebhookCalled = true;
              return {
                ok: true,
                eventKey: "x",
                providerRef: "x",
                status: "paid" as const
              };
            }
          })
      })
    );

    const { POST } = await loadRoute();
    const response = await POST({
      params: { provider: "midtrans", endpointToken: VALID_TOKEN },
      request: makeRequest(VALID_MIDTRANS_BODY, freshIp()),
      clientAddress: "203.0.113.5"
    } as unknown as Parameters<APIRoute>[0]);

    expect(response.status).toBe(404);
    expect(verifyWebhookCalled).toBe(false);
    expect(applyCalled).toBe(false);
  });

  test("a provider path segment mismatched against the token's own resolved provider also answers 404", async () => {
    mock.module(
      "../src/modules/commerce/application/payment-webhook-intake",
      () => ({
        ...ORIGINAL_INTAKE,
        // Issue #118 — this suite mocks every dependency; the real
        // implementation would open a genuine `withTenantOrThrow` transaction
        // this file's `FAKE_SQL`/`"tenant-1"` fixtures cannot satisfy.
        isGatewayFeatureEnabledForTenant: async () => true,
        resolveWebhookEndpoint: async () => ({
          tenantId: "tenant-1",
          provider: "midtrans"
        })
      })
    );

    const { POST } = await loadRoute();
    const response = await POST({
      // Path says "log", but the token resolves to "midtrans" — mismatch.
      params: { provider: "log", endpointToken: VALID_TOKEN },
      request: makeRequest(VALID_MIDTRANS_BODY, freshIp()),
      clientAddress: "203.0.113.5"
    } as unknown as Parameters<APIRoute>[0]);

    expect(response.status).toBe(404);
  });

  test("provider.verifyWebhook failure -> 401, and the event is never applied", async () => {
    let applyCalled = false;

    mock.module(
      "../src/modules/commerce/application/payment-webhook-intake",
      () => ({
        ...ORIGINAL_INTAKE,
        // Issue #118 — this suite mocks every dependency; the real
        // implementation would open a genuine `withTenantOrThrow` transaction
        // this file's `FAKE_SQL`/`"tenant-1"` fixtures cannot satisfy.
        isGatewayFeatureEnabledForTenant: async () => true,
        resolveWebhookEndpoint: async () => ({
          tenantId: "tenant-1",
          provider: "midtrans"
        }),
        applyVerifiedWebhookEvent: async () => {
          applyCalled = true;
          return { kind: "applied", orderAffected: true };
        }
      })
    );
    mock.module(
      "../src/modules/commerce/infrastructure/payment-gateway-provider-resolver",
      () => ({
        ...ORIGINAL_RESOLVER,
        resolvePaymentGatewayProvider: () =>
          mockProvider({
            verifyWebhook: async () => ({
              ok: false,
              eventKey: "",
              providerRef: "",
              status: "pending" as const
            })
          })
      })
    );

    const { POST } = await loadRoute();
    const response = await POST({
      params: { provider: "midtrans", endpointToken: VALID_TOKEN },
      request: makeRequest(VALID_MIDTRANS_BODY, freshIp()),
      clientAddress: "203.0.113.5"
    } as unknown as Parameters<APIRoute>[0]);

    expect(response.status).toBe(401);
    expect(applyCalled).toBe(false);
  });

  test("a replayed event still answers 200, with no error surfaced to the caller", async () => {
    mock.module(
      "../src/modules/commerce/application/payment-webhook-intake",
      () => ({
        ...ORIGINAL_INTAKE,
        // Issue #118 — this suite mocks every dependency; the real
        // implementation would open a genuine `withTenantOrThrow` transaction
        // this file's `FAKE_SQL`/`"tenant-1"` fixtures cannot satisfy.
        isGatewayFeatureEnabledForTenant: async () => true,
        resolveWebhookEndpoint: async () => ({
          tenantId: "tenant-1",
          provider: "midtrans"
        }),
        applyVerifiedWebhookEvent: async () => ({ kind: "replay" })
      })
    );
    mock.module(
      "../src/modules/commerce/infrastructure/payment-gateway-provider-resolver",
      () => ({
        ...ORIGINAL_RESOLVER,
        resolvePaymentGatewayProvider: () => mockProvider()
      })
    );

    const { POST } = await loadRoute();
    const response = await POST({
      params: { provider: "midtrans", endpointToken: VALID_TOKEN },
      request: makeRequest(VALID_MIDTRANS_BODY, freshIp()),
      clientAddress: "203.0.113.5"
    } as unknown as Parameters<APIRoute>[0]);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { outcome: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.outcome).toBe("replay");
  });

  test("a verified, newly-applied event answers 200", async () => {
    mock.module(
      "../src/modules/commerce/application/payment-webhook-intake",
      () => ({
        ...ORIGINAL_INTAKE,
        // Issue #118 — this suite mocks every dependency; the real
        // implementation would open a genuine `withTenantOrThrow` transaction
        // this file's `FAKE_SQL`/`"tenant-1"` fixtures cannot satisfy.
        isGatewayFeatureEnabledForTenant: async () => true,
        resolveWebhookEndpoint: async () => ({
          tenantId: "tenant-1",
          provider: "midtrans"
        }),
        applyVerifiedWebhookEvent: async () => ({
          kind: "applied",
          orderAffected: true
        })
      })
    );
    mock.module(
      "../src/modules/commerce/infrastructure/payment-gateway-provider-resolver",
      () => ({
        ...ORIGINAL_RESOLVER,
        resolvePaymentGatewayProvider: () => mockProvider()
      })
    );

    const { POST } = await loadRoute();
    const response = await POST({
      params: { provider: "midtrans", endpointToken: VALID_TOKEN },
      request: makeRequest(VALID_MIDTRANS_BODY, freshIp()),
      clientAddress: "203.0.113.5"
    } as unknown as Parameters<APIRoute>[0]);

    expect(response.status).toBe(200);
  });

  test("no provider configured for this deployment answers the same neutral 404", async () => {
    mock.module(
      "../src/modules/commerce/application/payment-webhook-intake",
      () => ({
        ...ORIGINAL_INTAKE,
        // Issue #118 — this suite mocks every dependency; the real
        // implementation would open a genuine `withTenantOrThrow` transaction
        // this file's `FAKE_SQL`/`"tenant-1"` fixtures cannot satisfy.
        isGatewayFeatureEnabledForTenant: async () => true,
        resolveWebhookEndpoint: async () => ({
          tenantId: "tenant-1",
          provider: "midtrans"
        })
      })
    );
    mock.module(
      "../src/modules/commerce/infrastructure/payment-gateway-provider-resolver",
      () => ({
        ...ORIGINAL_RESOLVER,
        resolvePaymentGatewayProvider: () => null
      })
    );

    const { POST } = await loadRoute();
    const response = await POST({
      params: { provider: "midtrans", endpointToken: VALID_TOKEN },
      request: makeRequest(VALID_MIDTRANS_BODY, freshIp()),
      clientAddress: "203.0.113.5"
    } as unknown as Parameters<APIRoute>[0]);

    expect(response.status).toBe(404);
  });

  test("Issue #118 — a tenant with features.gateway disabled answers the same neutral 404, never calling verifyWebhook or applyVerifiedWebhookEvent", async () => {
    let verifyWebhookCalled = false;
    let applyCalled = false;

    mock.module(
      "../src/modules/commerce/application/payment-webhook-intake",
      () => ({
        ...ORIGINAL_INTAKE,
        isGatewayFeatureEnabledForTenant: async () => false,
        resolveWebhookEndpoint: async () => ({
          tenantId: "tenant-1",
          provider: "midtrans"
        }),
        applyVerifiedWebhookEvent: async () => {
          applyCalled = true;
          return { kind: "applied", orderAffected: true };
        }
      })
    );
    mock.module(
      "../src/modules/commerce/infrastructure/payment-gateway-provider-resolver",
      () => ({
        ...ORIGINAL_RESOLVER,
        resolvePaymentGatewayProvider: () =>
          mockProvider({
            verifyWebhook: async () => {
              verifyWebhookCalled = true;
              return {
                ok: true,
                eventKey: "x",
                providerRef: "x",
                status: "paid" as const
              };
            }
          })
      })
    );

    const { POST } = await loadRoute();
    const response = await POST({
      params: { provider: "midtrans", endpointToken: VALID_TOKEN },
      request: makeRequest(VALID_MIDTRANS_BODY, freshIp()),
      clientAddress: "203.0.113.5"
    } as unknown as Parameters<APIRoute>[0]);

    expect(response.status).toBe(404);
    expect(verifyWebhookCalled).toBe(false);
    expect(applyCalled).toBe(false);
  });
});
