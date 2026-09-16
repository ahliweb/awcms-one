🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0008-one-commerce-module-carries-the-whole-store-not-three.id.md)

# ADR-0008 — One `commerce` module carries the whole store, not three

- **Status:** Accepted
- **Date:** 16 September 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0001](0001-git-subtree-with-full-history-for-apps-cms.md) (Consequences: the 29 shared files a module admission touches); [ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md); [issue #21](https://github.com/ahliweb/awcms-one/issues/21); issues #23, #26, #29; [`apps/cms/src/modules/commerce/README.md`](../../apps/cms/src/modules/commerce/README.md)

## Context

Increment 2 adds catalog depth (images, variants, tiers), marketing (flash sales, vouchers, sliders, testimonials, popups, store settings) and transactions (customers, orders, payments, reviews) to `apps/cms`. The question was whether those are three modules (`commerce`, `commerce_marketing`, `commerce_orders`) or one.

| | Three modules | One module (**chosen**) |
| --- | --- | --- |
| Parallel delivery | three agents could touch three `module.ts` files — but every admission still edits the same `apps/cms/src/modules/index.ts`, event registry, sidebar menu, coverage ledger, OpenAPI bundle and generated inventories (ADR-0001's 29-file list, three times) | CMS work is serialised per wave; storefront and ops work runs beside it |
| Maintainability | three `dependencies` edges between what is one aggregate (an order references products, variants, flash-sale prices and vouchers) | one bounded context, the granularity `blog_content` already uses (forty application files under one key) |
| Security | three permission namespaces with the same actors | one `commerce.*` namespace for owners/admins; the customer-facing surface is anonymous and Origin-bound (ADR-0007), so it is a distinct trust level by route family, not by module |
| Data lifecycle / subject data | descriptors split across modules that all answer for the same customer | one registry answers "what do we hold about this phone number" |
| Long-term | a later split is mechanical (tables and directories already grouped by area) | a later merge of three modules is not |

## Decision

All commerce tables, directories, routes, permissions, events, jobs and admin screens live under the single module key `commerce`, grouped by area inside it (`domain/{catalog,marketing,orders}/…` is a directory convention, not a module boundary). The module's `dependencies` gain `media_library` (product images) and nothing else.

## Consequences

- CMS issues in this epic merge one at a time; each PR regenerates the inventories after the previous one landed (`apps/cms`'s `bun run check` names every stale generator).
- The `commerce` module's own [`README.md`](../../apps/cms/src/modules/commerce/README.md) is the map of the module and is rewritten in every CMS PR of this epic — it is a deliverable, not a follow-up. This repository's own [`docs/skema-basis-data.md`](../skema-basis-data.md), [`docs/kamus-data.md`](../kamus-data.md) and [`docs/cms.md`](../cms.md) link to it rather than duplicating it field by field.
