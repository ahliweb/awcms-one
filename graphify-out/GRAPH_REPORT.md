# Graph Report - .  (2026-09-26)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 2538 nodes · 5723 edges · 133 communities (116 shown, 17 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 41 edges (avg confidence: 0.6)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `77f6c817`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- CMS seed CLI
- Template init plan & rewrite
- Knowledge-graph gate (audit:graf)
- News feed and rubric data
- Gate library and docs-translation audit
- Docs i18n mirror stamping
- Site identity composition
- News navigation
- Static page & portable text rendering
- Site build-profile config
- Storefront dev stub server (awcms API)
- Article/video schema & breadcrumbs
- Release & changeset tooling
- Marketing data client
- Root package.json manifest
- Share-row (bagikan) tests
- Article view rendering
- Dev server routing & Daerah panel
- First-party analytics beacon
- Docs audit gate (audit:dokumen)
- Checkout region & courier lookups
- Storefront package.json manifest
- Shared profile-route test harness
- Git argv helpers and CI entrypoints
- Account API client
- Seed-profile validation tests
- Legacy redirect rules
- Cart storage client
- Customer session & wishlist sync
- Account session contract
- Account inbox (pesan) screen
- Account order-history screen
- Legacy seputarborneo importer
- Storefront order client
- Blog & ad-placement fetch helpers
- CMS API fetch client
- Build-smoke stub lifecycle
- Profile and rubric navigation
- Commerce catalog wire types
- Local CI process and port helpers
- Static page data
- Sitemap XML rendering
- Obsidian export tool
- Ad popup widget
- Astro profile route injection
- Local CI security baseline
- Read-aloud (dengar) player
- Product JSON-LD schema
- Affiliate capture contract
- Registration (daftar) OTP screen
- getVideo
- Legacy importer tests
- Account address book
- Terpopuler analytics client
- Catalog helper tests
- Product listing and search client
- Product listing filters & sort
- Cart quote and rendering
- Order session and payment confirmation
- Lockfile consistency check
- Local CI watcher state
- Institution and partner data
- Checkout phone and order submission
- MySQL dump reader
- E2E global setup
- Tenant theme colors
- Account affiliate page
- CMS origin and analytics beacon
- E2E accessibility and responsive specs
- Log redaction
- runExport
- bacaSesi
- Account profile page
- Deploy scenario test harness
- bun
- Price formatting utilities
- Root package manifest
- Base tsconfig compiler options
- Deploy shell common library
- Account reviews page
- Product detail variant pricing
- CSP media origins
- Site identity config
- Storefront tsconfig compiler options
- kontrak package manifest
- Subtree-write guard tests
- Local CI leg table
- Color contrast utilities
- Region select cascade
- Obsidian export tool tests
- No-prerender guard tests
- Production compose file tests
- Recent-news (terkini) loader
- News search page
- audit:graf end-to-end tests
- Contract import-direction test
- Bun version pin check
- Local CI watch lock
- Env var reader helpers
- GA4 opt-in init
- Social-meta build-smoke test
- Stale-phrase prose check
- packages/config manifest
- packages/gerbang manifest
- Release backlog audit tests
- GA4 opt-in helpers
- Promo popup dialog
- Sidebar build-smoke test
- Kontrak tsconfig compiler options
- Fork PR refusal
- Env-example coverage test
- README screenshot renderer
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
2. `bun` - 56 edges
3. `scripts` - 42 edges
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
- `startStub()` --indirect_call--> `chunk()`  [INFERRED]
  tools/ci/runners/template.ts → apps/storefront/src/lib/awcms/media.ts
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json
- `runTemplateInitTests()` --indirect_call--> `profil()`  [INFERRED]
  tests/template-init.test.mjs → apps/storefront/integrations/profil.mjs

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (133 total, 17 thin omitted)

### Community 0 - "CMS seed CLI"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 1 - "Template init plan & rewrite"
Cohesion: 0.06
Nodes (53): canSpawnBun(), NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), ADR-0018, applyPlan(), applyColorDefaults(), BOOLEAN_FLAGS, FLAG_KEYS (+45 more)

### Community 2 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.05
Nodes (50): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+42 more)

### Community 3 - "News feed and rubric data"
Cohesion: 0.06
Nodes (50): RawTerm, AuthorArchive, BeritaFeedItem, buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive, DaerahLink (+42 more)

