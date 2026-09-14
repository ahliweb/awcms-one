# Graph Report - .  (2026-09-15)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 396 nodes · 599 edges · 25 communities (22 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `fd01916a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Storefront Catalog Rendering
- Release & Changeset Versioning
- Documentation Translation Mirroring
- Markdown Documentation Audit
- Gate Test Harness & Toolchain Pin
- Storefront Package Manifest
- Federated Graph Combine & Subtree Guard
- Root Workspace Manifest
- Root Knowledge-Graph Gate
- Obsidian Export Safety Boundary
- Changeset Backlog Gate
- Storefront Static Server Headers
- Lockfile Workspace Verification
- Subtree Write Protection Tests
- Obsidian Export Behaviour Tests
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
3. `auditLinkedCounts()` - 9 edges
4. `scripts` - 8 edges
5. `getProducts()` - 8 edges
6. `isMirrorInScope()` - 8 edges
7. `BUMP_LEVELS` - 8 edges
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
  tests/audit-dokumen.test.mjs → package.json
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json

## Import Cycles
- None detected.

## Communities (25 total, 3 thin omitted)

### Community 0 - "Storefront Catalog Rendering"
Cohesion: 0.08
Nodes (35): absoluteUrl(), siteConfig, siteUrl, canonicalUrl, metaDescription, AwcmsApiError, awcmsGet(), baseUrl() (+27 more)

### Community 1 - "Release & Changeset Versioning"
Cohesion: 0.11
Nodes (32): CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile(), parseChangeset(), validateChangeset(), gitRunOrThrow(), atLeastAsSignificant() (+24 more)

### Community 2 - "Documentation Translation Mirroring"
Cohesion: 0.14
Nodes (26): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+18 more)

### Community 3 - "Markdown Documentation Audit"
Cohesion: 0.13
Nodes (31): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+23 more)

### Community 4 - "Gate Test Harness & Toolchain Pin"
Cohesion: 0.07
Nodes (23): description, engines, bun, homepage, license, name, packageManager, private (+15 more)

### Community 5 - "Storefront Package Manifest"
Cohesion: 0.08
Nodes (25): dependencies, astro, @astrojs/node, description, devDependencies, @astrojs/check, @types/bun, typescript (+17 more)

### Community 6 - "Federated Graph Combine & Subtree Guard"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 7 - "Root Workspace Manifest"
Cohesion: 0.10
Nodes (21): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+13 more)

### Community 8 - "Root Knowledge-Graph Gate"
Cohesion: 0.16
Nodes (19): graphPath, outputDir, reporter, reportPath, subtreeTrackedOutput, trackedOutput, checkCombinedGraphUntracked(), checkCommunityLabels() (+11 more)

### Community 9 - "Obsidian Export Safety Boundary"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 10 - "Changeset Backlog Gate"
Cohesion: 0.14
Nodes (9): dated, oldest, pending, reporter, todayIso, createReporter(), formatReport(), SCRIPT_DIRS (+1 more)

### Community 11 - "Storefront Static Server Headers"
Cohesion: 0.20
Nodes (14): applyHeaders(), CACHE_ASSET, CACHE_PAGE, cacheControlFor(), createServer(), CSP, HSTS, isProductsRedirect() (+6 more)

### Community 12 - "Lockfile Workspace Verification"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 13 - "Subtree Write Protection Tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 14 - "Obsidian Export Behaviour Tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 15 - "Storefront Dev API Stub"
Cohesion: 0.33
Nodes (4): FIXTURES, PORT, ROUTES, server

### Community 16 - "Shared Config Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 17 - "Gerbang Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 18 - "Shared TypeScript Base Config"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 20 - "Storefront TypeScript Config"
Cohesion: 0.50
Nodes (3): extends, astro/tsconfigs/strict, ../../packages/config/tsconfig.base.json

### Community 21 - "Toolchain Version Pin Test"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

## Knowledge Gaps
- **182 isolated node(s):** `SITE`, `name`, `type`, `version`, `private` (+177 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Gate Test Harness & Toolchain Pin` to `Release & Changeset Versioning`, `Documentation Translation Mirroring`?**
  _High betweenness centrality (0.107) - this node is a cross-community bridge._
- **Why does `gitRun()` connect `Documentation Translation Mirroring` to `Root Knowledge-Graph Gate`, `Gate Test Harness & Toolchain Pin`?**
  _High betweenness centrality (0.092) - this node is a cross-community bridge._
- **What connects `SITE`, `name`, `type` to the rest of the system?**
  _182 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Storefront Catalog Rendering` be split into smaller, more focused modules?**
  _Cohesion score 0.08282828282828283 - nodes in this community are weakly interconnected._
- **Should `Release & Changeset Versioning` be split into smaller, more focused modules?**
  _Cohesion score 0.1126984126984127 - nodes in this community are weakly interconnected._
- **Should `Documentation Translation Mirroring` be split into smaller, more focused modules?**
  _Cohesion score 0.1411764705882353 - nodes in this community are weakly interconnected._
- **Should `Markdown Documentation Audit` be split into smaller, more focused modules?**
  _Cohesion score 0.13306451612903225 - nodes in this community are weakly interconnected._