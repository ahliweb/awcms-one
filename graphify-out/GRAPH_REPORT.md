# Graph Report - .  (2026-11-11)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3630 nodes · 8820 edges · 150 communities (138 shown, 12 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 71 edges (avg confidence: 0.62)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `cd8bf08e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Dependency freshness report tooling
- CMS seed CLI
- Storefront booking and reservations
- Local CI fork and git helpers
- Storefront dev stub server (awcms API)
- Seed profile CLI
- News feed, rubric and pagination
- Storefront build-id and stub lifecycle
- Account API client
- Site identity composition
- Storefront cart and affiliate contracts
- Account contract and session storage keys
- E2E global setup
- WhatsApp fallback and account status labels
- News navigation
- Marketing data client
- Account session client and contract
- Customer session & wishlist sync
- Site build-profile config
- Shared profile-route test harness
- Article/video schema & breadcrumbs
- Storefront cart client and storage
- Release & changeset tooling
- BPS archive file layout
- Commerce catalog wire types
- Root package.json manifest
- Share-row (bagikan) tests
- BPS population pipeline
- BPS extract checks and metadata
- News feed and rubric data
- Checkout region & courier lookups
- Booking order form script
- Product listing filters & sort
- Storefront package.json manifest
- Dev server routing & Daerah panel
- Single-flight guard and account messages
- Static page & portable text rendering
- BPS table row fixtures
- Gate library and docs-translation audit
- BPS fetch and district selection
- Order status rendering client
- Release image build tooling
- Bun-only deployment manifest gate tests
- Region and institution lookups
- Push browser ports and platform detection
- Knowledge-graph gate (audit:graf)
- Environment access and static page fetch
- Customer push device and status contract
- Docs audit gate (audit:dokumen)
- Push guard and worker configuration
- Push enrolment and sign-out flow
- BPS fetch client tests
- Seed-profile validation tests
- News URL redirect rules
- Legacy seputarborneo importer
- Shared storefront components and helpers
- BPS region discovery
- Local CI process and port helpers
- Push notification stub and consent
- Blog & ad-placement fetch helpers
- Product breadcrumb structured data
- Docs i18n mirror stamping
- BPS archive and checksums
- Price formatting and flash-sale countdown
- First-party analytics beacon
- Sitemap XML rendering
- Obsidian export tool
- BPS extract test fixtures
- Ad popup widget
- BPS cell and row parsing
- Local CI security baseline
- Redirect import push tool
- Astro profile route injection
- Read-aloud (dengar) player
- Checkout and popup e2e site config
- Affiliate code capture contract
- getVideo
- CSP media origins and GA wiring
- Account address book
- Terpopuler analytics client
- Newsletter form tests
- E2E accessibility and responsive specs
- Deploy preflight reporter tests
- Release evidence and latest-flag tooling
- Toko origin and CSP configuration
- Release file and git helpers
- MySQL dump reader
- BPS region extraction
- Legacy importer tests
- PWA web manifest
- Storefront theme and brand tokens
- Deploy scenario test harness
- Root package manifest
- Lockfile consistency check
- Base tsconfig compiler options
- Deploy shell common library
- Site theme extraction and API origin
- Product detail variant pricing
- Release publish and process helpers
- Log redaction helpers
- BPS district job planning
- CMS API fetch client
- Build id writer script
- Push browser port permissions and subscription
- PWA site icon rendering
- Storefront tsconfig compiler options
- kontrak package manifest
- Production compose file tests
- Subtree-write guard tests
- Push worker contract tests
- Theme colour contrast helpers
- Polite HTTP client for BPS
- Single-flight contract test
- Obsidian export tool tests
- BPS table and region index
- runExport
- Push-only service worker click handling
- No-prerender guard tests
- Local CI audit exceptions parser
- BPS publication discovery
- Recent-news (terkini) loader
- Contract import-direction test
- Site identity and AWCMS settings fallback
- GA init script
- Booking pages build smoke tests
- Social-meta build-smoke test
- Stale-phrase prose check
- packages/config manifest
- Gate report formatter
- packages/gerbang manifest
- Docs audit test suite
- Release audit tests
- Promo popup script
- Root dependency overrides
- Kontrak tsconfig compiler options
- Env-example coverage test
- Graph-update tool (knowledge:graph:update)
- Lynx direction doc test
- Production job-runner script
- BPS extractor region index types
- README screenshots script
- Offsite backup copy script
- Workspace member globs
- Postgres least-privilege role init
- Backup compose runner
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
- `resolveBuildId()` --references--> `bun`  [EXTRACTED]
  apps/storefront/scripts/write-build-id.mjs → package.json
