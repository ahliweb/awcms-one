# Graph Report - .  (2026-09-17)

## Corpus Check
- 1263 files · ~0 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1263 nodes · 2560 edges · 69 communities (62 shown, 7 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 18 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Storefront Server & CSP
- Marketing Read Models
- Tenant Seed Script
- Build & E2E Tooling
- Root Package Manifest
- Knowledge Graph Audit
- Rubrik & Region Rendering
- Changeset Parsing
- Translation Mirror Audit
- Client Product Search
- Storefront Package Manifest
- Storefront Commerce Client
- Portable Text Rendering
- Document Audit Gate
- AWCMS Stub Server
- News Layout & Archive
- Checkout Region Data
- Cart Client Storage
- Wishlist Client Storage
- Ad Placements & Blog Client
- Catalog Contract Types
- Base Layout & Site Identity
- Article Card & View
- Catalog Fetch Client
- Knowledge Graph Combine
- News JSON-LD
- Sitemap Generation
- Obsidian Export Safety
- Site Chrome & Navigation
- Cart Contract & WhatsApp Fallback
- Footer & Static Pages
- News RSS Feed
- Flash Sale Countdown
- Theme Token Fetch
- Rubrik Hierarchy
- Order Session & Phone
- Mitra Institutions
- Site Config & Env
- Order Tracking Script
- Lockfile Check
- Kontrak TS Config
- Region Index Builder
- Product Detail Variant Picker
- Legacy Redirect Map
- Kontrak Package Manifest
- Knowledge Subtree Guard Test
- News Front Page
- Price Formatting
- Product Index Build
- Obsidian Export Test
- AWCMS Build Client
- Recent News Loader
- Storefront TS Config
- Import Direction Test
- Config Package Manifest
- Gerbang Package Manifest
- Storefront API Error
- Promo Popup Client
- Base TS Config
- Graph Audit Test
- Env Example Coverage Test
- Prerender Guard Test
- Toolchain Version Test
- Graph Update Script
- Astro Config
- Postgres Role Init Script

## God Nodes (most connected - your core abstractions)
1. `ROUTES` - 29 edges
2. `formatPrice()` - 27 edges
3. `scripts` - 25 edges
4. `getSiteIdentity()` - 20 edges
5. `getProducts()` - 18 edges
6. `absoluteUrl()` - 17 edges
7. `getIndex()` - 17 edges
8. `readEnv()` - 15 edges
9. `renderPortableText()` - 15 edges
10. `getStoreSettings()` - 12 edges

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

## Communities (69 total, 7 thin omitted)

### Community 0 - "Storefront Server & CSP"
Cohesion: 0.10
Nodes (35): applyHeaders(), buildCsp(), CACHE_ASSET, CACHE_PAGE, cacheControlFor(), createServer(), CSP, discoverCssPreloadPaths() (+27 more)

### Community 1 - "Marketing Read Models"
Cohesion: 0.08
Nodes (36): CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus, getActiveFlashSales() (+28 more)

### Community 2 - "Tenant Seed Script"
Cohesion: 0.09
Nodes (39): ADR-0049, apiCall(), ApiResult, applySiteProfile(), assertOk(), BASE_URL, CategorySeed, ensureBlogPages() (+31 more)

### Community 3 - "Build & E2E Tooling"
Cohesion: 0.06
Nodes (23): buildId, OUT_PATH, resolveBuildId(), canSpawnBun(), canSpawnBun(), canSpawnBun(), globalSetup(), ADR-0002 (+15 more)

### Community 4 - "Root Package Manifest"
Cohesion: 0.05
Nodes (39): description, homepage, license, name, packageManager, private, repository, type (+31 more)

### Community 5 - "Knowledge Graph Audit"
Cohesion: 0.08
Nodes (28): graphPath, outputDir, reporter, reportPath, subtreeTrackedOutput, trackedOutput, dated, oldest (+20 more)

### Community 6 - "Rubrik & Region Rendering"
Cohesion: 0.08
Nodes (32): RawTerm, getResolvableRegionsByCode(), AuthorArchive, buildIndex(), buildRubrikForest(), DaerahArchive, DaerahLink, estimasiWaktuBacaMenit() (+24 more)

### Community 7 - "Changeset Parsing"
Cohesion: 0.11
Nodes (32): CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile(), parseChangeset(), validateChangeset(), gitRunOrThrow(), atLeastAsSignificant() (+24 more)

### Community 8 - "Translation Mirror Audit"
Cohesion: 0.14
Nodes (26): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+18 more)

### Community 9 - "Client Product Search"
Cohesion: 0.11
Nodes (28): paginateProdukIndex(), ProductSort, ProdukIndexFilter, emptyState, grid, heading, paginationEl, run() (+20 more)

### Community 10 - "Storefront Package Manifest"
Cohesion: 0.06
Nodes (31): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @playwright/test (+23 more)

