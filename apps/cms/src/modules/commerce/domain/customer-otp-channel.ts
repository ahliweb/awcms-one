/**
 * `CustomerOtpChannel` — the delivery port an OTP request is handed to
 * (Issue #89, contract #86/ADR-0016 D2). Pure interface, no I/O, no
 * imports — the same "port lives beside its consumer, adapter lives beside
 * its provider" split `_shared/ports/auth-notification-port.ts` already
 * established for the staff auth surface.
 *
 * Two adapters exist today (`application/customer-otp-channel-adapters.ts`):
 * `email` (the real path — enqueues into the `email` module's outbox inside
 * the SAME transaction as the OTP row) and `log` (writes a structured log
 * line instead, selected whenever `EMAIL_PROVIDER=log` or `EMAIL_ENABLED`
 * is not `"true"`, so a deployment/dev box/CI run with no mail credentials
 * can still exercise the whole OTP flow). A WhatsApp adapter is a follow-up
 * under #33 (ADR-0016 D2) — not built here.
 */
export type CustomerOtpChannelRequest = {
  tenantId: string;
  /** Already normalised (`lower(btrim(...))`) — see `domain/customer-account-validation.ts`. */
  emailNormalized: string;
  /** The 6-digit code itself. NEVER logged in full by the `email` adapter (it only reaches the outbox row, never a log line); the `log` adapter's whole reason to exist is printing it for a developer who has no other way to read it. */
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
