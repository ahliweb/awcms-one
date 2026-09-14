# Changelog

Every entry below is folded from `.changesets/` by `bun run release`, which also tags the release. The version is `MAJOR.MINOR.PATCH`, tagged `vX.Y.Z`; the next version is the largest `bump` declared among the changesets a release folds (see [`.changesets/README.md`](.changesets/README.md)) — never a level chosen at release time from a list of file names.

## [0.1.0] — 2026-09-15

Initial workspace scaffolding, landed before the `.changesets/` convention itself existed — recorded here by hand rather than folded from a changeset entry.

- Bun workspace root (`workspaces: ["apps/*", "packages/*"]`), pinned toolchain (`bun@1.4.0`), and the dotfiles that govern it (`.gitignore`, `.editorconfig`, `.dockerignore`).
- `packages/config` — the shared `tsconfig.base.json` preset.
- `apps/cms` — `ahliweb/awcms` v10.3.0, embedded whole via `git subtree` with full history (closes #2).
