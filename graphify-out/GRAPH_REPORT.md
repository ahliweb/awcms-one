# Graph Report - awcms-one  (2026-11-14)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3631 nodes · 8361 edges · 185 communities (165 shown, 20 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 63 edges (avg confidence: 0.64)
- Token cost: 220,515 input · 2,564 output

## Graph Freshness
- Built from commit: `742dbb80`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Booking Actions and Contract
- Dependency Freshness Report
- CMS Seed Script
- Template Init and Seeding Tests
- Legacy URL Redirect Rules
- Site Header and Layout Components
- Customer Account API Client
- News Rubric and Archive Pages
- Build Profile Configuration
- News Footer and Region Data
- OTP and Idempotency Keys
- Customer Session Contract
- Profile Build Output Assertions
- Booking Availability Client
- Marketing Flash Sales and Popups
- Bun-Only Manifest Scanner
- Root Package Scripts
- Social Share and Follow Links
- Wishlist Storage and Sync
- Article Card and View
- Site Config and RSS Feed
- Partner Institutions and Media
- Release Image Signing
- Price Formatting and Affiliate Pages
- Checkout Region Lookup
- Privacy Request Contract
- Logout and Device Revocation
- Storefront Package Manifest
- Portable Text Rendering
- Product Search and Pagination
- Ad Placements and Blog API
- Booking Hold and Order Form
- Privacy Build Smoke Test
- Documentation Audit Gate
- Knowledge Graph Audit
- Translation Mirror Checks
- Changesets and Semver
- AWCMS API Stub Server
- Order Status Rendering
- Web Push Enrollment Flow
- Customer Push Capability
- Seed Profile Validation
- News Article Structured Data
- Shopping Cart Storage
- Account Notification Settings
- Local CI Orchestration
- Checkout Session and Loyalty Points
- Storefront Build Smoke Tests
- Legacy News Importer
- CI Runner Utilities
- Commerce Catalog Data
- PWA Icon Generation
- Local Compose Database Config
- Release Evidence and Tagging
- Redirect Import Poster
- Push Stub and Service Worker
- App Install Help Page
- Graph Combine and Subtree Guard
- Bun-Only Runtime Entrypoints
- Booking E2E Tests
- Single-Flight Submit Guard
- Notification E2E Tests
- Changelog Release Notes
- Obsidian Export Safety
- Product Cards and Schema
- Newsletter Subscription
- Sitemap Generation
- Ad Popup Dialog
- Product Index and Categories
- Astro Profile Integration
- Text-to-Speech Reader
- Affiliate Code Capture
- Upstream Sync Issue Template
- Legacy Import Tests
- Security Baseline and CodeQL
- CI Watch and State Hashing
- Popular Posts Analytics
- Social Meta Tags
- Order Status Polling
- Newsletter Form Tests
- Accessibility and Navigation E2E
- Backup Environment Config
- Deploy Preflight Checks
- Customer Address Book
- Analytics Build Smoke Tests
- Bug Report Template
- Feature Request Template
- MySQL Dump Reader
- Stub Checkout Quote Fixtures
- Site Theme Tokens
- Production Jobs Services
- Local CI Leg Definitions
- Release Backlog Audit
- Legacy Import CLI Commands
- PWA Web Manifest
- AWCMS Client and Env
- Static Pages
- Production Compose Volumes
- Storefront Build Environment
- Production Deploy Tests
- E2E Build and Serve Harness
- Product Variant Selection
- Cart Quote and Summary
- Root Package Manifest
- Lockfile Consistency Check
- Contract Package TSConfig
- Production Deploy Helpers
- Stub Customer Accounts
- Stub Storefront API
- Courier Shipping Options
- Postgres Compose Service
- CI Log Redaction
- Product Feed and Labels
- Browser Push Enrollment
- Storefront TSConfig Paths
- Contract Package Manifest
- Compose Secrets
- Knowledge Subtree Write Guard
- Push Service Worker Tests
- Cascading Region Selects
- Docker Build Config
- Catalog Search and Pricing
- Analytics Page Beacon
- Single-Flight Contract Test
- Obsidian Export Tests
- CMS Origin and Gateway Redirect
- Notification Service Worker
- Checkout No-Prerender Guard
- Account Privacy E2E
- Container Healthcheck Config
- CI Audit Exceptions
- Booking Stub Server
- Recent News Loader
- Color Contrast Utilities
- News Search Page
- Contract Import Direction Test
- CI Bun Version Pin
- CI Fork Policy
- CI Run Lock
- News Route Guard Test
- Google Analytics Init
- Booking Build Smoke Test
- Social Meta Build Smoke
- Backup Compose Service
- CMS Compose Service
- Migrate Compose Service
- Restore Drill Service
- Status Prose Staleness Test
- Issue Template Config
- Config Package Manifest
- Gerbang Package Manifest
- Document Audit Tests
- Release Audit Tests
- Bun Runtime Smoke Test
- Promo Popup
- Null Contact Fallback Test
- Sidebar Build Smoke Test
- Dependency Overrides
- Base TSConfig Options
- Root Env Example Coverage
- Knowledge Graph Update
- Order Serialization Helpers
- Build ID Writer
- Share Button Build Smoke
- Listen Feature Build Smoke
- Institution Logo Build Smoke
- Lynx Direction Test
- Compose Job Runner
- Bun Runtime Smoke Script
- Bundle Build Smoke Test
- Flash Sale Countdown
- Affiliate Build Smoke Test
- Account Dashboard Build Smoke
- Newsletter Path Contract
- Offsite Backup Copy
- CodeQL Config
- Workspace Definitions
- Database Role Setup
- Funding Config
- Backup Compose Runner
- Production Deploy Script
- Remote Deploy Script
- Production Healthcheck Script
- Production Rollback Script

