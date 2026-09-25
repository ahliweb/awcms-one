# Graph Report - .  (2026-09-26)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 2406 nodes · 5366 edges · 128 communities (112 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 40 edges (avg confidence: 0.6)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `caa57722`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Gate library and docs-translation audit
- CMS seed CLI
- Dev server routing & Daerah panel
- Template init plan & rewrite
- Static page & portable text rendering
- Site identity composition
- Knowledge-graph gate (audit:graf)
- Release & changeset tooling
- News navigation
- Storefront dev stub server (awcms API)
- News data access
- Site build-profile config
- Marketing data client
- Storefront order client
- Share-row (bagikan) tests
- Article/video schema & breadcrumbs
- Profile navigation
- First-party analytics beacon
- Docs audit gate (audit:dokumen)
- Checkout region & courier lookups
- Storefront package.json manifest
- Root package.json manifest
- Article view rendering
- Shared profile-route test harness
- Catalog UI components
- Account API client
- Seed-profile validation tests
- Customer session & wishlist sync
- Cart storage client
- Legacy seputarborneo importer
- Blog & ad-placement fetch helpers
- CMS API fetch client
- Build-smoke stub lifecycle
- Docs i18n mirror stamping
- Sitemap XML rendering
- Obsidian export tool
- Commerce catalog wire types
- Ad popup widget
- Institution and partner data
- Product listing and search client
- Storefront API request client
- Account inbox (pesan) screen
- Astro profile route injection
- Tenant theme colors
- Affiliate capture contract
- Account affiliate page
- Account address book
- getVideo
- Legacy importer tests
- Account session contract
- Terpopuler analytics client
- OG/social meta builder
- Product listing filters & sort
- Read-aloud (dengar) player
- Lockfile consistency check
- bacaSesi
- MySQL dump reader
- E2E global setup
- Checkout phone and order submission
- CMS origin and analytics beacon
- E2E accessibility and responsive specs
- runExport
- Deploy scenario test harness
- bun
- Checkout e2e spec
- Account order-history screen
- Registration (daftar) OTP screen
- Account reviews page
- Product detail variant pricing
- Cart quote and rendering
- Base tsconfig compiler options
- Deploy shell common library
- Site identity config
- Price formatting utilities
- Account profile page
- Storefront tsconfig compiler options
- kontrak package manifest
- Subtree-write guard tests
- Product JSON-LD schema
- Region select cascade
- Root package manifest
- Env var reader helpers
- Obsidian export tool tests
- Catalog helper tests
- No-prerender guard tests
- Production compose file tests
- Footer & static-page links
- Recent-news (terkini) loader
- Color contrast utilities
- News layout and search page
- audit:graf end-to-end tests
- Contract import-direction test
- getPosts
- GA4 opt-in init
- Social-meta build-smoke test
- Stale-phrase prose check
- packages/config manifest
- Log redaction
- packages/gerbang manifest
- Release backlog audit tests
- Promo popup dialog
- Sidebar build-smoke test
- Kontrak tsconfig compiler options
- Env-example coverage test
- README screenshot renderer
- Product label stylesheet endpoint
- Share row build-smoke test
- Read-aloud build-smoke test
- Institution emblem build-smoke test
- Bun version-pin test
- Graph-update tool (knowledge:graph:update)
- Account dashboard build-smoke test
- Payment gateway build-smoke test
- Global CSS/fonts test
- Newsletter path-contract test
- Customer inbox build-smoke test
- Offsite backup copy script
- Root repository field
- Workspace member globs
- Postgres least-privilege role init
- Backup compose runner
- Production job-runner script
- Production deploy entrypoint
- Remote deploy trigger
- Production healthcheck
- Production rollback

