# Graph Report - .  (2026-10-26)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3297 nodes · 7815 edges · 131 communities (118 shown, 13 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 68 edges (avg confidence: 0.62)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2db2fa79`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Storefront cart and affiliate contracts
- Storefront build-id and stub lifecycle
- Storefront booking and reservations
- CMS seed CLI
- Storefront dev stub server (awcms API)
- News feed and rubric data
- Dev server routing & Daerah panel
- News navigation
- Design prototype support script
- Local CI process and port helpers
- Release & changeset tooling
- Site identity composition
- Storefront order client
- Marketing data client
- Account API client
- Site build-profile config
- First-party analytics beacon
- Article/video schema & breadcrumbs
- Release image build tooling
- Storefront theme and brand tokens
- Account session client and contract
- Commerce catalog wire types
- Site identity and AWCMS settings fallback
- Root package.json manifest
- Share-row (bagikan) tests
- BPS population pipeline
- Customer session & wishlist sync
- Local CI fork and git helpers
- BPS extract checks and metadata
- Shared profile-route test harness
- Institution and partner data
- Checkout region & courier lookups
- BPS table row fixtures
- Storefront package.json manifest
- Static page & portable text rendering
- Booking order form script
- BPS fetch and district selection
- E2E global setup
- Gate library and docs-translation audit
- Knowledge-graph gate (audit:graf)
- BPS archive and checksums
- Seed profile CLI
- Docs audit gate (audit:dokumen)
- BPS archive file layout
- BPS fetch client tests
- Seed-profile validation tests
- Terpopuler analytics client
- Booking availability search script
- Template init plan & rewrite
- Article view rendering
- Legacy seputarborneo importer
- Registration (daftar) OTP screen
- BPS region discovery
- Blog & ad-placement fetch helpers
- Account profile page
- Product breadcrumb structured data
- Docs i18n mirror stamping
- Local CI leg table
- Sitemap XML rendering
- Obsidian export tool
- Ad popup widget
- BPS extract test fixtures
- Listing search script
- Redirect import push tool
- Astro profile route injection
- Read-aloud (dengar) player
- getVideo
- Account address book
- Product listing filters & sort
- E2E accessibility and responsive specs
- Deploy preflight reporter tests
- BPS region extraction
- BPS cell and row parsing
- Price formatting utilities
- MySQL dump reader
- Account affiliate page
- Shared storefront components and helpers
- Legacy importer tests
- PWA web manifest
- Release publish tooling
- Deploy scenario test harness
- Root package manifest
- Lockfile consistency check
- Base tsconfig compiler options
- BPS table and region index
- Deploy shell common library
- Product detail variant pricing
- BPS district job planning
- CMS API fetch client
- Storefront tsconfig compiler options
- kontrak package manifest
- Subtree-write guard tests
- Polite HTTP client for BPS
- README screenshot renderer
- Gerbang test-scope check
- Obsidian export tool tests
- runExport
- No-prerender guard tests
- Production compose file tests
- BPS publication discovery
- Recent-news (terkini) loader
- Contract import-direction test
- Local CI Bun pin check
- Local CI lock handling
- GA4 opt-in init
- Social-meta build-smoke test
- Stale-phrase prose check
- Docs audit test suite
- packages/config manifest
- Gate report formatter
- packages/gerbang manifest
- Bun version-pin test
- Storefront Dockerfile security-update guard
- Root dependency overrides
- Kontrak tsconfig compiler options
- Env-example coverage test
- Graph-update tool (knowledge:graph:update)
- Template docs cleanup
- Lynx direction doc test
- Newsletter path-contract test
- Offsite backup copy script
- Workspace member globs
- Storefront no-service-worker guard test
- Postgres least-privilege role init
- Backup compose runner
- Production job-runner script
- Production deploy entrypoint
- Remote deploy trigger
- Production healthcheck
- Production rollback

