# Graph Report - .  (2026-09-23)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 2254 nodes · 5021 edges · 94 communities (88 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 38 edges (avg confidence: 0.6)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f09bfb12`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Storefront checkout & affiliate capture
- Dev server routing & Daerah panel
- Template init plan & rewrite
- Storefront catalog domain model
- Knowledge-graph gate (audit:graf)
- Storefront build/test spawn helpers
- Docs i18n mirror stamping
- News (berita) domain model
- Site build-profile config
- First-party analytics beacon
- CMS seed CLI
- Storefront dev stub server (awcms API)
- Static page & portable text rendering
- Site identity & route registry
- Customer session & wishlist sync
- Root package.json manifest
- Region (Kalteng) navigation index
- Marketing surface (flash sales, tiers)
- Share-row (bagikan) tests
- Docs audit gate (audit:dokumen)
- Release & changeset tooling
- Checkout region & courier lookups
- Shared profile-route test harness
- Article view component
- Product listing filters & sort
- Storefront order client
- Account client (akun-klien)
- Storefront package.json manifest
- Article/video schema & breadcrumbs
- Seed-profile validation tests
- Primary navigation per profile
- Legacy seputarborneo importer
- Seed-CMS ensure/apply helpers
- Account reviews screen
- Legacy redirect import tool
- Blog & ad-placement fetch helpers
- Bearer customer-session store
- Price formatting utilities
- Sitemap sources & RSS feed
- Obsidian export tool
- Media object resolution client
- Sitemap XML rendering
- Account inbox (pesan) screen
- Ad popup widget
- Astro profile route injection
- Account order-history screen
- Read-aloud (dengar) player
- Institution (mitra) directory
- Legacy redirect map & video lookup
- OG/social meta builder
- Legacy importer tests
- audit:graf end-to-end tests
- MySQL dump reader
- Tenant theme colors
- Affiliate commission screen
- Terpopuler analytics client
- Account address book screen
- Institution & redirect export CLI
- Berita layout OG/search helpers
- Env var reader helpers
- Account profile screen
- Lockfile consistency check
- Base tsconfig compiler options
- Product detail variant pricing
- Registration (daftar) OTP screen
- Storefront tsconfig compiler options
- kontrak package manifest
- Subtree-write guard tests
- Color contrast utilities
- E2E global setup
- Obsidian export tool tests
- No-prerender guard tests
- Production compose file tests
- Footer & static-page links
- Recent-news (terkini) loader
- Contract import-direction test
- GA4 opt-in init
- Social-meta build-smoke test
- Stale-phrase prose check
- packages/config manifest
- packages/gerbang manifest
- Region-institution matching helpers
- Promo popup dialog
- Kontrak tsconfig compiler options
- Env-example coverage test
- Bun version-pin test
- Graph-update tool (knowledge:graph:update)
- Global CSS/fonts test
- Newsletter path-contract test
- Postgres least-privilege role init
- Production job-runner script

## God Nodes (most connected - your core abstractions)
1. `ROUTES` - 56 edges
2. `bun` - 37 edges
3. `getSiteIdentity()` - 31 edges
4. `kirimPermintaan()` - 31 edges
5. `scripts` - 29 edges
6. `formatPrice()` - 27 edges
7. `bacaSesi()` - 26 edges
8. `startStub()` - 23 edges
9. `buildWhatsappUrl()` - 21 edges
10. `getStoreSettings()` - 20 edges

## Surprising Connections (you probably didn't know these)
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json
- `resolveBuildId()` --references--> `bun`  [EXTRACTED]
  apps/storefront/scripts/write-build-id.mjs → package.json
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json
- `runTemplateInitTests()` --indirect_call--> `profil()`  [INFERRED]
  tests/template-init.test.mjs → apps/storefront/integrations/profil.mjs
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/meta-sosial-build-smoke.test.ts → package.json

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (94 total, 6 thin omitted)

### Community 0 - "Storefront checkout & affiliate capture"
Cohesion: 0.05
Nodes (72): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+64 more)

### Community 1 - "Dev server routing & Daerah panel"
Cohesion: 0.06
Nodes (64): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+56 more)

