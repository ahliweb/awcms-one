---
bump: minor
type: structure
impact: public
---

# Commerce inbox — customer/store conversations, bearer + owner endpoints, admin screen

`commerce` gains a support inbox (Issue #111, contract #106 D8): `awcms_commerce_conversations`/`awcms_commerce_messages` (`sql/927`, FORCE RLS, one thread per verified customer account), and a `commerce.conversations.read|update` permission pair (`sql/928`).

Storefront (bearer, `Authorization: Bearer <customer session>`): `GET/POST /api/v1/commerce/storefront/account/conversations` (list, newest-activity-first, keyset-paginated; open a thread with its first message — subject 1-150 chars, body 1-4000 chars), `GET .../conversations/{id}` (thread + messages, marks it read for the customer), `POST .../conversations/{id}/messages` (post a reply; `409 CONVERSATION_CLOSED` once the thread is closed — a customer never reopens their own thread). Customer posts are rate-limited 10/hour per ACCOUNT (`COMMERCE_CONVERSATION_POST_RATE_LIMIT_MAX`), on top of the existing per-IP limiter every storefront route already applies.

Owner API: `GET /api/v1/commerce/conversations` (staff list, filterable by `status`/`unread`), `GET .../conversations/{id}` (marks it read for the store), `PATCH .../conversations/{id}` (explicit close/reopen), `POST .../conversations/{id}/messages` (staff reply — implicitly reopens a closed thread; requires `Idempotency-Key`). A store reply enqueues one `derived.commerce_conversation_reply` e-mail through the existing `email` module outbox in the SAME transaction as the reply insert, auto-seeding its default template on first miss (the same pattern `customer-otp-channel-adapters.ts` already established for OTP e-mail).

`unread_for_store`/`unread_for_customer` are independent flags on the conversation row, kept in step with every message insert; the storefront's own `Percakapan.unreadForCustomer` contract field travels as `0|1`.

New admin screen `/admin/commerce-inbox`: conversation list with status/unread filters and an unread badge, a thread view, a reply form (`Idempotency-Key` header), and close/reopen actions.

- Both new tables are `unreachableBySubject: true` in `subjectData` — the owning customer account carries no tenant_user/identity/profile/principal id (ADR-0016 D1), the same shape `commerce.customer_addresses`/`commerce.wishlists` already document; an account holder reaches their own threads through the bearer routes above, outside this automated engine's scope.
- New env var: `COMMERCE_CONVERSATION_POST_RATE_LIMIT_MAX` (default 10).
- `APP_BUDGET_BYTES` (`apps/cms/scripts/client-asset-budget.ts`) raised 231,000 -> 231,500 for this screen's own measured cost (624 B client script, built on the shared `onSubmit`/`onAction`/`mutateAndReload` helpers — no per-screen duplication).
