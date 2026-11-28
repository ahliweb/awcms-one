# Graph Report - .  (2026-11-28)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3761 nodes · 9100 edges · 162 communities (143 shown, 19 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 72 edges (avg confidence: 0.62)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `919fd2b7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- OpenGrep SAST scan and adoption baseline
- Booking contract and account reservations
- Dependency freshness report tooling
- CMS seed CLI
- Portable text, media and wishlist rendering
- Account sign-in, reviews and messages client
- Seed profile CLI
- Storefront dev stub server (awcms API)
- Site identity composition
- News feed, rubric pages and pagination
- Marketing data client
- Dev server routing & Daerah panel
- Reading-preferences settings and early apply
- Account API client
- News navigation
- Local CI fork and git helpers
- Storefront API client and booking search
- Account contract types (akun-kontrak)
- AWCMS pages, analytics and environment access
- Bun-only deployment manifest gate tests
- Release & changeset tooling
- Article/video schema & breadcrumbs
- Booking order form script
- Commerce catalog wire types
- BPS archive file layout
- Root package.json manifest
- Shared profile-route test harness
- Share-row (bagikan) tests
- Site build-profile config and robots
- BPS population pipeline
- BPS extract checks and metadata
- Sitemap XML rendering
- News feed and rubric data
- First-party analytics beacon
- Blog & ad-placement fetch helpers
- Release image build tooling
- Push enrolment and sign-out flow
- Checkout region & courier lookups
- Product listing filters & sort
- Storefront package.json manifest
- Gate library and docs-translation audit
- BPS table row fixtures
- BPS fetch and district selection
- Docs audit gate (audit:dokumen)
- Knowledge-graph gate (audit:graf)
- Order status pages and rendering
- Push browser ports and platform detection
- BPS fetch client tests
- Seed-profile validation tests
- Cart contract and cart client
- Customer push device and status contract
- Legacy seputarborneo importer
- Account contract and session storage keys
- Storefront build smoke tests and stub lifecycle
- Storefront theme and brand tokens
- BPS region discovery
- Checkout flow, loyalty points and phone input
- Analytics, media CSP and toko origin
- Release evidence and latest-flag tooling
- Single-flight guard and account messages
- Docs i18n mirror stamping
- BPS archive and checksums
- Profile navigation and routes
- Site theme extraction and API origin
- Push enrolment flow and keys
- Obsidian export tool
- BPS extract test fixtures
- Astro profile route injection
- Ad popup widget
- BPS cell and row parsing
- News navigation tree selectors
- E2E global setup
- Redirect import push tool
- Affiliate contract and referral capture
- Deploy preflight reporter tests
- Account address book
- Read-aloud (dengar) player
- E2E accessibility and responsive specs
- WhatsApp fallback and account status labels
- Cart page script and WhatsApp fallback
- Graph audit and analytics build smoke tests
- Reading-preferences panel e2e
- Booking e2e helpers
- MySQL dump reader
- Release audit gate and script standards
- BPS region extraction
- Legacy importer tests
- PWA web manifest
- Deploy scenario test harness
- Product detail variant pricing
- Root package manifest
- Lockfile consistency check
- Base tsconfig compiler options
- Deploy shell common library
- E2E ports and global setup entry
- Release notes tooling and toolchain checks
- BPS district job planning
- CMS API fetch client
- Push browser port permissions and subscription
- Reading-preferences CSS invariants test
- Storefront tsconfig compiler options
- kontrak package manifest
- Production compose file tests
- Subtree-write guard tests
- Product JSON-LD and catalog
- Push worker tests
- Address region selector
- Local CI leg definitions
- Polite HTTP client for BPS
- Booking and notification e2e tests
- Single-flight contract test
- Obsidian export tool tests
- BPS table and region index
- runExport
- Push-only service worker click handling
- No-prerender guard tests
- BPS publication discovery
- Push stub server
- Latest news widget
- News search page
- Contract import-direction test
- Local CI Bun version pin
- Local CI run lock
- Shared test profile setup
- Booking pages build smoke tests
- Social-meta build-smoke test
- Stale-phrase prose check
- packages/config manifest
- packages/gerbang manifest
- Docs audit test suite
- Release audit tests
- GA init script
- Promo popup script
- Contact fallback when unset test
- Sidebar build smoke test
- Root dependency overrides
- Kontrak tsconfig compiler options
- Env-example coverage test
- Graph-update tool (knowledge:graph:update)
- Build id writer
- Share-button build smoke test
- Listen-button build smoke test
- Footer contrast test
- Institution logo build smoke test
- Lynx direction doc test
- Production job-runner script
- BPS extractor region index types
- README screenshots script
- Package page build smoke test
- Early-apply script route
- Affiliate page build smoke test
- Account dashboard build smoke test
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
- `git()` --calls--> `gitRunOrThrow()`  [EXTRACTED]
  tools/rilis.mjs → packages/gerbang/lib/git.mjs
