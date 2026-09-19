/**
 * Midtrans Snap adapter (Issue #110, contract #106's D3) — the first real
 * `PaymentGatewayProvider` implementation (`../domain/payment-gateway-provider.ts`).
 * Same shape `rajaongkir-provider.ts` already follows: `withTimeout` +
 * `getProviderCircuitBreaker` live HERE, in the adapter, never in
 * `application/payment-gateway-directory.ts` — that file only ever calls a
 * plain `PaymentGatewayProvider` method.
 *
 * ## Wire shape (Midtrans Snap)
 *
 * - `POST {snapBaseUrl}/snap/v1/transactions`, header
 *   `Authorization: Basic base64(ServerKey + ":")`, JSON body
 *   `{transaction_details, item_details, customer_details, expiry, callbacks}`
 *   -> `{token, redirect_url}`.
 * - `GET {statusBaseUrl}/v2/{orderId}/status`, same auth header ->
 *   `{transaction_status, fraud_status, status_code, gross_amount, order_id,
 *   transaction_id, settlement_time?}`.
 *
 * `snapBaseUrl`/`statusBaseUrl` default from `isProduction`
 * (`COMMERCE_MIDTRANS_IS_PRODUCTION`) but are always env-overridable
 * (`COMMERCE_MIDTRANS_SNAP_BASE_URL`/`COMMERCE_MIDTRANS_STATUS_BASE_URL`),
 * the same "base URL is one env away" discipline `rajaongkir-provider.ts`
 * documents for its own base URL.
 *
 * ## What counts toward the circuit breaker
 *
 * Only statements about the SERVICE — a network error, a timeout, a
 * non-2xx status, an unparseable/incomplete body — never a legitimate
 * business outcome a caller must still handle itself.
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTimeout } from "../../../lib/integration/timeout";
import { mapMidtransStatus } from "../domain/gateway-status-mapping";
import { verifyMidtransSignature } from "../domain/midtrans-signature";
import type {
  PaymentGatewayCreateSessionInput,
  PaymentGatewayProvider,
  PaymentGatewaySessionResult,
  PaymentGatewayStatusResult,
  PaymentGatewayWebhookInput,
  PaymentGatewayWebhookResult
} from "../domain/payment-gateway-provider";

const PROVIDER_KEY = "commerce-midtrans";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_EXPIRY_MINUTES = 60;
const SNAP_BASE_URL_PRODUCTION = "https://app.midtrans.com";
const SNAP_BASE_URL_SANDBOX = "https://app.sandbox.midtrans.com";
const STATUS_BASE_URL_PRODUCTION = "https://api.midtrans.com";
const STATUS_BASE_URL_SANDBOX = "https://api.sandbox.midtrans.com";
const MAX_ITEM_NAME_LENGTH = 50; // Midtrans's own documented item_details.name limit.

export type MidtransProviderConfig = {
  serverKey: string;
  isProduction: boolean;
  /** Override for tests/dev only. */
  snapBaseUrl?: string;
  /** Override for tests/dev only. */
  statusBaseUrl?: string;
  timeoutMs?: number;
  expiryMinutes?: number;
  /** `callbacks.finish` — where Snap redirects the shopper back to after paying. */
  finishUrl?: string;
};

type SnapCreateTransactionResponse = {
  token?: string;
  redirect_url?: string;
};

type MidtransStatusResponse = {
  transaction_status?: string;
  fraud_status?: string | null;
  status_code?: string;
  gross_amount?: string;
  order_id?: string;
  transaction_id?: string;
  settlement_time?: string;
};

export class PaymentGatewayProviderCallFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentGatewayProviderCallFailedError";
  }
}

function buildAuthorizationHeader(serverKey: string): string {
  return `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`;
}

