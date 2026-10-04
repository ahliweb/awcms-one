# Graph Report - .  (2026-10-04)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 2572 nodes · 5777 edges · 126 communities (112 shown, 14 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 41 edges (avg confidence: 0.6)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d3b633a7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- CMS seed CLI
- Template init plan & rewrite
- Dev server routing & Daerah panel
- Local CI process and port helpers
- Docs i18n mirror stamping
- Docs audit gate (audit:dokumen)
- Release & changeset tooling
- News feed and rubric data
- First-party analytics beacon
- Storefront dev stub server (awcms API)
- Site build-profile config
- Customer session & wishlist sync
- News navigation
- Gate library and docs-translation audit
- Marketing data client
- Static page & portable text rendering
- Storefront order client
- Article view rendering
- Site identity composition
- Root package.json manifest
- Share-row (bagikan) tests
- Storefront site config & sitemap sources
- Checkout region & courier lookups
- Storefront package.json manifest
- News layout, pagination & post detail
- Commerce catalog wire types
- Shared profile-route test harness
- Knowledge-graph gate (audit:graf)
- Price formatting utilities
- Product listing filters & sort
- Local CI leg table
- Seed-profile validation tests
- Account API client
- Cart storage client
- Account session contract
- Institution and partner data
- Git argv helpers and CI entrypoints
- Build-smoke stub lifecycle
- Legacy seputarborneo importer
- Product JSON-LD schema
- Checkout phone and order submission
- CMS API fetch client
- Blog & ad-placement fetch helpers
- Article/video schema & breadcrumbs
- Sitemap XML rendering
- Obsidian export tool
- Ad popup widget
- Astro profile route injection
- Header/footer profile navigation
- Storefront API request envelope & signup
- Read-aloud (dengar) player
- Affiliate capture contract
- getVideo
- Cart quote and rendering
- E2E accessibility and responsive specs
- Legacy importer tests
- Account address book
- Terpopuler analytics client
- Tenant theme colors
- Release publish & image tag derivation
- E2E global setup
- Account affiliate page
- MySQL dump reader
- runExport
- Account order-history screen
- bacaSesi
- Account profile page
- Deploy scenario test harness
- Root package manifest
- Lockfile consistency check
- Base tsconfig compiler options
- Deploy shell common library
- Account reviews page
- Product detail variant pricing
- bun
- Account inbox (pesan) screen
- Registration (daftar) OTP screen
- Storefront tsconfig compiler options
- kontrak package manifest
- Subtree-write guard tests
- Local CI watcher state
- Env var reader helpers
- Obsidian export tool tests
- Color contrast utilities
- No-prerender guard tests
- Production compose file tests
- Storefront build-id smoke
- Recent-news (terkini) loader
- News search page
- audit:graf end-to-end tests
- Contract import-direction test
- Local CI watch lock
- GA4 opt-in init
- Social-meta build-smoke test
- Stale-phrase prose check
- packages/config manifest
- packages/gerbang manifest
- Release backlog audit tests
- GA4 opt-in helpers
- Promo popup dialog
- Contact fallback null test
- Sidebar build-smoke test
- Kontrak tsconfig compiler options
- Env-example coverage test
- Bun version-pin test
- Graph-update tool (knowledge:graph:update)
- README screenshot renderer
- Share row build-smoke test
- Read-aloud build-smoke test
- Institution emblem build-smoke test
- Storefront Dockerfile security-update guard
- No-GitHub-Actions guard test
- Video facade script
- Global CSS/fonts test
- Newsletter path-contract test
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
1. `bun` - 59 edges
2. `ROUTES` - 57 edges
3. `scripts` - 42 edges
4. `getSiteIdentity()` - 31 edges
5. `kirimPermintaan()` - 31 edges
6. `formatPrice()` - 27 edges
7. `main()` - 27 edges
8. `bacaSesi()` - 26 edges
9. `startStub()` - 24 edges
10. `buildWhatsappUrl()` - 21 edges

## Surprising Connections (you probably didn't know these)
- `git()` --calls--> `gitRunOrThrow()`  [EXTRACTED]
  tools/rilis.mjs → packages/gerbang/lib/git.mjs
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json
- `resolveBuildId()` --references--> `bun`  [EXTRACTED]
  apps/storefront/scripts/write-build-id.mjs → package.json
