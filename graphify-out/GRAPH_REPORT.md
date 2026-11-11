# Graph Report - .  (2026-11-11)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3309 nodes · 7878 edges · 147 communities (132 shown, 15 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 61 edges (avg confidence: 0.59)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `135fca6f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Marketing data client
- News feed, rubric and pagination
- Dependency freshness report tooling
- CMS seed CLI
- Storefront booking and reservations
- Seed profile CLI
- Storefront dev stub server (awcms API)
- Bun-only runtime and manifest gates
- Account API client
- Account session client and contract
- E2E global setup
- Site build-profile config
- Account contract and session storage keys
- Storefront shop client and booking search
- Article/video schema & breadcrumbs
- Terpopuler analytics client
- News navigation
- Release image build tooling
- Root package.json manifest
- Shared profile-route test harness
- Region and institution lookups
- Blog & ad-placement fetch helpers
- Order status rendering client
- Share-row (bagikan) tests
- Customer session & wishlist sync
- News feed and rubric data
- First-party analytics beacon
- Commerce catalog wire types
- Checkout region & courier lookups
- Static page & portable text rendering
- Push enrolment and sign-out flow
- Storefront package.json manifest
- Dev server routing & Daerah panel
- Release & changeset tooling
- Storefront cart and affiliate contracts
- Booking order form script
- Docs audit gate (audit:dokumen)
- Knowledge-graph gate (audit:graf)
- WhatsApp fallback links and cart scripts
- Gate library and docs-translation audit
- Push guard and worker configuration
- Customer push device and status contract
- Seed-profile validation tests
- News URL redirect rules
- Storefront cart client and storage
- Push browser ports and platform detection
- Local CI PR orchestration and status posting
- Shared storefront components and helpers
- Storefront build-id and stub lifecycle
- Legacy seputarborneo importer
- Local CI process and port helpers
- Storefront theme and brand tokens
- Redirect import push tool
- Push notification stub and consent
- Single-flight guard and account messages
- Docs i18n mirror stamping
- Site theme extraction and API origin
- Sitemap XML rendering
- Obsidian export tool
- Ad popup widget
- Product listing filters & sort
- Release evidence and latest-flag tooling
- Astro profile route injection
- Read-aloud (dengar) player
- Affiliate code capture contract
- Legacy importer tests
- Local CI security baseline
- Local CI watcher state and hashing
- Account address book
- Product listing and catalog helpers
- E2E accessibility and responsive specs
- Deploy preflight reporter tests
- WhatsApp fallback and account status labels
- Toko origin and CSP configuration
- Root package scripts and build-smoke spawns
- Release file and git helpers
- MySQL dump reader
- Local CI leg table (ADR-0021)
- runExport
- PWA web manifest
- Environment access and static page fetch
- Deploy scenario test harness
- Root package manifest
- Lockfile consistency check
- Base tsconfig compiler options
- Deploy shell common library
- Product detail variant pricing
- Log redaction helpers
- CSP media origins and GA wiring
- Product breadcrumb structured data
- Push browser port permissions and subscription
- Storefront tsconfig compiler options
- kontrak package manifest
- Production compose file tests
- Subtree-write guard tests
- Push worker contract tests
- Release backlog audit and changeset parser
- Storefront profile navigation
- Single-flight contract test
- Obsidian export tool tests
- Push-only service worker click handling
- No-prerender guard tests
- Local CI audit exceptions parser
- Recent-news (terkini) loader
- News search page
- Contract import-direction test
- Local CI Bun pin enforcement
- Local CI fork-PR guard
- Local CI run lock
- GA init script
- Booking pages build smoke tests
- Social-meta build-smoke test
- Stale-phrase prose check
- packages/config manifest
- Gate report formatter
- packages/gerbang manifest
- Docs audit test suite
- Release audit tests
- Bun runtime smoke tests
- Promo popup script
- Contact fallback null test
- Sidebar build smoke test
- Root dependency overrides
- Kontrak tsconfig compiler options
- Env-example coverage test
- Graph-update tool (knowledge:graph:update)
- README screenshots script
- Build id writer script
- Share buttons build smoke test
- Listen (audio) build smoke test
- Agency logo build smoke test
- Lynx direction doc test
- Production job-runner script
- Bun runtime smoke script
- Bundle package build smoke test
- Affiliate page build smoke test
- Account dashboard build smoke test
- Double-tap registration e2e
- Offsite backup copy script
- Workspace member globs
- Postgres least-privilege role init
- Backup compose runner
- Production deploy entrypoint
- Remote deploy trigger
- Production healthcheck
- Production rollback

