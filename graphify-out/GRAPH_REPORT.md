# Graph Report - .  (2026-10-20)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 2838 nodes · 6539 edges · 129 communities (112 shown, 17 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 54 edges (avg confidence: 0.59)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2b158bb7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Gate library and docs-translation audit
- CMS seed CLI
- Site identity composition
- News feed and rubric data
- Storefront dev stub server (awcms API)
- Dev server routing & Daerah panel
- Local CI leg table
- Template init plan & rewrite
- Knowledge-graph gate (audit:graf)
- Local CI process and port helpers
- News navigation
- Site build-profile config
- First-party analytics beacon
- Account API client
- Storefront order client
- Release & changeset tooling
- Article/video schema & breadcrumbs
- Storefront theme and brand tokens
- Site identity and AWCMS settings fallback
- Article view rendering
- Marketing data client
- Root package.json manifest
- Share-row (bagikan) tests
- Shared profile-route test harness
- Institution and partner data
- Docs audit gate (audit:dokumen)
- Checkout region & courier lookups
- Static page & portable text rendering
- Storefront package.json manifest
- Booking order form script
- Booking API contract types
- Seed-profile validation tests
- E2E global setup
- Account reservations page script
- Cart storage client
- Registration (daftar) OTP screen
- Customer session & wishlist sync
- Checkout flow helpers
- Build-smoke stub lifecycle
- Legacy seputarborneo importer
- Commerce catalog wire types
- CMS API fetch client
- Blog & ad-placement fetch helpers
- Docs i18n mirror stamping
- Shared storefront components and helpers
- Booking availability search script
- Sitemap XML rendering
- Obsidian export tool
- Astro profile route injection
- Account reviews page
- Ad popup widget
- Listing search script
- Read-aloud (dengar) player
- Affiliate capture contract
- Legacy importer tests
- Account session contract
- Product listing filters & sort
- E2E accessibility and responsive specs
- Account address book
- getVideo
- MySQL dump reader
- PWA web manifest
- Account affiliate page
- bacaSesi
- Terpopuler analytics client
- Cart quote and rendering
- runExport
- Account order-history screen
- Account profile page
- Deploy scenario test harness
- audit:graf end-to-end tests
- Root package manifest
- Lockfile consistency check
- Base tsconfig compiler options
- Deploy shell common library
- Catalog contract test
- Product detail variant pricing
- Price formatting utilities
- Storefront API request envelope & signup
- Product JSON-LD schema
- Storefront tsconfig compiler options
- kontrak package manifest
- Subtree-write guard tests
- Checkout phone and order submission
- Obsidian export tool tests
- No-prerender guard tests
- Production compose file tests
- Recent-news (terkini) loader
- News search page
- Contract import-direction test
- README screenshot renderer
- GA4 opt-in init
- Booking build-smoke test
- Social-meta build-smoke test
- Stale-phrase prose check
- packages/config manifest
- packages/gerbang manifest
- Release backlog audit tests
- Promo popup dialog
- Contact fallback null test
- Sidebar build-smoke test
- Bun version-pin test
- Storefront Dockerfile security-update guard
- Root dependency overrides
- Kontrak tsconfig compiler options
- Env-example coverage test
- Graph-update tool (knowledge:graph:update)
- Storefront build-id smoke
- Share row build-smoke test
- Read-aloud build-smoke test
- Institution emblem build-smoke test
- Lynx direction doc test
- Affiliate build-smoke test
- Payment gateway build-smoke test
- Newsletter path-contract test
- Product bundle build-smoke test
- Order build-smoke test
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
1. `ROUTES` - 61 edges
2. `bun` - 60 edges
3. `kirimPermintaan()` - 43 edges
4. `scripts` - 42 edges
5. `getSiteIdentity()` - 37 edges
6. `bacaSesi()` - 37 edges
7. `formatPrice()` - 36 edges
8. `buildWhatsappUrl()` - 27 edges
9. `main()` - 27 edges
10. `authHeader()` - 27 edges

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

## Communities (129 total, 17 thin omitted)

