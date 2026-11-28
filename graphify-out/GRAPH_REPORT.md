# Graph Report - .  (2026-11-24)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3701 nodes · 8724 edges · 156 communities (138 shown, 18 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 67 edges (avg confidence: 0.6)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `23408c0f`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Gate library and docs-translation audit
- News feed, rubric and pagination
- Tooling: Lib storefront consumer contract
- Dependency freshness report tooling
- CMS seed CLI
- Storefront dev stub server (awcms API)
- Template init planner
- Log redaction helpers
- Reading-preferences panel e2e
- Commerce catalog wire types
- Storefront: Akun klien
- Gate report formatter
- Storefront: Toko klien
- E2E ports and global setup entry
- Storefront booking contract client
- Recent news loader
- Site theme extraction and API origin
- Site identity composition
- Site build-profile config
- Storefront: Media
- Storefront cart client and storage
- Repo: Scripts
- Article/video schema & breadcrumbs
- News navigation
- Knowledge-graph gate (audit:graf)
- Blog & ad-placement fetch helpers
- Shared profile-route test harness
- News article view
- Share-row (bagikan) tests
- Customer session & wishlist sync
- Account contract types (akun-kontrak)
- Dev server routing & Daerah panel
- Storefront: Masuk
- Checkout region & courier lookups
- Storefront package scripts
- Toko origin and CSP configuration
- Release & changeset tooling
- Static page & portable text rendering
- Storefront: Booking pesan
- Storefront cart and affiliate contracts
- Storefront: Akun notifikasi
- E2E accessibility and responsive specs
- Storefront customer push
- Push enrolment and sign-out flow
- Seed-profile validation tests
- Local CI fork and git helpers
- Storefront: Pengalihan aturan
- Storefront build-id and stub lifecycle
- Storefront: Akun alamat
- Booking actions and CSS font test
- Storefront: A11y preferences
- Product price formatting
- Legacy seputarborneo importer
- Root tests: Fixture skema
- Local CI PR watcher
- Storefront: Buletin
- Storefront: Akun privasi
- CMS API fetch client
- Customer push device and status contract
- Environment access and static page fetch
- Single-flight guard and account messages
- Tooling: Knowledge graph combine
- Product listing filters & sort
- Sitemap XML rendering
- Root tests: Changelog
- Obsidian export tool
- Storefront: Toko permintaan
- Ad popup widget
- Astro profile route injection
- Storefront sign-in flow
- Read-aloud (dengar) player
- Storefront: Afiliasi kontrak
- Storefront: KeluarAman
- Legacy importer tests
- Storefront: Produk listing
- First-party analytics beacon
- Gates: Data pribadi config
- Root tests: Version mirrors tests
- Storefront: Akun
- Storefront marketing data
- Gates: Audit data pribadi
- MySQL dump reader
- WhatsApp fallback and account status labels
- Storefront: Awcms analitik
- Root tests: Audit data pribadi tests
- BPS table row fixtures
- PWA web manifest
- Storefront: A11y preferences tests
- Deploy scenario test harness
- Repo: Package
- Storefront: A11y early tests
- Production compose tests
- Lockfile consistency check
- Base tsconfig compiler options
- Local CI: Legs
- Deploy shell common library
- Storefront: Katalog csp media tests
- Storefront: Akun pesan
- Review list rendering and status tones
- Storefront: Bun
- Push browser port permissions and subscription
- Storefront tsconfig compiler options
- kontrak package manifest
- Subtree-write guard tests
- Storefront: Navigasi profil
- Storefront: Push pekerja tests
- Gates: Data pribadi
- Root tests: Template tanpa starsender tests
- Single-flight contract test
- Obsidian export tool tests
- Push-only service worker click handling
- No-prerender guard tests
- Root tests: Audit graf tests
- Contract import-direction test
- Bun version pin enforcement
- Local CI: Lock
- Storefront: Booking build smoke tests
- Social-meta build-smoke test
- Stale-phrase prose check
- packages/config manifest
- packages/gerbang manifest
- Release audit tests
- Root tests: Deploy smoke bun runtime tests
- Storefront: ResolveSiteProfile
- Storefront: ADR 0057
- GA init script
- Promo pop-up
- Storefront: Kontak fallback null tests
- Sidebar build smoke tests
- Repo: Overrides
- Kontrak tsconfig compiler options
- Env-example coverage test
- Graph-update tool (knowledge:graph:update)
- Build id writer script
- Storefront: IsMotionReduced
- Storefront: Bagikan build smoke tests
- Storefront: Dengar build smoke tests
- Footer contrast tests
- Storefront: Logo instansi build smoke tests
- Lynx direction doc test
- Production job-runner script
- Bun runtime image smoke
- Storefront: Afiliasi build smoke tests
- Storefront: Daftar ketuk ganda tests
- Storefront: Pesan build smoke tests
- Offsite backup copy script
- Repo: Repository
- Repo: Workspaces
- Postgres least-privilege role init
- Backup compose runner
- Production deploy entrypoint
- Remote deploy trigger
- Production healthcheck
- Production rollback