- `resolveBuildId()` --references--> `bun`  [EXTRACTED]
  apps/storefront/scripts/write-build-id.mjs → package.json
- `startStub()` --indirect_call--> `chunk()`  [INFERRED]
  tools/ci/runners/template.ts → apps/storefront/src/lib/awcms/media.ts
- `ageByRegionColumns()` --indirect_call--> `region()`  [INFERRED]
  tools/bps-population/extract/tables.ts → apps/storefront/tests/wilayah-checkout.test.ts
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (162 total, 19 thin omitted)

### Community 0 - "OpenGrep SAST scan and adoption baseline"
Cohesion: 0.06
Nodes (68): redactLine(), redactText(), valid, ADR-0060, ADR-0060, fakeBearerValue, fakeDsnPassword, fakeGithubToken (+60 more)

### Community 1 - "Booking contract and account reservations"
Cohesion: 0.06
Nodes (77): ADR-0045, HasilBayar, labelTombolBayar(), mulaiPembayaranGateway(), alasanTidakBisaBatal(), bandingkanUang(), BarisUang, BOOKING_AKTIF_KEY (+69 more)

### Community 2 - "Dependency freshness report tooling"
Cohesion: 0.06
Nodes (81): fixture(), FIXTURES, HOLD, json(), argValue(), collectAdvisories(), collectBun(), collectImageRefs() (+73 more)

### Community 3 - "CMS seed CLI"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 4 - "Portable text, media and wishlist rendering"
Cohesion: 0.05
Nodes (67): chunk(), fetchMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests(), resolvedCache (+59 more)

### Community 5 - "Account sign-in, reviews and messages client"
Cohesion: 0.05
Nodes (64): mintaKode(), OtpChannel, Percakapan, PercakapanHalaman, UlasanAkun, buatKunciBaru(), buatPengelolaKunci(), galatKonflikKunci() (+56 more)

### Community 6 - "Seed profile CLI"
Cohesion: 0.06
Nodes (57): ADR-0018, canSpawnBun(), NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), applyPlan(), describeChecklist(), POST_INIT_CHECKLIST, applyColorDefaults() (+49 more)

### Community 7 - "Storefront dev stub server (awcms API)"
Cohesion: 0.06
Nodes (67): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), bookingStub, buildAffiliateLink(), buildCourierOptions(), buildPaymentInstructions(), computeQuote() (+59 more)

### Community 8 - "Site identity composition"
Cohesion: 0.07
Nodes (35): socialIcons, tokoAktif, rubrikColumn, year, [], channelCandidates, footerLinks, publishedSlugs (+27 more)

### Community 9 - "News feed, rubric pages and pagination"
Cohesion: 0.05
Nodes (61): absoluteUrl(), RawTerm, AuthorArchive, BeritaFeedItem, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs() (+53 more)

### Community 10 - "Marketing data client"
Cohesion: 0.05
Nodes (51): getActiveAdPlacements(), getAdSlot(), getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale (+43 more)

