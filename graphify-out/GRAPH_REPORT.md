# Graph Report - .  (2026-11-24)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3475 nodes · 8216 edges · 134 communities (120 shown, 14 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 67 edges (avg confidence: 0.6)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5e1f6df7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Storefront cart client and storage
- News feed, rubric and pagination
- Storefront booking contract client
- Dependency freshness report tooling
- CMS seed CLI
- Storefront dev stub server (awcms API)
- Template init planner
- Reading-preferences panel e2e
- Dev server routing & Daerah panel
- Storefront marketing data
- Storefront customer account client
- GA init script
- Storefront build-id and stub lifecycle
- Site identity composition
- News navigation
- Site theme extraction and API origin
- Storefront sign-in flow
- Gate library and docs-translation audit
- Site build-profile config
- Account contract types (akun-kontrak)
- Release & changeset tooling
- Storefront booking and reservations
- Article/video schema & breadcrumbs
- Shared profile-route test harness
- Push enrolment and sign-out flow
- Root package scripts
- Blog & ad-placement fetch helpers
- Release image build tooling
- Share-row (bagikan) tests
- Storefront shop request helpers
- Customer session & wishlist sync
- Seed-profile validation tests
- First-party analytics beacon
- News article view
- Product listing filters & sort
- Checkout region & courier lookups
- Storefront customer push
- Storefront package scripts
- Static page & portable text rendering
- Toko origin and CSP configuration
- Push browser ports and platform detection
- Document audit gate
- Knowledge-graph gate (audit:graf)
- Booking actions and CSS font test
- Shared storefront components and helpers
- Storefront cart and affiliate contracts
- E2E accessibility and responsive specs
- Legacy seputarborneo importer
- Local CI fork and git helpers
- Local CI process and port helpers
- Contract package type barrels
- E2E ports and global setup entry
- CMS API fetch client
- Single-flight guard and account messages
- Local CI PR watcher
- Booking e2e helpers
- Environment access and static page fetch
- E2E global setup
- Obsidian export tool
- Astro profile route injection
- Sitemap XML rendering
- Ad popup widget
- Release evidence and latest-flag tooling
- Region and institution lookups
- Local CI security baseline
- Read-aloud (dengar) player
- Legacy importer tests
- Build id writer script
- Account address book
- Catalog fixture tests
- Deploy preflight reporter tests
- Commerce catalog wire types
- Product price formatting
- Customer push service worker (ADR-0048)
- MySQL dump reader
- WhatsApp fallback and account status labels
- Local CI leg table (ADR-0021)
- Gate report formatter
- BPS table row fixtures
- Price formatting and flash-sale countdown
- PWA web manifest
- Deploy scenario test harness
- Product detail variant pricing
- Production compose tests
- Root package metadata
- Lockfile consistency check
- Base tsconfig compiler options
- Deploy shell common library
- Log redaction helpers
- Review list rendering and status tones
- Storefront tsconfig compiler options
- kontrak package manifest
- Subtree-write guard tests
- Push browser port permissions and subscription
- Push guard and worker configuration
- Single-flight contract test
- Obsidian export tool tests
- Local CI process fork helper
- Push-only service worker click handling
- No-prerender guard tests
- Push worker tests
- Local CI audit exceptions parser
- Customer push device and status contract
- Recent news loader
- Contract import-direction test
- Bun version pin enforcement
- Social-meta build-smoke test
- Stale-phrase prose check
- packages/config manifest
- packages/gerbang manifest
- Docs audit test suite
- Release audit tests
- Robots file route
- Promo pop-up
- Sidebar build smoke tests
- Root dependency overrides
- Kontrak tsconfig compiler options
- Env-example coverage test
- Graph-update tool (knowledge:graph:update)
- Footer contrast tests
- Privacy page build smoke tests
- Lynx direction doc test
- Production job-runner script
- Bun runtime image smoke
- Offsite backup copy script
- Workspace declaration
- Postgres least-privilege role init
- Backup compose runner
- Production deploy entrypoint
- Remote deploy trigger
- Production healthcheck
- Production rollback

## God Nodes (most connected - your core abstractions)
1. `bun` - 64 edges
2. `ROUTES` - 63 edges
3. `kirimPermintaan()` - 54 edges
4. `bacaSesi()` - 51 edges
5. `scripts` - 44 edges
6. `getSiteIdentity()` - 39 edges
7. `formatPrice()` - 37 edges
8. `authHeader()` - 37 edges
9. `denganPembersihanSesi()` - 37 edges
10. `TokoApiError` - 32 edges