- `startStub()` --indirect_call--> `chunk()`  [INFERRED]
  tools/ci/runners/template.ts → apps/storefront/src/lib/awcms/media.ts
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (126 total, 14 thin omitted)

### Community 0 - "CMS seed CLI"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 1 - "Template init plan & rewrite"
Cohesion: 0.06
Nodes (59): canSpawnBun(), ADR-0018, NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), applyPlan(), applyColorDefaults(), BOOLEAN_FLAGS, FLAG_KEYS (+51 more)

### Community 2 - "Dev server routing & Daerah panel"
Cohesion: 0.06
Nodes (64): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+56 more)

### Community 3 - "Local CI process and port helpers"
Cohesion: 0.08
Nodes (44): redactLine(), redactText(), valid, fakeBearerValue, fakeDsnPassword, fakeGithubToken, AuditException, auditIgnoreArgs() (+36 more)

### Community 4 - "Docs i18n mirror stamping"
Cohesion: 0.06
Nodes (46): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+38 more)

### Community 5 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.07
Nodes (51): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+43 more)

### Community 6 - "Release & changeset tooling"
Cohesion: 0.06
Nodes (46): dated, oldest, pending, reporter, todayIso, changelogSection(), findChangelogHeadings(), ADR-0023 (+38 more)

### Community 7 - "News feed and rubric data"
Cohesion: 0.07
Nodes (49): getAllTerms(), RawTerm, getResolvableRegionsByCode(), AuthorArchive, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs() (+41 more)

### Community 8 - "First-party analytics beacon"
Cohesion: 0.06
Nodes (31): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+23 more)

### Community 9 - "Storefront dev stub server (awcms API)"
Cohesion: 0.09
Nodes (45): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), buildAffiliateLink(), buildPaymentInstructions(), computeQuote(), corsHeaders(), deterministicAffiliateCode() (+37 more)

### Community 10 - "Site build-profile config"
Cohesion: 0.07
Nodes (39): activeRouteKeys(), CspNeeds, cspNeedsFor(), DEFAULT_SITE_PROFILE, describeProfile(), excludedRouteKeys(), FeedEntry, FEEDS (+31 more)

### Community 11 - "Customer session & wishlist sync"
Cohesion: 0.10
Nodes (37): chunk(), fetchMediaPublicOrigin(), getMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests() (+29 more)

### Community 12 - "News navigation"
Cohesion: 0.08
Nodes (38): socialIcons, tokoAktif, rubrikColumn, year, daerahActive, STATIC_PAGE_SLUGS, getAllInstitutions(), RawInstitution (+30 more)

### Community 13 - "Gate library and docs-translation audit"
Cohesion: 0.12
Nodes (38): ADR-0020, gitRun(), cosignSign(), cosignVerify(), ensureBuilder(), fail(), headIsExactlyTag(), log() (+30 more)

### Community 14 - "Marketing data client"
Cohesion: 0.08
Nodes (36): CSP_NEEDS, CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus (+28 more)

### Community 15 - "Static page & portable text rendering"
Cohesion: 0.08
Nodes (39): detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), StaticPageDetail, ADR-0100, ALLOWED_LINK_SCHEMES (+31 more)

### Community 16 - "Storefront order client"
Cohesion: 0.06
Nodes (36): createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, PESANAN_PHONE_KEY, cancelOrder(), CartLineStatus (+28 more)

### Community 17 - "Article view rendering"
Cohesion: 0.08
Nodes (27): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+19 more)

### Community 18 - "Site identity composition"
Cohesion: 0.13
Nodes (19): ROUTES, DEFAULT_IDENTITY, getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), getSiteIdentity(), isExpectedRefusal() (+11 more)

### Community 19 - "Root package.json manifest"
Cohesion: 0.05
Nodes (42): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+34 more)

### Community 20 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 21 - "Storefront site config & sitemap sources"
Cohesion: 0.09
Nodes (27): SITEMAP_SOURCES, absoluteUrl(), DefaultIdentity, siteConfig, siteUrl, BeritaFeedItem, escapeCdata(), escapeXml() (+19 more)