### Community 11 - "Dev server routing & Daerah panel"
Cohesion: 0.06
Nodes (59): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+51 more)

### Community 12 - "Reading-preferences settings and early apply"
Cohesion: 0.07
Nodes (44): ADR-0057, A11Y_CHANGE_EVENT, A11Y_STORAGE_KEY, A11Y_STORAGE_VERSION, A11yPreferences, applyPreferences(), ATTRIBUTES, AttributeTarget (+36 more)

### Community 13 - "Account API client"
Cohesion: 0.10
Nodes (54): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilDetailReservasi(), ambilKomisiAfiliasi(), ambilKuotaPembatalan(), ambilPercakapan() (+46 more)

### Community 14 - "News navigation"
Cohesion: 0.06
Nodes (45): daerahActive, getAllInstitutions(), RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary() (+37 more)

### Community 15 - "Local CI fork and git helpers"
Cohesion: 0.10
Nodes (41): gitRunOrThrow(), main(), parseArgs(), main(), parseArgs(), hasRecordedResult(), listOpenPrs(), main() (+33 more)

### Community 16 - "Storefront API client and booking search"
Cohesion: 0.06
Nodes (49): buatPathPesan(), formatTanggalPendek(), KetersediaanMenginap, KuotaBooking, labelZonaWaktu(), nomorHari(), parseParamCari(), parseParamPesan() (+41 more)

### Community 17 - "Account contract types (akun-kontrak)"
Cohesion: 0.09
Nodes (33): simpanWishlistAkun(), Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun (+25 more)

### Community 18 - "AWCMS pages, analytics and environment access"
Cohesion: 0.08
Nodes (31): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+23 more)

### Community 19 - "Bun-only deployment manifest gate tests"
Cohesion: 0.07
Nodes (37): ADR-0049, activeLines(), argDefaults(), COMPOSE_FILES, composeViolations(), countOf(), DOCKERFILES, dockerfileStageViolations() (+29 more)

### Community 20 - "Release & changeset tooling"
Cohesion: 0.09
Nodes (38): changelogSection(), findChangelogHeadings(), normalizeLineEndings(), normalizeRequestedVersion(), CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile() (+30 more)

### Community 21 - "Article/video schema & breadcrumbs"
Cohesion: 0.08
Nodes (35): ResolvedMedia, getRelatedPosts(), PostDetail, ADR-0109, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema() (+27 more)

### Community 22 - "Booking order form script"
Cohesion: 0.12
Nodes (41): buatHoldAktif(), parseHoldAktif(), pengumumanAmbang(), sidikPermintaan(), teksSisa(), comparePrices(), formatDiscountPercent(), formatPrice() (+33 more)

### Community 23 - "Commerce catalog wire types"
Cohesion: 0.06
Nodes (33): assertNeverProductStatus(), buildPriceTiers(), buildProdukIndex(), CategoryNode, collectCategorySubtreeIds(), CommerceBundle, CommerceBundleComponent, CommercePage (+25 more)

### Community 24 - "BPS archive file layout"
Cohesion: 0.07
Nodes (43): candidate(), deps(), ARCHIVE_FILE_NAME, ArchiveKind, ArchiveOutcome, ArchivePlacement, ArchiveRecord, ArchiveScope (+35 more)

### Community 25 - "Root package.json manifest"
Cohesion: 0.05
Nodes (43): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+35 more)

### Community 26 - "Shared profile-route test harness"
Cohesion: 0.12
Nodes (29): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, isSiteProfile() (+21 more)

### Community 27 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 28 - "Site build-profile config and robots"
Cohesion: 0.07
Nodes (30): CSP_NEEDS, CspNeeds, cspNeedsFor(), describeProfile(), FeedEntry, FEEDS, feedsFor(), FooterPageLink (+22 more)

### Community 29 - "BPS population pipeline"
Cohesion: 0.10
Nodes (38): harness(), normaliseRemoteRoot(), ARCHIVE_SCRIPT, archiveStepArgv(), emptyPipelineState(), EXTRACT_SCRIPT, extractStepArgv(), formatLogLine() (+30 more)

