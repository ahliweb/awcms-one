# Graph Report - .  (2026-09-26)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 2534 nodes · 5717 edges · 118 communities (102 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 41 edges (avg confidence: 0.6)
- Token cost: 82,905 input · 1,706 output

## Graph Freshness
- Built from commit: `8686dc83`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- CMS Seed Scripts
- News Article UI Components
- Legacy URL Redirect Rules
- Template Init Tests
- Graph & Release Audit Scripts
- Release Image Signing
- Docs Translation Checks
- Site Config & RSS Feed
- News Nav, Footer & Regions
- Marketing Promos & Flash Sales
- Site Profile Configuration
- Origin Config & Analytics Beacon
- AWCMS API Stub Server
- Site Identity & Layout Shell
- Customer Account API Client
- Changelog & Changeset Tooling
- Package Scripts Manifest
- Share & Follow Links
- Static Pages & Sitemap
- Cart Client Storage
- WhatsApp Fallback Messaging
- Institutions & Media Origin
- Documentation Audit Script
- Checkout Region Lookup
- Portable Text Rendering
- Order Creation Client
- Storefront Package Manifest
- Profile Dist Assertions
- Profile Seed Assets
- News Homepage Navigation
- Wishlist Client Storage
- Social Meta & Newsletter
- Legacy Content Importer
- Local CI Entry & Fork Policy
- Site Theme Colors
- Checkout Address & Shipping
- CI Leg Runner Utilities
- Product Catalog Data
- AWCMS API & Redirect Push
- Blog Data Fetching & Ads
- Account Session Contract
- Build Smoke Tests
- Storefront Request Envelope
- Obsidian Export Safety
- CI Watch, Hash & Lock
- Product Schema & JSON-LD
- Ad Popup Dialog
- Local CI Leg Definitions
- Astro Route Injection
- Product Page Endpoints
- Account Order Rendering
- Product Search Listing
- CodeQL Baseline Scanning
- Article Text-to-Speech Player
- Affiliate Code Capture
- Legacy Redirect Map
- Legacy Import Tests
- Price Formatting & Flash Sale
- Popular Pages Analytics
- Product Listing Filters
- Lockfile & Dependabot Checks
- Affiliate Commission Page
- Account Address Management
- MySQL Dump Reader
- E2E Accessibility & Screenshots
- Legacy Export CLI Commands
- Playwright Test Harness
- Wishlist Account Sync
- API Client & Env Helpers
- Production Deploy Tests
- Build ID & Bundle Smoke Tests
- Product Variant Detail
- Root Package Metadata
- Contract TypeScript Config
- Deploy Shell Helpers
- Secret Redaction
- Storefront TypeScript Config
- Contract Package Manifest
- Subtree Write Guard Test
- Obsidian Export Test
- Checkout Prerender Guard
- Production Compose Audit
- Footer Links & Search Surface
- Graph Audit Test
- Contract Import Direction Test
- Bun Version Pin Check
- Google Analytics Init
- Social Meta Smoke Test
- Status Prose Translation Test
- Config Package Manifest
- Gateway Package Manifest
- Release Audit Test
- Promo Popup Display
- Sidebar Smoke Test
- Base TypeScript Config
- Env Example Coverage Test
- Screenshot Readme Generator
- Share Button Smoke Test
- Listen Player Smoke Test
- Institution Logo Smoke Test
- Toolchain Version Checks
- Knowledge Graph Update Script
- Account Dashboard Build Smoke Test
- Gateway Build Smoke Test
- Global CSS Font Checks
- Newsletter Path Contract Test
- Messaging Page Build Smoke Test
- Offsite Backup Copy Script
- Monorepo Workspace Layout
- Least-Privilege Role Provisioning
- Compose Backup Runner
- Compose Job Runner
- Production Deploy Script
- Remote Deploy Script
- Production Healthcheck Script
- Production Rollback Script