## God Nodes (most connected - your core abstractions)
1. `bun` - 68 edges
2. `ROUTES` - 61 edges
3. `kirimPermintaan()` - 45 edges
4. `scripts` - 42 edges
5. `bacaSesi()` - 38 edges
6. `getSiteIdentity()` - 37 edges
7. `formatPrice()` - 37 edges
8. `authHeader()` - 29 edges
9. `denganPembersihanSesi()` - 29 edges
10. `buildWhatsappUrl()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `git()` --calls--> `gitRunOrThrow()`  [EXTRACTED]
  tools/rilis.mjs → packages/gerbang/lib/git.mjs
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json
- `startStub()` --indirect_call--> `chunk()`  [INFERRED]
  tools/ci/runners/template.ts → apps/storefront/src/lib/awcms/media.ts
- `ageByRegionColumns()` --indirect_call--> `region()`  [INFERRED]
  tools/bps-population/extract/tables.ts → apps/storefront/tests/wilayah-checkout.test.ts
- `updateCountdowns()` --indirect_call--> `row()`  [INFERRED]
  apps/storefront/src/scripts/akun-reservasi.ts → tests/import-seputarborneo.test.mjs

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (131 total, 13 thin omitted)

### Community 0 - "Storefront cart and affiliate contracts"
Cohesion: 0.05
Nodes (73): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+65 more)

### Community 1 - "Storefront build-id and stub lifecycle"
Cohesion: 0.03
Nodes (47): buildId, OUT_PATH, resolveBuildId(), ADR-0036, canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+39 more)

### Community 2 - "Storefront booking and reservations"
Cohesion: 0.06
Nodes (75): labelTombolBayar(), alasanTidakBisaBatal(), bandingkanUang(), BarisUang, BOOKING_AKTIF_KEY, buatPathDetailReservasi(), buatPathPesan(), catatanPembayaran() (+67 more)

### Community 3 - "CMS seed CLI"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 4 - "Storefront dev stub server (awcms API)"
Cohesion: 0.06
Nodes (67): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), bookingStub, buildAffiliateLink(), buildCourierOptions(), buildPaymentInstructions(), computeQuote() (+59 more)

### Community 5 - "News feed and rubric data"
Cohesion: 0.05
Nodes (62): RawTerm, AuthorArchive, BeritaFeedItem, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive (+54 more)

### Community 6 - "Dev server routing & Daerah panel"
Cohesion: 0.06
Nodes (63): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+55 more)

### Community 7 - "News navigation"
Cohesion: 0.06
Nodes (58): rubrikColumn, year, daerahActive, buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf(), getResolvableRegionsByCode() (+50 more)

### Community 8 - "Design prototype support script"
Cohesion: 0.07
Nodes (52): boot(), cdnScriptFor(), collectProps(), compileAttr(), compileTemplate(), contentKey(), createComponentFactory(), createExternalModules() (+44 more)

### Community 9 - "Local CI process and port helpers"
Cohesion: 0.08
Nodes (44): redactLine(), redactText(), valid, fakeBearerValue, fakeDsnPassword, fakeGithubToken, AuditException, auditIgnoreArgs() (+36 more)

### Community 10 - "Release & changeset tooling"
Cohesion: 0.06
Nodes (47): dated, oldest, pending, reporter, todayIso, changelogSection(), findChangelogHeadings(), normalizeLineEndings() (+39 more)

### Community 11 - "Site identity composition"
Cohesion: 0.09
Nodes (28): socialIcons, tokoAktif, [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE (+20 more)

### Community 12 - "Storefront order client"
Cohesion: 0.05
Nodes (52): ADR-0045, AkunPesananHalaman, KetersediaanMenginap, KuotaBooking, TawaranBooking, createPesananRenderer(), PesananRenderer, PesananRenderRefs (+44 more)

### Community 13 - "Marketing data client"
Cohesion: 0.06
Nodes (44): CSP_NEEDS, CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus (+36 more)

### Community 14 - "Account API client"
Cohesion: 0.10
Nodes (52): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilDetailReservasi(), ambilKomisiAfiliasi(), ambilKuotaPembatalan(), ambilPercakapan() (+44 more)

### Community 15 - "Site build-profile config"
Cohesion: 0.07
Nodes (43): activeRouteKeys(), CspNeeds, cspNeedsFor(), DEFAULT_SITE_PROFILE, describeProfile(), excludedRouteKeys(), FeedEntry, FEEDS (+35 more)

### Community 16 - "First-party analytics beacon"
Cohesion: 0.06
Nodes (31): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+23 more)

### Community 17 - "Article/video schema & breadcrumbs"
Cohesion: 0.07
Nodes (41): absoluteUrl(), ResolvedMedia, getRelatedPosts(), PostDetail, ADR-0109, BreadcrumbItem, breadcrumbListSchema(), combineSchemas() (+33 more)

### Community 18 - "Release image build tooling"
Cohesion: 0.12
Nodes (40): ADR-0020, gitRun(), cosignSign(), cosignVerify(), ensureBuilder(), fail(), headIsExactlyTag(), log() (+32 more)

### Community 19 - "Storefront theme and brand tokens"
Cohesion: 0.08
Nodes (34): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, chunk() (+26 more)

### Community 20 - "Account session client and contract"
Cohesion: 0.09
Nodes (39): UlasanAkun, Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun (+31 more)

### Community 21 - "Commerce catalog wire types"
Cohesion: 0.07
Nodes (35): assertNeverProductStatus(), buildCategoryTree(), buildProdukIndex(), CategoryNode, CommerceBundle, CommerceBundleComponent, CommercePage, CommerceProductImage (+27 more)

### Community 22 - "Site identity and AWCMS settings fallback"
Cohesion: 0.08
Nodes (30): SITEMAP_SOURCES, DEFAULT_IDENTITY, DefaultIdentity, siteUrl, awcmsGet(), baseUrl(), Envelope, timeoutMs() (+22 more)

### Community 23 - "Root package.json manifest"
Cohesion: 0.05
Nodes (42): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+34 more)

### Community 24 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 25 - "BPS population pipeline"
Cohesion: 0.10
Nodes (38): harness(), normaliseRemoteRoot(), ARCHIVE_SCRIPT, archiveStepArgv(), emptyPipelineState(), EXTRACT_SCRIPT, extractStepArgv(), formatLogLine() (+30 more)

### Community 26 - "Customer session & wishlist sync"
Cohesion: 0.14
Nodes (29): laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist(), saveWishlist() (+21 more)

### Community 27 - "Local CI fork and git helpers"
Cohesion: 0.14
Nodes (30): gitRunOrThrow(), main(), parseArgs(), main(), parseArgs(), hasRecordedResult(), listOpenPrs(), main() (+22 more)

### Community 28 - "BPS extract checks and metadata"
Cohesion: 0.11
Nodes (35): CheckReport, attributionSentence(), cacheDir(), coverageOfDomain(), DistrictRecord, findRecord(), FrontMatter, frontMatterText() (+27 more)

### Community 29 - "Shared profile-route test harness"
Cohesion: 0.13
Nodes (27): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, isSiteProfile() (+19 more)

### Community 30 - "Institution and partner data"
Cohesion: 0.09
Nodes (27): RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), chunk(), fetchMediaPublicOrigin() (+19 more)

### Community 31 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 32 - "BPS table row fixtures"
Cohesion: 0.21
Nodes (35): row(), ageBandKey(), clusterLines(), cx(), cy(), headerWords(), labelColumnCount(), nearestMarker() (+27 more)

### Community 33 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 34 - "Static page & portable text rendering"
Cohesion: 0.11
Nodes (32): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), documentHasPlayableVideo(), escapeHtml(), extractPlayableVideoInfo() (+24 more)

### Community 35 - "Booking order form script"
Cohesion: 0.16
Nodes (33): buatHoldAktif(), formatSisa(), parseHoldAktif(), pengumumanAmbang(), sidikPermintaan(), sisaDetik(), teksSisa(), backToSearchHref() (+25 more)

### Community 36 - "BPS fetch and district selection"
Cohesion: 0.14
Nodes (32): arg(), Ctx, districtJobs(), fmt(), main(), Office, provinceCodes(), provinceFull() (+24 more)

### Community 37 - "E2E global setup"
Cohesion: 0.09
Nodes (25): api(), browserPage(), confirmed(), day(), hold(), login(), noOverflow360(), open() (+17 more)

### Community 38 - "Gate library and docs-translation audit"
Cohesion: 0.14
Nodes (25): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+17 more)

### Community 39 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.11
Nodes (28): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+20 more)

### Community 40 - "BPS archive and checksums"
Cohesion: 0.10
Nodes (30): candidate(), deps(), ITEM, LOCAL, PDF_BYTES, SHA, classifyPdfLocation(), decideArchivePlacement() (+22 more)

### Community 41 - "Seed profile CLI"
Cohesion: 0.16
Nodes (25): ADR-0018, requiredRewriteTargets(), ALWAYS_REMOVE_DIRS, ALWAYS_REMOVE_FILES, BJEKMART_SEED_ASSET_FILES, OLD_LAYOUT_SEED_DATA_FILES, extractHeroBlock(), IDENTITY_DESCRIPTION_BY_PROFILE (+17 more)

### Community 42 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.15
Nodes (30): actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths(), auditOneIndex() (+22 more)

### Community 43 - "BPS archive file layout"
Cohesion: 0.08
Nodes (30): ARCHIVE_FILE_NAME, ArchiveDeps, ArchiveKind, archiveOne(), ArchiveOutcome, ArchivePlacement, ArchiveRecord, ArchiveScope (+22 more)

### Community 44 - "BPS fetch client tests"
Cohesion: 0.11
Nodes (24): acquire(), DOWNLOAD_CONCURRENCY, HELP, ClientOptions, DownloadResult, pdfPages(), sha256File(), StallError (+16 more)

### Community 45 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 46 - "Terpopuler analytics client"
Cohesion: 0.10
Nodes (17): toDatetimeAttr(), fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath() (+9 more)

### Community 47 - "Booking availability search script"
Cohesion: 0.15
Nodes (28): formatTanggalPendek(), labelZonaWaktu(), nomorHari(), parseParamCari(), periksaTanggal(), pesanGalatBooking(), tanggalLokal(), ambilKetersediaanBooking() (+20 more)

### Community 48 - "Template init plan & rewrite"
Cohesion: 0.16
Nodes (22): NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), applyPlan(), applyColorDefaults(), BOOLEAN_FLAGS, FLAG_KEYS, missingRequired(), parseArgs() (+14 more)

### Community 49 - "Article view rendering"
Cohesion: 0.13
Nodes (20): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+12 more)

### Community 50 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (26): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+18 more)

### Community 51 - "Registration (daftar) OTP screen"
Cohesion: 0.14
Nodes (22): mintaKode(), buildWhatsappCartMessage(), lineText(), ADR-0003, ADR-0007, clearFieldErrors(), hideSubmitError(), root (+14 more)

### Community 52 - "BPS region discovery"
Cohesion: 0.15
Nodes (21): main(), OUT, Probe, ROOT, WILAYAH, ChallengeError, coreName(), matchTitle() (+13 more)

### Community 53 - "Blog & ad-placement fetch helpers"
Cohesion: 0.14
Nodes (18): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllInstitutions() (+10 more)

### Community 54 - "Account profile page"
Cohesion: 0.13
Nodes (18): CartQuote, Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, ValidationErrorDetail, hideSubmitError(), initialsFor(), LEVEL_LABELS (+10 more)

### Community 55 - "Product breadcrumb structured data"
Cohesion: 0.14
Nodes (13): buildPriceTiers(), collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, CommerceProductVariant, getCategoryBySlug(), productsInCategory(), BreadcrumbItem (+5 more)

### Community 56 - "Docs i18n mirror stamping"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 57 - "Local CI leg table"
Cohesion: 0.16
Nodes (17): EXPECTED_CONTEXTS, findLeg(), LEG_CONTEXTS, LegDefinition, LegGroup, LEGS, legsInGroup(), ADR-0021 (+9 more)

### Community 58 - "Sitemap XML rendering"
Cohesion: 0.20
Nodes (17): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), registerSitemapSource(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests() (+9 more)

### Community 59 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 60 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 61 - "BPS extract test fixtures"
Cohesion: 0.18
Nodes (17): ctxOf(), fixture(), pageOf(), snakeCase(), absDiff(), CheckFailure, dedupe(), fmt() (+9 more)

### Community 62 - "Listing search script"
Cohesion: 0.19
Nodes (15): filterProdukIndex(), normalizeSearchTerm(), paginateProdukIndex(), ProdukIndexEntry, emptyState, grid, heading, paginationEl (+7 more)

### Community 63 - "Redirect import push tool"
Cohesion: 0.15
Nodes (18): chunkIdempotencyKey(), ChunkOutcome, chunkRedirects(), FileWideDuplicate, findFileWideDuplicates(), ImportErrorEnvelope, ImportItemReport, ImportPoster (+10 more)

### Community 64 - "Astro profile route injection"
Cohesion: 0.20
Nodes (14): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+6 more)

### Community 65 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 66 - "getVideo"
Cohesion: 0.16
Nodes (12): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET() (+4 more)

### Community 67 - "Account address book"
Cohesion: 0.26
Nodes (16): Alamat, AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate() (+8 more)

### Community 68 - "Product listing filters & sort"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 69 - "E2E accessibility and responsive specs"
Cohesion: 0.18
Nodes (11): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, firstSlug(), KEY_PAGES, KeyPage, keyPagesFor(), VIEWPORTS (+3 more)

### Community 70 - "Deploy preflight reporter tests"
Cohesion: 0.22
Nodes (14): createReporter(), checkDistForToken(), checkStorefrontEnvShape(), collectFiles(), isHttpsUrl(), loadEnv(), looksLikeToken(), main() (+6 more)

### Community 71 - "BPS region extraction"
Cohesion: 0.18
Nodes (16): index, buildIndex(), coreLabel(), kindFromGroupLine(), KindHint, NAME_ALIASES, normalizeLabel(), parentCode() (+8 more)

### Community 72 - "BPS cell and row parsing"
Cohesion: 0.18
Nodes (15): CellKind, indonesianPart(), isCellToken(), isIndexToken(), numeric(), parseCell(), ParsedCell, analysePage() (+7 more)

### Community 73 - "Price formatting utilities"
Cohesion: 0.23
Nodes (10): comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003, HARGA_FILE, SCANNABLE_EXTENSIONS (+2 more)

### Community 74 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 75 - "Account affiliate page"
Cohesion: 0.22
Nodes (14): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+6 more)

### Community 76 - "Shared storefront components and helpers"
Cohesion: 0.19
Nodes (6): detectInstallState(), INSTALL_HELP_PATH, InstallEnvironment, InstallState, isInstallHelpEnabled(), applyInstallState()

### Community 77 - "Legacy importer tests"
Cohesion: 0.28
Nodes (12): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+4 more)

### Community 78 - "PWA web manifest"
Cohesion: 0.23
Nodes (11): SITE_PROFILE, buildManifest(), ICON_PATHS, MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, ManifestInput, PROFILE_CATEGORIES (+3 more)

### Community 79 - "Release publish tooling"
Cohesion: 0.33
Nodes (10): gitRunInherit(), computeLatestFlag(), runCapture(), runCaptureOrThrow(), matchesOwnRelease(), fail(), log(), main() (+2 more)

### Community 80 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 81 - "Root package manifest"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 82 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 83 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 84 - "BPS table and region index"
Cohesion: 0.22
Nodes (12): RegionIndex, PageInfo, Ctx, Found, bboxWindow(), decodeEntities(), ENTITIES, loadPages() (+4 more)

### Community 85 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 86 - "Product detail variant pricing"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 87 - "BPS district job planning"
Cohesion: 0.23
Nodes (11): blankDistrict(), DistrictJob, districtPdfPath(), listFor(), listKecamatan(), DistrictMatch, districtPdfName(), DistrictRegion (+3 more)

### Community 88 - "CMS API fetch client"
Cohesion: 0.21
Nodes (10): collectPendingAssignments(), runAssignInstitutions(), termMapHintFor(), apiCall(), ApiResult, assertOk(), AwcmsApiError, resolveExistingTenantSession() (+2 more)

### Community 89 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 90 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 91 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 93 - "README screenshot renderer"
Cohesion: 0.28
Nodes (7): run, { values }, resolveSiteProfile(), SITE_PROFILES, buildAndServe(), globalSetup(), ADR-0002

### Community 94 - "Gerbang test-scope check"
Cohesion: 0.31
Nodes (4): canSpawnBun(), run(), runFollowUpGates(), testScopeArgs()

### Community 95 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 96 - "runExport"
Cohesion: 0.28
Nodes (9): buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), flag(), main(), runExport(), runPushRedirects(), usage(), formatPushSummary() (+1 more)

### Community 97 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 98 - "Production compose file tests"
Cohesion: 0.25
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 99 - "BPS publication discovery"
Cohesion: 0.25
Nodes (8): blank(), discoverActionId(), findPublication(), listPage(), pdfPath(), processOffice(), extractActionId(), findPublicationChunk()

### Community 100 - "Recent-news (terkini) loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 101 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 102 - "Local CI Bun pin check"
Cohesion: 0.52
Nodes (5): PKG, BunPinResult, checkBunPin(), enforceBunPinOrThrow(), readPinnedBunVersion()

### Community 103 - "Local CI lock handling"
Cohesion: 0.48
Nodes (5): acquireLock(), isProcessAlive(), Lock, readHolder(), tryCreate()

### Community 104 - "GA4 opt-in init"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 105 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 106 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 107 - "Docs audit test suite"
Cohesion: 0.33
Nodes (4): ADR-0042, cleanup, run(), SCRIPT

### Community 108 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 109 - "Gate report formatter"
Cohesion: 0.40
Nodes (3): formatReport(), SCRIPT_DIRS, scripts

### Community 110 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 111 - "Bun version-pin test"
Cohesion: 0.40
Nodes (4): ADR-0021, orchestrate, pkg, VERSION

### Community 112 - "Storefront Dockerfile security-update guard"
Cohesion: 0.40
Nodes (4): ADR-0049, dockerfile, DOCKERFILE_PATH, REPO_ROOT

### Community 113 - "Root dependency overrides"
Cohesion: 0.40
Nodes (5): overrides, sharp, shell-quote, smol-toml, source-map-js

### Community 114 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 116 - "Graph-update tool (knowledge:graph:update)"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 117 - "Template docs cleanup"
Cohesion: 0.50
Nodes (4): listMarkdownFiles(), planDocCitationCleanup(), SKIP_DIR_NAMES, SKIP_TOP_LEVEL

### Community 121 - "Workspace member globs"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **860 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+855 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Storefront build-id and stub lifecycle` to `Local CI process and port helpers`, `Release & changeset tooling`, `Release image build tooling`, `BPS population pipeline`, `Local CI fork and git helpers`, `BPS extract checks and metadata`, `Shared profile-route test harness`, `BPS archive and checksums`, `BPS fetch client tests`, `Deploy preflight reporter tests`, `MySQL dump reader`, `Release publish tooling`, `Deploy scenario test harness`, `Root package manifest`, `BPS table and region index`, `README screenshot renderer`, `Gerbang test-scope check`, `runExport`, `Social-meta build-smoke test`, `Docs audit test suite`, `Graph-update tool (knowledge:graph:update)`?**
  _High betweenness centrality (0.265) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site identity composition` to `Storefront booking and reservations`, `News feed and rubric data`, `News navigation`, `Storefront order client`, `Marketing data client`, `Site build-profile config`, `Article/video schema & breadcrumbs`, `Account session client and contract`, `Site identity and AWCMS settings fallback`, `Shared profile-route test harness`, `Institution and partner data`, `Terpopuler analytics client`, `Article view rendering`, `Registration (daftar) OTP screen`, `Blog & ad-placement fetch helpers`, `Product breadcrumb structured data`, `getVideo`, `E2E accessibility and responsive specs`, `Price formatting utilities`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Seed profile CLI` to `Astro profile route injection`, `CMS seed CLI`, `Site identity composition`, `Site build-profile config`, `Template init plan & rewrite`, `Shared profile-route test harness`, `Gerbang test-scope check`?**
  _High betweenness centrality (0.101) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _860 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Storefront cart and affiliate contracts` be split into smaller, more focused modules?**
  _Cohesion score 0.05299145299145299 - nodes in this community are weakly interconnected._
- **Should `Storefront build-id and stub lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.033707865168539325 - nodes in this community are weakly interconnected._
- **Should `Storefront booking and reservations` be split into smaller, more focused modules?**
  _Cohesion score 0.05600722673893405 - nodes in this community are weakly interconnected._