### Community 30 - "BPS extract checks and metadata"
Cohesion: 0.10
Nodes (38): attributionSentence(), cacheDir(), coverageOfDomain(), districtCoverMismatch(), DistrictRecord, findRecord(), FrontMatter, frontMatterText() (+30 more)

### Community 31 - "Sitemap XML rendering"
Cohesion: 0.09
Nodes (31): SITEMAP_SOURCES, DEFAULT_IDENTITY, DefaultIdentity, siteConfig, siteUrl, mergeSiteIdentity(), parseSocialLinks(), chunkSitemapEntries() (+23 more)

### Community 32 - "News feed and rubric data"
Cohesion: 0.09
Nodes (25): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+17 more)

### Community 33 - "First-party analytics beacon"
Cohesion: 0.08
Nodes (22): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+14 more)

### Community 34 - "Blog & ad-placement fetch helpers"
Cohesion: 0.09
Nodes (26): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getAllPosts(), getAllTerms() (+18 more)

### Community 35 - "Release image build tooling"
Cohesion: 0.14
Nodes (32): ADR-0020, gitRun(), cosignSign(), cosignVerify(), ensureBuilder(), fail(), headIsExactlyTag(), log() (+24 more)

### Community 36 - "Push enrolment and sign-out flow"
Cohesion: 0.09
Nodes (25): adalah401(), adalah404(), bersihkanLokalBilaPerlu(), cabutPerangkatLain(), DepsPush, keluarAman(), keluarLokal(), LanggananInfo (+17 more)

### Community 37 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 38 - "Product listing filters & sort"
Cohesion: 0.10
Nodes (31): filterProdukIndex(), normalizeSearchTerm(), paginateProdukIndex(), ProductSort, ProdukIndexEntry, ProdukIndexFilter, emptyState, grid (+23 more)

### Community 39 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 40 - "Gate library and docs-translation audit"
Cohesion: 0.14
Nodes (27): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+19 more)

### Community 41 - "BPS table row fixtures"
Cohesion: 0.22
Nodes (34): row(), ageBandKey(), cx(), headerWords(), labelColumnCount(), nearestMarker(), ageByRegionColumns(), basisOf() (+26 more)

### Community 42 - "BPS fetch and district selection"
Cohesion: 0.14
Nodes (32): arg(), Ctx, districtJobs(), fmt(), main(), Office, provinceCodes(), provinceFull() (+24 more)

### Community 43 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.14
Nodes (31): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+23 more)

### Community 44 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.11
Nodes (28): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+20 more)

### Community 45 - "Order status pages and rendering"
Cohesion: 0.12
Nodes (26): AkunPesananHalaman, ambilPesananAkunByKode(), createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, getOrder() (+18 more)

### Community 46 - "Push browser ports and platform detection"
Cohesion: 0.16
Nodes (28): ambilPemberitahuan(), buatPortPenanda(), pushDidukungPeramban(), deteksiPlatform(), KeadaanPush, perangkatIni(), PESAN_PEMBERITAHUAN, tujuanDitawarkan() (+20 more)

### Community 47 - "BPS fetch client tests"
Cohesion: 0.11
Nodes (24): acquire(), DOWNLOAD_CONCURRENCY, HELP, ClientOptions, DownloadResult, pdfPages(), sha256File(), StallError (+16 more)

### Community 48 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 49 - "Cart contract and cart client"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 50 - "Customer push device and status contract"
Cohesion: 0.16
Nodes (25): DeskripsiTujuan, HasilMuat, iosMendukungPush(), isPushPurpose(), isRecord(), kunciSama(), kunciServerKeBytes(), LingkunganPush (+17 more)

### Community 51 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (26): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+18 more)