### Community 0 - "Gate library and docs-translation audit"
Cohesion: 0.06
Nodes (77): ADR-0020, DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage() (+69 more)

### Community 1 - "CMS seed CLI"
Cohesion: 0.06
Nodes (78): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+70 more)

### Community 2 - "Site identity composition"
Cohesion: 0.06
Nodes (37): ROUTES, ADR-0018, ADR-0045, getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), getSiteIdentity() (+29 more)

### Community 3 - "News feed and rubric data"
Cohesion: 0.05
Nodes (65): RawTerm, AuthorArchive, BeritaFeedItem, buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive, DaerahLink (+57 more)

### Community 4 - "Storefront dev stub server (awcms API)"
Cohesion: 0.05
Nodes (69): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), bookingStub, buildAffiliateLink(), buildCourierOptions(), buildPaymentInstructions(), computeQuote() (+61 more)

### Community 5 - "Dev server routing & Daerah panel"
Cohesion: 0.06
Nodes (64): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+56 more)

### Community 6 - "Local CI leg table"
Cohesion: 0.07
Nodes (57): gitRunOrThrow(), PKG, EXPECTED_CONTEXTS, main(), parseArgs(), main(), parseArgs(), hasRecordedResult() (+49 more)

### Community 7 - "Template init plan & rewrite"
Cohesion: 0.06
Nodes (55): canSpawnBun(), NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), ADR-0018, applyPlan(), applyColorDefaults(), BOOLEAN_FLAGS, FLAG_KEYS (+47 more)

### Community 8 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.05
Nodes (50): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+42 more)

### Community 9 - "Local CI process and port helpers"
Cohesion: 0.08
Nodes (44): redactLine(), redactText(), valid, fakeBearerValue, fakeDsnPassword, fakeGithubToken, AuditException, auditIgnoreArgs() (+36 more)

### Community 10 - "News navigation"
Cohesion: 0.06
Nodes (47): socialIcons, tokoAktif, rubrikColumn, year, daerahActive, getAllInstitutions(), buildRegionIndex(), findKaltengProvince() (+39 more)

### Community 11 - "Site build-profile config"
Cohesion: 0.06
Nodes (45): CSP_NEEDS, CspNeeds, cspNeedsFor(), DEFAULT_SITE_PROFILE, describeProfile(), FeedEntry, FEEDS, FEEDS_ALL (+37 more)

### Community 12 - "First-party analytics beacon"
Cohesion: 0.06
Nodes (31): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+23 more)

### Community 13 - "Account API client"
Cohesion: 0.11
Nodes (45): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilKomisiAfiliasi(), ambilPercakapan(), ambilPercakapanById(), ambilPoin() (+37 more)

### Community 14 - "Storefront order client"
Cohesion: 0.06
Nodes (42): TawaranBooking, createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS, PESANAN_PHONE_KEY, ambilTawaranBooking() (+34 more)

### Community 15 - "Release & changeset tooling"
Cohesion: 0.08
Nodes (40): changelogSection(), findChangelogHeadings(), normalizeLineEndings(), normalizeRequestedVersion(), CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile() (+32 more)

### Community 16 - "Article/video schema & breadcrumbs"
Cohesion: 0.08
Nodes (37): absoluteUrl(), getVideo(), PostDetail, ADR-0109, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema() (+29 more)

### Community 17 - "Storefront theme and brand tokens"
Cohesion: 0.08
Nodes (34): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, chunk() (+26 more)

### Community 18 - "Site identity and AWCMS settings fallback"
Cohesion: 0.08
Nodes (32): SITEMAP_SOURCES, DEFAULT_IDENTITY, DefaultIdentity, siteConfig, siteUrl, AwcmsApiError, awcmsGet(), baseUrl() (+24 more)

### Community 19 - "Article view rendering"
Cohesion: 0.08
Nodes (30): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+22 more)

### Community 20 - "Marketing data client"
Cohesion: 0.08
Nodes (37): getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus (+29 more)

### Community 21 - "Root package.json manifest"
Cohesion: 0.05
Nodes (42): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+34 more)