### Community 4 - "Gate library and docs-translation audit"
Cohesion: 0.10
Nodes (49): ADR-0020, ADR-0023, gitRunInherit(), cosignSign(), cosignVerify(), ensureBuilder(), fail(), log() (+41 more)

### Community 5 - "Docs i18n mirror stamping"
Cohesion: 0.07
Nodes (44): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+36 more)

### Community 6 - "Site identity composition"
Cohesion: 0.09
Nodes (24): socialIcons, tokoAktif, ROUTES, getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), getSiteIdentity() (+16 more)

### Community 7 - "News navigation"
Cohesion: 0.07
Nodes (47): rubrikColumn, year, daerahActive, getAllInstitutions(), RawInstitution, buildRegionIndex(), findKaltengProvince(), getProvinces() (+39 more)

### Community 8 - "Static page & portable text rendering"
Cohesion: 0.07
Nodes (48): chunk(), fetchMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests(), resolvedCache (+40 more)

### Community 9 - "Site build-profile config"
Cohesion: 0.07
Nodes (41): activeRouteKeys(), CspNeeds, cspNeedsFor(), DEFAULT_SITE_PROFILE, describeProfile(), excludedRouteKeys(), FeedEntry, FEEDS (+33 more)

### Community 10 - "Storefront dev stub server (awcms API)"
Cohesion: 0.09
Nodes (45): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), buildAffiliateLink(), buildPaymentInstructions(), computeQuote(), corsHeaders(), deterministicAffiliateCode() (+37 more)

### Community 11 - "Article/video schema & breadcrumbs"
Cohesion: 0.09
Nodes (35): absoluteUrl(), ResolvedMedia, PostDetail, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema(), NewsArticleSchemaInput (+27 more)

### Community 12 - "Release & changeset tooling"
Cohesion: 0.09
Nodes (37): changelogSection(), findChangelogHeadings(), normalizeLineEndings(), normalizeRequestedVersion(), CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile() (+29 more)

### Community 13 - "Marketing data client"
Cohesion: 0.08
Nodes (38): CSP_NEEDS, getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry (+30 more)

### Community 14 - "Root package.json manifest"
Cohesion: 0.05
Nodes (42): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+34 more)

### Community 15 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 16 - "Article view rendering"
Cohesion: 0.09
Nodes (26): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+18 more)

### Community 17 - "Dev server routing & Daerah panel"
Cohesion: 0.12
Nodes (32): applyHeaders(), CACHE_ASSET, CACHE_PAGE, cacheControlFor(), createServer(), CSP, discoverCssPreloadPaths(), discoverShadowedHtmlPaths() (+24 more)

### Community 18 - "First-party analytics beacon"
Cohesion: 0.08
Nodes (21): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+13 more)

### Community 19 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.11
Nodes (34): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+26 more)

### Community 20 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 21 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 22 - "Shared profile-route test harness"
Cohesion: 0.13
Nodes (25): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, routePathPrefix() (+17 more)

### Community 23 - "Git argv helpers and CI entrypoints"
Cohesion: 0.15
Nodes (25): gitRun(), gitRunOrThrow(), main(), parseArgs(), main(), parseArgs(), fetchPullRequestInfo(), parseGitHubRemoteUrl() (+17 more)

### Community 24 - "Account API client"
Cohesion: 0.18
Nodes (29): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilKomisiAfiliasi(), ambilPesananAkun(), ambilPesananAkunByKode(), ambilProfil() (+21 more)

### Community 25 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 26 - "Legacy redirect rules"
Cohesion: 0.14
Nodes (25): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+17 more)

### Community 27 - "Cart storage client"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 28 - "Customer session & wishlist sync"
Cohesion: 0.20
Nodes (21): loadWishlist(), removeFromWishlist(), saveWishlist(), toggleWishlist(), addWishlistItem(), createEmptyWishlist(), isIsoDateString(), isWishlisted() (+13 more)

### Community 29 - "Account session contract"
Cohesion: 0.14
Nodes (20): Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun, ADR-0007 (+12 more)

