---
bump: patch
type: dependency
impact: internal
---

# Close the devalue/fast-uri advisories; accept the unfixable http-cache-semantics one with a date

New advisories against transitive dependencies turned `main` red on
`local-ci/check-toko` (`bun audit`) and `local-ci/check-cms`
(`deps:audit:check`) without any change in this repository — every open PR
inherited the failure.

- `devalue` 5.9.2 → 5.9.3 and `fast-uri` 3.1.7 → 3.1.8, both inside every
  dependent's declared range, so `bun audit fix` closed them in `bun.lock`
  alone.
- `http-cache-semantics` (`GHSA-ch52-4w7c-c8xp`) has no fixed release at all.
  Its only consumer is `astro`'s build-time remote-image cache, never a shared
  request-time cache, so it is accepted as a dated, reasoned exception (review
  by 2026-11-03) in `apps/cms`'s `deps:audit:check` list and in a new root
  `tools/ci/dependency-audit-exceptions.json`, which `local-ci/check-toko` and
  `local-ci/security` (the two legs that run `bun audit`) now pass to
  `bun audit --ignore`, and which fails either leg once an entry's review date
  has passed.