## God Nodes (most connected - your core abstractions)
1. `ROUTES` - 62 edges
2. `bun` - 61 edges
3. `kirimPermintaan()` - 51 edges
4. `bacaSesi()` - 48 edges
5. `scripts` - 44 edges
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
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json
- `updateCountdowns()` --indirect_call--> `row()`  [INFERRED]
  apps/storefront/src/scripts/akun-reservasi.ts → tests/import-seputarborneo.test.mjs
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/afiliasi-build-smoke.test.ts → package.json

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (147 total, 15 thin omitted)

### Community 0 - "Marketing data client"
Cohesion: 0.05
Nodes (67): ROUTES, CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus (+59 more)

### Community 1 - "News feed, rubric and pagination"
Cohesion: 0.04
Nodes (76): RawTerm, AuthorArchive, BeritaFeedItem, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive (+68 more)

### Community 2 - "Dependency freshness report tooling"
Cohesion: 0.06
Nodes (81): fixture(), FIXTURES, HOLD, json(), argValue(), collectAdvisories(), collectBun(), collectImageRefs() (+73 more)

### Community 3 - "CMS seed CLI"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 4 - "Storefront booking and reservations"
Cohesion: 0.06
Nodes (74): ADR-0045, labelTombolBayar(), alasanTidakBisaBatal(), bandingkanUang(), BarisUang, BOOKING_AKTIF_KEY, buatPathDetailReservasi(), buatPathPesan() (+66 more)

### Community 5 - "Seed profile CLI"
Cohesion: 0.06
Nodes (58): ADR-0018, ADR-0053, canSpawnBun(), NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), applyPlan(), describeChecklist(), POST_INIT_CHECKLIST (+50 more)

### Community 6 - "Storefront dev stub server (awcms API)"
Cohesion: 0.06
Nodes (67): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), bookingStub, buildAffiliateLink(), buildCourierOptions(), buildPaymentInstructions(), computeQuote() (+59 more)

### Community 7 - "Bun-only runtime and manifest gates"
Cohesion: 0.05
Nodes (62): COMPOSE_FILES, composeViolations(), DOCKERFILES, EXEMPT_DOCKERFILES, EXEMPT_IMAGE_SERVICES, isTestFixture(), MANIFESTS, ADR-0002 (+54 more)

### Community 8 - "Account API client"
Cohesion: 0.09
Nodes (60): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilDetailReservasi(), ambilKomisiAfiliasi(), ambilKuotaPembatalan(), ambilPercakapan() (+52 more)

### Community 9 - "Account session client and contract"
Cohesion: 0.06
Nodes (51): mintaKode(), OtpChannel, Percakapan, PercakapanHalaman, buatKunciBaru(), buatPengelolaKunci(), galatKonflikKunci(), jawabanFinal() (+43 more)

### Community 10 - "E2E global setup"
Cohesion: 0.06
Nodes (39): api(), chooseAndEnable(), CORS(), enrolled(), enrolledOnAccount(), failRegistration(), installPushMock(), login() (+31 more)

### Community 11 - "Site build-profile config"
Cohesion: 0.07
Nodes (40): activeRouteKeys(), CSP_NEEDS, CspNeeds, cspNeedsFor(), DEFAULT_SITE_PROFILE, describeProfile(), excludedRouteKeys(), FeedEntry (+32 more)

### Community 12 - "Account contract and session storage keys"
Cohesion: 0.09
Nodes (43): Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun, ADR-0007 (+35 more)

### Community 13 - "Storefront shop client and booking search"
Cohesion: 0.07
Nodes (45): KetersediaanMenginap, KuotaBooking, labelZonaWaktu(), parseParamCari(), periksaTanggal(), tanggalLokal(), TawaranBooking, ambilKetersediaanBooking() (+37 more)

### Community 14 - "Article/video schema & breadcrumbs"
Cohesion: 0.09
Nodes (36): absoluteUrl(), ResolvedMedia, getRelatedPosts(), PostDetail, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema() (+28 more)

### Community 15 - "Terpopuler analytics client"
Cohesion: 0.08
Nodes (31): CSP, DEFAULT_IDENTITY, DefaultIdentity, siteConfig, siteUrl, fetchTopPaths(), getTopPaths(), hitungTayangPerSlug() (+23 more)

