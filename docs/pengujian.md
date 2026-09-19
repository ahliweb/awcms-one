🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](pengujian.id.md)

# Testing

Three tiers, each owned by a different workspace, run by two CI jobs. This document names all three and how to run each — it does not restate every individual test file.

## 1. Root gate suite (`bun test` from the repo root)

Needs no database, no build, and no network beyond `bun install`. Excludes `apps/cms/**` entirely via `bunfig.toml`'s `[test] pathIgnorePatterns` (CI invokes `bun test` bare, and a flag on `bun run test` would silently not apply to that bare invocation). Covers this repository's own root-owned gates (documentation audits, knowledge-graph artefact checks, changeset/release conventions, toolchain-pin checks, [`tests/kontrak-arah-impor.test.mjs`](../tests/kontrak-arah-impor.test.mjs)) **plus every one of `apps/storefront`'s own unit, build-smoke, and route tests** — `apps/storefront` has no `test` script of its own; its `tests/*.test.ts` files run as part of this same root `bun test` invocation, workspace-wide.

## 2. `apps/storefront`: unit tests, a type-check, and two build-smoke tiers

`apps/storefront/tests/` holds around 55 files (excluding `e2e/`), grouped roughly by area:

| Group | What it covers |
| --- | --- |
| News/`berita-*` | Portable Text rendering (`videoNews`/`gallery`), rubrik hierarchy, legacy-redirect map building and lookup, WIB date formatting, RSS validity, JSON-LD shape, the `/news/**` guard (named for `ahliweb/awcms`'s own ADR-0071) |
| Catalog/`katalog-*` | Search/filter, price formatting, cart contract, CSP media-origin derivation, JSON-LD, marketing-surface tolerance |
| Runtime/checkout | `toko-klien`/`toko-origin`/`toko-csp` (the anonymous API client, `PUBLIC_AWCMS_ORIGIN` validation, CSP `connect-src`), `checkout-guard-no-prerender` (no `apps/storefront/src/pages` file opts out of static output), `checkout-build-smoke`, `wilayah-checkout`, `wishlist-kontrak` |
| Server/build/general | `build-smoke`, `penyaji`, `portable-text`, `profil`, `routes`, `sitemap`, `telepon`, `theme`, `wa-fallback`, `warna` (contrast) |
| Increment 3 (issues #47–#59) | `awcms-media` (chunking, unresolvable ids, uuid filtering), `navigasi-berita`/`ikon-sosial` (nav and platform detection), `buletin-klien`, `bagikan` (share URL builders, the Web Share/clipboard decision table), `dengar` (reading units, sentence splitting, voice filtering, storage failure), `meta-sosial` (OG/Twitter builders), `analitik`/`ga`/`ga-csp` (beacon payload, DNT/GPC, the GA CSP branch), `analitik-terpopuler`, `pengalihan-aturan` (the rule table, end to end), `penyaji-bayangan-html` (the shadowed-page rewrite), `logo-instansi`, `wilayah-checkout` (the request-concurrency ceiling), `iklan-popup` |

| Customer accounts/affiliates (issues #88/#90/#93) | `akun-kontrak` (the `localStorage` session shape, guarded storage), `akun-klien` (mocked-fetch coverage of every account-client function: OTP request/verify, `me`/`logout`, addresses/wishlist/orders/reviews, affiliate enrol/commissions), `wishlist-sinkron` (the pure union-merge function), `afiliasi-kontrak` (the `?ref=` code shape, `localStorage` capture with its 30-day TTL, guarded storage) |

**A build-smoke test per feature, not one shared file.** Fifteen of them now (`build-smoke` #24, `berita-build-smoke` #28, `katalog-build-smoke` #27, `checkout-build-smoke` #30, `buletin-build-smoke` #50, `bagikan-build-smoke` #51, `dengar-build-smoke` #52, `sidebar-build-smoke` #49, `logo-instansi-build-smoke` #59, `meta-sosial-build-smoke` #54, `analitik-build-smoke`, `penyaji-bayangan-build-smoke` #75, `akun-build-smoke` #88, `akun-dashboard-build-smoke` #90, `afiliasi-build-smoke` #93). Each starts the stub, runs a **real** `astro build`, and asserts against the HTML that actually landed in `dist/client/` — which is the only place several increment-3 defects could have shown at all: a player rendered visible instead of `hidden`, a player on a video post, an emblem on an article whose institution has none, an `og:image` that changed for store pages, a page that 404s only when served. Every one of them SKIPS with a clear message rather than passing when `bun` cannot be spawned.

`bun --bun astro check` (`apps/storefront/package.json`'s `check` script) is a type-check, run as the first step of `bun run build`. A **manual, two-terminal stub-backed build** additionally proves the app builds a real site with no live `apps/cms` to reach — not wired into CI, but exercised by hand on every PR that touches this workspace:

```bash
# terminal 1
bun scripts/stub-awcms.mjs
# terminal 2
AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
  PUBLIC_AWCMS_ORIGIN=https://cms.example.com SITE_URL=http://localhost:4321 bun run build
```

`apps/storefront/scripts/stub-awcms.mjs` serves every endpoint the storefront calls, including the storefront-commerce state machine (quote → create order → track → confirm payment → cancel) the checkout flow exercises, reading response bodies from `apps/storefront/tests/fixtures/awcms/`. It is deliberately not imported by `astro.config.mjs`, `src/`, or `apps/storefront/server/penyaji.mjs` — nothing in the production build path can reach it by accident.

**The stub's own `/account/*` state machine (issues #88/#90/#93).** `otp/request` always answers the neutral `202`; `otp/verify` accepts exactly one fixed code, `123456`, and otherwise answers the same errors the real API defines (`ACCOUNT_NOT_FOUND`, `PHONE_ALREADY_REGISTERED`, `OTP_INVALID`); `me`/`logout` and every `account/{addresses,wishlist,orders,reviews,affiliate}` route are Bearer-only, checked against the `Authorization` header the same way the CMS's own `requireCustomerSession` would. Fixture `customer-accounts.json` seeds one account (`budi@example.test`, `+6281234567890`) with two stub orders, one dated before and one after the account's own `historyFrom` — so `akun-dashboard-build-smoke` can assert that the pre-`historyFrom` order never appears in `/akun/pesanan`, exactly what the real `GET account/orders` query enforces server-side. This is a stand-in for `apps/cms`'s real behaviour, not a second copy of its logic — it exists so `apps/storefront`'s own build-smoke and unit suites can exercise a signed-in shopper without a running `apps/cms`.

### Playwright e2e — a fourth tier, its own command, not part of `bun test`

`apps/storefront/tests/e2e/checkout.e2e.ts` drives a real Chromium browser against a real build+serve+stub, run with `bun run test:e2e` **inside `apps/storefront`** (never the root `bun test` — the `.e2e.ts` suffix keeps it out of that discovery on purpose). Covers add-to-cart → cart quote renders totals → checkout submits → tracking shows the order, plus the neutral not-found state for a wrong phone. **Not wired into `.github/workflows/ci.yml`** — this was outside the ops-owned CI file's scope for the issue that added it; `apps/storefront/README.md` documents exactly how a future CI job would run it (install Chromium, start the stub, build with the right env, serve, point `E2E_BASE_URL`/`STUB_ALLOWED_ORIGIN` at each other).

## 3. `apps/cms` (`check-cms` CI job): a real, provisioned PostgreSQL

Unlike increment 1, this is no longer a manual-only procedure — [issue #25](https://github.com/ahliweb/awcms-one/issues/25) provisioned PostgreSQL for both local development and CI. `apps/cms` carries its own large gate chain (`apps/cms/package.json`'s `check` script: 53 `&&`-joined steps — lint, docs/i18n, every registry/consistency gate, typecheck, `bun test`, `bun run build`) plus its own `bun test` (roughly 7,170 tests as of the affiliates PR) and a `tests/integration/` suite that needs a live database.

### Running it locally

```bash
cd apps/cms && DATABASE_URL="" bun run check   # every DB-gated suite skips cleanly
```

Then, against a disposable database (root: `bun run db:up`, or your own throwaway container):

```bash
DATABASE_URL=postgres://awcms:<password>@localhost:<port>/awcms bun run db:migrate:cms
cd apps/cms && DATABASE_URL=postgres://awcms:<password>@localhost:<port>/awcms \
  bun test tests/integration/ --timeout 60000
```

**The migration/test harness needs a privileged database role, not `awcms_app`.** It runs `CREATE DATABASE`/`ALTER ROLE`, which the unprivileged application role cannot do by design (`permission denied to alter role`, PostgreSQL `42501`) — not a regression. **`apps/cms`'s own `.env`'s mere presence turns the DB-gated suite on** — Bun loads `.env` itself, so removing `DATABASE_URL` from the shell alone does not disable it.

### What `check-cms` runs in CI, exactly (`.github/workflows/ci.yml`)

A `postgres:18.4` service container (`POSTGRES_USER=awcms`, `POSTGRES_DB=awcms`, health-checked with `pg_isready`), then: `cd apps/cms && DATABASE_URL="" bun run check`, then `bun run db:migrate:cms` against the service, then `cd apps/cms && bun test tests/integration/ --timeout 60000` — over 710 tests as of the affiliates PR, including `commerce-catalog.integration.test.ts` (list filters, by-slug, image/variant CRUD, restore, cross-tenant RLS), `commerce-marketing.integration.test.ts` (flash-sale derivation, the tick job firing exactly once, public vouchers, popup single-active-index, settings round-trip), and the four increment-4 suites below. A job-summary step reports the DB-gated skip count before and after the live database connects, so a reviewer can see the suites actually ran.

**Customer accounts and affiliates (issues #87/#89/#91/#92) each shipped their own `tests/integration/` suite, every one run for real against a live PostgreSQL, never merely written and left DB-gated-skipped:** `commerce-customer-account-store.integration.test.ts` (9 tests — create/bind an account applying D4's history-from rule, issue/consume an OTP with attempt counting in one `UPDATE … RETURNING`, session issue/find/touch/revoke), `commerce-customer-auth.integration.test.ts` (9 — OTP request/verify end to end, the register-on-existing-e-mail-logs-in case, the derived e-mail template's per-tenant auto-seed on first miss), `commerce-customer-account-resources.integration.test.ts` (14 — addresses/wishlist/orders/reviews, the `historyFrom` boundary enforced inside the query, the partial-unique-index default-address invariant), and `commerce-affiliates.integration.test.ts` (7 — enrol, commission creation on the `completed` transition, self-referral and suspended-affiliate exclusion, the approve/pay/void state machine). Every PR that landed one of these suites ran it against `apps/cms`'s own local dev PostgreSQL (the same `DATABASE_URL`-gated database `bun run db:up`/`db:migrate:cms` provisions), not merely asserted structurally — the same DATABASE_URL-gated posture the pre-existing `commerce-orders.integration.test.ts` suite already established.

**Orders/customers (issue #29) has a committed `apps/cms/tests/integration/commerce-orders.integration.test.ts`** (`apps/cms/tests/integration/`), covering create-order-decrements-stock, idempotent double-submit (the same idempotency key replays the same order, no second decrement), tracking's neutral wrong-phone/wrong-code response, the expiry job's restock, and cross-tenant RLS isolation. Issue #29's own PR body states this suite "was not written as a formal automated test" and that every one of these behaviours was only proven by hand (catching and fixing two real bugs along the way — a wrong foreign-key id on a flash-sale order line, and a missing worker grant for the expiry job's own writes) — the merged tree disagrees with that PR text, and this document follows the tree.

## Two things a contributor must know before writing a query here

- **Money reads as `"0"`, not `"0.00"`, through a parameterised `Bun.SQL` query.** A stored `0.00` decodes as the text `"0"` when read through the extended protocol (a parameterised query) but as `"0.00"` through a simple query — every non-zero value keeps its scale either way. `normalizeMoney` (`apps/cms/src/modules/commerce/domain/price-calculation.ts`) exists specifically to make the wire shape independent of which protocol happened to serve the row; every `toRecord` in the commerce module passes every money field through it before it ever leaves the module (`null` passes through unchanged — an absent money value is `null` on the wire, never `"0.00"`). Apply it in the read path, never in arithmetic.
- **`= ANY($ids)` with a plain JS array silently mis-binds under `Bun.SQL`.** Passed directly, an array of two or more ids binds as the single text value `"a,b"` (PostgreSQL error `22P02`); a single-element array silently passes, which is what let this ship once already (affecting every #23 product list with two or more products carrying images, until #26's own seeding caught it). The fix used throughout the commerce module is `tx.array([...ids], "uuid")::uuid[]` — bind the array explicitly as a Postgres `uuid[]`, never a bare parameter.

## What each tier would need to answer "is commerce correct"

| Question | Tier |
| --- | --- |
| Do the product/order/flash-sale state machines behave correctly in isolation? | `apps/cms`'s `apps/cms/tests/commerce-domain.test.ts`, `apps/cms/tests/commerce-marketing-domain.test.ts` (pure, no database) |
| Does every commerce migration stay inside the reserved `9xx` range, and every other migration outside it (issue #72)? | `apps/cms`'s `apps/cms/tests/commerce-migrations-range.test.ts` (pure, reads `apps/cms/sql/` file names only) |
| Does `db:commerce:renumber`'s rename plan behave correctly for a fresh, already-migrated, mixed, or already-renamed database (issue #72)? | `apps/cms`'s `apps/cms/tests/commerce-migrations-renumber.test.ts` (pure, no database) |
| Does RLS actually isolate every `awcms_commerce_*` table by tenant? | `apps/cms`'s generic RLS integration suite, derived from every table's own `ENABLE`/`FORCE` statements (needs PostgreSQL) |
| Does the anonymous storefront API resolve tenants correctly and refuse the rest? | `apps/cms`'s `commerce-catalog.integration.test.ts`/`commerce-marketing.integration.test.ts`/`commerce-orders.integration.test.ts` (all need PostgreSQL) |
| Does the storefront build a real site against the real API envelope, including checkout? | `apps/storefront`'s stub-backed build, and `bun run test:e2e` |
| Does `apps/cms` ever get imported the wrong way from `apps/storefront`/`packages/kontrak`? | Root `bun test` → `tests/kontrak-arah-impor.test.mjs` |
| Do this repository's own documentation and release conventions hold? | Root `bun test` plus the `audit:*` gates |

## Not built

A CI job for `apps/storefront`'s Playwright e2e suite (runs and passes locally; see "Playwright e2e" above). Any visual-regression or accessibility-audit tooling — see [`docs/aksesibilitas.md`](aksesibilitas.md) and [`docs/responsif.md`](responsif.md) for what was verified by reading code instead.
