🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.id.md)

# ADR-0017 — External providers are `commerce`-owned ports, with env-per-deployment credentials and token-addressed webhooks

- **Status:** Accepted
- **Date:** 19 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0010](0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md), [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md); `apps/cms`'s [ADR-0006](../../apps/cms/docs/adr/0006-offline-first-sync-outbox.md) (the ban on a provider call inside a DB transaction), [awcms ADR-0074](../../apps/cms/docs/adr/0074-push-delivery-is-a-second-outbox.md) (credentials per deployment, never per tenant); issues #33, #106, #107–#118

## Context

ADR-0010 named the shape but deferred the substance: "RajaOngkir and a payment gateway are external providers and — per `apps/cms`'s standing rule — must be called through the outbox, never synchronously on the order path; they are #33, with their own ADR each." ADR-0016 shipped the accounts contract that #33's WhatsApp channel and POS/reports/inbox/campaigns surface now build on top of. This ADR is wave 0 of #33 (increment 5): it records the ten architectural decisions (D1–D10) the whole increment codes against, and ships the OpenAPI contract that follows from them in the same change (issue #106) — every path is documented ahead of its handler, exactly as ADR-0016 did for #86, so C1–C9 (issues #107–#118) build against a contract already argued and settled rather than re-deciding it per-issue.

Five genuinely different providers are in scope at once (a payment gateway, a courier-rate API, two WhatsApp senders, and — structurally — an inbox/campaign surface that is provider-agnostic but shares the same outbox discipline). Deciding their shape five separate times would have produced five slightly different answers to the same three questions: where does the code live, how is a credential supplied, and how does an inbound callback find the right tenant. This ADR answers all three once.

## Decision

### D1 — Integration pattern: a port + adapters inside `commerce`, modelled on `email`

Every external provider this increment adds is a port + adapters **inside the `commerce` module** — not a new top-level module, not routed through `integration_hub`. Each provider family owns its own outbox table(s) and dispatcher job (the same CLAIM → CALL (outside any transaction) → FINALIZE shape `email-dispatch.ts`/`object-dispatch.ts` already prove three times over — see the `awcms-integration` skill), ships a `log` adapter for dev/CI alongside its real adapter (the same "provider off still runs" rule `email`/`push_delivery` already follow), reads its credentials from the **environment only, one set per deployment** (never per-tenant — awcms ADR-0074's own reasoning: a tenant-supplied credential lets one tenant's admin make this deployment speak as someone else), wraps every outbound call in `withTimeout` and `getProviderCircuitBreaker(providerKey)`, and never calls a provider from inside a DB transaction (ADR-0006/ADR-0010).

| Dimension | **Port + adapters inside `commerce` (chosen)** | Admit `integration_hub` first | Per-tenant credentials |
| --- | --- | --- | --- |
| Security | Stays inside the RLS/permission boundary `commerce` already owns; one deployment-wide secret to rotate per provider, not one per tenant | `integration_hub` is an upstream-spec module this repo has not admitted; pulling it in for five providers at once is a much larger, less-reviewed surface to trust in one step | A tenant's own admin becomes a credential-management surface; a leaked or malicious tenant credential can be used to send as this deployment to a provider that trusts it |
| Performance | No cross-module call for a hot path (checkout, OTP); the dispatcher pattern already meets this repo's outbox SLOs | An admission ADR, a subtree divergence, and weeks of integration work before the first adapter ships — pure latency to delivery, not runtime latency | No difference at request time; adds a decrypt-per-tenant-credential step to every dispatch |
| Maintainability | One more instance of a pattern this codebase already has three working examples of; no new module boundary to reason about | `integration_hub` is upstream's own spec; admitting it mid-increment means reconciling its shape with `commerce`'s existing outbox tables, doubling the design surface | Every provider needs its own per-tenant credential CRUD, validation, and masking UI — five times over |
| Scalability | Scales with `commerce`'s own tenant-scoped tables, same as every other outbox here | Unknown — no admission review has happened, so its scaling properties in THIS codebase are unproven | A credentials table keyed by tenant grows linearly with tenant count regardless of which tenants actually use a given provider |
| Accessibility | No effect either way | No effect either way | No effect either way |
| SEO | No effect either way | No effect either way | No effect either way |
| UI/UX | A merchant sees one settings screen per feature (D10), not a separate "connect your own Midtrans account" wizard this repo has never built | Depends entirely on whatever `integration_hub`'s own admin surface looks like — unreviewed | Every tenant's admin must obtain and paste their own provider secret correctly — a real support burden this codebase has never had to carry |
| Compatibility | Matches ADR-0010's own words ("through the outbox") and awcms ADR-0074's precedent (credentials per deployment) — this is that precedent's next chapter, not a new one | Nothing in this codebase today integrates with `integration_hub`; there is no compatibility story to inherit | BjekMart, the reference deployment, uses ONE Midtrans/RajaOngkir/Fonnte account for the whole store — modelling per-tenant credentials answers a question nobody asked |
| Operational complexity | Five provider families, five outbox tables, five dispatcher jobs — the same shape ops already knows how to run, retry, and monitor | A new module admission process, plus five adapters built against an unfamiliar module's conventions | A credential rotation is now a per-tenant operation instead of a per-deployment one; a leaked secret requires notifying and rotating for every affected tenant separately |
| Long-term | A future `integration_hub` admission (if it ever happens) can still absorb these ports later — a port's own interface does not change depending on which module implements it | Forecloses nothing today gains; the cost is paid up front for a benefit not yet needed | Locks the whole increment into a data model (`tenant_id` on every credential row) that BjekMart's own deployment shape does not need |