### Community 16 - "News navigation"
Cohesion: 0.08
Nodes (36): socialIcons, tokoAktif, daerahActive, buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf(), getResolvableRegionsByCode() (+28 more)

### Community 17 - "Release image build tooling"
Cohesion: 0.13
Nodes (37): ADR-0020, gitRun(), cosignSign(), cosignVerify(), ensureBuilder(), fail(), headIsExactlyTag(), log() (+29 more)

### Community 18 - "Root package.json manifest"
Cohesion: 0.05
Nodes (44): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+36 more)

### Community 19 - "Shared profile-route test harness"
Cohesion: 0.11
Nodes (31): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, isSiteProfile() (+23 more)

### Community 20 - "Region and institution lookups"
Cohesion: 0.08
Nodes (32): SITEMAP_SOURCES, getAllInstitutions(), RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary() (+24 more)

### Community 21 - "Blog & ad-placement fetch helpers"
Cohesion: 0.08
Nodes (31): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+23 more)

### Community 22 - "Order status rendering client"
Cohesion: 0.09
Nodes (35): AkunPesananHalaman, comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003, createPesananRenderer() (+27 more)

### Community 23 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 24 - "Customer session & wishlist sync"
Cohesion: 0.13
Nodes (30): laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist(), saveWishlist() (+22 more)

### Community 25 - "News feed and rubric data"
Cohesion: 0.09
Nodes (26): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+18 more)

### Community 26 - "First-party analytics beacon"
Cohesion: 0.08
Nodes (22): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+14 more)

### Community 27 - "Commerce catalog wire types"
Cohesion: 0.07
Nodes (28): assertNeverProductStatus(), buildPriceTiers(), CategoryNode, collectCategorySubtreeIds(), CommerceBundle, CommerceBundleComponent, CommercePage, CommerceProductImage (+20 more)

### Community 28 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 29 - "Static page & portable text rendering"
Cohesion: 0.11
Nodes (33): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), collectGalleryMediaObjectIds(), documentHasPlayableVideo(), escapeHtml() (+25 more)

### Community 30 - "Push enrolment and sign-out flow"
Cohesion: 0.09
Nodes (24): adalah401(), adalah404(), bersihkanLokalBilaPerlu(), cabutPerangkatLain(), keluarAman(), keluarLokal(), LanggananInfo, matikanPerangkatIni() (+16 more)

### Community 31 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 32 - "Dev server routing & Daerah panel"
Cohesion: 0.13
Nodes (30): applyHeaders(), CACHE_ASSET, CACHE_PAGE, cacheControlFor(), createServer(), discoverCssPreloadPaths(), discoverShadowedHtmlPaths(), EMPTY_SET (+22 more)

### Community 33 - "Release & changeset tooling"
Cohesion: 0.12
Nodes (30): CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), parseChangeset(), validateChangeset(), atLeastAsSignificant(), BUMP_LEVELS, bumpVersion() (+22 more)

### Community 34 - "Storefront cart and affiliate contracts"
Cohesion: 0.13
Nodes (26): ADR-0043, PESANAN_PHONE_KEY, bacaPoinInput(), bolehPakaiPoin(), parsePoinAkun(), perkiraanDiskonPoin(), pesanKesalahanPoin(), PoinAkun (+18 more)

### Community 35 - "Booking order form script"
Cohesion: 0.17
Nodes (31): buatHoldAktif(), parseHoldAktif(), pengumumanAmbang(), sidikPermintaan(), teksSisa(), backToSearchHref(), focusHeading(), forgetHold() (+23 more)

### Community 36 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.13
Nodes (31): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+23 more)

### Community 37 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.11
Nodes (28): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+20 more)

### Community 38 - "WhatsApp fallback links and cart scripts"
Cohesion: 0.11
Nodes (28): UlasanAkun, Cart, CartLineRequest, quoteCart(), QuoteLine, buildWhatsappCartMessage(), buildWhatsappUrl(), lineText() (+20 more)

### Community 39 - "Gate library and docs-translation audit"
Cohesion: 0.15
Nodes (24): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+16 more)

### Community 40 - "Push guard and worker configuration"
Cohesion: 0.11
Nodes (23): base64Url(), buatPortPemberitahuan(), buatPortPenanda(), buatPortPeramban(), DepsPush, HasilAktifkan, HasilMatikan, HasilSesiBaru (+15 more)

### Community 41 - "Customer push device and status contract"
Cohesion: 0.14
Nodes (27): DeskripsiTujuan, HasilMuat, iosMendukungPush(), isPushPurpose(), isRecord(), KeadaanPush, kunciSama(), kunciServerKeBytes() (+19 more)