## Surprising Connections (you probably didn't know these)
- `git()` --calls--> `gitRunOrThrow()`  [EXTRACTED]
  tools/rilis.mjs → packages/gerbang/lib/git.mjs
- `resolveBuildId()` --references--> `bun`  [EXTRACTED]
  apps/storefront/scripts/write-build-id.mjs → package.json
- `startStub()` --indirect_call--> `chunk()`  [INFERRED]
  tools/ci/runners/template.ts → apps/storefront/src/lib/awcms/media.ts
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json
- `updateCountdowns()` --indirect_call--> `row()`  [INFERRED]
  apps/storefront/src/scripts/akun-reservasi.ts → tests/import-seputarborneo.test.mjs

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (134 total, 14 thin omitted)

### Community 0 - "Storefront cart client and storage"
Cohesion: 0.05
Nodes (75): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+67 more)

### Community 1 - "News feed, rubric and pagination"
Cohesion: 0.04
Nodes (76): RawTerm, AuthorArchive, BeritaFeedItem, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive (+68 more)

### Community 2 - "Storefront booking contract client"
Cohesion: 0.06
Nodes (81): ADR-0045, alasanTidakBisaBatal(), bandingkanUang(), BarisUang, BOOKING_AKTIF_KEY, buatHoldAktif(), buatPathPesan(), catatanPembayaran() (+73 more)

### Community 3 - "Dependency freshness report tooling"
Cohesion: 0.06
Nodes (81): fixture(), FIXTURES, HOLD, json(), argValue(), collectAdvisories(), collectBun(), collectImageRefs() (+73 more)

### Community 4 - "CMS seed CLI"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 5 - "Storefront dev stub server (awcms API)"
Cohesion: 0.05
Nodes (71): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), bookingStub, buildAffiliateLink(), buildCourierOptions(), buildPaymentInstructions(), computeQuote() (+63 more)

### Community 6 - "Template init planner"
Cohesion: 0.06
Nodes (58): ADR-0053, canSpawnBun(), ADR-0018, NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), applyPlan(), describeChecklist(), POST_INIT_CHECKLIST (+50 more)

### Community 7 - "Reading-preferences panel e2e"
Cohesion: 0.05
Nodes (63): token(), COMPOSE_FILES, composeViolations(), DOCKERFILES, EXEMPT_DOCKERFILES, EXEMPT_IMAGE_SERVICES, isTestFixture(), MANIFESTS (+55 more)

### Community 8 - "Dev server routing & Daerah panel"
Cohesion: 0.06
Nodes (59): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+51 more)

### Community 9 - "Storefront marketing data"
Cohesion: 0.05
Nodes (53): CSP_NEEDS, getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry (+45 more)

### Community 10 - "Storefront customer account client"
Cohesion: 0.09
Nodes (64): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilDetailReservasi(), ambilKomisiAfiliasi(), ambilKuotaPembatalan(), ambilPercakapan() (+56 more)

### Community 11 - "GA init script"
Cohesion: 0.06
Nodes (45): ADR-0057, A11Y_CHANGE_EVENT, A11Y_STORAGE_KEY, A11Y_STORAGE_VERSION, A11yPreferences, applyPreferences(), ATTRIBUTES, AttributeTarget (+37 more)

### Community 12 - "Storefront build-id and stub lifecycle"
Cohesion: 0.05
Nodes (36): ADR-0036, canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), runBuild(), ARTICLE_PAGE, canSpawnBun() (+28 more)

### Community 13 - "Site identity composition"
Cohesion: 0.08
Nodes (30): socialIcons, tokoAktif, ROUTES, ADR-0018, ADR-0055, DEFAULT_IDENTITY, getStoreSettings(), ComposedSiteIdentity (+22 more)

### Community 14 - "News navigation"
Cohesion: 0.06
Nodes (47): daerahActive, getAllInstitutions(), RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary() (+39 more)

### Community 15 - "Site theme extraction and API origin"
Cohesion: 0.06
Nodes (42): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, chunk() (+34 more)

