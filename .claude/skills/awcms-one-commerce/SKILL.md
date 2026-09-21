---
name: awcms-one-commerce
description: Add or change a table, endpoint, or admin screen in apps/cms's commerce module. Use when extending catalog, marketing, or orders. Enforces one module not three (ADR-0008), RLS FORCE, permission/audit/event registration, the normalizeMoney and tx.array(...)::uuid[] rules, and the anonymous-vs-owner API split.
---

🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](SKILL.id.md)

# awcms-one — Add a commerce table + endpoint

Follow `apps/cms/AGENTS.md`, `apps/cms/CONTRIBUTING.md` (Definition of Done), and the skills under `apps/cms/.claude/skills/` this work touches — `awcms-new-migration`, `awcms-new-endpoint`, `awcms-new-event`, `awcms-abac-guard`, `awcms-audit-log`, `awcms-ui-screen`, `awcms-i18n`, `awcms-testing`. This skill states the rules **specific to this platform's `commerce` module**, on top of those generic ones; it does not repeat them.

## It is one module, not three — put your work inside `apps/cms/src/modules/commerce/`

[ADR-0008](../../../docs/adr/0008-one-commerce-module-carries-the-whole-store-not-three.md): catalog, marketing, and orders all live under the single module key `commerce`. A new table/route/permission/event belongs inside this module's existing `domain/{catalog,marketing,orders}/…` directory convention — that is a directory grouping, not a module boundary. Do **not** create a second `module.ts` for a new commerce feature; extend the existing one. The module's `dependencies` (`tenant_admin`, `identity_access`, `domain_event_runtime`, `media_library`, `module_management`) only grow when a genuinely new capability is needed, not per table.

## Every new table