## God Nodes (most connected - your core abstractions)
1. `bun` - 67 edges
2. `ROUTES` - 63 edges
3. `kirimPermintaan()` - 54 edges
4. `bacaSesi()` - 51 edges
5. `scripts` - 47 edges
6. `getSiteIdentity()` - 40 edges
7. `formatPrice()` - 37 edges
8. `authHeader()` - 37 edges
9. `denganPembersihanSesi()` - 37 edges
10. `TokoApiError` - 32 edges

## Surprising Connections (you probably didn't know these)
- `resolveBuildId()` --references--> `bun`  [EXTRACTED]
  apps/storefront/scripts/write-build-id.mjs → package.json
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-rilis.test.mjs → package.json
- `updateCountdowns()` --indirect_call--> `row()`  [INFERRED]
  apps/storefront/src/scripts/akun-reservasi.ts → tests/import-seputarborneo.test.mjs
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/akun-build-smoke.test.ts → package.json
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/bagikan-build-smoke.test.ts → package.json

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (156 total, 18 thin omitted)

### Community 0 - "Gate library and docs-translation audit"
Cohesion: 0.06
Nodes (77): ADR-0020, DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage() (+69 more)

### Community 1 - "News feed, rubric and pagination"
Cohesion: 0.04
Nodes (79): RawTerm, AuthorArchive, BeritaFeedItem, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive (+71 more)

### Community 2 - "Tooling: Lib storefront consumer contract"
Cohesion: 0.05
Nodes (81): ADR-0024, breaksFor(), bundle, clone(), currentSlice(), find(), frozen, ADR-0058 (+73 more)

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

### Community 7 - "Log redaction helpers"
Cohesion: 0.07
Nodes (56): redactLine(), redactText(), valid, alive(), waitGone(), fakeBearerValue, fakeDsnPassword, fakeGithubToken (+48 more)

### Community 8 - "Reading-preferences panel e2e"
Cohesion: 0.05
Nodes (63): token(), COMPOSE_FILES, composeViolations(), DOCKERFILES, EXEMPT_DOCKERFILES, EXEMPT_IMAGE_SERVICES, isTestFixture(), MANIFESTS (+55 more)

### Community 9 - "Commerce catalog wire types"
Cohesion: 0.05
Nodes (48): assertNeverProductStatus(), buildCategoryTree(), buildPriceTiers(), buildProdukIndex(), CategoryNode, collectCategorySubtreeIds(), CommerceBundle, CommerceBundleComponent (+40 more)

### Community 10 - "Storefront: Akun klien"
Cohesion: 0.08
Nodes (62): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilDetailReservasi(), ambilKomisiAfiliasi(), ambilKuotaPembatalan(), ambilPercakapan() (+54 more)

### Community 11 - "Gate report formatter"
Cohesion: 0.05
Nodes (56): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+48 more)

### Community 12 - "Storefront: Toko klien"
Cohesion: 0.05
Nodes (52): KetersediaanMenginap, KuotaBooking, TawaranBooking, bacaPoinInput(), bolehPakaiPoin(), parsePoinAkun(), perkiraanDiskonPoin(), pesanKesalahanPoin() (+44 more)

### Community 13 - "E2E ports and global setup entry"
Cohesion: 0.05
Nodes (42): api(), chooseAndEnable(), CORS(), enrolled(), enrolledOnAccount(), failRegistration(), installPushMock(), login() (+34 more)

### Community 14 - "Storefront booking contract client"
Cohesion: 0.08
Nodes (55): ADR-0045, alasanTidakBisaBatal(), bandingkanUang(), BarisUang, BOOKING_AKTIF_KEY, buatPathDetailReservasi(), buatPathPesan(), catatanPembayaran() (+47 more)