## God Nodes (most connected - your core abstractions)
1. `ROUTES` - 63 edges
2. `bun` - 61 edges
3. `kirimPermintaan()` - 54 edges
4. `bacaSesi()` - 51 edges
5. `scripts` - 44 edges
6. `formatPrice()` - 39 edges
7. `getSiteIdentity()` - 39 edges
8. `authHeader()` - 38 edges
9. `denganPembersihanSesi()` - 37 edges
10. `TokoApiError` - 35 edges

## Surprising Connections (you probably didn't know these)
- `updateCountdowns()` --indirect_call--> `row()`  [INFERRED]
  apps/storefront/src/scripts/akun-reservasi.ts → tests/import-seputarborneo.test.mjs
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/booking-build-smoke.test.ts → package.json
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/meta-sosial-build-smoke.test.ts → package.json
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (185 total, 20 thin omitted)

### Community 0 - "Booking Actions and Contract"
Cohesion: 0.06
Nodes (77): ADR-0045, HasilBayar, labelTombolBayar(), mulaiPembayaranGateway(), alasanTidakBisaBatal(), bandingkanUang(), BarisUang, BOOKING_AKTIF_KEY (+69 more)

### Community 1 - "Dependency Freshness Report"
Cohesion: 0.06
Nodes (81): fixture(), FIXTURES, HOLD, json(), argValue(), collectAdvisories(), collectBun(), collectImageRefs() (+73 more)

### Community 2 - "CMS Seed Script"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 3 - "Template Init and Seeding Tests"
Cohesion: 0.06
Nodes (57): ADR-0018, ADR-0053, canSpawnBun(), runTemplateInitTests(), applyPlan(), describeChecklist(), POST_INIT_CHECKLIST, applyColorDefaults() (+49 more)

### Community 4 - "Legacy URL Redirect Rules"
Cohesion: 0.06
Nodes (64): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+56 more)

### Community 5 - "Site Header and Layout Components"
Cohesion: 0.08
Nodes (32): socialIcons, tokoAktif, ROUTES, ADR-0018, ADR-0055, DEFAULT_IDENTITY, getStoreSettings(), ComposedSiteIdentity (+24 more)

### Community 6 - "Customer Account API Client"
Cohesion: 0.08
Nodes (64): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilDetailReservasi(), ambilKomisiAfiliasi(), ambilKuotaPembatalan(), ambilPercakapan() (+56 more)

### Community 7 - "News Rubric and Archive Pages"
Cohesion: 0.06
Nodes (49): RawTerm, AuthorArchive, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive, DaerahLink (+41 more)

### Community 8 - "Build Profile Configuration"
Cohesion: 0.06
Nodes (45): CspNeeds, cspNeedsFor(), DEFAULT_SITE_PROFILE, describeProfile(), FeedEntry, FEEDS, FEEDS_ALL, feedsFor() (+37 more)

### Community 9 - "News Footer and Region Data"
Cohesion: 0.07
Nodes (43): rubrikColumn, year, daerahActive, getAllInstitutions(), buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf() (+35 more)

### Community 10 - "OTP and Idempotency Keys"
Cohesion: 0.08
Nodes (46): mintaKode(), OtpChannel, Percakapan, PercakapanHalaman, buatKunciBaru(), buatPengelolaKunci(), galatKonflikKunci(), jawabanFinal() (+38 more)

### Community 11 - "Customer Session Contract"
Cohesion: 0.09
Nodes (41): Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun, ADR-0007 (+33 more)

### Community 12 - "Profile Build Output Assertions"
Cohesion: 0.09
Nodes (37): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, run (+29 more)

### Community 13 - "Booking Availability Client"
Cohesion: 0.07
Nodes (45): formatTanggalPendek(), KetersediaanMenginap, KuotaBooking, labelZonaWaktu(), nomorHari(), parseParamCari(), periksaTanggal(), tanggalLokal() (+37 more)