- `startStub()` --indirect_call--> `chunk()`  [INFERRED]
  tools/ci/runners/template.ts → apps/storefront/src/lib/awcms/media.ts
- `ageByRegionColumns()` --indirect_call--> `region()`  [INFERRED]
  tools/bps-population/extract/tables.ts → apps/storefront/tests/wilayah-checkout.test.ts
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json
- `updateCountdowns()` --indirect_call--> `row()`  [INFERRED]
  apps/storefront/src/scripts/akun-reservasi.ts → tests/import-seputarborneo.test.mjs

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (150 total, 12 thin omitted)

### Community 0 - "Dependency freshness report tooling"
Cohesion: 0.06
Nodes (81): fixture(), FIXTURES, HOLD, json(), argValue(), collectAdvisories(), collectBun(), collectImageRefs() (+73 more)

### Community 1 - "CMS seed CLI"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 2 - "Storefront booking and reservations"
Cohesion: 0.06
Nodes (72): ADR-0045, HasilBayar, labelTombolBayar(), mulaiPembayaranGateway(), alasanTidakBisaBatal(), bandingkanUang(), BarisUang, BOOKING_AKTIF_KEY (+64 more)

### Community 3 - "Local CI fork and git helpers"
Cohesion: 0.06
Nodes (60): ADR-0021, PKG, EXPECTED_CONTEXTS, WORKFLOWS_DIR, orchestrate, pkg, VERSION, main() (+52 more)

### Community 4 - "Storefront dev stub server (awcms API)"
Cohesion: 0.05
Nodes (68): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), bookingStub, buildAffiliateLink(), buildCourierOptions(), buildPaymentInstructions(), computeQuote() (+60 more)

### Community 5 - "Seed profile CLI"
Cohesion: 0.06
Nodes (57): ADR-0018, canSpawnBun(), NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), applyPlan(), describeChecklist(), POST_INIT_CHECKLIST, applyColorDefaults() (+49 more)

### Community 6 - "News feed, rubric and pagination"
Cohesion: 0.05
Nodes (59): RawTerm, AuthorArchive, BeritaFeedItem, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive (+51 more)

### Community 7 - "Storefront build-id and stub lifecycle"
Cohesion: 0.05
Nodes (34): ADR-0036, canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), runBuild(), ARTICLE_PAGE, canSpawnBun() (+26 more)

### Community 8 - "Account API client"
Cohesion: 0.09
Nodes (57): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilDetailReservasi(), ambilKomisiAfiliasi(), ambilKuotaPembatalan(), ambilPercakapan() (+49 more)

### Community 9 - "Site identity composition"
Cohesion: 0.08
Nodes (29): socialIcons, tokoAktif, ROUTES, DEFAULT_IDENTITY, getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity() (+21 more)

### Community 10 - "Storefront cart and affiliate contracts"
Cohesion: 0.06
Nodes (53): ADR-0043, KetersediaanMenginap, KuotaBooking, TawaranBooking, bacaPoinInput(), bolehPakaiPoin(), parsePoinAkun(), perkiraanDiskonPoin() (+45 more)

### Community 11 - "Account contract and session storage keys"
Cohesion: 0.08
Nodes (48): simpanWishlistAkun(), Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun (+40 more)

### Community 12 - "E2E global setup"
Cohesion: 0.06
Nodes (45): api(), chooseAndEnable(), CORS(), enrolled(), enrolledOnAccount(), failRegistration(), installPushMock(), login() (+37 more)

### Community 13 - "WhatsApp fallback and account status labels"
Cohesion: 0.08
Nodes (49): AfiliasiKomisiHalaman, UlasanAkun, labelZonaWaktu(), parseParamCari(), periksaTanggal(), pesanGalatBooking(), tanggalLokal(), ambilKetersediaanBooking() (+41 more)

### Community 14 - "News navigation"
Cohesion: 0.07
Nodes (40): daerahActive, flattenRubrikTree(), getRubrikTree(), paginate(), RegionRef, RubrikNode, branchOrder(), DAERAH_PANEL_ID (+32 more)

