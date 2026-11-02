/**
 * The six mutating storefront endpoints that take an OPTIONAL
 * `Idempotency-Key` (Issue #513, work unit C), each as ONE application function
 * the route calls and the integration tests drive directly: the keyed run
 * (`runStorefrontIdempotent`) wrapped around the unchanged mutation.
 *
 * Classification (also in `docs/api.md`):
 *
 * | route                                  | without a key                                             | with a key                  |
 * | -------------------------------------- | --------------------------------------------------------- | --------------------------- |
 * | `POST account/addresses`               | creates a second address                                  | replays the first           |
 * | `POST account/conversations`           | opens a second thread                                     | replays the first           |
 * | `POST account/conversations/{id}/messages` | posts the message twice                               | replays the first           |
 * | `POST orders/{code}/payment-confirmations` | records a second confirmation row                     | replays the first           |
 * | `POST orders/{code}/cancel`            | NATURALLY idempotent: already-cancelled answers success   | replays (marker only)       |
 * | `POST reviews`                         | unique index: the repeat is `409 REVIEW_NOT_ALLOWED`      | replays the first review id |
 *
 * Every function maps "same key, different request" to `idempotency_conflict`
 * and records ONLY a success, so a refused or failed request can be retried
 * under the same key.
 */
import {
  createAccountAddress,
  type AccountAddress
} from "./customer-account-resources";
import {
  openConversation,
  postCustomerMessage,
  type ConversationMessageRecord,
  type OpenConversationResult
} from "./conversation-directory";
import {
  cancelOrderByCustomer,
  createPaymentConfirmation,
  fetchOrderRecordForCredential,
  type PublicOrderRecord
} from "./order-directory";
import { createReview, type CreateReviewOutcome } from "./review-directory";
import {
  runStorefrontIdempotent,
  type StorefrontIdempotentResult
} from "./storefront-idempotency";
import { STOREFRONT_IDEMPOTENCY_SCOPES } from "../domain/storefront-idempotency";
import type { AccountAddressInput } from "../domain/address-validation";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";

export type StorefrontIdempotencyOptions = {
  /** The validated `Idempotency-Key` (`parseStorefrontIdempotencyKey`); `null` = no idempotency. */
  key: string | null;
  correlationId?: string;
};

/** Asked right before a NEW post is written (never on a replay, so a replay does not spend the limit); `null` admits it. */
export type PostAdmission = () => Promise<{ retryAfterSec: number } | null>;

type Conflict = { kind: "idempotency_conflict" };

// ---------------------------------------------------------------------------
// account/addresses
// ---------------------------------------------------------------------------

export type CreateAddressIdempotentOutcome =
  | { kind: "created"; address: AccountAddress; replayed: boolean }
  | { kind: "limit_reached" }
  | Conflict;

export async function createAccountAddressIdempotent(
  tx: Bun.SQL,
  tenantId: string,
  account: { id: string; customerId: string },
  input: AccountAddressInput,
  options: StorefrontIdempotencyOptions
): Promise<CreateAddressIdempotentOutcome> {
  const run = await runStorefrontIdempotent<
    CreateAddressIdempotentOutcome,
    { address: AccountAddress }
  >(
    tx,
    tenantId,
    {
      scope: STOREFRONT_IDEMPOTENCY_SCOPES.accountAddressCreate,
      key: options.key,
      accountId: account.id,
      request: { address: input },
      correlationId: options.correlationId
    },
    async () => {
      const outcome = await createAccountAddress(
        tx,
        tenantId,
        account.customerId,
        input,
        options.correlationId
      );
      if (outcome.kind === "limit_reached") {
        return { outcome: { kind: "limit_reached" }, record: null };
      }
      return {
        outcome: { kind: "created", address: outcome.address, replayed: false },
        record: { address: outcome.address }
      };
    }
  );

  if (run.kind === "conflict") return { kind: "idempotency_conflict" };
  if (run.kind === "replayed") {
    return { kind: "created", address: run.record.address, replayed: true };
  }
  return run.outcome;
}

// ---------------------------------------------------------------------------
// account/conversations
// ---------------------------------------------------------------------------

export type OpenConversationIdempotentOutcome =
  | { kind: "created"; result: OpenConversationResult; replayed: boolean }
  | { kind: "rate_limited"; retryAfterSec: number }
  | Conflict;