### Community 14 - "Marketing Flash Sales and Popups"
Cohesion: 0.07
Nodes (38): CSP_NEEDS, getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry (+30 more)

### Community 15 - "Bun-Only Manifest Scanner"
Cohesion: 0.09
Nodes (43): classify(), COMPOSE_FILES, composeViolations(), DOCKERFILES, EXEMPT_DOCKERFILES, EXEMPT_IMAGE_SERVICES, isTestFixture(), MANIFESTS (+35 more)

### Community 16 - "Root Package Scripts"
Cohesion: 0.05
Nodes (44): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+36 more)

### Community 17 - "Social Share and Follow Links"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 18 - "Wishlist Storage and Sync"
Cohesion: 0.14
Nodes (29): laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist(), saveWishlist() (+21 more)

### Community 19 - "Article Card and View"
Cohesion: 0.09
Nodes (30): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+22 more)

### Community 20 - "Site Config and RSS Feed"
Cohesion: 0.09
Nodes (27): SITEMAP_SOURCES, absoluteUrl(), DefaultIdentity, siteConfig, siteUrl, BeritaFeedItem, escapeCdata(), escapeXml() (+19 more)

### Community 21 - "Partner Institutions and Media"
Cohesion: 0.09
Nodes (28): RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), chunk(), fetchMediaPublicOrigin() (+20 more)

### Community 22 - "Release Image Signing"
Cohesion: 0.14
Nodes (31): ADR-0020, cosignSign(), cosignVerify(), ensureBuilder(), fail(), headIsExactlyTag(), log(), main() (+23 more)

### Community 23 - "Price Formatting and Affiliate Pages"
Cohesion: 0.10
Nodes (32): AfiliasiKomisiHalaman, UlasanAkun, formatPrice(), PRICE_FORMATTER, ADR-0003, buildWhatsappUrl(), ADR-0003, ADR-0007 (+24 more)

### Community 24 - "Checkout Region Lookup"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 25 - "Privacy Request Contract"
Cohesion: 0.10
Nodes (27): bacaPenolakan(), bacaRingkasanPenghapusan(), isKodePenolakan(), KODE_PENOLAKAN, KodePenolakan, kodeValid(), namaBerkasEkspor(), PESAN_KODE_SALAH (+19 more)

### Community 26 - "Logout and Device Revocation"
Cohesion: 0.09
Nodes (24): adalah401(), adalah404(), bersihkanLokalBilaPerlu(), cabutPerangkatLain(), keluarAman(), keluarLokal(), LanggananInfo, matikanPerangkatIni() (+16 more)

### Community 27 - "Storefront Package Manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 28 - "Portable Text Rendering"
Cohesion: 0.11
Nodes (31): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), documentHasPlayableVideo(), escapeHtml(), extractPlayableVideoInfo() (+23 more)

### Community 29 - "Product Search and Pagination"
Cohesion: 0.11
Nodes (29): paginateProdukIndex(), ProductSort, ProdukIndexEntry, ProdukIndexFilter, emptyState, grid, heading, paginationEl (+21 more)

### Community 30 - "Ad Placements and Blog API"
Cohesion: 0.11
Nodes (24): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+16 more)

### Community 31 - "Booking Hold and Order Form"
Cohesion: 0.17
Nodes (32): buatHoldAktif(), parseHoldAktif(), pengumumanAmbang(), sidikPermintaan(), teksSisa(), ambilKuotaBooking(), backToSearchHref(), focusHeading() (+24 more)

### Community 32 - "Privacy Build Smoke Test"
Cohesion: 0.07
Nodes (16): ADR-0055, ADR-0019, ADR-0160, ADR-0162, COMPOSE_PATH, doc, raw, REPO_ROOT (+8 more)

### Community 33 - "Documentation Audit Gate"
Cohesion: 0.13
Nodes (31): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+23 more)

### Community 34 - "Knowledge Graph Audit"
Cohesion: 0.11
Nodes (28): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+20 more)

### Community 35 - "Translation Mirror Checks"
Cohesion: 0.15
Nodes (25): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+17 more)

### Community 36 - "Changesets and Semver"
Cohesion: 0.12
Nodes (28): CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile(), parseChangeset(), validateChangeset(), atLeastAsSignificant(), BUMP_LEVELS (+20 more)

### Community 37 - "AWCMS API Stub Server"
Cohesion: 0.07
Nodes (26): ANALYTICS_RANGES, bookingStub, buildAffiliateLink(), FIXTURES, GATEWAY_SESSIONS_BY_ID, GATEWAY_SESSIONS_BY_ORDER, gatewayPageHtml(), handleStubGatewayPage() (+18 more)

