---
bump: patch
type: dependency
impact: internal
---

# apps/cms synced to ahliweb/awcms a0dabcd9

`apps/cms` now carries upstream `main` at `a0dabcd9`: the `sharp`, `shell-quote` and `source-map-js` advisory fixes (ahliweb/awcms#920) and `InventoryLedgerPort.listBalances`, a paged, read-only listing of ledger balances (ahliweb/awcms#913). No new migration, no conflict beyond the regenerated `apps/cms/docs/awcms/repo-inventory.md`.
