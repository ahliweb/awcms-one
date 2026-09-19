---
type: community
cohesion: 0.18
members: 16
---

# MySQL Dump Reader

**Cohesion:** 0.18 - loosely connected
**Members:** 16 nodes

## Members
- [[dot-columnsFor()]] - code - tools/lib/mysql-dump-reader.ts
- [[dot-constructor()_4]] - code - tools/lib/mysql-dump-reader.ts
- [[dot-feed()]] - code - tools/lib/mysql-dump-reader.ts
- [[dot-isAtRest()]] - code - tools/lib/mysql-dump-reader.ts
- [[DumpRow]] - code - tools/lib/mysql-dump-reader.ts
- [[Mode]] - code - tools/lib/mysql-dump-reader.ts
- [[SqlInsertTokenizer]] - code - tools/lib/mysql-dump-reader.ts
- [[TupleEvent]] - code - tools/lib/mysql-dump-reader.ts
- [[TupleParseResult]] - code - tools/lib/mysql-dump-reader.ts
- [[extractCreateTableColumns()]] - code - tools/lib/mysql-dump-reader.ts
- [[findMatchingParen()]] - code - tools/lib/mysql-dump-reader.ts
- [[findNextStatementStart()]] - code - tools/lib/mysql-dump-reader.ts
- [[mysql-dump-reader.ts]] - code - tools/lib/mysql-dump-reader.ts
- [[readMysqlDumpRows()]] - code - tools/lib/mysql-dump-reader.ts
- [[tryParseValueTuple()]] - code - tools/lib/mysql-dump-reader.ts
- [[unescapeChar()]] - code - tools/lib/mysql-dump-reader.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/MySQL_Dump_Reader
SORT file.name ASC
```

## Connections to other communities
- 5 edges to [[_COMMUNITY_Importer Record Builders & Legacy URLs]]
- 3 edges to [[_COMMUNITY_Legacy Taxonomy Mapping (Importer)]]
- 2 edges to [[_COMMUNITY_runExport]]
- 1 edge to [[_COMMUNITY_Build Smoke Harness (Bun Spawn)]]

## Top bridge nodes
- [[readMysqlDumpRows()]] - degree 8, connects to 4 communities
- [[mysql-dump-reader.ts]] - degree 14, connects to 2 communities
- [[SqlInsertTokenizer]] - degree 6, connects to 1 community
- [[tryParseValueTuple()]] - degree 4, connects to 1 community
- [[extractCreateTableColumns()]] - degree 3, connects to 1 community