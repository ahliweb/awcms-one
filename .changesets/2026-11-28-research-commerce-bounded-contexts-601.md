---
bump: patch
type: docs
impact: internal
---

# Research: commerce bounded contexts and upstream architecture fitness (issue #601)

Adds `docs/research-commerce-bounded-contexts.md` (with its Indonesian mirror) and an index section in `docs/README.md` and its mirror. The document is proposed research only: a candidate logical context map for commerce, the module layout it must start from (the embedded `apps/cms` registers more modules than ADR-0008 describes), and a proposed adoption workflow. Its references were checked on 2026-11-28; three DOI links could not be opened and are marked as not verified.

No code, schema, workflow, test, dependency or deployment changed, and no ADR is amended. The "why" for a changeset anyway: a later release note should be able to point at where the module-layout mismatch with ADR-0008 was first written down.