### Community 42 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 43 - "News URL redirect rules"
Cohesion: 0.14
Nodes (25): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+17 more)

### Community 44 - "Storefront cart client and storage"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 45 - "Push browser ports and platform detection"
Cohesion: 0.19
Nodes (25): ambilPemberitahuan(), pushDidukungPeramban(), deteksiPlatform(), perangkatIni(), PESAN_PEMBERITAHUAN, tujuanDitawarkan(), bersihkan(), buatCheckbox() (+17 more)

### Community 46 - "Local CI PR orchestration and status posting"
Cohesion: 0.18
Nodes (20): gitRunOrThrow(), main(), parseArgs(), main(), parseArgs(), parseGitHubRemoteUrl(), RepoRef, resolveRepo() (+12 more)

### Community 47 - "Shared storefront components and helpers"
Cohesion: 0.11
Nodes (15): rubrikColumn, year, [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE (+7 more)

### Community 48 - "Storefront build-id and stub lifecycle"
Cohesion: 0.11
Nodes (13): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+5 more)

### Community 49 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 50 - "Local CI process and port helpers"
Cohesion: 0.24
Nodes (18): run(), RunOptions, runOrThrow(), RunResult, freePort(), LegContext, LegOutcome, runCheckCmsLeg() (+10 more)

### Community 51 - "Storefront theme and brand tokens"
Cohesion: 0.14
Nodes (18): chunk(), crc32(), CRC_TABLE, encodePng(), GLYPHS, hexToRgb(), iconInitial(), IconSpec (+10 more)

### Community 52 - "Redirect import push tool"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 53 - "Push notification stub and consent"
Cohesion: 0.10
Nodes (17): APPLICATION_SERVER_KEY, CONSENT_TEXT_VERSION, createPushStub(), maskEndpoint(), PURPOSES, PUSH_HOSTS, ADR-0049, prerender (+9 more)

### Community 54 - "Single-flight guard and account messages"
Cohesion: 0.12
Nodes (17): buatPenjagaDom(), buatPenjagaTunggal(), HasilJalan, KaitPenjaga, KeadaanPenjaga, OpsiJalan, OpsiPenjagaDom, OpsiPenjagaUntuk (+9 more)

### Community 55 - "Docs i18n mirror stamping"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 56 - "Site theme extraction and API origin"
Cohesion: 0.16
Nodes (16): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, contrastingForeground() (+8 more)

### Community 57 - "Sitemap XML rendering"
Cohesion: 0.20
Nodes (17): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), registerSitemapSource(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests() (+9 more)

### Community 58 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 59 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 60 - "Product listing filters & sort"
Cohesion: 0.19
Nodes (15): filterProdukIndex(), normalizeSearchTerm(), paginateProdukIndex(), ProdukIndexEntry, emptyState, grid, heading, paginationEl (+7 more)

### Community 61 - "Release evidence and latest-flag tooling"
Cohesion: 0.26
Nodes (14): readFileIfPresent(), gitRunInherit(), computeLatestFlag(), deriveImageTags(), highestTag(), isValidTag(), matchesOwnRelease(), parseTag() (+6 more)

### Community 62 - "Astro profile route injection"
Cohesion: 0.20
Nodes (14): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+6 more)

### Community 63 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 64 - "Affiliate code capture contract"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 65 - "Legacy importer tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 66 - "Local CI security baseline"
Cohesion: 0.22
Nodes (13): BaselineEntry, isBaselined(), parseBaseline(), partitionHighSeverityFindings(), SecurityFinding, CODEQL_CLI_SHA256, CODEQL_CLI_VERSION, codeqlCacheDir() (+5 more)

### Community 67 - "Local CI watcher state and hashing"
Cohesion: 0.28
Nodes (14): hasRecordedResult(), listOpenPrs(), main(), OpenPr, recordResult(), fetchPullRequestInfo(), ghApiJson(), ciDefinitionHash() (+6 more)

### Community 68 - "Account address book"
Cohesion: 0.26
Nodes (16): Alamat, AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate() (+8 more)

### Community 69 - "Product listing and catalog helpers"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 70 - "E2E accessibility and responsive specs"
Cohesion: 0.18
Nodes (11): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, firstSlug(), KEY_PAGES, KeyPage, keyPagesFor(), VIEWPORTS (+3 more)