### Community 11 - "Storefront Commerce Client"
Cohesion: 0.09
Nodes (29): cancelOrder(), CartLineStatus, createOrder(), createPaymentProofUploadSession(), Envelope, finalizePaymentProofUpload(), getOrder(), Order (+21 more)

### Community 12 - "Portable Text Rendering"
Cohesion: 0.12
Nodes (28): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), documentHasPlayableVideo(), escapeHtml(), formatDurationSeconds() (+20 more)

### Community 13 - "Document Audit Gate"
Cohesion: 0.15
Nodes (30): actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths(), auditOneIndex() (+22 more)

### Community 14 - "AWCMS Stub Server"
Cohesion: 0.12
Nodes (27): buildPaymentInstructions(), computeQuote(), corsHeaders(), envelope(), envelopeError(), findOrderForPhone(), findProductLine(), findVoucher() (+19 more)

### Community 15 - "News Layout & Archive"
Cohesion: 0.09
Nodes (24): getArsipBulan(), getAuthor(), getIndex(), getMitraStripBulanIni(), getTag(), getTags(), listArsipBulan(), listAuthors() (+16 more)

### Community 16 - "Checkout Region Data"
Cohesion: 0.13
Nodes (21): configuredProvinceCodes(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces(), getCheckoutRegencies(), listRegions() (+13 more)

### Community 17 - "Cart Client Storage"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 18 - "Wishlist Client Storage"
Cohesion: 0.21
Nodes (22): loadWishlist(), removeFromWishlist(), saveWishlist(), toggleWishlist(), addWishlistItem(), createEmptyWishlist(), isIsoDateString(), isWishlisted() (+14 more)

### Community 19 - "Ad Placements & Blog Client"
Cohesion: 0.14
Nodes (20): disclosureLabel, AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements() (+12 more)

### Community 20 - "Catalog Contract Types"
Cohesion: 0.12
Nodes (15): buildPriceTiers(), collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, CommerceProductVariant, getCategoryBySlug(), primaryProductImage(), productsInCategory() (+7 more)

### Community 21 - "Base Layout & Site Identity"
Cohesion: 0.12
Nodes (17): DEFAULT_IDENTITY, canonicalUrl, metaDescription, ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), getSiteIdentity(), isExpectedRefusal() (+9 more)

### Community 22 - "Article Card & View"
Cohesion: 0.22
Nodes (13): absoluteShareUrl, bodyHtml, breadcrumbItems, encodedTitle, readingMinutes, wasUpdated, PostDetail, formatBulanArsipWIB() (+5 more)

### Community 23 - "Catalog Fetch Client"
Cohesion: 0.11
Nodes (22): assertNeverProductStatus(), CategoryNode, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, filterProdukIndex(), isPubliclyVisible(), listAllCategories() (+14 more)

### Community 24 - "Knowledge Graph Combine"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 25 - "News JSON-LD"
Cohesion: 0.15
Nodes (17): getRelatedPosts(), getVideo(), BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema(), NewsArticleSchemaInput, ADR-0109 (+9 more)

### Community 26 - "Sitemap Generation"
Cohesion: 0.20
Nodes (17): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), registerSitemapSource(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests() (+9 more)

### Community 27 - "Obsidian Export Safety"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 28 - "Site Chrome & Navigation"
Cohesion: 0.18
Nodes (9): FOOTER_PAGE_LINKS, PRIMARY_NAV, ROUTES, STATIC_PAGE_SLUGS, KATALOG_SITEMAP_SOURCE_NAMES, SitemapEntry, SITEMAP_SOURCE_NAMES, PAGES_ROOT (+1 more)

### Community 29 - "Cart Contract & WhatsApp Fallback"
Cohesion: 0.16
Nodes (18): Cart, CartLineRequest, CartQuote, QuoteLine, buildWhatsappCartMessage(), buildWhatsappUrl(), lineText(), ADR-0003 (+10 more)

### Community 30 - "Footer & Static Pages"
Cohesion: 0.15
Nodes (15): footerLinks, publishedSlugs, year, detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal() (+7 more)

### Community 31 - "News RSS Feed"
Cohesion: 0.21
Nodes (12): absoluteUrl(), BeritaFeedItem, escapeCdata(), escapeXml(), getPost(), renderBeritaRssXml(), GET(), prerender (+4 more)

### Community 32 - "Flash Sale Countdown"
Cohesion: 0.19
Nodes (8): getProduct(), getProducts(), labelClassName(), GET(), prerender, getStaticPaths(), formatRemaining(), tick()

### Community 33 - "Theme Token Fetch"
Cohesion: 0.16
Nodes (16): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, contrastingForeground() (+8 more)

### Community 34 - "Rubrik Hierarchy"
Cohesion: 0.17
Nodes (17): collectAncestors(), collectDescendantSlugs(), flattenRubrikTree(), getRubrik(), getRubrikTree(), paginate(), toPublicRubrikNode(), getStaticPaths() (+9 more)

### Community 35 - "Order Session & Phone"
Cohesion: 0.20
Nodes (11): PESANAN_PHONE_KEY, keepDigitsAndLeadingPlus(), previewIndonesianPhone(), CreateOrderRequest, ShippingSelection, root, runCheckout(), Step (+3 more)

### Community 36 - "Mitra Institutions"
Cohesion: 0.21
Nodes (11): RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), resolveRegion(), getMitra() (+3 more)