### Community 15 - "Recent news loader"
Cohesion: 0.06
Nodes (45): CSP_NEEDS, getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry (+37 more)

### Community 16 - "Site theme extraction and API origin"
Cohesion: 0.06
Nodes (41): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, chunk() (+33 more)

### Community 17 - "Site identity composition"
Cohesion: 0.11
Nodes (22): socialIcons, tokoAktif, ROUTES, DEFAULT_IDENTITY, getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity() (+14 more)

### Community 18 - "Site build-profile config"
Cohesion: 0.07
Nodes (38): activeRouteKeys(), CspNeeds, cspNeedsFor(), DEFAULT_SITE_PROFILE, describeProfile(), excludedRouteKeys(), FeedEntry, FEEDS (+30 more)

### Community 19 - "Storefront: Media"
Cohesion: 0.07
Nodes (39): [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE, SITE_PROFILE_ENV, AwcmsApiError (+31 more)

### Community 20 - "Storefront cart client and storage"
Cohesion: 0.11
Nodes (38): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+30 more)

### Community 21 - "Repo: Scripts"
Cohesion: 0.04
Nodes (47): scripts, audit:data-pribadi, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check (+39 more)

### Community 22 - "Article/video schema & breadcrumbs"
Cohesion: 0.09
Nodes (36): absoluteUrl(), ResolvedMedia, getRelatedPosts(), PostDetail, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema() (+28 more)

### Community 23 - "News navigation"
Cohesion: 0.08
Nodes (36): rubrikColumn, year, daerahActive, buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf(), getResolvableRegionsByCode() (+28 more)

### Community 24 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.09
Nodes (39): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, status (+31 more)

### Community 25 - "Blog & ad-placement fetch helpers"
Cohesion: 0.08
Nodes (31): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+23 more)

### Community 26 - "Shared profile-route test harness"
Cohesion: 0.11
Nodes (30): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, isSiteProfile() (+22 more)

### Community 27 - "News article view"
Cohesion: 0.08
Nodes (28): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+20 more)

### Community 28 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 29 - "Customer session & wishlist sync"
Cohesion: 0.13
Nodes (29): laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist(), saveWishlist() (+21 more)

### Community 30 - "Account contract types (akun-kontrak)"
Cohesion: 0.11
Nodes (30): keluar(), Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun (+22 more)

### Community 31 - "Dev server routing & Daerah panel"
Cohesion: 0.13
Nodes (31): applyHeaders(), CACHE_ASSET, CACHE_PAGE, cacheControlFor(), createServer(), discoverCssPreloadPaths(), discoverShadowedHtmlPaths(), EMPTY_SET (+23 more)

### Community 32 - "Storefront: Masuk"
Cohesion: 0.11
Nodes (31): mintaKode(), OtpChannel, buatKunciBaru(), buatPengelolaKunci(), galatKonflikKunci(), jawabanFinal(), KODE_KONFLIK_KUNCI, kunciValid() (+23 more)

### Community 33 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 34 - "Storefront package scripts"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 35 - "Toko origin and CSP configuration"
Cohesion: 0.09
Nodes (20): DefaultIdentity, siteConfig, siteUrl, awcmsGet(), baseUrl(), Envelope, timeoutMs(), EnvSource (+12 more)

### Community 36 - "Release & changeset tooling"
Cohesion: 0.12
Nodes (31): CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile(), parseChangeset(), validateChangeset(), atLeastAsSignificant(), BUMP_LEVELS (+23 more)

### Community 37 - "Static page & portable text rendering"
Cohesion: 0.11
Nodes (31): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), documentHasPlayableVideo(), escapeHtml(), extractPlayableVideoInfo() (+23 more)

### Community 38 - "Storefront: Booking pesan"
Cohesion: 0.16
Nodes (32): buatHoldAktif(), MetodeBayarBooking, ParamPesan, pengumumanAmbang(), sidikPermintaan(), ambilKuotaBooking(), backToSearchHref(), focusHeading() (+24 more)

### Community 39 - "Storefront cart and affiliate contracts"
Cohesion: 0.11
Nodes (27): AkunPesananHalaman, PESAN_KONFLIK_KUNCI, createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, PESANAN_PHONE_KEY (+19 more)

