## Summary

<!-- What changed, and why. A sentence or two is usually enough. -->

## Linked issue

Closes #

## How it was verified

<!-- Commands you actually ran, and their result — not "should work". e.g.

     bun test                        → OK
     bun run audit:dokumen           → OK
     cd apps/cms && bun run check    → OK (only if apps/cms/ was touched)
-->

## Definition of Done

Mirrors [`AGENTS.md`](../AGENTS.md#definition-of-done) in substance — check what applies, and say in "How it was verified" above what does not and why.

- [ ] Scoped to one workspace, or deliberately more than one (see `AGENTS.md`'s "Workspace boundaries").
- [ ] `bun install` resolves cleanly.
- [ ] Root `bun test` is green, and `bun run check:cms` too if `apps/cms/` was touched.
- [ ] `bun run audit:dokumen`, `bun run audit:rilis`, and `bun run audit:translation` are green.
- [ ] Any new or changed governance document ships its Indonesian mirror in this same change (`bun run docs:i18n:stamp`).
- [ ] A changeset is added under `.changesets/` when this affects public behaviour, workspace structure, dependencies, or deployment.
- [ ] Any new environment variable read by a root-level script is documented in `.env.example`.
- [ ] If this PR syncs `apps/cms/` from upstream (`git subtree pull`), it is merged with a **merge commit** — never squashed, never rebased. (n/a otherwise.)
- [ ] Documentation explaining the changed behaviour is updated in this same change.