### Community 52 - "Account contract and session storage keys"
Cohesion: 0.16
Nodes (22): hapusSesi(), adaPenandaPush(), bersihkanSebelumSesiBaru(), keluarDenganPush(), keluarLokalDenganPush(), muatAlur(), prerender, hideSubmitError() (+14 more)

### Community 53 - "Storefront build smoke tests and stub lifecycle"
Cohesion: 0.11
Nodes (13): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+5 more)

### Community 54 - "Storefront theme and brand tokens"
Cohesion: 0.14
Nodes (18): chunk(), crc32(), CRC_TABLE, encodePng(), GLYPHS, hexToRgb(), iconInitial(), IconSpec (+10 more)

### Community 55 - "BPS region discovery"
Cohesion: 0.15
Nodes (21): main(), OUT, Probe, ROOT, WILAYAH, ChallengeError, coreName(), matchTitle() (+13 more)

### Community 56 - "Checkout flow, loyalty points and phone input"
Cohesion: 0.17
Nodes (18): ADR-0043, PESANAN_PHONE_KEY, bacaPoinInput(), bolehPakaiPoin(), parsePoinAkun(), perkiraanDiskonPoin(), pesanKesalahanPoin(), PoinAkun (+10 more)

### Community 57 - "Analytics, media CSP and toko origin"
Cohesion: 0.14
Nodes (15): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, buildCspOriginsArtifact(), collectOrigins(), CspOriginsArtifact, originOf(), ADR-0002 (+7 more)

### Community 58 - "Release evidence and latest-flag tooling"
Cohesion: 0.21
Nodes (18): gitRunInherit(), buildEvidence(), validateEvidence(), computeLatestFlag(), deriveImageTags(), highestTag(), imageRepository(), isValidTag() (+10 more)

### Community 59 - "Single-flight guard and account messages"
Cohesion: 0.12
Nodes (17): buatPenjagaDom(), buatPenjagaTunggal(), HasilJalan, KaitPenjaga, KeadaanPenjaga, OpsiJalan, OpsiPenjagaDom, OpsiPenjagaUntuk (+9 more)

### Community 60 - "Docs i18n mirror stamping"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 61 - "BPS archive and checksums"
Cohesion: 0.12
Nodes (21): ITEM, LOCAL, NO_REGIONS, PDF_BYTES, SHA, ArchiveDeps, archiveOne(), compareVerification() (+13 more)

### Community 62 - "Profile navigation and routes"
Cohesion: 0.13
Nodes (18): DEFAULT_SITE_PROFILE, FEEDS_ALL, FOOTER_PAGE_LINKS, GROUP_STYLESHEETS, NavItem, PRIMARY_NAV, PROFILE_NAV, PROFILE_NAV_DYNAMIC (+10 more)

### Community 63 - "Site theme extraction and API origin"
Cohesion: 0.16
Nodes (16): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, contrastingForeground() (+8 more)

### Community 64 - "Push enrolment flow and keys"
Cohesion: 0.13
Nodes (16): base64Url(), buatPortPeramban(), HasilAktifkan, HasilKeluar, HasilMatikan, HasilSesiBaru, infoDari(), PortPemberitahuan (+8 more)

### Community 65 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 66 - "BPS extract test fixtures"
Cohesion: 0.17
Nodes (18): ctxOf(), fixture(), pageOf(), snakeCase(), absDiff(), CheckFailure, CheckReport, dedupe() (+10 more)

### Community 67 - "Astro profile route injection"
Cohesion: 0.18
Nodes (16): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+8 more)

### Community 68 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 69 - "BPS cell and row parsing"
Cohesion: 0.19
Nodes (18): CellKind, indonesianPart(), isCellToken(), isIndexToken(), numeric(), parseCell(), ParsedCell, analysePage() (+10 more)

### Community 70 - "News navigation tree selectors"
Cohesion: 0.16
Nodes (17): flattenRubrikTree(), getRubrikTree(), paginate(), getNavUtama(), getUmumList(), getStaticPaths(), canonicalPath, getStaticPaths() (+9 more)