### Community 37 - "Site Config & Env"
Cohesion: 0.21
Nodes (8): siteConfig, siteUrl, EnvSource, readEnvOr(), escapeXml(), GET(), prerender, prerender

### Community 38 - "Order Tracking Script"
Cohesion: 0.28
Nodes (11): formatPrice(), loadOrder(), renderCountdown(), renderLines(), renderOrder(), renderPaymentInstructions(), renderSummary(), renderTimeline() (+3 more)

### Community 39 - "Lockfile Check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 40 - "Kontrak TS Config"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 41 - "Region Index Builder"
Cohesion: 0.30
Nodes (10): buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf(), listLintasKalimantanProvinces(), listRegions(), matchesProvinceName(), regenciesCache (+2 more)

### Community 42 - "Product Detail Variant Picker"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 43 - "Legacy Redirect Map"
Cohesion: 0.31
Nodes (8): getLegacyRedirectRows(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET(), prerender

### Community 44 - "Kontrak Package Manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 45 - "Knowledge Subtree Guard Test"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 46 - "News Front Page"
Cohesion: 0.32
Nodes (6): getPosts(), getTerpopuler(), getStaticPaths(), BeritaIndexEntry, GET(), prerender

### Community 47 - "Price Formatting"
Cohesion: 0.24
Nodes (7): formatDiscountPercent(), PRICE_FORMATTER, ADR-0003, HARGA_FILE, SCANNABLE_EXTENSIONS, SRC_ROOT, walk()

### Community 48 - "Product Index Build"
Cohesion: 0.24
Nodes (8): buildCategoryTree(), buildProdukIndex(), getCategories(), PRODUK_PAGE_SIZE, GET(), prerender, categoryTree, firstPage

### Community 50 - "Obsidian Export Test"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 51 - "AWCMS Build Client"
Cohesion: 0.43
Nodes (6): AwcmsApiError, awcmsGet(), baseUrl(), Envelope, timeoutMs(), readEnv()

### Community 52 - "Recent News Loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 53 - "Storefront TS Config"
Cohesion: 0.29
Nodes (6): compilerOptions, types, extends, astro/tsconfigs/strict, bun, ../../packages/config/tsconfig.base.json

### Community 54 - "Import Direction Test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 55 - "Config Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 56 - "Gerbang Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 58 - "Promo Popup Client"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 59 - "Base TS Config"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 64 - "Toolchain Version Test"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

## Knowledge Gaps
- **435 isolated node(s):** `SITE`, `Envelope`, `EnvSource`, `prerender`, `name` (+430 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `awcmsGet()` connect `AWCMS Build Client` to `Marketing Read Models`, `Region Index Builder`, `Checkout Region Data`, `Ad Placements & Blog Client`, `Base Layout & Site Identity`, `Catalog Fetch Client`, `Footer & Static Pages`?**
  _High betweenness centrality (0.033) - this node is a cross-community bridge._
- **Why does `formatPrice()` connect `Order Tracking Script` to `Flash Sale Countdown`, `Marketing Read Models`, `Order Session & Phone`, `Site Config & Env`, `Client Product Search`, `Product Detail Variant Picker`, `Price Formatting`, `Wishlist Client Storage`, `Catalog Fetch Client`, `Cart Contract & WhatsApp Fallback`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site Chrome & Navigation` to `Flash Sale Countdown`, `Marketing Read Models`, `Rubrik Hierarchy`, `Mitra Institutions`, `Rubrik & Region Rendering`, `Legacy Redirect Map`, `News Front Page`, `News Layout & Archive`, `Ad Placements & Blog Client`, `Catalog Contract Types`, `Article Card & View`, `News JSON-LD`, `Footer & Static Pages`, `News RSS Feed`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **What connects `SITE`, `Envelope`, `EnvSource` to the rest of the system?**
  _435 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Storefront Server & CSP` be split into smaller, more focused modules?**
  _Cohesion score 0.09797979797979799 - nodes in this community are weakly interconnected._
- **Should `Marketing Read Models` be split into smaller, more focused modules?**
  _Cohesion score 0.08484848484848485 - nodes in this community are weakly interconnected._
- **Should `Tenant Seed Script` be split into smaller, more focused modules?**
  _Cohesion score 0.09175377468060394 - nodes in this community are weakly interconnected._