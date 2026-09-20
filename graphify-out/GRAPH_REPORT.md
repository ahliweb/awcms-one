# Graph Report - .  (2026-09-20)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 2185 nodes · 4809 edges · 116 communities (99 shown, 17 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 37 edges (avg confidence: 0.61)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a67521b1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- seed-cms.ts
- penyaji.mjs
- audit-graf.mjs
- plan.mjs
- routes.ts
- berita.ts
- portable-text.ts
- navigasi-berita.ts
- stub-awcms.mjs
- video/[slug].astro
- pemasaran.ts
- scripts
- bagikan.test.ts
- toko-klien.ts
- wishlist-akun-sync.ts
- buletin.ts
- audit-dokumen.mjs
- config/profil.ts
- wilayah-checkout.ts
- rilis.mjs
- BeritaLayout.astro
- awcms/profil.ts
- scripts
- lembaga.ts
- akun-klien.ts
- seed-profil.test.mjs
- bacaSesi
- keranjang-kontrak.ts
- import-seputarborneo.ts
- profil-build-smoke.test.ts
- sitemap.ts
- redirect-push.ts
- kategori/[slug].astro
- formatPrice
- catalog.ts
- knowledge-graph-combine.mjs
- profil.mjs
- site.ts
- knowledge-obsidian-export.mjs
- wilayah.ts
- iklan-popup.ts
- masuk.ts
- dengar.ts
- afiliasi-kontrak.ts
- getProducts
- import-seputarborneo.test.mjs
- akun-alamat.ts
- awcms/analitik.ts
- theme.ts
- cari-listing.ts
- produk-listing.ts
- checkout.ts
- mysql-dump-reader.ts
- requireAwcmsOrigin
- runExport
- akun-afiliasi.ts
- pages.ts
- bun
- getVideo
- cek-lockfile.mjs
- compilerOptions
- produk-detail.ts
- daftar.ts
- akun-ulasan.ts
- akun.ts
- compilerOptions
- kontrak/package.json
- knowledge-no-subtree-write.test.mjs
- isGroupActive
- akun-pesanan.ts
- wilayah-region-select.ts
- global-setup.ts
- product/[slug].astro
- knowledge-obsidian-export.test.mjs
- checkout-guard-no-prerender.test.ts
- Footer.astro
- berita-terkini.ts
- warna.ts
- meta-sosial-build-smoke.test.ts
- kontrak-arah-impor.test.mjs
- katalog-harga.test.ts
- ga-init.ts
- analitik-build-smoke.test.ts
- sidebar-build-smoke.test.ts
- config/package.json
- gerbang/package.json
- audit-rilis.test.mjs
- robots.txt.ts
- promo-popup.ts
- bagikan-build-smoke.test.ts
- dengar-build-smoke.test.ts
- logo-instansi-build-smoke.test.ts
- compilerOptions
- audit-graf.test.mjs
- root-env-example-coverage.test.mjs
- write-build-id.mjs
- afiliasi-build-smoke.test.ts
- akun-dashboard-build-smoke.test.ts
- gateway-build-smoke.test.ts
- pesan-build-smoke.test.ts
- versi-toolchain.test.mjs
- knowledge-graph-update.mjs
- video-facade.ts
- build-smoke.test.ts
- checkout-build-smoke.test.ts
- katalog-build-smoke.test.ts
- kurir-build-smoke.test.ts
- newsletter-path-contract.test.ts
- 01-create-least-privilege-roles.sh
- seed-borneojek-mart.ts
- blog.ts
- Sidebar.astro

## God Nodes (most connected - your core abstractions)
1. `ROUTES` - 54 edges
2. `bun` - 32 edges
3. `getSiteIdentity()` - 31 edges
4. `kirimPermintaan()` - 31 edges
5. `scripts` - 28 edges
6. `formatPrice()` - 27 edges
7. `bacaSesi()` - 24 edges
8. `getStoreSettings()` - 20 edges
9. `readEnv()` - 19 edges
10. `absoluteUrl()` - 19 edges

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
  apps/storefront/tests/afiliasi-build-smoke.test.ts → package.json

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (116 total, 17 thin omitted)

