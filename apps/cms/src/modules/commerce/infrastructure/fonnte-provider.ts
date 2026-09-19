/**
 * Fonnte adapter (Issue #108, contract #106/ADR-0017 D5) — the first real
 * `WhatsappProvider` implementation (`../domain/whatsapp-provider.ts`).
 *
 * `POST {baseUrl}/send`, header `Authorization: <token>` (no `Bearer`
 * prefix — Fonnte's own convention), form body `target`/`message`. JSON
 * response `{status: true|false, reason?, id?}`. `target` takes the phone
 * WITHOUT the leading `+` (Fonnte's documented shape is `62812…`) — this
 * adapter strips it from the already-E.164 `toPhone`.
 *
 * One send = one recipient, same "one row = one delivery unit" shape
 * `awcms_commerce_whatsapp_messages` already uses (mirrors
 * `mailketing-provider.ts`'s own comment).
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTimeout } from "../../../lib/integration/timeout";
import type {
  WhatsappDeliveryResult,
  WhatsappHealthCheckResult,
  WhatsappMessage,
  WhatsappProvider
} from "../domain/whatsapp-provider";

const PROVIDER_KEY = "commerce-whatsapp-fonnte";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const DEFAULT_BASE_URL = "https://api.fonnte.com";

export type FonnteProviderConfig = {
  token: string;
  /** Override for tests/dev only — a local fake HTTP server standing in for Fonnte. Always from configuration, never request input (SSRF-safe, same convention as `mailketing-provider.ts`'s `baseUrl`). */
  baseUrl?: string;
  timeoutMs?: number;
};

type FonnteSendResponse = {
  status?: boolean;
  reason?: string;
  id?: string | string[];
};

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;
}

/** Fonnte's `target` field: E.164 without the leading `+` (`62812…`). */
function toFonnteTarget(e164Phone: string): string {
  return e164Phone.startsWith("+") ? e164Phone.slice(1) : e164Phone;
}

export function createFonnteWhatsappProvider(
  config: FonnteProviderConfig
): WhatsappProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const breaker = getProviderCircuitBreaker(PROVIDER_KEY);

  async function callSend(
    formData: URLSearchParams
  ): Promise<{ response: Response; rawBody: string }> {
    const response = await withTimeout(
      fetch(`${baseUrl}/send`, {
        method: "POST",
        headers: {
          Authorization: config.token,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: formData.toString()
      }),
      timeoutMs,
      "fonnte send"
    );
    const rawBody = await response.text().catch(() => "");

    return { response, rawBody };
  }

  return {
    async send(message: WhatsappMessage): Promise<WhatsappDeliveryResult> {
      const attemptedAt = new Date();

      if (!breaker.canAttempt(attemptedAt)) {
        return {
          ok: false,
          error: "Fonnte circuit breaker is open; no attempt was made.",
          retryable: true,
          skipped: true
        };
      }

      const formData = new URLSearchParams({
        target: toFonnteTarget(message.toPhone),
        message: message.body
      });

      try {
        const { response, rawBody } = await callSend(formData);

        // 4xx (except 429) is a permanent rejection of THIS request — bad
        // token, bad payload shape; 429/5xx are statements about the
        // service.
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            breaker.recordFailure(attemptedAt);
          }

          return {
            ok: false,
            error: truncate(
              `Fonnte API returned HTTP ${response.status}${rawBody ? `: ${rawBody}` : ""}`
            ),
            retryable: response.status === 429 || response.status >= 500
          };
        }

        let parsed: FonnteSendResponse = {};

        try {
          parsed = JSON.parse(rawBody) as FonnteSendResponse;
        } catch {
          breaker.recordFailure(attemptedAt);
          return {
            ok: false,
            error: "Fonnte API returned a non-JSON response.",
            retryable: true
          };
        }

        if (parsed.status !== true) {
          // Answered, in time, with a well-formed body — it is up. It just
          // refused THIS message (bad number, quota, etc.) — never feeds
          // the breaker, same split `mailketing-provider.ts` draws.
          return {
            ok: false,
            error: truncate(parsed.reason ?? "Unknown error from Fonnte"),
            retryable: false
          };
        }

        breaker.recordSuccess(attemptedAt);
        const providerMessageId = Array.isArray(parsed.id)
          ? parsed.id[0]
          : parsed.id;
        return { ok: true, providerMessageId };
      } catch (error) {
        breaker.recordFailure(attemptedAt);
        const messageText =
          error instanceof Error ? error.message : String(error);
        return { ok: false, error: truncate(messageText), retryable: true };
      }
    },

    /** Probes with an empty target — a valid token gets a field-validation error, an invalid token gets an auth error, a down server returns 5xx/timeout. Never sends a real message. */
    async healthCheck(): Promise<WhatsappHealthCheckResult> {
      const formData = new URLSearchParams({ target: "", message: "" });

      try {
        const { response, rawBody } = await callSend(formData);

        if (response.status >= 500) {
          return {
            ok: false,
            error: truncate(`Fonnte API server error (HTTP ${response.status})`)
          };
        }

        let parsed: FonnteSendResponse = {};

        try {
          parsed = JSON.parse(rawBody) as FonnteSendResponse;
        } catch {
          /* non-JSON body on a non-5xx status is still an accepted token */
        }

        if (
          parsed.status === false &&
          parsed.reason &&
          /token|auth/i.test(parsed.reason)
        ) {
          return {
            ok: false,
            error: truncate(`Invalid token: ${parsed.reason}`)
          };
        }

        return { ok: true };
      } catch (error) {
        const messageText =
          error instanceof Error ? error.message : String(error);
        return { ok: false, error: truncate(messageText) };
      }
    }
  };
}