export function createMidtransProvider(
  config: MidtransProviderConfig
): PaymentGatewayProvider {
  const snapBaseUrl =
    config.snapBaseUrl ??
    (config.isProduction ? SNAP_BASE_URL_PRODUCTION : SNAP_BASE_URL_SANDBOX);
  const statusBaseUrl =
    config.statusBaseUrl ??
    (config.isProduction
      ? STATUS_BASE_URL_PRODUCTION
      : STATUS_BASE_URL_SANDBOX);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expiryMinutes = config.expiryMinutes ?? DEFAULT_EXPIRY_MINUTES;
  const authorization = buildAuthorizationHeader(config.serverKey);
  const breaker = getProviderCircuitBreaker(PROVIDER_KEY);

  async function guardedFetch(
    label: string,
    request: () => Promise<Response>
  ): Promise<Response> {
    const now = new Date();

    if (!breaker.canAttempt(now)) {
      throw new PaymentGatewayProviderCallFailedError(
        "commerce-midtrans circuit is open."
      );
    }

    try {
      const response = await withTimeout(request(), timeoutMs, label);

      if (!response.ok) {
        breaker.recordFailure(new Date());
        throw new PaymentGatewayProviderCallFailedError(
          `Midtrans responded ${response.status} for "${label}".`
        );
      }

      breaker.recordSuccess(new Date());
      return response;
    } catch (error) {
      if (!(error instanceof PaymentGatewayProviderCallFailedError)) {
        breaker.recordFailure(new Date());
      }
      throw error;
    }
  }

  return {
    async createSession(
      input: PaymentGatewayCreateSessionInput
    ): Promise<PaymentGatewaySessionResult> {
      const orderId = `${input.orderCode}-${input.attempt}`;
      const grossAmount = Number.parseFloat(input.grossAmount);

      const response = await guardedFetch("midtrans.createSession", () =>
        fetch(`${snapBaseUrl}/snap/v1/transactions`, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            accept: "application/json"
          },
          body: JSON.stringify({
            transaction_details: {
              order_id: orderId,
              gross_amount: grossAmount
            },
            item_details: [
              {
                id: orderId,
                price: grossAmount,
                quantity: 1,
                name: `Pesanan ${input.orderCode}`.slice(
                  0,
                  MAX_ITEM_NAME_LENGTH
                )
              }
            ],
            customer_details: {
              first_name: input.customerName,
              phone: input.customerPhone,
              ...(input.customerEmail ? { email: input.customerEmail } : {})
            },
            expiry: { unit: "minutes", duration: expiryMinutes },
            callbacks: config.finishUrl
              ? { finish: config.finishUrl }
              : undefined
          })
        })
      );

      let body: SnapCreateTransactionResponse;
      try {
        body = (await response.json()) as SnapCreateTransactionResponse;
      } catch {
        throw new PaymentGatewayProviderCallFailedError(
          "Midtrans createSession returned an unparseable body."
        );
      }

      if (!body.token || !body.redirect_url) {
        throw new PaymentGatewayProviderCallFailedError(
          "Midtrans createSession response is missing token/redirect_url."
        );
      }

      return {
        providerRef: orderId,
        redirectUrl: body.redirect_url,
        expiresAt: new Date(Date.now() + expiryMinutes * 60_000)
      };
    },

    async fetchStatus(
      providerRef: string
    ): Promise<PaymentGatewayStatusResult> {
      const response = await guardedFetch("midtrans.fetchStatus", () =>
        fetch(`${statusBaseUrl}/v2/${encodeURIComponent(providerRef)}/status`, {
          headers: { authorization, accept: "application/json" }
        })
      );

      let body: MidtransStatusResponse;
      try {
        body = (await response.json()) as MidtransStatusResponse;
      } catch {
        throw new PaymentGatewayProviderCallFailedError(
          "Midtrans fetchStatus returned an unparseable body."
        );
      }

      return {
        status: mapMidtransStatus(
          body.transaction_status ?? "pending",
          body.fraud_status ?? null
        ),
        raw: body
      };
    },

    async verifyWebhook(
      input: PaymentGatewayWebhookInput
    ): Promise<PaymentGatewayWebhookResult> {
      const ok = verifyMidtransSignature({
        orderId: input.orderId,
        statusCode: input.statusCode,
        grossAmount: input.grossAmount,
        serverKey: config.serverKey,
        signatureKey: input.signatureKey
      });

      return {
        ok,
        eventKey: `${input.orderId}:${input.statusCode}`,
        providerRef: input.orderId,
        status: mapMidtransStatus(input.transactionStatus, input.fraudStatus)
      };
    }
  };
}