### Community 0 - "CMS seeding: profile seed loader & validators"
Cohesion: 0.05
Nodes (80): AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed (+72 more)

### Community 1 - "Storefront server: legacy redirects & shadow-path rewrite"
Cohesion: 0.06
Nodes (64): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+56 more)

### Community 2 - "Knowledge-graph audit gate"
Cohesion: 0.05
Nodes (54): graphPath, outputDir, reporter, reportPath, subtreeTrackedOutput, trackedOutput, dated, oldest (+46 more)

### Community 3 - "template:init planning & CLI"
Cohesion: 0.06
Nodes (57): ADR-0018, runTemplateInitTests(), applyPlan(), applyColorDefaults(), BOOLEAN_FLAGS, FLAG_KEYS, missingRequired(), ADR-0018 (+49 more)

### Community 4 - "Storefront route registry & groups"
Cohesion: 0.10
Nodes (16): tokoAktif, PRIMARY_NAV, ROUTE_GROUPS, ROUTES, STATIC_PAGE_SLUGS, ADR-0018, SITEMAP_SOURCE_NAMES, input (+8 more)

### Community 5 - "News (berita) client library"
Cohesion: 0.06
Nodes (45): RawTerm, AuthorArchive, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive, DaerahLink (+37 more)

### Community 6 - "Portable Text rendering"
Cohesion: 0.06
Nodes (47): chunk(), fetchMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests(), resolvedCache (+39 more)

### Community 7 - "News navigation resolver"
Cohesion: 0.09
Nodes (38): rubrikColumn, year, daerahActive, RawInstitution, listStaticPages(), flattenRubrikTree(), getRubrikTree(), RegionRef (+30 more)

### Community 8 - "Stub CMS server for storefront tests"
Cohesion: 0.09
Nodes (45): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), buildAffiliateLink(), buildPaymentInstructions(), computeQuote(), corsHeaders(), deterministicAffiliateCode() (+37 more)

### Community 9 - "News video pages"
Cohesion: 0.07
Nodes (36): absoluteUrl(), BeritaFeedItem, escapeCdata(), escapeXml(), getPost(), getPosts(), renderBeritaRssXml(), BreadcrumbItem (+28 more)

### Community 10 - "Marketing surfaces client"
Cohesion: 0.08
Nodes (36): getActiveAdPlacements(), getAdSlot(), getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, FlashSale, FlashSaleProductEntry (+28 more)

### Community 11 - "Root package.json scripts registry"
Cohesion: 0.05
Nodes (43): description, engines, homepage, license, name, packageManager, private, repository (+35 more)

### Community 12 - "Share row (bagikan) tests"
Cohesion: 0.09
Nodes (33): followLinks, shareLinks, socialIcons, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform (+25 more)

### Community 13 - "Anonymous commerce API client (toko-klien)"
Cohesion: 0.07
Nodes (35): createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, PESANAN_PHONE_KEY, cancelOrder(), CartLineStatus, CreateOrderRequest (+27 more)

### Community 14 - "Wishlist/account sync"
Cohesion: 0.14
Nodes (29): laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist(), saveWishlist() (+21 more)

### Community 15 - "Newsletter (buletin) client"
Cohesion: 0.08
Nodes (21): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+13 more)

### Community 16 - "Documentation audit gate"
Cohesion: 0.11
Nodes (34): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+26 more)

### Community 17 - "Build profile configuration"
Cohesion: 0.08
Nodes (31): CSP_NEEDS, CspNeeds, DEFAULT_SITE_PROFILE, FeedEntry, FEEDS, FEEDS_ALL, FooterPageLink, GROUP_STYLESHEET_HREFS (+23 more)