Rejected: admitting `integration_hub` first (an upstream-spec module this repo has not brought in, and doing so mid-increment for five providers at once is exactly the kind of weeks-long, subtree-diverging detour ADR-0006 (root) already warned against for a federated knowledge graph — the same "do not duplicate/fork upstream's own tree" instinct applies here); per-tenant credentials (BjekMart is the one deployment this increment ships for, and awcms ADR-0074 already settled the "credentials are per-DEPLOYMENT" question for push — there is no reason payment/courier/WhatsApp credentials should answer it differently).

### D2 — Inbound webhooks: token-addressed, `SECURITY DEFINER`-resolved, replay-protected

A public `POST /api/v1/commerce/webhooks/{provider}/{endpointToken}` is the ONE inbound surface every provider callback lands on. The tenant is resolved from an opaque per-tenant endpoint token (`awcms_commerce_webhook_endpoints`, the token stored hashed, never in cleartext, following the same "raw value named in one file only" discipline awcms ADR-0074 used for a push endpoint), through a `SECURITY DEFINER` bootstrap function shaped like the existing `awcms_resolve_tenant_domain_lookup` (a function that may read across tenants specifically so an unauthenticated, pre-tenant request can find out WHICH tenant it belongs to, without granting the calling role broad cross-tenant `SELECT`). The provider's own signature is verified timing-safe before anything else happens. Replay protection is a UNIQUE constraint on `(tenant_id, provider, event_key)` over `awcms_commerce_payment_events` — not an in-memory cache, so it survives a restart and works across however many app instances are running. The body carries a size limit. A verified event then calls `markOrderPaidBySystem`, adding a new `system` edge to the order-status graph (`pending_payment → paid`) alongside the existing `customer`/`admin` edges `order-status.ts` already defines. Because a webhook can be lost (network partition, provider outage, a deploy landing mid-delivery), a reconciliation job `commerce:payments:reconcile` separately polls pending gateway sessions on a schedule — the webhook is the fast path, not the only path.

| Dimension | **Opaque per-tenant token in the URL (chosen)** | Tenant resolved from the webhook payload |
| --- | --- | --- |
| Security | The token is the credential; an attacker who does not hold it cannot even reach a specific tenant's row, let alone forge a signature for it | The payload's own tenant-identifying field (an order code, a merchant reference) is exactly the kind of caller-supplied value ADR-0009's "phone-enumeration oracle" reasoning already rejected once — trusting it to pick a tenant means an attacker who merely guesses a live order code can probe which tenant it belongs to |
| Performance | One indexed lookup by token hash, same cost class as `awcms_tenant_domains`'s own lookup | Same lookup cost, but only after parsing and trusting an unverified payload field first |
| Maintainability | One resolution function, reused by every provider adapter (the token format does not vary by provider) | Every adapter needs its own "which payload field identifies the tenant" logic, and every one of them is a potential oracle if it is ever wrong |
| Scalability | Scales identically to the domain-lookup pattern this codebase already runs at tenant scale | No different scaling cost, but the security cost above scales with how many tenants and providers are added |
| Accessibility | No effect either way | No effect either way |
| SEO | No effect either way | No effect either way |
| UI/UX | An admin copies one URL (with the embedded token) into the provider's dashboard once, per D10's webhook-endpoints screen | No merchant-facing difference, but a merchant has no way to know their tenant is being used as an oracle target |
| Compatibility | Matches the `awcms_resolve_tenant_domain_lookup` precedent this codebase already trusts for "resolve a tenant before authentication exists" | Nothing in this codebase resolves a tenant from a request BODY today — a new, unreviewed resolution shape |
| Operational complexity | Token rotation is `DELETE` + re-`POST` on the webhook-endpoints screen (D10); a compromised token stops working the moment it is deleted | No rotation story at all — the "credential" is baked into every payload the provider ever sends |
| Long-term | Adding a second, third, fourth provider reuses the identical token-resolution function; onboarding cost per new provider is one adapter, not one new tenant-resolution strategy | Every new provider needs its own audited answer to "what payload field is safe to trust", forever |

