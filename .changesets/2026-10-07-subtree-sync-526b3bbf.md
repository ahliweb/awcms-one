---
bump: patch
type: structure
impact: internal
---

# `apps/cms` synced to upstream `526b3bbf`: four-digit migration prefixes

Issue #329: the embedded AWCMS moves one commit past v10.5.0 to `526b3bbf` (ahliweb/awcms#911, upstream ADR-0130). `db-migrate` now accepts a three- or four-digit prefix and applies files in numeric order. Existing three-digit order is unchanged.

Per ADR-0037 D3, `apps/cms/tests/commerce-migrations-range.test.ts` widens the commerce band to `900`–`9999` in the same change. A commerce migration that cannot take a gap number continues at `1000`. No existing file is renamed, and no deployed database needs a ledger change.