### Community 38 - "Order Status Rendering"
Cohesion: 0.12
Nodes (26): AkunPesananHalaman, ambilPesananAkunByKode(), createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, getOrder() (+18 more)

### Community 39 - "Web Push Enrollment Flow"
Cohesion: 0.11
Nodes (23): base64Url(), buatPortPemberitahuan(), buatPortPenanda(), buatPortPeramban(), DepsPush, HasilAktifkan, HasilMatikan, HasilSesiBaru (+15 more)

### Community 40 - "Customer Push Capability"
Cohesion: 0.14
Nodes (27): DeskripsiTujuan, HasilMuat, iosMendukungPush(), isPushPurpose(), isRecord(), KeadaanPush, kunciSama(), kunciServerKeBytes() (+19 more)

### Community 41 - "Seed Profile Validation"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 42 - "News Article Structured Data"
Cohesion: 0.10
Nodes (23): getRelatedPosts(), getVideo(), ADR-0109, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema(), NewsArticleSchemaInput (+15 more)

### Community 43 - "Shopping Cart Storage"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 44 - "Account Notification Settings"
Cohesion: 0.19
Nodes (25): ambilPemberitahuan(), pushDidukungPeramban(), deteksiPlatform(), perangkatIni(), PESAN_PEMBERITAHUAN, tujuanDitawarkan(), bersihkan(), buatCheckbox() (+17 more)

### Community 45 - "Local CI Orchestration"
Cohesion: 0.18
Nodes (20): gitRunOrThrow(), main(), parseArgs(), main(), parseArgs(), parseGitHubRemoteUrl(), RepoRef, resolveRepo() (+12 more)

### Community 46 - "Checkout Session and Loyalty Points"
Cohesion: 0.14
Nodes (20): Alamat, Cart, PESANAN_PHONE_KEY, bacaPoinInput(), bolehPakaiPoin(), parsePoinAkun(), perkiraanDiskonPoin(), pesanKesalahanPoin() (+12 more)

### Community 47 - "Storefront Build Smoke Tests"
Cohesion: 0.11
Nodes (13): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+5 more)

### Community 48 - "Legacy News Importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 49 - "CI Runner Utilities"
Cohesion: 0.24
Nodes (18): run(), RunOptions, runOrThrow(), RunResult, freePort(), LegContext, LegOutcome, runCheckCmsLeg() (+10 more)

### Community 50 - "Commerce Catalog Data"
Cohesion: 0.09
Nodes (20): assertNeverProductStatus(), CategoryNode, CommerceBundle, CommerceBundleComponent, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, isPubliclyVisible() (+12 more)

### Community 51 - "PWA Icon Generation"
Cohesion: 0.14
Nodes (18): chunk(), crc32(), CRC_TABLE, encodePng(), GLYPHS, hexToRgb(), iconInitial(), IconSpec (+10 more)

### Community 52 - "Local Compose Database Config"
Cohesion: 0.08
Nodes (23): name, AWCMS_APP_PASSWORD, AWCMS_SETUP_PASSWORD, AWCMS_WORKER_PASSWORD, POSTGRES_DB, POSTGRES_PASSWORD, POSTGRES_USER, interval (+15 more)

### Community 53 - "Release Evidence and Tagging"
Cohesion: 0.21
Nodes (18): gitRunInherit(), buildEvidence(), validateEvidence(), computeLatestFlag(), deriveImageTags(), highestTag(), imageRepository(), isValidTag() (+10 more)

### Community 54 - "Redirect Import Poster"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 55 - "Push Stub and Service Worker"
Cohesion: 0.10
Nodes (17): APPLICATION_SERVER_KEY, CONSENT_TEXT_VERSION, createPushStub(), maskEndpoint(), PURPOSES, PUSH_HOSTS, ADR-0049, prerender (+9 more)