### Community 40 - "Storefront: Akun notifikasi"
Cohesion: 0.16
Nodes (30): adalah404(), ambilPemberitahuan(), cabutPerangkatLain(), matikanPerangkatIni(), pushDidukungPeramban(), deteksiPlatform(), perangkatIni(), petakanGalat() (+22 more)

### Community 41 - "E2E accessibility and responsive specs"
Cohesion: 0.09
Nodes (22): axePanel(), axeSerious(), describeViolations(), fab(), FAILING_IMPACT, openPanel(), panel(), PANEL_TAGS (+14 more)

### Community 42 - "Storefront customer push"
Cohesion: 0.13
Nodes (28): DeskripsiTujuan, HasilMuat, iosMendukungPush(), isPushPurpose(), isRecord(), KeadaanPush, kunciSama(), kunciServerKeBytes() (+20 more)

### Community 43 - "Push enrolment and sign-out flow"
Cohesion: 0.11
Nodes (23): base64Url(), buatPortPemberitahuan(), buatPortPenanda(), buatPortPeramban(), DepsPush, HasilAktifkan, HasilMatikan, HasilSesiBaru (+15 more)

### Community 44 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 45 - "Local CI fork and git helpers"
Cohesion: 0.17
Nodes (22): gitRunOrThrow(), main(), parseArgs(), main(), parseArgs(), LegDefinition, parseGitHubRemoteUrl(), RepoRef (+14 more)

### Community 46 - "Storefront: Pengalihan aturan"
Cohesion: 0.14
Nodes (25): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+17 more)

### Community 47 - "Storefront build-id and stub lifecycle"
Cohesion: 0.10
Nodes (14): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+6 more)

### Community 48 - "Storefront: Akun alamat"
Cohesion: 0.17
Nodes (25): Alamat, AlamatInput, applyRegionSelection(), fetchRegionJson(), fillRegionOptions(), loadKabupaten(), loadKecamatan(), loadProvinces() (+17 more)

### Community 49 - "Booking actions and CSS font test"
Cohesion: 0.14
Nodes (24): HasilBayar, labelTombolBayar(), mulaiPembayaranGateway(), parseKodeDetail(), pesanGalatBooking(), ReservasiSaya, appendRows(), DetailReservasiKontrol (+16 more)

### Community 50 - "Storefront: A11y preferences"
Cohesion: 0.15
Nodes (21): A11Y_CHANGE_EVENT, A11Y_STORAGE_VERSION, applyPreferences(), AttributeTarget, clearAppliedPreferences(), OsPreferences, readStoredPreferences(), resolveEffectivePreferences() (+13 more)

### Community 51 - "Product price formatting"
Cohesion: 0.13
Nodes (22): CommerceProductVariant, findVariantForSelection(), comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003 (+14 more)

### Community 52 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 53 - "Root tests: Fixture skema"
Cohesion: 0.12
Nodes (21): bundle, ADR-0058, today, validator, BUNDLE_PATH, COMPOSITION, createValidator(), errorProperty() (+13 more)

### Community 54 - "Local CI PR watcher"
Cohesion: 0.19
Nodes (19): hasRecordedResult(), listOpenPrs(), main(), OpenPr, recordResult(), enforceForkPolicyOrThrow(), fetchPullRequestInfo(), ghApiJson() (+11 more)

### Community 55 - "Storefront: Buletin"
Cohesion: 0.14
Nodes (15): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+7 more)

### Community 56 - "Storefront: Akun privasi"
Cohesion: 0.18
Nodes (20): ADR-0055, bacaPenolakan(), bacaRingkasanPenghapusan(), isKodePenolakan(), KODE_PENOLAKAN, KodePenolakan, kodeValid(), namaBerkasEkspor() (+12 more)

### Community 57 - "CMS API fetch client"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 58 - "Customer push device and status contract"
Cohesion: 0.10
Nodes (17): APPLICATION_SERVER_KEY, CONSENT_TEXT_VERSION, createPushStub(), maskEndpoint(), PURPOSES, PUSH_HOSTS, ADR-0049, prerender (+9 more)

### Community 59 - "Environment access and static page fetch"
Cohesion: 0.13
Nodes (16): SITEMAP_SOURCES, getAllInstitutions(), RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary() (+8 more)