### Community 16 - "Storefront sign-in flow"
Cohesion: 0.07
Nodes (51): OtpChannel, Percakapan, PercakapanHalaman, buatKunciBaru(), buatPengelolaKunci(), galatKonflikKunci(), jawabanFinal(), KODE_KONFLIK_KUNCI (+43 more)

### Community 17 - "Gate library and docs-translation audit"
Cohesion: 0.07
Nodes (44): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+36 more)

### Community 18 - "Site build-profile config"
Cohesion: 0.06
Nodes (42): CspNeeds, cspNeedsFor(), DEFAULT_SITE_PROFILE, describeProfile(), FeedEntry, FEEDS, FEEDS_ALL, feedsFor() (+34 more)

### Community 19 - "Account contract types (akun-kontrak)"
Cohesion: 0.08
Nodes (44): keluar(), Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun (+36 more)

### Community 20 - "Release & changeset tooling"
Cohesion: 0.07
Nodes (42): ADR-0023, changelogSection(), findChangelogHeadings(), normalizeLineEndings(), normalizeRequestedVersion(), CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody() (+34 more)

### Community 21 - "Storefront booking and reservations"
Cohesion: 0.07
Nodes (46): formatTanggalPendek(), KetersediaanMenginap, KuotaBooking, labelZonaWaktu(), nomorHari(), parseParamCari(), periksaTanggal(), tanggalLokal() (+38 more)

### Community 22 - "Article/video schema & breadcrumbs"
Cohesion: 0.08
Nodes (38): absoluteUrl(), ResolvedMedia, getRelatedPosts(), PostDetail, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema() (+30 more)

### Community 23 - "Shared profile-route test harness"
Cohesion: 0.10
Nodes (34): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, activeRouteKeys() (+26 more)

### Community 24 - "Push enrolment and sign-out flow"
Cohesion: 0.08
Nodes (31): adalah401(), adalah404(), base64Url(), bersihkanLokalBilaPerlu(), cabutPerangkatLain(), DepsPush, HasilAktifkan, HasilKeluar (+23 more)

### Community 25 - "Root package scripts"
Cohesion: 0.05
Nodes (44): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+36 more)

### Community 26 - "Blog & ad-placement fetch helpers"
Cohesion: 0.08
Nodes (31): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+23 more)

### Community 27 - "Release image build tooling"
Cohesion: 0.13
Nodes (35): ADR-0020, gitRun(), cosignSign(), cosignVerify(), ensureBuilder(), fail(), headIsExactlyTag(), log() (+27 more)

### Community 28 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 29 - "Storefront shop request helpers"
Cohesion: 0.09
Nodes (28): bacaPenolakan(), bacaRingkasanPenghapusan(), isKodePenolakan(), KODE_PENOLAKAN, KodePenolakan, kodeValid(), namaBerkasEkspor(), PESAN_KODE_SALAH (+20 more)

### Community 30 - "Customer session & wishlist sync"
Cohesion: 0.14
Nodes (29): laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist(), saveWishlist() (+21 more)

### Community 31 - "Seed-profile validation tests"
Cohesion: 0.10
Nodes (31): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, canSpawn(), configFiles() (+23 more)

### Community 32 - "First-party analytics beacon"
Cohesion: 0.08
Nodes (22): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+14 more)

### Community 33 - "News article view"
Cohesion: 0.10
Nodes (26): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+18 more)

### Community 34 - "Product listing filters & sort"
Cohesion: 0.10
Nodes (31): preferredScrollBehavior(), ScrollWindow, paginateProdukIndex(), ProductSort, ProdukIndexEntry, ProdukIndexFilter, emptyState, grid (+23 more)

### Community 35 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 36 - "Storefront customer push"
Cohesion: 0.12
Nodes (33): DeskripsiTujuan, deteksiPlatform(), HasilMuat, iosMendukungPush(), isPushPurpose(), isRecord(), kunciSama(), kunciServerKeBytes() (+25 more)

### Community 37 - "Storefront package scripts"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 38 - "Static page & portable text rendering"
Cohesion: 0.12
Nodes (32): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), collectGalleryMediaObjectIds(), documentHasPlayableVideo(), escapeHtml() (+24 more)

### Community 39 - "Toko origin and CSP configuration"
Cohesion: 0.11
Nodes (22): DefaultIdentity, siteUrl, fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests() (+14 more)

