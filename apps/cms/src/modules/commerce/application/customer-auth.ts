/**
 * OTP request/verify orchestration (Issue #89, contract #86/ADR-0016
 * D2/D3/D4) — the application layer the `otp/request` and `otp/verify`
 * routes call. Thin routes, all the branching lives here so it can be unit
 * tested with the store mocked (`awcms-testing`'s own convention for this
 * module — see `order-directory.ts`/`customer-account-store.ts` for the
 * sibling shape).
 *
 * ## Audit events (masked e-mail/phone only, never a code/token)
 *
 * Five events, matching Issue #89's own list exactly:
 * `commerce.customer.otp_requested` (every request, `sent` records whether
 * the channel actually queued something — the caller answers 202 either
 * way); `commerce.customer.login_failed` (every verify failure, whatever the
 * reason — OTP invalid/expired/exhausted/consumed, no account, blocked, or a
 * register attempt whose phone is already bound — the reason lives only in
 * `attributes.reason`, never in the HTTP response, mirroring
 * `consumeOtp`'s own "one generic error outside this module" rule);
 * `commerce.customer.otp_verified` (every successful verify, login or
 * register alike — the code WAS correct); `commerce.customer.
 * account_registered` (ADDITIONALLY, only when `purpose: "register"`
 * succeeded and a new account row was created); `commerce.customer.logout`
 * (own file, `application/customer-session-auth.ts`'s caller — see
 * `logout.ts`).
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { maskIdentifierValue } from "../../profile-identity/domain/identifier";
import { maskPhone, normalizePhoneNumber } from "../domain/phone-normalisation";
import {
  isWellFormedEmail,
  normalizeEmail,
  validateRegistration,
  type ValidationError
} from "../domain/customer-account-validation";
import { OTP_TTL_SECONDS } from "../domain/customer-otp";
import type {
  CustomerOtpChannel,
  CustomerOtpChannelRequest
} from "../domain/customer-otp-channel";
import {
  OTP_VERIFY_IDEMPOTENCY_KEY_PATTERN,
  deriveOtpVerifyIdentity,
  otpVerifyDigestsEqual
} from "../domain/customer-otp-idempotency";
import {
  acquireCustomerAuthLock,
  consumeOtp,
  tryCreateAccountForCustomer,
  CustomerAccountUniqueViolationError,
  findAccountByEmail,
  findAccountById,
  findAccountByPhone,
  findRecentOtpWithinResendWindow,
  issueOtp,
  issueSession,
  type CustomerAccountRecord,
  type OtpIdentifierColumn
} from "./customer-account-store";
import {
  computeOtpVerifyDigest,
  findOtpVerifyRecord,
  hashOtpVerifyIdempotencyKey,
  lockOtpVerifyKey,
  saveOtpVerifyRecord
} from "./customer-otp-verify-idempotency";
import { isWhatsappOtpChannelAvailableForTenant } from "./whatsapp-otp-channel-adapter";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE_OTP = "customer_otp";

/**
 * The full account shape `GET/PATCH /account/me` and a successful OTP verify
 * answer with (contract #86's `CustomerAccount` schema) — `email`/`phone`
 * in the clear, because this is always a self-view: the caller either just
 * proved control of the mailbox (verify) or is holding a live bearer session
 * for this very account (`me`). Never confuse this with
 * `CustomerAccountRecord` (`customer-account-store.ts`), whose `emailMasked`
 * is for contexts (audit attributes) that are NOT a self-view.
 */
export type CustomerAccountView = {
  id: string;
  name: string;
  email: string;
  phone: string;
  level: number;
  createdAt: string;
  historyFrom: string;
  /** Issue #114 (contract #106 ADR-0017 D9) — `true` when `marketing_consent_at` is non-null. */
  marketingConsent: boolean;
};