### Community 60 - "Single-flight guard and account messages"
Cohesion: 0.12
Nodes (17): buatPenjagaDom(), buatPenjagaTunggal(), HasilJalan, KaitPenjaga, KeadaanPenjaga, OpsiJalan, OpsiPenjagaDom, OpsiPenjagaUntuk (+9 more)

### Community 61 - "Tooling: Knowledge graph combine"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 62 - "Product listing filters & sort"
Cohesion: 0.17
Nodes (17): preferredScrollBehavior(), ScrollWindow, filterProdukIndex(), normalizeSearchTerm(), paginateProdukIndex(), ProdukIndexEntry, emptyState, grid (+9 more)

### Community 63 - "Sitemap XML rendering"
Cohesion: 0.20
Nodes (17): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), registerSitemapSource(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests() (+9 more)

### Community 64 - "Root tests: Changelog"
Cohesion: 0.14
Nodes (14): ADR-0021, ADR-0023, changelogSection(), findChangelogHeadings(), normalizeLineEndings(), normalizeRequestedVersion(), run(), SCRIPT (+6 more)

### Community 65 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 66 - "Storefront: Toko permintaan"
Cohesion: 0.11
Nodes (11): LanggananInfo, PushCapability, Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, CAPABILITY, DEVICE, MARKER (+3 more)

### Community 67 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 68 - "Astro profile route injection"
Cohesion: 0.19
Nodes (15): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+7 more)

### Community 69 - "Storefront sign-in flow"
Cohesion: 0.23
Nodes (18): labelZonaWaktu(), tanggalLokal(), ambilKetersediaanBooking(), buildWhatsappAccountMessage(), buildWhatsappUrl(), showSubmitError(), applyOffering(), clearError() (+10 more)

### Community 70 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 71 - "Storefront: Afiliasi kontrak"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 72 - "Storefront: KeluarAman"
Cohesion: 0.18
Nodes (10): adalah401(), bersihkanLokalBilaPerlu(), keluarAman(), keluarLokal(), PortPenanda, PortServer, PortSesi, putusLokal() (+2 more)

### Community 73 - "Legacy importer tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 74 - "Storefront: Produk listing"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 75 - "First-party analytics beacon"
Cohesion: 0.12
Nodes (7): FakeButton, FakeForm, FakeInput, FakeStatus, Listener, pending, requests

### Community 76 - "Gates: Data pribadi config"
Cohesion: 0.12
Nodes (16): RFC-2606, RFC-6762, CATEGORIES, DATA_DIRECTORY_SEGMENTS, DATA_FILE_EXTENSIONS, EMAIL_PATTERN, FILE_SHARE_LINKS, MAX_SCAN_BYTES (+8 more)

### Community 77 - "Root tests: Version mirrors tests"
Cohesion: 0.19
Nodes (14): applyMirrorPlan(), findMirrorMismatches(), loadMirrors(), locate(), MIRRORS_CONFIG_PATH, parseMirrorConfig(), planMirrors(), dirs (+6 more)

### Community 78 - "Storefront: Akun"
Cohesion: 0.25
Nodes (15): ambilPesananAkun(), hideSubmitError(), initialsFor(), jalankanKeluar(), LEVEL_LABELS, levelLabel(), loadStats(), render() (+7 more)

### Community 79 - "Storefront marketing data"
Cohesion: 0.21
Nodes (10): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+2 more)

### Community 80 - "Gates: Audit data pribadi"
Cohesion: 0.14
Nodes (14): entries, HERE, historyMode, hits, inScope, listing, problems, reporter (+6 more)

### Community 81 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 82 - "WhatsApp fallback and account status labels"
Cohesion: 0.22
Nodes (14): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+6 more)

### Community 83 - "Storefront: Awcms analitik"
Cohesion: 0.23
Nodes (10): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+2 more)

### Community 84 - "Root tests: Audit data pribadi tests"
Cohesion: 0.13
Nodes (13): cleanup, EMAIL, EMAIL_PLACEHOLDER, fixtureTree(), NATIONAL_ID, NATIONAL_ID_REPEATED, NATIONAL_ID_RESERVED, PHONE (+5 more)

### Community 85 - "BPS table row fixtures"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 86 - "PWA web manifest"
Cohesion: 0.23
Nodes (11): SITE_PROFILE, buildManifest(), ICON_PATHS, MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, ManifestInput, PROFILE_CATEGORIES (+3 more)

