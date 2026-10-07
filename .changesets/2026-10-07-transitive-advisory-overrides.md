---
bump: patch
type: dependency
impact: internal
---

# Root `overrides` close four new transitive advisories

Advisories published on 6–7 October 2026 turned `bun audit` and `apps/cms`'s `deps:audit:check` red on every branch, `main` included. Each is closed by a root `package.json` `overrides` entry, which is the only place a Bun workspace honours overrides:

- `sharp` `^0.35.5` (GHSA-wq5f-xc86-pv6w, high, via `astro`)
- `shell-quote` `^1.12.0` (GHSA-pqg4-j6r4-53mv, critical, via `@changesets/cli` › `launch-editor`; development-only)
- `source-map-js` `^1.2.2` (GHSA-68fv-2mgg-jv7q, high, via `astro` › `unifont`)
- `smol-toml` `^1.9.0` (GHSA-r4xh-jqrq-34v2, moderate, via `@astrojs/internal-helpers`)

`apps/cms/package.json` is upstream's own file and is not edited. The same entries are worth proposing upstream to `ahliweb/awcms`, after which the root entries can go.