type AccountViewRow = {
  id: string;
  name: string;
  phone: string;
  email_normalized: string;
  level: number;
  created_at: Date;
  history_from: Date;
  marketing_consent_at: Date | null;
};

function toAccountView(row: AccountViewRow): CustomerAccountView {
  return {
    id: row.id,
    name: row.name,
    email: row.email_normalized,
    phone: row.phone,
    level: row.level,
    createdAt: row.created_at.toISOString(),
    historyFrom: row.history_from.toISOString(),
    marketingConsent: row.marketing_consent_at !== null
  };
}

/** `null` when the account row does not exist for this tenant — a live bearer session always resolves one (the join is 1:1, D1), so `null` here means the caller passed a stale/foreign id, never an ordinary outcome. */
export async function fetchCustomerAccountView(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<CustomerAccountView | null> {
  const rows = (await tx`
    SELECT a.id, c.name, c.phone, a.email_normalized, c.level,
           a.created_at, a.history_from, a.marketing_consent_at
    FROM awcms_commerce_customer_accounts a
    JOIN awcms_commerce_customers c ON c.id = a.customer_id
    WHERE a.tenant_id = ${tenantId} AND a.id = ${accountId}
  `) as AccountViewRow[];
  return rows[0] ? toAccountView(rows[0]) : null;
}

export type OtpPurpose = "login" | "register";
export type OtpVia = "email" | "whatsapp";

export type RequestCustomerOtpInput = {
  email: unknown;
  purpose: unknown;
  name?: unknown;
  phone?: unknown;
  /** Issue #108, contract #106/ADR-0017 D5. Defaults to `"email"` when absent — a caller from before this issue never sent it and keeps getting the e-mail path. */
  via?: unknown;
};

export type RequestCustomerOtpOutcome =
  | { kind: "validation_error"; errors: ValidationError[] }
  /** `via: "whatsapp"` and the channel is not enabled/configured — a CONFIGURATION fact, not an identifier-existence oracle (ADR-0017 D5). */
  | { kind: "channel_unavailable" }
  | { kind: "sent"; expiresInSeconds: number };

function validatePurpose(value: unknown): value is OtpPurpose {
  return value === "login" || value === "register";
}

/**
 * Validates the request, then ALWAYS issues a code and ALWAYS asks the
 * channel to deliver it — never a lookup first. Looking up "does this
 * e-mail have an account" before deciding whether to send would itself be
 * the enumeration oracle ADR-0016 rules out; the account-existence question
 * is answered only at VERIFY, and even there `purpose: "login"` with no
 * account is a deliberate, documented exception (D2 — "the mailbox owner
 * already received the code"). The ONE exception to "never decide anything
 * before issuing a code" is `channel_unavailable` (Issue #108): whether
 * WhatsApp is enabled/configured for this tenant's deployment is public
 * configuration, not a fact about any one shopper's identifier, so
 * answering it truthfully before touching the database is not a new
 * oracle.
 *
 * ## Why WhatsApp only ever supports `purpose: "login"`
 *
 * ADR-0017 D5 keeps registration e-mail-OTP only in this issue — the
 * account KEY stays the e-mail address (`awcms_commerce_customer_accounts.
 * email_normalized`), and `via: "whatsapp"` is a second LOGIN channel for an
 * account that already exists, resolved by phone
 * (`findAccountByPhone`) rather than by e-mail.
 */
export async function requestCustomerOtp(
  tx: Bun.SQL,
  tenantId: string,
  storeName: string,
  input: RequestCustomerOtpInput,
  channel: CustomerOtpChannel,
  correlationId?: string,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env
): Promise<RequestCustomerOtpOutcome> {
  const errors: ValidationError[] = [];

  if (!validatePurpose(input.purpose)) {
    errors.push({
      field: "purpose",
      message: 'purpose must be "login" or "register".'
    });
  }

  if (
    input.via !== undefined &&
    input.via !== "email" &&
    input.via !== "whatsapp"
  ) {
    errors.push({
      field: "via",
      message: 'via must be "email" or "whatsapp".'
    });
  }

  const via: OtpVia = input.via === "whatsapp" ? "whatsapp" : "email";

  if (via === "whatsapp" && input.purpose === "register") {
    errors.push({
      field: "via",
      message:
        'via "whatsapp" only supports purpose "login" in this release; registration is e-mail OTP only.'
    });
  }

  let emailNormalized = "";
  let phoneNormalizedForVia: string | null = null;

  if (via === "whatsapp") {
    const rawPhone = typeof input.phone === "string" ? input.phone : "";
    if (rawPhone.trim().length === 0) {
      errors.push({
        field: "phone",
        message: 'phone is required when via is "whatsapp".'
      });
    } else {
      const phoneResult = normalizePhoneNumber(rawPhone);
      if (!phoneResult.valid) {
        errors.push({
          field: "phone",
          message: "phone is not a valid Indonesian phone number."
        });
      } else {
        phoneNormalizedForVia = phoneResult.value;
      }
    }
  } else {
    const rawEmail = typeof input.email === "string" ? input.email : "";
    if (rawEmail.trim().length === 0) {
      errors.push({ field: "email", message: "email is required." });
    } else {
      const candidate = normalizeEmail(rawEmail);
      if (!isWellFormedEmail(candidate)) {
        errors.push({
          field: "email",
          message: "email is not a valid e-mail address."
        });
      } else {
        emailNormalized = candidate;
      }
    }
  }

  let registration: { name: string; phone: string } | null = null;

  // Register requires name+phone NOW, per Issue #89: "run the registration
  // validator now so the shopper gets field errors before the e-mail goes
  // out" — the same shape check `validateRegistration` already runs at
  // `createAccountForCustomer` time, just moved earlier so a malformed
  // phone/name never causes a code to be issued and mailed at all. Only
  // reachable when `via === "email"` (a `whatsapp`+`register` combination
  // already failed validation above).
  if (input.purpose === "register" && via === "email") {
    const rawEmail = typeof input.email === "string" ? input.email : "";
    const registrationResult = validateRegistration({
      name: input.name,
      phone: input.phone,
      email: rawEmail
    });
    if (!registrationResult.valid) {
      errors.push(...registrationResult.errors);
    } else {
      registration = {
        name: registrationResult.value.name,
        phone: registrationResult.value.phone
      };
      // `validateRegistration` re-derives `emailNormalized` from the same
      // `rawEmail` this function already validated above — reuse ITS value
      // so the two validations can never disagree on what "normalized"
      // means for this one request.
      emailNormalized = registrationResult.value.emailNormalized;
    }
  }

  if (errors.length > 0) {
    return { kind: "validation_error", errors };
  }

  const purpose = input.purpose as OtpPurpose;

  if (
    via === "whatsapp" &&
    !(await isWhatsappOtpChannelAvailableForTenant(tx, tenantId, env))
  ) {
    return { kind: "channel_unavailable" };
  }

  const identifierColumn: OtpIdentifierColumn =
    via === "whatsapp" ? "phone_normalized" : "email_normalized";
  const identifierValue =
    via === "whatsapp" ? phoneNormalizedForVia! : emailNormalized;

  // Issue #513 — resend window. A second request for the SAME registration
  // while the previous code is less than a minute old (a double tap, a retry,
  // two tabs) is a no-op success: the live code stays valid, no second message
  // goes out and nothing is superseded. The lookup takes an advisory lock that
  // lives until this transaction ends, so two simultaneous requests are decided
  // one after the other, not both as "first". The response is identical either
  // way (anti-enumeration), with the live code's own remaining lifetime.
  const recent = await findRecentOtpWithinResendWindow(
    tx,
    tenantId,
    identifierValue,
    purpose,
    registration,
    now,
    identifierColumn
  );
  if (recent) {
    return {
      kind: "sent",
      expiresInSeconds: Math.max(
        1,
        Math.ceil((recent.expiresAt.getTime() - now.getTime()) / 1000)
      )
    };
  }

  const issued = await issueOtp(
    tx,
    tenantId,
    identifierValue,
    purpose,
    registration,
    now,
    identifierColumn
  );

  const channelRequest: CustomerOtpChannelRequest = {
    tenantId,
    via,
    emailNormalized: via === "email" ? emailNormalized : null,
    phoneNormalized: via === "whatsapp" ? phoneNormalizedForVia : null,
    code: issued.code,
    purpose,
    expiresInMinutes: Math.round(OTP_TTL_SECONDS / 60),
    storeName,
    correlationId
  };

  const delivery = await channel.sendOtp(tx, channelRequest);

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.customer.otp_requested",
    resourceType: AUDIT_RESOURCE_TYPE_OTP,
    message: `Customer OTP requested for ${purpose} via ${via}.`,
    attributes: {
      identifierMasked:
        via === "whatsapp"
          ? maskPhone(identifierValue)
          : maskIdentifierValue(identifierValue, "email"),
      via,
      purpose,
      sent: delivery.sent
    },
    correlationId
  });

  return { kind: "sent", expiresInSeconds: OTP_TTL_SECONDS };
}