### Community 15 - "Marketing data client"
Cohesion: 0.07
Nodes (38): CSP_NEEDS, getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry (+30 more)

### Community 16 - "Account session client and contract"
Cohesion: 0.08
Nodes (37): mintaKode(), OtpChannel, buatKunciBaru(), buatPengelolaKunci(), galatKonflikKunci(), jawabanFinal(), KODE_KONFLIK_KUNCI, kunciValid() (+29 more)

### Community 17 - "Customer session & wishlist sync"
Cohesion: 0.10
Nodes (36): chunk(), fetchMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests(), resolvedCache (+28 more)

### Community 18 - "Site build-profile config"
Cohesion: 0.07
Nodes (35): CspNeeds, DEFAULT_SITE_PROFILE, FeedEntry, FEEDS, FEEDS_ALL, FOOTER_PAGE_LINKS, FooterPageLink, GROUP_STYLESHEET_HREFS (+27 more)

### Community 19 - "Shared profile-route test harness"
Cohesion: 0.11
Nodes (32): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, isSiteProfile() (+24 more)

### Community 20 - "Article/video schema & breadcrumbs"
Cohesion: 0.09
Nodes (35): absoluteUrl(), ResolvedMedia, PostDetail, ADR-0109, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema() (+27 more)

### Community 21 - "Storefront cart client and storage"
Cohesion: 0.11
Nodes (36): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+28 more)

### Community 22 - "Release & changeset tooling"
Cohesion: 0.08
Nodes (36): dated, oldest, pending, reporter, todayIso, CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody() (+28 more)

### Community 23 - "BPS archive file layout"
Cohesion: 0.07
Nodes (43): candidate(), deps(), ARCHIVE_FILE_NAME, ArchiveKind, ArchiveOutcome, ArchivePlacement, ArchiveRecord, ArchiveScope (+35 more)

### Community 24 - "Commerce catalog wire types"
Cohesion: 0.07
Nodes (34): assertNeverProductStatus(), buildCategoryTree(), buildProdukIndex(), CategoryNode, CommerceBundle, CommerceBundleComponent, CommercePage, CommerceProductImage (+26 more)

### Community 25 - "Root package.json manifest"
Cohesion: 0.05
Nodes (43): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+35 more)

### Community 26 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 27 - "BPS population pipeline"
Cohesion: 0.10
Nodes (38): harness(), normaliseRemoteRoot(), ARCHIVE_SCRIPT, archiveStepArgv(), emptyPipelineState(), EXTRACT_SCRIPT, extractStepArgv(), formatLogLine() (+30 more)

### Community 28 - "BPS extract checks and metadata"
Cohesion: 0.10
Nodes (38): attributionSentence(), cacheDir(), coverageOfDomain(), districtCoverMismatch(), DistrictRecord, findRecord(), FrontMatter, frontMatterText() (+30 more)

### Community 29 - "News feed and rubric data"
Cohesion: 0.10
Nodes (25): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+17 more)

### Community 30 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 31 - "Booking order form script"
Cohesion: 0.15
Nodes (35): buatHoldAktif(), formatTanggalPendek(), nomorHari(), parseHoldAktif(), parseParamPesan(), pengumumanAmbang(), sidikPermintaan(), teksMenginap() (+27 more)

### Community 32 - "Product listing filters & sort"
Cohesion: 0.10
Nodes (31): filterProdukIndex(), normalizeSearchTerm(), paginateProdukIndex(), ProductSort, ProdukIndexEntry, ProdukIndexFilter, emptyState, grid (+23 more)

### Community 33 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 34 - "Dev server routing & Daerah panel"
Cohesion: 0.13
Nodes (30): applyHeaders(), CACHE_ASSET, CACHE_PAGE, cacheControlFor(), createServer(), discoverCssPreloadPaths(), discoverShadowedHtmlPaths(), EMPTY_SET (+22 more)

### Community 35 - "Single-flight guard and account messages"
Cohesion: 0.09
Nodes (28): Percakapan, PercakapanHalaman, buatPenjagaDom(), buatPenjagaTunggal(), HasilJalan, KaitPenjaga, KeadaanPenjaga, OpsiJalan (+20 more)