Rejected: tenant from payload (an unverified, caller-shaped value used to pick a tenant is a cross-tenant oracle by the exact same reasoning ADR-0009 already applied to guest-checkout phone numbers).

### D3 — Payment gateway: a `PaymentGatewayProvider` port, Midtrans Snap first, redirect-based storefront flow

```
PaymentGatewayProvider = {
  createSession(order) -> { providerRef, redirectUrl, expiresAt },
  verifyWebhook(request, rawBody) -> { ok, eventKey, providerRef, status },
  fetchStatus(providerRef)
}
```

The shipped adapter is **Midtrans Snap**: `createSession` is a server-side `POST /snap/v1/transactions`, returning the hosted page's `redirect_url`; the webhook signature is `sha512(order_id + status_code + gross_amount + ServerKey)`. Config: `COMMERCE_PAYMENT_GATEWAY=midtrans|none`, `COMMERCE_MIDTRANS_SERVER_KEY`, `COMMERCE_MIDTRANS_IS_PRODUCTION`. A `log` adapter exists for dev/CI, matching D1. Xendit is a named follow-up adapter behind the same port, not built here.

The storefront flow is **redirect-based**: the browser's own `window.location` navigates to Midtrans's hosted page — no `script-src`/`form-action` CSP change, because nothing is embedded. `/pesanan?kode=` (the existing order-tracking page) polls the order every 5 seconds while its status is `pending_payment`, so a shopper returning from the hosted page (or abandoning it and coming back later) sees the payment land without a manual refresh.