### Community 22 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 23 - "Shared profile-route test harness"
Cohesion: 0.12
Nodes (29): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, activeRouteKeys() (+21 more)

### Community 24 - "Institution and partner data"
Cohesion: 0.09
Nodes (28): RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), chunk(), fetchMediaPublicOrigin() (+20 more)

### Community 25 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.11
Nodes (34): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+26 more)

### Community 26 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 27 - "Static page & portable text rendering"
Cohesion: 0.11
Nodes (33): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), collectGalleryMediaObjectIds(), documentHasPlayableVideo(), escapeHtml() (+25 more)

### Community 28 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 29 - "Booking order form script"
Cohesion: 0.16
Nodes (32): buatHoldAktif(), parseHoldAktif(), pengumumanAmbang(), sidikPermintaan(), ambilKuotaBooking(), backToSearchHref(), focusHeading(), forgetHold() (+24 more)

### Community 30 - "Booking API contract types"
Cohesion: 0.09
Nodes (26): BOOKING_AKTIF_KEY, buatPathPesan(), formatSisa(), GalatTanggal, GambarBooking, HalamanReservasiSaya, HoldAktif, KetersediaanMenginap (+18 more)

### Community 31 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 32 - "E2E global setup"
Cohesion: 0.10
Nodes (20): api(), browserPage(), day(), hold(), login(), [R1, R2], register(), Sesi (+12 more)

### Community 33 - "Account reservations page script"
Cohesion: 0.16
Nodes (26): isNol(), labelPembayaran(), labelStatusReservasi(), sisaDetik(), statusEfektif(), tujuanSesiGateway(), createGatewaySession(), appendRows() (+18 more)

### Community 34 - "Cart storage client"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 35 - "Registration (daftar) OTP screen"
Cohesion: 0.14
Nodes (24): buildWhatsappAccountMessage(), buildWhatsappUrl(), ADR-0003, ADR-0007, showSubmitError(), appendConversationRows(), hideSubmitError(), loadDetail() (+16 more)

### Community 36 - "Customer session & wishlist sync"
Cohesion: 0.20
Nodes (21): loadWishlist(), removeFromWishlist(), saveWishlist(), toggleWishlist(), addWishlistItem(), createEmptyWishlist(), isIsoDateString(), isWishlisted() (+13 more)

### Community 37 - "Checkout flow helpers"
Cohesion: 0.13
Nodes (22): Alamat, Cart, bacaPoinInput(), bolehPakaiPoin(), parsePoinAkun(), perkiraanDiskonPoin(), pesanKesalahanPoin(), PoinAkun (+14 more)

### Community 38 - "Build-smoke stub lifecycle"
Cohesion: 0.11
Nodes (13): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun() (+5 more)

### Community 39 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 40 - "Commerce catalog wire types"
Cohesion: 0.09
Nodes (23): assertNeverProductStatus(), CategoryNode, CommerceBundle, CommerceBundleComponent, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, getProduct() (+15 more)

### Community 41 - "CMS API fetch client"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 42 - "Blog & ad-placement fetch helpers"
Cohesion: 0.15
Nodes (17): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+9 more)

### Community 43 - "Docs i18n mirror stamping"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 44 - "Shared storefront components and helpers"
Cohesion: 0.12
Nodes (12): [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE, StaticPageSummary, detectInstallState() (+4 more)

### Community 45 - "Booking availability search script"
Cohesion: 0.20
Nodes (20): formatTanggalPendek(), labelZonaWaktu(), nomorHari(), parseParamCari(), periksaTanggal(), pesanGalatBooking(), tanggalLokal(), ambilKetersediaanBooking() (+12 more)

### Community 46 - "Sitemap XML rendering"
Cohesion: 0.20
Nodes (17): chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), registerSitemapSource(), renderSitemapIndexXml(), renderUrlsetXml(), resetSitemapEntriesCacheForTests() (+9 more)

### Community 47 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 48 - "Astro profile route injection"
Cohesion: 0.17
Nodes (16): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), ADR-0018, PAGE_EXTENSIONS (+8 more)