### Community 18 - "Checkout region (wilayah) cascade"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 19 - "Release tooling"
Cohesion: 0.11
Nodes (32): CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile(), parseChangeset(), validateChangeset(), gitRunOrThrow(), atLeastAsSignificant() (+24 more)

### Community 20 - "News layout & chrome"
Cohesion: 0.11
Nodes (25): ResolvedMedia, paginate(), PostDetail, articleSocialMeta(), isHttpUrl(), listingSocialMeta(), MetaTag, ogImageMeta() (+17 more)

### Community 21 - "Storefront site-profile client"
Cohesion: 0.14
Nodes (15): getStoreSettings(), isGoogleMapsEmbedUrl(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), getSiteIdentity(), isExpectedRefusal(), SiteIdentity (+7 more)

### Community 22 - "Storefront package.json scripts"
Cohesion: 0.06
Nodes (31): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @playwright/test (+23 more)

### Community 23 - "Institution (lembaga/mitra) directory"
Cohesion: 0.18
Nodes (12): getAllInstitutions(), buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), resolveRegion(), getMitra() (+4 more)

### Community 24 - "Customer account API client"
Cohesion: 0.18
Nodes (29): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilKomisiAfiliasi(), ambilPesananAkun(), ambilPesananAkunByKode(), ambilProfil() (+21 more)

### Community 25 - "Profile seed validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 26 - "Customer session storage (akun-sesi)"
Cohesion: 0.15
Nodes (21): verifikasiKode(), Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun (+13 more)

### Community 27 - "Cart contract types"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 28 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 29 - "Build-profile smoke tests"
Cohesion: 0.16
Nodes (21): routePathPrefix(), SiteProfile, GROUP_FILES, GROUP_SITEMAP_PATHS, ADR-0018, PROFILE, ADR-0018, BUILD_TIMEOUT_MS (+13 more)

### Community 30 - "Sitemap generation"
Cohesion: 0.16
Nodes (20): SITEMAP_SOURCES, chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), KATALOG_SITEMAP_SOURCE_NAMES, registerSitemapSource(), renderSitemapIndexXml() (+12 more)

### Community 31 - "Legacy redirect import tooling"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 32 - "Category listing page"
Cohesion: 0.14
Nodes (13): buildPriceTiers(), collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, CommerceProductVariant, getCategoryBySlug(), productsInCategory(), BreadcrumbItem (+5 more)

### Community 33 - "Price formatting (harga)"
Cohesion: 0.17
Nodes (19): formatPrice(), PRICE_FORMATTER, ADR-0003, Cart, quoteCart(), buildWhatsappCartMessage(), buildWhatsappUrl(), lineText() (+11 more)

### Community 34 - "Catalog client library"
Cohesion: 0.11
Nodes (22): assertNeverProductStatus(), CategoryNode, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, filterProdukIndex(), isPubliclyVisible(), listAllCategories() (+14 more)

### Community 35 - "Knowledge-graph federation/combine tooling"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 36 - "Astro build-profile integration"
Cohesion: 0.15
Nodes (18): ADR-0018, SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), ADR-0018 (+10 more)

### Community 37 - "Site identity & theme config"
Cohesion: 0.16
Nodes (15): DEFAULT_IDENTITY, DEFAULT_THEME_COLORS, siteUrl, awcmsGet(), baseUrl(), Envelope, timeoutMs(), mergeSiteIdentity() (+7 more)

### Community 38 - "Knowledge-graph Obsidian export"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 39 - "Region (wilayah) data client"
Cohesion: 0.17
Nodes (17): buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf(), getResolvableRegionsByCode(), listLintasKalimantanProvinces(), listRegions(), matchesProvinceName() (+9 more)

### Community 40 - "Ad popup"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 41 - "Customer sign-in (masuk) page script"
Cohesion: 0.16
Nodes (13): Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, ValidationErrorDetail, clearFieldErrors(), hideSubmitError(), root, sendCode() (+5 more)

