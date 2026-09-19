🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.id.md)

# ADR-0016 — Customer accounts are OTP-verified `commerce` accounts with bearer sessions

- **Status:** Accepted
- **Date:** 19 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md), [ADR-0009](0009-guest-checkout-by-order-code-and-phone.md); issues #32, #86, #87–#93

## Context

`apps/storefront` is 100% static ([ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md)): the browser calls `apps/cms` directly and `apps/storefront/server/penyaji.mjs` holds no session. `apps/cms`'s `awcms_principals` is the **staff** credential store — global, RLS-free, guarded by `identity:principal-access:check` — never meant to authenticate an anonymous shopper. No WhatsApp/SMS channel exists in this codebase today; `email` does. Guest checkout ([ADR-0009](0009-guest-checkout-by-order-code-and-phone.md)) already keys `awcms_commerce_customers` by phone, with no credential at all — tracking is order code + phone.

Issue #32 (customer accounts, synced wishlist/addresses/reviews, the affiliate program) needs a real identity, a real login, and a real session, on top of that same table, without inheriting any of the staff surface's assumptions (an e-mail on every row, a password to reset, a lockout policy shared with an administrator). This ADR is wave 0 of #32: it records the four architectural decisions (D1–D4), the affiliate program's shape (D5), and what stays deliberately out of scope (D6) — the OpenAPI contract that follows from them ships in the same change (issue #86), documented ahead of its handlers so C2–C4 (issues #87–#93) code against a contract already argued and settled.

## Decision

### D1 — Identity: a `commerce` row, never `awcms_principals`

A customer account is a row in the `commerce` module (`awcms_commerce_customer_accounts`, tenant-scoped, `FORCE ROW LEVEL SECURITY`), bound 1:1 to `awcms_commerce_customers`. **No password, ever** — no second password store, and no link to `awcms_principals`.