### Community 56 - "App Install Help Page"
Cohesion: 0.13
Nodes (13): [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE, StaticPageSummary, detectInstallState() (+5 more)

### Community 57 - "Graph Combine and Subtree Guard"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 58 - "Bun-Only Runtime Entrypoints"
Cohesion: 0.11
Nodes (19): CMS_DOCKERFILE, CRON_TARGETS, CRONTAB, exists(), ADR-0002, PROFILES, read(), readJson() (+11 more)

### Community 59 - "Booking E2E Tests"
Cohesion: 0.13
Nodes (14): api(), browserPage(), confirmed(), day(), hold(), login(), open(), payDeposit() (+6 more)

### Community 60 - "Single-Flight Submit Guard"
Cohesion: 0.12
Nodes (15): buatPenjagaDom(), buatPenjagaTunggal(), HasilJalan, KaitPenjaga, KeadaanPenjaga, OpsiJalan, OpsiPenjagaDom, OpsiPenjagaUntuk (+7 more)

### Community 61 - "Notification E2E Tests"
Cohesion: 0.16
Nodes (16): api(), chooseAndEnable(), CORS(), enrolled(), enrolledOnAccount(), failRegistration(), installPushMock(), login() (+8 more)

### Community 62 - "Changelog Release Notes"
Cohesion: 0.15
Nodes (14): ADR-0023, changelogSection(), findChangelogHeadings(), normalizeLineEndings(), normalizeRequestedVersion(), readFileIfPresent(), formatTag(), formatVersion() (+6 more)

### Community 63 - "Obsidian Export Safety"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 64 - "Product Cards and Schema"
Cohesion: 0.18
Nodes (9): buildPriceTiers(), CommerceCategory, CommerceProduct, formatDiscountPercent(), BreadcrumbItem, breadcrumbListNode(), buildCategoryPageSchema(), buildProductPageSchema() (+1 more)

### Community 65 - "Newsletter Subscription"
Cohesion: 0.19
Nodes (14): penjagaUntuk(), BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus() (+6 more)

### Community 66 - "Sitemap Generation"
Cohesion: 0.22
Nodes (16): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests(), resetSitemapSourcesForTests() (+8 more)

### Community 67 - "Ad Popup Dialog"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 68 - "Product Index and Categories"
Cohesion: 0.13
Nodes (13): buildCategoryTree(), buildProdukIndex(), collectCategorySubtreeIds(), getCategories(), getCategoryBySlug(), primaryProductImage(), productsInCategory(), PRODUK_PAGE_SIZE (+5 more)

### Community 69 - "Astro Profile Integration"
Cohesion: 0.20
Nodes (14): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+6 more)

### Community 70 - "Text-to-Speech Reader"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 71 - "Affiliate Code Capture"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 72 - "Upstream Sync Issue Template"
Cohesion: 0.11
Nodes (17): description, label, options, placeholder, value, body, attributes, id (+9 more)

### Community 73 - "Legacy Import Tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 74 - "Security Baseline and CodeQL"
Cohesion: 0.22
Nodes (13): BaselineEntry, isBaselined(), parseBaseline(), partitionHighSeverityFindings(), SecurityFinding, CODEQL_CLI_SHA256, CODEQL_CLI_VERSION, codeqlCacheDir() (+5 more)

### Community 75 - "CI Watch and State Hashing"
Cohesion: 0.28
Nodes (14): hasRecordedResult(), listOpenPrs(), main(), OpenPr, recordResult(), fetchPullRequestInfo(), ghApiJson(), ciDefinitionHash() (+6 more)

### Community 76 - "Popular Posts Analytics"
Cohesion: 0.20
Nodes (11): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+3 more)

### Community 77 - "Social Meta Tags"
Cohesion: 0.26
Nodes (13): PostDetail, articleSocialMeta(), isHttpUrl(), listingSocialMeta(), MetaTag, ogImageMeta(), postSeoText(), rubrikPaginationLinks() (+5 more)

### Community 78 - "Order Status Polling"
Cohesion: 0.17
Nodes (13): nextPollDecision(), PesananPoller, POLL_INTERVAL_MS, POLL_MAX_DURATION_MS, PollDecision, PollInput, PollStopReason, wirePesananPolling() (+5 more)

### Community 79 - "Newsletter Form Tests"
Cohesion: 0.12
Nodes (7): FakeButton, FakeForm, FakeInput, FakeStatus, Listener, pending, requests

### Community 80 - "Accessibility and Navigation E2E"
Cohesion: 0.18
Nodes (11): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, firstSlug(), KEY_PAGES, KeyPage, keyPagesFor(), VIEWPORTS (+3 more)

### Community 81 - "Backup Environment Config"
Cohesion: 0.15
Nodes (17): environment, environment, BACKUP_AGE_RECIPIENTS_FILE, BACKUP_DIR, BACKUP_HMAC_KEY_FILE, BACKUP_LABEL, BACKUP_RETENTION_DAYS, DATABASE_URL (+9 more)

### Community 82 - "Deploy Preflight Checks"
Cohesion: 0.22
Nodes (14): createReporter(), checkDistForToken(), checkStorefrontEnvShape(), collectFiles(), isHttpsUrl(), loadEnv(), looksLikeToken(), main() (+6 more)

### Community 83 - "Customer Address Book"
Cohesion: 0.28
Nodes (15): AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate(), openFormForEdit() (+7 more)

### Community 84 - "Analytics Build Smoke Tests"
Cohesion: 0.14
Nodes (8): canSpawnBun(), runBuild(), canSpawnBun(), bun, cleanup, fixture(), run(), SCRIPT

### Community 85 - "Bug Report Template"
Cohesion: 0.12
Nodes (15): description, label, options, placeholder, value, body, attributes, id (+7 more)

### Community 86 - "Feature Request Template"
Cohesion: 0.12
Nodes (15): description, label, options, placeholder, value, body, attributes, id (+7 more)