### Community 2 - "Template init plan & rewrite"
Cohesion: 0.06
Nodes (55): canSpawnBun(), ADR-0018, NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), ADR-0018, applyPlan(), applyColorDefaults(), BOOLEAN_FLAGS (+47 more)

### Community 3 - "Storefront catalog domain model"
Cohesion: 0.05
Nodes (51): siteConfig, assertNeverProductStatus(), buildCategoryTree(), buildPriceTiers(), buildProdukIndex(), CategoryNode, collectCategorySubtreeIds(), CommerceCategory (+43 more)

### Community 4 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.05
Nodes (51): ADR-0002, graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath (+43 more)

### Community 5 - "Storefront build/test spawn helpers"
Cohesion: 0.06
Nodes (29): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), runBuild(), ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE (+21 more)

### Community 6 - "Docs i18n mirror stamping"
Cohesion: 0.07
Nodes (43): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+35 more)

### Community 7 - "News (berita) domain model"
Cohesion: 0.06
Nodes (46): RawTerm, AuthorArchive, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive, DaerahLink (+38 more)

### Community 8 - "Site build-profile config"
Cohesion: 0.07
Nodes (44): CSP_NEEDS, CspNeeds, cspNeedsFor(), DEFAULT_SITE_PROFILE, describeProfile(), excludedRouteKeys(), FeedEntry, FEEDS (+36 more)

### Community 9 - "First-party analytics beacon"
Cohesion: 0.06
Nodes (31): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+23 more)

### Community 10 - "CMS seed CLI"
Cohesion: 0.05
Nodes (46): AdPlacementSeed, ApiResult, attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed, Cli, ensureTenantDomains(), errorCodeOf() (+38 more)

### Community 11 - "Storefront dev stub server (awcms API)"
Cohesion: 0.09
Nodes (45): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), buildAffiliateLink(), buildPaymentInstructions(), computeQuote(), corsHeaders(), deterministicAffiliateCode() (+37 more)

### Community 12 - "Static page & portable text rendering"
Cohesion: 0.07
Nodes (42): detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), StaticPageDetail, ADR-0100, toPostSummary() (+34 more)

### Community 13 - "Site identity & route registry"
Cohesion: 0.11
Nodes (22): socialIcons, tokoAktif, ROUTES, DEFAULT_IDENTITY, siteUrl, getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD (+14 more)

### Community 14 - "Customer session & wishlist sync"
Cohesion: 0.12
Nodes (33): bacaSesi(), laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist() (+25 more)

### Community 15 - "Root package.json manifest"
Cohesion: 0.04
Nodes (44): description, engines, homepage, license, name, packageManager, private, repository (+36 more)

### Community 16 - "Region (Kalteng) navigation index"
Cohesion: 0.09
Nodes (35): rubrikColumn, year, daerahActive, buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf(), getResolvableRegionsByCode() (+27 more)

### Community 17 - "Marketing surface (flash sales, tiers)"
Cohesion: 0.08
Nodes (37): AwcmsApiError, CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus (+29 more)

### Community 18 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 19 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.11
Nodes (34): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+26 more)

### Community 20 - "Release & changeset tooling"
Cohesion: 0.11
Nodes (33): CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile(), parseChangeset(), validateChangeset(), gitRunInherit(), gitRunOrThrow() (+25 more)

### Community 21 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 22 - "Shared profile-route test harness"
Cohesion: 0.12
Nodes (27): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, activeRouteKeys() (+19 more)

### Community 23 - "Article view component"
Cohesion: 0.11
Nodes (23): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+15 more)

### Community 24 - "Product listing filters & sort"
Cohesion: 0.11
Nodes (29): filterProdukIndex(), paginateProdukIndex(), ProductSort, ProdukIndexFilter, emptyState, grid, heading, paginationEl (+21 more)

### Community 25 - "Storefront order client"
Cohesion: 0.08
Nodes (29): createPesananRenderer(), cancelOrder(), CartLineStatus, CreateOrderRequest, createPaymentProofUploadSession(), finalizePaymentProofUpload(), getOrder(), OrderAddressInput (+21 more)

### Community 26 - "Account client (akun-klien)"
Cohesion: 0.15
Nodes (32): Afiliasi, AfiliasiKomisi, Alamat, AlamatInput, ambilAfiliasi(), ambilAlamat(), ambilKomisiAfiliasi(), ambilPesananAkun() (+24 more)