### Community 30 - "Account inbox (pesan) screen"
Cohesion: 0.35
Nodes (10): buildWhatsappAccountMessage(), appendConversationRows(), hideSubmitError(), loadDetail(), loadMore(), render(), renderMessages(), root (+2 more)

### Community 31 - "Account order-history screen"
Cohesion: 0.27
Nodes (12): AkunPesananHalaman, Order, appendOrderRows(), hideSubmitError(), loadDetail(), loadMore(), maybeStartPolling(), render() (+4 more)

### Community 32 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 33 - "Storefront order client"
Cohesion: 0.09
Nodes (22): CartLineStatus, CreateOrderRequest, createPaymentProofUploadSession(), finalizePaymentProofUpload(), OrderAddressInput, OrderCustomerInput, OrderLine, OrderPaymentInput (+14 more)

### Community 34 - "Blog & ad-placement fetch helpers"
Cohesion: 0.14
Nodes (18): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+10 more)

### Community 35 - "CMS API fetch client"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 36 - "Build-smoke stub lifecycle"
Cohesion: 0.13
Nodes (12): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+4 more)

### Community 37 - "Profile and rubric navigation"
Cohesion: 0.13
Nodes (21): NavItem, flattenRubrikTree(), getRubrikTree(), paginate(), getPrimaryNav(), insertAfter(), ResolvedNavItem, selectPrimaryNav() (+13 more)

### Community 38 - "Commerce catalog wire types"
Cohesion: 0.10
Nodes (21): assertNeverProductStatus(), CategoryNode, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, getProduct(), isPubliclyVisible(), listAllCategories() (+13 more)

### Community 39 - "Local CI process and port helpers"
Cohesion: 0.29
Nodes (15): run(), freePort(), LegContext, LegOutcome, runCheckCmsLeg(), skipCount(), waitForPostgres(), Profile (+7 more)

### Community 40 - "Static page data"
Cohesion: 0.13
Nodes (18): [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE, detailCache, fetchStaticPage() (+10 more)

### Community 41 - "Sitemap XML rendering"
Cohesion: 0.20
Nodes (17): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), registerSitemapSource(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests() (+9 more)

### Community 42 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 43 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 44 - "Astro profile route injection"
Cohesion: 0.19
Nodes (15): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+7 more)

### Community 45 - "Local CI security baseline"
Cohesion: 0.21
Nodes (14): BaselineEntry, isBaselined(), parseBaseline(), partitionHighSeverityFindings(), SecurityFinding, CODEQL_CLI_SHA256, CODEQL_CLI_VERSION, codeqlCacheDir() (+6 more)

### Community 46 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 47 - "Product JSON-LD schema"
Cohesion: 0.17
Nodes (10): buildPriceTiers(), CommerceCategory, CommerceProduct, CommerceProductVariant, BreadcrumbItem, breadcrumbListNode(), buildCategoryPageSchema(), buildProductPageSchema() (+2 more)

### Community 48 - "Affiliate capture contract"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 49 - "Registration (daftar) OTP screen"
Cohesion: 0.17
Nodes (20): mintaKode(), buildWhatsappUrl(), clearFieldErrors(), hideSubmitError(), root, sendCode(), showCodeStep(), showStatus() (+12 more)

### Community 50 - "getVideo"
Cohesion: 0.16
Nodes (13): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET() (+5 more)

### Community 51 - "Legacy importer tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 52 - "Account address book"
Cohesion: 0.26
Nodes (16): Alamat, AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate() (+8 more)

### Community 53 - "Terpopuler analytics client"
Cohesion: 0.20
Nodes (11): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+3 more)

### Community 54 - "Catalog helper tests"
Cohesion: 0.14
Nodes (11): buildProdukIndex(), collectCategorySubtreeIds(), getCategoryBySlug(), labelClassName(), primaryProductImage(), productsInCategory(), ProdukIndexEntry, GET() (+3 more)

### Community 55 - "Product listing and search client"
Cohesion: 0.22
Nodes (13): filterProdukIndex(), paginateProdukIndex(), emptyState, grid, heading, paginationEl, run(), cardHtml() (+5 more)

### Community 56 - "Product listing filters & sort"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 57 - "Cart quote and rendering"
Cohesion: 0.20
Nodes (15): Cart, quoteCart(), QuoteLine, buildWhatsappCartMessage(), lineText(), ADR-0003, ADR-0007, hideQuoteError() (+7 more)