### Community 87 - "MySQL Dump Reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 88 - "Stub Checkout Quote Fixtures"
Cohesion: 0.19
Nodes (15): buildCourierOptions(), computeQuote(), courierSettings(), findProductLine(), findVoucher(), fixture(), fromCents(), productCatalog() (+7 more)

### Community 89 - "Site Theme Tokens"
Cohesion: 0.20
Nodes (11): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, GET() (+3 more)

### Community 90 - "Production Jobs Services"
Cohesion: 0.13
Nodes (15): depends_on, postgres, depends_on, env_file, image, profiles, depends_on, env_file (+7 more)

### Community 91 - "Local CI Leg Definitions"
Cohesion: 0.18
Nodes (12): ADR-0021, EXPECTED_CONTEXTS, orchestrate, pkg, VERSION, findLeg(), LEG_CONTEXTS, LegDefinition (+4 more)

### Community 92 - "Release Backlog Audit"
Cohesion: 0.14
Nodes (8): dated, oldest, pending, reporter, todayIso, formatReport(), SCRIPT_DIRS, scripts

### Community 93 - "Legacy Import CLI Commands"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 94 - "PWA Web Manifest"
Cohesion: 0.23
Nodes (11): SITE_PROFILE, buildManifest(), ICON_PATHS, MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, ManifestInput, PROFILE_CATEGORIES (+3 more)

### Community 95 - "AWCMS Client and Env"
Cohesion: 0.29
Nodes (9): awcmsGet(), baseUrl(), Envelope, timeoutMs(), EnvSource, readEnv(), readEnvOr(), isValidGaMeasurementId() (+1 more)

### Community 96 - "Static Pages"
Cohesion: 0.22
Nodes (11): detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), listStaticPages(), StaticPageDetail, ADR-0100 (+3 more)

### Community 97 - "Production Compose Volumes"
Cohesion: 0.14
Nodes (13): name, name, name, command, image, profiles, secrets, volumes (+5 more)

### Community 98 - "Storefront Build Environment"
Cohesion: 0.14
Nodes (14): AWCMS_API_URL, PUBLIC_AWCMS_ORIGIN, PUBLIC_CUSTOMER_PUSH, PUBLIC_GA_ID, PUBLIC_INSTALL_HELP, SITE_PROFILE, SITE_URL, args (+6 more)

### Community 99 - "Production Deploy Tests"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 100 - "E2E Build and Serve Harness"
Cohesion: 0.23
Nodes (9): buildAndServe(), BuildAndServeOptions, BuiltSite, waitForHttp(), globalSetup(), PREVIEW_PORT, STUB_PORT, ADR-0002 (+1 more)

### Community 101 - "Product Variant Selection"
Cohesion: 0.23
Nodes (12): CommerceProductVariant, findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload (+4 more)

### Community 102 - "Cart Quote and Summary"
Cohesion: 0.26
Nodes (12): quoteCart(), QuoteLine, buildWhatsappCartMessage(), lineText(), hideQuoteError(), refresh(), renderLines(), renderSummary() (+4 more)

### Community 103 - "Root Package Manifest"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 104 - "Lockfile Consistency Check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 105 - "Contract Package TSConfig"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 106 - "Production Deploy Helpers"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 107 - "Stub Customer Accounts"
Cohesion: 0.21
Nodes (12): ACCOUNTS, deterministicAffiliateCode(), envelope(), handleAccountRequest(), issueSession(), lastMessageAt(), nextConversationId(), nextMessageId() (+4 more)

### Community 108 - "Stub Storefront API"
Cohesion: 0.18
Nodes (12): analyticsPages(), corsHeaders(), envelopeError(), findAccountByBearer(), findAccountByPhone(), findOrderForPhone(), gatewayReturnBase(), generateOrderCode() (+4 more)

### Community 109 - "Courier Shipping Options"
Cohesion: 0.24
Nodes (10): describeShippingOption(), isShippingOptionSelected(), shippingOptionKey(), ShippingOptionView, ShippingOption, ShippingSelection, ALTERNATIVE, COURIER_OPTION (+2 more)

### Community 110 - "Postgres Compose Service"
Cohesion: 0.17
Nodes (12): AWCMS_APP_PASSWORD, AWCMS_SETUP_PASSWORD, AWCMS_WORKER_PASSWORD, POSTGRES_DB, POSTGRES_PASSWORD, POSTGRES_USER, container_name, environment (+4 more)

### Community 111 - "CI Log Redaction"
Cohesion: 0.32
Nodes (7): redactLine(), redactText(), fakeBearerValue, fakeDsnPassword, fakeGithubToken, redact(), main()