### Community 27 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (31): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @playwright/test (+23 more)

### Community 28 - "Article/video schema & breadcrumbs"
Cohesion: 0.09
Nodes (26): getPosts(), getRelatedPosts(), ADR-0109, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema(), NewsArticleSchemaInput (+18 more)

### Community 29 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 30 - "Primary navigation per profile"
Cohesion: 0.13
Nodes (23): listStaticPages(), flattenRubrikTree(), getRubrikTree(), paginate(), getNavUtama(), getUmumList(), selectNavUtamaRubrik(), getPrimaryNav() (+15 more)

### Community 31 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 32 - "Seed-CMS ensure/apply helpers"
Cohesion: 0.22
Nodes (26): apiCall(), applySiteProfile(), assertOk(), ensureAdPlacements(), ensureBlogPages(), ensureBlogPosts(), ensureBlogTerms(), ensureCategories() (+18 more)

### Community 33 - "Account reviews screen"
Cohesion: 0.15
Nodes (22): buildWhatsappAccountMessage(), buildWhatsappUrl(), showSubmitError(), hideSubmitError(), loadList(), render(), renderItem(), root (+14 more)

### Community 34 - "Legacy redirect import tool"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 35 - "Blog & ad-placement fetch helpers"
Cohesion: 0.15
Nodes (17): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+9 more)

### Community 36 - "Bearer customer-session store"
Cohesion: 0.17
Nodes (17): verifikasiKode(), AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun, ADR-0007 (+9 more)

### Community 37 - "Price formatting utilities"
Cohesion: 0.16
Nodes (12): comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003, formatRemaining(), tick() (+4 more)

### Community 38 - "Sitemap sources & RSS feed"
Cohesion: 0.16
Nodes (16): SITEMAP_SOURCES, absoluteUrl(), BeritaFeedItem, getPost(), renderBeritaRssXml(), renderPortableText(), KATALOG_SITEMAP_SOURCE_NAMES, registerSitemapSource() (+8 more)

### Community 39 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 40 - "Media object resolution client"
Cohesion: 0.16
Nodes (16): chunk(), fetchMediaPublicOrigin(), getMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests() (+8 more)

### Community 41 - "Sitemap XML rendering"
Cohesion: 0.22
Nodes (16): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests(), resetSitemapSourcesForTests() (+8 more)

### Community 42 - "Account inbox (pesan) screen"
Cohesion: 0.15
Nodes (14): CartQuote, Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, ValidationErrorDetail, appendConversationRows(), hideSubmitError(), loadDetail() (+6 more)

### Community 43 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 44 - "Astro profile route injection"
Cohesion: 0.19
Nodes (15): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+7 more)

### Community 45 - "Account order-history screen"
Cohesion: 0.18
Nodes (17): AkunPesananHalaman, ambilPesananAkunByKode(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, Order, appendOrderRows() (+9 more)

### Community 46 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 47 - "Institution (mitra) directory"
Cohesion: 0.17
Nodes (13): getAllInstitutions(), RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), resolveRegion() (+5 more)

### Community 48 - "Legacy redirect map & video lookup"
Cohesion: 0.16
Nodes (13): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET() (+5 more)

### Community 49 - "OG/social meta builder"
Cohesion: 0.24
Nodes (14): ResolvedMedia, PostDetail, articleSocialMeta(), isHttpUrl(), listingSocialMeta(), MetaTag, ogImageMeta(), postSeoText() (+6 more)

### Community 50 - "Legacy importer tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 51 - "audit:graf end-to-end tests"
Cohesion: 0.10
Nodes (10): buildId, OUT_PATH, resolveBuildId(), cleanup, fixture(), run(), SCRIPT, cleanup (+2 more)

### Community 52 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 53 - "Tenant theme colors"
Cohesion: 0.20
Nodes (11): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, GET() (+3 more)

### Community 54 - "Affiliate commission screen"
Cohesion: 0.22
Nodes (14): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+6 more)

### Community 55 - "Terpopuler analytics client"
Cohesion: 0.23
Nodes (10): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+2 more)

### Community 56 - "Account address book screen"
Cohesion: 0.31
Nodes (14): clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate(), openFormForEdit(), render() (+6 more)