### Community 36 - "Static page & portable text rendering"
Cohesion: 0.11
Nodes (32): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), documentHasPlayableVideo(), escapeHtml(), extractPlayableVideoInfo() (+24 more)

### Community 37 - "BPS table row fixtures"
Cohesion: 0.22
Nodes (34): row(), ageBandKey(), cx(), headerWords(), labelColumnCount(), nearestMarker(), ageByRegionColumns(), basisOf() (+26 more)

### Community 38 - "Gate library and docs-translation audit"
Cohesion: 0.14
Nodes (26): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+18 more)

### Community 39 - "BPS fetch and district selection"
Cohesion: 0.14
Nodes (32): arg(), Ctx, districtJobs(), fmt(), main(), Office, provinceCodes(), provinceFull() (+24 more)

### Community 40 - "Order status rendering client"
Cohesion: 0.11
Nodes (28): AkunPesananHalaman, ambilPesananAkunByKode(), PESAN_KONFLIK_KUNCI, createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS (+20 more)

### Community 41 - "Release image build tooling"
Cohesion: 0.14
Nodes (28): ADR-0020, gitRunOrThrow(), cosignSign(), cosignVerify(), ensureBuilder(), fail(), headIsExactlyTag(), log() (+20 more)

### Community 42 - "Bun-only deployment manifest gate tests"
Cohesion: 0.11
Nodes (28): activeLines(), argDefaults(), COMPOSE_FILES, composeViolations(), countOf(), DOCKERFILES, dockerfileStageViolations(), dockerInstructions() (+20 more)

### Community 43 - "Region and institution lookups"
Cohesion: 0.11
Nodes (25): getAllInstitutions(), RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), buildRegionIndex() (+17 more)

### Community 44 - "Push browser ports and platform detection"
Cohesion: 0.16
Nodes (30): adalah404(), ambilPemberitahuan(), cabutPerangkatLain(), matikanPerangkatIni(), pushDidukungPeramban(), deteksiPlatform(), perangkatIni(), petakanGalat() (+22 more)

### Community 45 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.11
Nodes (28): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+20 more)

### Community 46 - "Environment access and static page fetch"
Cohesion: 0.09
Nodes (23): SITEMAP_SOURCES, DefaultIdentity, siteConfig, siteUrl, detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage() (+15 more)

### Community 47 - "Customer push device and status contract"
Cohesion: 0.13
Nodes (28): DeskripsiTujuan, HasilMuat, iosMendukungPush(), isPushPurpose(), isRecord(), KeadaanPush, kunciSama(), kunciServerKeBytes() (+20 more)

### Community 48 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.15
Nodes (30): actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths(), auditOneIndex() (+22 more)

### Community 49 - "Push guard and worker configuration"
Cohesion: 0.11
Nodes (23): base64Url(), buatPortPemberitahuan(), buatPortPenanda(), buatPortPeramban(), DepsPush, HasilAktifkan, HasilMatikan, HasilSesiBaru (+15 more)

### Community 50 - "Push enrolment and sign-out flow"
Cohesion: 0.10
Nodes (18): adalah401(), bersihkanLokalBilaPerlu(), keluarAman(), keluarLokal(), LanggananInfo, PortPenanda, PortServer, PortSesi (+10 more)

### Community 51 - "BPS fetch client tests"
Cohesion: 0.11
Nodes (24): acquire(), DOWNLOAD_CONCURRENCY, HELP, ClientOptions, DownloadResult, pdfPages(), sha256File(), StallError (+16 more)

### Community 52 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 53 - "News URL redirect rules"
Cohesion: 0.14
Nodes (25): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+17 more)

### Community 54 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (26): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+18 more)

### Community 55 - "Shared storefront components and helpers"
Cohesion: 0.11
Nodes (15): rubrikColumn, year, [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE (+7 more)

### Community 56 - "BPS region discovery"
Cohesion: 0.15
Nodes (21): main(), OUT, Probe, ROOT, WILAYAH, ChallengeError, coreName(), matchTitle() (+13 more)

### Community 57 - "Local CI process and port helpers"
Cohesion: 0.25
Nodes (17): run(), RunOptions, RunResult, freePort(), LegContext, LegOutcome, runCheckCmsLeg(), skipCount() (+9 more)

### Community 58 - "Push notification stub and consent"
Cohesion: 0.10
Nodes (17): APPLICATION_SERVER_KEY, CONSENT_TEXT_VERSION, createPushStub(), maskEndpoint(), PURPOSES, PUSH_HOSTS, ADR-0049, prerender (+9 more)

### Community 59 - "Blog & ad-placement fetch helpers"
Cohesion: 0.15
Nodes (17): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+9 more)