### Community 40 - "Push browser ports and platform detection"
Cohesion: 0.15
Nodes (30): ambilPemberitahuan(), buatPortPenanda(), buatPortPeramban(), pushDidukungPeramban(), GalatPush, KeadaanPush, lamaTunggu(), PESAN_PEMBERITAHUAN (+22 more)

### Community 41 - "Document audit gate"
Cohesion: 0.14
Nodes (31): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+23 more)

### Community 42 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.11
Nodes (28): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+20 more)

### Community 43 - "Booking actions and CSS font test"
Cohesion: 0.14
Nodes (28): HasilBayar, labelTombolBayar(), mulaiPembayaranGateway(), buatPathDetailReservasi(), labelPembayaran(), labelStatusReservasi(), parseKodeDetail(), pesanGalatBooking() (+20 more)

### Community 44 - "Shared storefront components and helpers"
Cohesion: 0.10
Nodes (18): rubrikColumn, year, [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE (+10 more)

### Community 45 - "Storefront cart and affiliate contracts"
Cohesion: 0.12
Nodes (25): AkunPesananHalaman, createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, PESANAN_PHONE_KEY, getOrder() (+17 more)

### Community 46 - "E2E accessibility and responsive specs"
Cohesion: 0.09
Nodes (19): axePanel(), axeSerious(), describeViolations(), fab(), FAILING_IMPACT, openPanel(), panel(), PANEL_TAGS (+11 more)

### Community 47 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 48 - "Local CI fork and git helpers"
Cohesion: 0.19
Nodes (19): gitRunOrThrow(), main(), parseArgs(), main(), parseArgs(), parseGitHubRemoteUrl(), RepoRef, resolveRepo() (+11 more)

### Community 49 - "Local CI process and port helpers"
Cohesion: 0.24
Nodes (18): run(), RunOptions, runOrThrow(), RunResult, freePort(), LegContext, LegOutcome, runCheckCmsLeg() (+10 more)

### Community 50 - "Contract package type barrels"
Cohesion: 0.09
Nodes (20): assertNeverProductStatus(), CategoryNode, CommerceBundle, CommerceBundleComponent, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, isPubliclyVisible() (+12 more)

### Community 51 - "E2E ports and global setup entry"
Cohesion: 0.12
Nodes (17): run, { values }, resolveSiteProfile(), SITE_PROFILES, api(), register(), Sesi, ADR-0055 (+9 more)

### Community 52 - "CMS API fetch client"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 53 - "Single-flight guard and account messages"
Cohesion: 0.12
Nodes (17): buatPenjagaDom(), buatPenjagaTunggal(), HasilJalan, KaitPenjaga, KeadaanPenjaga, OpsiJalan, OpsiPenjagaDom, OpsiPenjagaUntuk (+9 more)

### Community 54 - "Local CI PR watcher"
Cohesion: 0.20
Nodes (17): hasRecordedResult(), listOpenPrs(), main(), OpenPr, recordResult(), ciDefinitionHash(), listFilesRecursive(), acquireLock() (+9 more)

### Community 55 - "Booking e2e helpers"
Cohesion: 0.13
Nodes (14): api(), browserPage(), confirmed(), day(), hold(), login(), open(), payDeposit() (+6 more)

### Community 56 - "Environment access and static page fetch"
Cohesion: 0.15
Nodes (16): SITEMAP_SOURCES, detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), listStaticPages(), StaticPageDetail (+8 more)

### Community 57 - "E2E global setup"
Cohesion: 0.16
Nodes (16): api(), chooseAndEnable(), CORS(), enrolled(), enrolledOnAccount(), failRegistration(), installPushMock(), login() (+8 more)

### Community 58 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 59 - "Astro profile route injection"
Cohesion: 0.18
Nodes (16): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+8 more)

### Community 60 - "Sitemap XML rendering"
Cohesion: 0.22
Nodes (16): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests(), resetSitemapSourcesForTests() (+8 more)

### Community 61 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 62 - "Release evidence and latest-flag tooling"
Cohesion: 0.26
Nodes (15): gitRunInherit(), computeLatestFlag(), runCapture(), runCaptureOrThrow(), deriveImageTags(), highestTag(), isValidTag(), matchesOwnRelease() (+7 more)

### Community 63 - "Region and institution lookups"
Cohesion: 0.16
Nodes (15): chunk(), fetchMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests(), resolvedCache (+7 more)