### Community 22 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 23 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 24 - "News layout, pagination & post detail"
Cohesion: 0.11
Nodes (25): ResolvedMedia, paginate(), PostDetail, articleSocialMeta(), isHttpUrl(), listingSocialMeta(), MetaTag, ogImageMeta() (+17 more)

### Community 25 - "Commerce catalog wire types"
Cohesion: 0.10
Nodes (29): assertNeverProductStatus(), buildCategoryTree(), buildProdukIndex(), CategoryNode, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, getCategories() (+21 more)

### Community 26 - "Shared profile-route test harness"
Cohesion: 0.13
Nodes (25): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, routePathPrefix() (+17 more)

### Community 27 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.11
Nodes (28): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+20 more)

### Community 28 - "Price formatting utilities"
Cohesion: 0.12
Nodes (19): filterProdukIndex(), labelClassName(), normalizeSearchTerm(), comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber() (+11 more)

### Community 29 - "Product listing filters & sort"
Cohesion: 0.11
Nodes (26): paginateProdukIndex(), ProductSort, ProdukIndexFilter, emptyState, grid, heading, paginationEl, run() (+18 more)

### Community 30 - "Local CI leg table"
Cohesion: 0.11
Nodes (23): PKG, EXPECTED_CONTEXTS, findLeg(), LEG_CONTEXTS, LegDefinition, LegGroup, LEGS, legsInGroup() (+15 more)

### Community 31 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 32 - "Account API client"
Cohesion: 0.18
Nodes (28): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilKomisiAfiliasi(), ambilPesananAkun(), ambilProfil(), ambilUlasanAkun() (+20 more)

### Community 33 - "Cart storage client"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 34 - "Account session contract"
Cohesion: 0.14
Nodes (20): Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun, ADR-0007 (+12 more)

### Community 35 - "Institution and partner data"
Cohesion: 0.12
Nodes (20): buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), buildRegionIndex(), findKaltengProvince(), getProvinces() (+12 more)

### Community 36 - "Git argv helpers and CI entrypoints"
Cohesion: 0.20
Nodes (20): gitRunOrThrow(), main(), parseArgs(), main(), parseArgs(), hasRecordedResult(), listOpenPrs(), main() (+12 more)

### Community 37 - "Build-smoke stub lifecycle"
Cohesion: 0.11
Nodes (13): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+5 more)

### Community 38 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 39 - "Product JSON-LD schema"
Cohesion: 0.13
Nodes (14): buildPriceTiers(), collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, CommerceProductVariant, getCategoryBySlug(), productsInCategory(), ProdukIndexEntry (+6 more)

### Community 40 - "Checkout phone and order submission"
Cohesion: 0.16
Nodes (20): keepDigitsAndLeadingPlus(), previewIndonesianPhone(), CartLineRequest, createOrder(), ShippingSelection, applyRegionSelection(), fetchRegionJson(), fillRegionOptions() (+12 more)

### Community 41 - "CMS API fetch client"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 42 - "Blog & ad-placement fetch helpers"
Cohesion: 0.16
Nodes (16): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+8 more)

### Community 43 - "Article/video schema & breadcrumbs"
Cohesion: 0.13
Nodes (18): ADR-0109, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema(), NewsArticleSchemaInput, breadcrumbItems, canonicalPath (+10 more)

### Community 44 - "Sitemap XML rendering"
Cohesion: 0.20
Nodes (17): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), registerSitemapSource(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests() (+9 more)

### Community 45 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 46 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 47 - "Astro profile route injection"
Cohesion: 0.20
Nodes (14): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+6 more)

### Community 48 - "Header/footer profile navigation"
Cohesion: 0.14
Nodes (15): [], channelCandidates, footerLinks, publishedSlugs, year, NavItem, PROFILE_NAV, PROFILE_NAV_DYNAMIC (+7 more)

### Community 49 - "Storefront API request envelope & signup"
Cohesion: 0.16
Nodes (14): mintaKode(), Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, ValidationErrorDetail, clearFieldErrors(), hideSubmitError(), root (+6 more)

### Community 50 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 51 - "Affiliate capture contract"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 52 - "getVideo"
Cohesion: 0.16
Nodes (13): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET() (+5 more)