### Community 60 - "Product breadcrumb structured data"
Cohesion: 0.14
Nodes (13): buildPriceTiers(), collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, CommerceProductVariant, getCategoryBySlug(), productsInCategory(), BreadcrumbItem (+5 more)

### Community 61 - "Docs i18n mirror stamping"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 62 - "BPS archive and checksums"
Cohesion: 0.12
Nodes (21): ITEM, LOCAL, NO_REGIONS, PDF_BYTES, SHA, ArchiveDeps, archiveOne(), compareVerification() (+13 more)

### Community 63 - "Price formatting and flash-sale countdown"
Cohesion: 0.16
Nodes (13): comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003, getStaticPaths(), formatRemaining() (+5 more)

### Community 64 - "First-party analytics beacon"
Cohesion: 0.16
Nodes (15): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+7 more)

### Community 65 - "Sitemap XML rendering"
Cohesion: 0.20
Nodes (17): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), registerSitemapSource(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests() (+9 more)

### Community 66 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 67 - "BPS extract test fixtures"
Cohesion: 0.17
Nodes (18): ctxOf(), fixture(), pageOf(), snakeCase(), absDiff(), CheckFailure, CheckReport, dedupe() (+10 more)

### Community 68 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 69 - "BPS cell and row parsing"
Cohesion: 0.19
Nodes (18): CellKind, indonesianPart(), isCellToken(), isIndexToken(), numeric(), parseCell(), ParsedCell, analysePage() (+10 more)

### Community 70 - "Local CI security baseline"
Cohesion: 0.21
Nodes (14): BaselineEntry, isBaselined(), parseBaseline(), partitionHighSeverityFindings(), SecurityFinding, CODEQL_CLI_SHA256, CODEQL_CLI_VERSION, codeqlCacheDir() (+6 more)

### Community 71 - "Redirect import push tool"
Cohesion: 0.15
Nodes (18): chunkIdempotencyKey(), ChunkOutcome, chunkRedirects(), FileWideDuplicate, findFileWideDuplicates(), ImportErrorEnvelope, ImportItemReport, ImportPoster (+10 more)

### Community 72 - "Astro profile route injection"
Cohesion: 0.20
Nodes (14): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+6 more)

### Community 73 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 74 - "Checkout and popup e2e site config"
Cohesion: 0.16
Nodes (14): activeRouteKeys(), cspNeedsFor(), describeProfile(), excludedRouteKeys(), feedsFor(), groupStylesheetsFor(), isGroupActive(), isRouteActive() (+6 more)

### Community 75 - "Affiliate code capture contract"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 76 - "getVideo"
Cohesion: 0.16
Nodes (13): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET() (+5 more)

### Community 77 - "CSP media origins and GA wiring"
Cohesion: 0.19
Nodes (11): buildCsp(), CSP, readCspOrigins(), sanitizeOrigins(), buildCspOriginsArtifact(), collectOrigins(), CspOriginsArtifact, originOf() (+3 more)

### Community 78 - "Account address book"
Cohesion: 0.26
Nodes (16): Alamat, AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate() (+8 more)

### Community 79 - "Terpopuler analytics client"
Cohesion: 0.20
Nodes (11): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+3 more)

### Community 80 - "Newsletter form tests"
Cohesion: 0.12
Nodes (7): FakeButton, FakeForm, FakeInput, FakeStatus, Listener, pending, requests

### Community 81 - "E2E accessibility and responsive specs"
Cohesion: 0.18
Nodes (11): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, firstSlug(), KEY_PAGES, KeyPage, keyPagesFor(), VIEWPORTS (+3 more)

### Community 82 - "Deploy preflight reporter tests"
Cohesion: 0.22
Nodes (14): createReporter(), checkDistForToken(), checkStorefrontEnvShape(), collectFiles(), isHttpsUrl(), loadEnv(), looksLikeToken(), main() (+6 more)

