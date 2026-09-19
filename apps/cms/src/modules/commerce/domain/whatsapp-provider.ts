/**
 * Provider-neutral WhatsApp service contract (Issue #108, contract
 * #106/ADR-0017 D5). Pure types only — no implementation here.
 * `WhatsappProvider` is the port; `fonnte-provider.ts`, `meta-whatsapp-
 * provider.ts` and `log-whatsapp-provider.ts` (`../infrastructure/`) all
 * implement it, resolved to a concrete implementation by
 * `../infrastructure/whatsapp-provider-resolver.ts` and never imported by
 * name anywhere else. Mirrors `email/domain/email-provider-contract.ts`
 * exactly (ADR-0017 D1 — every external provider is a port + adapters
 * inside `commerce`, modelled on `email`).
 *
 * Callers build a `WhatsappMessage`, enqueue it
 * (`application/whatsapp-enqueue.ts`'s outbox row), and a separate
 * dispatcher (`application/whatsapp-dispatch.ts`) calls
 * `WhatsappProvider.send` OUTSIDE any DB transaction — ADR-0006's rule,
 * unchanged for this second provider family.
 */

export type WhatsappMessage = {
  /** E.164 (`+62…`, `domain/phone-normalisation.ts`). */
  toPhone: string;
  /** `commerce.customer_otp` / `commerce.order_paid` / `commerce.campaign` — see `whatsapp-templates.ts`. */
  templateKey: string;
  /** The already-rendered body (`whatsapp-templates.ts#renderWhatsappTemplate`) — Fonnte and Meta's free-text path both send this verbatim. */
  body: string;
  /**
   * Present only for `commerce.customer_otp` — the raw 6-digit code, used
   * ONLY by the Meta adapter to fill the OTP template's body parameter
   * (`{{1}}`, Meta's own template-message shape). Fonnte has no separate
   * template concept and sends `body` as free text regardless.
   */
  otpCode?: string;
  correlationId?: string;
};

export type WhatsappDeliveryResult =
  | { ok: true; providerMessageId?: string }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      /**
       * Same "no attempt reached the provider at all" signal
       * `EmailDeliveryResult.skipped` already carries (finding D6) — set
       * when the circuit breaker is open. The dispatcher must not record a
       * delivery attempt or spend a retry for a message that was never
       * tried.
       */
      skipped?: true;
    };

export type WhatsappHealthCheckResult =
  { ok: true } | { ok: false; error: string };

/**
 * The port. `retryable` tells the dispatcher whether to retry
 * (`queued` with backoff) or move straight to terminal `failed` — a 4xx
 * from either provider is a permanent rejection of THIS message (bad
 * number, bad template, bad payload); a timeout/429/5xx is a statement
 * about the SERVICE and is retryable. Only the ADAPTER feeds the circuit
 * breaker, for the same reason `email-provider-contract.ts` states: a
 * per-message business rejection must never trip it.
 */
export type WhatsappProvider = {
  send(message: WhatsappMessage): Promise<WhatsappDeliveryResult>;
  healthCheck(): Promise<WhatsappHealthCheckResult>;
};
