# Graph Report - .  (2026-09-15)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 433 nodes · 645 edges · 29 communities (26 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ae231010`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Storefront Catalog Rendering
- Root Workspace Manifest
- Documentation Translation Mirroring
- Release & Changeset Versioning
- Markdown Documentation Audit
- Storefront Package Manifest
- Federated Graph Combine & Subtree Guard
- Root Knowledge-Graph Gate
- Obsidian Export Safety Boundary
- Changeset Backlog Gate
- Storefront Static Server Headers
- Gate Test Harness & Toolchain Pin
- Lockfile Workspace Verification
- Contract Package TypeScript Config
- Storefront CMS Client & Env
- Contract Package Manifest
- Subtree Write Protection Tests
- Obsidian Export Behaviour Tests
- Import Direction Gate Test
- Storefront Dev API Stub
- Shared Config Package Manifest
- Gerbang Package Manifest
- Shared TypeScript Base Config
- Knowledge-Graph Gate Tests
- Storefront TypeScript Config
- Toolchain Version Pin Test
- Root Graph Update Wrapper
- Storefront Astro Site Config

## God Nodes (most connected - your core abstractions)
1. `scripts` - 21 edges
2. `join()` - 11 edges
3. `getProducts()` - 9 edges
4. `auditLinkedCounts()` - 9 edges
5. `isMirrorInScope()` - 8 edges
6. `BUMP_LEVELS` - 8 edges
7. `scripts` - 8 edges
8. `runChecks()` - 7 edges
9. `validateChangeset()` - 7 edges
10. `gitRun()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `listMirrors()` --indirect_call--> `isMirrorInScope()`  [INFERRED]
  tools/docs-i18n-stamp.mjs → packages/gerbang/lib/docs-i18n-checks.mjs
- `gitRun()` --references--> `bun`  [EXTRACTED]
  packages/gerbang/lib/git.mjs → package.json
- `gitRunOrThrow()` --references--> `bun`  [EXTRACTED]
  packages/gerbang/lib/git.mjs → package.json
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json

## Import Cycles
- None detected.

## Communities (29 total, 3 thin omitted)

### Community 0 - "Storefront Catalog Rendering"
Cohesion: 0.10
Nodes (28): absoluteUrl(), siteConfig, siteUrl, canonicalUrl, metaDescription, assertNeverProductStatus(), CommerceCategory, CommercePage (+20 more)

### Community 1 - "Root Workspace Manifest"
Cohesion: 0.06
Nodes (35): description, homepage, license, name, packageManager, private, repository, type (+27 more)

### Community 2 - "Documentation Translation Mirroring"
Cohesion: 0.14
Nodes (26): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+18 more)

### Community 3 - "Release & Changeset Versioning"
Cohesion: 0.11
Nodes (31): CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), parseChangeset(), validateChangeset(), gitRunOrThrow(), atLeastAsSignificant(), BUMP_LEVELS (+23 more)

### Community 4 - "Markdown Documentation Audit"
Cohesion: 0.14
Nodes (31): actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths(), auditOneIndex() (+23 more)

### Community 5 - "Storefront Package Manifest"
Cohesion: 0.07
Nodes (27): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @types/bun (+19 more)

### Community 6 - "Federated Graph Combine & Subtree Guard"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 7 - "Root Knowledge-Graph Gate"
Cohesion: 0.16
Nodes (19): graphPath, outputDir, reporter, reportPath, subtreeTrackedOutput, trackedOutput, checkCombinedGraphUntracked(), checkCommunityLabels() (+11 more)

### Community 8 - "Obsidian Export Safety Boundary"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 9 - "Changeset Backlog Gate"
Cohesion: 0.13
Nodes (10): dated, oldest, pending, reporter, todayIso, isChangesetFile(), createReporter(), formatReport() (+2 more)

### Community 10 - "Storefront Static Server Headers"
Cohesion: 0.20
Nodes (14): applyHeaders(), CACHE_ASSET, CACHE_PAGE, cacheControlFor(), createServer(), CSP, HSTS, isProductsRedirect() (+6 more)

### Community 11 - "Gate Test Harness & Toolchain Pin"
Cohesion: 0.13
Nodes (10): engines, bun, gitRunInherit(), cleanup, ADR-0042, run(), SCRIPT, cleanup (+2 more)

### Community 12 - "Lockfile Workspace Verification"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 13 - "Contract Package TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 14 - "Storefront CMS Client & Env"
Cohesion: 0.31
Nodes (8): AwcmsApiError, awcmsGet(), baseUrl(), Envelope, timeoutMs(), EnvSource, readEnv(), readEnvOr()

### Community 15 - "Contract Package Manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 16 - "Subtree Write Protection Tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 17 - "Obsidian Export Behaviour Tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 18 - "Import Direction Gate Test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 19 - "Storefront Dev API Stub"
Cohesion: 0.33
Nodes (4): FIXTURES, PORT, ROUTES, server

### Community 20 - "Shared Config Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 21 - "Gerbang Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 22 - "Shared TypeScript Base Config"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 24 - "Storefront TypeScript Config"
Cohesion: 0.50
Nodes (3): extends, astro/tsconfigs/strict, ../../packages/config/tsconfig.base.json

### Community 25 - "Toolchain Version Pin Test"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

## Knowledge Gaps
- **194 isolated node(s):** `SITE`, `CACHE_ASSET`, `CACHE_PAGE`, `CSP`, `PERMISSIONS_POLICY` (+189 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `bun` to `docs-i18n-stamp.mjs`, `rilis.mjs`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **Why does `gitRun()` connect `docs-i18n-stamp.mjs` to `bun`, `audit-graf.mjs`?**
  _High betweenness centrality (0.078) - this node is a cross-community bridge._
- **Why does `engines` connect `bun` to `scripts`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `isMirrorInScope()` (e.g. with `listMirrors()` and `listMirrors()`) actually correct?**
  _`isMirrorInScope()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `SITE`, `CACHE_ASSET`, `CACHE_PAGE` to the rest of the system?**
  _194 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `catalog.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1036036036036036 - nodes in this community are weakly interconnected._
- **Should `scripts` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._