### Community 83 - "Release evidence and latest-flag tooling"
Cohesion: 0.29
Nodes (12): buildEvidence(), validateEvidence(), computeLatestFlag(), deriveImageTags(), highestTag(), imageRepository(), isValidTag(), lowerCaseOwnerRepo() (+4 more)

### Community 84 - "Toko origin and CSP configuration"
Cohesion: 0.21
Nodes (10): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+2 more)

### Community 85 - "Release file and git helpers"
Cohesion: 0.20
Nodes (10): ADR-0023, changelogSection(), findChangelogHeadings(), normalizeLineEndings(), normalizeRequestedVersion(), readFileIfPresent(), run(), SCRIPT (+2 more)

### Community 86 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 87 - "BPS region extraction"
Cohesion: 0.19
Nodes (14): index, buildIndex(), coreLabel(), kindFromGroupLine(), KindHint, NAME_ALIASES, normalizeLabel(), parentCode() (+6 more)

### Community 88 - "Legacy importer tests"
Cohesion: 0.28
Nodes (12): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+4 more)

### Community 89 - "PWA web manifest"
Cohesion: 0.23
Nodes (11): SITE_PROFILE, buildManifest(), ICON_PATHS, MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, ManifestInput, PROFILE_CATEGORIES (+3 more)

### Community 90 - "Storefront theme and brand tokens"
Cohesion: 0.24
Nodes (11): chunk(), crc32(), CRC_TABLE, encodePng(), GLYPHS, hexToRgb(), iconInitial(), IconSpec (+3 more)

### Community 91 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 92 - "Root package manifest"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 93 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 94 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 95 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 96 - "Site theme extraction and API origin"
Cohesion: 0.24
Nodes (9): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, FIXTURE_CSS (+1 more)

### Community 97 - "Product detail variant pricing"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 98 - "Release publish and process helpers"
Cohesion: 0.39
Nodes (10): gitRunInherit(), tagIsAncestorOfOriginMain(), runCapture(), runCaptureOrThrow(), runInherit(), fail(), log(), main() (+2 more)

### Community 99 - "Log redaction helpers"
Cohesion: 0.32
Nodes (7): redactLine(), redactText(), fakeBearerValue, fakeDsnPassword, fakeGithubToken, redact(), main()

### Community 100 - "BPS district job planning"
Cohesion: 0.23
Nodes (11): blankDistrict(), DistrictJob, districtPdfPath(), listFor(), listKecamatan(), DistrictMatch, districtPdfName(), DistrictRegion (+3 more)

### Community 101 - "CMS API fetch client"
Cohesion: 0.21
Nodes (10): collectPendingAssignments(), runAssignInstitutions(), termMapHintFor(), apiCall(), ApiResult, assertOk(), AwcmsApiError, resolveExistingTenantSession() (+2 more)

### Community 102 - "Build id writer script"
Cohesion: 0.16
Nodes (7): buildId, OUT_PATH, resolveBuildId(), cleanup, fixture(), run(), SCRIPT

### Community 103 - "Push browser port permissions and subscription"
Cohesion: 0.27
Nodes (4): aktifkanPerangkat(), PortPeramban, petakanGalatPeramban(), TeksPersetujuan

### Community 104 - "PWA site icon rendering"
Cohesion: 0.27
Nodes (7): ICON_FILES, IconName, renderSiteIcon(), GET(), prerender, GET(), prerender

### Community 105 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 106 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 107 - "Production compose file tests"
Cohesion: 0.18
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 108 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 109 - "Push worker contract tests"
Cohesion: 0.20
Nodes (7): PUSH_PURPOSES, PUSH_TARGET_PATHS, FakeClient, Harness, Listener, Shown, SOURCE

### Community 110 - "Theme colour contrast helpers"
Cohesion: 0.40
Nodes (7): contrastingForeground(), contrastRatio(), isValidHexColor(), relativeLuminance(), WCAG_AA_TEXT_CONTRAST, GET(), prerender

### Community 112 - "Single-flight contract test"
Cohesion: 0.28
Nodes (7): BACA_SAJA, DIKECUALIKAN, LIBS, mutasiDalam(), mutatingExports(), SCRIPTS, stripKomentar()

### Community 113 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 114 - "BPS table and region index"
Cohesion: 0.36
Nodes (8): bboxWindow(), decodeEntities(), ENTITIES, loadPages(), median(), parseBboxPages(), pdfPageCount(), Word