### Community 71 - "E2E global setup"
Cohesion: 0.19
Nodes (16): api(), chooseAndEnable(), CORS(), enrolled(), enrolledOnAccount(), failRegistration(), installPushMock(), login() (+8 more)

### Community 72 - "Redirect import push tool"
Cohesion: 0.15
Nodes (18): chunkIdempotencyKey(), ChunkOutcome, chunkRedirects(), FileWideDuplicate, findFileWideDuplicates(), ImportErrorEnvelope, ImportItemReport, ImportPoster (+10 more)

### Community 73 - "Affiliate contract and referral capture"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 74 - "Deploy preflight reporter tests"
Cohesion: 0.20
Nodes (15): ADR-0002, createReporter(), checkDistForToken(), checkStorefrontEnvShape(), collectFiles(), isHttpsUrl(), loadEnv(), looksLikeToken() (+7 more)

### Community 75 - "Account address book"
Cohesion: 0.26
Nodes (16): Alamat, AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate() (+8 more)

### Community 76 - "Read-aloud (dengar) player"
Cohesion: 0.21
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 77 - "E2E accessibility and responsive specs"
Cohesion: 0.18
Nodes (11): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, firstSlug(), KEY_PAGES, KeyPage, keyPagesFor(), VIEWPORTS (+3 more)

### Community 78 - "WhatsApp fallback and account status labels"
Cohesion: 0.22
Nodes (15): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+7 more)

### Community 79 - "Cart page script and WhatsApp fallback"
Cohesion: 0.19
Nodes (15): Cart, CartLineRequest, CartQuote, quoteCart(), QuoteLine, buildWhatsappCartMessage(), lineText(), hideQuoteError() (+7 more)

### Community 80 - "Graph audit and analytics build smoke tests"
Cohesion: 0.14
Nodes (8): canSpawnBun(), runBuild(), canSpawnBun(), bun, cleanup, fixture(), run(), SCRIPT

### Community 81 - "Reading-preferences panel e2e"
Cohesion: 0.16
Nodes (14): axePanel(), axeSerious(), describeViolations(), fab(), FAILING_IMPACT, htmlAttribute(), openPanel(), panel() (+6 more)

### Community 82 - "Booking e2e helpers"
Cohesion: 0.17
Nodes (11): api(), confirmed(), day(), hold(), login(), payDeposit(), [R1, R2], register() (+3 more)

### Community 83 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 84 - "Release audit gate and script standards"
Cohesion: 0.14
Nodes (8): dated, oldest, pending, reporter, todayIso, formatReport(), SCRIPT_DIRS, scripts

### Community 85 - "BPS region extraction"
Cohesion: 0.19
Nodes (14): index, buildIndex(), coreLabel(), kindFromGroupLine(), KindHint, NAME_ALIASES, normalizeLabel(), parentCode() (+6 more)

### Community 86 - "Legacy importer tests"
Cohesion: 0.28
Nodes (12): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+4 more)

### Community 87 - "PWA web manifest"
Cohesion: 0.23
Nodes (11): SITE_PROFILE, buildManifest(), ICON_PATHS, MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, ManifestInput, PROFILE_CATEGORIES (+3 more)

### Community 88 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 89 - "Product detail variant pricing"
Cohesion: 0.23
Nodes (12): CommerceProductVariant, findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload (+4 more)

### Community 90 - "Root package manifest"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 91 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 92 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 93 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 94 - "E2E ports and global setup entry"
Cohesion: 0.26
Nodes (8): buildAndServe(), BuildAndServeOptions, BuiltSite, waitForHttp(), globalSetup(), PREVIEW_PORT, STUB_PORT, ADR-0007

### Community 95 - "Release notes tooling and toolchain checks"
Cohesion: 0.18
Nodes (8): ADR-0021, ADR-0023, WORKFLOWS_DIR, orchestrate, pkg, VERSION, { file, version }, text

