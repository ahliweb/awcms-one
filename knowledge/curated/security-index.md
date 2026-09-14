# Security and tenant-isolation boundaries

Where this platform's security posture actually lives, and what is — and is not — this repo's own to define. Thin on purpose: the substance is canonical elsewhere, and copying it here would let the copy drift from the policy it restates.

## Canonical sources

- **`apps/cms`'s threat model and layered controls**: [`apps/cms/docs/awcms/20_threat_model_security_architecture.md`](../../apps/cms/docs/awcms/20_threat_model_security_architecture.md) — the default-deny authorization stack (ABAC + PostgreSQL row-level security + "the UI is not a control"), owned by `ahliweb/awcms` and consumed here read-only, same as the rest of `apps/cms`'s own policy (see [`ownership-boundaries.md`](ownership-boundaries.md)).
- **This repo's own attack surface and vulnerability reporting**: root [`SECURITY.md`](../../SECURITY.md).
- **Tenant isolation specifically**: `apps/cms`'s own ADRs establish it is never one layer — [`apps/cms/docs/adr/0003-postgresql-rls-multi-tenant.md`](../../apps/cms/docs/adr/0003-postgresql-rls-multi-tenant.md) (force row-level security) and [`apps/cms/docs/adr/0004-rbac-abac-default-deny.md`](../../apps/cms/docs/adr/0004-rbac-abac-default-deny.md) (default deny, deny overrides allow) are the base every module inherits; row-level security is enforced at the database, not only in application code.

## What this repo adds, not restates

`awcms-one` introduces no new tenant model — `apps/cms` embeds `awcms`'s existing one whole, and `apps/storefront` is a public, read-only consumer of `apps/cms`'s public API, so it inherits that boundary rather than defining its own. The one genuinely NEW security surface this repo owns is the knowledge-graph workflow itself ([issue #11](https://github.com/ahliweb/awcms-one/issues/11)): what it might index, where its output might leak, and how automation is kept from writing where it should not. That threat model — nine specific risks and their controls — is in [`../README.md`](../README.md#security-and-privacy-what-this-workflow-considers-and-does-not-certify), not duplicated here.

## What this file does not claim

No ISO/IEC 27001/27002/27005/27034/27701 certification or formal compliance is asserted anywhere in this repository or this directory — only alignment with their general principles, stated exactly that plainly in [`../README.md`](../README.md#security-and-privacy-what-this-workflow-considers-and-does-not-certify).