### Community 53 - "Cart quote and rendering"
Cohesion: 0.20
Nodes (16): Cart, quoteCart(), buildWhatsappCartMessage(), buildWhatsappUrl(), lineText(), ADR-0003, ADR-0007, hideQuoteError() (+8 more)

### Community 54 - "E2E accessibility and responsive specs"
Cohesion: 0.16
Nodes (12): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, firstSlug(), KEY_PAGES, KeyPage, keyPagesFor(), VIEWPORTS (+4 more)

### Community 55 - "Legacy importer tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 56 - "Account address book"
Cohesion: 0.26
Nodes (16): Alamat, AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate() (+8 more)

### Community 57 - "Terpopuler analytics client"
Cohesion: 0.20
Nodes (11): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+3 more)

### Community 58 - "Tenant theme colors"
Cohesion: 0.18
Nodes (12): apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, GET(), prerender (+4 more)

### Community 59 - "Release publish & image tag derivation"
Cohesion: 0.30
Nodes (13): gitRunInherit(), computeLatestFlag(), deriveImageTags(), highestTag(), isValidTag(), matchesOwnRelease(), parseTag(), TAG_REGEX (+5 more)

### Community 60 - "E2E global setup"
Cohesion: 0.18
Nodes (12): ADR-0021, isSiteProfile(), resolveSiteProfile(), buildAndServe(), BuildAndServeOptions, BuiltSite, waitForHttp(), globalSetup() (+4 more)

### Community 61 - "Account affiliate page"
Cohesion: 0.22
Nodes (15): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+7 more)

### Community 62 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 63 - "runExport"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 64 - "Account order-history screen"
Cohesion: 0.26
Nodes (13): AkunPesananHalaman, ambilPesananAkunByKode(), OrderStatus, appendOrderRows(), hideSubmitError(), loadDetail(), loadMore(), maybeStartPolling() (+5 more)

### Community 65 - "bacaSesi"
Cohesion: 0.30
Nodes (10): simpanWishlistAkun(), bacaSesi(), laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), gabungkanWishlist() (+2 more)

### Community 66 - "Account profile page"
Cohesion: 0.27
Nodes (13): hideSubmitError(), initialsFor(), LEVEL_LABELS, levelLabel(), loadStats(), render(), renderProfile(), root (+5 more)

### Community 67 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 68 - "Root package manifest"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 69 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 70 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 71 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 72 - "Account reviews page"
Cohesion: 0.27
Nodes (11): UlasanAkun, hideSubmitError(), loadList(), render(), renderItem(), root, showGuestView(), showSubmitError() (+3 more)

### Community 73 - "Product detail variant pricing"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 74 - "bun"
Cohesion: 0.18
Nodes (5): canSpawnBun(), runBuild(), canSpawnBun(), canSpawnBun(), bun

### Community 75 - "Account inbox (pesan) screen"
Cohesion: 0.35
Nodes (10): buildWhatsappAccountMessage(), appendConversationRows(), hideSubmitError(), loadDetail(), loadMore(), render(), renderMessages(), root (+2 more)

### Community 76 - "Registration (daftar) OTP screen"
Cohesion: 0.33
Nodes (9): clearFieldErrors(), hideSubmitError(), root, sendCode(), showCodeStep(), showStatus(), showSubmitError(), showWaFallback() (+1 more)

### Community 77 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 78 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 79 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 80 - "Local CI watcher state"
Cohesion: 0.42
Nodes (7): ciDefinitionHash(), listFilesRecursive(), evidenceDir(), lockFilePath(), resultKey(), resultsDir(), stateRoot()

### Community 81 - "Env var reader helpers"
Cohesion: 0.42
Nodes (7): awcmsGet(), baseUrl(), Envelope, timeoutMs(), EnvSource, readEnv(), readEnvOr()

### Community 82 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 83 - "Color contrast utilities"
Cohesion: 0.50
Nodes (6): DEFAULT_THEME_COLORS, contrastingForeground(), contrastRatio(), isValidHexColor(), relativeLuminance(), WCAG_AA_TEXT_CONTRAST

