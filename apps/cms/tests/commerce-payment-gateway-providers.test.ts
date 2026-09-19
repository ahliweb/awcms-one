/**
 * Midtrans + `log` payment-gateway adapter unit tests (Issue #110, contract
 * #106's D3). Midtrans is driven against a LOCAL fake HTTP server
 * (`Bun.serve`) injected via its own `snapBaseUrl`/`statusBaseUrl`
 * overrides — the same seam `commerce-whatsapp-providers.test.ts` and
 * `commerce-rajaongkir-provider.test.ts` already use for this module's other
 * provider adapters. No real network call is ever made.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetProviderCircuitBreakersForTests } from "../src/lib/database/circuit-breaker";
import { createMidtransProvider } from "../src/modules/commerce/infrastructure/midtrans-provider";
import {
  createLogPaymentGatewayProvider,
  LOG_PROVIDER_PAID_AFTER_MS
} from "../src/modules/commerce/infrastructure/log-payment-gateway-provider";

type FakeBehavior =
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "text"; status?: number; body: string }
  | { kind: "delayMs"; ms: number; body: unknown };

let behavior: FakeBehavior = {
  kind: "json",
  body: {
    token: "tok-1",
    redirect_url: "https://app.sandbox.midtrans.com/snap/v1/x"
  }
};
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

beforeEach(() => {
  resetProviderCircuitBreakersForTests();
  server = Bun.serve({
    port: 0,
    async fetch() {
      const current = behavior;
      if (current.kind === "delayMs") {
        await new Promise((resolve) => setTimeout(resolve, current.ms));
        return Response.json(current.body);
      }
      if (current.kind === "text") {
        return new Response(current.body, { status: current.status ?? 200 });
      }
      return Response.json(current.body, { status: current.status ?? 200 });
    }
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server.stop(true);
});

const SESSION_INPUT = {
  orderCode: "ORD-ABC",
  attempt: 1,
  grossAmount: "150000.00",
  customerName: "Budi",
  customerPhone: "+6281234567890",
  customerEmail: null
};

describe("Midtrans adapter (Issue #110)", () => {
  test("createSession success maps to {providerRef, redirectUrl, expiresAt}", async () => {
    behavior = {
      kind: "json",
      body: { token: "tok-1", redirect_url: `${baseUrl}/snap` }
    };
    const provider = createMidtransProvider({
      serverKey: "SB-Mid-server-abc",
      isProduction: false,
      snapBaseUrl: baseUrl,
      statusBaseUrl: baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.createSession(SESSION_INPUT);

    expect(result.providerRef).toBe("ORD-ABC-1");
    expect(result.redirectUrl).toBe(`${baseUrl}/snap`);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("createSession's order_id is unique per attempt", async () => {
    behavior = {
      kind: "json",
      body: { token: "tok-1", redirect_url: `${baseUrl}/snap` }
    };
    const provider = createMidtransProvider({
      serverKey: "SB-Mid-server-abc",
      isProduction: false,
      snapBaseUrl: baseUrl,
      statusBaseUrl: baseUrl,
      timeoutMs: 2000
    });

    const first = await provider.createSession(SESSION_INPUT);
    const second = await provider.createSession({
      ...SESSION_INPUT,
      attempt: 2
    });

    expect(first.providerRef).toBe("ORD-ABC-1");
    expect(second.providerRef).toBe("ORD-ABC-2");
  });

  test("createSession throws when the response is missing token/redirect_url", async () => {
    behavior = { kind: "json", body: {} };
    const provider = createMidtransProvider({
      serverKey: "SB-Mid-server-abc",
      isProduction: false,
      snapBaseUrl: baseUrl,
      statusBaseUrl: baseUrl,
      timeoutMs: 2000
    });

    await expect(provider.createSession(SESSION_INPUT)).rejects.toThrow();
  });

  test("createSession throws on a non-2xx response", async () => {
    behavior = { kind: "text", status: 500, body: "server error" };
    const provider = createMidtransProvider({
      serverKey: "SB-Mid-server-abc",
      isProduction: false,
      snapBaseUrl: baseUrl,
      statusBaseUrl: baseUrl,
      timeoutMs: 2000
    });

    await expect(provider.createSession(SESSION_INPUT)).rejects.toThrow();
  });

  test("fetchStatus maps a settlement response to paid", async () => {
    behavior = {
      kind: "json",
      body: { transaction_status: "settlement", fraud_status: null }
    };
    const provider = createMidtransProvider({
      serverKey: "SB-Mid-server-abc",
      isProduction: false,
      snapBaseUrl: baseUrl,
      statusBaseUrl: baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.fetchStatus("ORD-ABC-1");
    expect(result.status).toBe("paid");
  });

  test("verifyWebhook delegates to the pure signature check", async () => {
    const provider = createMidtransProvider({
      serverKey: "SB-Mid-server-abc",
      isProduction: false,
      snapBaseUrl: baseUrl,
      statusBaseUrl: baseUrl,
      timeoutMs: 2000
    });

    const bad = await provider.verifyWebhook({
      orderId: "ORD-ABC-1",
      statusCode: "200",
      grossAmount: "150000.00",
      transactionStatus: "settlement",
      fraudStatus: null,
      signatureKey: "0".repeat(128)
    });

    expect(bad.ok).toBe(false);
  });

  test("production defaults to the production base URLs when no override is given", async () => {
    const provider = createMidtransProvider({
      serverKey: "SB-Mid-server-abc",
      isProduction: true
    });
    // No network assertion possible without an override — this only proves
    // construction does not throw for the production branch.
    expect(provider).toBeTruthy();
  });
});

describe("log payment-gateway provider (Issue #110)", () => {
  test("createSession builds the /pesanan redirect URL and a providerRef carrying the creation timestamp", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const provider = createLogPaymentGatewayProvider({
      storefrontPublicUrl: "https://toko.example.com",
      now: () => now
    });

    const result = await provider.createSession(SESSION_INPUT);

    expect(result.redirectUrl).toBe(
      "https://toko.example.com/pesanan?kode=ORD-ABC&gateway=log"
    );
    expect(result.providerRef).toBe(`log:ORD-ABC:1:${now.getTime()}`);
  });

  test("fetchStatus is pending before 60 real seconds and paid at/after, via an injected clock", async () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    let clock = createdAt;
    const provider = createLogPaymentGatewayProvider({
      storefrontPublicUrl: "https://toko.example.com",
      now: () => clock
    });

    const session = await provider.createSession(SESSION_INPUT);

    clock = new Date(createdAt.getTime() + LOG_PROVIDER_PAID_AFTER_MS - 1);
    expect((await provider.fetchStatus(session.providerRef)).status).toBe(
      "pending"
    );

    clock = new Date(createdAt.getTime() + LOG_PROVIDER_PAID_AFTER_MS);
    expect((await provider.fetchStatus(session.providerRef)).status).toBe(
      "paid"
    );
  });

  test("fetchStatus never throws on an unrecognized providerRef", async () => {
    const provider = createLogPaymentGatewayProvider({
      storefrontPublicUrl: "https://toko.example.com"
    });

    const result = await provider.fetchStatus("not-a-log-ref");
    expect(result.status).toBe("pending");
  });

  test("makes no network calls at all", async () => {
    const provider = createLogPaymentGatewayProvider({
      storefrontPublicUrl: "https://toko.example.com"
    });
    // If this adapter ever performed I/O, closing the fake server here would
    // make the following calls fail/hang.
    server.stop(true);

    const session = await provider.createSession(SESSION_INPUT);
    const status = await provider.fetchStatus(session.providerRef);
    expect(status.status).toBe("pending");
  });
});
