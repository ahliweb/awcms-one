# Graph Report - .  (2026-09-18)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1716 nodes · 3564 edges · 99 communities (83 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 30 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `066b2511`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- seed-borneojek-mart.ts
- BeritaLayout.astro
- audit-graf.mjs
- berita.ts
- rilis.mjs
- scripts
- bagikan.test.ts
- buletin.ts
- Sidebar.astro
- audit-dokumen.mjs
- portable-text.ts
- wilayah-checkout.ts
- navigasi-berita.ts
- penyaji.mjs
- produk-listing.ts
- stub-awcms.mjs
- scripts
- catalog.ts
- toko-klien.ts
- pemasaran.ts
- pengalihan-aturan.mjs
- routes.ts
- wishlist-kontrak.ts
- sitemap-sources.ts
- import-seputarborneo.ts
- blog.ts
- product/[slug].astro
- kategori/[slug].astro
- knowledge-graph-combine.mjs
- keranjang-kontrak.ts
- keranjang.ts
- site.ts
- knowledge-obsidian-export.mjs
- [n].astro
- iklan-popup.ts
- redirect-push.ts
- dengar.ts
- lembaga.ts
- import-seputarborneo.test.mjs
- awcms/analitik.ts
- checkout.ts
- requireAwcmsOrigin
- scripts/pesanan.ts
- mysql-dump-reader.ts
- profil.ts
- theme.ts
- pages.ts
- csp.json.ts
- cek-lockfile.mjs
- compilerOptions
- katalog-csp-media.test.ts
- getVideo
- wilayah.ts
- produk-detail.ts
- getProducts
- bun
- kontrak/package.json
- knowledge-no-subtree-write.test.mjs
- pages/index.astro
- warna.ts
- global-setup.ts
- readEnv
- runExport
- knowledge-obsidian-export.test.mjs
- BaseLayout.astro
- meta-sosial-build-smoke.test.ts
- extends
- kontrak-arah-impor.test.mjs
- ga-init.ts
- sidebar-build-smoke.test.ts
- audit-dokumen.test.mjs
- config/package.json
- gerbang/package.json
- audit-rilis.test.mjs
- ga.ts
- TokoApiError
- promo-popup.ts
- bagikan-build-smoke.test.ts
- dengar-build-smoke.test.ts
- logo-instansi-build-smoke.test.ts
- compilerOptions
- audit-graf.test.mjs
- root-env-example-coverage.test.mjs
- write-build-id.mjs
- checkout-guard-no-prerender.test.ts
- versi-toolchain.test.mjs
- knowledge-graph-update.mjs
- berita-build-smoke.test.ts
- build-smoke.test.ts
- buletin-build-smoke.test.ts
- checkout-build-smoke.test.ts
- penyaji-bayangan-build-smoke.test.ts
- astro.config.mjs
- newsletter-path-contract.test.ts
- 01-create-least-privilege-roles.sh