### Community 84 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 85 - "Production compose file tests"
Cohesion: 0.25
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 86 - "Storefront build-id smoke"
Cohesion: 0.24
Nodes (4): buildId, OUT_PATH, resolveBuildId(), canSpawnBun()

### Community 87 - "Recent-news (terkini) loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 88 - "News search page"
Cohesion: 0.29
Nodes (5): input, matches, needle, resultsList, status

### Community 89 - "audit:graf end-to-end tests"
Cohesion: 0.29
Nodes (4): cleanup, fixture(), run(), SCRIPT

### Community 90 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 91 - "Local CI watch lock"
Cohesion: 0.48
Nodes (5): acquireLock(), isProcessAlive(), Lock, readHolder(), tryCreate()

### Community 92 - "GA4 opt-in init"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 93 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 94 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 95 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 96 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 97 - "Release backlog audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 99 - "Promo popup dialog"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 100 - "Contact fallback null test"
Cohesion: 0.40
Nodes (3): canSpawnBun(), FIXTURE_PATH, SITE_TS_PATH

### Community 102 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 104 - "Bun version-pin test"
Cohesion: 0.40
Nodes (4): ADR-0021, orchestrate, pkg, VERSION

### Community 105 - "Graph-update tool (knowledge:graph:update)"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 106 - "README screenshot renderer"
Cohesion: 0.50
Nodes (3): run, { values }, SITE_PROFILES

### Community 107 - "Share row build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 108 - "Read-aloud build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 109 - "Institution emblem build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 111 - "Storefront Dockerfile security-update guard"
Cohesion: 0.50
Nodes (3): dockerfile, DOCKERFILE_PATH, REPO_ROOT

### Community 112 - "No-GitHub-Actions guard test"
Cohesion: 0.50
Nodes (3): ADR-0021, ADR-0023, WORKFLOWS_DIR

### Community 117 - "Workspace member globs"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **744 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+739 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `bun` to `Template init plan & rewrite`, `Local CI process and port helpers`, `Docs audit gate (audit:dokumen)`, `Release & changeset tooling`, `Gate library and docs-translation audit`, `Shared profile-route test harness`, `Git argv helpers and CI entrypoints`, `Build-smoke stub lifecycle`, `Release publish & image tag derivation`, `E2E global setup`, `MySQL dump reader`, `runExport`, `Deploy scenario test harness`, `Root package manifest`, `Storefront build-id smoke`, `audit:graf end-to-end tests`, `Social-meta build-smoke test`, `Release backlog audit tests`, `Contact fallback null test`, `Sidebar build-smoke test`, `Graph-update tool (knowledge:graph:update)`, `Share row build-smoke test`, `Read-aloud build-smoke test`, `Institution emblem build-smoke test`?**
  _High betweenness centrality (0.230) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site identity composition` to `News feed and rubric data`, `Site build-profile config`, `News navigation`, `Marketing data client`, `Article view rendering`, `Storefront site config & sitemap sources`, `News layout, pagination & post detail`, `Commerce catalog wire types`, `Shared profile-route test harness`, `Price formatting utilities`, `Account session contract`, `Institution and partner data`, `Product JSON-LD schema`, `Blog & ad-placement fetch helpers`, `Article/video schema & breadcrumbs`, `Header/footer profile navigation`, `Storefront API request envelope & signup`, `getVideo`, `E2E accessibility and responsive specs`, `Account order-history screen`, `Account inbox (pesan) screen`, `Registration (daftar) OTP screen`, `News search page`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Astro profile route injection` to `CMS seed CLI`, `Template init plan & rewrite`, `Site build-profile config`, `Site identity composition`, `Shared profile-route test harness`?**
  _High betweenness centrality (0.107) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _744 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `CMS seed CLI` be split into smaller, more focused modules?**
  _Cohesion score 0.05540499849442939 - nodes in this community are weakly interconnected._
- **Should `Template init plan & rewrite` be split into smaller, more focused modules?**
  _Cohesion score 0.05775803144224197 - nodes in this community are weakly interconnected._
- **Should `Dev server routing & Daerah panel` be split into smaller, more focused modules?**
  _Cohesion score 0.05719298245614035 - nodes in this community are weakly interconnected._