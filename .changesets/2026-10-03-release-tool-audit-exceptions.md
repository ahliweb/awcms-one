---
bump: patch
type: fix
impact: internal
---

# The release tool honours the same dated audit exceptions as local CI

`bun run release --apply` ran a plain `bun audit --audit-level=low` and would
refuse every release on the accepted, unfixable `http-cache-semantics`
advisory (`GHSA-ch52-4w7c-c8xp`) that `local-ci/check-toko` and
`local-ci/security` already skip. It now runs `bun audit` through
`tools/ci/lib/audit-exceptions.ts` like both legs do — the same
`tools/ci/dependency-audit-exceptions.json`, and the same refusal once an
entry's `reviewDate` has passed.