### Community 87 - "Storefront: A11y preferences tests"
Cohesion: 0.18
Nodes (8): ATTRIBUTES, clearStoredPreferences(), DEFAULT_PREFERENCES, serializePreferences(), StorageLike, writeStoredPreferences(), ALL_ON, throwingStorage

### Community 88 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 89 - "Repo: Package"
Cohesion: 0.15
Nodes (12): ajv, description, devDependencies, ajv, engines, homepage, license, name (+4 more)

### Community 90 - "Storefront: A11y early tests"
Cohesion: 0.19
Nodes (10): A11Y_STORAGE_KEY, A11yPreferences, isTextSize(), parsePreferences(), Attributes, fakeRoot(), runEarly(), SOURCE (+2 more)

### Community 91 - "Production compose tests"
Cohesion: 0.15
Nodes (7): ADR-0019, ADR-0160, ADR-0162, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 92 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 93 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 94 - "Local CI: Legs"
Cohesion: 0.31
Nodes (10): EXPECTED_CONTEXTS, DISABLED_LEG_GROUPS, filterDisabledGroups(), findLeg(), LEG_CONTEXTS, LEG_GROUPS, LegGroup, LEGS (+2 more)

### Community 95 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 96 - "Storefront: Katalog csp media tests"
Cohesion: 0.26
Nodes (8): buildCsp(), CSP, sanitizeOrigins(), buildCspOriginsArtifact(), collectOrigins(), CspOriginsArtifact, originOf(), ADR-0002

### Community 97 - "Storefront: Akun pesan"
Cohesion: 0.29
Nodes (11): Percakapan, PercakapanHalaman, appendConversationRows(), hideSubmitError(), loadDetail(), loadMore(), render(), renderMessages() (+3 more)

### Community 98 - "Review list rendering and status tones"
Cohesion: 0.27
Nodes (11): UlasanAkun, hideSubmitError(), loadList(), render(), renderItem(), root, showGuestView(), showSubmitError() (+3 more)

### Community 99 - "Storefront: Bun"
Cohesion: 0.18
Nodes (5): canSpawnBun(), canSpawnBun(), runBuild(), canSpawnBun(), bun

### Community 100 - "Push browser port permissions and subscription"
Cohesion: 0.27
Nodes (4): aktifkanPerangkat(), PortPeramban, petakanGalatPeramban(), TeksPersetujuan

### Community 101 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 102 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 103 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 104 - "Storefront: Navigasi profil"
Cohesion: 0.29
Nodes (8): NavItem, PROFILE_NAV, PROFILE_NAV_DYNAMIC, selectNavUtamaRubrik(), getPrimaryNav(), insertAfter(), ResolvedNavItem, selectPrimaryNav()

### Community 105 - "Storefront: Push pekerja tests"
Cohesion: 0.20
Nodes (7): PUSH_PURPOSES, PUSH_TARGET_PATHS, FakeClient, Harness, Listener, Shown, SOURCE

### Community 106 - "Gates: Data pribadi"
Cohesion: 0.38
Nodes (9): applyAllowList(), covers(), isFakeNationalId(), isFakePhone(), isPlaceholderDomain(), longestRepeatedRun(), longestSequentialRun(), looksFake() (+1 more)

### Community 107 - "Root tests: Template tanpa starsender tests"
Cohesion: 0.24
Nodes (7): canSpawn(), configFiles(), FORBIDDEN_ASSIGNMENTS, listFiles(), makeTempCopy(), PROFILES, tempDirs

### Community 108 - "Single-flight contract test"
Cohesion: 0.28
Nodes (7): BACA_SAJA, DIKECUALIKAN, LIBS, mutasiDalam(), mutatingExports(), SCRIPTS, stripKomentar()

### Community 109 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 110 - "Push-only service worker click handling"
Cohesion: 0.39
Nodes (5): isRecord(), normalizePayload(), resolveTarget(), tagOf(), text()

### Community 111 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 112 - "Root tests: Audit graf tests"
Cohesion: 0.29
Nodes (4): cleanup, fixture(), run(), SCRIPT

### Community 113 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 114 - "Bun version pin enforcement"
Cohesion: 0.52
Nodes (5): PKG, BunPinResult, checkBunPin(), enforceBunPinOrThrow(), readPinnedBunVersion()