### Community 96 - "BPS district job planning"
Cohesion: 0.23
Nodes (11): blankDistrict(), DistrictJob, districtPdfPath(), listFor(), listKecamatan(), DistrictMatch, districtPdfName(), DistrictRegion (+3 more)

### Community 97 - "CMS API fetch client"
Cohesion: 0.21
Nodes (10): collectPendingAssignments(), runAssignInstitutions(), termMapHintFor(), apiCall(), ApiResult, assertOk(), AwcmsApiError, resolveExistingTenantSession() (+2 more)

### Community 98 - "Push browser port permissions and subscription"
Cohesion: 0.27
Nodes (4): aktifkanPerangkat(), PortPeramban, petakanGalatPeramban(), TeksPersetujuan

### Community 99 - "Reading-preferences CSS invariants test"
Cohesion: 0.20
Nodes (8): ATTRIBUTE_SECTION, CSS, GLOBAL_CSS, OS_SECTION, PANEL, RAW_CSS, section(), ADR-0057

### Community 100 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 101 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 102 - "Production compose file tests"
Cohesion: 0.18
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 103 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 104 - "Product JSON-LD and catalog"
Cohesion: 0.33
Nodes (6): CommerceCategory, CommerceProduct, breadcrumbListNode(), buildCategoryPageSchema(), buildProductPageSchema(), ProductSchemaInput

### Community 105 - "Push worker tests"
Cohesion: 0.20
Nodes (7): PUSH_PURPOSES, PUSH_TARGET_PATHS, FakeClient, Harness, Listener, Shown, SOURCE

### Community 106 - "Address region selector"
Cohesion: 0.44
Nodes (9): applyRegionSelection(), fetchRegionJson(), fillRegionOptions(), loadKabupaten(), loadKecamatan(), loadProvinces(), RegionOption, RegionSelects (+1 more)

### Community 107 - "Local CI leg definitions"
Cohesion: 0.31
Nodes (8): EXPECTED_CONTEXTS, findLeg(), LEG_CONTEXTS, LegDefinition, LegGroup, LEGS, legsInGroup(), ADR-0021

### Community 109 - "Booking and notification e2e tests"
Cohesion: 0.28
Nodes (9): MockLog, noOverflow360(), browserPage(), noOverflow360(), open(), openDialog(), signedIn(), watch() (+1 more)

### Community 110 - "Single-flight contract test"
Cohesion: 0.28
Nodes (7): BACA_SAJA, DIKECUALIKAN, LIBS, mutasiDalam(), mutatingExports(), SCRIPTS, stripKomentar()

### Community 111 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 112 - "BPS table and region index"
Cohesion: 0.36
Nodes (8): bboxWindow(), decodeEntities(), ENTITIES, loadPages(), median(), parseBboxPages(), pdfPageCount(), Word

### Community 113 - "runExport"
Cohesion: 0.28
Nodes (9): buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), flag(), main(), runExport(), runPushRedirects(), usage(), formatPushSummary() (+1 more)

### Community 114 - "Push-only service worker click handling"
Cohesion: 0.39
Nodes (5): isRecord(), normalizePayload(), resolveTarget(), tagOf(), text()

### Community 115 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 116 - "BPS publication discovery"
Cohesion: 0.25
Nodes (8): blank(), discoverActionId(), findPublication(), listPage(), pdfPath(), processOffice(), extractActionId(), findPublicationChunk()

### Community 117 - "Push stub server"
Cohesion: 0.33
Nodes (6): APPLICATION_SERVER_KEY, CONSENT_TEXT_VERSION, createPushStub(), maskEndpoint(), PURPOSES, PUSH_HOSTS

### Community 118 - "Latest news widget"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 119 - "News search page"
Cohesion: 0.29
Nodes (5): input, matches, needle, resultsList, status

### Community 120 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 121 - "Local CI Bun version pin"
Cohesion: 0.52
Nodes (5): PKG, BunPinResult, checkBunPin(), enforceBunPinOrThrow(), readPinnedBunVersion()

