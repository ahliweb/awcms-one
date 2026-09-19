/**
 * Fonnte/Meta WhatsApp adapter unit tests (Issue #108, contract
 * #106/ADR-0017 D5). Drives each adapter against a LOCAL fake HTTP server
 * (`Bun.serve`) injected via its own `baseUrl` config override — the same
 * test seam `turnstile-verifier.test.ts` documents for this repo's other
 * provider adapters (a fake stands in for the real API deterministically;
 * no real network call is ever made). Covers success, a permanent 4xx, a
 * retryable 5xx, and a timeout for each provider, plus the `log` adapter's
 * own always-succeed/never-network behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetProviderCircuitBreakersForTests } from "../src/lib/database/circuit-breaker";
import { createFonnteWhatsappProvider } from "../src/modules/commerce/infrastructure/fonnte-provider";
import { createMetaWhatsappProvider } from "../src/modules/commerce/infrastructure/meta-whatsapp-provider";
import { createLogWhatsappProvider } from "../src/modules/commerce/infrastructure/log-whatsapp-provider";

type FakeBehavior =
  | { kind: "json"; status?: number; body: unknown }
  | { kind: "text"; status?: number; body: string }
  | { kind: "delayMs"; ms: number; body: unknown };

let behavior: FakeBehavior = { kind: "json", body: { status: true, id: "m1" } };
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let requestCount = 0;

beforeEach(() => {
  requestCount = 0;
  resetProviderCircuitBreakersForTests();
  server = Bun.serve({
    port: 0,
    async fetch() {
      requestCount += 1;
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

describe("Fonnte adapter (Issue #108)", () => {
  test("success — status:true maps to ok:true with the provider message id", async () => {
    behavior = { kind: "json", body: { status: true, id: "fonnte-1" } };
    const provider = createFonnteWhatsappProvider({
      token: "tok",
      baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      body: "kode Anda 123456"
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerMessageId).toBe("fonnte-1");
  });

  test("a 2xx body with status:false is a permanent, non-retryable rejection", async () => {
    behavior = {
      kind: "json",
      body: { status: false, reason: "invalid target" }
    };
    const provider = createFonnteWhatsappProvider({
      token: "tok",
      baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      body: "x"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toContain("invalid target");
    }
  });

  test("HTTP 400 is permanent (retryable: false)", async () => {
    behavior = { kind: "text", status: 400, body: "bad request" };
    const provider = createFonnteWhatsappProvider({
      token: "tok",
      baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      body: "x"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
  });

  test("HTTP 500 is retryable", async () => {
    behavior = { kind: "text", status: 500, body: "server error" };
    const provider = createFonnteWhatsappProvider({
      token: "tok",
      baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      body: "x"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  test("a timeout is retryable", async () => {
    behavior = { kind: "delayMs", ms: 200, body: { status: true } };
    const provider = createFonnteWhatsappProvider({
      token: "tok",
      baseUrl,
      timeoutMs: 20
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      body: "x"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  test("target strips the leading + from an E.164 phone", async () => {
    let capturedBody = "";
    server.stop(true);
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedBody = await req.text();
        return Response.json({ status: true, id: "m1" });
      }
    });
    baseUrl = `http://localhost:${server.port}`;

    const provider = createFonnteWhatsappProvider({
      token: "tok",
      baseUrl,
      timeoutMs: 2000
    });

    await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      body: "x"
    });

    expect(capturedBody).toContain("target=6281234567890");
    expect(capturedBody).not.toContain("target=%2B");
  });
});

describe("Meta WhatsApp Cloud API adapter (Issue #108)", () => {
  test("OTP send builds a template message and succeeds", async () => {
    behavior = { kind: "json", body: { messages: [{ id: "wamid.1" }] } };
    const provider = createMetaWhatsappProvider({
      token: "tok",
      phoneNumberId: "12345",
      otpTemplateName: "customer_otp",
      baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      body: "unused for a template send",
      otpCode: "123456"
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.providerMessageId).toBe("wamid.1");
  });

  test("OTP send with no configured template name is a non-retryable misconfiguration, not a network call", async () => {
    const provider = createMetaWhatsappProvider({
      token: "tok",
      phoneNumberId: "12345",
      baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      body: "x",
      otpCode: "123456"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(false);
    expect(requestCount).toBe(0);
  });

  test("a free-text send (no otpCode) succeeds", async () => {
    behavior = { kind: "json", body: { messages: [{ id: "wamid.2" }] } };
    const provider = createMetaWhatsappProvider({
      token: "tok",
      phoneNumberId: "12345",
      baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.order_paid",
      body: "Pesanan Anda telah dibayar."
    });

    expect(result.ok).toBe(true);
  });

  test("HTTP 400 (e.g. unapproved template) is permanent", async () => {
    behavior = {
      kind: "json",
      status: 400,
      body: { error: { message: "template not approved" } }
    };
    const provider = createMetaWhatsappProvider({
      token: "tok",
      phoneNumberId: "12345",
      baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.order_paid",
      body: "x"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toContain("template not approved");
    }
  });

  test("HTTP 500 is retryable", async () => {
    behavior = { kind: "text", status: 500, body: "boom" };
    const provider = createMetaWhatsappProvider({
      token: "tok",
      phoneNumberId: "12345",
      baseUrl,
      timeoutMs: 2000
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.order_paid",
      body: "x"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });

  test("a timeout is retryable", async () => {
    behavior = { kind: "delayMs", ms: 200, body: { messages: [{ id: "m" }] } };
    const provider = createMetaWhatsappProvider({
      token: "tok",
      phoneNumberId: "12345",
      baseUrl,
      timeoutMs: 20
    });

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.order_paid",
      body: "x"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
  });
});

describe("log WhatsApp provider (Issue #108)", () => {
  test("always succeeds and never reaches the network", async () => {
    const provider = createLogWhatsappProvider();

    const result = await provider.send({
      toPhone: "+6281234567890",
      templateKey: "commerce.customer_otp",
      body: "x",
      otpCode: "654321"
    });

    expect(result.ok).toBe(true);
  });
});
