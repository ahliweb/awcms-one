🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0058-contract-parity-fixtures-with-schema-check-consumer-slice-at-the-root-and-generic-gaps-go-upstream.id.md)

# ADR-0058 — Contract parity: fixtures with a schema check first, the storefront consumer-contract slice at the repository root, and generic contract gaps go upstream

- **Status:** Accepted
- **Date:** 20 November 2026
- **Decision maker:** ahliweb (owner decision of 20 November 2026, chosen through a decision dialog)
- **Related:** [`docs/audit-paritas-kontrak-cms-storefront.md`](../audit-paritas-kontrak-cms-storefront.md) (issue #547, section 8.1: the three decisions that waited for the owner); [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md) (ownership: this is a template); issue [#6](https://github.com/ahliweb/awcms-one/issues/6) (`packages/kontrak` is type-only); upstream issue [ahliweb/awcms#1385](https://github.com/ahliweb/awcms/issues/1385); backlog issues [#553](https://github.com/ahliweb/awcms-one/issues/553), [#554](https://github.com/ahliweb/awcms-one/issues/554), [#555](https://github.com/ahliweb/awcms-one/issues/555), [#556](https://github.com/ahliweb/awcms-one/issues/556), [#557](https://github.com/ahliweb/awcms-one/issues/557)

## Context

The contract parity audit found that the storefront's tests and browser runs exercise a hand-written stub (`apps/storefront/scripts/stub-awcms.mjs` and `apps/storefront/tests/fixtures/awcms`) that nothing compares with the OpenAPI document the CMS is checked against (findings F-01 and F-02). It also found gaps in the generic public contract that belong to the provider, not to this template: no declared `429` on 25 operations that raise `RATE_LIMITED`, and no machine-readable optional idempotency header (F-08 and F-09). Section 8.1 of the audit listed three decisions that waited for the owner. The owner decided them on 20 November 2026. This ADR records them so the backlog issues can cite one place.

## Decision

**D1 — Mock strategy: fixtures plus a schema check first.** Each storefront fixture is validated against the matching OpenAPI response schema by a gate that needs no database and no network and runs in `local-ci/check-toko`; fixtures that are declared subsets list the fields the consumer reads. A generated mock (a server produced from the OpenAPI document, with error and `429` examples) is deferred: it follows later only if a need appears, and per the audit's ownership table the generator belongs upstream while per-product seed data belongs to the product repository. The tiers are not exclusive; the schema check is a strict improvement on plain fixtures and adds no runtime dependency.

**D2 — The storefront consumer-contract slice lives in the root `tests/` of this repository, not in `apps/cms`.** `apps/cms` is a subtree of `ahliweb/awcms`; a local divergence there has a cost at every subtree sync and conflicts with ADR-0024 (the template does not edit the generic backend directly). The slice follows the additive-superset rule that `api:consumer-contract:check` already uses for `awcms-astro`, reads the OpenAPI bundle, imports nothing at runtime from `packages/kontrak`, and keeps the import-direction guard.

**D3 — `RATE_LIMITED` (`429`) and the optional idempotency header component are reported upstream, not patched in `apps/cms`.** The report is [ahliweb/awcms#1385](https://github.com/ahliweb/awcms/issues/1385). Upstream also chose to publish a pinned fixture pack for consumers (its option C'). This repository adopts the result after the next subtree sync that carries it, tracked by [#557](https://github.com/ahliweb/awcms-one/issues/557); until then the stub may not invent a `429` shape that the contract does not declare.

### Alternatives rejected

- **A generated mock first.** Rejected as the first step: it adds a dependency and a generator to maintain, and the largest verified gap (fixtures that contradict the schema) is closed by the schema check alone. It stays open as an upstream proposal if more than one consumer needs it.
- **The slice inside `apps/cms` next to the `awcms-astro` slice.** Rejected: it would be a local divergence in a subtree, repeated at every sync, unless proposed and accepted upstream first, which would delay a gate that can start today.
- **Patching `429` and idempotency in the `apps/cms` copy.** Rejected: the next subtree sync would overwrite or conflict with it, and consumers other than this template (`awcms-astro`, `awcms-lynx`) would not benefit.

### Criteria

| Criterion | D1 fixtures plus schema check | D2 root `tests/` | D3 upstream |
| --- | --- | --- | --- |
| Security | no new runtime surface | none | corrects the contract at the owner of the handler |
| Performance | static check, no database, no network | static check | none here |
| Maintainability | one gate replaces manual comparison | no subtree divergence | one fix for every consumer |
| Scalability | per-product fixtures reuse the same gate | per-product slices reuse the format | shared by all consumers |
| Compatibility | additive-subset rule already used | same rule as `awcms-astro` | follows the subtree sync |
| Operational complexity | one more `check-toko` step | one frozen file | waits for an upstream release |
| Long-term | a generator can be added later | stays valid if upstream publishes a pack | aligned with upstream option C' |

Accessibility, SEO and UI/UX are not affected: these are test and contract decisions with no rendered surface.

## Consequences

- Five backlog issues exist, all waiting for gate 9 and the Definition of Ready; none is implemented by this decision: [#553](https://github.com/ahliweb/awcms-one/issues/553) (fixture-versus-schema gate), [#554](https://github.com/ahliweb/awcms-one/issues/554) (correct fixtures F-03 to F-05 once the gate exists), [#555](https://github.com/ahliweb/awcms-one/issues/555) (frozen slice, build-time reads), [#556](https://github.com/ahliweb/awcms-one/issues/556) (frozen slice, browser calls), [#557](https://github.com/ahliweb/awcms-one/issues/557) (adopt `429` and idempotency after the subtree sync).
- The audit report's section 8.1 now points here instead of listing open decisions. Its findings are unchanged.
- No code, schema, workflow or test changes with this ADR. `apps/cms` is untouched.
- F-07 (the `tokens.css` route outside the bundle) remains an upstream report; #555 names the route explicitly but does not fix it here.