### Community 64 - "Local CI security baseline"
Cohesion: 0.20
Nodes (14): BaselineEntry, isBaselined(), parseBaseline(), partitionHighSeverityFindings(), SecurityFinding, CODEQL_CLI_SHA256, CODEQL_CLI_VERSION, CODEQL_JS_QUERY_PACK (+6 more)

### Community 65 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 66 - "Legacy importer tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 67 - "Build id writer script"
Cohesion: 0.10
Nodes (12): buildId, OUT_PATH, resolveBuildId(), cleanup, fixture(), run(), SCRIPT, GOOD (+4 more)

### Community 68 - "Account address book"
Cohesion: 0.26
Nodes (16): Alamat, AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate() (+8 more)

### Community 69 - "Catalog fixture tests"
Cohesion: 0.15
Nodes (11): buildCategoryTree(), buildPriceTiers(), buildProdukIndex(), getCategories(), getCategoryBySlug(), primaryProductImage(), PRODUK_PAGE_SIZE, GET() (+3 more)

### Community 70 - "Deploy preflight reporter tests"
Cohesion: 0.22
Nodes (14): createReporter(), checkDistForToken(), checkStorefrontEnvShape(), collectFiles(), isHttpsUrl(), loadEnv(), looksLikeToken(), main() (+6 more)

### Community 71 - "Commerce catalog wire types"
Cohesion: 0.20
Nodes (10): collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, productsInCategory(), BreadcrumbItem, breadcrumbListNode(), buildCategoryPageSchema(), buildProductPageSchema() (+2 more)

### Community 72 - "Product price formatting"
Cohesion: 0.23
Nodes (12): filterProdukIndex(), normalizeSearchTerm(), comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003 (+4 more)

### Community 73 - "Customer push service worker (ADR-0048)"
Cohesion: 0.14
Nodes (11): ADR-0049, prerender, ADR-0048, dockerfile, DOCKERFILE_PATH, REPO_ROOT, code(), files (+3 more)

### Community 74 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 75 - "WhatsApp fallback and account status labels"
Cohesion: 0.22
Nodes (14): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+6 more)

### Community 76 - "Local CI leg table (ADR-0021)"
Cohesion: 0.18
Nodes (12): ADR-0021, EXPECTED_CONTEXTS, orchestrate, pkg, VERSION, findLeg(), LEG_CONTEXTS, LegDefinition (+4 more)

### Community 77 - "Gate report formatter"
Cohesion: 0.14
Nodes (8): dated, oldest, pending, reporter, todayIso, formatReport(), SCRIPT_DIRS, scripts

### Community 78 - "BPS table row fixtures"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 79 - "Price formatting and flash-sale countdown"
Cohesion: 0.20
Nodes (8): getProduct(), getProducts(), labelClassName(), GET(), prerender, getStaticPaths(), formatRemaining(), tick()

### Community 80 - "PWA web manifest"
Cohesion: 0.23
Nodes (11): SITE_PROFILE, buildManifest(), ICON_PATHS, MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, ManifestInput, PROFILE_CATEGORIES (+3 more)

### Community 81 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 82 - "Product detail variant pricing"
Cohesion: 0.23
Nodes (12): CommerceProductVariant, findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload (+4 more)

### Community 83 - "Production compose tests"
Cohesion: 0.15
Nodes (7): ADR-0019, ADR-0160, ADR-0162, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 84 - "Root package metadata"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 85 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 86 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 87 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 88 - "Log redaction helpers"
Cohesion: 0.32
Nodes (7): redactLine(), redactText(), fakeBearerValue, fakeDsnPassword, fakeGithubToken, redact(), main()

### Community 89 - "Review list rendering and status tones"
Cohesion: 0.29
Nodes (10): UlasanAkun, hideSubmitError(), loadList(), render(), renderItem(), root, showGuestView(), starRow() (+2 more)

### Community 90 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 91 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 92 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 94 - "Push guard and worker configuration"
Cohesion: 0.33
Nodes (6): adaPenanda(), jagaPenandaPush(), PUSH_WORKER_PATH, PUSH_WORKER_SCOPE, PUSH_MARKER_KEY, PUSH_NOTICE_KEY

### Community 95 - "Single-flight contract test"
Cohesion: 0.28
Nodes (7): BACA_SAJA, DIKECUALIKAN, LIBS, mutasiDalam(), mutatingExports(), SCRIPTS, stripKomentar()