export async function openConversationIdempotent(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  input: { subject: string; body: string },
  options: StorefrontIdempotencyOptions & { admit?: PostAdmission }
): Promise<OpenConversationIdempotentOutcome> {
  const run = await runStorefrontIdempotent<
    OpenConversationIdempotentOutcome,
    OpenConversationResult
  >(
    tx,
    tenantId,
    {
      scope: STOREFRONT_IDEMPOTENCY_SCOPES.accountConversationCreate,
      key: options.key,
      accountId,
      request: { conversation: input },
      correlationId: options.correlationId
    },
    async () => {
      const refused = await options.admit?.();
      if (refused) {
        return {
          outcome: {
            kind: "rate_limited",
            retryAfterSec: refused.retryAfterSec
          },
          record: null
        };
      }
      const result = await openConversation(
        tx,
        tenantId,
        accountId,
        input,
        options.correlationId
      );
      return {
        outcome: { kind: "created", result, replayed: false },
        record: result
      };
    }
  );

  if (run.kind === "conflict") return { kind: "idempotency_conflict" };
  if (run.kind === "replayed") {
    return { kind: "created", result: run.record, replayed: true };
  }
  return run.outcome;
}

// ---------------------------------------------------------------------------
// account/conversations/{id}/messages
// ---------------------------------------------------------------------------

export type PostMessageIdempotentOutcome =
  | { kind: "posted"; message: ConversationMessageRecord; replayed: boolean }
  | { kind: "not_found" }
  | { kind: "closed" }
  | { kind: "rate_limited"; retryAfterSec: number }
  | Conflict;

export async function postCustomerMessageIdempotent(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  conversationId: string,
  body: string,
  options: StorefrontIdempotencyOptions & { admit?: PostAdmission }
): Promise<PostMessageIdempotentOutcome> {
  const run = await runStorefrontIdempotent<
    PostMessageIdempotentOutcome,
    { message: ConversationMessageRecord }
  >(
    tx,
    tenantId,
    {
      scope: STOREFRONT_IDEMPOTENCY_SCOPES.accountMessagePost,
      key: options.key,
      accountId,
      request: { conversationId, body },
      correlationId: options.correlationId
    },
    async () => {
      const refused = await options.admit?.();
      if (refused) {
        return {
          outcome: {
            kind: "rate_limited",
            retryAfterSec: refused.retryAfterSec
          },
          record: null
        };
      }
      const outcome = await postCustomerMessage(
        tx,
        tenantId,
        accountId,
        conversationId,
        body,
        options.correlationId
      );
      if (outcome.kind !== "posted") return { outcome, record: null };
      return {
        outcome: { kind: "posted", message: outcome.message, replayed: false },
        record: { message: outcome.message }
      };
    }
  );

  if (run.kind === "conflict") return { kind: "idempotency_conflict" };
  if (run.kind === "replayed") {
    return { kind: "posted", message: run.record.message, replayed: true };
  }
  return run.outcome;
}

// ---------------------------------------------------------------------------
// orders/{code}/payment-confirmations and orders/{code}/cancel
// ---------------------------------------------------------------------------

export type OrderMutationIdempotentOutcome =
  /** `order` is the order as it is now; `replayed` when the same keyed request already succeeded. */
  | { kind: "done"; order: PublicOrderRecord; replayed: boolean }
  /** Unknown order code or a phone that does not match: the neutral 404. */
  | { kind: "not_found" }
  | Conflict;

export type PaymentConfirmationInput = Parameters<
  typeof createPaymentConfirmation
>[5];

/** Throws `OrderNotPayableError` exactly like {@link createPaymentConfirmation} (nothing is recorded). */
export async function createPaymentConfirmationIdempotent(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  orderCode: string,
  phone: string,
  input: PaymentConfirmationInput,
  options: StorefrontIdempotencyOptions
): Promise<OrderMutationIdempotentOutcome> {
  const run = await runStorefrontIdempotent<
    PublicOrderRecord | null,
    { outcome: "submitted" }
  >(
    tx,
    tenantId,
    {
      scope: STOREFRONT_IDEMPOTENCY_SCOPES.paymentConfirmationCreate,
      key: options.key,
      accountId: null,
      request: { orderCode, phone, confirmation: input },
      correlationId: options.correlationId
    },
    async () => {
      const order = await createPaymentConfirmation(
        tx,
        tenantId,
        mediaPort,
        orderCode,
        phone,
        input,
        options.correlationId
      );
      return {
        outcome: order,
        record: order ? { outcome: "submitted" as const } : null
      };
    }
  );
  return orderMutationOutcome(tx, tenantId, mediaPort, orderCode, phone, run);
}