### Community 71 - "Deploy preflight reporter tests"
Cohesion: 0.22
Nodes (14): createReporter(), checkDistForToken(), checkStorefrontEnvShape(), collectFiles(), isHttpsUrl(), loadEnv(), looksLikeToken(), main() (+6 more)

### Community 72 - "WhatsApp fallback and account status labels"
Cohesion: 0.22
Nodes (15): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+7 more)

### Community 73 - "Toko origin and CSP configuration"
Cohesion: 0.21
Nodes (10): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+2 more)

### Community 74 - "Root package scripts and build-smoke spawns"
Cohesion: 0.14
Nodes (8): canSpawnBun(), runBuild(), canSpawnBun(), bun, cleanup, fixture(), run(), SCRIPT

### Community 75 - "Release file and git helpers"
Cohesion: 0.19
Nodes (10): ADR-0023, changelogSection(), findChangelogHeadings(), normalizeLineEndings(), normalizeRequestedVersion(), run(), SCRIPT, WORKFLOWS_DIR (+2 more)

### Community 76 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 77 - "Local CI leg table (ADR-0021)"
Cohesion: 0.18
Nodes (12): ADR-0021, EXPECTED_CONTEXTS, orchestrate, pkg, VERSION, findLeg(), LEG_CONTEXTS, LegDefinition (+4 more)

### Community 78 - "runExport"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 79 - "PWA web manifest"
Cohesion: 0.23
Nodes (11): SITE_PROFILE, buildManifest(), ICON_PATHS, MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, ManifestInput, PROFILE_CATEGORIES (+3 more)

### Community 80 - "Environment access and static page fetch"
Cohesion: 0.22
Nodes (11): detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), listStaticPages(), StaticPageDetail, ADR-0100 (+3 more)

### Community 81 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 82 - "Root package manifest"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 83 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 84 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 85 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 86 - "Product detail variant pricing"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 87 - "Log redaction helpers"
Cohesion: 0.32
Nodes (7): redactLine(), redactText(), fakeBearerValue, fakeDsnPassword, fakeGithubToken, redact(), main()

### Community 88 - "CSP media origins and GA wiring"
Cohesion: 0.27
Nodes (8): buildCsp(), readCspOrigins(), sanitizeOrigins(), buildCspOriginsArtifact(), collectOrigins(), CspOriginsArtifact, originOf(), ADR-0002

### Community 89 - "Product breadcrumb structured data"
Cohesion: 0.29
Nodes (7): CommerceCategory, CommerceProduct, CommerceProductVariant, breadcrumbListNode(), buildCategoryPageSchema(), buildProductPageSchema(), ProductSchemaInput

### Community 90 - "Push browser port permissions and subscription"
Cohesion: 0.27
Nodes (4): aktifkanPerangkat(), PortPeramban, petakanGalatPeramban(), TeksPersetujuan

### Community 91 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 92 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 93 - "Production compose file tests"
Cohesion: 0.18
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 94 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 95 - "Push worker contract tests"
Cohesion: 0.20
Nodes (7): PUSH_PURPOSES, PUSH_TARGET_PATHS, FakeClient, Harness, Listener, Shown, SOURCE

### Community 96 - "Release backlog audit and changeset parser"
Cohesion: 0.20
Nodes (6): dated, oldest, pending, reporter, todayIso, isChangesetFile()

### Community 97 - "Storefront profile navigation"
Cohesion: 0.25
Nodes (6): NavItem, PROFILE_NAV, PROFILE_NAV_DYNAMIC, insertAfter(), ResolvedNavItem, selectPrimaryNav()

### Community 98 - "Single-flight contract test"
Cohesion: 0.28
Nodes (7): BACA_SAJA, DIKECUALIKAN, LIBS, mutasiDalam(), mutatingExports(), SCRIPTS, stripKomentar()

### Community 99 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 100 - "Push-only service worker click handling"
Cohesion: 0.39
Nodes (5): isRecord(), normalizePayload(), resolveTarget(), tagOf(), text()

### Community 101 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 102 - "Local CI audit exceptions parser"
Cohesion: 0.46
Nodes (6): valid, AuditException, auditIgnoreArgs(), loadAuditIgnoreArgs(), parseAuditExceptions(), runBunAuditWithExceptions()

### Community 103 - "Recent-news (terkini) loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 104 - "News search page"
Cohesion: 0.29
Nodes (5): input, matches, needle, resultsList, status

### Community 105 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 106 - "Local CI Bun pin enforcement"
Cohesion: 0.52
Nodes (5): PKG, BunPinResult, checkBunPin(), enforceBunPinOrThrow(), readPinnedBunVersion()

