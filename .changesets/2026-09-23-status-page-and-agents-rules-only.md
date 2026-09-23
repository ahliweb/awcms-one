---
bump: patch
type: docs
impact: internal
---

# A single current-state status page; AGENTS.md becomes working rules only

`AGENTS.md`'s "What this repo is"/"What is here today" sections had grown into an increment-by-increment chronicle that went stale the moment the next increment landed — "Increment 1 — this epic — is foundation... with no live database" was still there after five increments. History belongs in `CHANGELOG.md` and the ADR index, not in the working contract a reader consults on every task.

- New `docs/status.md` (+ `.id.md`): the single, concise, current-state reference — what exists by surface (storefront per build profile, the `commerce` module, customer accounts, external integrations, ops/deploy, the template mechanism) and the short "not here yet" list, each item linking to its own document or ADR.
- `AGENTS.md` (+ `.id.md`): the two chronicle sections are replaced with a short summary pointing at `docs/status.md`; every working rule (the subtree embed, migration ranges, build profiles, the gates, the knowledge graph, toolchain, changesets, DoD, language, the bearer-session and `ROUTE_PARITY_EXEMPTIONS` rules) is kept in substance.
- `docs/README.md` (+ `.id.md`): added a `status.md` row, fixed the ADR count (eighteen → twenty), and made the `ui-ux.md`/`aksesibilitas.md`/`responsif.md` rows describe the documents as they are now (a design system with real product imagery; automated axe-core/browser-overflow verification, not only a manual read).
- Fixed a handful of present-tense claims elsewhere that contradicted the current tree: `docs/skema-basis-data.md` citing ADR-0016 as "not yet written" (it has been since increment 4), and `docs/arsitektur.md`'s epic-chronicle opening paragraph (now points at `docs/status.md` instead).
- `AGENTS.md`'s Dependabot bullet also updated to match reality: no `bun` ecosystem block (Dependabot's updater cannot parse this repo's `bun.lock` `lockfileVersion` 2 — issue #199), workspace dependencies bumped by hand instead.