### Community 96 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 97 - "Local CI process fork helper"
Cohesion: 0.39
Nodes (7): enforceForkPolicyOrThrow(), fetchPullRequestInfo(), ghApiJson(), isFromFork(), PullRequestInfo, pullRequestInfoFromRest(), RestPullRequest

### Community 98 - "Push-only service worker click handling"
Cohesion: 0.39
Nodes (5): isRecord(), normalizePayload(), resolveTarget(), tagOf(), text()

### Community 99 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 100 - "Push worker tests"
Cohesion: 0.25
Nodes (5): FakeClient, Harness, Listener, Shown, SOURCE

### Community 101 - "Local CI audit exceptions parser"
Cohesion: 0.46
Nodes (6): valid, AuditException, auditIgnoreArgs(), loadAuditIgnoreArgs(), parseAuditExceptions(), runBunAuditWithExceptions()

### Community 102 - "Customer push device and status contract"
Cohesion: 0.33
Nodes (6): APPLICATION_SERVER_KEY, CONSENT_TEXT_VERSION, createPushStub(), maskEndpoint(), PURPOSES, PUSH_HOSTS

### Community 103 - "Recent news loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 104 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 105 - "Bun version pin enforcement"
Cohesion: 0.52
Nodes (5): PKG, BunPinResult, checkBunPin(), enforceBunPinOrThrow(), readPinnedBunVersion()

### Community 106 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 107 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 108 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 109 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 110 - "Docs audit test suite"
Cohesion: 0.33
Nodes (4): cleanup, ADR-0042, run(), SCRIPT

### Community 111 - "Release audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 112 - "Robots file route"
Cohesion: 0.40
Nodes (3): ROBOTS_DISALLOW, siteConfig, prerender

### Community 113 - "Promo pop-up"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 115 - "Root dependency overrides"
Cohesion: 0.40
Nodes (5): overrides, sharp, shell-quote, smol-toml, source-map-js

### Community 116 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 118 - "Graph-update tool (knowledge:graph:update)"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 123 - "Bun runtime image smoke"
Cohesion: 0.83
Nodes (3): fail(), smoke-bun-runtime.sh script, usage()

### Community 125 - "Workspace declaration"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **922 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+917 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Storefront build-id and stub lifecycle` to `Dependency freshness report tooling`, `Template init planner`, `Release & changeset tooling`, `Shared profile-route test harness`, `Release image build tooling`, `Seed-profile validation tests`, `Local CI fork and git helpers`, `Local CI process and port helpers`, `E2E ports and global setup entry`, `Release evidence and latest-flag tooling`, `Local CI security baseline`, `Build id writer script`, `Deploy preflight reporter tests`, `MySQL dump reader`, `BPS table row fixtures`, `Deploy scenario test harness`, `Root package metadata`, `Local CI process fork helper`, `Local CI audit exceptions parser`, `Social-meta build-smoke test`, `Docs audit test suite`, `Release audit tests`, `Sidebar build smoke tests`, `Graph-update tool (knowledge:graph:update)`, `Privacy page build smoke tests`?**
  _High betweenness centrality (0.282) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site identity composition` to `News article view`, `News feed, rubric and pagination`, `Commerce catalog wire types`, `Storefront marketing data`, `Booking actions and CSS font test`, `Shared storefront components and helpers`, `Storefront cart and affiliate contracts`, `News navigation`, `Price formatting and flash-sale countdown`, `Storefront sign-in flow`, `Site build-profile config`, `Account contract types (akun-kontrak)`, `Article/video schema & breadcrumbs`, `Shared profile-route test harness`, `Environment access and static page fetch`, `Blog & ad-placement fetch helpers`?**
  _High betweenness centrality (0.106) - this node is a cross-community bridge._
- **Why does `buildProfile()` connect `Shared profile-route test harness` to `Storefront build-id and stub lifecycle`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _922 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Storefront cart client and storage` be split into smaller, more focused modules?**
  _Cohesion score 0.051425899953249185 - nodes in this community are weakly interconnected._
- **Should `News feed, rubric and pagination` be split into smaller, more focused modules?**
  _Cohesion score 0.04322344322344322 - nodes in this community are weakly interconnected._
- **Should `Storefront booking contract client` be split into smaller, more focused modules?**
  _Cohesion score 0.06094627105052125 - nodes in this community are weakly interconnected._