### Community 122 - "Local CI run lock"
Cohesion: 0.48
Nodes (5): acquireLock(), isProcessAlive(), Lock, readHolder(), tryCreate()

### Community 123 - "Shared test profile setup"
Cohesion: 0.40
Nodes (6): activeRouteKeys(), excludedRouteKeys(), isRouteActive(), routePathPrefix(), excludedRoutesHit(), pathBelongsToRoute()

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

### Community 128 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 129 - "Docs audit test suite"
Cohesion: 0.33
Nodes (4): cleanup, ADR-0042, run(), SCRIPT

### Community 130 - "Release audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 132 - "Promo popup script"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 134 - "Contact fallback when unset test"
Cohesion: 0.40
Nodes (3): canSpawnBun(), FIXTURE_PATH, SITE_TS_PATH

### Community 136 - "Root dependency overrides"
Cohesion: 0.40
Nodes (5): overrides, sharp, shell-quote, smol-toml, source-map-js

### Community 137 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 139 - "Graph-update tool (knowledge:graph:update)"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 140 - "Build id writer"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 141 - "Share-button build smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 142 - "Listen-button build smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 144 - "Institution logo build smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 147 - "BPS extractor region index types"
Cohesion: 0.50
Nodes (4): RegionIndex, PageInfo, Ctx, Found

### Community 154 - "Workspace member globs"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **948 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+943 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **19 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Graph audit and analytics build smoke tests` to `OpenGrep SAST scan and adoption baseline`, `Docs audit test suite`, `Release audit tests`, `Dependency freshness report tooling`, `Contact fallback when unset test`, `Sidebar build smoke test`, `Seed profile CLI`, `Graph-update tool (knowledge:graph:update)`, `Build id writer`, `Share-button build smoke test`, `Listen-button build smoke test`, `Local CI fork and git helpers`, `Institution logo build smoke test`, `Release & changeset tooling`, `Package page build smoke test`, `Affiliate page build smoke test`, `Account dashboard build smoke test`, `BPS archive file layout`, `Shared profile-route test harness`, `BPS population pipeline`, `BPS extract checks and metadata`, `Release image build tooling`, `BPS fetch client tests`, `Storefront build smoke tests and stub lifecycle`, `Release evidence and latest-flag tooling`, `Deploy preflight reporter tests`, `MySQL dump reader`, `Deploy scenario test harness`, `Root package manifest`, `E2E ports and global setup entry`, `BPS table and region index`, `runExport`, `Booking pages build smoke tests`, `Social-meta build-smoke test`?**
  _High betweenness centrality (0.324) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Seed profile CLI` to `Astro profile route injection`, `CMS seed CLI`, `Site identity composition`, `Shared profile-route test harness`, `Site build-profile config and robots`, `Profile navigation and routes`?**
  _High betweenness centrality (0.103) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site identity composition` to `News feed and rubric data`, `Booking contract and account reservations`, `Blog & ad-placement fetch helpers`, `Account sign-in, reviews and messages client`, `News navigation tree selectors`, `News feed, rubric pages and pagination`, `Marketing data client`, `Order status pages and rendering`, `News navigation`, `E2E accessibility and responsive specs`, `Account contract types (akun-kontrak)`, `Article/video schema & breadcrumbs`, `News search page`, `Shared profile-route test harness`, `Site build-profile config and robots`, `Profile navigation and routes`, `Sitemap XML rendering`?**
  _High betweenness centrality (0.084) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _948 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `OpenGrep SAST scan and adoption baseline` be split into smaller, more focused modules?**
  _Cohesion score 0.059025394646533974 - nodes in this community are weakly interconnected._
- **Should `Booking contract and account reservations` be split into smaller, more focused modules?**
  _Cohesion score 0.05966386554621849 - nodes in this community are weakly interconnected._
- **Should `Dependency freshness report tooling` be split into smaller, more focused modules?**
  _Cohesion score 0.060784313725490195 - nodes in this community are weakly interconnected._