### Community 58 - "Order session and payment confirmation"
Cohesion: 0.16
Nodes (13): createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, PESANAN_PHONE_KEY, cancelOrder(), getOrder() (+5 more)

### Community 59 - "Lockfile consistency check"
Cohesion: 0.15
Nodes (14): stripTrailingCommas(), blocks, config, lockfile, ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths (+6 more)

### Community 60 - "Local CI watcher state"
Cohesion: 0.29
Nodes (13): hasRecordedResult(), listOpenPrs(), main(), OpenPr, recordResult(), ciDefinitionHash(), listFilesRecursive(), evidenceDir() (+5 more)

### Community 61 - "Institution and partner data"
Cohesion: 0.18
Nodes (11): buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), resolveRegion(), getMitra(), canonicalPath (+3 more)

### Community 62 - "Checkout phone and order submission"
Cohesion: 0.18
Nodes (12): keepDigitsAndLeadingPlus(), previewIndonesianPhone(), CartLineRequest, CartQuote, createOrder(), ShippingSelection, root, runCheckout() (+4 more)

### Community 63 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 64 - "E2E global setup"
Cohesion: 0.20
Nodes (11): isSiteProfile(), resolveSiteProfile(), buildAndServe(), BuildAndServeOptions, BuiltSite, waitForHttp(), globalSetup(), PREVIEW_PORT (+3 more)

### Community 65 - "Tenant theme colors"
Cohesion: 0.20
Nodes (11): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, GET() (+3 more)

### Community 66 - "Account affiliate page"
Cohesion: 0.22
Nodes (15): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+7 more)

### Community 67 - "CMS origin and analytics beacon"
Cohesion: 0.22
Nodes (10): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+2 more)

### Community 68 - "E2E accessibility and responsive specs"
Cohesion: 0.20
Nodes (11): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, firstSlug(), KEY_PAGES, KeyPage, keyPagesFor(), VIEWPORTS (+3 more)

### Community 69 - "Log redaction"
Cohesion: 0.24
Nodes (9): redactLine(), redactText(), fakeBearerValue, fakeDsnPassword, fakeGithubToken, RunOptions, RunResult, redact() (+1 more)

### Community 70 - "runExport"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 71 - "bacaSesi"
Cohesion: 0.30
Nodes (10): simpanWishlistAkun(), bacaSesi(), laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), gabungkanWishlist() (+2 more)

### Community 72 - "Account profile page"
Cohesion: 0.27
Nodes (13): hideSubmitError(), initialsFor(), LEVEL_LABELS, levelLabel(), loadStats(), render(), renderProfile(), root (+5 more)

### Community 73 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 74 - "bun"
Cohesion: 0.17
Nodes (7): buildId, OUT_PATH, resolveBuildId(), canSpawnBun(), canSpawnBun(), runBuild(), bun

### Community 75 - "Price formatting utilities"
Cohesion: 0.28
Nodes (10): comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003, HARGA_FILE, SCANNABLE_EXTENSIONS (+2 more)

### Community 76 - "Root package manifest"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 77 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 78 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 79 - "Account reviews page"
Cohesion: 0.15
Nodes (14): UlasanAkun, Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, hideSubmitError(), loadList(), render(), renderItem() (+6 more)

### Community 80 - "Product detail variant pricing"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 81 - "CSP media origins"
Cohesion: 0.31
Nodes (7): buildCsp(), sanitizeOrigins(), buildCspOriginsArtifact(), collectOrigins(), CspOriginsArtifact, originOf(), ADR-0002

### Community 82 - "Site identity config"
Cohesion: 0.13
Nodes (16): SITEMAP_SOURCES, DEFAULT_IDENTITY, siteConfig, siteUrl, mergeSiteIdentity(), parseSocialLinks(), getProducts(), EnvSource (+8 more)

### Community 83 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 84 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 85 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 86 - "Local CI leg table"
Cohesion: 0.27
Nodes (9): EXPECTED_CONTEXTS, findLeg(), LEG_CONTEXTS, LegDefinition, LegGroup, LEGS, legsInGroup(), ADR-0021 (+1 more)