### Community 107 - "Local CI fork-PR guard"
Cohesion: 0.48
Nodes (5): enforceForkPolicyOrThrow(), isFromFork(), PullRequestInfo, pullRequestInfoFromRest(), RestPullRequest

### Community 108 - "Local CI run lock"
Cohesion: 0.48
Nodes (5): acquireLock(), isProcessAlive(), Lock, readHolder(), tryCreate()

### Community 109 - "GA init script"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 110 - "Booking pages build smoke tests"
Cohesion: 0.33
Nodes (3): canSpawnBun(), PAGE_SOURCES, PAGES

### Community 111 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 112 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 113 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 114 - "Gate report formatter"
Cohesion: 0.40
Nodes (3): formatReport(), SCRIPT_DIRS, scripts

### Community 115 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 116 - "Docs audit test suite"
Cohesion: 0.33
Nodes (4): cleanup, ADR-0042, run(), SCRIPT

### Community 117 - "Release audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 118 - "Bun runtime smoke tests"
Cohesion: 0.33
Nodes (4): GOOD, ADR-0002, REPO_ROOT, SCRIPT

### Community 119 - "Promo popup script"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 120 - "Contact fallback null test"
Cohesion: 0.40
Nodes (3): canSpawnBun(), FIXTURE_PATH, SITE_TS_PATH

### Community 122 - "Root dependency overrides"
Cohesion: 0.40
Nodes (5): overrides, sharp, shell-quote, smol-toml, source-map-js

### Community 123 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 125 - "Graph-update tool (knowledge:graph:update)"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 126 - "README screenshots script"
Cohesion: 0.50
Nodes (3): run, { values }, SITE_PROFILES

### Community 127 - "Build id writer script"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 128 - "Share buttons build smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 129 - "Listen (audio) build smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 130 - "Agency logo build smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 133 - "Bun runtime smoke script"
Cohesion: 0.83
Nodes (3): fail(), smoke-bun-runtime.sh script, usage()

### Community 139 - "Workspace member globs"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **885 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+880 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **15 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Root package scripts and build-smoke spawns` to `Share buttons build smoke test`, `Listen (audio) build smoke test`, `Agency logo build smoke test`, `Dependency freshness report tooling`, `Seed profile CLI`, `Bundle package build smoke test`, `Affiliate page build smoke test`, `Account dashboard build smoke test`, `E2E global setup`, `Release image build tooling`, `Shared profile-route test harness`, `Local CI PR orchestration and status posting`, `Storefront build-id and stub lifecycle`, `Local CI process and port helpers`, `Release evidence and latest-flag tooling`, `Local CI security baseline`, `Local CI watcher state and hashing`, `Deploy preflight reporter tests`, `Release file and git helpers`, `MySQL dump reader`, `runExport`, `Deploy scenario test harness`, `Root package manifest`, `Local CI audit exceptions parser`, `Booking pages build smoke tests`, `Social-meta build-smoke test`, `Docs audit test suite`, `Release audit tests`, `Contact fallback null test`, `Sidebar build smoke test`, `Graph-update tool (knowledge:graph:update)`, `Build id writer script`?**
  _High betweenness centrality (0.193) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Seed profile CLI` to `Marketing data client`, `CMS seed CLI`, `Site build-profile config`, `Shared profile-route test harness`, `Astro profile route injection`?**
  _High betweenness centrality (0.146) - this node is a cross-community bridge._
- **Why does `ADR-0048` connect `Push notification stub and consent` to `Push-only service worker click handling`, `Storefront dev stub server (awcms API)`, `Account API client`, `Customer push device and status contract`, `Push guard and worker configuration`, `Account session client and contract`, `Account contract and session storage keys`, `Push browser ports and platform detection`, `E2E global setup`, `Shared profile-route test harness`, `Push enrolment and sign-out flow`, `Push worker contract tests`?**
  _High betweenness centrality (0.087) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _885 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Marketing data client` be split into smaller, more focused modules?**
  _Cohesion score 0.046731873932619156 - nodes in this community are weakly interconnected._
- **Should `News feed, rubric and pagination` be split into smaller, more focused modules?**
  _Cohesion score 0.043717152412804584 - nodes in this community are weakly interconnected._
- **Should `Dependency freshness report tooling` be split into smaller, more focused modules?**
  _Cohesion score 0.060784313725490195 - nodes in this community are weakly interconnected._