export type VerifyCustomerOtpInput = {
  email: unknown;
  /** Issue #108, contract #106/ADR-0017 D5 — the alternative identifier for a `via: "whatsapp"` login OTP. Exactly one of `email`/`phone` must be present. */
  phone?: unknown;
  code: unknown;
  purpose: unknown;
};

export type VerifyCustomerOtpOutcome =
  | { kind: "validation_error"; errors: ValidationError[] }
  | { kind: "otp_invalid" }
  | { kind: "account_not_found" }
  | { kind: "phone_already_registered" }
  | { kind: "blocked" }
  /** Issue #513 — the `Idempotency-Key` was already used (inside the replay window) by a different request. */
  | { kind: "idempotency_conflict" }
  | {
      kind: "success";
      token: string;
      expiresAt: string;
      account: CustomerAccountView;
      /** Issue #513 — `true` when this answer replays an earlier success for the same `Idempotency-Key` (a FRESH session for the same account; no token is ever read back). */
      replayed?: boolean;
    };

export type SessionMeta = {
  clientIpHash: string | null;
  userAgentSummary: string | null;
};

export type VerifyCustomerOtpOptions = {
  /** Issue #513 — the validated `Idempotency-Key` (`parseOtpVerifyIdempotencyKey`); `null`/absent = no idempotency. */
  idempotencyKey?: string | null;
};

