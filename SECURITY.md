🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](SECURITY.id.md)

# Security Policy

## Reporting a vulnerability

**Do not open a public issue for an exploitable vulnerability.**

Report it through [GitHub Security Advisory](https://github.com/ahliweb/awcms-one/security/advisories/new) (a private route). Include reproduction steps, the impact you estimate, and the commit you tested.

We aim for an initial response within **3 working days** and a fix for a confirmed vulnerability within **14 working days**, depending on severity.

## Five surfaces, reported the same way but owned differently

This repo is a monorepo, and today it holds five real attack surfaces plus the machinery around them:

- **`apps/cms`** — `ahliweb/awcms`, embedded whole via `git subtree`. It is this platform's system of record: the database, authentication, authorization (RBAC/ABAC), and every module that stores commerce data — including, since increment 4, the customer-account/OTP/session tables and the increment-5 provider integrations. A vulnerability found in its code, as it stands in this repository, is reported here (GitHub Security Advisory on `ahliweb/awcms-one`), because that is where the affected code actually runs. [`apps/cms/SECURITY.md`](apps/cms/SECURITY.md) (carried over from upstream) documents that surface's own specifics in more depth. If the same defect is unpatched in current `ahliweb/awcms` too, report it there as well, since other deployments of that project share it — this repo's own copy is fixed here regardless, following the subtree pull described in [`AGENTS.md`](AGENTS.md#the-subtree-embed).
- **`apps/storefront`'s anonymous commerce surface** — since increment 2, a shopper's browser calls `apps/cms`'s anonymous, cross-origin `/api/v1/commerce/storefront/*` endpoints directly, for cart quoting, order creation, order tracking, payment confirmation, cancellation, and reviews. See "The storefront's anonymous surface" below for the protections in force. This code lives in `apps/cms` (the endpoints themselves) and `apps/storefront` (the client calling them); a vulnerability in either is reported here.
- **`apps/storefront`'s authenticated customer surface** — since increment 4 ([ADR-0016](docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md), [issue #32](https://github.com/ahliweb/awcms-one/issues/32)), an OTP-verified shopper's browser holds a bearer session and calls `apps/cms`'s `/api/v1/commerce/storefront/account/*` resources directly — login/registration, profile, addresses, wishlist, order history, reviews, and the affiliate program. See "The storefront's authenticated customer surface" below for the protections in force. This code lives in `apps/cms` (the endpoints themselves) and `apps/storefront` (`apps/storefront/src/lib/akun-sesi.ts`/`akun-klien.ts`, the session client); a vulnerability in either is reported here.
- **`apps/cms`'s provider and webhook surfaces** — since increment 5 ([ADR-0017](docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md), [issue #33](https://github.com/ahliweb/awcms-one/issues/33)), `commerce` owns a set of provider-facing ports and adapters (a Midtrans Snap payment gateway with token-addressed public webhook intake, a WhatsApp OTP outbox via Fonnte/Meta Cloud API, a RajaOngkir courier-rate cache) that an external service calls into, or that call out to one. See "Provider and webhook surfaces" below for the protections in force.
- **The workspace root** (`packages/gerbang/`, `tools/`, `tests/`) — build and release tooling, not a running service. It has no network listener, no database connection, and no user-facing surface at all; its only external interaction is spawning `git` as an argv array (never through a shell — see `packages/gerbang/lib/git.mjs`). A vulnerability class here looks like a script that can be made to write outside the repo, or one that would execute something an attacker controls (a hostile branch name, a hostile changeset file name) — report it the same way, here.

`apps/storefront`'s *served* container — everything except the anonymous commerce surface above — remains what [ADR-0002](docs/adr/0002-static-output-with-build-time-fetch-for-the-storefront.md) describes: a static-file server with no database connection and no `apps/cms` credential of any kind, so a compromise of the container itself reaches no customer data — see [`docs/arsitektur.md`](docs/arsitektur.md).

## The storefront's anonymous surface: what protects it

[ADR-0007](docs/adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) is the design decision; this section is the control list, for a security reader who wants it without reading the ADR's own trade-off argument:

- **Origin-bound tenant resolution, not a header the caller controls.** Every request's tenant is resolved from its `Origin`/`Host` against `awcms_tenant_domains` — an unregistered origin gets the same neutral refusal an unknown order gets. No cookie, no bearer token, ever (`mode: "cors"` / `credentials: "omit"` on every client call).
- **Rate limits** per IP on every route, and per normalised phone number additionally on order creation.
- **Neutral responses wherever a distinguishing one would leak.** `GET .../orders/{code}?phone=` answers a byte-identical `404` for an unknown order code, a right code with the wrong phone, and another tenant's order — never three different responses an attacker could use to enumerate valid order codes or phone numbers.
- **Idempotency on order creation**, via the shared `awcms_idempotency_keys` store — a double-submitted "place order" click cannot create two orders.
- **No write path for money that is not reviewed by a person.** A payment confirmation moves an order's `paymentStatus` only after an admin's explicit `accepted`/`rejected` decision; there is no automated acceptance path in this increment (see [ADR-0010](docs/adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md)).
- **The derived CSP**: `connect-src` names only `PUBLIC_AWCMS_ORIGIN`, re-validated by `apps/storefront/server/penyaji.mjs` at every server startup independently of the build that produced it, falling back to a `'self'`-only baseline on any missing or malformed artifact — see [`docs/arsitektur.md`](docs/arsitektur.md).
- **No PII stored by the storefront itself.** An order, a phone number, a payment instruction all travel browser ↔ CMS directly; the storefront container never sees any of it and cannot log what it never receives.
- **`apps/cms`'s machine credentials remain read-only by construction** — the build-time `AWCMS_API_TOKEN` could not create an order even if it leaked; every commerce read it is scoped to is, by definition, non-destructive.

## The storefront's authenticated customer surface: what protects it

[ADR-0016](docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) is the design decision; this section is the control list:

- **Non-ambient bearer tokens, not a cookie.** A customer session is an opaque, `cs_`-prefixed token, stored `sha256:`-hashed at rest in `awcms_commerce_customer_sessions` — the plaintext token exists only at issuance and in the browser. It is sent as `Authorization: Bearer` on every authenticated call and kept in `localStorage` under the key `awcms-one:akun:v1`. There is never a `Set-Cookie` for it, and CORS never gains `Access-Control-Allow-Credentials` on this route family (`apps/cms/src/modules/commerce/domain/commerce-cors.ts`) — the browser never sends this token anywhere automatically, so there is no CSRF exposure to defend against on these routes.
- **The residual risk is XSS, not CSRF, and it is stated plainly.** Because the token lives in `localStorage`, script injected into the storefront origin (a supply-chain compromise of a bundled dependency, for instance — there is no user-authored content rendered as HTML on this static site) could read and exfiltrate it, and a stolen token is usable until it expires or is revoked. The mitigation is a strict Content-Security-Policy on the storefront (see "The derived CSP" above) that constrains what a successfully injected script could still reach, not a claim that the token is unstealable. This is the ordinary trade-off of a non-ambient bearer credential in a browser and is unchanged by anything in this increment.
- **A `401 UNAUTHENTICATED` from any bearer-secured route clears the stored session client-side** (`apps/storefront/src/lib/akun-klien.ts`'s `denganPembersihanSesi`) — a token revoked or expired server-side never keeps being retried once the CMS has said no.
- **OTP issuance is rate-limited two ways at once**: per requesting IP, and per normalised e-mail/phone identifier (`apps/cms/src/modules/commerce/domain/otp-rate-limit-key.ts`) — an attacker who rotates IPs still cannot flood one mailbox or WhatsApp number, and one that owns many mailboxes still cannot flood one IP's ceiling.
- **A stored OTP code is hashed, never plaintext, and capped at 5 guesses** (`OTP_MAX_ATTEMPTS`, `apps/cms/src/modules/commerce/domain/customer-otp.ts`) — the rate limits above are the first line of defence; this attempt cap is what actually stops a code from being guessed once a request has gone through.
- **`GET/PATCH account/me` accepts no e-mail/phone change today** (`PATCH` takes only `{name}`) — account-recovery-by-takeover through an unverified identifier change is not a surface that exists yet; see "What is NOT yet true" below.

## Provider and webhook surfaces: what protects them

Since increment 5 ([ADR-0017](docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)), `commerce` owns a set of provider-facing ports, each with its own inbound or outbound network boundary:

- **Payment gateway (Midtrans Snap)**: the public intake route is `POST /api/v1/commerce/webhooks/{provider}/{endpointToken}` — no session, addressed instead by a per-tenant opaque token in the path, hashed at rest the same way a customer session is. An unknown/revoked token, a `{provider}` mismatch, or no provider configured all answer the *same* neutral `404`, padded to a minimum latency so "token exists but mismatched" cannot be timed apart from "token does not exist". A verified signature is required before any state change (`provider.verifyWebhook`; a bad signature is `401`); the route is additionally rate-limited per IP (`COMMERCE_WEBHOOK_RATE_LIMIT_MAX`, default 120 requests/60s). Replay is a structural no-op — `INSERT … ON CONFLICT (tenant_id, provider, event_key) DO NOTHING` — and every provider-reported amount is checked against the order's own total in integer cents before any order transition (the amount guard, `apps/cms/sql/934_awcms_commerce_payment_events_amount_mismatch.sql`) rather than trusted at face value. `commerce:payments:reconcile` (`*/2 * * * *`) independently re-polls any gateway session still pending past its own short window, so the webhook is never the only path to a correct final state.
- **WhatsApp OTP outbox (Fonnte / Meta Cloud API)**: outbound only — this platform never accepts an inbound WhatsApp webhook. The same per-IP/per-identifier OTP rate limits and hashed, attempt-capped codes described above apply regardless of which channel (e-mail or WhatsApp) delivered the code; WhatsApp is a login-only channel for an existing account, never a registration path.
- **RajaOngkir courier rates**: outbound only, credentialed by a server-held env var, with rates cached rather than fetched live on every quote — no caller-supplied input reaches the provider credential.
- **Campaign targeting stays consent-gated**: a customer account is only a marketing-campaign recipient when its own `marketing_consent_at` column is non-null (`apps/cms/src/modules/commerce/application/customer-auth.ts`) — there is no default-on or admin-forced enrolment path.

## Controls in force today

- **No secret, token, or credential** in code, commits, issues, or documentation.
- **Automated scanning in force**: CodeQL code scanning for JavaScript/TypeScript (`.github/workflows/codeql.yml`, issue #184, part of epic #179) on every push to `main`, every pull request, and weekly; GitHub secret scanning and secret-scanning push protection; Dependabot security updates — all three verified enabled via `gh api repos/ahliweb/awcms-one --jq '.security_and_analysis'` (see `docs/alur-kerja-pengembangan.md`'s "Branch protection on `main`"). CodeQL's `apps/cms/**` SOURCE stays in scope, deliberately — see "Five surfaces" above; a resulting alert there is triaged the same way any other finding on that tree is: fixed here only if it falls inside AGENTS.md's documented local divergences or this repository's own `commerce` module, otherwise reported to (and fixed in) `ahliweb/awcms` and pulled in through the normal subtree sync. CodeQL is not yet a required status check — see `docs/alur-kerja-pengembangan.md`'s "CI: a fifth workflow, not required — `codeql`".
- **`bun audit` must report zero vulnerabilities** before a release (`tools/rilis.mjs` runs it before applying); `bun audit --audit-level=low` also runs on every CI push.
- **GitHub Actions are pinned to a commit SHA**, not a tag — see `AGENTS.md`'s "Configuration and toolchain".
- **A `git subtree pull` PR is merged with a merge commit, never squashed or rebased** — not a security control against an external attacker, but a control against corrupting this repo's own ability to pull upstream security patches into `apps/cms` in the future. Since issue #149 this is mechanically enforced repository-wide (`allow_squash_merge=false`, `allow_rebase_merge=false`), not only a reviewer's own memory. See `AGENTS.md`'s "The subtree embed".
- **RLS `ENABLE`+`FORCE` on every tenant-scoped table**, including every `awcms_commerce_*` table added since increment 2 — see [`docs/skema-basis-data.md`](docs/skema-basis-data.md) for the current, exact table list rather than a count repeated here that a later migration would make stale.

## CodeQL triage

**Where alerts appear.** CodeQL's findings land on the repository's [Security → Code scanning alerts](https://github.com/ahliweb/awcms-one/security/code-scanning) tab and are readable/writable via `gh api repos/ahliweb/awcms-one/code-scanning/alerts` — the same API this section's own triage record was produced with (issue #206). An alert is not itself a defect report; it is a starting point that must be read against the actual flagged line before any action is taken.

**The `security-extended` query suite is kept deliberately**, not widened to upstream `ahliweb/awcms`'s own `security-extended,security-and-quality` — see `docs/alur-kerja-pengembangan.md`'s "CI: a fifth workflow, not required — `codeql`" for why this repository starts narrower than the tree it embeds.

**How an alert on `apps/cms/**` is triaged.** That tree is upstream's own source, carried here via subtree (see `AGENTS.md`'s "The subtree embed"), so the first question is never "is this a real bug" but "whose code is this": an alert on ordinary upstream code is reported to (and fixed in) `ahliweb/awcms` and pulled in through the normal subtree sync, never patched locally in a way a future `git subtree pull` would conflict with; an alert on this repository's own additive `commerce` module code (`apps/cms/src/modules/commerce/**` and the handful of other local divergences `AGENTS.md` names) is this repository's own to fix or dismiss, following the same verify-before-dismiss discipline as everywhere else.

**Two standing rules a future reader must not re-litigate.** Issue #206's triage dismissed thirteen of the fifteen alerts open on `main` at the time as false positives / won't-fix / test-only, verified line by line against the flagged code rather than accepted on the tool's word. Two of the findings it dismissed rest on rules worth stating outright, so nobody "fixes" them again later:

1. **A SHA-256 hash over a high-entropy random token (`randomBytes(32)`) is not a password hash**, and must not be replaced with a slow key-derivation function (argon2/bcrypt/scrypt). A KDF's cost buys resistance against an attacker guessing a low-entropy, human-chosen secret; a 256-bit CSPRNG value has no guessable structure to resist, so the added cost defends nothing while making every verification slower. This is why `js/insufficient-password-hash` is a false positive on `apps/cms/src/lib/auth/mfa-challenge-token.ts`'s `hashChallengeToken` and `apps/cms/src/lib/auth/oauth-state-token.ts`'s `hashOAuthState` — both hash a `randomBytes(32)` token, the same accepted shape as `session-token.ts`'s `hashSessionToken`.
2. **`computePkceChallengeS256` (`apps/cms/src/lib/auth/oauth-state-token.ts`) implements RFC 7636 §4.2**, which specifies the PKCE `code_challenge` as `base64url(sha256(code_verifier))` — SHA-256 is not a weak choice here, it is the mandated one. Swapping it for a slower hash would not harden anything; it would produce a `code_challenge` the OAuth provider's own S256 verification no longer accepts, breaking login.

**The dismissed alerts, by rule ID** (full reasoning and the exact `dismissed_comment` for each are on the alerts themselves, via the API above):

| Rule ID | Count | Files | Reason used |
| --- | --- | --- | --- |
| `js/insufficient-password-hash` | 3 | `apps/cms/src/lib/auth/mfa-challenge-token.ts`, `oauth-state-token.ts` (×2) | false positive |
| `js/file-access-to-http` | 4 | `tools/seed-cms.ts` | false positive |
| `js/file-system-race` | 2 | `tools/rilis.mjs`, `tools/knowledge-graph-update.mjs` | won't fix |
| `js/file-system-race` | 1 | `tests/knowledge-no-subtree-write.test.mjs` | used in tests |
| `js/reflected-xss` | 1 | `apps/storefront/tests/penyaji-bayangan-html.test.ts` | used in tests |
| `js/incomplete-url-substring-sanitization` | 1 | `apps/storefront/tests/profil-build-smoke.test.ts` | false positive |
| `js/clear-text-logging` | 1 | `tools/seed-cms.ts` (the generated owner password, printed once and labelled "SHOWN ONCE, not stored", for the local dev operator who needs it) | won't fix |

**Not dismissed.** Two further `js/clear-text-logging` alerts on `apps/cms/scripts/commerce-deploy-preflight.ts` are real findings, not false positives, and are fixed as code by a sibling change rather than dismissed here.

## What is NOT yet true, stated plainly

**There is no live production deployment of this platform yet.** See [`docs/deployment.md`](docs/deployment.md) for exactly what is and is not provisioned; there is no running system at `mart.borneojek.com` for this repo's own code to expose. A reproducible production topology and a fail-closed preflight now exist ([ADR-0019](docs/adr/0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md), `docs/deployment.md`'s "Production runbook") — the sentence above is about whether anything is actually running yet, not whether a documented path exists.

**Customer accounts, OTP login, and bearer sessions DO exist** ([issue #32](https://github.com/ahliweb/awcms-one/issues/32), [ADR-0016](docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)) — see "The storefront's authenticated customer surface" above for the surface itself and its controls. What ADR-0016's own D6 explicitly deferred, and is still not here: changing e-mail or phone on an existing account, and phone verification. A Xendit payment-gateway adapter and courier tracking are named as explicit follow-ups behind the existing provider ports in [ADR-0017](docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md), and are not built yet.

## Not a security vulnerability

The following matter, but are not security reports — use an ordinary issue, or the routes in [`SUPPORT.md`](SUPPORT.md):

- A defect in `apps/cms` that is purely `ahliweb/awcms`'s own general-purpose behaviour, unrelated to this platform's commerce work.
- A missing feature, or a gap between the borneojek-mart source schema and what has landed here so far — see [issue #21](https://github.com/ahliweb/awcms-one/issues/21) for what is in scope for the current increment.
