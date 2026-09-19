/**
 * Meta WhatsApp Cloud API adapter (Issue #108, contract #106/ADR-0017 D5).
 *
 * `POST https://graph.facebook.com/v20.0/{phoneNumberId}/messages`,
 * `Authorization: Bearer <token>`, JSON body. Two shapes:
 *
 * - `message.otpCode` present (the `commerce.customer_otp` template) — a
 *   TEMPLATE message: `{messaging_product:"whatsapp", to, type:"template",
 *   template:{name, language:{code:"id"}, components:[{type:"body",
 *   parameters:[{type:"text", text: code}]}]}}`. The template NAME comes
 *   from `COMMERCE_META_WA_OTP_TEMPLATE` (an operator-approved Meta
 *   template, not this codebase's own body string) — Meta rejects an
 *   unapproved template outright, which is exactly why OTP delivery through
 *   this provider needs one configured at all.
 * - Otherwise — a free TEXT message: `{type:"text", text:{body}}`, using
 *   `message.body` (already rendered by `whatsapp-templates.ts`) verbatim.
 *
 * Success response: `{messages:[{id}]}`. 4xx = permanent (bad number,
 * unapproved template, malformed payload); 429/5xx/timeout = retryable.
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTimeout } from "../../../lib/integration/timeout";
import type {
  WhatsappDeliveryResult,
  WhatsappHealthCheckResult,
  WhatsappMessage,
  WhatsappProvider
} from "../domain/whatsapp-provider";

const PROVIDER_KEY = "commerce-whatsapp-meta";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const DEFAULT_BASE_URL = "https://graph.facebook.com/v20.0";
const DEFAULT_TEMPLATE_LANGUAGE_CODE = "id";

export type MetaWhatsappProviderConfig = {
  token: string;
  phoneNumberId: string;
  /** The Meta-approved template name for `commerce.customer_otp` (`COMMERCE_META_WA_OTP_TEMPLATE`). Required only for OTP sends — a free-text send never reads this. */
  otpTemplateName?: string;
  /** Override for tests/dev only — a local fake HTTP server standing in for the Graph API. */
  baseUrl?: string;
  timeoutMs?: number;
};

type MetaSendResponse = {
  messages?: { id?: string }[];
  error?: { message?: string; type?: string; code?: number };
};

function truncate(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : message;
}

/** Meta's `to` field: E.164 without the leading `+`. */
function toMetaRecipient(e164Phone: string): string {
  return e164Phone.startsWith("+") ? e164Phone.slice(1) : e164Phone;
}

type BuildPayloadResult =
  { ok: true; payload: Record<string, unknown> } | { ok: false; error: string };

function buildPayload(
  message: WhatsappMessage,
  otpTemplateName: string | undefined
): BuildPayloadResult {
  const to = toMetaRecipient(message.toPhone);

  if (message.otpCode !== undefined) {
    if (!otpTemplateName) {
      return {
        ok: false,
        error:
          "COMMERCE_META_WA_OTP_TEMPLATE is not configured; cannot send an OTP template message."
      };
    }

    return {
      ok: true,
      payload: {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: otpTemplateName,
          language: { code: DEFAULT_TEMPLATE_LANGUAGE_CODE },
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: message.otpCode }]
            }
          ]
        }
      }
    };
  }

  return {
    ok: true,
    payload: {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message.body }
    }
  };
}

export function createMetaWhatsappProvider(
  config: MetaWhatsappProviderConfig
): WhatsappProvider {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const breaker = getProviderCircuitBreaker(PROVIDER_KEY);

  async function callSend(
    payload: Record<string, unknown>
  ): Promise<{ response: Response; rawBody: string }> {
    const response = await withTimeout(
      fetch(`${baseUrl}/${config.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }),
      timeoutMs,
      "meta whatsapp send"
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
          error: "Meta WhatsApp circuit breaker is open; no attempt was made.",
          retryable: true,
          skipped: true
        };
      }

      const built = buildPayload(message, config.otpTemplateName);

      if (!built.ok) {
        // A deployment's own misconfiguration (no template name) — never a
        // statement about Meta's service, so the breaker is untouched.
        return { ok: false, error: built.error, retryable: false };
      }

      try {
        const { response, rawBody } = await callSend(built.payload);

        let parsed: MetaSendResponse = {};

        try {
          parsed = rawBody ? (JSON.parse(rawBody) as MetaSendResponse) : {};
        } catch {
          if (!response.ok) {
            if (response.status === 429 || response.status >= 500) {
              breaker.recordFailure(attemptedAt);
            }
            return {
              ok: false,
              error: truncate(`Meta API returned HTTP ${response.status}`),
              retryable: response.status === 429 || response.status >= 500
            };
          }
          breaker.recordFailure(attemptedAt);
          return {
            ok: false,
            error: "Meta API returned a non-JSON response.",
            retryable: true
          };
        }

        if (!response.ok) {
          // 429/5xx are statements about the service; every other 4xx (bad
          // number, unapproved template, malformed payload) is about THIS
          // message.
          if (response.status === 429 || response.status >= 500) {
            breaker.recordFailure(attemptedAt);
          }

          return {
            ok: false,
            error: truncate(
              parsed.error?.message ??
                `Meta API returned HTTP ${response.status}`
            ),
            retryable: response.status === 429 || response.status >= 500
          };
        }

        breaker.recordSuccess(attemptedAt);
        return {
          ok: true,
          providerMessageId: parsed.messages?.[0]?.id
        };
      } catch (error) {
        breaker.recordFailure(attemptedAt);
        const messageText =
          error instanceof Error ? error.message : String(error);
        return { ok: false, error: truncate(messageText), retryable: true };
      }
    },

    /** A minimal, harmless read against the phone number id — never sends a real message. A bad token/phone number id answers 401/404; a down server answers 5xx/timeout. */
    async healthCheck(): Promise<WhatsappHealthCheckResult> {
      try {
        const response = await withTimeout(
          fetch(`${baseUrl}/${config.phoneNumberId}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${config.token}` }
          }),
          timeoutMs,
          "meta whatsapp health check"
        );

        if (!response.ok) {
          const rawBody = await response.text().catch(() => "");
          return {
            ok: false,
            error: truncate(
              `Meta API returned HTTP ${response.status}${rawBody ? `: ${rawBody}` : ""}`
            )
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