### Community 112 - "Product Feed and Labels"
Cohesion: 0.25
Nodes (9): getProduct(), getProducts(), labelClassName(), escapeXml(), GET(), prerender, GET(), prerender (+1 more)

### Community 113 - "Browser Push Enrollment"
Cohesion: 0.27
Nodes (4): aktifkanPerangkat(), PortPeramban, petakanGalatPeramban(), TeksPersetujuan

### Community 114 - "Storefront TSConfig Paths"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 115 - "Contract Package Manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 116 - "Compose Secrets"
Cohesion: 0.18
Nodes (11): file, file, file, file, file, secrets, awcms_api_token, backup_age_recipients (+3 more)

### Community 117 - "Knowledge Subtree Write Guard"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 118 - "Push Service Worker Tests"
Cohesion: 0.20
Nodes (7): PUSH_PURPOSES, PUSH_TARGET_PATHS, FakeClient, Harness, Listener, Shown, SOURCE

### Community 119 - "Cascading Region Selects"
Cohesion: 0.44
Nodes (9): applyRegionSelection(), fetchRegionJson(), fillRegionOptions(), loadKabupaten(), loadKecamatan(), loadProvinces(), RegionOption, RegionSelects (+1 more)

### Community 120 - "Docker Build Config"
Cohesion: 0.33
Nodes (10): build, context, dockerfile, target, build, build, build, build (+2 more)

### Community 121 - "Catalog Search and Pricing"
Cohesion: 0.31
Nodes (8): filterProdukIndex(), normalizeSearchTerm(), comparePrices(), priceToNumber(), HARGA_FILE, SCANNABLE_EXTENSIONS, SRC_ROOT, walk()

### Community 122 - "Analytics Page Beacon"
Cohesion: 0.36
Nodes (7): AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon(), TrackingSignalSource, ADR-0007

### Community 123 - "Single-Flight Contract Test"
Cohesion: 0.28
Nodes (7): BACA_SAJA, DIKECUALIKAN, LIBS, mutasiDalam(), mutatingExports(), SCRIPTS, stripKomentar()

### Community 124 - "Obsidian Export Tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 125 - "CMS Origin and Gateway Redirect"
Cohesion: 0.39
Nodes (4): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, isValidGatewayRedirectUrl()

### Community 126 - "Notification Service Worker"
Cohesion: 0.39
Nodes (5): isRecord(), normalizePayload(), resolveTarget(), tagOf(), text()

### Community 127 - "Checkout No-Prerender Guard"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 128 - "Account Privacy E2E"
Cohesion: 0.29
Nodes (4): api(), register(), Sesi, ADR-0055

### Community 129 - "Container Healthcheck Config"
Cohesion: 0.50
Nodes (8): healthcheck, interval, retries, start_period, test, timeout, healthcheck, healthcheck

### Community 130 - "CI Audit Exceptions"
Cohesion: 0.46
Nodes (6): valid, AuditException, auditIgnoreArgs(), loadAuditIgnoreArgs(), parseAuditExceptions(), runBunAuditWithExceptions()

### Community 132 - "Recent News Loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 133 - "Color Contrast Utilities"
Cohesion: 0.62
Nodes (5): contrastingForeground(), contrastRatio(), isValidHexColor(), relativeLuminance(), WCAG_AA_TEXT_CONTRAST

### Community 134 - "News Search Page"
Cohesion: 0.29
Nodes (5): input, matches, needle, resultsList, status

### Community 135 - "Contract Import Direction Test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 136 - "CI Bun Version Pin"
Cohesion: 0.52
Nodes (5): PKG, BunPinResult, checkBunPin(), enforceBunPinOrThrow(), readPinnedBunVersion()

### Community 137 - "CI Fork Policy"
Cohesion: 0.48
Nodes (5): enforceForkPolicyOrThrow(), isFromFork(), PullRequestInfo, pullRequestInfoFromRest(), RestPullRequest

### Community 138 - "CI Run Lock"
Cohesion: 0.48
Nodes (5): acquireLock(), isProcessAlive(), Lock, readHolder(), tryCreate()

### Community 139 - "News Route Guard Test"
Cohesion: 0.33
Nodes (4): ADR-0071, PAGES_ROOT, PROFIL_ROOT, SRC_ROOT

### Community 140 - "Google Analytics Init"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 141 - "Booking Build Smoke Test"
Cohesion: 0.33
Nodes (3): canSpawnBun(), PAGE_SOURCES, PAGES

### Community 142 - "Social Meta Build Smoke"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 143 - "Backup Compose Service"
Cohesion: 0.33
Nodes (6): command, image, profiles, secrets, volumes, backup

### Community 144 - "CMS Compose Service"
Cohesion: 0.33
Nodes (6): container_name, depends_on, env_file, image, restart, cms

### Community 145 - "Migrate Compose Service"
Cohesion: 0.33
Nodes (6): command, depends_on, env_file, image, profiles, migrate