/**
 * Verify + login/register, optionally idempotent by an `Idempotency-Key`
 * (Issue #513; storage design in `customer-otp-verify-idempotency.ts`).
 *
 * Without a key it is exactly {@link verifyCustomerOtpOnce}: the code is
 * single-use (an atomic consume), so a second verify of the same code is
 * `otp_invalid`. With a key, requests carrying it are serialised by an advisory
 * lock, and:
 *
 * - no record: run the verify; on SUCCESS record `(key hash, request digest,
 *   account id)`;
 * - a record inside the replay window with the SAME digest: skip the (already
 *   consumed) code and issue a FRESH session for the recorded account — a
 *   blocked account stays blocked;
 * - a record with a DIFFERENT digest: `idempotency_conflict`;
 * - a record outside the window: ignored (an ordinary verify, nothing written).
 *
 * Failures are never recorded, so a mistyped code can be retried under the same
 * key.
 */
export async function verifyCustomerOtp(
  tx: Bun.TransactionSQL,
  tenantId: string,
  input: VerifyCustomerOtpInput,
  sessionMeta: SessionMeta,
  correlationId?: string,
  now: Date = new Date(),
  options: VerifyCustomerOtpOptions = {}
): Promise<VerifyCustomerOtpOutcome> {
  const key = options.idempotencyKey ?? null;
  if (key === null) {
    return verifyCustomerOtpOnce(
      tx,
      tenantId,
      input,
      sessionMeta,
      correlationId,
      now
    );
  }

  if (!OTP_VERIFY_IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new TypeError("idempotencyKey must be a validated key.");
  }

  const identity = deriveOtpVerifyIdentity(input);
  if (!identity) {
    // A request the verifier answers with `validation_error`: no code is
    // consumed, so there is nothing to record or replay.
    return verifyCustomerOtpOnce(
      tx,
      tenantId,
      input,
      sessionMeta,
      correlationId,
      now
    );
  }

  const keyHash = hashOtpVerifyIdempotencyKey(key);
  const requestHash = computeOtpVerifyDigest(identity);
  await lockOtpVerifyKey(tx, tenantId, keyHash);
  const record = await findOtpVerifyRecord(tx, tenantId, keyHash);

  if (record.state === "fresh") {
    if (!otpVerifyDigestsEqual(record.requestHash, requestHash)) {
      return { kind: "idempotency_conflict" };
    }

    const account = record.accountId
      ? await findAccountById(tx, tenantId, record.accountId)
      : null;
    if (account) {
      const identifierMasked =
        identity.identifierColumn === "phone_normalized"
          ? maskPhone(identity.identifierValue)
          : maskIdentifierValue(identity.identifierValue, "email");

      if (account.status === "blocked") {
        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: AUDIT_MODULE_KEY,
          action: "commerce.customer.login_failed",
          resourceType: AUDIT_RESOURCE_TYPE_OTP,
          message: `Customer OTP verification failed for ${identity.purpose}.`,
          attributes: {
            identifierMasked,
            purpose: identity.purpose,
            reason: "blocked"
          },
          correlationId
        });
        return { kind: "blocked" };
      }

      // One low-noise event per replay; never the key, the code or a token.
      await recordAuditEvent(tx, {
        tenantId,
        moduleKey: AUDIT_MODULE_KEY,
        action: "commerce.customer.otp_verify_replayed",
        resourceType: "customer_account",
        resourceId: account.id,
        message: "Customer OTP verify replayed for an idempotency key.",
        attributes: { identifierMasked, purpose: identity.purpose },
        correlationId
      });

      const session = await issueSession(
        tx,
        tenantId,
        account.id,
        sessionMeta,
        now
      );
      return {
        kind: "success",
        token: session.token,
        expiresAt: session.expiresAt,
        account: (await fetchCustomerAccountView(tx, tenantId, account.id))!,
        replayed: true
      };
    }
    // The recorded account no longer exists: fall through to an ordinary
    // verify (the code is consumed, so it answers `otp_invalid`).
  }

  const outcome = await verifyCustomerOtpOnce(
    tx,
    tenantId,
    input,
    sessionMeta,
    correlationId,
    now
  );

  if (outcome.kind === "success" && record.state === "none") {
    await saveOtpVerifyRecord(
      tx,
      tenantId,
      keyHash,
      requestHash,
      outcome.account.id
    );
  }

  return outcome;
}