## God Nodes (most connected - your core abstractions)
1. `ROUTES` - 36 edges
2. `formatPrice()` - 27 edges
3. `scripts` - 26 edges
4. `bun` - 24 edges
5. `getSiteIdentity()` - 21 edges
6. `absoluteUrl()` - 19 edges
7. `readEnv()` - 18 edges
8. `getProducts()` - 18 edges
9. `assertOk()` - 18 edges
10. `main()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json
- `resolveBuildId()` --references--> `bun`  [EXTRACTED]
  apps/storefront/scripts/write-build-id.mjs → package.json
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/build-smoke.test.ts → package.json
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/checkout-build-smoke.test.ts → package.json
- `auditLinkedCounts()` --indirect_call--> `item()`  [INFERRED]
  packages/gerbang/audit-dokumen.mjs → apps/storefront/tests/wishlist-kontrak.test.ts

## Import Cycles
- None detected.

## Communities (99 total, 16 thin omitted)

### Community 0 - "Tenant Seed Script"
Cohesion: 0.06
Nodes (65): ADR-0049, AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL (+57 more)

### Community 1 - "Media Resolution, Social Meta & News JSON-LD"
Cohesion: 0.06
Nodes (51): chunk(), fetchMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests(), resolvedCache (+43 more)

### Community 2 - "Graph Audit & Docs i18n Stamping"
Cohesion: 0.08
Nodes (45): graphPath, outputDir, reporter, reportPath, subtreeTrackedOutput, trackedOutput, DOCS_AWAITING_MIRROR, gitList() (+37 more)

### Community 3 - "News Index & Region Archives"
Cohesion: 0.07
Nodes (38): RawTerm, AuthorArchive, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive, DaerahLink (+30 more)

### Community 4 - "Release & Changeset Parsing"
Cohesion: 0.08
Nodes (37): dated, oldest, pending, reporter, todayIso, CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody() (+29 more)

### Community 5 - "Root Package Manifest"
Cohesion: 0.05
Nodes (41): description, engines, homepage, license, name, packageManager, private, repository (+33 more)

### Community 6 - "Article Share Row"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 7 - "Newsletter Form & Token Pages"
Cohesion: 0.08
Nodes (21): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+13 more)

### Community 8 - "WIB Dates & News Sidebar"
Cohesion: 0.11
Nodes (27): toDatetimeAttr(), getArsipBulan(), getIndex(), getMitraStripBulanIni(), getPosts(), getTag(), getTags(), listArsipBulan() (+19 more)

### Community 9 - "Document Audit Gate & Script Standards"
Cohesion: 0.11
Nodes (34): actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths(), auditOneIndex() (+26 more)

### Community 10 - "Portable Text Renderer"
Cohesion: 0.11
Nodes (34): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), collectGalleryMediaObjectIds(), documentHasPlayableVideo(), escapeHtml() (+26 more)

### Community 11 - "Checkout Region Indexes"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 12 - "News Navigation & Footer Directory"
Cohesion: 0.10
Nodes (27): socialIcons, rubrikColumn, year, daerahActive, getResolvableRegionsByCode(), RegionRef, RubrikNode, branchOrder() (+19 more)

### Community 13 - "Storefront Server & Shadowed-Page Rewrite"
Cohesion: 0.14
Nodes (29): applyHeaders(), CACHE_ASSET, CACHE_PAGE, cacheControlFor(), createServer(), discoverCssPreloadPaths(), discoverShadowedHtmlPaths(), EMPTY_SET (+21 more)

### Community 14 - "Product Listing Scripts"
Cohesion: 0.11
Nodes (28): paginateProdukIndex(), ProductSort, ProdukIndexFilter, emptyState, grid, heading, paginationEl, run() (+20 more)

### Community 15 - "Stub CMS"
Cohesion: 0.12
Nodes (30): ANALYTICS_RANGES, analyticsPages(), buildPaymentInstructions(), computeQuote(), corsHeaders(), envelope(), envelopeError(), findOrderForPhone() (+22 more)

### Community 16 - "Storefront Package Manifest"
Cohesion: 0.06
Nodes (31): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @playwright/test (+23 more)

### Community 17 - "Catalog Read Models & Product Index"
Cohesion: 0.09
Nodes (27): assertNeverProductStatus(), buildCategoryTree(), buildProdukIndex(), CategoryNode, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, getCategories() (+19 more)

### Community 18 - "Anonymous Commerce Client"
Cohesion: 0.09
Nodes (27): cancelOrder(), CartLineStatus, CreateOrderRequest, createPaymentProofUploadSession(), Envelope, finalizePaymentProofUpload(), OrderAddressInput, OrderCustomerInput (+19 more)

### Community 19 - "Marketing Read Models"
Cohesion: 0.08
Nodes (25): CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus, isGoogleMapsEmbedUrl() (+17 more)

### Community 20 - "Legacy Redirect Rules"
Cohesion: 0.14
Nodes (25): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+17 more)

### Community 21 - "Route Table, Store Header & Footer"
Cohesion: 0.11
Nodes (15): footerLinks, publishedSlugs, year, FOOTER_PAGE_LINKS, PRIMARY_NAV, ROUTES, STATIC_PAGE_SLUGS, StaticPageSummary (+7 more)

### Community 22 - "Wishlist Contract"
Cohesion: 0.20
Nodes (21): loadWishlist(), removeFromWishlist(), saveWishlist(), toggleWishlist(), addWishlistItem(), createEmptyWishlist(), isIsoDateString(), isWishlisted() (+13 more)

### Community 23 - "Sitemap Sources"
Cohesion: 0.17
Nodes (20): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), KATALOG_SITEMAP_SOURCE_NAMES, registerSitemapSource(), renderSitemapIndexXml(), renderUrlsetXml() (+12 more)

### Community 24 - "Legacy Export: Taxonomy"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 25 - "Blog Fetches & Ad Slots"
Cohesion: 0.14
Nodes (18): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+10 more)

### Community 26 - "Product Detail Page & Prices"
Cohesion: 0.14
Nodes (15): buildPriceTiers(), filterProdukIndex(), normalizeSearchTerm(), comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber() (+7 more)

### Community 27 - "Category Pages & Product JSON-LD"
Cohesion: 0.14
Nodes (13): collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, CommerceProductVariant, getCategoryBySlug(), productsInCategory(), ProdukIndexEntry, BreadcrumbItem (+5 more)

### Community 28 - "Knowledge Graph Combine"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 29 - "Cart Contract & Count Badge"
Cohesion: 0.23
Nodes (15): addOrMergeLine(), Cart, CartLine, countCartItems(), createEmptyCart(), isIsoDateString(), isSameConfiguration(), KERANJANG_EVENT_NAME (+7 more)

### Community 30 - "Cart Runtime & WhatsApp Fallback"
Cohesion: 0.17
Nodes (20): addToCart(), loadCart(), removeCartLine(), saveCart(), updateCartLineQuantity(), quoteCart(), buildWhatsappCartMessage(), buildWhatsappUrl() (+12 more)

### Community 31 - "Site URL & News Feed Tests"
Cohesion: 0.16
Nodes (14): absoluteUrl(), siteConfig, siteUrl, BeritaFeedItem, escapeXml(), getPost(), renderBeritaRssXml(), GET() (+6 more)

### Community 32 - "Obsidian Export Safety"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 33 - "Rubrik Archive Pages & News Front"
Cohesion: 0.16
Nodes (17): flattenRubrikTree(), getRubrikTree(), paginate(), getNavUtama(), getUmumList(), getStaticPaths(), canonicalPath, getStaticPaths() (+9 more)

### Community 34 - "Ad Popup Dialog"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 35 - "Legacy Export: Redirect Push & API Client"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 36 - "Read-Aloud Player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 37 - "Institutions (Mitra) & Region Lookup"
Cohesion: 0.17
Nodes (13): getAllInstitutions(), RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), resolveRegion() (+5 more)

### Community 38 - "Legacy Export Tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 39 - "Terpopuler Analytics Reader"
Cohesion: 0.20
Nodes (11): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+3 more)

### Community 40 - "Checkout Script & Phone Helpers"
Cohesion: 0.18
Nodes (14): clearCart(), newCartId(), keepDigitsAndLeadingPlus(), previewIndonesianPhone(), CartLineRequest, CartQuote, createOrder(), ShippingSelection (+6 more)

### Community 41 - "Public CMS Origin & Analytics Beacon"
Cohesion: 0.21
Nodes (10): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+2 more)

### Community 42 - "Order Tracking Script"
Cohesion: 0.20
Nodes (13): PESANAN_PHONE_KEY, getOrder(), Order, loadOrder(), renderCountdown(), renderLines(), renderOrder(), renderPaymentInstructions() (+5 more)

### Community 43 - "MariaDB Dump Reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 44 - "Site Profile"
Cohesion: 0.20
Nodes (12): DEFAULT_IDENTITY, ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), isExpectedRefusal(), mergeSiteIdentity(), parseSocialLinks(), SiteIdentity (+4 more)

### Community 45 - "Theme Tokens & Web Manifest"
Cohesion: 0.20
Nodes (11): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, GET() (+3 more)

### Community 46 - "CMS Static Pages"
Cohesion: 0.22
Nodes (11): detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), listStaticPages(), StaticPageDetail, ADR-0100 (+3 more)

### Community 47 - "Derived CSP Artifact"
Cohesion: 0.32
Nodes (12): getMediaPublicOrigin(), getActiveFlashSales(), getActivePopup(), getActiveSliders(), getActiveTestimonials(), getPublicVouchers(), isMissingEndpoint(), warnMissing() (+4 more)

### Community 48 - "Lockfile Check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 49 - "Kontrak TSConfig"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 50 - "CSP Media Origins & Header Builder"
Cohesion: 0.24
Nodes (9): buildCsp(), CSP, readCspOrigins(), sanitizeOrigins(), buildCspOriginsArtifact(), collectOrigins(), CspOriginsArtifact, originOf() (+1 more)

### Community 51 - "Legacy Redirect Map Builder"
Cohesion: 0.29
Nodes (9): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), GET(), prerender (+1 more)

### Community 52 - "Region Lookup Client"
Cohesion: 0.30
Nodes (10): buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf(), listLintasKalimantanProvinces(), listRegions(), matchesProvinceName(), regenciesCache (+2 more)

### Community 53 - "Product Detail Script"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 54 - "Product Feed & Label CSS"
Cohesion: 0.25
Nodes (9): getProduct(), getProducts(), labelClassName(), escapeXml(), GET(), prerender, GET(), prerender (+1 more)

### Community 55 - "Build-Smoke Harness"
Cohesion: 0.20
Nodes (5): canSpawnBun(), runBuild(), canSpawnBun(), bun, gitRunInherit()

### Community 56 - "Kontrak Package Manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 57 - "Knowledge No-Subtree-Write Test"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 58 - "Store Home & Recent News"
Cohesion: 0.24
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 59 - "Colour Contrast"
Cohesion: 0.40
Nodes (7): contrastingForeground(), contrastRatio(), isValidHexColor(), relativeLuminance(), WCAG_AA_TEXT_CONTRAST, GET(), prerender

### Community 61 - "Playwright Setup"
Cohesion: 0.33
Nodes (6): globalSetup(), ADR-0002, ADR-0007, waitForHttp(), PREVIEW_PORT, STUB_PORT

### Community 62 - "Owner API Client & Env"
Cohesion: 0.42
Nodes (7): awcmsGet(), baseUrl(), Envelope, timeoutMs(), EnvSource, readEnv(), readEnvOr()

### Community 63 - "Legacy Export Runner"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 64 - "Obsidian Export Test"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 66 - "Social Meta Build Smoke"
Cohesion: 0.38
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 67 - "Storefront TSConfig"
Cohesion: 0.29
Nodes (6): compilerOptions, types, extends, astro/tsconfigs/strict, bun, ../../packages/config/tsconfig.base.json

### Community 68 - "Kontrak Import-Direction Test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 69 - "GA4 Bootstrap"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 71 - "Document Audit Test"
Cohesion: 0.33
Nodes (4): ADR-0042, cleanup, run(), SCRIPT

### Community 72 - "Config Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 73 - "Gerbang Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 74 - "Release Audit Test"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 77 - "Promo Popup"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 78 - "Share Row Build Smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 79 - "Read-Aloud Build Smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 80 - "Institution Emblem Build Smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 81 - "Base TSConfig"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 84 - "Build Id Stamp"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 87 - "Toolchain Version Test"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

## Knowledge Gaps
- **532 isolated node(s):** `SITE`, `Envelope`, `EnvSource`, `prerender`, `name` (+527 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `item()` connect `BeritaLayout.astro` to `audit-dokumen.mjs`, `pages/index.astro`, `wishlist-kontrak.ts`?**
  _High betweenness centrality (0.307) - this node is a cross-community bridge._
- **Why does `auditLinkedCounts()` connect `audit-dokumen.mjs` to `BeritaLayout.astro`?**
  _High betweenness centrality (0.302) - this node is a cross-community bridge._
- **Why does `bun` connect `bun` to `audit-graf.mjs`, `rilis.mjs`, `scripts`, `mysql-dump-reader.ts`, `global-setup.ts`, `runExport`, `meta-sosial-build-smoke.test.ts`, `sidebar-build-smoke.test.ts`, `audit-dokumen.test.mjs`, `audit-rilis.test.mjs`, `bagikan-build-smoke.test.ts`, `dengar-build-smoke.test.ts`, `logo-instansi-build-smoke.test.ts`, `write-build-id.mjs`, `berita-build-smoke.test.ts`, `build-smoke.test.ts`, `buletin-build-smoke.test.ts`, `checkout-build-smoke.test.ts`, `penyaji-bayangan-build-smoke.test.ts`?**
  _High betweenness centrality (0.222) - this node is a cross-community bridge._
- **What connects `SITE`, `Envelope`, `EnvSource` to the rest of the system?**
  _532 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `seed-borneojek-mart.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06277436347673397 - nodes in this community are weakly interconnected._
- **Should `BeritaLayout.astro` be split into smaller, more focused modules?**
  _Cohesion score 0.05721153846153846 - nodes in this community are weakly interconnected._
- **Should `audit-graf.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.07792207792207792 - nodes in this community are weakly interconnected._