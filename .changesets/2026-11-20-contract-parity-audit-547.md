---
bump: patch
type: docs
impact: internal
---

# Research report: CMS and storefront contract parity across the three profiles (issue #547)

Adds `docs/audit-paritas-kontrak-cms-storefront.md` (with its Indonesian mirror) and its index rows. The report is findings only: an evidence matrix of every operation the storefront calls for `toko`, `berita` and `landing`, a protocol that keeps TypeScript types apart from HTTP behaviour, sixteen classified findings against baseline `66b9985ad753d815ad8f85f6392487087f4a8e8f`, and the mock-versus-fixture ownership question.

No code, schema, workflow, test or deployment changed. The "why" for a changeset anyway: the report's main finding is that the storefront's tests run against a hand-written stub that nothing compares with the OpenAPI document, and a later release note should be able to point at where that was first written down.