async function verifyCustomerOtpOnce(
  tx: Bun.TransactionSQL,
  tenantId: string,
  input: VerifyCustomerOtpInput,
  sessionMeta: SessionMeta,
  correlationId?: string,
  now: Date = new Date()
): Promise<VerifyCustomerOtpOutcome> {
  const errors: ValidationError[] = [];

  if (!validatePurpose(input.purpose)) {
    errors.push({
      field: "purpose",
      message: 'purpose must be "login" or "register".'
    });
  }

  const rawEmail = typeof input.email === "string" ? input.email : "";
  const rawPhone = typeof input.phone === "string" ? input.phone : "";
  const hasEmail = rawEmail.trim().length > 0;
  const hasPhone = rawPhone.trim().length > 0;

  if (!hasEmail && !hasPhone) {
    errors.push({
      field: "email",
      message: "email or phone is required."
    });
  } else if (hasEmail && hasPhone) {
    errors.push({
      field: "phone",
      message: "provide either email or phone, not both."
    });
  }

  // Phone verification only ever proves a WhatsApp LOGIN OTP (ADR-0017 D5 —
  // registration stays e-mail OTP only, so a phone-keyed row issued by
  // `requestCustomerOtp` never has `purpose: "register"` in the first
  // place).
  if (hasPhone && !hasEmail && input.purpose === "register") {
    errors.push({
      field: "phone",
      message: 'phone verification only supports purpose "login".'
    });
  }

  let emailNormalized = "";
  let phoneNormalized = "";
  const identifierColumn: OtpIdentifierColumn =
    hasPhone && !hasEmail ? "phone_normalized" : "email_normalized";

  if (identifierColumn === "phone_normalized") {
    const phoneResult = normalizePhoneNumber(rawPhone);
    if (!phoneResult.valid) {
      errors.push({
        field: "phone",
        message: "phone is not a valid Indonesian phone number."
      });
    } else {
      phoneNormalized = phoneResult.value;
    }
  } else if (hasEmail) {
    const candidate = normalizeEmail(rawEmail);
    if (!isWellFormedEmail(candidate)) {
      errors.push({
        field: "email",
        message: "email is not a valid e-mail address."
      });
    } else {
      emailNormalized = candidate;
    }
  }

  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!/^\d{6}$/.test(code)) {
    errors.push({ field: "code", message: "code must be 6 digits." });
  }

  if (errors.length > 0) {
    return { kind: "validation_error", errors };
  }

  const purpose = input.purpose as OtpPurpose;
  const identifierValue =
    identifierColumn === "phone_normalized" ? phoneNormalized : emailNormalized;
  const identifierMasked =
    identifierColumn === "phone_normalized"
      ? maskPhone(identifierValue)
      : maskIdentifierValue(identifierValue, "email");
  // Retained for the `register` branch below, which is only ever reached
  // for `identifierColumn === "email_normalized"` (phone verification never
  // allows `purpose: "register"`, validated above).
  const emailMasked = identifierMasked;

  async function auditFailure(reason: string): Promise<void> {
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "commerce.customer.login_failed",
      resourceType: AUDIT_RESOURCE_TYPE_OTP,
      message: `Customer OTP verification failed for ${purpose}.`,
      attributes: { identifierMasked, purpose, reason },
      correlationId
    });
  }

  const consumed = await consumeOtp(
    tx,
    tenantId,
    identifierValue,
    purpose,
    code,
    now,
    identifierColumn
  );

  if (!consumed.ok) {
    await auditFailure(consumed.reason);
    return { kind: "otp_invalid" };
  }

  if (identifierColumn === "phone_normalized") {
    // `via: "whatsapp"` login — the account is the one whose CUSTOMER row
    // has this phone (`findAccountByPhone`), never `findAccountByEmail`.
    const account = await findAccountByPhone(tx, tenantId, identifierValue);

    if (!account) {
      await auditFailure("account_not_found");
      return { kind: "account_not_found" };
    }

    if (account.status === "blocked") {
      await auditFailure("blocked");
      return { kind: "blocked" };
    }

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "commerce.customer.otp_verified",
      resourceType: AUDIT_RESOURCE_TYPE_OTP,
      message: "Customer OTP verified (login via whatsapp).",
      attributes: { identifierMasked, purpose },
      correlationId
    });

    const session = await issueSession(
      tx,
      tenantId,
      account.id,
      sessionMeta,
      now
    );

    return {
      kind: "success",
      token: session.token,
      expiresAt: session.expiresAt,
      account: (await fetchCustomerAccountView(tx, tenantId, account.id))!
    };
  }

  if (purpose === "login") {
    const account = await findAccountByEmail(tx, tenantId, emailNormalized);

    if (!account) {
      await auditFailure("account_not_found");
      return { kind: "account_not_found" };
    }

    if (account.status === "blocked") {
      await auditFailure("blocked");
      return { kind: "blocked" };
    }

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "commerce.customer.otp_verified",
      resourceType: AUDIT_RESOURCE_TYPE_OTP,
      message: "Customer OTP verified (login).",
      attributes: { emailMasked, purpose },
      correlationId
    });

    const session = await issueSession(
      tx,
      tenantId,
      account.id,
      sessionMeta,
      now
    );

    return {
      kind: "success",
      token: session.token,
      expiresAt: session.expiresAt,
      account: (await fetchCustomerAccountView(tx, tenantId, account.id))!
    };
  }

  // purpose === "register" — `consumeOtp` only matched a row issued with
  // `purpose: "register"`, so `consumed.otp.registration` is always present
  // here (`issueOtp` always stores it for that purpose, `requestCustomerOtp`
  // above never issues one without it).
  const registration = consumed.otp.registration!;

  const phoneResult = normalizePhoneNumber(registration.phone);
  const normalizedPhone = phoneResult.valid
    ? phoneResult.value
    : registration.phone;

  // Issue #513 — serialise registrations for this e-mail and this phone, always
  // in the same order (e-mail, then phone) so two registrations can never wait
  // on each other. The checks below are then decided one after the other: the
  // loser of a race finds the winner's committed account and resolves to a
  // login or to PHONE_ALREADY_REGISTERED instead of colliding on a unique index.
  await acquireCustomerAuthLock(
    tx,
    tenantId,
    "register-email",
    emailNormalized
  );
  await acquireCustomerAuthLock(
    tx,
    tenantId,
    "register-phone",
    normalizedPhone
  );

  // The verified e-mail already owns an account: the shopper proved control of
  // that mailbox, so this is a login under a different button, not a second
  // account (the (tenant, email) unique index would refuse one anyway). Never
  // PHONE_ALREADY_REGISTERED, whatever phone the form carried.
  async function loginAsExistingAccount(
    existing: CustomerAccountRecord
  ): Promise<VerifyCustomerOtpOutcome> {
    if (existing.status === "blocked") {
      await auditFailure("blocked");
      return { kind: "blocked" };
    }

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "commerce.customer.otp_verified",
      resourceType: AUDIT_RESOURCE_TYPE_OTP,
      message:
        "Customer OTP verified (register on an existing account — treated as login).",
      attributes: { emailMasked, purpose },
      correlationId
    });

    const existingSession = await issueSession(
      tx,
      tenantId,
      existing.id,
      sessionMeta,
      now
    );

    return {
      kind: "success",
      token: existingSession.token,
      expiresAt: existingSession.expiresAt,
      account: (await fetchCustomerAccountView(tx, tenantId, existing.id))!
    };
  }

  const accountByEmail = await findAccountByEmail(
    tx,
    tenantId,
    emailNormalized
  );
  if (accountByEmail) return loginAsExistingAccount(accountByEmail);

  const existingAccount = await findAccountByPhone(
    tx,
    tenantId,
    normalizedPhone
  );

  if (existingAccount) {
    await auditFailure("phone_already_registered");
    return { kind: "phone_already_registered" };
  }

  const created = await tryCreateAccountForCustomer(
    tx,
    tenantId,
    {
      name: registration.name,
      phone: normalizedPhone,
      emailNormalized
    },
    correlationId
  );
  if (!created.ok) {
    // Defence in depth behind the locks above (another writer of this table
    // that does not take them): the unique index refused the INSERT, so the
    // account exists now. Resolve to it - the same person's e-mail is a login,
    // a phone that belongs to someone else's account is the real conflict.
    const winnerByEmail = await findAccountByEmail(
      tx,
      tenantId,
      emailNormalized
    );
    if (winnerByEmail) return loginAsExistingAccount(winnerByEmail);
    if (await findAccountByPhone(tx, tenantId, normalizedPhone)) {
      await auditFailure("phone_already_registered");
      return { kind: "phone_already_registered" };
    }
    throw new CustomerAccountUniqueViolationError(created.constraint);
  }
  const account = created.account;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.customer.otp_verified",
    resourceType: AUDIT_RESOURCE_TYPE_OTP,
    message: "Customer OTP verified (register).",
    attributes: { emailMasked, purpose },
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "commerce.customer.account_registered",
    resourceType: "customer_account",
    resourceId: account.id,
    message: "Customer account registered via e-mail OTP.",
    attributes: { emailMasked, phoneMasked: maskPhone(normalizedPhone) },
    correlationId
  });

  const session = await issueSession(
    tx,
    tenantId,
    account.id,
    sessionMeta,
    now
  );

  return {
    kind: "success",
    token: session.token,
    expiresAt: session.expiresAt,
    account: (await fetchCustomerAccountView(tx, tenantId, account.id))!
  };
}

