# Commerce bounded contexts and upstream architecture fitness — research

Version: v0.1.0 | Date: 2026-11-28 | Status: PROPOSED, research only
Document changeset: initial candidate context map and adoption verification. History: v0.1.0 initial.
Issue #601; no accepted ADR amendment.

## Evidence and scope
AGENTS.md blob c6ed72f8b5a29c3559d67c5b905e9344227387cd and docs/status.md blob 3dde77494069a2134339e4a1708f397d02edeefd read on default branch. ADR-0008 describes one commerce module, ADR-0024 says template only; upstream apps/cms via subtree, apps/storefront static Astro, packages/kontrak typed DTOs. Actual code/SQL/domain audit not yet complete. #280/#281 cover capability work; do not duplicate. Generic architecture controls belong upstream #1543/#1544/#1545. No consumer-specific backend/data/runtime in template; each consumer owns database, deployment, migration, secrets, UAT and release. Preserve three SITE_PROFILE choices toko/berita/landing and local-ci gates. No runtime module split or SSR change.

## Candidate context map (logical only; not implementation claims)
| Context | Example authority / interaction to validate |
|---|---|
| Catalog | product definitions, variants, public read projection |
| Pricing/promotion | price rule, quote/version snapshot, voucher decisions |
| Cart/checkout | purchase intent, input validation, idempotent submit |
| Order | order lifecycle and authoritative order status |
| Inventory | stock/reservation owner via existing upstream port; verify actual contract |
| Payment | provider transaction/status owner via existing adapter; finance boundaries separate |
| Fulfillment | shipment/dispatch state and event, provider integration |
| Returns/refunds | authorized return/refund state, reconciliation |
| Customer | existing identity/profile authority, scoped reads |
| Loyalty/merchant | candidate capabilities only; assess roadmap/actual ownership first |

Do not create a new module or physical package for each logical context. Identify aggregate/invariant, owning table(s)/SQL writer, port/DTO/version, caller, permission, tenant scope, transaction boundary, events, read model, dependency exceptions, owner and evidence. Mark implemented/partial/planned/deferred at pinned checkout. Preserve existing checkout atomicity, authorization, RLS FORCE, stock/payment/ledger invariants and approved FK; no blanket removal of joins or FK. Canonical single writer; no direct cross-domain mutation; valid reporting path reviewed. Local adapter can share transaction; remote adapter introduces timeout, duplicate/reordered event, partial failure and reconciliation. Reuse upstream outbox/consumer runtime; no Kafka or new dependency just to match demo. Independent concepts only, no external code/license assumption.

## Adoption workflow
1. Pin upstream and subtree SHAs and compare existing source, SQL, contracts, tests and current divergence record; reconcile issue ownership.
2. Audit internal commerce contexts and five synthetic business scenarios: catalog/price quote, stock reservation concurrency, order/checkout retry, duplicate/out-of-order provider status, return/refund unknown outcome; cross-tenant negative access for each.
3. Propose targeted changes only after applicable Gate 9. Generic gates upstream; no local patch to shared infrastructure. Versioned public DTOs; compatibility and idempotency fixtures.
4. After verified upstream release, subtree sync using merge commit (never squash/rebase); no implicit upgrade to consumer deployment.
5. Verify toko/berita/landing, template:init, CMS real PostgreSQL tests, contract parity, security, E2E and all required local-ci checks. Consumer UAT/release/rollback in consumer repo. Track template-upgrade adoption with evidence.
6. Extraction only under AWCMS ADR-0013 §7 mandatory measured conditions plus backfill, shadow read, cutover, rollback, no dual write and telemetry. Not a mandate.

No actual benchmark, code change, migration, deployment or release. Future adoption requires measured value, CI evidence, review and consumer-controlled rollback. Review docs en/id, navigation/changeset according to repo conventions.
## Sources
- https://github.com/ahliweb/awcms/issues/1543 ; https://github.com/ahliweb/awcms/issues/1544 ; https://github.com/ahliweb/awcms/issues/1545
- https://doi.org/10.1145/361598.361623 ; https://doi.org/10.3390/fi17110496 ; https://doi.org/10.1002/spe.70062
- https://www.postgresql.org/docs/18/ddl-constraints.html ; https://www.postgresql.org/docs/18/ddl-rowsecurity.html
- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html ; https://docs.spring.io/spring-modulith/reference/verification.html
