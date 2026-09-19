---
type: community
cohesion: 0.09
members: 26
---

# Legacy Taxonomy Mapping (Importer)

**Cohesion:** 0.09 - loosely connected
**Members:** 26 nodes

## Members
- [[ADR-0114]] - concept - tools/import-seputarborneo.ts
- [[BASE_URL]] - code - tools/import-seputarborneo.ts
- [[BuildResult]] - code - tools/import-seputarborneo.ts
- [[DAERAH_LEAF_LABELS]] - code - tools/import-seputarborneo.ts
- [[ExportOptions]] - code - tools/import-seputarborneo.ts
- [[LegacyImportRecordJson]] - code - tools/import-seputarborneo.ts
- [[Manifest]] - code - tools/import-seputarborneo.ts
- [[ManifestSkip]] - code - tools/import-seputarborneo.ts
- [[NormalizedTaxonomy]] - code - tools/import-seputarborneo.ts
- [[PLAIN_RUBRIK_SLUGS]] - code - tools/import-seputarborneo.ts
- [[PendingAssignment]] - code - tools/import-seputarborneo.ts
- [[PublishedAtResult]] - code - tools/import-seputarborneo.ts
- [[RFC-3986]] - concept - tools/import-seputarborneo.ts
- [[RedirectEntry]] - code - tools/import-seputarborneo.ts
- [[SOCIAL_COLUMNS]] - code - tools/import-seputarborneo.ts
- [[SiteProfileUpdate]] - code - tools/import-seputarborneo.ts
- [[SqlValue]] - code - tools/lib/mysql-dump-reader.ts
- [[TaxonomyMapResult]] - code - tools/import-seputarborneo.ts
- [[TaxonomyOutcome]] - code - tools/import-seputarborneo.ts
- [[TermMapHint]] - code - tools/import-seputarborneo.ts
- [[UMUM_LEAF_LABELS]] - code - tools/import-seputarborneo.ts
- [[UMUM_WISATA_SLUG_CANDIDATES]] - code - tools/import-seputarborneo.ts
- [[import-seputarborneo.ts]] - code - tools/import-seputarborneo.ts
- [[mapLegacyTaxonomy()]] - code - tools/import-seputarborneo.ts
- [[normalizeLegacyTaxonomy()]] - code - tools/import-seputarborneo.ts
- [[reformatLegacyVideoTimestamp()]] - code - tools/import-seputarborneo.ts

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Legacy_Taxonomy_Mapping_Importer
SORT file.name ASC
```

## Connections to other communities
- 18 edges to [[_COMMUNITY_Importer Record Builders & Legacy URLs]]
- 14 edges to [[_COMMUNITY_runExport]]
- 6 edges to [[_COMMUNITY_redirect-push.ts]]
- 3 edges to [[_COMMUNITY_MySQL Dump Reader]]

## Top bridge nodes
- [[import-seputarborneo.ts]] - degree 61, connects to 4 communities
- [[mapLegacyTaxonomy()]] - degree 5, connects to 1 community
- [[normalizeLegacyTaxonomy()]] - degree 5, connects to 1 community
- [[reformatLegacyVideoTimestamp()]] - degree 3, connects to 1 community
- [[SqlValue]] - degree 3, connects to 1 community