| Dimension | **Redirect to Midtrans's hosted page (chosen)** | Snap.js embed (an iframe/JS widget on `/checkout`) | Form-POST handoff to the gateway |
| --- | --- | --- | --- |
| Security | No third-party script ever executes in this origin's page; the CSP this repo already ships (`worker-src` falling back to `default-src 'self'`, per awcms ADR-0074's own numbers) stays exactly as narrow as it is today | Requires a new `script-src`/`frame-src` origin for Snap.js — the exact kind of third-party-origin expansion awcms ADR-0029's "LAN/offline = zero third-party origins" contract exists to prevent | Requires `form-action` to include the gateway's origin, a CSP directive this repo's six-directive, zero-third-party-origin policy does not currently carry |
| Performance | One network hop (the redirect itself); no SDK bytes shipped to the browser at all | Adds Snap.js's own bundle weight to the checkout page, on top of this repo's per-file byte ceilings (awcms ADR-0074's own build-gate numbers show how tight that budget already is) | Comparable to redirect, but a POST-based handoff cannot be a plain `<a>`/`location.assign`, so it needs its own small form-submission script anyway |
| Maintainability | One provider call, one webhook handler; the redirect target is entirely Midtrans's own page, so a Snap UI change on their side never touches this codebase | Any Snap.js UI/behaviour change on Midtrans's side is a potential breakage inside THIS origin's page, discovered only by re-testing checkout | A third shape (redirect target vs. embedded widget vs. POST target) to maintain alongside the other two payment methods already documented in ADR-0010 |
| Scalability | No different at this repo's scale | No different at this repo's scale | No different at this repo's scale |
| Accessibility | The hosted page is Midtrans's own, audited surface; this repo's own checkout page needs no additional accessibility work for it | An embedded iframe/widget's accessibility is entirely out of this repo's control, and a screen reader crossing an iframe boundary is a known rough edge | No different from redirect once the form auto-submits, but a JS-disabled fallback needs its own accessible page anyway |
| SEO | No effect either way | No effect either way | No effect either way |
| UI/UX | A `window.location` handoff and a polling tracking page is a pattern shoppers already understand from BjekMart's OTHER payment methods (manual bank/QRIS also leave the page conceptually, to go check a bank app) | Keeps the shopper on `/checkout`, arguably smoother, at the cost of the CSP/bundle trade-offs above | Same "leaves the page" UX as redirect, with no embed benefit to offset its CSP cost |
| Compatibility | Works identically regardless of what future gateway adapter (Xendit) is added behind the same port — every hosted-page gateway exposes a redirect URL | Ties the checkout page's own markup to Midtrans's specific widget API; swapping to Xendit later would mean a different embed, not a drop-in adapter | Same coupling risk as the embed option, for a different reason (form field names are gateway-specific) |
| Operational complexity | Nothing new to operate beyond the existing outbox/dispatcher pattern | A widget version to track and update, plus a CSP exception to maintain and re-justify at every security review | A form-target URL to keep in sync with the provider's own API version |
| Long-term | The `PaymentGatewayProvider` port's `createSession` return shape (`redirectUrl`) is provider-agnostic — Xendit slots in without touching the storefront at all | Locks the checkout page's UI to one provider's SDK shape, undoing exactly the portability the port was designed to give | Locks the checkout page's form fields to one provider's API shape, for the same reason |

Rejected: Snap.js embed (a new CSP origin this repo's zero-third-party-origin posture does not currently need to grant); form-POST handoff (`form-action 'self'` would need to widen for no benefit over a redirect).

### D4 — Courier rates: a `ShippingRateProvider` port, RajaOngkir (Komerce API v2) adapter, 6-hour cached rates

```
ShippingRateProvider = {
  getRates({ originId, destinationId, weightGrams, couriers }) -> Rate[]
}
```

The shipped adapter is **RajaOngkir**, specifically the Komerce API v2 shape (`COMMERCE_RAJAONGKIR_API_KEY`). Rates are cached in `awcms_commerce_shipping_rates`, keyed `(tenant, origin, destination, weight bucket of 100 g, courier)`, TTL 6 hours — the same "provider call is optional, its answer is cached" shape a live rate-quote API needs when it sits on a customer-facing hot path. Destination resolution goes through `awcms_commerce_courier_destinations`, mapping an `idn_admin_regions` district code to the provider's own destination id; that mapping is resolved ONCE, by a name search against the provider's destination list, and cached — not re-resolved on every quote. The cart-quote request accepts `destination: {districtCode}`; the provider call itself happens from the quote path **outside any transaction** (ADR-0006), and a provider failure degrades the courier option to `available: false` with a note, rather than failing the whole quote. Order creation validates the chosen `{courier, service, cost}` against the cache only — it never calls the provider a second time on the write path. Store settings gain `shipping.courier = {enabled, originDestinationId, couriers: string[]}`.

| Dimension | **6-hour weight-bucketed cache (chosen)** | No cache — call the provider on every quote |
| --- | --- | --- |
| Security | Fewer outbound calls to audit and rate-limit against | Every cart-quote request becomes an outbound call, widening the SSRF/abuse surface the `awcms-integration` skill's checklist already calls out |
| Performance | A cache hit is a single indexed lookup; the customer-facing quote path stays fast even when the provider is slow | Every quote pays the provider's own latency — unacceptable on a path shoppers hit repeatedly while adjusting quantities |
| Maintainability | One cache table + one TTL policy to reason about | No caching logic, but a much larger real-time failure surface to handle gracefully on every single request |
| Scalability | Cache hit rate improves as more shoppers quote similar routes; provider call volume stays roughly flat regardless of quote volume | Provider call volume scales linearly with quote volume — a busy store could hit the provider's own rate limits |
| Accessibility | No effect either way | No effect either way |
| SEO | No effect either way | No effect either way |
| UI/UX | Courier options render as fast as any other quote field; a stale rate is at most 6 hours old, well inside RajaOngkir's own typical rate-change cadence | A slow provider response makes the whole cart-quote page feel slow, exactly the UX ADR-0010 already avoided by shipping "manual + flat courier first" |
| Compatibility | Matches D3's own "provider call outside the transaction, degrade gracefully" shape | Same transactional discipline required, just exercised on every request instead of on a cache-miss |
| Operational complexity | One more cache table with a documented TTL; a stuck/incorrect cache row is fixed by deleting it | A provider outage degrades EVERY quote, not just the fraction that misses a 6-hour cache window |
| Long-term | The weight-bucket/TTL shape generalises to a future second courier aggregator without changing the port | No different scaling story is gained by skipping the cache — only risk is added |

Rejected: none seriously considered beyond the cache-vs-no-cache trade-off above — a live rate on every keystroke was never viable given ADR-0006's "no provider call inside a transaction, and no critical flow may depend on one" rule and the checkout page's own responsiveness requirement.

### D5 — WhatsApp: an outbox, two adapters (Fonnte, Meta Cloud API), and a third `CustomerOtpChannel` adapter

`awcms_commerce_whatsapp_messages` + a `commerce:whatsapp:dispatch` job is the same outbox shape as `email`/`push_delivery`. Two adapters: **Fonnte** (`COMMERCE_WHATSAPP_PROVIDER=fonnte`, `COMMERCE_FONNTE_TOKEN`) and **Meta Cloud API** (`meta`, `COMMERCE_META_WA_TOKEN`, `COMMERCE_META_WA_PHONE_NUMBER_ID`, plus a template name for OTP messages specifically, since Meta's own API requires a pre-approved template for a business-initiated conversation). A third adapter implements ADR-0016 D2's own `CustomerOtpChannel` port (`domain/customer-otp-channel.ts`), so OTP delivery reuses the identical port `email`/`log` already implement — `OtpRequest` gains an optional `via?: "email" | "whatsapp"` (default `email`); `whatsapp` requires a `phone` on the request, and login-by-phone looks the account up through its linked customer row (the account itself still carries no phone-as-credential column — D1 of ADR-0016 is unchanged, this only adds a second delivery address for the same OTP).

This is a same-shape repeat of ADR-0016 D2's own comparison (e-mail now, WhatsApp as a follow-up) — that decision is not re-litigated here; D5 is the follow-up ADR-0016 named, landing on schedule under #33/#108.

### D6 — POS: a `cash` payment method, an order `channel`, and one new permission

`payment_method` gains `cash`. `orders.channel` becomes `'storefront' | 'pos'`. A new permission `commerce.orders.create` — POS-only, since every OTHER order-creation path is either anonymous (storefront) or provider-driven (nothing creates an order server-side today except a human at the counter). `POST /api/v1/commerce/pos/orders` creates a `paid`, `self_pickup` order for a walk-in or phone-identified customer, with `admin` recorded as the acting party in `order_events` (not `system`, and not `customer` — a staff member is the one who typed it in). POS order history is simply the existing order list, filtered `channel = pos` — no second orders table, no second read model.

### D7 — Reports: three `reporting` projections, contributed by `commerce`

Three cross-cutting projections land in the `reporting` module (not `commerce` itself, matching how `reporting` already hosts projections contributed by other modules): `commerce.sales_daily`, `commerce.sales_by_product`, `commerce.sales_by_category`. Strategy: `cursor_table` over the append-only `awcms_commerce_order_events` — an order reaching `paid` ADDS to the projection, and a later `cancelled`/`refunded` transition (always reached FROM `paid` or later in the state graph) SUBTRACTS, so the projection is always a correct running total without ever re-scanning the whole orders table. An admin screen reads the projection, plus a built-in scheduled export (the same shape other `reporting`-hosted dashboards already use).

### D8 — Inbox: `awcms_commerce_conversations` + `awcms_commerce_messages`

A customer account ↔ store messaging surface: `awcms_commerce_conversations` (one per customer, or one per customer+subject — the schema decision for #111) and `awcms_commerce_messages` (the individual turns). Bearer endpoints let the account read and reply to its own conversation; owner endpoints let staff read, reply, and close/reopen (`status: open|closed`). A reply from staff triggers an e-mail notification to the customer (reusing the `email` outbox, not a new channel) so a customer does not have to keep the tab open to notice a reply.

Rejected: modelling this on `comments` (the existing public/moderated, resource-anchored commenting surface) — an inbox conversation is private between one customer and the store, has no moderation queue, and is not anchored to a published resource (a product, a post) the way a comment is; forcing it into `comments`'s shape would mean bolting a privacy model onto a module designed for the opposite.

### D9 — Campaigns: consent-gated mass e-mail/WhatsApp, fanned out through the existing outboxes

`awcms_commerce_campaigns` (`channel: email|whatsapp`, an `audience` filter `{levels[], hasAccount, lastOrderSince}`, `subject`/`body`, `status: draft|scheduled|sending|sent|cancelled`) plus `awcms_commerce_campaign_recipients` (one row per resolved recipient, so a partial send is resumable and auditable). A dispatcher `commerce:campaigns:dispatch` fans a sending campaign out into the SAME e-mail/WhatsApp outboxes D5 and `email` already dispatch from, in batches — no third delivery mechanism, no separate rate-limit story.

**Consent** is load-bearing: `customer_accounts.marketing_consent_at` is a nullable timestamp, toggled by the customer themselves in `/akun`; a campaign's audience resolution only ever includes accounts with a non-null `marketing_consent_at` — an account that never opts in is structurally unreachable by a campaign, not merely filtered out by convention. Customer push notification is explicitly deferred: `push_delivery` (awcms ADR-0074) subscribes DEVICES, and today only staff devices are modelled — extending it to a customer's own device is a real design question (a customer has no staff-shaped session to hang a device subscription off) left for a later increment.

### D10 — Features & partners: module settings flags, and `customers.level` as BjekMart's own "Partners"

BjekMart's own admin language calls a set of togglable capabilities "Features" — modelled here as `commerce` module settings flags (`pos`, `inbox`, `campaigns`, `gateway`, `courier`) inside `awcms_module_settings` (the existing per-tenant, per-module settings mechanism every module already has), with one settings form covering all five. BjekMart's "Partners" — a tiered-pricing relationship with certain customers — is `customers.level`: an admin sets a customer's level, and the cart-quote path applies `price_level_{n}` (a column `CommerceProduct` already carries, per `docs/api.md`'s own "Not built" note under increment 4) for a bearer-authenticated customer of level `n`. This closes ADR-0016 D6's own explicitly-deferred item ("Tiered pricing by `level` at quote time"). ADR-0089's own "partners" concept (recorded elsewhere) is unrelated to this one and is noted here only so the two are not confused by name alone.

### Out of scope (this ADR, this increment)

A database backup screen (an operations concern, not a `commerce` one); customer-facing push notifications (D9); courier package tracking (D4 ships RATES, not tracking); the Xendit adapter (D3 names it as a future adapter behind the same port, not built here).

## Options considered

See the tables under D1–D4 above for the full dimension-by-dimension comparisons; D5–D10 are structural decisions with a single chosen shape each, reasoned in prose. Summarised:

| Option | Why not (or why chosen) |
| --- | --- |
| **Port + adapters inside `commerce`, env-per-deployment credentials, token-addressed webhooks** (chosen) | Reuses the outbox pattern this codebase already runs three times over, matches awcms ADR-0074's own "credentials per deployment" precedent, and resolves a webhook's tenant the same safe way `awcms_resolve_tenant_domain_lookup` already does |
| Admit `integration_hub` first | An unreviewed, upstream-spec module — weeks of admission work and a subtree-divergence risk this increment does not need to take on to ship five adapters |
| Per-tenant provider credentials | BjekMart, the reference deployment, needs exactly one account per provider; per-tenant credentials answer a question nobody is asking and add a real credential-management UI this increment does not need |
| Tenant resolved from the webhook payload | An unverified, caller-shaped value used to pick a tenant is a cross-tenant existence oracle, the same failure mode ADR-0009 already ruled out for guest-checkout phone numbers |
| Snap.js embed / form-POST handoff for the gateway | Both widen this repo's CSP (a new script/frame/form-action origin) for no benefit a redirect does not already give, and both couple the checkout page's markup to one provider's specific API shape |
| Live courier rate on every quote, uncached | Pays the provider's own latency and rate limits on a customer-facing hot path ADR-0006 already forbids depending on a provider for |
| Model the inbox on `comments` | A private, unmoderated, non-resource-anchored conversation does not fit a module built for public, moderated, resource-anchored ones |

## Consequences

- The OpenAPI contract landing in the same change (issue #106) documents every new path under `/api/v1/commerce/{pos,conversations,campaigns,webhook-endpoints}`, `/api/v1/commerce/storefront/orders/{orderCode}/payment-gateway/sessions`, `/api/v1/commerce/storefront/account/conversations*`, `/api/v1/commerce/webhooks/{provider}/{endpointToken}`, and `/api/v1/reports/commerce/sales-{daily,by-product,by-category}`, using `ROUTE_PARITY_EXEMPTIONS` in `apps/cms/scripts/api-spec-check.ts` because no route file exists yet for any of them — each exemption names the child issue (#107–#118) that removes it the moment its own handler lands, and the set is required to be empty again once the increment finishes.
- `customerBearer` (ADR-0016 D3) now also authenticates the storefront's own inbox endpoints and the payment-gateway session request when a signed-in shopper places it; the anonymous, phone-identified path stays available for a guest exactly as ADR-0009 already established for orders and reviews.
- Only TWO new operations declare `security: []` and join `ALLOWED_PUBLIC_OPERATIONS`: the payment-gateway webhook intake (a provider callback has no session to present, by definition) and the payment-gateway session-creation endpoint (a guest identified by phone, matching the rest of the anonymous storefront surface's own trust model) — every other new endpoint requires either `customerBearer` or the owner's staff `bearerAuth` plus a `commerce.*` permission.
- `payment_method` already carries the `gateway` enum value (added ahead of time, per ADR-0010's own "additive" note) and `shipping` already carries the `courier` method — D3/D4 do not need an enum migration, only a working adapter behind each.
- No handler exists yet for any of D2–D10's endpoints; this ADR and its OpenAPI contract are the reviewed target C1–C9 (issues #107–#118) build against, not a description of running code.

## Status — 19 September 2026: every decision implemented, `ROUTE_PARITY_EXEMPTIONS` empty

Every child issue landed and every `ROUTE_PARITY_EXEMPTIONS` entry this contract needed has been removed — the set is empty on `main`, as this ADR required above.

| Decision | Status | Landed by |
| --- | --- | --- |
| D1 — provider ports inside `commerce`, env credentials | Implemented — `ShippingRateProvider`, `PaymentGatewayProvider`, `WhatsappProvider`, each with a `log` dev/CI adapter, `withTimeout` + `getProviderCircuitBreaker`, called outside any DB transaction | #107, #108, #110 |
| D2 — token-addressed public webhooks, replay protection | Implemented — `POST /api/v1/commerce/webhooks/{provider}/{endpointToken}`, `awcms_resolve_commerce_webhook_endpoint` (`SECURITY DEFINER`), `UNIQUE (tenant_id, provider, event_key)` on `awcms_commerce_payment_events`, `commerce:payments:reconcile` backstop | #110, #113 |
| D3 — Midtrans Snap payment gateway | Implemented — redirect-based checkout, `/pesanan` 5 s polling, `COMMERCE_PAYMENT_GATEWAY=midtrans\|none`. Xendit remains a named follow-up, not built | #110, #112, #113 |
| D4 — RajaOngkir courier rates, cached | Implemented — `awcms_commerce_shipping_rates`/`_courier_destinations` (`sql/924`), 6 h TTL, weight-bucketed, never called from inside the order transaction. Courier tracking remains a named follow-up, not built | #107, #109 |
| D5 — WhatsApp outbox + OTP channel | Implemented — Fonnte + Meta Cloud API adapters, `awcms_commerce_whatsapp_messages` outbox (`sql/925`), `otp/request via: "whatsapp"` (login-only) | #108, #115 |
| D6 — POS | Implemented — `orders.channel`, `payment_method = 'cash'` (`sql/931`), `commerce.pos.create`, `/admin/commerce-pos` | #116 |
| D7 — sales reports | Implemented — three `reporting` `cursor_table`/`dimensional` projections (`commerce.sales_daily`/`_by_product`/`_by_category`, `sql/933`), `/admin/commerce-reports` | #117 |
| D8 — inbox | Implemented — `awcms_commerce_conversations`/`_messages` (`sql/927`/`928`), bearer storefront routes, `/admin/commerce-inbox` | #111 |
| D9 — campaigns, consent | Implemented — `awcms_commerce_campaigns`/`_campaign_recipients` (`sql/929`/`930`), `marketing_consent_at`, `commerce:campaigns:dispatch` | #114 |
| D10 — feature toggles, tiered pricing | Implemented — `commerce` module settings `{pos, inbox, campaigns, gateway, courier}`, `price_level_{n}` at quote via `customerLevel` | #118 |

Out of scope at this ADR's own writing and still out of scope: a database-backup admin screen (an operations concern — see [`docs/deployment.md`](../deployment.md)), customer-facing push notifications, courier package tracking, and the Xendit payment-gateway adapter (both named above as follow-ups behind ports this increment already built).
