🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0048-customer-web-push-identity-subscription-and-cross-origin-contract.id.md)

# ADR-0048 — Customer Web Push: identity, subscription model and cross-origin contract

- **Status:** Proposed
- **Date:** 18 October 2026
- **Decision maker:** ahliweb (sign-off pending; nothing below is implemented or approved until the owner changes this status)
- **Related:** issue [#429](https://github.com/ahliweb/awcms-one/issues/429) (this ADR); consumers [#430](https://github.com/ahliweb/awcms-one/issues/430), [#431](https://github.com/ahliweb/awcms-one/issues/431), [#432](https://github.com/ahliweb/awcms-one/issues/432); prerequisites [#427](https://github.com/ahliweb/awcms-one/issues/427) (subtree sync) and [#428](https://github.com/ahliweb/awcms-one/issues/428) (storefront installability); [ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md), [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md), [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md), [ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md), [ADR-0040](0040-aw-business-platform-capability-ownership-and-boundaries.md); upstream `ahliweb/awcms` issue 1106 and its Web Push work (declarative payload, installable iOS admin, operator test matrix); WebKit [Declarative Web Push](https://webkit.org/blog/16535/)

## Context

`apps/cms` embeds the upstream `ahliweb/awcms` `push_delivery` module. This ADR was written against upstream `main` at `3c7fc296`, the state this repository reaches after the #427 sync. Where this tree is older than that, it says so. What that module is, and what it assumes:

- **One recipient type: a tenant user.** The subscription table is keyed `(tenant_id, endpoint_hash)` and carries a composite foreign key `(tenant_id, tenant_user_id)` to the tenant-users table. The queue row carries `subscription_id` and (since upstream's hardening of a recipient-binding gap) a `NOT NULL recipient_tenant_user_id` with the same kind of composite foreign key. The dispatcher refuses a message whose recipient is no longer the owner of the device. The schema is `apps/cms/sql/093_awcms_push_delivery_schema.sql`; the recipient binding and the encrypted auth secret are later upstream migrations that this tree does not have yet.
- **The HTTP surface is self-service for staff.** `GET|POST /api/v1/push/subscriptions` and `DELETE …/{id}` (`apps/cms/src/pages/api/v1/push/subscriptions/index.ts`) take the principal from the staff session and never accept a `tenantUserId`.
- **The enqueue function takes tenant-user ids.** `enqueuePushToRecipients` in `apps/cms/src/modules/push-delivery/application/push-enqueue.ts` writes `awcms_push_messages` for `recipientTenantUserIds`. Its click target is a same-origin path (`apps/cms/src/modules/push-delivery/domain/push-target-path.ts`).
- **The provider layer is recipient-neutral.** `PushProvider`, `PushTarget` and `PushMessage` (`apps/cms/src/modules/push-delivery/domain/push-provider-contract.ts`) know nothing about tenant users. VAPID signing, RFC 8291 encryption, response mapping, retry policy and the circuit breaker live in `apps/cms/src/modules/push-delivery/infrastructure/web-push-provider.ts`, `apps/cms/src/modules/push-delivery/domain/web-push-encryption.ts`, `apps/cms/src/modules/push-delivery/domain/push-retry.ts` and `apps/cms/src/modules/push-delivery/infrastructure/push-provider-resolver.ts`.
- **Three-phase dispatch outside any transaction.** `apps/cms/src/modules/push-delivery/application/push-dispatch.ts`: claim with `FOR UPDATE SKIP LOCKED` and a lease in `next_attempt_at`, send, finalize. `sent` means the push service answered 2xx and nothing more.
- **Upstream, after the sync:** the Web Push `auth_secret` is stored as AES-256-GCM ciphertext with the AAD `(purpose, tenant_id, endpoint_hash)` under a key ring; a re-registration of an endpoint held by another user is an explicit, audited transfer; the producer can emit WebKit's declarative payload (`navigate` is an absolute URL on `APP_URL`'s origin, which is the **CMS** origin); and `apps/cms/public/push-sw.js` is a dual-format service worker served from the CMS origin only.
- **The provider sends a fixed `TTL` and no `Urgency` header.** The message priority is queue ordering only.

On the customer side:

- A customer is an `awcms_commerce_customer_accounts` row bound 1:1 to `awcms_commerce_customers` (`apps/cms/sql/917_awcms_commerce_customer_accounts_schema.sql`), authenticated by an e-mail OTP and a `cs_` opaque bearer session whose `sha256` is stored in `awcms_commerce_customer_sessions` ([ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)). The guard is `requireCustomerSession` in `apps/cms/src/modules/commerce/application/customer-session-auth.ts`; it returns the account and the session id and deliberately does not reject a blocked account.
- The tenant of a storefront call is resolved from the browser's `Origin` host against the tenant's active domains (`apps/cms/src/modules/commerce/application/public-commerce-tenant.ts`); CORS never grants credentials (`apps/cms/src/modules/commerce/domain/commerce-cors.ts`). The browser keeps the token in `localStorage` (`apps/storefront/src/lib/akun-sesi.ts`) and attaches it explicitly (`apps/storefront/src/lib/akun-klien.ts`).
- Logout (`apps/cms/src/pages/api/v1/commerce/storefront/account/logout.ts`) revokes the one session. `revokeAllSessions` in `apps/cms/src/modules/commerce/application/customer-account-store.ts` exists but has no production caller (only a test). A blocked account keeps its live sessions; its routes answer `403 ACCOUNT_BLOCKED`.
- Accounts carry `marketing_consent_at` (e-mail and WhatsApp campaigns). There is no account-deletion flow in `commerce` today.
- `apps/storefront` is static ([ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md)): its CSP is built in `apps/storefront/server/penyaji.mjs` with `default-src 'self'` and a derived `connect-src` that already names the CMS origin.

The two worlds do not meet. A customer is not a tenant user, a storefront service worker cannot be registered on the CMS origin, and the producer builds click targets on the CMS origin. Blindly reusing the staff endpoints, or inventing a shadow tenant user per customer, would let one account's notifications reach another's device, or let a customer token act as staff. Issue #430 additionally forbids storing a `customer_id` in `tenant_user_id`.

## How to read this ADR

The sections follow the order the DoR asks for: blueprint, threat and privacy model, ERD, RLS and authorization matrix, domain algorithm, API and event contract, UX, tests, migration and recovery. Identifiers `T1…` (threats), `I1…` (invariants), `E1…` (events), `P1…` (proof obligations) and `Q1…` (open questions) are stable handles for the implementation issues. Every file path in backticks exists in this repository; proposed new files are described, not named as paths. The migration band is stated, never a concrete number ([ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md)).

## 1. Blueprint

### 1.1 Options compared

The three options of #429, over the criteria the project uses. A column header carries the verdict.

| Criterion | **A. Generic upstream "external recipient" abstraction** | **B. Commerce mapping + provider reuse + the generic queue** | **C. Commerce-owned device table and thin outbox, reusing everything below the queue (recommended)** |
| --- | --- | --- | --- |
| Security | One pipeline, but customer identity enters the most hardened admin tables. The recipient reference becomes polymorphic and cannot be a foreign key to `commerce` accounts, so the database loses the integrity and owner backstop that the staff path has. A bug touches the admin path. | Not implementable alone. `awcms_push_messages.subscription_id` references a staff-owned subscription and `recipient_tenant_user_id` is `NOT NULL`; writing those tables from `commerce` is refused by `modules:table-writes:check` (one writer module per table); the only way in is a shadow tenant user, which is impersonation. | Strongest isolation. The admin pipeline is untouched. Customer rows carry composite foreign keys to accounts and sessions, so cross-tenant and cross-account rows are structurally impossible. One eligibility query decides every send. |
| Performance | Same queue. A customer flood shares the tenant batch with admin messages. | As A once the queue is shared. | Separate queue, batch and cron; customer volume cannot starve admin messages. Provider and circuit breaker are shared on purpose (they describe the push services' health). |
| Maintainability | Best end state (one dispatcher) but the worst transition: upstream design, ADR, release and a second subtree sync before #430 can start. | Collapses into A or C. | A second claim/finalize loop to keep correct (about the size of upstream's three-phase pattern, which upstream itself copied from `email`). Mitigated by importing retry, mapping and provider code and by the convergence proposals in section 12. |
| Scalability | Shared claim ordering and shared tenant batch. | As A. | Independent fan-out bounds, limits and schedule; devices per account are capped. |
| Accessibility | No difference. | No difference. | No difference. Notification text is generic by design (section 6.5). |
| SEO | None (no public page changes). | None. | None. |
| UI/UX | Same user-facing result. | Same. | Same user-facing result. |
| Compatibility | Alters columns and constraints of a live credential table that deployed admin devices use (expand and contract on a security-sensitive table). | Same as A. | Purely additive in the commerce migration band. No upstream table changes, so the subtree stays clean and no standing divergence is created. |
| Operational complexity | One queue and one purge, but #430 is gated on the upstream release train. | n/a | One more job and one more purge. One VAPID key pair, one key ring and one runbook (section 9). |
| Long-term | Cleanest if several consumers need external recipients; premature for one (ADR-0024 D3: one consumer is evidence to examine generality, not permission to generalize). | n/a | Can later be re-pointed at an upstream abstraction: the device table stays, the outbox shrinks to an adapter. |

**Verdict.** The evidence above shows that the generic outbox cannot safely carry a customer recipient without an upstream schema change (B fails on its own terms), which is the condition #429 sets for (c). Choose **C**, with B's ownership split: `commerce` owns identity, consent, devices and the outbox; it **imports** the upstream provider, crypto and policy code and writes none of upstream's tables. Option A stays open as the long-term convergence, through the small generic upstream proposals in section 12. Owner question Q1 asks the owner to confirm this trade (accept a thin commerce outbox now, versus wait for A).

### 1.2 What is reused and what is new

| Reused from upstream `push_delivery` (no copy, no fork) | New in `apps/cms/src/modules/commerce/` |
| --- | --- |
| `PushProvider` / `PushTarget` / `PushMessage` types, `createWebPushProvider`, VAPID signing, RFC 8291 encryption, `mapWebPushResponse`, `evaluatePushRetry`, the `push-delivery` circuit breaker, `PUSH_ENABLED`, VAPID configuration | The four tables of section 3 |
| Endpoint normalisation, hashing and masking; `validateSubscriptionInput`; `validatePushTargetPath` | Customer device directory (register, transfer, revoke), preferences, eligibility query |
| The upstream field-encryption helper and the `PUSH_AUTH_SECRET_ENCRYPTION_KEYS` ring (a distinct AAD purpose; the helper arrives with the #427 sync) | Domain-event consumers, notification policy, generic templates |
| Body limit, shared rate limiter, audit log, the feature-gate pattern | The claim/send/finalize loop against the new outbox, purge, re-key job |

The `commerce` descriptor gains `push_delivery` as a dependency (checked by `modules:dag:check`). It imports upstream pure, domain and infrastructure functions only and never names an `awcms_push_*` table in SQL.

### 1.3 Ownership and boundaries

- **Subtree.** Nothing under upstream-owned code is edited. New code and migrations live in `apps/cms/src/modules/commerce/` and the commerce migration band ([ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md)). Shared registries (security readiness grants, subject-data coverage, OpenAPI bundle, jobs crontab) receive commerce rows exactly as every earlier commerce table did; those collisions are resolved by keeping both lineages, per [AGENTS.md](../../AGENTS.md).
- **Template, not a service** ([ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)). A derived application runs its own backend, database, VAPID key pair, key ring, consent copy and flags. Nothing here names BjekMart; store-specific wording comes from tenant data. The feature is off unless a deployment turns it on (section 9).
- **Domain ownership.** Tenant owns the data (`tenant_id` on every row, RLS). A customer account owns its preferences and devices. A **device** is one browser profile's push subscription on one storefront origin, bound to the account and the session that enrolled it. A guest (no account) has no device and receives no push.

## 2. Threat and privacy model

### 2.1 Assets and actors

Assets: the endpoint URL (a bearer-grade capability to push to a device), the p256dh key and auth secret, the customer-to-device link, order and support information, the VAPID private key, the `cs_` token. Actors: the owning customer, another customer on a shared browser, a customer of another tenant, staff, a guest, an attacker who steals one token (XSS), a malicious registrant (hostile endpoint), a compromised push service.

### 2.2 Threat table

| ID | Threat | Mitigation (layered) | Regression test |
| --- | --- | --- | --- |
| T1 | A staff cookie or staff bearer works on a customer push route, or a `cs_` token works on `/api/v1/push/*` | Customer routes call only `requireCustomerSession`, never read a cookie, never import the staff principal resolver; `cs_` has a distinct prefix and hash namespace; staff routes resolve a different table and answer 401 | TS-H1, TS-H2, TS-S1 |
| T2 | Client chooses the principal (`accountId`, `customerId`, `tenantId`, `sessionId`, `tenantUserId`) | Principal comes only from the bearer and the resolved tenant; the body schema is strict and rejects unknown keys with 400 | TS-U5, TS-H1 |
| T3 | Cross-tenant use: a tenant A token with a tenant B origin | Session lookup runs under tenant B's RLS and finds nothing: 401. Every row carries `tenant_id`; composite foreign keys include it | TS-I1, TS-H1 |
| T4 | A notification for customer X reaches customer Y | `account_id` is derived server-side from order to customer to account, fixed on the message, and compared with the device's account at send time (I5) | TS-I4, TS-I2 |
| T5 | Endpoint takeover on a shared device: customer B registers the endpoint of customer A's device | Transfer is explicit, atomic, audited (ids only); A's queued messages are cancelled in the same transaction; the recipient check at send time refuses any message whose account is not the device's current account. Residual: a holder of the raw endpoint can silence A (availability only; B receives nothing). Accepted and detectable (audit event, metric) | TS-I2 |
| T6 | Stale subscriber disclosure: A logs out or is switched out, and A's notifications still show on that browser for B | Logout revokes the session's devices in the same transaction; delivery requires a live enrolling session; the client revokes the old session before saving a new one; text is generic so a leak would disclose almost nothing | TS-I3, TS-I4, TS-E1 |
| T7 | Notification click target tampered (open redirect with the store's name and icon) | Target is chosen from a closed list per purpose, never from event or request data; the origin is the device's stored, validated storefront origin; checked again by `validatePushTargetPath` and by the service worker | TS-U2, TS-E3 |
| T8 | A shopper device subscribed on the CMS (admin) origin | The registration `Origin` must be an active domain of the same tenant and must not be the CMS/admin origin; otherwise refused | TS-U2, TS-H3 |
| T9 | Hostile endpoint (SSRF through the dispatcher) | Upstream validation (https only, literal private/reserved address refused) **plus** a push-service host allowlist for this surface, because any verified customer can register (a larger attacker population than staff). Unknown host: 422 | TS-U3 |
| T10 | Resource exhaustion: registration floods, fan-out amplification | Body cap, per-IP and per-account rate limits, at most five active devices per account, per-account notification cap, bounded batches, TTL | TS-H5, TS-I5 |
| T11 | Credential or PII leakage in responses, logs, audit rows, errors | Responses carry the masked endpoint only; ciphertext and keys are never selected into a response; error strings and `last_error` are fixed vocabularies; audit rows carry ids only | TS-H4 |
| T12 | A blocked or unverified account still receives or registers | Register and update answer 403; send-time eligibility requires an active, verified account; blocking must revoke devices (#430 wires it) | TS-I4 |
| T13 | Consent bypass: transactional consent used for marketing | Purposes are separate preference rows; the event-to-purpose map has no path to `marketing`; marketing push is not shipped (Q11) | TS-U1, TS-I4 |
| T14 | Event replay, duplicate delivery, worker restart | Unique `dedupe_key` per event and device; consumers use the runtime's once-per-effect guard; provider attempts are at-least-once (one duplicate banner is possible and is documented) | TS-I5 |
| T15 | Lock-screen privacy: order codes, amounts or names in the notification | Payload text comes from fixed generic templates; no identifiers in the payload or the URL; rows hold no order data | TS-U4 |
| T16 | XSS steals the `cs_` token | Residual of [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D3, not widened: the service worker holds no token and cannot call the API; payloads hold none; first-party CSP | TS-E3 |
| T17 | "Delivered" claimed from provider acceptance | Status vocabulary says `sent` = provider accepted; metrics never say delivered; no click tracking in v1 | TS-I6 |
| T18 | Enumeration oracle: foreign device id, feature off, other tenant | One neutral 404 for foreign or absent device; feature off collapses to the same neutral 404 as an unresolvable tenant, as the other public commerce routes do | TS-H6 |
| T19 | Cached or shared responses expose a device list | `Cache-Control: private, no-store`, `Vary: Origin` | TS-H3 |

### 2.3 Privacy by design

- **Data inventory.** Per device: endpoint (credential, held only while active), masked endpoint, p256dh key, encrypted auth secret, a coarse user-agent summary, storefront origin, status and timestamps. Per account: purpose preferences with consent version and timestamps. Per message: generic title and body, a fixed target path, purpose, status. No IP address is stored on a device row. No order identifier, amount, name or phone is stored on a message row.
- **Purposes (closed list).** `order_updates`, `payment_updates`, `support_replies` (transactional) and `marketing` (reserved, never sent in v1). Transactional consent does not imply marketing consent; the existing `marketing_consent_at` (e-mail and WhatsApp) is **not** reused for push.
- **Consent.** Captured on an explicit user action together with the purpose text version shown, stored per purpose with a grant time, withdrawable at any time (a withdrawal keeps its row as evidence). The browser permission prompt belongs to the browser and cannot be revoked programmatically; the page says so.
- **Minimisation and transparency.** The consent text must say that the notification travels through the browser vendor's push service in encrypted form, that the lock screen shows generic text only, and how to turn it off.
- **Retention.** Credential material exists only while a device is `active`; it is destroyed on every other status. Revoked, gone and disabled device rows are kept 30 days (as tombstones carrying hash and mask) and then purged; terminal messages and attempts are purged after 30 days. Preferences are kept while the account exists. The windows are defaults for owner confirmation (Q8) and are declared to the data-lifecycle engine.
- **Deletion.** Devices, preferences, messages and attempts register `subjectData` descriptors (erase = delete). There is no customer-account deletion flow in `commerce` today; when one is built it must reach these tables, and the coverage gate (`subject-data:coverage:check`) makes the registration mandatory now.

## 3. ERD and data dictionary

Four new tables in the commerce migration band (`901`–`9999`, [ADR-0037](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md)); #430 allocates the numbers. All are additive. Every table: `tenant_id uuid NOT NULL REFERENCES awcms_tenants (id)`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, policy `tenant_id = current_setting('app.current_tenant_id')::uuid`, a retention descriptor and a `subjectData` descriptor. The two existing commerce tables that need a `UNIQUE (tenant_id, id)` for composite foreign keys (customer accounts and customer sessions) get it through an additive constraint in the new migration.

```
awcms_tenants 1───* awcms_commerce_customer_accounts 1───* awcms_commerce_customer_sessions
                           │ 1                                        │ 1
                           │                                          │
                           ├────* awcms_commerce_push_preferences     │
                           │ 1                                        │ *
                           └────* awcms_commerce_push_devices *───────┘   (device ↔ account, device ↔ enrolling session)
                                        │ 1
                                        └────* awcms_commerce_push_messages 1───* awcms_commerce_push_delivery_attempts
                                               (account_id also stored on the message)
```

### 3.1 `awcms_commerce_push_devices` (one row per tenant and endpoint)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `tenant_id` | uuid | FK tenants |
| `account_id` | uuid | composite FK `(tenant_id, account_id)` to customer accounts; the current owner |
| `session_id` | uuid | composite FK `(tenant_id, session_id)` to customer sessions; the session that enrolled or last re-registered the device |
| `storefront_origin` | text | validated `https` origin of the tenant's storefront (see 6.3); the only origin a click may open |
| `endpoint` | text NULL | raw endpoint; present only while `active`; destroyed otherwise; selected in exactly one file (the device directory), like upstream's rule |
| `endpoint_hash` | text | `sha256` of the normalised endpoint (upstream function); unique with `tenant_id` |
| `endpoint_masked` | text | what every list, log and diagnostic reads |
| `p256dh_key` | text NULL | present only while `active` |
| `auth_secret_ciphertext` | text NULL | present only while `active`; AES-256-GCM envelope of the upstream helper; AAD = (purpose `commerce.customer_push_auth_secret`, `tenant_id`, `endpoint_hash`). No plaintext column exists |
| `status` | text | `active`, `revoked`, `gone`, `disabled` (CHECK) |
| `status_reason` | text NULL | closed vocabulary: `customer_removed`, `logout`, `session_ended`, `account_blocked`, `account_erased`, `endpoint_gone`, `origin_revoked`, `vapid_rotated`, `kill_switch` |
| `user_agent_summary` | text NULL | coarse summary (upstream function), at most 120 characters |
| `last_success_at` | timestamptz NULL | provider acceptance, not display |
| `registered_at`, `rebound_at`, `created_at`, `updated_at` | timestamptz | `rebound_at` moves on every re-registration or transfer |

Constraints: `UNIQUE (tenant_id, endpoint_hash)`; `UNIQUE (tenant_id, id)`; CHECK `status = 'active'` iff `endpoint`, `p256dh_key` and `auth_secret_ciphertext` are all present (credentials exist only for active rows); CHECK on status and reason vocabularies; CHECK `storefront_origin` is an origin (no path, query or userinfo). Indexes: `(tenant_id, account_id)` partial on `status = 'active'` (fan-out), `(tenant_id, session_id)` (logout and session sweep), `(tenant_id, status, updated_at)` (purge), plus those `db:fk-index:check` requires.

### 3.2 `awcms_commerce_push_preferences` (consent per account and purpose)

`tenant_id`, `account_id` (composite FK), `purpose` (CHECK in the closed list), `enabled` boolean, `consent_text_version` text, `granted_at` timestamptz NULL, `revoked_at` timestamptz NULL, `updated_at`. Primary key `(tenant_id, account_id, purpose)`. CHECK: `enabled` implies `granted_at` is not null. A withdrawal sets `enabled = false` and `revoked_at`; the row stays.

### 3.3 `awcms_commerce_push_messages` (the outbox, one row per message and device)

| Column | Notes |
| --- | --- |
| `id`, `tenant_id` | |
| `account_id` | composite FK to accounts; **fixed at enqueue**, compared with the device's account at send (I5) |
| `device_id` | composite FK `(tenant_id, device_id)` to devices |
| `source_event_id` | uuid of the domain event; opaque, no FK (event retention differs) |
| `event_type`, `purpose`, `priority`, `tag` | `priority` CHECK in `low`, `normal`, `high`; `tag` is the coalescing key (the purpose) |
| `dedupe_key` | text; `UNIQUE (tenant_id, dedupe_key)`; value is the event id and the device id |
| `title`, `body` | generic rendered text, capped at 120 and 240 characters; never order data |
| `target_path` | one of the fixed storefront paths (6.5) |
| `status` | `queued`, `sending`, `sent`, `retry_wait`, `failed`, `cancelled`, `expired` |
| `retry_count`, `next_attempt_at` | `next_attempt_at` doubles as the claim lease, as upstream does |
| `expires_at` | after this a queued message is expired, never sent late |
| `last_error` | fixed vocabulary only |
| `provider_name`, `provider_message_id`, `created_at`, `updated_at`, `sent_at` | `sent_at` = provider acceptance |

Indexes: dispatch `(tenant_id, status, next_attempt_at)`, device `(tenant_id, device_id)`, rate window `(tenant_id, account_id, created_at DESC)`, retention `(tenant_id, status, updated_at)`.

### 3.4 `awcms_commerce_push_delivery_attempts`

`id`, `tenant_id`, `message_id` (composite FK), `attempt_no`, `outcome` (`success`, `failure`), `provider_name`, `provider_response_snippet` (at most 500 characters, never the payload or the endpoint), `error_message` (fixed vocabulary), `created_at`; `UNIQUE (message_id, attempt_no)` with `ON CONFLICT DO NOTHING` at the call site (the expired-lease re-claim needs it, as upstream documents).

### 3.5 Grants (least privilege)

`awcms_app`: register, revoke and preferences (INSERT and UPDATE on devices and preferences, UPDATE on messages to cancel). The eligibility fan-out and the enqueue run in the domain-event runtime's role; #430 maps them. `awcms_worker`: SELECT on all four; UPDATE only on `status`, `status_reason`, `last_success_at`, `updated_at` of devices (and the ciphertext column for the re-key job); UPDATE on messages; INSERT on attempts; DELETE for the purge. The worker **cannot INSERT a device and cannot UPDATE `endpoint`, `endpoint_hash`, `p256dh_key`, `account_id`, `session_id` or `storefront_origin`** (upstream's lesson: a worker able to rewrite those could redirect delivery). Each grant gets its row in the security-readiness matrix and a real-PostgreSQL test.

## 4. RLS and authorization matrix

| Surface | Credential accepted | Must be refused (and how) | Tenant comes from | DB role | Tables |
| --- | --- | --- | --- | --- | --- |
| `GET …/account/push/subscriptions` | `cs_` bearer, any non-expired session | no header, malformed, staff cookie, staff bearer, machine token, revoked or expired `cs_`: 401 `UNAUTHENTICATED`; blocked account: 403 `ACCOUNT_BLOCKED` | `Origin` host to tenant domain | app | devices R, preferences R |
| `PUT …/account/push/preferences` | `cs_`, active account | as above; unverified: 403 | same | app | preferences RW, audit |
| `POST …/account/push/subscriptions` | `cs_`, active and verified account | as above; hostile endpoint 422; origin not allowed 422 `ORIGIN_NOT_ALLOWED`; cap 409 | same | app | devices RW, preferences RW, messages U (cancel), audit |
| `DELETE …/account/push/subscriptions/{id}` | `cs_` (a blocked account may revoke) | foreign or absent id: 404 (same body) | same | app | devices U, messages U |
| `DELETE …/account/push/subscriptions` (all of my devices) | `cs_` | as above | same | app | devices U, messages U |
| `POST …/account/logout` (existing, extended) | `cs_` | 401 | same | app | sessions U, devices U, messages U |
| Event consumer | the runtime, tenant context from the event | an event with no resolvable account: no-op | the event's tenant | runtime role | orders R, accounts R, preferences R, devices R, messages I |
| Dispatch job | worker | feature off or push off: claims nothing | per-tenant loop | worker | devices R/U(status), messages R/U, attempts I |
| Purge and re-key jobs | worker | none | per-tenant loop | worker | D on terminal rows; ciphertext re-key |
| Proposed staff diagnostics: aggregate counts by status and purpose | staff session with a new `commerce.customer_push.read` permission (Q10) | `cs_` tokens: 401; no identifiers or endpoints in the answer | tenant header | app | messages and devices aggregates |
| Existing `/api/v1/push/*` | staff session | `cs_`: 401 (unchanged upstream behaviour, now covered by a test) | staff tenant | app | upstream tables only |

Authorization is **self-service by construction**: the subject is the bearer's own account, so there is no permission to check and no id to compare; ownership of a device id is enforced inside the `WHERE` (`id = $1 AND account_id = $caller`), so "absent", "someone else's" and "already revoked" are indistinguishable. Customer routes follow the existing public commerce route shape: `withPublicCommerceTenant`, the commerce feature gate, `requireCustomerSession`, shared rate limits and `commercePreflightResponse` for `OPTIONS`.

## 5. Domain algorithm

### 5.1 Invariants

- **I1** The principal is `(tenant, account, session)` from the bearer. Nothing in a request body or query can name or change it.
- **I2** A device binds one endpoint to one account, one enrolling session and one validated storefront origin.
- **I3** Credential material exists only on `active` rows.
- **I4** A message is sent only if the send-time eligibility holds (5.5).
- **I5** A message belongs to exactly one account, fixed at enqueue; at send time it must equal the device's current account.
- **I6** Notification content is a fixed generic template plus a fixed path; it never carries an identifier or a secret.
- **I7** One effect per `(event, device)`; provider attempts are at-least-once.
- **I8** `sent` means the push service accepted the request. Nothing in this system claims display or reading.

### 5.2 Register (idempotent)

1. Resolve CORS and tenant from `Origin` (refused origin: neutral 404 body, no ACAO). Feature `customerPush` off: the same neutral 404.
2. `requireCustomerSession`; 401 on failure. Blocked: 403 `ACCOUNT_BLOCKED`. No verified e-mail: 403 `ACCOUNT_NOT_VERIFIED`.
3. Rate limits (IP, then account). Read the body under the size cap; strict schema; `Content-Type` JSON.
4. Push available? (`PUSH_ENABLED`, VAPID, key ring) otherwise 409 `PUSH_UNAVAILABLE`.
5. Validate the endpoint (upstream validation plus the host allowlist). Validate the `Origin` as an approved storefront origin (6.3). Validate `consent.purposes` against the closed transactional list and the version string.
6. Encrypt the auth secret with the upstream helper (AAD with the commerce purpose).
7. One transaction: upsert the preference rows from `consent`; check the active-device count (excluding this endpoint) against the cap; `INSERT … ON CONFLICT (tenant_id, endpoint_hash) DO NOTHING`; if the row exists, `SELECT … FOR UPDATE`, then `UPDATE` it to the caller's account, session, origin and new keys, `status = 'active'`, `status_reason = NULL`, `rebound_at = now()`.
8. If the previous account differs: cancel that account's `queued` and `retry_wait` messages on the device (`last_error = 'device_transferred'`) in the same transaction and write one audit event `commerce.customer_push.device_transferred` with ids only. A failed audit write rolls the registration back.
9. Audit `commerce.customer_push.device_registered`. Respond 201 when the caller newly owns the row (new or transferred) and 200 for a no-op re-registration by the same account and session. The two cases are identical to the caller for a transfer, so the response never reveals that the endpoint was known.

Two concurrent registrations of one endpoint serialize on the row lock; exactly one account owns the row afterwards.

### 5.3 Revoke, logout, account switch, expiry, block

- **Revoke one or all.** `UPDATE … WHERE tenant_id AND id AND account_id = caller`; set `status = 'revoked'`, reason `customer_removed`, destroy `endpoint`, `p256dh_key` and the ciphertext, cancel the device's queued messages, audit. A second call by id is a 404; the "all" form is a no-op 204. The page then calls the browser's `unsubscribe()` (best effort; the server does not depend on it).
- **Logout.** In the same transaction as `revokeSession`: revoke every device whose `session_id` is the logging-out session (reason `logout`), cancel their queued messages. If the transaction fails, neither happens.
- **Account switch on one browser.** The storefront must call logout for the old session before it saves the new one (section 7). Server backstop: the new account's registration transfers the endpoint (5.2) and the send-time check refuses the old account's messages.
- **Session expiry.** A device is deliverable only while its `session_id` is live (not revoked, not expired). A sweep in the purge job marks devices of ended sessions `revoked` (`session_ended`) and destroys their credentials. Consequence (Q5): notifications stop when the enrolling session lapses after 30 days without use; the customer re-enables with one tap.
- **Block.** Send-time eligibility refuses a blocked account at once. The code path that blocks an account must also revoke its devices (reason `account_blocked`); #430 wires it, because `revokeAllSessions` has no caller today.

### 5.4 Enqueue (domain-event consumers)

Consumers are declared in the `commerce` descriptor (`domainEventConsumers`, the seam the loyalty consumers already use) with the runtime's default once-per-effect idempotency, so the handler is only the side effect and runs inside the delivery transaction. It makes no network call.

1. Skip unless the tenant's `customerPush` feature is on and `PUSH_ENABLED` is true.
2. Map the event to a purpose and a template through a closed table (section 6.6). No entry, no push.
3. From the event's `orderId`: order to `customer_id` to the single account with that `customer_id`. No account (guest, walk-in): stop. The account must be `active` and e-mail verified.
4. The preference for the purpose must be explicitly `enabled`. Otherwise stop.
5. Select the account's devices that are `active`, whose session is live and whose origin is still valid. None: stop (the inbox is the fallback).
6. Apply the account notification cap (12 per rolling hour, 40 per rolling day, initial values for Q7). Over the cap: insert nothing and count `suppressed_rate_limit`.
7. Insert one row per device: `dedupe_key = <event id>:<device id>`, `ON CONFLICT DO NOTHING`, generic title and body in the tenant's default locale, the purpose's fixed path, `expires_at` from the policy.

### 5.5 Send-time eligibility (one query, evaluated per message in its own short transaction)

All of: the tenant has `commerce` enabled and `customerPush` on; push is enabled and configured; the message is not past `expires_at`; the device is `active` and `device.account_id = message.account_id`; the device's session is not revoked and not expired; the account is `active` and verified; the preference for the message's purpose is `enabled`; the device's origin is still an active domain of the tenant and is not the admin origin. Any failure cancels the message with a fixed reason (`expired`, `not_eligible`, …); no provider call is made.

### 5.6 Dispatch

Three phases, outside any transaction while sending, mirroring upstream's pattern: **claim** (`FOR UPDATE SKIP LOCKED`, lease in `next_attempt_at`, high priority first, bounded batch), **eligibility and target** (query 5.5, decrypt the auth secret outside the transaction, build the `PushTarget`), **send** through the upstream provider created with the device's `storefront_origin` as the public origin (so a declarative `navigate` is on the storefront origin, never on `APP_URL`), **finalize** per row: `sent` (provider accepted, `last_success_at`), `retry_wait` with upstream's backoff, `failed`, or, when the push service says 404 or 410, device `gone` plus cancellation of its queued messages. Every attempt writes one attempts row. A crash after provider acceptance and before finalize can repeat one banner; the `tag` makes the repeat replace rather than stack.

### 5.7 Clean-up

The purge job deletes terminal messages and attempts older than the retention window, deletes non-active devices older than their window, and runs the session-ended sweep. It runs even when the feature is off, because rows from an earlier period still need removing.

## 6. API and event contract

### 6.1 Routes

Under `/api/v1/commerce/storefront/account/push/…`, security scheme `customerBearer` (never `bearerAuth`), final spelling fixed by #430 in the commerce OpenAPI fragment (`apps/cms/openapi/modules/commerce.openapi.yaml`).

| Method and path | Purpose | Success | Notable errors |
| --- | --- | --- | --- |
| `GET …/push/subscriptions` | Capability, preferences and this account's devices | 200 `{ capability, preferences, devices[] }` | 401, 403 `ACCOUNT_BLOCKED`, 404 neutral, 429 |
| `POST …/push/subscriptions` | Register or re-register this browser | 201 new or transferred, 200 no-op | 401, 403, 404, 409 `PUSH_UNAVAILABLE`, 409 `DEVICE_LIMIT`, 422 `VALIDATION_ERROR` / `ENDPOINT_NOT_ALLOWED` / `ORIGIN_NOT_ALLOWED`, 429 |
| `DELETE …/push/subscriptions/{id}` | Revoke one of my devices | 204 | 401, 404 (foreign, absent), 429 |
| `DELETE …/push/subscriptions` | Revoke all my devices | 204 | 401, 429 |
| `PUT …/push/preferences` | Set purposes and record consent | 200 `{ preferences }` | 401, 403, 422, 429 |

All answers carry `Cache-Control: private, no-store` and `Vary: Origin`. Response envelope is the commerce standard (`success`, `data`, `meta`).

**Request** (`POST`): `{ "endpoint": string, "keys": { "p256dh": string, "auth": string }, "expirationTime": number|null (ignored), "consent": { "purposes": ["order_updates", …], "textVersion": string } }`. Anything else, including `transport`, `accountId`, `tenantId`, `title`, `body`, `navigate`, is a 400. The shape is `PushSubscription.toJSON()` plus `consent`.

**Device** (response): `{ id, endpointMasked, userAgentSummary, status, lastSuccessAt, registeredAt, current }`. The raw endpoint, keys and ciphertext are never returned. `current` is true when the device's session is the caller's.

**Capability** (browser-capability response, what the **server** knows): `{ enabled, reason: null | "push_not_configured" | "origin_not_supported", applicationServerKey: string|null, transports: ["web_push"], purposes: [...], consentTextVersion, maxDevices }`. Everything the **browser** knows (Push API present, installed iOS app, permission state) is detected by the storefront (section 7). `enabled: false` is a first-class 200 answer, not an error.

**Idempotency.** Registration is idempotent by the natural key `(tenant, endpoint_hash)` under a row lock; no client key is required. DELETE is idempotent in effect. Replays of the consumer path are idempotent by `dedupe_key`.

**Transfer semantics.** Registering an endpoint held by another account moves it to the caller (5.2): atomic, audited, queued messages cancelled, recipient check at send. The caller learns nothing about the previous owner.

### 6.2 Rate limits (initial values, Q7)

| Route | Per IP | Per account |
| --- | --- | --- |
| `GET` | the commerce storefront default (60 per minute) | n/a |
| `POST subscriptions` | 30 per hour | 10 per hour |
| `DELETE`, `PUT preferences` | 60 per minute | 30 per minute |
| `OPTIONS` | the existing preflight limiter, under the same key as the request it precedes | n/a |

Over the limit: 429 with `Retry-After`. Body cap: 8 KiB.

### 6.3 Origins, CORS, CSP and CSRF

- **Origin mapping.** The storefront is a different origin from the CMS ([ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md)). The service worker and the push subscription live on the **storefront** origin. `storefront_origin` is the request's `Origin`, accepted only if: it is `https` (an `http` loopback origin only in a development profile); it has no userinfo, path or query; its host resolves, through the same lookup CORS uses, to **this** tenant's active domain; and it differs from the CMS/admin origin (`APP_URL`). A same-origin request (no cross-origin `Origin`) is refused in v1: a deployment that serves storefront and CMS from one origin gets `reason: "origin_not_supported"` and no customer push (Q3). Upstream's admin PWA stays on the CMS origin and never subscribes a shopper.
- **Target validation.** A click target is never taken from a request or an event. It is the fixed path of the purpose, joined to the device's stored `storefront_origin` at send time, after re-checking that the origin is still an active tenant domain. A removed domain disables the device (`origin_revoked`). The path is also run through `validatePushTargetPath`, and the storefront service worker resolves it against its own origin a third time.
- **CORS.** The existing commerce family: allow-origin echoes only a tenant-resolved origin, `Vary: Origin`, `authorization` and `content-type` allowed, methods include `DELETE` and `PUT`, **no `Access-Control-Allow-Credentials`** ([ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) D3).
- **CSRF.** Not exposed: authority is an `Authorization` header that script attaches deliberately; there is no cookie, no ambient credential and no credentialed CORS, so a third-party page cannot cause an authenticated request. The one residual, token theft by XSS, is ADR-0016's and is not widened: the service worker holds no token.
- **CSP.** Storefront: no change to origins. `worker-src` falls back to `default-src 'self'`; `connect-src` already names the CMS origin; the service worker is first-party and unhashed at a fixed URL. CMS: API only. No Firebase SDK, no third-party script.

### 6.4 Pushed payload

The upstream producer encrypts either the legacy payload (title, body, target path, data) or the declarative one (`navigate` absolute on the origin passed to the provider). Customer messages use whichever format the deployment configured; the origin is always the storefront's. No icon or image is taken from the payload. Title at most 120 and body at most 240 characters, as upstream caps them.

### 6.5 Fixed paths and generic text

| Purpose | Path (storefront, no identifiers) | Generic text (English; Indonesian in the catalogue) |
| --- | --- | --- |
| `order_updates` | `/akun/pesanan` | "Your order has an update" / "Open your account to see it." |
| `payment_updates` | `/akun/pesanan` | "Payment update" / "Open your account to see it." |
| `support_replies` | `/akun/pesan` | "You have a new message from the store" / "Open your inbox to read it." |

The store name may be added from tenant data. Order codes, amounts, product names and personal names are not allowed. Tenant-editable templates are deferred (Q9).

### 6.6 Event use cases (verified in code)

Each event below exists in `apps/cms/src/modules/commerce/domain/commerce-events.ts`, is published in the `commerce` descriptor, is described in `apps/cms/asyncapi/awcms-domain-events.asyncapi.yaml` and is appended by the producer named. The consumer reads only ids from the payload.

| ID | Event type (verified) | Producer evidence | Trigger | Purpose | Priority | Tag and TTL | Rule |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | `awcms.commerce.order.paid` | `transitionOrderStatus` in `apps/cms/src/modules/commerce/application/order-directory.ts` appends it when `to = paid`; payload `orderId`, `orderCode`, `from`, `to` | Payment confirmed | `payment_updates` | high | `payment`, 4 h | Always eligible if consented |
| E2 | `awcms.commerce.order.status_changed` | same function, every transition | Only `to` in `processing`, `shipped`, `completed` (the `paid`, `cancelled`, `expired` targets are handled by their own events, so no double notification) | `order_updates` | `shipped` high, `processing` normal, `completed` low | `order`, 12 h | Fulfilment and shipping update |
| E3 | `awcms.commerce.order.cancelled` | same function, `to = cancelled` | Order cancelled by staff or system; suppressed when the order event row records the customer as the actor | `order_updates` | normal | `order`, 4 h | |
| E4 | `awcms.commerce.order.expired` | same function, `to = expired`, run by the `commerce:orders:expire` job | Payment window elapsed | `payment_updates` | normal | `payment`, 4 h | |
| E5 | `awcms.commerce.refund.settled` | `settleRefundLeg` in `apps/cms/src/modules/commerce/application/refund-settlement.ts`; payload carries `orderId` | Refund leg reached `succeeded` | `payment_updates` | normal | `payment`, 12 h | One per leg |
| E6 | `awcms.commerce.return.recorded` | `createReturn` in `apps/cms/src/modules/commerce/application/return-directory.ts`; payload carries `orderId` | Goods accepted back | `order_updates` | normal | `order`, 12 h | |

Checked and **not** in the verified list:

- **Customer-inbox reply (named in #429's examples).** No domain event exists. `postStoreReply` in `apps/cms/src/modules/commerce/application/conversation-directory.ts` inserts the message and enqueues an e-mail in the same transaction, and appends no event. A push for it needs a new `commerce` event (proposed key `awcms.commerce.conversation.store_replied`, ids only) with its AsyncAPI entry and descriptor registration. It is a conditional **E7** in #432 (purpose `support_replies`, priority high), shipped only if the owner approves the new event (Q4). Until then the inbox and the e-mail are the channels.
- `order.created` (the shopper is looking at the confirmation), `payment.recorded` (partial legs; revisit with down-payment orders), `work_order.status_changed` (payload names a staff assignee, not the customer), `document.issued`, loyalty, voucher and flash-sale events (marketing in nature), and `quotation.*`.

**Opt-in, priority and rate policy.** No message is queued without an explicit `enabled` preference for its purpose. Priority only orders the claim (the provider sends no `Urgency` header today; section 12). Per account: at most 12 messages per rolling hour and 40 per rolling day; the `tag` coalesces repeats of one purpose on the device; TTL is the lesser of the policy value and the provider's four hours. Marketing is never produced by these events.

### 6.7 OpenAPI sketch (illustrative; the real fragment is #430's)

```yaml
/api/v1/commerce/storefront/account/push/subscriptions:
  get:
    security: [{ customerBearer: [] }]
    responses:
      "200": { content: { application/json: { schema: { $ref: "#/components/schemas/CustomerPushState" } } } }
      "401": { $ref: "#/components/responses/Unauthenticated" }
      "403": { description: ACCOUNT_BLOCKED }
      "404": { description: Neutral not found (feature off or unresolvable tenant) }
  post:
    security: [{ customerBearer: [] }]
    requestBody:
      required: true
      content:
        application/json:
          schema:
            type: object
            additionalProperties: false
            required: [endpoint, keys, consent]
            properties:
              endpoint: { type: string, maxLength: 2048 }
              keys:
                type: object
                additionalProperties: false
                required: [p256dh, auth]
                properties: { p256dh: { type: string }, auth: { type: string } }
              expirationTime: { type: [number, "null"] }
              consent:
                type: object
                additionalProperties: false
                required: [purposes, textVersion]
                properties:
                  purposes: { type: array, items: { enum: [order_updates, payment_updates, support_replies] }, minItems: 1 }
                  textVersion: { type: string, maxLength: 32 }
    responses:
      "200": { description: No-op re-registration }
      "201": { description: Registered or transferred to the caller }
      "409": { description: PUSH_UNAVAILABLE or DEVICE_LIMIT }
      "422": { description: VALIDATION_ERROR, ENDPOINT_NOT_ALLOWED or ORIGIN_NOT_ALLOWED }
      "429": { description: RATE_LIMITED, with Retry-After }
```

### 6.8 AsyncAPI sketch

No existing channel changes. The new consumers are declared in the `commerce` descriptor and are not AsyncAPI documents. If Q4 is approved, #432 adds one channel and the descriptor entry:

```yaml
awcms.commerce.conversation.store_replied:
  address: awcms.commerce.conversation.store_replied
  messages: { DomainEvent: { $ref: "#/components/messages/DomainEvent" } }
  description: >-
    A staff reply was added to a customer conversation. Producer: the commerce
    conversation directory's store-reply function, same transaction as the
    message. Aggregate: the conversation. Payload: conversationId only; never
    the subject, the body or the customer.
```

Operational metrics (not events): counts by message status (`queued`, `sending`, `sent` = provider accepted, `retry_wait`, `failed`, `cancelled`, `expired`), device status, `suppressed_rate_limit`. No metric is named "delivered".

## 7. UX contract (for #431)

- **Opt-in only.** The browser permission prompt and the registration happen only from a click on "Aktifkan Notifikasi" (en: "Turn on notifications") after the consent text is shown. Never on load, login, scroll or timer.
- **Client states** (decided by the storefront): unsupported (no Push API, an embedded web view): show the inbox only; iOS or iPadOS Safari tab (not installed): show the Add-to-Home-Screen guide for 16.4+; installed app, permission default: show the opt-in; permission denied: explain how to re-enable in system settings (the page cannot); permission granted, not enrolled for this account: opt-in without a second browser prompt; enrolled on this device; server capability off: hide the control.
- **Consent text** (versioned, localized, keyed by the tenant's store name): what is sent, the three purposes with individual toggles (all on by default is not allowed; the customer picks), that the lock screen shows generic text, that the message passes through the browser vendor's push service encrypted, and how to turn it off. Marketing is not offered in v1.
- **Never automatic.** After a login, the page never silently re-enrols a device. If permission is granted and the account has no device here, it shows the one-tap opt-in.
- **Logout and account switch.** Order of operations: (1) call logout with the old token and wait; (2) on success, call `unsubscribe()` best effort; (3) only then clear the stored session and let a new login store its own. On a network failure the page does not clear silently: it says the sign-out could not be confirmed and offers retry; the server still revokes at the next successful call, at session expiry, and by the registration transfer. A login over a stored session performs the same sequence for the old session first.
- **Failure messages.** 401: clear the session through the existing rule and show the sign-in page. 403: blocked or unverified message. 409 `DEVICE_LIMIT`: list devices and offer removal. 422 and 429: plain, localized text with `Retry-After`. 404: hide the control.
- **Accessibility.** Native `button` elements; focus moves to a status region that is `aria-live="polite"`; no state is conveyed by colour alone; usable at 360 px and by keyboard and screen reader; touch targets at least 44 px.
- **Inbox fallback.** The account inbox and orders pages (`apps/storefront/src/profil/toko/pages/akun/pesan.astro`, `apps/storefront/src/profil/toko/pages/akun/pesanan.astro`) remain the system of record. A click opens the fixed page; the page authenticates with the stored bearer before showing anything private.
- **Service worker** (#431): a first-party, unhashed file at a fixed URL on the storefront origin, scope `/`, served `max-age=0` (upstream's three reasons in the comment of `apps/cms/public/push-sw.js` apply); it reads both payload formats, always shows exactly one notification, resolves the click target against its own origin, never calls the API and never stores a token. It may share its parser with upstream's through a reviewed copy and a test that both agree.

## 8. Test strategy

IDs are reserved handles; #430 to #432 create the tests under those names. Layers: unit (U), HTTP surface (H), real PostgreSQL integration (I), static (S), contract (C), browser (E), physical device (D).

### 8.1 Acceptance criteria to tests

| Criterion | Tests |
| --- | --- |
| #429 DoR: signed-off ADR and cross-spec review | This ADR accepted; TS-C1 (OpenAPI parity and bundle, `api:spec:check`), TS-C2 (data dictionary and ERD updated), TS-C3 (i18n catalogue) in #430 to #432 |
| #429 DoR: at least five verified events and a policy | TS-EVT1: a test enumerates the policy table's event types and asserts each is in the commerce descriptor's published list and in the AsyncAPI file; a renamed or removed event turns it red |
| #429 DoR: four proofs | P1 to P4 below |
| #429 DoR: criteria to tests, threats to tests, issue trace | Sections 8.1, 2.2 and 11 |
| #429 DoR: template capability, profile-gated, not BjekMart-specific | TS-U6: every default is off; TS-E4: all three build profiles build, and profiles without customer accounts contain no push UI; TS-S2: no store-specific literals in the new files |
| #430: idempotent registration, no admin fallback | TS-I2 (re-register), TS-H1, TS-H2 |
| #430: cross-tenant, other-customer, guest, deleted or blocked, shared-browser transfer | TS-I1, TS-H1, TS-I2, TS-I4 |
| #430: genuine browser subscription sent through Bun Web Push; acceptance not conflated; no leak | TS-D1 (device), TS-I6, TS-H4 |
| #430: RLS, FORCE, FK, unique, worker grants, cleanup on real PostgreSQL; races | TS-I1, TS-I2, TS-I5, TS-I7 |
| #431: opt-in only; Safari tab guide; iOS closed-app push | TS-E2, TS-D1 |
| #431: two profiles isolated; logout and rebinding cannot leak | TS-E1 |
| #431: CSP first-party, 360 px, WCAG, translations | TS-E3, TS-E5 (a11y and layout), TS-C3 |
| #432: events, queue, worker trace; checkout never waits on a provider | TS-EVT1, TS-I5, TS-S3 (no network import in the consumer) |
| #432: one enqueue per dedupe key under replay; at-least-once attempts documented | TS-I5 |
| #432: no cross-tenant or account leak; tampered targets; marketing consent | TS-I4, TS-U1, TS-U2 |
| #432: failure, recovery, TTL, 404/410, rate limit | TS-I6, TS-I7 |

### 8.2 Threats to regression tests

| Test | Covers | What it proves |
| --- | --- | --- |
| TS-U1 | T13 | The event-to-purpose map is closed and has no path to `marketing`; consent policy |
| TS-U2 | T7, T8 | Origin validator (https, tenant domain, not the admin origin, no userinfo or path); target allowlist; `//host`, `/\host`, schemes and traversal rejected |
| TS-U3 | T9 | Endpoint validation: http, literal private address, oversize, host outside the allowlist |
| TS-U4 | T15 | Rendered text equals the template; no digits or codes from the order |
| TS-U5 | T2 | Strict schema: every client-chosen principal or content key is a 400 |
| TS-U6 | DoR | Defaults off |
| TS-H1 | T1, T2, T3, T12 | A matrix of credentials (none, malformed, staff cookie, staff bearer, machine token, expired, revoked, other-tenant `cs_`, blocked) over every route |
| TS-H2 | T1 | A `cs_` token on each `/api/v1/push/*` route is 401 |
| TS-H3 | T8, T19 | Preflight and ACAO for tenant origins only; no credentials header ever; `Vary`; `no-store` |
| TS-H4 | T11 | Sentinel endpoint, key and secret never appear in responses, logs, audit or errors |
| TS-H5 | T10 | Rate limits and `Retry-After` |
| TS-H6 | T18 | Feature off, unresolvable tenant, foreign device and absent device give indistinguishable bodies |
| TS-S1 | T1 | Static: the customer route files do not import the staff principal resolver or read cookies |
| TS-S3 | #432 | The consumer imports no network or provider code |
| TS-I1 | T3 | FORCE RLS, composite foreign keys across tenants, unique and CHECK constraints, worker column grants (cannot INSERT a device or rewrite endpoint columns) |
| TS-I2 | T4, T5 | Concurrent register of one endpoint by two accounts: one owner, queued messages cancelled, one audit event; register racing logout |
| TS-I3 | T6 | Logout revokes exactly that session's devices atomically; rollback on failure |
| TS-I4 | T4, T6, T12, T13 | Eligibility truth table: each of the nine predicates, flipped alone, makes the message ineligible and no provider call happens |
| TS-I5 | T10, T14 | Replay and double delivery give one row per dedupe key; concurrent dispatch; expired-lease re-claim; fan-out bounds |
| TS-I6 | T17 | Mock provider: 201 to `sent`; 404 and 410 to device `gone`; 429 and 5xx to `retry_wait`; permanent 4xx to `failed`; TTL expiry; breaker; status vocabulary |
| TS-I7 | Retention | Purge touches only terminal rows; credentials destroyed on non-active status; erasure deletes the account's rows; key re-rotation and fail-closed without the ring |
| TS-E1 | T6 | Two browser profiles; A signs out and B signs in on one profile; an account switch without logout; B never sees A's notification |
| TS-E2 | #431 | `Notification.requestPermission` is never called without a click |
| TS-E3 | T7, T16 | Service worker: both payload formats, empty-payload fallback, foreign-origin target rejected, no token access |
| TS-EVT1 | DoR | Policy event types exist in the descriptor and the AsyncAPI file |
| TS-C1, TS-C2, TS-C3 | DoR | OpenAPI parity and bundle; data dictionary and ERD; i18n catalogue |
| TS-S2, TS-S3 | DoR, #432 | No store-specific literals in the new files; the consumer imports no network or provider code |
| TS-E4, TS-E5 | DoR, #431 | All three build profiles build and only account-capable profiles carry push UI; 360 px and accessibility checks |
| TS-D1 | DoR | Physical iPhone (installed app), Chrome Android and desktop, Safari tab guide; recorded in the test matrix |

### 8.3 Proof obligations

- **P1 — No admin-cookie or bearer fallback.** *Layers:* the customer routes use only `requireCustomerSession` and never read a cookie (TS-S1); `looksLikeCustomerSessionToken` rejects anything without the `cs_` shape before a lookup; the staff push routes cannot resolve a `cs_` hash. *Proof:* TS-H1 and TS-H2 run every credential kind against every route in both directions; TS-S1 fails the build if a customer push route file gains a staff-principal import.
- **P2 — No push to another customer.** *Layers:* the account is derived from the order on the server (5.4), fixed on the message, equal to the device's account at send (I5), and never present in any request body; composite foreign keys keep device, account and tenant consistent. *Proof:* TS-I4 (account mismatch alone makes a message ineligible), TS-I2 (transfer cancels queued messages), TS-U5 (no client-chosen id).
- **P3 — No endpoint takeover on a shared device.** *Layers:* transfer is a locked, atomic, audited operation; recipient binding at send; destroyed credentials on revoke; generic text. The residual (a holder of the raw endpoint can silence the owner) is stated in T5 and is detectable. *Proof:* TS-I2, TS-I3, TS-E1.
- **P4 — No stale-subscriber disclosure on the same browser.** *Layers:* logout revokes the session's devices in the same transaction; delivery requires a live enrolling session; the client revokes before it replaces the stored session; a registration by the next account transfers the endpoint; the text is generic. *Proof:* TS-I3, TS-I4 (ended session alone makes a message ineligible), TS-E1 (browser-level, including the abnormal path where the logout call fails).

## 9. Migration, rollout and recovery

- **From the no-subscription state.** Everything is additive. Today no device or message exists, so there is no backfill. The migration creates empty tables and two additive unique constraints; the application is inert until the feature is on.
- **Gates (all must be on for any effect).** The module `commerce` enabled for the tenant; the commerce feature `customerPush` (a new flag, default **off**, like `loyalty`); `PUSH_ENABLED=true`; a VAPID key pair; the auth-secret key ring. A deployment missing the ring gets `reason: "push_not_configured"` and no registration, because there is no plaintext fallback. Profile gating: the storefront includes the control only in a profile with customer-account capability (typically `toko`).
- **Order of work.** (0) #427 sync brings the upstream code and migrations; (1) #430 migration and routes, behind the flag; (2) verify VAPID, ring, cron and `PUSH_SERVICE_WORKER_PATH` in staging by the operator test matrix; (3) #431 UI, flag-gated; (4) #432 consumers, flag-gated; (5) a pilot tenant, then others, each with a device UAT (iPhone installed app, Chrome Android and desktop) before production activation.
- **Kill switch and rollback.** Turn the flag off: routes answer the neutral 404, consumers skip, the dispatcher claims nothing, and existing devices become inert; run the revoke-all job to tombstone endpoints if the feature is being abandoned. Schema is additive and there is no down migration; roll the application forward rather than dropping tables. The inbox and e-mail paths never depend on push, so customers lose nothing but the banner.
- **Fallback to the inbox.** Always present. Denied permission, a gone endpoint, an expired session, an exhausted cap and a disabled feature all leave the inbox and the existing e-mail and WhatsApp channels as the way the customer learns of the change.
- **Key rotation.** Prepend a key to the ring, deploy, run the commerce re-key job (#430 provides it; upstream's re-key command covers only upstream's table), check readiness, retire the old key. A VAPID rotation invalidates every subscription: disable devices with reason `vapid_rotated`; the page notices the changed `applicationServerKey` and asks the customer to enable again.
- **Backup and restore.** Devices and sessions are restored together. After a point-in-time restore to an earlier moment, a logout that happened later is lost for both tables; treat all devices as suspect: run the revoke-all job and decide whether to revoke customer sessions too. Deploy the same ring keys that wrote the backup, or the ciphertext cannot be read.
- **Observability.** Counts by message and device status; alarms on a rising `failed` share, on `gone` spikes and on the breaker open state; never a "delivered" figure.

## 10. Regulatory mapping

This is an alignment of design controls with the requirements, not a claim of compliance or certification. Whether an endpoint URL is personal data is a legal judgment; the design treats it as such. Legal review of the consent text is the owner's (Q8).

| Reference | Theme | Design element |
| --- | --- | --- |
| UU PDP 27/2022 (Indonesian personal data protection law) | Lawful basis and explicit consent; purpose limitation; data minimisation; security of processing; the data subject's rights to withdraw consent and to erasure | Opt-in by explicit action with a versioned text; closed purposes; no order data on messages; encrypted auth secret, RLS, bearer isolation; one-tap withdrawal and per-purpose toggles; subject-data erasure registration; breach handling follows the platform runbook |
| PP PSTE 71/2019 (electronic systems and transactions) | Reliability and security of the electronic system; access control; audit trail | Default-deny customer routes, tenant isolation, audit events with ids only, logged administrative actions, availability through the inbox fallback |
| ISO/IEC 27001 | Information security management system | Threat register (2.2), controls, review cycle through ADR sign-off |
| ISO/IEC 27002 (2022 edition) | Access control (5.15), privacy and PII protection (5.34), information deletion (8.10), logging (8.15), cryptography (8.24) | Section 4, section 2.3, retention and purge (5.7), audit events, field encryption with purpose-bound AAD |
| ISO/IEC 27005 | Information security risk management | Section 2 is the risk identification and treatment input; open items are in Q1 to Q12 |
| ISO/IEC 27701 | Privacy information management (controller controls) | Consent capture and withdrawal, minimisation, retention windows, records of processing in the data dictionary |

## 11. Issue trace

| Issue | Implements from this ADR |
| --- | --- |
| #427 (sync) | Brings the upstream payload, key ring, field-encryption helper and ops matrix; verify the CMS-origin admin PWA does not subscribe shoppers |
| #428 (installability) | Storefront manifest and installability, a prerequisite for iOS push |
| #429 (this) | Decisions, threat model, contracts, tests and trace |
| #430 | Section 3 (tables, constraints, grants, retention, subject-data), section 4, sections 5.2, 5.3, 5.5, 5.6, 5.7 (dispatch, purge, re-key, session sweep), section 6.1 to 6.3 and 6.7 (routes, validation, CORS, rate limits, OpenAPI fragment), logout extension, block-path revocation, tests TS-U2, U3, U5, U6, H1 to H6, S1, I1 to I3, I6, I7, C1, C2 |
| #431 | Section 7 (consent copy, states, logout and switch sequence, service worker, inbox fallback), CSP check, tests TS-E1 to E5, TS-D1, TS-C3 |
| #432 | Sections 5.4, 6.4 to 6.6 and 6.8 (consumers, policy, generic text, dedupe, caps), the optional new event, AsyncAPI, metrics, tests TS-U1, U4, EVT1, S3, I4, I5, E1, D1 |

## 12. Proposed upstream issues (described, not filed)

Generic changes belong to `ahliweb/awcms` first and arrive through the subtree sync ([ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md) D3). None of them blocks #430 to #432.

- **U1 — a supported reuse surface for sibling modules.** Make the auth-secret encrypt and decrypt helpers take the AAD purpose as a parameter, expose a pure "build a push target from stored parts" function, and document the provider factory as a supported API. Removes the need for commerce to restate upstream's wiring.
- **U2 — per-message delivery options on `PushMessage`.** A validated navigate origin, a per-message TTL, and the RFC 8030 `Urgency` header derived from priority. Lets a sibling module target a non-`APP_URL` origin without creating a provider per origin.
- **U3 — a table-agnostic dispatch core.** Extract the claim, send and finalize state machine behind a small store interface so another outbox can reuse it. This removes the duplicated loop and satisfies #432's wish for one dispatcher.
- **U4 — a push-service host allowlist for endpoint validation** (configurable, with sensible defaults). Hardens the admin surface as well.
- **U5 — a neutral external-recipient abstraction (option A).** Only worth filing if U1 to U3 are adopted and a second consumer appears.

## Open questions for the owner

| ID | Question | Recommendation |
| --- | --- | --- |
| Q1 | Accept a thin commerce outbox now (option C), or wait for upstream option A? | C now, converge via U3 |
| Q2 | One auth-secret key ring with a purpose-bound AAD, or a separate ring for customers? | One ring, distinct AAD purpose; a commerce re-key job |
| Q3 | Customer push unsupported when storefront and CMS share an origin in v1? | Yes |
| Q4 | Approve a new `awcms.commerce.conversation.store_replied` event for inbox-reply push? | Yes, in #432 |
| Q5 | Notifications stop when the enrolling session lapses (30 days sliding)? | Yes (fail safe); revisit with usage data |
| Q6 | Default push-service host allowlist and who can override it? | Known vendor suffixes, operator environment override |
| Q7 | Limits: 5 devices per account, 12 per hour and 40 per day per account, registration limits | Accept as initial values |
| Q8 | Retention windows (30 days) and the consent and privacy wording, with legal review | Owner and counsel |
| Q9 | Tenant-editable templates in v1, or built-in generic text only? | Built-in only |
| Q10 | A staff diagnostics endpoint and its permission name in v1? | Aggregate counts only, `commerce.customer_push.read` |
| Q11 | Marketing push reserved and out of scope in v1? | Yes |
| Q12 | No click tracking in v1? | Yes |

## Decision summary

1. **D1.** Option C: commerce owns customer devices, consent and a thin outbox; upstream provider, crypto and policy code are imported, no upstream table is written; option A is the convergence path (section 12).
2. **D2.** The principal is derived from the `cs_` bearer; a device binds one endpoint to one account, one enrolling session and one validated storefront origin; guests receive no push.
3. **D3.** Registration of a known endpoint by another account is an explicit atomic transfer with cancellation of queued messages and an audit event; revocation and logout destroy credentials; delivery requires a live session.
4. **D4.** Click targets are fixed storefront paths on the device's stored, domain-validated origin; payloads are generic; no identifiers cross the push service.
5. **D5.** Four additive commerce tables with FORCE RLS and least-privilege grants; new flag `customerPush` default off; no plaintext secret column.
6. **D6.** Closed purposes; transactional only in v1; marketing reserved and never sent; verified events E1 to E6 drive notifications; the inbox reply (E7) waits for a real event.

## Consequences

- #430 to #432 can start once this ADR is accepted and #427 has landed; no upstream release is required.
- The commerce module gains a second dispatch loop. The duplication is bounded (everything below the queue is shared) and tracked for convergence; if the owner prefers A, #430 waits for the upstream work.
- Customer push depends on a live session: a customer unseen for 30 days stops receiving banners until they re-enable (Q5).
- Providers receive only encrypted, generic content; the system cannot say whether a banner was displayed or read.
- Each deployed derived application carries its own VAPID and ring; rotating either is an operator procedure, not a code change.

## What is not here yet

- Marketing push (needs its own consent flow, audience and ADR), tenant-editable templates, click and read analytics, native (FCM/APNs) customer apps, a customer-account deletion flow, a staff UI for customer devices, and the inbox-reply event (Q4).
- No implementation exists: no table, route, consumer, worker job, service worker or UI. This ADR is the Definition of Ready for #430, #431 and #432.
