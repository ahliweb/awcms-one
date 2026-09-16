---
type: community
cohesion: 0.06
members: 40
---

# Build & E2E Tooling

**Cohesion:** 0.06 - loosely connected
**Members:** 40 nodes

## Members
- [[ADR-0002_2]] - concept - apps/storefront/tests/e2e/global-setup.ts
- [[ADR-0007_7]] - concept - apps/storefront/tests/e2e/global-setup.ts
- [[ADR-0042]] - concept - tests/audit-dokumen.test.mjs
- [[OUT_PATH]] - code - apps/storefront/scripts/write-build-id.mjs
- [[PREVIEW_PORT]] - code - apps/storefront/tests/e2e/ports.ts
- [[SCRIPT_2]] - code - tests/audit-dokumen.test.mjs
- [[SCRIPT]] - code - tests/audit-rilis.test.mjs
- [[STUB_PORT]] - code - apps/storefront/tests/e2e/ports.ts
- [[audit-dokumen.test.mjs]] - code - tests/audit-dokumen.test.mjs
- [[audit-rilis.test.mjs]] - code - tests/audit-rilis.test.mjs
- [[berita-build-smoke.test.ts]] - code - apps/storefront/tests/berita-build-smoke.test.ts
- [[build-smoke.test.ts]] - code - apps/storefront/tests/build-smoke.test.ts
- [[buildId]] - code - apps/storefront/scripts/write-build-id.mjs
- [[bun_1]] - code - package.json
- [[canSpawnBun()]] - code - apps/storefront/tests/berita-build-smoke.test.ts
- [[canSpawnBun()_1]] - code - apps/storefront/tests/build-smoke.test.ts
- [[canSpawnBun()_2]] - code - apps/storefront/tests/checkout-build-smoke.test.ts
- [[canSpawnBun()_3]] - code - apps/storefront/tests/katalog-build-smoke.test.ts
- [[checkout-build-smoke.test.ts]] - code - apps/storefront/tests/checkout-build-smoke.test.ts
- [[cleanup_4]] - code - tests/audit-dokumen.test.mjs
- [[cleanup]] - code - tests/audit-rilis.test.mjs
- [[engines]] - code - package.json
- [[gitRunInherit()]] - code - packages/gerbang/lib/git.mjs
- [[global-setup.ts]] - code - apps/storefront/tests/e2e/global-setup.ts
- [[globalSetup()]] - code - apps/storefront/tests/e2e/global-setup.ts
- [[katalog-build-smoke.test.ts]] - code - apps/storefront/tests/katalog-build-smoke.test.ts
- [[nOf()]] - code - tests/audit-rilis.test.mjs
- [[playwright.config.ts]] - code - apps/storefront/playwright.config.ts
- [[ports.ts]] - code - apps/storefront/tests/e2e/ports.ts
- [[resolveBuildId()]] - code - apps/storefront/scripts/write-build-id.mjs
- [[run()_3]] - code - tests/audit-dokumen.test.mjs
- [[run()]] - code - tests/audit-rilis.test.mjs
- [[tree()_1]] - code - tests/audit-dokumen.test.mjs
- [[tree()]] - code - tests/audit-rilis.test.mjs
- [[waitForHttp()]] - code - apps/storefront/tests/e2e/global-setup.ts
- [[waitForStub()]] - code - apps/storefront/tests/berita-build-smoke.test.ts
- [[waitForStub()_1]] - code - apps/storefront/tests/build-smoke.test.ts
- [[waitForStub()_2]] - code - apps/storefront/tests/checkout-build-smoke.test.ts
- [[waitForStub()_3]] - code - apps/storefront/tests/katalog-build-smoke.test.ts
- [[write-build-id.mjs]] - code - apps/storefront/scripts/write-build-id.mjs

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Build__E2E_Tooling
SORT file.name ASC
```

## Connections to other communities
- 2 edges to [[_COMMUNITY_Translation Mirror Audit]]
- 2 edges to [[_COMMUNITY_Changeset Parsing]]
- 1 edge to [[_COMMUNITY_Document Audit Gate]]
- 1 edge to [[_COMMUNITY_Root Package Manifest]]

## Top bridge nodes
- [[bun_1]] - degree 12, connects to 2 communities
- [[gitRunInherit()]] - degree 3, connects to 2 communities
- [[engines]] - degree 2, connects to 1 community
- [[ADR-0042]] - degree 2, connects to 1 community