## God Nodes (most connected - your core abstractions)
1. `ROUTES` - 57 edges
2. `bun` - 57 edges
3. `scripts` - 42 edges
4. `getSiteIdentity()` - 31 edges
5. `kirimPermintaan()` - 31 edges
6. `formatPrice()` - 27 edges
7. `main()` - 27 edges
8. `bacaSesi()` - 26 edges
9. `startStub()` - 23 edges
10. `buildWhatsappUrl()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json
- `startStub()` --indirect_call--> `chunk()`  [INFERRED]
  tools/ci/runners/template.ts → apps/storefront/src/lib/awcms/media.ts
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json
- `runTemplateInitTests()` --indirect_call--> `profil()`  [INFERRED]
  tests/template-init.test.mjs → apps/storefront/integrations/profil.mjs
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/akun-build-smoke.test.ts → package.json

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (118 total, 16 thin omitted)

### Community 0 - "CMS Seed Scripts"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 1 - "News Article UI Components"
Cohesion: 0.05
Nodes (60): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+52 more)

### Community 2 - "Legacy URL Redirect Rules"
Cohesion: 0.06
Nodes (64): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+56 more)

### Community 3 - "Template Init Tests"
Cohesion: 0.06
Nodes (53): canSpawnBun(), NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), ADR-0018, applyPlan(), applyColorDefaults(), BOOLEAN_FLAGS, FLAG_KEYS (+45 more)

### Community 4 - "Graph & Release Audit Scripts"
Cohesion: 0.05
Nodes (51): ADR-0002, graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath (+43 more)

### Community 5 - "Release Image Signing"
Cohesion: 0.10
Nodes (51): ADR-0020, ADR-0023, gitRun(), gitRunInherit(), cosignSign(), cosignVerify(), ensureBuilder(), fail() (+43 more)

### Community 6 - "Docs Translation Checks"
Cohesion: 0.07
Nodes (44): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+36 more)

### Community 7 - "Site Config & RSS Feed"
Cohesion: 0.06
Nodes (43): absoluteUrl(), siteConfig, siteUrl, BeritaFeedItem, escapeCdata(), escapeXml(), getPost(), getPosts() (+35 more)

### Community 8 - "News Nav, Footer & Regions"
Cohesion: 0.07
Nodes (43): rubrikColumn, year, daerahActive, getAllInstitutions(), buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf() (+35 more)

### Community 9 - "Marketing Promos & Flash Sales"
Cohesion: 0.06
Nodes (42): CSP_NEEDS, CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus (+34 more)

### Community 10 - "Site Profile Configuration"
Cohesion: 0.07
Nodes (41): activeRouteKeys(), CspNeeds, cspNeedsFor(), DEFAULT_SITE_PROFILE, describeProfile(), excludedRouteKeys(), FeedEntry, FEEDS (+33 more)

### Community 11 - "Origin Config & Analytics Beacon"
Cohesion: 0.06
Nodes (31): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+23 more)

### Community 12 - "AWCMS API Stub Server"
Cohesion: 0.09
Nodes (45): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), buildAffiliateLink(), buildPaymentInstructions(), computeQuote(), corsHeaders(), deterministicAffiliateCode() (+37 more)

### Community 13 - "Site Identity & Layout Shell"
Cohesion: 0.10
Nodes (24): socialIcons, tokoAktif, ROUTES, DEFAULT_IDENTITY, getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity() (+16 more)

### Community 14 - "Customer Account API Client"
Cohesion: 0.12
Nodes (42): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilKomisiAfiliasi(), ambilPesananAkun(), ambilPesananAkunByKode(), ambilProfil() (+34 more)

### Community 15 - "Changelog & Changeset Tooling"
Cohesion: 0.10
Nodes (36): changelogSection(), findChangelogHeadings(), normalizeLineEndings(), normalizeRequestedVersion(), CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile() (+28 more)

### Community 16 - "Package Scripts Manifest"
Cohesion: 0.05
Nodes (42): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+34 more)

### Community 17 - "Share & Follow Links"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 18 - "Static Pages & Sitemap"
Cohesion: 0.09
Nodes (32): SITEMAP_SOURCES, detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), listStaticPages(), StaticPageDetail (+24 more)

### Community 19 - "Cart Client Storage"
Cohesion: 0.12
Nodes (33): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+25 more)

### Community 20 - "WhatsApp Fallback Messaging"
Cohesion: 0.11
Nodes (33): mintaKode(), Cart, buildWhatsappAccountMessage(), buildWhatsappUrl(), ADR-0003, ADR-0007, appendConversationRows(), hideSubmitError() (+25 more)

### Community 21 - "Institutions & Media Origin"
Cohesion: 0.09
Nodes (29): RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), chunk(), fetchMediaPublicOrigin() (+21 more)

### Community 22 - "Documentation Audit Script"
Cohesion: 0.11
Nodes (34): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+26 more)

### Community 23 - "Checkout Region Lookup"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 24 - "Portable Text Rendering"
Cohesion: 0.11
Nodes (33): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), collectGalleryMediaObjectIds(), documentHasPlayableVideo(), escapeHtml() (+25 more)

### Community 25 - "Order Creation Client"
Cohesion: 0.08
Nodes (30): createPesananRenderer(), PESANAN_PHONE_KEY, cancelOrder(), CartLineStatus, CreateOrderRequest, createPaymentProofUploadSession(), finalizePaymentProofUpload(), getOrder() (+22 more)

### Community 26 - "Storefront Package Manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 27 - "Profile Dist Assertions"
Cohesion: 0.13
Nodes (25): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, routePathPrefix() (+17 more)

### Community 28 - "Profile Seed Assets"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 29 - "News Homepage Navigation"
Cohesion: 0.12
Nodes (24): NavItem, flattenRubrikTree(), getRubrikTree(), paginate(), rubrikPaginationLinks(), getNavUtama(), getUmumList(), selectNavUtamaRubrik() (+16 more)

### Community 30 - "Wishlist Client Storage"
Cohesion: 0.20
Nodes (21): loadWishlist(), removeFromWishlist(), saveWishlist(), toggleWishlist(), addWishlistItem(), createEmptyWishlist(), isIsoDateString(), isWishlisted() (+13 more)

### Community 31 - "Social Meta & Newsletter"
Cohesion: 0.13
Nodes (18): PostDetail, articleSocialMeta(), isHttpUrl(), listingSocialMeta(), MetaTag, ogImageMeta(), OgType, postSeoText() (+10 more)

### Community 32 - "Legacy Content Importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 33 - "Local CI Entry & Fork Policy"
Cohesion: 0.18
Nodes (19): gitRunOrThrow(), main(), parseArgs(), main(), parseArgs(), enforceForkPolicyOrThrow(), fetchPullRequestInfo(), isFromFork() (+11 more)

### Community 34 - "Site Theme Colors"
Cohesion: 0.14
Nodes (18): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, contrastingForeground() (+10 more)

### Community 35 - "Checkout Address & Shipping"
Cohesion: 0.15
Nodes (21): Alamat, keepDigitsAndLeadingPlus(), previewIndonesianPhone(), CartLineRequest, createOrder(), ShippingSelection, applyRegionSelection(), fetchRegionJson() (+13 more)

### Community 36 - "CI Leg Runner Utilities"
Cohesion: 0.25
Nodes (17): run(), RunOptions, RunResult, freePort(), LegContext, LegOutcome, runCheckCmsLeg(), skipCount() (+9 more)

### Community 37 - "Product Catalog Data"
Cohesion: 0.11
Nodes (21): assertNeverProductStatus(), buildCategoryTree(), CategoryNode, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, isPubliclyVisible(), listAllCategories() (+13 more)

### Community 38 - "AWCMS API & Redirect Push"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 39 - "Blog Data Fetching & Ads"
Cohesion: 0.15
Nodes (17): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+9 more)

### Community 40 - "Account Session Contract"
Cohesion: 0.17
Nodes (17): verifikasiKode(), Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun (+9 more)

### Community 41 - "Build Smoke Tests"
Cohesion: 0.13
Nodes (12): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+4 more)

### Community 42 - "Storefront Request Envelope"
Cohesion: 0.13
Nodes (16): UlasanAkun, CartQuote, Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, ValidationErrorDetail, hideSubmitError(), loadList() (+8 more)

### Community 43 - "Obsidian Export Safety"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 44 - "CI Watch, Hash & Lock"
Cohesion: 0.22
Nodes (16): hasRecordedResult(), listOpenPrs(), main(), OpenPr, recordResult(), ciDefinitionHash(), listFilesRecursive(), acquireLock() (+8 more)

### Community 45 - "Product Schema & JSON-LD"
Cohesion: 0.16
Nodes (11): buildPriceTiers(), collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, getCategoryBySlug(), productsInCategory(), BreadcrumbItem, breadcrumbListNode() (+3 more)

### Community 46 - "Ad Popup Dialog"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 47 - "Local CI Leg Definitions"
Cohesion: 0.16
Nodes (16): EXPECTED_CONTEXTS, findLeg(), LEG_CONTEXTS, LegDefinition, LegGroup, LEGS, legsInGroup(), ADR-0021 (+8 more)

### Community 48 - "Astro Route Injection"
Cohesion: 0.19
Nodes (15): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+7 more)

### Community 49 - "Product Page Endpoints"
Cohesion: 0.16
Nodes (12): buildProdukIndex(), getCategories(), getProduct(), getProducts(), labelClassName(), primaryProductImage(), GET(), prerender (+4 more)

### Community 50 - "Account Order Rendering"
Cohesion: 0.17
Nodes (17): AkunPesananHalaman, PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, Order, OrderStatus, appendOrderRows() (+9 more)

### Community 51 - "Product Search Listing"
Cohesion: 0.19
Nodes (15): filterProdukIndex(), normalizeSearchTerm(), paginateProdukIndex(), ProdukIndexEntry, emptyState, grid, heading, paginationEl (+7 more)

### Community 52 - "CodeQL Baseline Scanning"
Cohesion: 0.21
Nodes (14): BaselineEntry, isBaselined(), parseBaseline(), partitionHighSeverityFindings(), SecurityFinding, CODEQL_CLI_SHA256, CODEQL_CLI_VERSION, codeqlCacheDir() (+6 more)

### Community 53 - "Article Text-to-Speech Player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 54 - "Affiliate Code Capture"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 55 - "Legacy Redirect Map"
Cohesion: 0.16
Nodes (13): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET() (+5 more)

### Community 56 - "Legacy Import Tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 57 - "Price Formatting & Flash Sale"
Cohesion: 0.21
Nodes (12): comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003, formatRemaining(), tick() (+4 more)

### Community 58 - "Popular Pages Analytics"
Cohesion: 0.20
Nodes (11): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+3 more)

### Community 59 - "Product Listing Filters"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 60 - "Lockfile & Dependabot Checks"
Cohesion: 0.15
Nodes (14): stripTrailingCommas(), blocks, config, lockfile, ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths (+6 more)

### Community 61 - "Affiliate Commission Page"
Cohesion: 0.22
Nodes (15): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+7 more)

### Community 62 - "Account Address Management"
Cohesion: 0.28
Nodes (15): AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate(), openFormForEdit() (+7 more)

### Community 63 - "MySQL Dump Reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 64 - "E2E Accessibility & Screenshots"
Cohesion: 0.20
Nodes (11): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, firstSlug(), KEY_PAGES, KeyPage, keyPagesFor(), VIEWPORTS (+3 more)

### Community 65 - "Legacy Export CLI Commands"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 66 - "Playwright Test Harness"
Cohesion: 0.22
Nodes (10): isSiteProfile(), resolveSiteProfile(), buildAndServe(), BuildAndServeOptions, BuiltSite, waitForHttp(), globalSetup(), PREVIEW_PORT (+2 more)

### Community 67 - "Wishlist Account Sync"
Cohesion: 0.30
Nodes (10): simpanWishlistAkun(), bacaSesi(), laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), gabungkanWishlist() (+2 more)

### Community 68 - "API Client & Env Helpers"
Cohesion: 0.29
Nodes (9): awcmsGet(), baseUrl(), Envelope, timeoutMs(), EnvSource, readEnv(), readEnvOr(), isValidGaMeasurementId() (+1 more)

### Community 69 - "Production Deploy Tests"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 70 - "Build ID & Bundle Smoke Tests"
Cohesion: 0.17
Nodes (7): buildId, OUT_PATH, resolveBuildId(), canSpawnBun(), canSpawnBun(), runBuild(), bun

### Community 71 - "Product Variant Detail"
Cohesion: 0.23
Nodes (12): CommerceProductVariant, findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload (+4 more)

### Community 72 - "Root Package Metadata"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 73 - "Contract TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 74 - "Deploy Shell Helpers"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 75 - "Secret Redaction"
Cohesion: 0.32
Nodes (7): redactLine(), redactText(), fakeBearerValue, fakeDsnPassword, fakeGithubToken, redact(), main()

### Community 76 - "Storefront TypeScript Config"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 77 - "Contract Package Manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 78 - "Subtree Write Guard Test"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 79 - "Obsidian Export Test"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 80 - "Checkout Prerender Guard"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 81 - "Production Compose Audit"
Cohesion: 0.25
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 82 - "Footer Links & Search Surface"
Cohesion: 0.29
Nodes (7): [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE, StaticPageSummary

### Community 83 - "Graph Audit Test"
Cohesion: 0.29
Nodes (4): cleanup, fixture(), run(), SCRIPT

### Community 84 - "Contract Import Direction Test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 85 - "Bun Version Pin Check"
Cohesion: 0.52
Nodes (5): PKG, BunPinResult, checkBunPin(), enforceBunPinOrThrow(), readPinnedBunVersion()

### Community 86 - "Google Analytics Init"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 87 - "Social Meta Smoke Test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 88 - "Status Prose Translation Test"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 89 - "Config Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 90 - "Gateway Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 91 - "Release Audit Test"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 92 - "Promo Popup Display"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 94 - "Base TypeScript Config"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 96 - "Screenshot Readme Generator"
Cohesion: 0.50
Nodes (3): run, { values }, SITE_PROFILES

### Community 97 - "Share Button Smoke Test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 98 - "Listen Player Smoke Test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 99 - "Institution Logo Smoke Test"
Cohesion: 0.50
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 101 - "Toolchain Version Checks"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

### Community 109 - "Monorepo Workspace Layout"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **723 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+718 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Build ID & Bundle Smoke Tests` to `Template Init Tests`, `Graph & Release Audit Scripts`, `Release Image Signing`, `Changelog & Changeset Tooling`, `Documentation Audit Script`, `Profile Dist Assertions`, `Local CI Entry & Fork Policy`, `CI Leg Runner Utilities`, `Build Smoke Tests`, `CI Watch, Hash & Lock`, `CodeQL Baseline Scanning`, `MySQL Dump Reader`, `Legacy Export CLI Commands`, `Playwright Test Harness`, `Production Deploy Tests`, `Root Package Metadata`, `Graph Audit Test`, `Social Meta Smoke Test`, `Release Audit Test`, `Sidebar Smoke Test`, `Share Button Smoke Test`, `Listen Player Smoke Test`, `Institution Logo Smoke Test`, `Account Dashboard Build Smoke Test`, `Gateway Build Smoke Test`, `Messaging Page Build Smoke Test`?**
  _High betweenness centrality (0.221) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Template Init Tests` to `CMS Seed Scripts`, `Site Profile Configuration`, `Site Identity & Layout Shell`, `Astro Route Injection`, `Profile Dist Assertions`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site Identity & Layout Shell` to `News Article UI Components`, `Site Config & RSS Feed`, `News Nav, Footer & Regions`, `Marketing Promos & Flash Sales`, `Site Profile Configuration`, `Static Pages & Sitemap`, `WhatsApp Fallback Messaging`, `Institutions & Media Origin`, `Profile Dist Assertions`, `News Homepage Navigation`, `Social Meta & Newsletter`, `Product Catalog Data`, `Blog Data Fetching & Ads`, `Product Schema & JSON-LD`, `Product Page Endpoints`, `Account Order Rendering`, `Legacy Redirect Map`, `E2E Accessibility & Screenshots`, `Footer Links & Search Surface`?**
  _High betweenness centrality (0.098) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _723 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `CMS Seed Scripts` be split into smaller, more focused modules?**
  _Cohesion score 0.05510388437217705 - nodes in this community are weakly interconnected._
- **Should `News Article UI Components` be split into smaller, more focused modules?**
  _Cohesion score 0.0519311911716975 - nodes in this community are weakly interconnected._
- **Should `Legacy URL Redirect Rules` be split into smaller, more focused modules?**
  _Cohesion score 0.05719298245614035 - nodes in this community are weakly interconnected._