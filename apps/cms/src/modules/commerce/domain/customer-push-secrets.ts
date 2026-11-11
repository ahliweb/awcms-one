/**
 * At-rest protection for a customer device's credentials (Issue #430, ADR-0048
 * Q2). Pure: no I/O, no `process.env` read at module scope.
 *
 * ONE key ring, a DISTINCT purpose-bound AAD per column. The ring is upstream's
 * auth-secret ring (`PUSH_AUTH_SECRET_ENCRYPTION_KEYS`, resolved by
 * `resolvePushAuthSecretRing`, strict, fail closed, no plaintext fallback): a
 * deployment operates one ring and one rotation runbook. The ciphertext format
 * is the shared `field-encryption` helper's (`v2:<keyId>:...`), so rotation needs
 * no schema change.
 *
 * The AAD binds `(purpose, tenant_id, endpoint_hash)`:
 *
 * - `commerce.customer_push_auth_secret` for the RFC 8291 auth secret, and
 * - `commerce.customer_push_endpoint` for the endpoint URL itself,
 *
 * both different from upstream's `push_delivery.subscription_auth_secret`. A
 * customer ciphertext therefore cannot be replayed into a staff subscription
 * row, an endpoint ciphertext cannot be read as an auth secret (or the other way
 * round), and neither survives a copy to another tenant or another endpoint.
 * `endpoint_hash` is the AAD row id for the reason upstream's header gives: it
 * is the business key, known before the UPSERT, and it never changes.
 *
 * The plaintext exists in memory only: the register handler handing it to the
 * encrypt functions, and (in #432) the dispatcher handing the decrypted values
 * to the Web Push adapter. It reaches no log, audit row, event or response.
 */
import {
  decryptFieldToString,
  encryptField,
  type KeyRing
} from "../../../lib/security/field-encryption";

export const CUSTOMER_PUSH_AUTH_SECRET_PURPOSE =
  "commerce.customer_push_auth_secret";

export const CUSTOMER_PUSH_ENDPOINT_PURPOSE = "commerce.customer_push_endpoint";

export function encryptCustomerPushAuthSecret(
  authSecret: string,
  tenantId: string,
  endpointHash: string,
  ring: KeyRing
): string {
  return encryptField(
    authSecret,
    {
      purpose: CUSTOMER_PUSH_AUTH_SECRET_PURPOSE,
      tenantId,
      rowId: endpointHash
    },
    ring
  );
}

/** Throws a `FieldEncryptionError` on any failure; callers treat a throw as "cannot decrypt" and never fall back. */
export function decryptCustomerPushAuthSecret(
  ciphertext: string,
  tenantId: string,
  endpointHash: string,
  ring: KeyRing
): string {
  return decryptFieldToString(
    ciphertext,
    {
      purpose: CUSTOMER_PUSH_AUTH_SECRET_PURPOSE,
      tenantId,
      rowId: endpointHash
    },
    ring
  );
}

export function encryptCustomerPushEndpoint(
  endpoint: string,
  tenantId: string,
  endpointHash: string,
  ring: KeyRing
): string {
  return encryptField(
    endpoint,
    {
      purpose: CUSTOMER_PUSH_ENDPOINT_PURPOSE,
      tenantId,
      rowId: endpointHash
    },
    ring
  );
}

export function decryptCustomerPushEndpoint(
  ciphertext: string,
  tenantId: string,
  endpointHash: string,
  ring: KeyRing
): string {
  return decryptFieldToString(
    ciphertext,
    {
      purpose: CUSTOMER_PUSH_ENDPOINT_PURPOSE,
      tenantId,
      rowId: endpointHash
    },
    ring
  );
}