/** Throws `OrderNotCancellableError`/inventory errors exactly like {@link cancelOrderByCustomer}; an already-cancelled order is a success. */
export async function cancelOrderIdempotent(
  tx: Bun.TransactionSQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  orderCode: string,
  phone: string,
  reason: string | null,
  options: StorefrontIdempotencyOptions
): Promise<OrderMutationIdempotentOutcome> {
  const run = await runStorefrontIdempotent<
    PublicOrderRecord | null,
    { outcome: "cancelled" }
  >(
    tx,
    tenantId,
    {
      scope: STOREFRONT_IDEMPOTENCY_SCOPES.orderCancel,
      key: options.key,
      accountId: null,
      request: { orderCode, phone, reason },
      correlationId: options.correlationId
    },
    async () => {
      const order = await cancelOrderByCustomer(
        tx,
        tenantId,
        mediaPort,
        orderCode,
        phone,
        reason,
        options.correlationId
      );
      return {
        outcome: order,
        record: order ? { outcome: "cancelled" as const } : null,
        status: 200
      };
    }
  );
  return orderMutationOutcome(tx, tenantId, mediaPort, orderCode, phone, run);
}

async function orderMutationOutcome(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  orderCode: string,
  phone: string,
  run: StorefrontIdempotentResult<PublicOrderRecord | null, unknown>
): Promise<OrderMutationIdempotentOutcome> {
  if (run.kind === "conflict") return { kind: "idempotency_conflict" };
  if (run.kind === "replayed") {
    // The record is a marker; the answer is the order as it is NOW, through
    // the same `(orderCode, phone)` check as the ordinary request.
    const order = await fetchOrderRecordForCredential(
      tx,
      tenantId,
      mediaPort,
      orderCode,
      phone
    );
    return order
      ? { kind: "done", order, replayed: true }
      : { kind: "not_found" };
  }
  return run.outcome
    ? { kind: "done", order: run.outcome, replayed: false }
    : { kind: "not_found" };
}

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

export type CreateReviewIdempotentOutcome =
  | Exclude<CreateReviewOutcome, { kind: "created" }>
  | { kind: "created"; id: string; replayed: boolean }
  | Conflict;

export async function createReviewIdempotent(
  tx: Bun.TransactionSQL,
  tenantId: string,
  input: {
    orderCode: string;
    phone: string;
    productId: string;
    rating: number;
    body: string;
  },
  /** Set ONLY after a valid bearer session was presented (`createReview`'s `accountCustomerId`). */
  accountCustomerId: string | undefined,
  options: StorefrontIdempotencyOptions
): Promise<CreateReviewIdempotentOutcome> {
  const run = await runStorefrontIdempotent<
    CreateReviewOutcome,
    { id: string }
  >(
    tx,
    tenantId,
    {
      scope: STOREFRONT_IDEMPOTENCY_SCOPES.reviewCreate,
      key: options.key,
      // A signed-in shopper's key lives in their own namespace; a guest's is
      // bound to the `(orderCode, phone)` pair by the request digest.
      accountId: accountCustomerId ?? null,
      request: { ...input },
      correlationId: options.correlationId
    },
    async () => {
      const outcome = await createReview(
        tx,
        tenantId,
        input.orderCode,
        input.phone,
        input.productId,
        input.rating,
        input.body,
        options.correlationId,
        accountCustomerId
      );
      return {
        outcome,
        record: outcome.kind === "created" ? { id: outcome.id } : null
      };
    }
  );

  if (run.kind === "conflict") return { kind: "idempotency_conflict" };
  if (run.kind === "replayed") {
    return { kind: "created", id: run.record.id, replayed: true };
  }
  return run.outcome.kind === "created"
    ? { kind: "created", id: run.outcome.id, replayed: false }
    : run.outcome;
}