export type UpdateCustomerNameOutcome =
  | { kind: "validation_error"; errors: ValidationError[] }
  | { kind: "updated"; account: CustomerAccountView };

const MAX_NAME_LENGTH = 150;
const MIN_NAME_LENGTH = 2;

/**
 * `PATCH /account/me` validates `{name}` only (Issue #89 — no e-mail/phone
 * change in this increment, D6). The name lives on
 * `awcms_commerce_customers`, not the account row itself (the account has
 * no `name` column of its own — `customer_id` is where a display name
 * already lives, one copy, shared with the guest-checkout shape).
 */
export async function updateCustomerName(
  tx: Bun.SQL,
  tenantId: string,
  account: CustomerAccountRecord,
  rawName: unknown
): Promise<UpdateCustomerNameOutcome> {
  const name = typeof rawName === "string" ? rawName.trim() : "";

  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
    return {
      kind: "validation_error",
      errors: [
        {
          field: "name",
          message: `name is required and must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters.`
        }
      ]
    };
  }

  await tx`
    UPDATE awcms_commerce_customers
    SET name = ${name}, updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${account.customerId}
  `;

  return {
    kind: "updated",
    account: (await fetchCustomerAccountView(tx, tenantId, account.id))!
  };
}

export type UpdateMarketingConsentOutcome = {
  kind: "updated";
  account: CustomerAccountView;
};

