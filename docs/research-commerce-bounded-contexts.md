🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](research-commerce-bounded-contexts.id.md)

# Commerce bounded contexts and upstream architecture fitness — research

**Version:** v0.2.0 | **Updated:** 2026-11-28 | **Status:** PROPOSED, research only. Nothing below is a rule, a decision, a gate result or permission to implement.
**Document changeset:** Takeover revision: claims checked against the tree and ADRs, module layout corrected, reference verification added.
**Tracking:** issue [#601](https://github.com/ahliweb/awcms-one/issues/601). No accepted ADR is amended by this document.

## Evidence and scope

Read at takeover (2026-11-28) on the default branch at commit `b95d76d54cbb482587ffb2b7ef6e409c48771838`. These pins describe that state and go stale when the files change.

| Source | Pin at takeover |
| --- | --- |
| [`AGENTS.md`](../AGENTS.md) | blob `c6ed72f8b5a29c3559d67c5b905e9344227387cd` |
| [`status.md`](status.md) | blob `3dde77494069a2134339e4a1708f397d02edeefd` |

What the sources say, and what was checked:

- [ADR-0008](adr/0008-one-commerce-module-carries-the-whole-store-not-three.md) (Accepted, 16 September 2026) placed the whole store of its increment under one `commerce` module key. It does **not** describe today's module layout: the embedded `apps/cms` now registers further modules, among them `inventory`, `booking`, `procurement`, `tax`, `reporting`, `crm-leads` and `domain-event-runtime` (module directories present on the pinned default branch; their contracts were not audited here). Any context map must start from that layout, not from ADR-0008 alone.
- [ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.md) (Accepted): this repository is template-only, and a derived application owns its own backend, database, migrations, secrets, deployment and release.
- [ADR-0018](adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) (Accepted) defines the three build profiles `toko`, `berita` and `landing` selected by `SITE_PROFILE`, and the idempotent `template:init`.
- [ADR-0058](adr/0058-contract-parity-fixtures-with-schema-check-consumer-slice-at-the-root-and-generic-gaps-go-upstream.md) (Accepted, 20 November 2026) already routes generic gaps upstream; this document follows the same direction.
- [ADR-0001](adr/0001-git-subtree-with-full-history-for-apps-cms.md) (Accepted): `apps/cms` is embedded by `git subtree` with full history; per [`AGENTS.md`](../AGENTS.md) a sync PR is merged with a merge commit.
- Topology: `apps/cms` (upstream subtree), `apps/storefront` (static Astro) and `packages/kontrak` (typed DTOs).
- Issues [#280](https://github.com/ahliweb/awcms-one/issues/280) and [#281](https://github.com/ahliweb/awcms-one/issues/281) are closed epics (AW Business Platform; OSPOS capability-gap adaptation). Their capability work is not repeated here.
- Generic architecture controls belong in the upstream repository `ahliweb/awcms`, which has open research issues [#1543](https://github.com/ahliweb/awcms/issues/1543) (declared versus actual module dependency graphs), [#1544](https://github.com/ahliweb/awcms/issues/1544) (module data ownership and tenant-safe referential integrity) and [#1545](https://github.com/ahliweb/awcms/issues/1545) (transaction and event boundary guarantees). This repository does not duplicate them.
- No consumer-specific backend, data or runtime belongs in the template: each consumer owns its database, deployment, migration, secrets, UAT and release (ADR-0024).

The actual code, SQL and domain audit is **not done**. The template keeps its three `SITE_PROFILE` choices and its `local-ci` gates. This document proposes no runtime module split and no SSR change.

## Candidate context map (logical only; not implementation claims)

| Context | Example authority / interaction to validate |
| --- | --- |
| Catalog | product definitions, variants, public read projection |
| Pricing/promotion | price rule, quote/version snapshot, voucher decisions |
| Cart/checkout | purchase intent, input validation, idempotent submit |
| Order | order lifecycle and authoritative order status |
| Inventory | stock/reservation owner; an `inventory` module with an append-only stock ledger exists upstream, so the actual contract and the consumers' use of it are to be verified |
| Payment | provider transaction/status owner via existing adapter; finance boundaries separate |
| Fulfillment | shipment/dispatch state and event, provider integration; no file named after shipment or fulfillment was found under module `domain` or `application` directories at the pinned checkout (a file-name search only, not an audit) |
| Returns/refunds | authorized return/refund state, reconciliation |
| Customer | existing identity/profile authority, scoped reads |
| Loyalty/merchant | candidate capabilities only; assess roadmap and actual ownership first |

Proposed principles to evaluate (none is adopted):

- Do not create a new module or physical package for each logical context.
- For each context, identify: aggregate and invariant, owning table(s) and SQL writer, port/DTO/version, caller, permission, tenant scope, transaction boundary, events, read model, dependency exceptions, owner and evidence. Mark each implemented, partial, planned or deferred at a pinned checkout.
- Preserve the existing checkout atomicity, authorization, row-level security with `FORCE` (see [`skema-basis-data.md`](skema-basis-data.md)), stock/payment/ledger invariants and approved foreign keys. No blanket removal of joins or foreign keys.
- One canonical writer per data set; no direct cross-domain mutation; a reviewed path for valid reporting reads.
- A local adapter can share a transaction; a remote adapter introduces timeout, duplicate or reordered events, partial failure and reconciliation.
- Reuse the upstream outbox and consumer runtime (the `domain-event-runtime` module directory); no Kafka and no new dependency just to match a demonstration.
- Independent concepts only; no external code, license or product assumption.

## Adoption workflow (proposed)

1. Pin the upstream and subtree commits, and compare existing source, SQL, contracts, tests and the current divergence record; reconcile issue ownership.
2. Audit the internal commerce contexts with five synthetic business scenarios: catalog and price quote, stock reservation concurrency, order/checkout retry, duplicate or out-of-order provider status, and return/refund with an unknown outcome; add a cross-tenant negative access case for each.
3. Propose targeted changes only after the applicable gate 9. Generic gates go upstream; no local patch to shared infrastructure. Versioned public DTOs; compatibility and idempotency fixtures.
4. After a verified upstream release, sync the subtree with a merge commit (never squash or rebase); no implicit upgrade of any consumer deployment.
5. Verify `toko`, `berita` and `landing`, `template:init`, the CMS real-PostgreSQL tests, contract parity, security, end-to-end tests and every required `local-ci` check. Consumer UAT, release and rollback stay in the consumer repository. Track template-upgrade adoption with evidence.
6. Extract a service only under the upstream `ahliweb/awcms` ADR-0013 §7 (a different numbering space from this repository's own [ADR-0013](adr/0013-rule-based-legacy-redirects-beside-the-row-based-map.md)): all six measured conditions, plus backfill, shadow read, cutover, rollback, no dual write and observability evidence. That ADR states it is not a mandate.

No benchmark, code change, migration, deployment or release is part of this document. Any future adoption needs measured value, CI evidence, review and a consumer-controlled rollback.

## Reference verification at takeover (2026-11-28)

Each source URL was opened once, read-only, on 2026-11-28. The reading was a model summary of the page, not a raw copy.

- **Supported (9 of 12):** the three upstream issues (title and open state read through the GitHub API); PostgreSQL 18 [Constraints](https://www.postgresql.org/docs/18/ddl-constraints.html) (covers foreign keys and referential integrity) and [Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html) (covers `FORCE ROW LEVEL SECURITY`); the AWS transactional outbox page (dual-write problem, outbox table, idempotent consumers, ordering); the Spring Modulith verification page (cycles, access to internals, allowed dependencies).
- **Not verified at takeover (3 of 12):** the three DOI links in Sources. Each redirected to a publisher page that returned HTTP 403. Their titles, authors and years are not stated here and nothing in this document relies on them.
- **Corrections made:** none of the cited sources needed correction. Corrections were made to claims about this repository: the status of #280 and #281 (closed), the module layout (ADR-0008 alone is not current), the ambiguity of the ADR-0013 citation, and the unverified fulfillment and inventory wording.
- This section reports only what was opened on the date above; it makes no claim about later changes to those pages.

## Sources

- https://github.com/ahliweb/awcms/issues/1543 ; https://github.com/ahliweb/awcms/issues/1544 ; https://github.com/ahliweb/awcms/issues/1545
- https://doi.org/10.1145/361598.361623 ; https://doi.org/10.3390/fi17110496 ; https://doi.org/10.1002/spe.70062 (not verified at takeover)
- https://www.postgresql.org/docs/18/ddl-constraints.html ; https://www.postgresql.org/docs/18/ddl-rowsecurity.html
- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html ; https://docs.spring.io/spring-modulith/reference/verification.html

## Changelog

### v0.2.0 (2026-11-28)

Takeover revision. Claims about this repository checked against the default branch and corrected; module layout updated beyond ADR-0008; closed epics stated; ADR-0013 citation disambiguated; reference verification section added; status kept as proposed research.

### v0.1.0 (2026-11-28)

Initial candidate context map and adoption verification, created by another session as a draft.