### Community 49 - "Account reviews page"
Cohesion: 0.14
Nodes (15): UlasanAkun, Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, ValidationErrorDetail, hideSubmitError(), loadList(), render() (+7 more)

### Community 50 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 51 - "Listing search script"
Cohesion: 0.19
Nodes (15): filterProdukIndex(), normalizeSearchTerm(), paginateProdukIndex(), ProdukIndexEntry, emptyState, grid, heading, paginationEl (+7 more)

### Community 52 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 53 - "Affiliate capture contract"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 54 - "Legacy importer tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 55 - "Account session contract"
Cohesion: 0.25
Nodes (14): AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun, ADR-0007, validateAkun() (+6 more)

### Community 56 - "Product listing filters & sort"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 57 - "E2E accessibility and responsive specs"
Cohesion: 0.18
Nodes (11): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, firstSlug(), KEY_PAGES, KeyPage, keyPagesFor(), VIEWPORTS (+3 more)

### Community 58 - "Account address book"
Cohesion: 0.28
Nodes (15): AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate(), openFormForEdit() (+7 more)

### Community 59 - "getVideo"
Cohesion: 0.18
Nodes (11): getLegacyRedirectRows(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET(), prerender (+3 more)

### Community 60 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 61 - "PWA web manifest"
Cohesion: 0.21
Nodes (12): SITE_PROFILE, SiteProfile, buildManifest(), ICON_PATHS, MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, ManifestInput (+4 more)

### Community 62 - "Account affiliate page"
Cohesion: 0.22
Nodes (14): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+6 more)

### Community 63 - "bacaSesi"
Cohesion: 0.27
Nodes (11): simpanWishlistAkun(), bacaSesi(), laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), gabungkanWishlist() (+3 more)

### Community 64 - "Terpopuler analytics client"
Cohesion: 0.23
Nodes (10): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+2 more)

### Community 65 - "Cart quote and rendering"
Cohesion: 0.21
Nodes (13): CartQuote, quoteCart(), QuoteLine, buildWhatsappCartMessage(), lineText(), hideQuoteError(), refresh(), renderLines() (+5 more)

### Community 66 - "runExport"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 67 - "Account order-history screen"
Cohesion: 0.27
Nodes (13): AkunPesananHalaman, ambilPesananAkun(), ambilPesananAkunByKode(), appendOrderRows(), hideSubmitError(), loadDetail(), loadMore(), maybeStartPolling() (+5 more)

### Community 68 - "Account profile page"
Cohesion: 0.27
Nodes (13): hideSubmitError(), initialsFor(), LEVEL_LABELS, levelLabel(), loadStats(), render(), renderProfile(), root (+5 more)

### Community 69 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 70 - "audit:graf end-to-end tests"
Cohesion: 0.18
Nodes (7): canSpawnBun(), runBuild(), bun, cleanup, fixture(), run(), SCRIPT

### Community 71 - "Root package manifest"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 72 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 73 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 74 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 75 - "Catalog contract test"
Cohesion: 0.18
Nodes (7): buildPriceTiers(), collectCategorySubtreeIds(), getCategoryBySlug(), labelClassName(), productsInCategory(), GET(), prerender

### Community 76 - "Product detail variant pricing"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 77 - "Price formatting utilities"
Cohesion: 0.29
Nodes (10): comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003, HARGA_FILE, SCANNABLE_EXTENSIONS (+2 more)

### Community 78 - "Storefront API request envelope & signup"
Cohesion: 0.35
Nodes (10): mintaKode(), clearFieldErrors(), hideSubmitError(), root, sendCode(), showCodeStep(), showStatus(), showSubmitError() (+2 more)

### Community 79 - "Product JSON-LD schema"
Cohesion: 0.29
Nodes (7): CommerceCategory, CommerceProduct, CommerceProductVariant, breadcrumbListNode(), buildCategoryPageSchema(), buildProductPageSchema(), ProductSchemaInput

### Community 80 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 81 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 82 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 83 - "Checkout phone and order submission"
Cohesion: 0.44
Nodes (9): applyRegionSelection(), fetchRegionJson(), fillRegionOptions(), loadKabupaten(), loadKecamatan(), loadProvinces(), RegionOption, RegionSelects (+1 more)