/**
 * `PATCH /account/me {marketingConsent}` (Issue #114, contract #106
 * ADR-0017 D9) — `true` sets `marketing_consent_at` to `now()`, `false`
 * clears it to `NULL`. Toggled ONLY by the account itself (never by staff —
 * this module ships no admin route that sets it for a customer). Audited on
 * BOTH grant and revoke, per this issue's own instructions — a consent
 * change is legally load-bearing (it is the ONLY thing a campaign's
 * audience resolution reads to decide reachability, `application/
 * campaign-directory.ts`), unlike a plain name edit above which records no
 * audit event at all.
 */
export async function updateMarketingConsent(
  tx: Bun.SQL,
  tenantId: string,
  account: CustomerAccountRecord,
  consent: boolean,
  correlationId?: string
): Promise<UpdateMarketingConsentOutcome> {
  await tx`
    UPDATE awcms_commerce_customer_accounts
    SET marketing_consent_at = CASE WHEN ${consent} THEN now() ELSE NULL END,
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${account.id}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: "customer_marketing_consent",
    resourceId: account.id,
    message: consent
      ? "Customer granted marketing consent."
      : "Customer revoked marketing consent.",
    attributes: { accountId: account.id, consent },
    correlationId
  });

  return {
    kind: "updated",
    account: (await fetchCustomerAccountView(tx, tenantId, account.id))!
  };
}
