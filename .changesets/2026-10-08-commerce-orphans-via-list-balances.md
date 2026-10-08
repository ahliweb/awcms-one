---
bump: patch
type: fix
impact: internal
---

# Commerce orphan detection reads balances through the inventory port

`listLedgerOrphans` (the `orphans` section of the stock reconciliation) no longer `SELECT`s `awcms_inventory_balances` directly. It pages `InventoryLedgerPort.listBalances` (synced from upstream awcms#913) and classifies each page against commerce's own tables in one query, so commerce no longer reads any inventory table. The report is unchanged: same reasons, same ordering, same `ORPHAN_LIMIT` cap.

- The walk is bounded at `ORPHAN_SCAN_MAX_PAGES` (100 pages of 500 balances); stopping at that cap sets `truncated: true`, which the old unbounded query never needed.
- The `sql/947` worker `SELECT` grant on `awcms_inventory_balances` is now unused by commerce and is deliberately left in place.
- ADR-0038's "Orphan detection" paragraph and the commerce README are updated.