### Community 115 - "runExport"
Cohesion: 0.28
Nodes (9): buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), flag(), main(), runExport(), runPushRedirects(), usage(), formatPushSummary() (+1 more)

### Community 116 - "Push-only service worker click handling"
Cohesion: 0.39
Nodes (5): isRecord(), normalizePayload(), resolveTarget(), tagOf(), text()

### Community 117 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 118 - "Local CI audit exceptions parser"
Cohesion: 0.46
Nodes (6): valid, AuditException, auditIgnoreArgs(), loadAuditIgnoreArgs(), parseAuditExceptions(), runBunAuditWithExceptions()

### Community 119 - "BPS publication discovery"
Cohesion: 0.25
Nodes (8): blank(), discoverActionId(), findPublication(), listPage(), pdfPath(), processOffice(), extractActionId(), findPublicationChunk()

### Community 120 - "Recent-news (terkini) loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 121 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 122 - "Site identity and AWCMS settings fallback"
Cohesion: 0.67
Nodes (5): awcmsGet(), baseUrl(), Envelope, timeoutMs(), readEnv()

### Community 123 - "GA init script"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 124 - "Booking pages build smoke tests"
Cohesion: 0.33
Nodes (3): canSpawnBun(), PAGE_SOURCES, PAGES

### Community 125 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 126 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 127 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 128 - "Gate report formatter"
Cohesion: 0.40
Nodes (3): formatReport(), SCRIPT_DIRS, scripts

### Community 129 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 130 - "Docs audit test suite"
Cohesion: 0.33
Nodes (4): cleanup, ADR-0042, run(), SCRIPT

### Community 131 - "Release audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 132 - "Promo popup script"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 133 - "Root dependency overrides"
Cohesion: 0.40
Nodes (5): overrides, sharp, shell-quote, smol-toml, source-map-js

### Community 134 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 136 - "Graph-update tool (knowledge:graph:update)"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 139 - "BPS extractor region index types"
Cohesion: 0.50
Nodes (4): RegionIndex, PageInfo, Ctx, Found

### Community 142 - "Workspace member globs"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **921 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+916 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Storefront build-id and stub lifecycle` to `Dependency freshness report tooling`, `Docs audit test suite`, `Release audit tests`, `Local CI fork and git helpers`, `Seed profile CLI`, `Graph-update tool (knowledge:graph:update)`, `E2E global setup`, `Shared profile-route test harness`, `BPS archive file layout`, `BPS population pipeline`, `BPS extract checks and metadata`, `Gate library and docs-translation audit`, `Release image build tooling`, `BPS fetch client tests`, `Local CI process and port helpers`, `Local CI security baseline`, `Deploy preflight reporter tests`, `Release file and git helpers`, `MySQL dump reader`, `Deploy scenario test harness`, `Root package manifest`, `Release publish and process helpers`, `Build id writer script`, `BPS table and region index`, `runExport`, `Local CI audit exceptions parser`, `Booking pages build smoke tests`, `Social-meta build-smoke test`?**
  _High betweenness centrality (0.303) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Seed profile CLI` to `CMS seed CLI`, `Astro profile route injection`, `Site identity composition`, `Site build-profile config`, `Shared profile-route test harness`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site identity composition` to `Storefront booking and reservations`, `News feed, rubric and pagination`, `News navigation`, `Marketing data client`, `Account session client and contract`, `Site build-profile config`, `Shared profile-route test harness`, `Article/video schema & breadcrumbs`, `Commerce catalog wire types`, `News feed and rubric data`, `Single-flight guard and account messages`, `Order status rendering client`, `Region and institution lookups`, `Environment access and static page fetch`, `Shared storefront components and helpers`, `Blog & ad-placement fetch helpers`, `Product breadcrumb structured data`, `Price formatting and flash-sale countdown`, `getVideo`, `E2E accessibility and responsive specs`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _921 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Dependency freshness report tooling` be split into smaller, more focused modules?**
  _Cohesion score 0.060784313725490195 - nodes in this community are weakly interconnected._
- **Should `CMS seed CLI` be split into smaller, more focused modules?**
  _Cohesion score 0.05540499849442939 - nodes in this community are weakly interconnected._
- **Should `Storefront booking and reservations` be split into smaller, more focused modules?**
  _Cohesion score 0.060759493670886074 - nodes in this community are weakly interconnected._