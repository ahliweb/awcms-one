🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0024-awcms-one-is-template-only-derived-apps-own-their-backend.id.md)

# ADR-0024 — awcms-one is template-only; derived applications own their backend and runtime

- **Status:** Accepted
- **Date:** 3 October 2026
- **Decision maker:** ahliweb
- **Related:** [ADR-0018](0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md); issue [#297](https://github.com/ahliweb/awcms-one/issues/297)

## Context

`awcms-one` is both a working reference deployment and a GitHub template. A derived product can therefore be tempted to keep its frontend in another repository while pointing production traffic back to this repository's live `apps/cms`. That turns a template into a centrally shared application backend, mixes consumer-specific lifecycle and data into the reference deployment, and causes product issues to be implemented in a repository that does not own the resulting product.

IRMbyDUS exposed the problem concretely: its product repository owns PRD, UX, privacy and frontend work, while several IRM-specific backend issues were placed in `awcms-one` and were being implemented as modules in the template itself. Generic improvements such as commerce entitlement and protected private-media delivery are reasonable template capabilities; IRM practice cycles, a 21-day program, private IRM journals and IRM mentoring semantics are product-domain concerns.

## Decision

### D1 — The template is not a shared backend service

An application created from or based on `awcms-one` MUST own and operate its own backend instance in its own repository/deployment boundary. It owns its database, migrations, environment/secrets, domains, provider credentials, jobs, product data, backups, observability and release lifecycle.

A derived application MUST NOT use the reference deployment of `ahliweb/awcms-one/apps/cms` as its production system of record merely because the required API already exists here.

### D2 — Issue placement follows code ownership

A product-specific backend issue belongs to the product repository that will contain the implementation. Product requirements, UX, UAT, legal/compliance, operations and deployment also remain in that product repository.

An issue belongs in `awcms-one` only when its implementation is intended to become a neutral reusable template capability.

### D3 — Consumer needs may promote reusable capabilities, not consumer domains

A missing capability discovered by a consumer may be added to this template only after an explicit classification:

- **Consumer-specific:** stays in the consumer repository.
- **Reusable template capability:** may be proposed here after product names, content, one-off workflow assumptions and deployment-specific configuration are removed, and after reuse is demonstrated through neutral contracts/tests.
- **AWCMS-owned foundation:** lands in `ahliweb/awcms` first, then arrives here through the established subtree sync.

The fact that only one consumer currently needs a feature is evidence to examine generality, not permission to put that consumer's domain model in this template.

### D4 — No consumer production tenancy or secrets in the reference deployment

Do not provision a derived product's production tenant, domain verification, API token, secrets, private customer content, product-specific queues/jobs or operational state in this repository's reference deployment.

The reference deployment may host neutral development/test fixtures used to prove template behaviour, but those fixtures cannot become the consumer's production dependency.

### D5 — Derived repositories may adopt later template releases deliberately

A derived repository may later import/sync/cherry-pick an approved template capability according to its own migration and regression plan. This is a **source evolution relationship**, not a runtime service dependency.

Template availability must never be in the derived product's production availability path.

### D6 — Existing generic IRM-triggered improvements remain; IRM domain work moves

Already-merged generic capabilities introduced while building IRMbyDUS — such as additional generic commerce product types, commerce entitlements, and private-media signed downloads — remain in `awcms-one` because they are reusable baseline capabilities.

Open IRM-specific domain work (practice, program, journal, progress, mentoring and IRM deployment provisioning) moves to `ahliweb/web-irmbydus.com`. Generic booking/scheduling or other capabilities discovered by that product may later be promoted separately under D3.

## Consequences

- Derived applications are independently deployable and recoverable.
- Product data and secrets stay inside the product's own operational boundary.
- `awcms-one` remains reusable instead of accumulating one-off vertical modules.
- Some useful improvements will be implemented twice temporarily: first as a product-specific need, then extracted/promoted into the template. That duplication is preferable to coupling product availability to a shared reference deployment.
- Cross-repo contracts become template/version adoption concerns, not live service dependencies.
- New agents must classify ownership before opening an issue or editing code.

## Verification

For every new feature request originating from a derived application, the PR/issue must identify:

1. final code-owning repository;
2. runtime/deployment owner;
3. whether the feature is consumer-specific, reusable template capability, or AWCMS-owned foundation;
4. migration/compatibility path if the consumer later adopts a promoted template implementation.

A review fails Definition of Ready if those four answers are missing.
