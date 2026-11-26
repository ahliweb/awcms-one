/**
 * The fresh proof of control a shopper's data-subject request needs on top of
 * the bearer session (Issue #529, ADR-0055 D3): a one-time code mailed to the
 * ACCOUNT'S e-mail address, under its own purpose (`subject_export` or
 * `subject_erasure`) so a login code can never authorise an erasure.
 *
 * It reuses the sign-in OTP machinery unchanged: `issueOtp` (supersedes any
 * earlier code), `findRecentOtpWithinResendWindow` (a double tap does not mail
 * twice), the same e-mail channel and `consumeOtp` (one `UPDATE ... RETURNING`,
 * five attempts, single use). Unlike the sign-in request there is no
 * enumeration question: the caller already holds a live bearer session for this
 * very account, so the address is looked up, not guessed.
 *
 * `consumeSubjectOtp` collapses every failure to one boolean; the route answers
 * one generic `OTP_INVALID` whatever the reason (ADR-0016's rule).
 */
import { maskIdentifierValue } from "../../profile-identity/domain/identifier";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  consumeOtp,
  findRecentOtpWithinResendWindow,
  issueOtp
} from "./customer-account-store";
import type { CustomerOtpChannel } from "../domain/customer-otp-channel";
import { OTP_TTL_SECONDS } from "../domain/customer-otp";
import {
  SUBJECT_OTP_PURPOSES,
  type SubjectRequestType
} from "../domain/customer-subject-policy";

async function accountEmail(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<string | null> {
  const rows = (await tx`
    SELECT email_normalized FROM awcms_commerce_customer_accounts
    WHERE tenant_id = ${tenantId} AND id = ${accountId} AND erased_at IS NULL
  `) as { email_normalized: string }[];
  return rows[0]?.email_normalized ?? null;
}

export type RequestSubjectOtpOutcome =
  { kind: "no_account" } | { kind: "sent"; expiresInSeconds: number };

export async function requestSubjectOtp(
  tx: Bun.SQL,
  tenantId: string,
  storeName: string,
  accountId: string,
  requestType: SubjectRequestType,
  channel: CustomerOtpChannel,
  correlationId?: string,
  now: Date = new Date()
): Promise<RequestSubjectOtpOutcome> {
  const email = await accountEmail(tx, tenantId, accountId);
  if (!email) return { kind: "no_account" };

  const purpose = SUBJECT_OTP_PURPOSES[requestType];

  const recent = await findRecentOtpWithinResendWindow(
    tx,
    tenantId,
    email,
    purpose,
    null,
    now,
    "email_normalized"
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
    email,
    purpose,
    null,
    now,
    "email_normalized"
  );

  const delivery = await channel.sendOtp(tx, {
    tenantId,
    via: "email",
    emailNormalized: email,
    phoneNormalized: null,
    code: issued.code,
    purpose,
    expiresInMinutes: Math.round(OTP_TTL_SECONDS / 60),
    storeName,
    correlationId
  });

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: "commerce",
    action: "commerce.customer.otp_requested",
    resourceType: "customer_otp",
    message: `Customer OTP requested for ${purpose} via email.`,
    attributes: {
      identifierMasked: maskIdentifierValue(email, "email"),
      via: "email",
      purpose,
      sent: delivery.sent
    },
    correlationId
  });

  return { kind: "sent", expiresInSeconds: OTP_TTL_SECONDS };
}

/** `true` only for a correct, live, unconsumed code of THIS purpose for THIS account. */
export async function consumeSubjectOtp(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  requestType: SubjectRequestType,
  code: string,
  now: Date = new Date()
): Promise<boolean> {
  const email = await accountEmail(tx, tenantId, accountId);
  if (!email) return false;
  const result = await consumeOtp(
    tx,
    tenantId,
    email,
    SUBJECT_OTP_PURPOSES[requestType],
    code,
    now,
    "email_normalized"
  );
  return result.ok;
}