## God Nodes (most connected - your core abstractions)
1. `ROUTES` - 57 edges
2. `bun` - 44 edges
3. `scripts` - 35 edges
4. `getSiteIdentity()` - 31 edges
5. `kirimPermintaan()` - 31 edges
6. `formatPrice()` - 27 edges
7. `main()` - 27 edges
8. `bacaSesi()` - 26 edges
9. `startStub()` - 23 edges
10. `buildWhatsappUrl()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `git()` --calls--> `gitRunOrThrow()`  [EXTRACTED]
  tools/rilis.mjs → packages/gerbang/lib/git.mjs
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json
- `runTemplateInitTests()` --indirect_call--> `profil()`  [INFERRED]
  tests/template-init.test.mjs → apps/storefront/integrations/profil.mjs
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/akun-build-smoke.test.ts → package.json

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (128 total, 16 thin omitted)

### Community 0 - "Gate library and docs-translation audit"
Cohesion: 0.06
Nodes (79): ADR-0020, ADR-0023, DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks() (+71 more)

### Community 1 - "CMS seed CLI"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 2 - "Dev server routing & Daerah panel"
Cohesion: 0.05
Nodes (66): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+58 more)

### Community 3 - "Template init plan & rewrite"
Cohesion: 0.06
Nodes (53): canSpawnBun(), NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), ADR-0018, applyPlan(), applyColorDefaults(), BOOLEAN_FLAGS, FLAG_KEYS (+45 more)

### Community 4 - "Static page & portable text rendering"
Cohesion: 0.07
Nodes (49): chunk(), fetchMediaPublicOrigin(), getMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests() (+41 more)

### Community 5 - "Site identity composition"
Cohesion: 0.09
Nodes (24): socialIcons, tokoAktif, ROUTES, getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), getSiteIdentity() (+16 more)

### Community 6 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.06
Nodes (45): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+37 more)

### Community 7 - "Release & changeset tooling"
Cohesion: 0.07
Nodes (42): dated, oldest, pending, reporter, todayIso, changelogSection(), findChangelogHeadings(), normalizeLineEndings() (+34 more)

### Community 8 - "News navigation"
Cohesion: 0.08
Nodes (42): rubrikColumn, year, daerahActive, buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf(), getResolvableRegionsByCode() (+34 more)

### Community 9 - "Storefront dev stub server (awcms API)"
Cohesion: 0.09
Nodes (45): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), buildAffiliateLink(), buildPaymentInstructions(), computeQuote(), corsHeaders(), deterministicAffiliateCode() (+37 more)

### Community 10 - "News data access"
Cohesion: 0.07
Nodes (41): RawTerm, AuthorArchive, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive, DaerahLink (+33 more)

### Community 11 - "Site build-profile config"
Cohesion: 0.07
Nodes (33): CspNeeds, DEFAULT_SITE_PROFILE, FeedEntry, FEEDS, FEEDS_ALL, FOOTER_PAGE_LINKS, FooterPageLink, GROUP_STYLESHEET_HREFS (+25 more)

### Community 12 - "Marketing data client"
Cohesion: 0.08
Nodes (36): CSP_NEEDS, CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus (+28 more)

### Community 13 - "Storefront order client"
Cohesion: 0.07
Nodes (35): createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, PESANAN_PHONE_KEY, cancelOrder(), CartLineStatus (+27 more)

### Community 14 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 15 - "Article/video schema & breadcrumbs"
Cohesion: 0.09
Nodes (30): absoluteUrl(), BeritaFeedItem, getPost(), getRelatedPosts(), renderBeritaRssXml(), BreadcrumbItem, breadcrumbListSchema(), combineSchemas() (+22 more)

### Community 16 - "Profile navigation"
Cohesion: 0.09
Nodes (31): detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), listStaticPages(), StaticPageDetail, ADR-0100 (+23 more)

### Community 17 - "First-party analytics beacon"
Cohesion: 0.08
Nodes (21): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+13 more)

### Community 18 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.11
Nodes (34): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+26 more)

### Community 19 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 20 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 21 - "Root package.json manifest"
Cohesion: 0.06
Nodes (35): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+27 more)

### Community 22 - "Article view rendering"
Cohesion: 0.11
Nodes (20): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+12 more)

### Community 23 - "Shared profile-route test harness"
Cohesion: 0.13
Nodes (25): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, routePathPrefix() (+17 more)

### Community 24 - "Catalog UI components"
Cohesion: 0.11
Nodes (16): getActiveFlashSales(), buildCategoryTree(), buildProdukIndex(), getCategories(), getProducts(), primaryProductImage(), BreadcrumbItem, KATALOG_SITEMAP_SOURCE_NAMES (+8 more)

### Community 25 - "Account API client"
Cohesion: 0.12
Nodes (27): Afiliasi, AfiliasiKomisi, AkunPesananHalaman, AlamatInput, ambilPesananAkun(), ambilWishlistAkun(), authHeader(), denganPembersihanSesi() (+19 more)

### Community 26 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 27 - "Customer session & wishlist sync"
Cohesion: 0.20
Nodes (21): loadWishlist(), removeFromWishlist(), saveWishlist(), toggleWishlist(), addWishlistItem(), createEmptyWishlist(), isIsoDateString(), isWishlisted() (+13 more)

### Community 28 - "Cart storage client"
Cohesion: 0.20
Nodes (22): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+14 more)

### Community 29 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 30 - "Blog & ad-placement fetch helpers"
Cohesion: 0.14
Nodes (18): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+10 more)

### Community 31 - "CMS API fetch client"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 32 - "Build-smoke stub lifecycle"
Cohesion: 0.13
Nodes (12): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+4 more)

### Community 33 - "Docs i18n mirror stamping"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 34 - "Sitemap XML rendering"
Cohesion: 0.19
Nodes (18): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), registerSitemapSource(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests() (+10 more)

### Community 35 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 36 - "Commerce catalog wire types"
Cohesion: 0.12
Nodes (19): assertNeverProductStatus(), CategoryNode, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, getProduct(), isPubliclyVisible(), listAllCategories() (+11 more)

### Community 37 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 38 - "Institution and partner data"
Cohesion: 0.16
Nodes (14): getAllInstitutions(), RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), ResolvedMedia (+6 more)

### Community 39 - "Product listing and search client"
Cohesion: 0.19
Nodes (15): filterProdukIndex(), normalizeSearchTerm(), paginateProdukIndex(), ProdukIndexEntry, emptyState, grid, heading, paginationEl (+7 more)

### Community 40 - "Storefront API request client"
Cohesion: 0.16
Nodes (13): Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, ValidationErrorDetail, clearFieldErrors(), hideSubmitError(), root, sendCode() (+5 more)

### Community 41 - "Account inbox (pesan) screen"
Cohesion: 0.19
Nodes (15): buildWhatsappAccountMessage(), buildWhatsappCartMessage(), buildWhatsappUrl(), lineText(), ADR-0003, ADR-0007, appendConversationRows(), hideSubmitError() (+7 more)

### Community 42 - "Astro profile route injection"
Cohesion: 0.20
Nodes (14): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+6 more)

### Community 43 - "Tenant theme colors"
Cohesion: 0.17
Nodes (13): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, GET() (+5 more)

### Community 44 - "Affiliate capture contract"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 45 - "Account affiliate page"
Cohesion: 0.20
Nodes (17): AfiliasiKomisiHalaman, ambilAfiliasi(), ambilKomisiAfiliasi(), appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi() (+9 more)

### Community 46 - "Account address book"
Cohesion: 0.25
Nodes (17): ambilAlamat(), hapusAlamat(), jadikanAlamatUtama(), clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList() (+9 more)

### Community 47 - "getVideo"
Cohesion: 0.16
Nodes (13): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET() (+5 more)

### Community 48 - "Legacy importer tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 49 - "Account session contract"
Cohesion: 0.25
Nodes (14): AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun, ADR-0007, validateAkun() (+6 more)

### Community 50 - "Terpopuler analytics client"
Cohesion: 0.20
Nodes (11): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+3 more)

### Community 51 - "OG/social meta builder"
Cohesion: 0.26
Nodes (13): PostDetail, articleSocialMeta(), isHttpUrl(), listingSocialMeta(), MetaTag, ogImageMeta(), postSeoText(), rubrikPaginationLinks() (+5 more)

### Community 52 - "Product listing filters & sort"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 53 - "Read-aloud (dengar) player"
Cohesion: 0.21
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 54 - "Lockfile consistency check"
Cohesion: 0.15
Nodes (14): stripTrailingCommas(), blocks, config, lockfile, ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths (+6 more)

### Community 55 - "bacaSesi"
Cohesion: 0.25
Nodes (12): hapusWishlistAkunItem(), simpanWishlistAkun(), bacaSesi(), laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk() (+4 more)

### Community 56 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 57 - "E2E global setup"
Cohesion: 0.20
Nodes (11): isSiteProfile(), resolveSiteProfile(), buildAndServe(), BuildAndServeOptions, BuiltSite, waitForHttp(), globalSetup(), PREVIEW_PORT (+3 more)

### Community 58 - "Checkout phone and order submission"
Cohesion: 0.20
Nodes (12): Alamat, keepDigitsAndLeadingPlus(), previewIndonesianPhone(), CartLineRequest, createOrder(), ShippingSelection, root, runCheckout() (+4 more)

### Community 59 - "CMS origin and analytics beacon"
Cohesion: 0.22
Nodes (10): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+2 more)

### Community 60 - "E2E accessibility and responsive specs"
Cohesion: 0.20
Nodes (11): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, firstSlug(), KEY_PAGES, KeyPage, keyPagesFor(), VIEWPORTS (+3 more)

### Community 61 - "runExport"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 62 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 63 - "bun"
Cohesion: 0.17
Nodes (7): buildId, OUT_PATH, resolveBuildId(), canSpawnBun(), canSpawnBun(), runBuild(), bun

### Community 64 - "Checkout e2e spec"
Cohesion: 0.23
Nodes (11): activeRouteKeys(), cspNeedsFor(), describeProfile(), excludedRouteKeys(), feedsFor(), groupStylesheetsFor(), isGroupActive(), isRouteActive() (+3 more)

### Community 65 - "Account order-history screen"
Cohesion: 0.29
Nodes (12): ambilPesananAkunByKode(), OrderStatus, appendOrderRows(), hideSubmitError(), loadDetail(), loadMore(), maybeStartPolling(), render() (+4 more)

### Community 66 - "Registration (daftar) OTP screen"
Cohesion: 0.35
Nodes (10): mintaKode(), clearFieldErrors(), hideSubmitError(), root, sendCode(), showCodeStep(), showStatus(), showSubmitError() (+2 more)

### Community 67 - "Account reviews page"
Cohesion: 0.26
Nodes (12): ambilUlasanAkun(), UlasanAkun, hideSubmitError(), loadList(), render(), renderItem(), root, showGuestView() (+4 more)

### Community 68 - "Product detail variant pricing"
Cohesion: 0.23
Nodes (12): CommerceProductVariant, findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload (+4 more)

### Community 69 - "Cart quote and rendering"
Cohesion: 0.24
Nodes (11): CartQuote, quoteCart(), hideQuoteError(), refresh(), renderLines(), renderSummary(), root, showQuoteError() (+3 more)

### Community 70 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 71 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 72 - "Site identity config"
Cohesion: 0.23
Nodes (9): DEFAULT_IDENTITY, siteConfig, siteUrl, mergeSiteIdentity(), parseSocialLinks(), escapeXml(), GET(), prerender (+1 more)

### Community 73 - "Price formatting utilities"
Cohesion: 0.29
Nodes (10): comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003, HARGA_FILE, SCANNABLE_EXTENSIONS (+2 more)

### Community 74 - "Account profile page"
Cohesion: 0.29
Nodes (12): ambilProfil(), hideSubmitError(), initialsFor(), LEVEL_LABELS, levelLabel(), render(), renderProfile(), root (+4 more)

### Community 75 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 76 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 77 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 78 - "Product JSON-LD schema"
Cohesion: 0.33
Nodes (6): CommerceCategory, CommerceProduct, breadcrumbListNode(), buildCategoryPageSchema(), buildProductPageSchema(), ProductSchemaInput

### Community 79 - "Region select cascade"
Cohesion: 0.44
Nodes (9): applyRegionSelection(), fetchRegionJson(), fillRegionOptions(), loadKabupaten(), loadKecamatan(), loadProvinces(), RegionOption, RegionSelects (+1 more)

### Community 80 - "Root package manifest"
Cohesion: 0.20
Nodes (9): description, engines, homepage, license, name, packageManager, private, type (+1 more)

### Community 81 - "Env var reader helpers"
Cohesion: 0.42
Nodes (7): awcmsGet(), baseUrl(), Envelope, timeoutMs(), EnvSource, readEnv(), readEnvOr()

### Community 82 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 83 - "Catalog helper tests"
Cohesion: 0.25
Nodes (4): buildPriceTiers(), collectCategorySubtreeIds(), getCategoryBySlug(), productsInCategory()

### Community 84 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 85 - "Production compose file tests"
Cohesion: 0.25
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 86 - "Footer & static-page links"
Cohesion: 0.29
Nodes (7): [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE, StaticPageSummary

### Community 87 - "Recent-news (terkini) loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 88 - "Color contrast utilities"
Cohesion: 0.62
Nodes (5): contrastingForeground(), contrastRatio(), isValidHexColor(), relativeLuminance(), WCAG_AA_TEXT_CONTRAST

### Community 89 - "News layout and search page"
Cohesion: 0.29
Nodes (5): input, matches, needle, resultsList, status

### Community 90 - "audit:graf end-to-end tests"
Cohesion: 0.29
Nodes (4): cleanup, fixture(), run(), SCRIPT

### Community 91 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 92 - "getPosts"
Cohesion: 0.40
Nodes (5): getPosts(), getStaticPaths(), BeritaIndexEntry, GET(), prerender

### Community 93 - "GA4 opt-in init"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 94 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 95 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 96 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 97 - "Log redaction"
Cohesion: 0.67
Nodes (3): redactLine(), redactText(), main()

### Community 98 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 99 - "Release backlog audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 100 - "Promo popup dialog"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 102 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 104 - "README screenshot renderer"
Cohesion: 0.50
Nodes (3): run, { values }, SITE_PROFILES

### Community 105 - "Product label stylesheet endpoint"
Cohesion: 0.67
Nodes (3): labelClassName(), GET(), prerender

### Community 106 - "Share row build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 107 - "Read-aloud build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 108 - "Institution emblem build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 110 - "Bun version-pin test"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

### Community 118 - "Root repository field"
Cohesion: 0.67
Nodes (3): repository, type, url

### Community 119 - "Workspace member globs"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **694 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+689 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `bun` to `Gate library and docs-translation audit`, `Template init plan & rewrite`, `Knowledge-graph gate (audit:graf)`, `Release & changeset tooling`, `Docs audit gate (audit:dokumen)`, `Shared profile-route test harness`, `Build-smoke stub lifecycle`, `MySQL dump reader`, `E2E global setup`, `runExport`, `Deploy scenario test harness`, `Root package manifest`, `audit:graf end-to-end tests`, `Social-meta build-smoke test`, `Release backlog audit tests`, `Sidebar build-smoke test`, `Share row build-smoke test`, `Read-aloud build-smoke test`, `Institution emblem build-smoke test`, `Account dashboard build-smoke test`, `Payment gateway build-smoke test`, `Customer inbox build-smoke test`?**
  _High betweenness centrality (0.162) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Template init plan & rewrite` to `CMS seed CLI`, `Site identity composition`, `Astro profile route injection`, `Site build-profile config`, `Shared profile-route test harness`?**
  _High betweenness centrality (0.159) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site identity composition` to `News navigation`, `News data access`, `Site build-profile config`, `Article/video schema & breadcrumbs`, `Profile navigation`, `Article view rendering`, `Shared profile-route test harness`, `Catalog UI components`, `Blog & ad-placement fetch helpers`, `Institution and partner data`, `Storefront API request client`, `Account inbox (pesan) screen`, `getVideo`, `OG/social meta builder`, `E2E accessibility and responsive specs`, `Account order-history screen`, `Registration (daftar) OTP screen`, `Footer & static-page links`, `News layout and search page`?**
  _High betweenness centrality (0.099) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _694 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Gate library and docs-translation audit` be split into smaller, more focused modules?**
  _Cohesion score 0.05629974762182101 - nodes in this community are weakly interconnected._
- **Should `CMS seed CLI` be split into smaller, more focused modules?**
  _Cohesion score 0.05510388437217705 - nodes in this community are weakly interconnected._
- **Should `Dev server routing & Daerah panel` be split into smaller, more focused modules?**
  _Cohesion score 0.053703703703703705 - nodes in this community are weakly interconnected._