### Community 57 - "Institution & redirect export CLI"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 58 - "Berita layout OG/search helpers"
Cohesion: 0.15
Nodes (6): OgType, input, matches, needle, resultsList, status

### Community 59 - "Env var reader helpers"
Cohesion: 0.29
Nodes (9): awcmsGet(), baseUrl(), Envelope, timeoutMs(), EnvSource, readEnv(), readEnvOr(), isValidGaMeasurementId() (+1 more)

### Community 60 - "Account profile screen"
Cohesion: 0.27
Nodes (13): hideSubmitError(), initialsFor(), LEVEL_LABELS, levelLabel(), loadStats(), render(), renderProfile(), root (+5 more)

### Community 61 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 62 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 63 - "Product detail variant pricing"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 64 - "Registration (daftar) OTP screen"
Cohesion: 0.35
Nodes (10): mintaKode(), clearFieldErrors(), hideSubmitError(), root, sendCode(), showCodeStep(), showStatus(), showSubmitError() (+2 more)

### Community 65 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 66 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 67 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 68 - "Color contrast utilities"
Cohesion: 0.40
Nodes (7): contrastingForeground(), contrastRatio(), isValidHexColor(), relativeLuminance(), WCAG_AA_TEXT_CONTRAST, GET(), prerender

### Community 69 - "E2E global setup"
Cohesion: 0.33
Nodes (6): globalSetup(), ADR-0002, ADR-0007, waitForHttp(), PREVIEW_PORT, STUB_PORT

### Community 70 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 71 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 72 - "Production compose file tests"
Cohesion: 0.25
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 73 - "Footer & static-page links"
Cohesion: 0.29
Nodes (7): [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE, StaticPageSummary

### Community 74 - "Recent-news (terkini) loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 75 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 76 - "GA4 opt-in init"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 77 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 78 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 79 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 80 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 81 - "Region-institution matching helpers"
Cohesion: 0.53
Nodes (6): ensureInstitutionsGeneric(), fetchRegionItems(), matchRegionCode(), namesMatchIgnoringSpaces(), resolveKaltengRegions(), resolveRegionCode()

### Community 82 - "Promo popup dialog"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 83 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 85 - "Bun version-pin test"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

## Knowledge Gaps
- **656 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+651 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Storefront build/test spawn helpers` to `Template init plan & rewrite`, `Knowledge-graph gate (audit:graf)`, `E2E global setup`, `Docs i18n mirror stamping`, `Social-meta build-smoke test`, `Root package.json manifest`, `audit:graf end-to-end tests`, `Release & changeset tooling`, `Docs audit gate (audit:dokumen)`, `Shared profile-route test harness`, `MySQL dump reader`, `Institution & redirect export CLI`?**
  _High betweenness centrality (0.198) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Template init plan & rewrite` to `Site build-profile config`, `CMS seed CLI`, `Astro profile route injection`, `Site identity & route registry`, `Shared profile-route test harness`?**
  _High betweenness centrality (0.138) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site identity & route registry` to `Storefront catalog domain model`, `News (berita) domain model`, `Site build-profile config`, `Customer session & wishlist sync`, `Region (Kalteng) navigation index`, `Shared profile-route test harness`, `Article view component`, `Article/video schema & breadcrumbs`, `Primary navigation per profile`, `Account reviews screen`, `Blog & ad-placement fetch helpers`, `Price formatting utilities`, `Sitemap sources & RSS feed`, `Account inbox (pesan) screen`, `Account order-history screen`, `Institution (mitra) directory`, `Legacy redirect map & video lookup`, `OG/social meta builder`, `Berita layout OG/search helpers`, `Registration (daftar) OTP screen`, `Footer & static-page links`?**
  _High betweenness centrality (0.114) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _656 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Storefront checkout & affiliate capture` be split into smaller, more focused modules?**
  _Cohesion score 0.052434456928838954 - nodes in this community are weakly interconnected._
- **Should `Dev server routing & Daerah panel` be split into smaller, more focused modules?**
  _Cohesion score 0.05719298245614035 - nodes in this community are weakly interconnected._
- **Should `Template init plan & rewrite` be split into smaller, more focused modules?**
  _Cohesion score 0.05997778600518327 - nodes in this community are weakly interconnected._