1. `NNN_awcms_commerce_<area>_<desc>.sql` under `apps/cms/sql/`, continuing the module's own migration sequence (153–168 as of this writing — check `ls apps/cms/sql/ | tail` for the real next number).
2. `tenant_id uuid NOT NULL REFERENCES awcms_tenants`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` **and** `... FORCE ROW LEVEL SECURITY`, one tenant-isolation policy (`tenant_id = current_setting('app.current_tenant_id')::uuid`) — copy the exact shape from any existing commerce table in [`docs/skema-basis-data.md`](../../../docs/skema-basis-data.md), do not write a new variant.
3. Every foreign-key column gets its own index (`apps/cms`'s `db:fk-index:check` gate enforces this).
4. Money is `numeric(14,2)`, never `float`/`real` — see [ADR-0003](../../../docs/adr/0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) and the `normalizeMoney` rule below.
5. Cross-table references this module cannot trust a bare FK to isolate by tenant (e.g. a `category_id` on a product) are checked in the **application layer**, inside the same RLS-scoped transaction, and an unknown/soft-deleted/cross-tenant id is rejected **identically** — never three different error messages that would let a caller probe for ids belonging to another tenant (see [`docs/skema-basis-data.md`](../../../docs/skema-basis-data.md)'s "category_id crossing tenants" section for the exact pattern to copy).
6. Register the table's `dataLifecycle` (generic purge engine, `cursorColumn: "deleted_at"` unless the table is append-only like `order_events`, which uses `"created_at"` and carries no `deleted_at` at all) and `subjectData` descriptor in `module.ts`. If the table can hold a real person's data but that person has no `tenant_user`/`identity`/`profile`/`principal` row (a guest customer, identified only by phone), the honest descriptor is `unreachableBySubject: true` — see [ADR-0009](../../../docs/adr/0009-guest-checkout-by-order-code-and-phone.md) for why every order/customer table already does this; do not invent a `subjectColumns` value that does not honestly exist.

## Two `Bun.SQL` quirks every commerce query must account for

- **A stored `0.00` decodes as the text `"0"` through a parameterised query**, but `"0.00"` through a simple one. Pass every money field through `normalizeMoney` (`domain/price-calculation.ts`) in the `toRecord` step — never in arithmetic — before it leaves the module. `null` passes through unchanged.
- **`= ANY($ids)` with a bare JS array silently mis-binds** two or more ids as the single text value `"a,b"` (`22P02`) — a single-element array passes silently, which is exactly how this shipped broken once already. Always bind with `tx.array([...ids], "uuid")::uuid[]` for a batched id lookup.

## Every new owner-side endpoint

Follow `apps/cms/.claude/skills/awcms-new-endpoint/SKILL.md` in full (thin routes, `defineTenantRoute`, ABAC, validation, idempotency on high-risk mutations, OpenAPI). Two commerce-specific additions:

1. **Permission naming**: `commerce.<resource>.<action>`, matching the module's existing four areas (catalog/marketing/store-settings/orders) — see [`docs/api.md`](../../../docs/api.md) for the full 39-key list. Do not declare a permission with no route enforcing it (`access:permissions:enforcement:check` catches this).
2. **`create`/`delete` for `orders`/`customers` do not exist, on purpose** — an order or customer is created only through the anonymous storefront path below, which has no admin identity to authorize. Do not add owner-side `POST .../orders` "for completeness"; it would need its own design (what actor creates an order on a shopper's behalf?) that this module deliberately has not built.

## Adding to the anonymous storefront API (`/api/v1/commerce/storefront/*`)

Read [ADR-0007](../../../docs/adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) before adding a new route here — this is the highest-trust-sensitive part of the module, because it has no permission check at all by design.

1. Resolve the tenant from the request's `Origin`/`Host` against `awcms_tenant_domains`, the same way every existing route in `application/public-commerce-tenant.ts` does — never trust a header the caller can set to anything (a tenant id in the body, an `X-Tenant-*` header).
2. Answer the `OPTIONS` preflight, echo the allowed origin verbatim (never `*`), send `Vary: Origin` on every response.
3. Rate-limit per IP; add a per-identifier limit too (per phone, per order code) if the route can be used to enumerate or brute-force something.
4. Where a lookup can fail for more than one reason (wrong code, wrong phone, another tenant's order), answer with the **same** response for all of them — see `orders/{code}?phone=`'s neutral 404 as the pattern to copy.
5. A write that a shopper might double-submit needs an idempotency key through the shared `awcms_idempotency_keys` store (`_shared/idempotency.ts`) — not a bespoke column on your new table.

## Admin screen and events

- New admin screen: follow `awcms-ui-screen`; gate its `read` view on the matching `commerce.<resource>.read` permission via `loadAdminScreen`, and make sure `admin:screen-coverage:check` sees every permission your change adds claimed somewhere.
- New domain event: follow `awcms-new-event`; register it in `module.ts`'s `events.publishes`, `domain-event-runtime/domain/event-type-registry.ts`, and `apps/cms/asyncapi/awcms-domain-events.asyncapi.yaml` in the **same** change — a forward-declared event with no registration (`voucher.redeemed` was declared a full increment before it was ever fired) is fine; a fired event with no registration is not.

### Admin screen composition (2026-09 redesign, issue #171)

Every `commerce` admin screen composes on the shared primitives the admin-chrome restyle added to `apps/cms/src/styles/admin.css` (issue #170, subtree sync of upstream awcms#813) — do not hand-roll a stat tile, tab strip, or toggle a screen needs; reuse the existing class:

| Primitive | Use it for |
| --- | --- |
| `.admin-stat-card` | A single KPI tile (count/currency/label) — dashboard, reports, affiliates, settings' provider status |
| `.admin-status-pill[data-tone]` | A small status/tone indicator — order status, provider configured/not, POS change amount |
| `.admin-segmented` | An equal-weight tab/filter row (`aria-current="page"` for plain navigation links, a JS-driven `aria-selected` only for a real tablist) — status filters, the shared `CommerceMarketingTabs.astro` strip |
| `.admin-bulk-bar` | The bar that appears once a table row is selection-checked, for a bulk action |
| `.admin-two-pane` | A list + detail split — inbox; **not** POS, whose cart side needs POS-specific controls a generic two-pane does not model, so POS keeps its own `.pos-layout` |
| `.admin-toggle` | A feature on/off switch — settings |
| `.admin-timeline` | An ordered, timestamped event list — the order detail page's status history from `order_events` |
| `.admin-media-grid` | A selectable image grid with a side detail panel — not yet consumed by any `commerce` screen; adopt it rather than inventing a grid layout when one is needed |

**Real data only, on every screen** — a stat, count, or row this module cannot honestly compute from an existing table or projection is omitted, never filled with a placeholder or invented number (the dashboard's own missing conversion-rate stat, absent for lack of a funnel/visit projection, is the pattern to follow). A shared cross-page partial (the marketing tab strip) lives under `apps/cms/src/components/`, never `apps/cms/src/pages/admin/` — `access-chokepoint-check.ts` walks every `.astro` file under that tree looking for a `loadAdminScreen` call, and a shared partial placed there reads as an extra screen with no chokepoint.

## Verification

```bash
cd apps/cms && DATABASE_URL="" bun run check     # full ~53-step chain
# then, against a disposable Postgres (bun run db:up from the repo root):
cd apps/cms && DATABASE_URL=postgres://... bun test tests/integration/ --timeout 60000
```

From the repo root, if your change touched `docs/**`, `.changesets/**`, or anything root-owned: `bun test`, `bun run audit:dokumen`, `audit:translation`, `audit:rilis`, `audit:graf`. See [`docs/pengujian.md`](../../../docs/pengujian.md) for what each tier proves and the two `Bun.SQL` quirks above in more depth.