### Community 87 - "Color contrast utilities"
Cohesion: 0.40
Nodes (7): contrastingForeground(), contrastRatio(), isValidHexColor(), relativeLuminance(), WCAG_AA_TEXT_CONTRAST, GET(), prerender

### Community 88 - "Region select cascade"
Cohesion: 0.44
Nodes (9): applyRegionSelection(), fetchRegionJson(), fillRegionOptions(), loadKabupaten(), loadKecamatan(), loadProvinces(), RegionOption, RegionSelects (+1 more)

### Community 89 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 90 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 91 - "Production compose file tests"
Cohesion: 0.25
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 92 - "Recent-news (terkini) loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 93 - "News search page"
Cohesion: 0.29
Nodes (5): input, matches, needle, resultsList, status

### Community 94 - "audit:graf end-to-end tests"
Cohesion: 0.29
Nodes (4): cleanup, fixture(), run(), SCRIPT

### Community 95 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 96 - "Bun version pin check"
Cohesion: 0.52
Nodes (5): PKG, BunPinResult, checkBunPin(), enforceBunPinOrThrow(), readPinnedBunVersion()

### Community 97 - "Local CI watch lock"
Cohesion: 0.48
Nodes (5): acquireLock(), isProcessAlive(), Lock, readHolder(), tryCreate()

### Community 98 - "Env var reader helpers"
Cohesion: 0.67
Nodes (5): awcmsGet(), baseUrl(), Envelope, timeoutMs(), readEnv()

### Community 99 - "GA4 opt-in init"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 100 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 101 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 102 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 103 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 104 - "Release backlog audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 106 - "Promo popup dialog"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 108 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 109 - "Fork PR refusal"
Cohesion: 0.70
Nodes (3): enforceForkPolicyOrThrow(), isFromFork(), PullRequestInfo

### Community 111 - "README screenshot renderer"
Cohesion: 0.50
Nodes (3): run, { values }, SITE_PROFILES

### Community 112 - "Share row build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 113 - "Read-aloud build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 114 - "Institution emblem build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 116 - "Bun version-pin test"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

### Community 124 - "Workspace member globs"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **723 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+718 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `bun` to `Template init plan & rewrite`, `Knowledge-graph gate (audit:graf)`, `Gate library and docs-translation audit`, `Release & changeset tooling`, `Docs audit gate (audit:dokumen)`, `Shared profile-route test harness`, `Git argv helpers and CI entrypoints`, `Build-smoke stub lifecycle`, `Local CI process and port helpers`, `Local CI security baseline`, `Local CI watcher state`, `MySQL dump reader`, `E2E global setup`, `runExport`, `Deploy scenario test harness`, `Root package manifest`, `audit:graf end-to-end tests`, `Social-meta build-smoke test`, `Release backlog audit tests`, `Sidebar build-smoke test`, `Share row build-smoke test`, `Read-aloud build-smoke test`, `Institution emblem build-smoke test`, `Account dashboard build-smoke test`, `Payment gateway build-smoke test`, `Customer inbox build-smoke test`?**
  _High betweenness centrality (0.218) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Template init plan & rewrite` to `CMS seed CLI`, `Site identity composition`, `Site build-profile config`, `Astro profile route injection`, `Shared profile-route test harness`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site identity composition` to `News feed and rubric data`, `News navigation`, `Site build-profile config`, `Article/video schema & breadcrumbs`, `Article view rendering`, `Shared profile-route test harness`, `Account session contract`, `Account inbox (pesan) screen`, `Account order-history screen`, `Blog & ad-placement fetch helpers`, `Profile and rubric navigation`, `Static page data`, `Product JSON-LD schema`, `Registration (daftar) OTP screen`, `getVideo`, `Institution and partner data`, `E2E accessibility and responsive specs`, `Site identity config`, `News search page`?**
  _High betweenness centrality (0.097) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _723 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `CMS seed CLI` be split into smaller, more focused modules?**
  _Cohesion score 0.05510388437217705 - nodes in this community are weakly interconnected._
- **Should `Template init plan & rewrite` be split into smaller, more focused modules?**
  _Cohesion score 0.06338028169014084 - nodes in this community are weakly interconnected._
- **Should `Knowledge-graph gate (audit:graf)` be split into smaller, more focused modules?**
  _Cohesion score 0.05257936507936508 - nodes in this community are weakly interconnected._