### Community 84 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 85 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 86 - "Production compose file tests"
Cohesion: 0.25
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 87 - "Recent-news (terkini) loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 88 - "News search page"
Cohesion: 0.29
Nodes (5): input, matches, needle, resultsList, status

### Community 89 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 90 - "README screenshot renderer"
Cohesion: 0.33
Nodes (5): run, { values }, isSiteProfile(), resolveSiteProfile(), SITE_PROFILES

### Community 91 - "GA4 opt-in init"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 92 - "Booking build-smoke test"
Cohesion: 0.33
Nodes (3): canSpawnBun(), PAGE_SOURCES, PAGES

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

### Community 98 - "Promo popup dialog"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 99 - "Contact fallback null test"
Cohesion: 0.40
Nodes (3): canSpawnBun(), FIXTURE_PATH, SITE_TS_PATH

### Community 101 - "Bun version-pin test"
Cohesion: 0.40
Nodes (4): ADR-0021, orchestrate, pkg, VERSION

### Community 102 - "Storefront Dockerfile security-update guard"
Cohesion: 0.40
Nodes (4): ADR-0049, dockerfile, DOCKERFILE_PATH, REPO_ROOT

### Community 103 - "Root dependency overrides"
Cohesion: 0.40
Nodes (5): overrides, sharp, shell-quote, smol-toml, source-map-js

### Community 104 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 106 - "Graph-update tool (knowledge:graph:update)"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 107 - "Storefront build-id smoke"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 108 - "Share row build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 109 - "Read-aloud build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 110 - "Institution emblem build-smoke test"
Cohesion: 0.50
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 119 - "Workspace member globs"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **804 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+799 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `audit:graf end-to-end tests` to `Gate library and docs-translation audit`, `Local CI leg table`, `Template init plan & rewrite`, `Knowledge-graph gate (audit:graf)`, `Local CI process and port helpers`, `Release & changeset tooling`, `Shared profile-route test harness`, `Docs audit gate (audit:dokumen)`, `E2E global setup`, `Build-smoke stub lifecycle`, `MySQL dump reader`, `runExport`, `Deploy scenario test harness`, `Root package manifest`, `Booking build-smoke test`, `Social-meta build-smoke test`, `Release backlog audit tests`, `Contact fallback null test`, `Sidebar build-smoke test`, `Graph-update tool (knowledge:graph:update)`, `Storefront build-id smoke`, `Share row build-smoke test`, `Read-aloud build-smoke test`, `Institution emblem build-smoke test`, `Affiliate build-smoke test`, `Payment gateway build-smoke test`, `Product bundle build-smoke test`, `Order build-smoke test`?**
  _High betweenness centrality (0.184) - this node is a cross-community bridge._
- **Why does `ROUTES` connect `Site identity composition` to `Account reservations page script`, `News feed and rubric data`, `Registration (daftar) OTP screen`, `Account order-history screen`, `News navigation`, `Site build-profile config`, `Shared storefront components and helpers`, `Blog & ad-placement fetch helpers`, `Storefront API request envelope & signup`, `Article/video schema & breadcrumbs`, `Site identity and AWCMS settings fallback`, `Article view rendering`, `Shared profile-route test harness`, `News search page`, `Institution and partner data`, `getVideo`, `E2E accessibility and responsive specs`?**
  _High betweenness centrality (0.124) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `Template init plan & rewrite` to `Astro profile route injection`, `CMS seed CLI`, `Shared profile-route test harness`?**
  _High betweenness centrality (0.099) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _804 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Gate library and docs-translation audit` be split into smaller, more focused modules?**
  _Cohesion score 0.05710162853019996 - nodes in this community are weakly interconnected._
- **Should `CMS seed CLI` be split into smaller, more focused modules?**
  _Cohesion score 0.05510388437217705 - nodes in this community are weakly interconnected._
- **Should `Site identity composition` be split into smaller, more focused modules?**
  _Cohesion score 0.06481481481481481 - nodes in this community are weakly interconnected._