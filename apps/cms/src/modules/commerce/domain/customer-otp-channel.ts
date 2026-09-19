/**
 * `CustomerOtpChannel` — the delivery port an OTP request is handed to
 * (Issue #89, contract #86/ADR-0016 D2; extended to a third channel by
 * Issue #108, contract #106/ADR-0017 D5). Pure interface, no I/O, no
 * imports — the same "port lives beside its consumer, adapter lives beside
 * its provider" split `_shared/ports/auth-notification-port.ts` already
 * established for the staff auth surface.
 *
 * Four adapters exist today: `email` and its `log` counterpart
 * (`application/customer-otp-channel-adapters.ts` — enqueues into the
 * `email` module's outbox inside the SAME transaction as the OTP row, or
 * writes a structured log line instead, selected whenever
 * `EMAIL_PROVIDER=log` or `EMAIL_ENABLED` is not `"true"`), and `whatsapp`
 * and its own `log` counterpart (`application/whatsapp-otp-channel-
 * adapter.ts` — enqueues into `awcms_commerce_whatsapp_messages` inside the
 * SAME transaction, or logs the code, selected whenever
 * `COMMERCE_WHATSAPP_ENABLED` is not `"true"` or `COMMERCE_WHATSAPP_
 * PROVIDER=log`). `via` on the request tells a caller which one it is
 * holding; `emailNormalized`/`phoneNormalized` are populated according to
 * which identifier the request actually used — see
 * `application/customer-auth.ts#requestCustomerOtp`.
 */
export type CustomerOtpChannelRequest = {
  tenantId: string;
  via: "email" | "whatsapp";
  /** Already normalised (`lower(btrim(...))`) — see `domain/customer-account-validation.ts`. Present only when `via: "email"`. */
  emailNormalized: string | null;
  /** E.164 (`domain/phone-normalisation.ts`). Present only when `via: "whatsapp"`. */
  phoneNormalized: string | null;
  /** The 6-digit code itself. NEVER logged in full by a real-provider adapter (it only reaches the outbox row, never a log line); each channel's own `log` adapter is the ONE place that prints it, for a developer who has no other way to read it. */
  code: string;
  purpose: "login" | "register";
  expiresInMinutes: number;
  storeName: string;
  correlationId?: string;
};

export type CustomerOtpChannelResult = {
  /** `false` when the tenant has no active template for the derived category, or the address is suppressed (the `email` adapter only) — the caller still answers `202` either way (ADR-0016's anti-enumeration rule); this is for the audit trail, not the HTTP response. */
  sent: boolean;
};

export type CustomerOtpChannel = {
  sendOtp(
    tx: Bun.SQL,
    request: CustomerOtpChannelRequest
  ): Promise<CustomerOtpChannelResult>;
};