| Dimension | **A `commerce` row, no principal link (chosen)** | Link to `awcms_principals` |
| --- | --- | --- |
| Security | New surface stays inside `commerce`'s own RLS boundary; a compromise of the anonymous customer surface cannot reach a staff credential row | Exposes the staff credential table — global, RLS-free — to the anonymous surface; a bug in the customer path becomes a staff-credential bug |
| Performance | One join (`customer_accounts` → `customers`) already on the hot checkout path | An extra join into a global, unindexed-for-this-purpose table on every customer request |
| Maintainability | `commerce` owns its own lifecycle end to end; no cross-module coupling to reason about | Every staff-auth change (lockout, MFA, SSO) must be re-audited for "does this affect a customer too" |
| Scalability | Scales with `commerce`'s own tenant-scoped tables | `awcms_principals` is intentionally global; growth of one customer base pressures a table every tenant shares |
| Accessibility | No effect either way | No effect either way |
| SEO | No effect either way | No effect either way |
| UI/UX | A customer never sees a staff-shaped login (MFA prompts, session-tenant switcher) | Staff UI concepts (tenant switch, MFA enrolment) leak into a shopper's login unless specifically suppressed everywhere |
| Compatibility | Matches ADR-0009's own row (`awcms_commerce_customers`) — this is that row's next chapter, not a parallel identity | None of the legacy site's customer identity carries a principal equivalent to link to |
| Operational complexity | One additional table, owned and migrated by `commerce` alone | Needs exemptions threaded through every upstream identity gate (`identity:principal-access:check` and friends) to keep an anonymous customer from being treated as staff |
| Long-term | A customer never needs an e-mail to exist (D2's WA follow-up stays open) | Forces an e-mail onto every customer today, foreclosing a phone-only account later |

### D2 — Channel: e-mail OTP now, WhatsApp as a follow-up

Authentication is a 6-digit **e-mail OTP** (hashed, 10 minute TTL, 5 attempts, single use) sent through the `email` module outbox under a new derived template category `derived.commerce_customer_otp`. A `CustomerOtpChannel` port defines `email` and `log` adapters; a WhatsApp adapter is a follow-up under #33.

| Dimension | **E-mail OTP now (chosen)** | WhatsApp/SMS OTP now | Password (ADR-0009-style reset) |
| --- | --- | --- | --- |
| Security | Reuses the `email` module's existing outbox, template, and delivery-failure handling — one less new surface to audit | A vendor credential (WA Business API / SMS gateway) is a new secret to rotate and a new place to leak one | Reintroduces the whole reset/forgot/lockout surface ADR-0009 deliberately avoided for guest checkout |
| Performance | Delivery latency bound by the existing outbox's own SLOs, already measured | Unmeasured in this codebase; a new provider's latency and retry behaviour is unknown until integrated | No delivery latency, but adds a password-hashing cost (bcrypt/argon2) to every login |
| Maintainability | One port (`CustomerOtpChannel`), one adapter shipped (`email`), a `log` adapter for tests/CI | A second adapter shipped before it can be tested end to end in CI (no vendor sandbox available here) | A second, parallel credential-lifecycle state machine to maintain beside D3's sessions |
| Scalability | `email` already scales to the tenant volumes this repo seeds | Provider rate limits are unknown and untested at this repo's scale | Scales fine, but the surface it reopens (reset tokens, lockouts) scales the operational burden, not the throughput |
| Accessibility | A code a screen reader announces cleanly from an inbox; no new client-side widget | Same, if a WA/SMS inbox is available; not everyone has one at checkout time | A password field is a known accessible pattern, but adds a "forgot password" flow with its own accessibility surface |
| SEO | No effect either way | No effect either way | No effect either way |
| UI/UX | One familiar "enter the 6-digit code" step BjekMart shoppers already expect from e-mail-based tools | Matches how most BjekMart shoppers actually communicate (WhatsApp), a real UX loss deferred to #33 | An extra field to remember, and a "forgot password" detour the whole codebase has avoided so far |
| Compatibility | `email` already exists in this codebase; nothing new to provision | Nothing in this codebase talks to a WA/SMS provider yet | Matches the legacy site's own login, but re-imports the exact surface ADR-0009 rejected for guest checkout |
| Operational complexity | Zero new vendor relationship | A new vendor account, credential, and CI gap (untestable without live secrets) | A support inbox for "I forgot my password" from day one |
| Long-term | The `CustomerOtpChannel` port makes a WA adapter additive later, not a rewrite | Ships the UX goal today, at the cost above, before it can be verified in CI | Every future decision (accounts, sessions) inherits password-reset's edge cases permanently |

### D3 — Session transport: opaque bearer token, `localStorage`, 30-day sliding TTL

Sessions are **opaque bearer tokens** (`cs_` + 32 random bytes base64url; only `sha256:` stored in `awcms_commerce_customer_sessions`), sent as `Authorization: Bearer`, kept in `localStorage`, 30-day sliding TTL, revoked on logout. CORS: `Authorization` joins `Access-Control-Allow-Headers`; **still no `Access-Control-Allow-Credentials`**.

| Dimension | **Bearer token in `localStorage` (chosen)** | `SameSite=None` cookie on the CMS origin |
| --- | --- | --- |
| Security | Never sent implicitly cross-site (no ambient authority), so no new CSRF surface; token theft (XSS) is the residual risk any bearer scheme carries | Requires `Access-Control-Allow-Credentials` plus a CSRF token scheme on every mutating route — a bigger surface added to a contract that has none of it today |
| Performance | One `Authorization` header, no extra preflight beyond what `X-AWCMS-Tenant-ID`/JSON content type already require | Cookie jars add per-request overhead and interact with browser partitioning caches in ways a header does not |
| Maintainability | Symmetric with how `bearerAuth` already works for staff sessions — no second authentication code path shape to maintain, only a second scheme instance (`customerBearer`) | A cookie-based flow needs its own CSRF middleware, its own SameSite/Secure/HttpOnly matrix per environment, and its own local-dev story (`localhost` vs a real domain) |
| Scalability | Stateless to verify per request beyond one indexed lookup on `token_hash` | Same lookup cost, plus session-affinity assumptions cookies sometimes invite at the infra layer |
| Accessibility | No effect either way | No effect either way |
| SEO | No effect either way | No effect either way |
| UI/UX | Survives a page reload exactly like the guest cart already does (same storage mechanism shoppers' browsers already hold state in) | Third-party-cookie blocking (already shipping in real browsers) silently logs a shopper out whenever the CMS and the storefront are different origins — which ADR-0007 says they always are |
| Compatibility | Works identically whether `apps/storefront` and `apps/cms` share a domain or not — the exact cross-origin shape ADR-0007 already committed to | Breaks specifically in the cross-origin case ADR-0007 chose; would require same-site deployment as an undocumented precondition |
| Operational complexity | No `Access-Control-Allow-Credentials`, so the existing Origin-allowlist CORS posture is unchanged | Turns on credentialed CORS, which drops the ability to answer a preflight with a wildcard/simple-allowlist origin check and forces per-request Origin echoing everywhere |
| Long-term | A native mobile client or a future SSR storefront can reuse the identical bearer scheme with no cookie-jar assumptions | Locks any future non-browser client (a mobile app, a future SSR client) into cookie-jar semantics that do not exist there |

### D4 — Registration binds to an existing guest row only when the e-mail also matches

Registration requires name + phone + e-mail. If the phone already exists as a guest customer (`awcms_commerce_customers`, ADR-0009), the account binds to that row, but `history_from` = that row's `created_at` **only if** the guest row's e-mail equals the verified e-mail; otherwise `history_from` = now, and older orders stay reachable by code + phone only.

Rejected: free claim by phone alone (an attacker who merely learns a phone number could see its address/order history — an address/history leak); refusing the bind outright (a `409` distinguishing "this phone already ordered" from "it never did" is itself a phone-enumeration oracle). The chosen middle path (bind silently, but gate history disclosure on a second factor already proven — the verified e-mail) gives the account its continuity when it is genuinely earned and degrades to "orders from today forward" — never a leak — when it is not.

### D5 — Affiliate program, designed fresh

Legacy columns were never recorded, so `awcms_commerce_affiliates` and `awcms_commerce_affiliate_commissions` are new tables. `?ref=` is captured by the storefront and sent at order creation; a commission row is created when an order reaches `completed`; self-referral yields none; staff approve/pay.

### D6 — Explicitly out of scope (follow-ups)

Tiered pricing by `level` at quote time, phone verification, WhatsApp OTP (D2's follow-up), and e-mail/phone change on an existing account. None of these blocks wave 0's contract; each is a strict addition to it later.

## Options considered

See the three tables under D1–D3 above for the full dimension-by-dimension comparison. Summarised:

| Option | Why not (or why chosen) |
| --- | --- |
| **`commerce`-owned account, e-mail OTP, bearer token** (chosen) | Stays inside the module boundary this codebase already trusts for anonymous traffic (ADR-0007/0009), reuses the `email` outbox that already exists, and needs no new CORS credential posture |
| Link the account to `awcms_principals` | Forces an e-mail onto every customer, exposes the global staff credential table to the anonymous surface, and needs bespoke exemptions in every upstream identity gate |
| WhatsApp/SMS OTP today | A vendor credential this repo cannot provision or test in CI yet — deferred to #33 rather than shipped untestable |
| Password + reset/forgot | Reopens exactly the surface ADR-0009 chose guest checkout to avoid, and shares none of D3's stateless-token benefits |
| `SameSite=None` session cookie | Breaks under third-party-cookie blocking whenever the CMS and the store are different origins, which ADR-0007 already committed to being the normal case, and opens a CSRF surface this contract does not otherwise have |
| Free phone-based account claim (D4) | An address/order-history leak to anyone who merely knows a phone number |
| Refuse phone-based binding outright (D4) | Turns the registration endpoint into a phone-enumeration oracle |

## Consequences

- The OpenAPI contract landing in the same change (issue #86) documents every path under `/api/v1/commerce/storefront/account/*` plus the staff-side `/api/v1/commerce/affiliates*` routes, using `ROUTE_PARITY_EXEMPTIONS` in `apps/cms/scripts/api-spec-check.ts` because no route file exists yet — each exemption is removed the moment its own handler lands (C2–C4, issues #87–#93).
- `customerBearer` is a security scheme deliberately separate from the staff `bearerAuth`/session schemes: a customer token is refused wherever `bearerAuth` is required, and vice versa, so the two credential spaces can never be confused by a caller or by a future contributor reading the spec.
- `POST /storefront/orders` and `POST /storefront/reviews` (ADR-0009's own anonymous endpoints) gain an *optional* bearer and, for orders, an optional `affiliateCode` — additive fields only, so the frozen `awcms-astro` consumer-contract snapshot and the pre-migration snapshot both stay satisfied.
- A guest who never registers loses nothing: every anonymous path ADR-0009 shipped is unchanged, and D4's binding rule only ever adds continuity, never removes access to an order a guest can already reach by code + phone.
- `store_settings.affiliate_commission_rate` being `null` is the affiliate program's own off switch (`409 AFFILIATE_PROGRAM_DISABLED` at enrolment) — a tenant that never sets it never exposes the affiliate surface to a shopper, matching how other optional `commerce` marketing surfaces (vouchers, flash sales) are already tenant-configurable.
- No handler exists yet for any of D1–D5's endpoints; this ADR and its OpenAPI contract are the reviewed target C2 (accounts/OTP/sessions), C3 (addresses/wishlist/orders/reviews) and C4 (affiliates) build against, not a description of running code.