### Community 146 - "Restore Drill Service"
Cohesion: 0.33
Nodes (6): command, image, profiles, secrets, volumes, restore-drill

### Community 147 - "Status Prose Staleness Test"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 148 - "Issue Template Config"
Cohesion: 0.33
Nodes (5): blank_issues_enabled, contact_links, about, name, url

### Community 149 - "Config Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 150 - "Gerbang Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 151 - "Document Audit Tests"
Cohesion: 0.33
Nodes (4): cleanup, ADR-0042, run(), SCRIPT

### Community 152 - "Release Audit Tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 153 - "Bun Runtime Smoke Test"
Cohesion: 0.33
Nodes (4): GOOD, ADR-0002, REPO_ROOT, SCRIPT

### Community 154 - "Promo Popup"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 155 - "Null Contact Fallback Test"
Cohesion: 0.40
Nodes (3): canSpawnBun(), FIXTURE_PATH, SITE_TS_PATH

### Community 157 - "Dependency Overrides"
Cohesion: 0.40
Nodes (5): overrides, sharp, shell-quote, smol-toml, source-map-js

### Community 158 - "Base TSConfig Options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 160 - "Knowledge Graph Update"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 161 - "Order Serialization Helpers"
Cohesion: 0.50
Nodes (4): buildPaymentInstructions(), maskPhone(), serializeOrder(), storeSettings()

### Community 162 - "Build ID Writer"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 163 - "Share Button Build Smoke"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 164 - "Listen Feature Build Smoke"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 165 - "Institution Logo Build Smoke"
Cohesion: 0.50
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 168 - "Bun Runtime Smoke Script"
Cohesion: 0.83
Nodes (3): fail(), smoke-bun-runtime.sh script, usage()

### Community 176 - "Workspace Definitions"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **74 isolated node(s):** `ADR-0007`, `../config/tsconfig.base.json`, `ES2024`, `src/**/*`, `ADR-0007` (+69 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 1307 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **20 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Analytics Build Smoke Tests` to `Dependency Freshness Report`, `CI Audit Exceptions`, `Template Init and Seeding Tests`, `Profile Build Output Assertions`, `Booking Build Smoke Test`, `Social Meta Build Smoke`, `Release Image Signing`, `Document Audit Tests`, `Release Audit Tests`, `Null Contact Fallback Test`, `Sidebar Build Smoke Test`, `Knowledge Graph Update`, `Build ID Writer`, `Share Button Build Smoke`, `Listen Feature Build Smoke`, `Institution Logo Build Smoke`, `Translation Mirror Checks`, `Bundle Build Smoke Test`, `Affiliate Build Smoke Test`, `Account Dashboard Build Smoke`, `Local CI Orchestration`, `Storefront Build Smoke Tests`, `CI Runner Utilities`, `Release Evidence and Tagging`, `Changelog Release Notes`, `Security Baseline and CodeQL`, `CI Watch and State Hashing`, `Deploy Preflight Checks`, `MySQL Dump Reader`, `Legacy Import CLI Commands`, `Production Deploy Tests`, `E2E Build and Serve Harness`, `Root Package Manifest`?**
  _High betweenness centrality (0.190) - this node is a cross-community bridge._
- **What connects `ADR-0007`, `../config/tsconfig.base.json`, `ES2024` to the rest of the system?**
  _74 weakly-connected nodes found - possible missing edges._
- **Should `Booking Actions and Contract` be split into smaller, more focused modules?**
  _Cohesion score 0.05826330532212885 - nodes in this community are weakly interconnected._
- **Why does `ADR-0018` connect `Template Init and Seeding Tests` to `Build Profile Configuration`, `CMS Seed Script`, `Profile Build Output Assertions`, `Astro Profile Integration`?**
  _High betweenness centrality (0.106) - this node is a cross-community bridge._
- **Should `Dependency Freshness Report` be split into smaller, more focused modules?**
  _Cohesion score 0.060784313725490195 - nodes in this community are weakly interconnected._
- **Why does `ROUTES` connect `Site Header and Layout Components` to `Booking Actions and Contract`, `News Search Page`, `News Rubric and Archive Pages`, `Build Profile Configuration`, `News Footer and Region Data`, `OTP and Idempotency Keys`, `News Route Guard Test`, `Profile Build Output Assertions`, `Marketing Flash Sales and Popups`, `Article Card and View`, `Site Config and RSS Feed`, `Partner Institutions and Media`, `Ad Placements and Blog API`, `Order Status Rendering`, `News Article Structured Data`, `App Install Help Page`, `Product Cards and Schema`, `Social Meta Tags`, `Accessibility and Navigation E2E`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Should `CMS Seed Script` be split into smaller, more focused modules?**
  _Cohesion score 0.05540499849442939 - nodes in this community are weakly interconnected._