### Community 115 - "Local CI: Lock"
Cohesion: 0.48
Nodes (5): acquireLock(), isProcessAlive(), Lock, readHolder(), tryCreate()

### Community 116 - "Storefront: Booking build smoke tests"
Cohesion: 0.33
Nodes (3): canSpawnBun(), PAGE_SOURCES, PAGES

### Community 117 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 118 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 119 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 120 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 121 - "Release audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 122 - "Root tests: Deploy smoke bun runtime tests"
Cohesion: 0.33
Nodes (5): GOOD, ADR-0002, REPO_ROOT, SCRIPT, smoke()

### Community 123 - "Storefront: ResolveSiteProfile"
Cohesion: 0.40
Nodes (4): run, { values }, resolveSiteProfile(), SITE_PROFILES

### Community 126 - "Promo pop-up"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 127 - "Storefront: Kontak fallback null tests"
Cohesion: 0.40
Nodes (3): canSpawnBun(), FIXTURE_PATH, SITE_TS_PATH

### Community 129 - "Repo: Overrides"
Cohesion: 0.40
Nodes (5): overrides, sharp, shell-quote, smol-toml, source-map-js

### Community 130 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 132 - "Graph-update tool (knowledge:graph:update)"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 133 - "Build id writer script"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 135 - "Storefront: Bagikan build smoke tests"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 136 - "Storefront: Dengar build smoke tests"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 138 - "Storefront: Logo instansi build smoke tests"
Cohesion: 0.50
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 141 - "Bun runtime image smoke"
Cohesion: 0.83
Nodes (3): fail(), smoke-bun-runtime.sh script, usage()

### Community 146 - "Repo: Repository"
Cohesion: 0.67
Nodes (3): repository, type, url

### Community 147 - "Repo: Workspaces"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **991 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+986 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **18 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `Storefront: Bun` to `Sidebar build smoke tests`, `Gate library and docs-translation audit`, `Dependency freshness report tooling`, `Graph-update tool (knowledge:graph:update)`, `Build id writer script`, `Template init planner`, `Storefront: Bagikan build smoke tests`, `Storefront: Dengar build smoke tests`, `Log redaction helpers`, `Storefront: Logo instansi build smoke tests`, `Gate report formatter`, `E2E ports and global setup entry`, `Storefront: Afiliasi build smoke tests`, `Storefront: Pesan build smoke tests`, `Shared profile-route test harness`, `Local CI fork and git helpers`, `Storefront build-id and stub lifecycle`, `Local CI PR watcher`, `Root tests: Changelog`, `Root tests: Version mirrors tests`, `MySQL dump reader`, `Root tests: Audit data pribadi tests`, `BPS table row fixtures`, `Deploy scenario test harness`, `Repo: Package`, `Root tests: Template tanpa starsender tests`, `Root tests: Audit graf tests`, `Storefront: Booking build smoke tests`, `Social-meta build-smoke test`, `Release audit tests`, `Root tests: Deploy smoke bun runtime tests`, `Storefront: Kontak fallback null tests`?**
  _High betweenness centrality (0.209) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Template init planner` to `Site identity composition`, `Shared profile-route test harness`?**
  _High betweenness centrality (0.106) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site identity composition` to `Storefront: Masuk`, `News feed, rubric and pagination`, `Storefront: Akun pesan`, `Storefront cart and affiliate contracts`, `Storefront: Navigasi profil`, `Environment access and static page fetch`, `Commerce catalog wire types`, `E2E accessibility and responsive specs`, `Recent news loader`, `Booking actions and CSS font test`, `Site build-profile config`, `Storefront: Media`, `Article/video schema & breadcrumbs`, `News navigation`, `Blog & ad-placement fetch helpers`, `Shared profile-route test harness`, `News article view`, `Account contract types (akun-kontrak)`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _991 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Gate library and docs-translation audit` be split into smaller, more focused modules?**
  _Cohesion score 0.05970790378006873 - nodes in this community are weakly interconnected._
- **Should `News feed, rubric and pagination` be split into smaller, more focused modules?**
  _Cohesion score 0.04188129899216125 - nodes in this community are weakly interconnected._
- **Should `Tooling: Lib storefront consumer contract` be split into smaller, more focused modules?**
  _Cohesion score 0.05052125100240577 - nodes in this community are weakly interconnected._