### Community 42 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 43 - "Affiliate contract & capture"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 44 - "Product catalog data fetchers"
Cohesion: 0.15
Nodes (15): buildCategoryTree(), buildProdukIndex(), getCategories(), getProduct(), getProducts(), labelClassName(), primaryProductImage(), PRODUK_PAGE_SIZE (+7 more)

### Community 45 - "Legacy importer tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 46 - "Account address book"
Cohesion: 0.26
Nodes (16): Alamat, AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate() (+8 more)

### Community 47 - "Visitor analytics client"
Cohesion: 0.20
Nodes (11): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+3 more)

### Community 48 - "Theme token tests/config"
Cohesion: 0.18
Nodes (12): apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, GET(), prerender (+4 more)

### Community 49 - "Product search listing"
Cohesion: 0.21
Nodes (13): paginateProdukIndex(), ProdukIndexEntry, emptyState, grid, heading, paginationEl, run(), cardHtml() (+5 more)

### Community 50 - "Product listing page logic"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 51 - "Checkout page script"
Cohesion: 0.18
Nodes (12): keepDigitsAndLeadingPlus(), previewIndonesianPhone(), CartLineRequest, CartQuote, createOrder(), ShippingSelection, root, runCheckout() (+4 more)

### Community 52 - "Legacy MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 53 - "AWCMS origin validation (toko-origin)"
Cohesion: 0.22
Nodes (10): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+2 more)

### Community 54 - "Legacy export runner"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 55 - "Affiliate dashboard page"
Cohesion: 0.26
Nodes (13): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, loadMoreKomisi(), render(), renderEnrolled(), root (+5 more)

### Community 56 - "Storefront page group definitions"
Cohesion: 0.19
Nodes (10): detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), StaticPageDetail, ADR-0100, bodyHtml (+2 more)

### Community 57 - "Test harness bootstrap"
Cohesion: 0.14
Nodes (6): canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), bun, gitRunInherit()

### Community 58 - "News video data fetchers"
Cohesion: 0.26
Nodes (10): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), ADR-0071, GET() (+2 more)

### Community 59 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 60 - "kontrak package tsconfig"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 61 - "Product detail page logic"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 62 - "Customer registration (daftar) page"
Cohesion: 0.35
Nodes (10): mintaKode(), clearFieldErrors(), hideSubmitError(), root, sendCode(), showCodeStep(), showStatus(), showSubmitError() (+2 more)

### Community 63 - "Account reviews (ulasan)"
Cohesion: 0.31
Nodes (10): UlasanAkun, hideSubmitError(), loadList(), render(), renderItem(), root, showGuestView(), showSubmitError() (+2 more)

### Community 64 - "Account dashboard page script"
Cohesion: 0.35
Nodes (10): hideSubmitError(), LEVEL_LABELS, levelLabel(), render(), renderProfile(), root, showAccountView(), showGuestView() (+2 more)

### Community 65 - "storefront package tsconfig"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 66 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 67 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 68 - "Profile group activation logic"
Cohesion: 0.33
Nodes (10): activeRouteKeys(), cspNeedsFor(), describeProfile(), excludedRouteKeys(), feedsFor(), groupStylesheetsFor(), isGroupActive(), isRouteActive() (+2 more)

### Community 69 - "Account order history page"
Cohesion: 0.38
Nodes (9): AkunPesananHalaman, buildWhatsappAccountMessage(), appendOrderRows(), hideSubmitError(), loadDetail(), loadMore(), render(), root (+1 more)

### Community 70 - "Region select widget"
Cohesion: 0.44
Nodes (9): applyRegionSelection(), fetchRegionJson(), fillRegionOptions(), loadKabupaten(), loadKecamatan(), loadProvinces(), RegionOption, RegionSelects (+1 more)

