🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](SECURITY.id.md)

# Security Policy

## Reporting a vulnerability

**Do not open a public issue for an exploitable vulnerability.**

Report it through [GitHub Security Advisory](https://github.com/ahliweb/awcms-one/security/advisories/new) (a private route). Include reproduction steps, the impact you estimate, and the commit you tested.

We aim for an initial response within **3 working days** and a fix for a confirmed vulnerability within **14 working days**, depending on severity.

## Three surfaces, reported the same way but owned differently

This repo is a monorepo, and today it holds three real attack surfaces plus the machinery around them:

- **`apps/cms`** — `ahliweb/awcms`, embedded whole via `git subtree`. It is this platform's system of record: the database, authentication, authorization (RBAC/ABAC), and every module that stores commerce data. A vulnerability found in its code, as it stands in this repository, is reported here (GitHub Security Advisory on `ahliweb/awcms-one`), because that is where the affected code actually runs. [`apps/cms/SECURITY.md`](apps/cms/SECURITY.md) (carried over from upstream) documents that surface's own specifics in more depth. If the same defect is unpatched in current `ahliweb/awcms` too, report it there as well, since other deployments of that project share it — this repo's own copy is fixed here regardless, following the subtree pull described in [`AGENTS.md`](AGENTS.md#the-subtree-embed).
- **`apps/storefront`'s anonymous commerce surface** — since increment 2, a shopper's browser calls `apps/cms`'s anonymous, cross-origin `/api/v1/commerce/storefront/*` endpoints directly, for cart quoting, order creation, order tracking, payment confirmation, cancellation, and reviews. See "The storefront's anonymous surface" below for the protections in force. This code lives in `apps/cms` (the endpoints themselves) and `apps/storefront` (the client calling them); a vulnerability in either is reported here.
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

## Controls in force today

- **No secret, token, or credential** in code, commits, issues, or documentation.
- **`bun audit` must report zero vulnerabilities** before a release (`tools/rilis.mjs` runs it before applying); `bun audit --audit-level=low` also runs on every CI push.
- **GitHub Actions are pinned to a commit SHA**, not a tag — see `AGENTS.md`'s "Configuration and toolchain".
- **A `git subtree pull` PR is merged with a merge commit, never squashed or rebased** — not a security control against an external attacker, but a control against corrupting this repo's own ability to pull upstream security patches into `apps/cms` in the future. See `AGENTS.md`'s "The subtree embed".
- **RLS `ENABLE`+`FORCE` on every tenant-scoped table**, including all eighteen commerce tables added in increment 2 — see [`docs/skema-basis-data.md`](docs/skema-basis-data.md).

## What is NOT yet true, stated plainly

**There is no live production deployment of this platform yet.** `compose.yaml`'s `postgres:18.4` is a local/CI convenience only — see [`docs/deployment.md`](docs/deployment.md) for exactly what is and is not provisioned. There is no running system at `mart.borneojek.com` for this repo's own code to expose. Customer accounts do not exist ([issue #32](https://github.com/ahliweb/awcms-one/issues/32)) — every commerce write today is either an authenticated owner/admin action inside `apps/cms`, or the anonymous guest-checkout surface described above; there is no session/login attack surface yet.

## Not a security vulnerability

The following matter, but are not security reports — use an ordinary issue, or the routes in [`SUPPORT.md`](SUPPORT.md):

- A defect in `apps/cms` that is purely `ahliweb/awcms`'s own general-purpose behaviour, unrelated to this platform's commerce work.
- A missing feature, or a gap between the borneojek-mart source schema and what has landed here so far — see [issue #21](https://github.com/ahliweb/awcms-one/issues/21) for what is in scope for the current increment.
