# Graph Report - .  (2026-11-02)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3668 nodes · 8788 edges · 162 communities (145 shown, 17 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 73 edges (avg confidence: 0.62)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6c2d4fc0`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Dependency freshness report tooling
- Storefront booking and reservations
- Storefront dev stub server (awcms API)
- Seed profile CLI
- News feed and rubric data
- Storefront order client
- Dev server routing & Daerah panel
- Account API client
- Design prototype support script
- Article/video schema & breadcrumbs
- E2E global setup
- Account contract and session storage keys
- Site identity composition
- Account session client and contract
- CMS seed CLI
- Commerce catalog wire types
- Push enrolment and sign-out flow
- News navigation
- Blog & ad-placement fetch helpers
- BPS archive file layout
- Site build-profile config
- Marketing data client
- Root package.json manifest
- Shared profile-route test harness
- Bun-only deployment manifest gate tests
- Share-row (bagikan) tests
- Institution and partner data
- Static page & portable text rendering
- BPS population pipeline
- Customer session & wishlist sync
- BPS extract checks and metadata
- Local CI process and port helpers
- First-party analytics beacon
- BPS table row fixtures
- Checkout region & courier lookups
- Release image build tooling
- Storefront package.json manifest
- Account affiliate page
- Product listing filters & sort
- Release & changeset tooling
- Push browser ports and platform detection
- BPS fetch and district selection
- Booking order form script
- Product breadcrumb structured data
- Storefront cart and affiliate contracts
- Local CI fork and git helpers
- Knowledge-graph gate (audit:graf)
- Docs audit gate (audit:dokumen)
- Gate library and docs-translation audit
- Customer push device and status contract
- BPS fetch client tests
- Seed-profile validation tests
- News rubrik pages and navigation helpers
- Storefront cart client and storage
- Storefront build-id and stub lifecycle
- Legacy seputarborneo importer
- Release file and git helpers
- CMS seed CLI API helpers
- Storefront theme and brand tokens
- BPS region discovery
- Toko origin and CSP configuration
- Docs i18n mirror stamping
- BPS archive and checksums
- Obsidian export tool
- Recent-news (terkini) loader
- Sitemap XML rendering
- Ad popup widget
- BPS cell and row parsing
- Astro profile route injection
- Order status rendering client
- E2E accessibility and responsive specs
- BPS extract test fixtures
- Local CI security baseline
- Release evidence and latest-flag tooling
- Redirect import push tool
- Checkout and popup e2e site config
- Affiliate code capture contract
- getVideo
- Account address book
- Terpopuler analytics client
- Read-aloud (dengar) player
- Deploy preflight reporter tests
- Local CI definition hash and state directory
- Analytics and graph build smoke tests
- MySQL dump reader
- Site theme extraction and API origin
- BPS region extraction
- Legacy importer tests
- Site identity and AWCMS settings fallback
- Shared storefront components and helpers
- Deploy scenario test harness
- Primary navigation resolution and search form
- Push browser port permissions and subscription
- PWA web manifest
- Root package manifest
- Lockfile consistency check
- Base tsconfig compiler options
- Deploy shell common library
- Product detail variant pricing
- Push guard and worker configuration
- Log redaction helpers
- BPS district job planning
- CMS API fetch client
- Push worker contract tests
- Storefront tsconfig compiler options
- kontrak package manifest
- Subtree-write guard tests
- Static page fetchers and cache
- Changeset date audit
- Polite HTTP client for BPS
- Price formatting utilities
- Push-only service worker click handling
- Obsidian export tool tests
- BPS table and region index
- runExport
- Push stub service for storefront builds
- No-prerender guard tests
- Production compose file tests
- Local CI audit exceptions parser
- BPS publication discovery
- Berita search page script
- Contract import-direction test
- Local CI Bun pin check
- Local CI lock handling
- Booking pages build smoke tests
- Social-meta build-smoke test
- Stale-phrase prose check
- Docs audit test suite
- packages/config manifest
- Gate report formatter
- packages/gerbang manifest
- Release audit tests
- Storefront Dockerfile security-update guard
- Kalteng region resolver for seed tools
- Account profile page
- Contact fallback null test
- Sidebar build smoke tests
- Root dependency overrides
- Kontrak tsconfig compiler options
- Env-example coverage test
- Graph-update tool (knowledge:graph:update)
- Build id writer script
- Service worker endpoint route
- Share button build smoke tests
- Listen page build smoke tests
- Institution logo build smoke tests
- Lynx direction doc test
- Bun version-pin test
- BPS extractor region index types
- Gateway build smoke tests
- Newsletter path-contract test
- Account message build smoke tests
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
1. `bun` - 70 edges
2. `ROUTES` - 62 edges
3. `kirimPermintaan()` - 51 edges
4. `bacaSesi()` - 48 edges
5. `scripts` - 43 edges
6. `getSiteIdentity()` - 38 edges
7. `formatPrice()` - 37 edges
8. `authHeader()` - 34 edges
9. `denganPembersihanSesi()` - 34 edges
10. `buildWhatsappUrl()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `git()` --calls--> `gitRunOrThrow()`  [EXTRACTED]
  tools/rilis.mjs → packages/gerbang/lib/git.mjs
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json
- `resolveBuildId()` --references--> `bun`  [EXTRACTED]
  apps/storefront/scripts/write-build-id.mjs → package.json
- `startStub()` --indirect_call--> `chunk()`  [INFERRED]
  tools/ci/runners/template.ts → apps/storefront/src/lib/awcms/media.ts
- `ageByRegionColumns()` --indirect_call--> `region()`  [INFERRED]
  tools/bps-population/extract/tables.ts → apps/storefront/tests/wilayah-checkout.test.ts

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (162 total, 17 thin omitted)

### Community 0 - "Dependency freshness report tooling"
Cohesion: 0.06
Nodes (81): fixture(), FIXTURES, HOLD, json(), argValue(), collectAdvisories(), collectBun(), collectImageRefs() (+73 more)

### Community 1 - "Storefront booking and reservations"
Cohesion: 0.06
Nodes (76): ADR-0045, HasilBayar, labelTombolBayar(), mulaiPembayaranGateway(), alasanTidakBisaBatal(), bandingkanUang(), BarisUang, BOOKING_AKTIF_KEY (+68 more)

### Community 2 - "Storefront dev stub server (awcms API)"
Cohesion: 0.05
Nodes (70): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), bookingStub, buildAffiliateLink(), buildCourierOptions(), buildPaymentInstructions(), computeQuote() (+62 more)

### Community 3 - "Seed profile CLI"
Cohesion: 0.06
Nodes (59): canSpawnBun(), ADR-0018, NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), ADR-0018, applyPlan(), describeChecklist(), POST_INIT_CHECKLIST (+51 more)

### Community 4 - "News feed and rubric data"
Cohesion: 0.05
Nodes (57): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+49 more)

### Community 5 - "Storefront order client"
Cohesion: 0.05
Nodes (62): formatTanggalPendek(), KetersediaanMenginap, KuotaBooking, labelZonaWaktu(), nomorHari(), parseParamCari(), periksaTanggal(), tanggalLokal() (+54 more)

### Community 6 - "Dev server routing & Daerah panel"
Cohesion: 0.06
Nodes (59): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+51 more)

### Community 7 - "Account API client"
Cohesion: 0.09
Nodes (60): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilDetailReservasi(), ambilKomisiAfiliasi(), ambilKuotaPembatalan(), ambilPercakapan() (+52 more)

### Community 8 - "Design prototype support script"
Cohesion: 0.07
Nodes (52): boot(), cdnScriptFor(), collectProps(), compileAttr(), compileTemplate(), contentKey(), createComponentFactory(), createExternalModules() (+44 more)

### Community 9 - "Article/video schema & breadcrumbs"
Cohesion: 0.06
Nodes (46): SITEMAP_SOURCES, absoluteUrl(), DefaultIdentity, siteUrl, BeritaFeedItem, escapeCdata(), escapeXml(), getPost() (+38 more)

### Community 10 - "E2E global setup"
Cohesion: 0.06
Nodes (46): api(), chooseAndEnable(), CORS(), enrolled(), enrolledOnAccount(), failRegistration(), installPushMock(), login() (+38 more)

### Community 11 - "Account contract and session storage keys"
Cohesion: 0.08
Nodes (45): Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun, ADR-0007 (+37 more)

### Community 12 - "Site identity composition"
Cohesion: 0.10
Nodes (24): ROUTES, DEFAULT_IDENTITY, getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), getSiteIdentity(), isExpectedRefusal() (+16 more)

### Community 13 - "Account session client and contract"
Cohesion: 0.08
Nodes (46): mintaKode(), OtpChannel, UlasanAkun, buildWhatsappAccountMessage(), buildWhatsappUrl(), appendConversationRows(), hideSubmitError(), loadDetail() (+38 more)

### Community 14 - "CMS seed CLI"
Cohesion: 0.05
Nodes (46): AdPlacementSeed, ApiResult, attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed, Cli, ensureTenantDomains(), errorCodeOf() (+38 more)

### Community 15 - "Commerce catalog wire types"
Cohesion: 0.07
Nodes (39): assertNeverProductStatus(), buildCategoryTree(), buildProdukIndex(), CategoryNode, CommerceBundle, CommerceBundleComponent, CommercePage, CommerceProductImage (+31 more)

### Community 16 - "Push enrolment and sign-out flow"
Cohesion: 0.07
Nodes (34): adalah401(), adalah404(), base64Url(), bersihkanLokalBilaPerlu(), cabutPerangkatLain(), DepsPush, HasilAktifkan, HasilKeluar (+26 more)

### Community 17 - "News navigation"
Cohesion: 0.08
Nodes (38): socialIcons, tokoAktif, rubrikColumn, year, daerahActive, buildRegionIndex(), findKaltengProvince(), getProvinces() (+30 more)

### Community 18 - "Blog & ad-placement fetch helpers"
Cohesion: 0.08
Nodes (34): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllInstitutions() (+26 more)

### Community 19 - "BPS archive file layout"
Cohesion: 0.07
Nodes (43): candidate(), deps(), ARCHIVE_FILE_NAME, ArchiveKind, ArchiveOutcome, ArchivePlacement, ArchiveRecord, ArchiveScope (+35 more)

### Community 20 - "Site build-profile config"
Cohesion: 0.07
Nodes (34): run, { values }, CspNeeds, DEFAULT_SITE_PROFILE, FeedEntry, FEEDS, FEEDS_ALL, FOOTER_PAGE_LINKS (+26 more)

### Community 21 - "Marketing data client"
Cohesion: 0.08
Nodes (38): CSP_NEEDS, getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry (+30 more)

### Community 22 - "Root package.json manifest"
Cohesion: 0.05
Nodes (43): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+35 more)

### Community 23 - "Shared profile-route test harness"
Cohesion: 0.11
Nodes (30): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, routePathPrefix() (+22 more)

### Community 24 - "Bun-only deployment manifest gate tests"
Cohesion: 0.08
Nodes (35): activeLines(), argDefaults(), COMPOSE_FILES, composeViolations(), countOf(), DOCKERFILES, dockerfileStageViolations(), dockerInstructions() (+27 more)

### Community 25 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 26 - "Institution and partner data"
Cohesion: 0.09
Nodes (30): chunk(), fetchMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests(), resolvedCache (+22 more)

### Community 27 - "Static page & portable text rendering"
Cohesion: 0.09
Nodes (37): listStaticPages(), toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), collectGalleryMediaObjectIds(), documentHasPlayableVideo() (+29 more)

### Community 28 - "BPS population pipeline"
Cohesion: 0.10
Nodes (38): harness(), normaliseRemoteRoot(), ARCHIVE_SCRIPT, archiveStepArgv(), emptyPipelineState(), EXTRACT_SCRIPT, extractStepArgv(), formatLogLine() (+30 more)

### Community 29 - "Customer session & wishlist sync"
Cohesion: 0.14
Nodes (29): laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist(), saveWishlist() (+21 more)

### Community 30 - "BPS extract checks and metadata"
Cohesion: 0.10
Nodes (37): attributionSentence(), cacheDir(), coverageOfDomain(), DistrictRecord, findRecord(), FrontMatter, frontMatterText(), loadDistrictRecords() (+29 more)

### Community 31 - "Local CI process and port helpers"
Cohesion: 0.14
Nodes (27): EXPECTED_CONTEXTS, findLeg(), LEG_CONTEXTS, LegDefinition, LegGroup, LEGS, legsInGroup(), run() (+19 more)

### Community 32 - "First-party analytics beacon"
Cohesion: 0.08
Nodes (21): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+13 more)

### Community 33 - "BPS table row fixtures"
Cohesion: 0.21
Nodes (36): row(), ageBandKey(), snakeCase(), cx(), headerWords(), labelColumnCount(), nearestMarker(), ageByRegionColumns() (+28 more)

### Community 34 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 35 - "Release image build tooling"
Cohesion: 0.15
Nodes (31): ADR-0020, gitRun(), cosignSign(), cosignVerify(), ensureBuilder(), fail(), headIsExactlyTag(), log() (+23 more)

### Community 36 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 37 - "Account affiliate page"
Cohesion: 0.11
Nodes (32): AfiliasiKomisiHalaman, formatPrice(), Cart, CartLineRequest, quoteCart(), QuoteLine, buildWhatsappCartMessage(), lineText() (+24 more)

### Community 38 - "Product listing filters & sort"
Cohesion: 0.10
Nodes (30): labelClassName(), paginateProdukIndex(), ProductSort, ProdukIndexEntry, ProdukIndexFilter, emptyState, grid, heading (+22 more)

### Community 39 - "Release & changeset tooling"
Cohesion: 0.11
Nodes (31): CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), parseChangeset(), validateChangeset(), atLeastAsSignificant(), BUMP_LEVELS, bumpVersion() (+23 more)

### Community 40 - "Push browser ports and platform detection"
Cohesion: 0.14
Nodes (32): ambilPemberitahuan(), buatPortPenanda(), buatPortPeramban(), pushDidukungPeramban(), deteksiPlatform(), GalatPush, KeadaanPush, perangkatIni() (+24 more)

### Community 41 - "BPS fetch and district selection"
Cohesion: 0.14
Nodes (32): arg(), Ctx, districtJobs(), fmt(), main(), Office, provinceCodes(), provinceFull() (+24 more)

### Community 42 - "Booking order form script"
Cohesion: 0.16
Nodes (32): buatHoldAktif(), formatSisa(), parseHoldAktif(), pengumumanAmbang(), sidikPermintaan(), teksSisa(), backToSearchHref(), focusHeading() (+24 more)

### Community 43 - "Product breadcrumb structured data"
Cohesion: 0.11
Nodes (17): buildPriceTiers(), collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, CommerceProductVariant, getCategoryBySlug(), primaryProductImage(), productsInCategory() (+9 more)

### Community 44 - "Storefront cart and affiliate contracts"
Cohesion: 0.14
Nodes (26): bacaPoinInput(), bolehPakaiPoin(), parsePoinAkun(), perkiraanDiskonPoin(), pesanKesalahanPoin(), PoinAkun, keepDigitsAndLeadingPlus(), previewIndonesianPhone() (+18 more)

### Community 45 - "Local CI fork and git helpers"
Cohesion: 0.15
Nodes (24): ADR-0021, gitRunOrThrow(), main(), parseArgs(), main(), parseArgs(), enforceForkPolicyOrThrow(), fetchPullRequestInfo() (+16 more)

### Community 46 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.11
Nodes (28): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+20 more)

### Community 47 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.15
Nodes (30): actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths(), auditOneIndex() (+22 more)

### Community 48 - "Gate library and docs-translation audit"
Cohesion: 0.15
Nodes (24): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+16 more)

### Community 49 - "Customer push device and status contract"
Cohesion: 0.14
Nodes (27): DeskripsiTujuan, HasilMuat, iosMendukungPush(), isPushPurpose(), isRecord(), kunciSama(), kunciServerKeBytes(), LingkunganPush (+19 more)

### Community 50 - "BPS fetch client tests"
Cohesion: 0.11
Nodes (24): acquire(), DOWNLOAD_CONCURRENCY, HELP, ClientOptions, DownloadResult, pdfPages(), sha256File(), StallError (+16 more)

### Community 51 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 52 - "News rubrik pages and navigation helpers"
Cohesion: 0.12
Nodes (25): RawTerm, collectAncestors(), collectDescendantSlugs(), estimasiWaktuBacaMenit(), flattenRubrikTree(), getRubrik(), getRubrikTree(), paginate() (+17 more)

### Community 53 - "Storefront cart client and storage"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 54 - "Storefront build-id and stub lifecycle"
Cohesion: 0.10
Nodes (14): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+6 more)

### Community 55 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (26): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+18 more)

### Community 56 - "Release file and git helpers"
Cohesion: 0.14
Nodes (18): ADR-0023, changelogSection(), findChangelogHeadings(), normalizeLineEndings(), normalizeRequestedVersion(), readFileIfPresent(), gitRunInherit(), run() (+10 more)

### Community 57 - "CMS seed CLI API helpers"
Cohesion: 0.22
Nodes (26): apiCall(), applySiteProfile(), assertOk(), ensureAdPlacements(), ensureBlogPages(), ensureBlogPosts(), ensureBlogTerms(), ensureCategories() (+18 more)

### Community 58 - "Storefront theme and brand tokens"
Cohesion: 0.14
Nodes (18): chunk(), crc32(), CRC_TABLE, encodePng(), GLYPHS, hexToRgb(), iconInitial(), IconSpec (+10 more)

### Community 59 - "BPS region discovery"
Cohesion: 0.15
Nodes (21): main(), OUT, Probe, ROOT, WILAYAH, ChallengeError, coreName(), matchTitle() (+13 more)

### Community 60 - "Toko origin and CSP configuration"
Cohesion: 0.14
Nodes (15): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, buildCspOriginsArtifact(), collectOrigins(), CspOriginsArtifact, originOf(), ADR-0002 (+7 more)

### Community 61 - "Docs i18n mirror stamping"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 62 - "BPS archive and checksums"
Cohesion: 0.12
Nodes (21): ITEM, LOCAL, NO_REGIONS, PDF_BYTES, SHA, ArchiveDeps, archiveOne(), compareVerification() (+13 more)

### Community 63 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 64 - "Recent-news (terkini) loader"
Cohesion: 0.13
Nodes (11): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost, formatRemaining(), tick(), dialog (+3 more)

### Community 65 - "Sitemap XML rendering"
Cohesion: 0.22
Nodes (16): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests(), resetSitemapSourcesForTests() (+8 more)

### Community 66 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 67 - "BPS cell and row parsing"
Cohesion: 0.19
Nodes (18): CellKind, indonesianPart(), isCellToken(), isIndexToken(), numeric(), parseCell(), ParsedCell, analysePage() (+10 more)

### Community 68 - "Astro profile route injection"
Cohesion: 0.19
Nodes (15): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), ADR-0018, PAGE_EXTENSIONS (+7 more)

### Community 69 - "Order status rendering client"
Cohesion: 0.17
Nodes (17): AkunPesananHalaman, PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, Order, OrderStatus, appendOrderRows() (+9 more)

### Community 70 - "E2E accessibility and responsive specs"
Cohesion: 0.13
Nodes (11): gtag(), initGa(), Window, FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, KEY_PAGES, VIEWPORTS (+3 more)

### Community 71 - "BPS extract test fixtures"
Cohesion: 0.19
Nodes (16): ctxOf(), fixture(), pageOf(), absDiff(), CheckFailure, CheckReport, dedupe(), fmt() (+8 more)

### Community 72 - "Local CI security baseline"
Cohesion: 0.21
Nodes (14): BaselineEntry, isBaselined(), parseBaseline(), partitionHighSeverityFindings(), SecurityFinding, CODEQL_CLI_SHA256, CODEQL_CLI_VERSION, codeqlCacheDir() (+6 more)

### Community 73 - "Release evidence and latest-flag tooling"
Cohesion: 0.25
Nodes (13): buildEvidence(), validateEvidence(), computeLatestFlag(), checkPublishPreconditions(), deriveImageTags(), highestTag(), imageRepository(), isValidTag() (+5 more)

### Community 74 - "Redirect import push tool"
Cohesion: 0.15
Nodes (18): chunkIdempotencyKey(), ChunkOutcome, chunkRedirects(), FileWideDuplicate, findFileWideDuplicates(), ImportErrorEnvelope, ImportItemReport, ImportPoster (+10 more)

### Community 75 - "Checkout and popup e2e site config"
Cohesion: 0.15
Nodes (16): [], channelCandidates, footerLinks, publishedSlugs, year, activeRouteKeys(), cspNeedsFor(), describeProfile() (+8 more)

### Community 76 - "Affiliate code capture contract"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 77 - "getVideo"
Cohesion: 0.16
Nodes (13): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET() (+5 more)

### Community 78 - "Account address book"
Cohesion: 0.26
Nodes (16): Alamat, AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate() (+8 more)

### Community 79 - "Terpopuler analytics client"
Cohesion: 0.20
Nodes (11): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+3 more)

### Community 80 - "Read-aloud (dengar) player"
Cohesion: 0.21
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 81 - "Deploy preflight reporter tests"
Cohesion: 0.22
Nodes (14): createReporter(), checkDistForToken(), checkStorefrontEnvShape(), collectFiles(), isHttpsUrl(), loadEnv(), looksLikeToken(), main() (+6 more)

### Community 82 - "Local CI definition hash and state directory"
Cohesion: 0.29
Nodes (13): hasRecordedResult(), listOpenPrs(), main(), OpenPr, recordResult(), ghApiJson(), ciDefinitionHash(), listFilesRecursive() (+5 more)

### Community 83 - "Analytics and graph build smoke tests"
Cohesion: 0.14
Nodes (8): canSpawnBun(), runBuild(), canSpawnBun(), bun, cleanup, fixture(), run(), SCRIPT

### Community 84 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 85 - "Site theme extraction and API origin"
Cohesion: 0.20
Nodes (11): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, GET() (+3 more)

### Community 86 - "BPS region extraction"
Cohesion: 0.19
Nodes (14): index, buildIndex(), coreLabel(), kindFromGroupLine(), KindHint, NAME_ALIASES, normalizeLabel(), parentCode() (+6 more)

### Community 87 - "Legacy importer tests"
Cohesion: 0.28
Nodes (12): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+4 more)

### Community 88 - "Site identity and AWCMS settings fallback"
Cohesion: 0.29
Nodes (9): awcmsGet(), baseUrl(), Envelope, timeoutMs(), EnvSource, readEnv(), readEnvOr(), isValidGaMeasurementId() (+1 more)

### Community 89 - "Shared storefront components and helpers"
Cohesion: 0.20
Nodes (5): detectInstallState(), InstallEnvironment, InstallState, isInstallHelpEnabled(), applyInstallState()

### Community 90 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 91 - "Primary navigation resolution and search form"
Cohesion: 0.22
Nodes (9): NavItem, PROFILE_NAV, PROFILE_NAV_DYNAMIC, SEARCH_SURFACE, SITE_PROFILE, getPrimaryNav(), insertAfter(), ResolvedNavItem (+1 more)

### Community 92 - "Push browser port permissions and subscription"
Cohesion: 0.22
Nodes (6): aktifkanPerangkat(), PortPeramban, lamaTunggu(), petakanGalat(), petakanGalatPeramban(), ambilHasil()

### Community 93 - "PWA web manifest"
Cohesion: 0.26
Nodes (10): buildManifest(), ICON_PATHS, MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, ManifestInput, PROFILE_CATEGORIES, shortNameFor() (+2 more)

### Community 94 - "Root package manifest"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 95 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 96 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 97 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 98 - "Product detail variant pricing"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 99 - "Push guard and worker configuration"
Cohesion: 0.23
Nodes (9): adaPenanda(), jagaPenandaPush(), isCustomerPushEnabled(), PUSH_WORKER_PATH, PUSH_WORKER_SCOPE, ADR-0048, ADR-0049, PUSH_MARKER_KEY (+1 more)

### Community 100 - "Log redaction helpers"
Cohesion: 0.32
Nodes (7): redactLine(), redactText(), fakeBearerValue, fakeDsnPassword, fakeGithubToken, redact(), main()

### Community 101 - "BPS district job planning"
Cohesion: 0.23
Nodes (11): blankDistrict(), DistrictJob, districtPdfPath(), listFor(), listKecamatan(), DistrictMatch, districtPdfName(), DistrictRegion (+3 more)

### Community 102 - "CMS API fetch client"
Cohesion: 0.21
Nodes (10): collectPendingAssignments(), runAssignInstitutions(), termMapHintFor(), apiCall(), ApiResult, assertOk(), AwcmsApiError, resolveExistingTenantSession() (+2 more)

### Community 103 - "Push worker contract tests"
Cohesion: 0.18
Nodes (8): PUSH_PURPOSES, PUSH_TARGET_PATHS, FakeClient, Harness, Listener, Shown, SOURCE, ADR-0048

### Community 104 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 105 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 106 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 107 - "Static page fetchers and cache"
Cohesion: 0.27
Nodes (8): detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), StaticPageDetail, StaticPageSummary, ADR-0100

### Community 108 - "Changeset date audit"
Cohesion: 0.20
Nodes (6): dated, oldest, pending, reporter, todayIso, isChangesetFile()

### Community 110 - "Price formatting utilities"
Cohesion: 0.31
Nodes (8): filterProdukIndex(), normalizeSearchTerm(), comparePrices(), priceToNumber(), HARGA_FILE, SCANNABLE_EXTENSIONS, SRC_ROOT, walk()

### Community 111 - "Push-only service worker click handling"
Cohesion: 0.33
Nodes (6): isRecord(), ADR-0048, normalizePayload(), resolveTarget(), tagOf(), text()

### Community 112 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 113 - "BPS table and region index"
Cohesion: 0.36
Nodes (8): bboxWindow(), decodeEntities(), ENTITIES, loadPages(), median(), parseBboxPages(), pdfPageCount(), Word

### Community 114 - "runExport"
Cohesion: 0.28
Nodes (9): buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), flag(), main(), runExport(), runPushRedirects(), usage(), formatPushSummary() (+1 more)

### Community 115 - "Push stub service for storefront builds"
Cohesion: 0.29
Nodes (7): APPLICATION_SERVER_KEY, CONSENT_TEXT_VERSION, createPushStub(), maskEndpoint(), ADR-0048, PURPOSES, PUSH_HOSTS

### Community 116 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 117 - "Production compose file tests"
Cohesion: 0.25
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 118 - "Local CI audit exceptions parser"
Cohesion: 0.46
Nodes (6): valid, AuditException, auditIgnoreArgs(), loadAuditIgnoreArgs(), parseAuditExceptions(), runBunAuditWithExceptions()

### Community 119 - "BPS publication discovery"
Cohesion: 0.25
Nodes (8): blank(), discoverActionId(), findPublication(), listPage(), pdfPath(), processOffice(), extractActionId(), findPublicationChunk()

### Community 120 - "Berita search page script"
Cohesion: 0.29
Nodes (5): input, matches, needle, resultsList, status

### Community 121 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 122 - "Local CI Bun pin check"
Cohesion: 0.52
Nodes (5): PKG, BunPinResult, checkBunPin(), enforceBunPinOrThrow(), readPinnedBunVersion()

### Community 123 - "Local CI lock handling"
Cohesion: 0.48
Nodes (5): acquireLock(), isProcessAlive(), Lock, readHolder(), tryCreate()

### Community 124 - "Booking pages build smoke tests"
Cohesion: 0.33
Nodes (3): canSpawnBun(), PAGE_SOURCES, PAGES

### Community 125 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 126 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 127 - "Docs audit test suite"
Cohesion: 0.33
Nodes (4): ADR-0042, cleanup, run(), SCRIPT

### Community 128 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 129 - "Gate report formatter"
Cohesion: 0.40
Nodes (3): formatReport(), SCRIPT_DIRS, scripts

### Community 130 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 131 - "Release audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 132 - "Storefront Dockerfile security-update guard"
Cohesion: 0.33
Nodes (5): dockerfile, DOCKERFILE_PATH, ADR-0048, ADR-0049, REPO_ROOT

### Community 133 - "Kalteng region resolver for seed tools"
Cohesion: 0.53
Nodes (6): ensureInstitutionsGeneric(), fetchRegionItems(), matchRegionCode(), namesMatchIgnoringSpaces(), resolveKaltengRegions(), resolveRegionCode()

### Community 135 - "Contact fallback null test"
Cohesion: 0.40
Nodes (3): canSpawnBun(), FIXTURE_PATH, SITE_TS_PATH

### Community 137 - "Root dependency overrides"
Cohesion: 0.40
Nodes (5): overrides, sharp, shell-quote, smol-toml, source-map-js

### Community 138 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 140 - "Graph-update tool (knowledge:graph:update)"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 141 - "Build id writer script"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 143 - "Share button build smoke tests"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 144 - "Listen page build smoke tests"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 145 - "Institution logo build smoke tests"
Cohesion: 0.50
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 147 - "Bun version-pin test"
Cohesion: 0.50
Nodes (3): orchestrate, pkg, VERSION

### Community 148 - "BPS extractor region index types"
Cohesion: 0.50
Nodes (4): RegionIndex, PageInfo, Ctx, Found

### Community 153 - "Workspace member globs"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **944 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+939 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `bun` to `lib/deps-freshness.ts`, `audit-rilis.test.mjs`, `plan.mjs`, `kontak-fallback-null.test.ts`, `sidebar-build-smoke.test.ts`, `akun-notifikasi.e2e.ts`, `knowledge-graph-update.mjs`, `write-build-id.mjs`, `bagikan-build-smoke.test.ts`, `dengar-build-smoke.test.ts`, `logo-instansi-build-smoke.test.ts`, `archive.ts`, `gateway-build-smoke.test.ts`, `profil-uji-bersama.ts`, `pesan-build-smoke.test.ts`, `pipeline.ts`, `run.ts`, `orchestrate.ts`, `images.ts`, `git.mjs`, `bps-population-fetch.test.mjs`, `stub-lifecycle.ts`, `publish.ts`, `security.ts`, `deploy-preflight.mjs`, `ci-watch.ts`, `mysql-dump-reader.ts`, `deploy-production.test.mjs`, `package.json`, `words.ts`, `runExport`, `audit-exceptions.ts`, `booking-build-smoke.test.ts`, `meta-sosial-build-smoke.test.ts`, `audit-dokumen.test.mjs`?**
  _High betweenness centrality (0.275) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `routes.ts` to `toko/Beranda.astro`, `booking-kontrak.ts`, `berita.ts`, `akun-pesanan.ts`, `video/[slug].astro`, `isGroupActive`, `product/[slug].astro`, `getVideo`, `bacaSesi`, `masuk.ts`, `navigasi-berita.ts`, `blog.ts`, `config/profil.ts`, `[slug]/feed.xml.ts`, `profil-uji-bersama.ts`, `berita/pages/cari-berita.astro`, `BeritaLayout.astro`, `navigasi-profil.ts`?**
  _High betweenness centrality (0.098) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `plan.mjs` to `profil.mjs`, `routes.ts`, `seed-cms.ts`, `config/profil.ts`, `profil-uji-bersama.ts`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _944 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `lib/deps-freshness.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.060784313725490195 - nodes in this community are weakly interconnected._
- **Should `booking-kontrak.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05823293172690763 - nodes in this community are weakly interconnected._
- **Should `stub-awcms.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.0519311911716975 - nodes in this community are weakly interconnected._