### Community 71 - "Storefront test global setup"
Cohesion: 0.33
Nodes (6): globalSetup(), ADR-0002, ADR-0007, waitForHttp(), PREVIEW_PORT, STUB_PORT

### Community 72 - "Product detail page (astro)"
Cohesion: 0.28
Nodes (3): findFlashSaleForProduct(), formatRemaining(), tick()

### Community 73 - "Obsidian export tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 74 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 75 - "Site footer component"
Cohesion: 0.29
Nodes (6): footerLinks, publishedSlugs, year, FOOTER_PAGE_LINKS, SEARCH_SURFACE, StaticPageSummary

### Community 76 - "News ticker (terkini)"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 77 - "Colour contrast utilities"
Cohesion: 0.62
Nodes (5): contrastingForeground(), contrastRatio(), isValidHexColor(), relativeLuminance(), WCAG_AA_TEXT_CONTRAST

### Community 78 - "Social metadata smoke tests"
Cohesion: 0.38
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 79 - "Import-direction gate tests"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 80 - "Catalog pricing tests"
Cohesion: 0.40
Nodes (5): formatDiscountPercent(), HARGA_FILE, SCANNABLE_EXTENSIONS, SRC_ROOT, walk()

### Community 81 - "GA4 analytics init"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 84 - "config package manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 85 - "gerbang package manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 86 - "Release audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 87 - "Robots.txt generation"
Cohesion: 0.40
Nodes (3): ROBOTS_DISALLOW, siteConfig, prerender

### Community 88 - "Promo popup component logic"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 89 - "Share row smoke tests"
Cohesion: 0.40
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 90 - "Read-aloud smoke tests"
Cohesion: 0.40
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 91 - "Institution logo smoke tests"
Cohesion: 0.40
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 92 - "config package tsconfig"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 95 - "Build-id writer"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 101 - "Toolchain pin tests"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

### Community 114 - "Blog/news content client"
Cohesion: 0.15
Nodes (16): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getAllPosts(), getAllTerms() (+8 more)

### Community 115 - "Sidebar component"
Cohesion: 0.23
Nodes (11): toDatetimeAttr(), PostSummary, formatBulanArsipWIB(), formatTanggalPanjangWIB(), formatTanggalWaktuWIB(), formatWaktuWIB(), pernahDiperbaruiSetelahTerbit(), toDatetimeAttr() (+3 more)

## Knowledge Gaps
- **635 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+630 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `bun` to `audit-graf.mjs`, `scripts`, `audit-dokumen.mjs`, `rilis.mjs`, `profil-build-smoke.test.ts`, `mysql-dump-reader.ts`, `runExport`, `global-setup.ts`, `meta-sosial-build-smoke.test.ts`, `analitik-build-smoke.test.ts`, `sidebar-build-smoke.test.ts`, `audit-rilis.test.mjs`, `bagikan-build-smoke.test.ts`, `dengar-build-smoke.test.ts`, `logo-instansi-build-smoke.test.ts`, `write-build-id.mjs`, `afiliasi-build-smoke.test.ts`, `akun-dashboard-build-smoke.test.ts`, `gateway-build-smoke.test.ts`, `pesan-build-smoke.test.ts`, `build-smoke.test.ts`, `checkout-build-smoke.test.ts`, `katalog-build-smoke.test.ts`, `kurir-build-smoke.test.ts`?**
  _High betweenness centrality (0.295) - this node is a cross-community bridge._
- **Why does `buildProfile()` connect `profil-build-smoke.test.ts` to `bun`?**
  _High betweenness centrality (0.130) - this node is a cross-community bridge._
- **Why does `canSpawnBun()` connect `profil-build-smoke.test.ts` to `bun`?**
  _High betweenness centrality (0.127) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _635 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `seed-cms.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05335628227194492 - nodes in this community are weakly interconnected._
- **Should `penyaji.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.05719298245614035 - nodes in this community are weakly interconnected._
- **Should `audit-graf.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.05438184663536776 - nodes in this community are weakly interconnected._