# Graph Report - .  (2026-09-20)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1931 nodes · 4233 edges · 100 communities (84 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 38 edges (avg confidence: 0.61)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1ce9bef8`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Storefront server: shadowed-page rewrite + rule-based redirects
- Tooling: knowledge-graph audit + docs i18n stamping
- Storefront: Portable Text rendering + static CMS pages
- Seed script: borneojek-mart tenant bootstrap
- Storefront: checkout region picker + visitor analytics
- Storefront: sitemap + theme tokens + site config
- Storefront: newsletter form + analytics beacon + CSP origin
- Storefront: news navigation + administrative regions
- Storefront dev/CI stub: commerce + account state machine
- Storefront: news/rubrik content helpers
- Tooling: release cut + changeset/semver helpers
- Gate: documentation audit (links, ADR index, path citations)
- Storefront: share row + social-icon detection
- Root package.json script registry
- Storefront: anonymous commerce client + order tracking
- Storefront: wishlist contract, client, and account sync
- Storefront: media resolution + institution pages
- apps/storefront package.json script registry
- Storefront: article/video pages + NewsArticle JSON-LD
- Storefront: catalog listing/search core
- Storefront: customer-account API client
- Storefront: marketing-surface client
- Storefront: route config + news search page
- Storefront: product detail + Product JSON-LD
- Storefront: account session contract
- Storefront: cart contract + client
- Storefront: site profile + base layout chrome
- Tooling: legacy seputarborneo import
- Storefront: blog_content client + ad placements
- Storefront: date formatting + archive sidebar
- Storefront: search-listing script
- Storefront: rubrik archive pagination + feeds
- Tooling: Obsidian export safety checks
- Storefront: cart page script + WhatsApp fallback
- Storefront: ad popup script
- Tooling: legacy-redirect push to the CMS
- Storefront: OG/Twitter social metadata
- Storefront: login page script
- Storefront: read-aloud player
- Storefront: affiliate ?ref= capture
- Tooling: legacy-import tests + redirect push
- Storefront: product-listing script
- Storefront: checkout submit script + phone formatting
- Storefront: account address-management script
- Storefront: homepage + derived CSP
- Tooling: legacy MySQL dump reader
- Storefront: price formatting
- Storefront: account affiliate dashboard script
- Gate: lockfile-ownership check
- packages/kontrak tsconfig
- Storefront: account order-history + WhatsApp fallback
- Storefront: legacy row-based redirect map
- Storefront: product-detail page script
- Storefront: registration page script
- Storefront: account reviews script
- Storefront: account dashboard script
- Storefront: build-smoke shared bun-spawn helper
- packages/kontrak package manifest
- Gate: knowledge graph never writes into the apps/cms subtree
- Storefront: checkout region-select component
- Storefront: Playwright e2e global setup
- Tooling: seputarborneo export run
- Gate: knowledge Obsidian-export tests
- Storefront: homepage Terkini ticker
- Storefront: social-metadata build-smoke
- apps/storefront tsconfig
- Gate: kontrak import-direction test
- Storefront: GA4 init script
- Storefront: analytics build-smoke
- Storefront: sidebar build-smoke
- packages/config package manifest
- packages/gerbang package manifest
- Gate: release-audit unit test
- Storefront: site-profile unit test
- Storefront: promo popup script
- Storefront: share-row build-smoke
- Storefront: read-aloud build-smoke
- Storefront: institution-logo build-smoke
- packages/config base tsconfig
- Gate: knowledge-graph audit unit test
- Gate: root .env.example coverage test
- Storefront: build-id writer script
- Storefront: site-wide RSS feed
- Storefront: affiliate build-smoke
- Storefront: account-dashboard build-smoke
- Storefront: static-output checkout guard test
- packages/kontrak barrel exports
- Gate: toolchain-pin version test
- Tooling: knowledge-graph update script
- Storefront: flash-sale countdown script
- Storefront: account build-smoke
- Storefront: news build-smoke
- Storefront: newsletter build-smoke
- Storefront: checkout build-smoke
- apps/storefront Astro build config
- Storefront: newsletter path-contract test
- Ops: least-privilege database-role bootstrap
- Storefront: checkout Playwright e2e
- Storefront: ad-popup Playwright e2e
- Gate: root test-coverage inventory test
## God Nodes (most connected - your core abstractions)
1. `ROUTES` - 47 edges
2. `kirimPermintaan()` - 31 edges
3. `formatPrice()` - 29 edges
4. `getSiteIdentity()` - 28 edges
5. `bun` - 27 edges
6. `scripts` - 26 edges
7. `bacaSesi()` - 24 edges
8. `absoluteUrl()` - 19 edges
9. `authHeader()` - 19 edges
10. `denganPembersihanSesi()` - 19 edges

## Surprising Connections (you probably didn't know these)
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json
- `resolveBuildId()` --references--> `bun`  [EXTRACTED]
  apps/storefront/scripts/write-build-id.mjs → package.json
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/checkout-build-smoke.test.ts → package.json
- `auditLinkedCounts()` --indirect_call--> `item()`  [INFERRED]
  packages/gerbang/audit-dokumen.mjs → apps/storefront/tests/wishlist-kontrak.test.ts
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/analitik-build-smoke.test.ts → package.json

## Import Cycles
- 2-file cycle: `apps/storefront/src/lib/toko-klien.ts -> apps/storefront/src/lib/toko-permintaan.ts -> apps/storefront/src/lib/toko-klien.ts`

## Communities (100 total, 16 thin omitted)

### Community 0 - "Storefront server: shadowed-page rewrite + rule-based redirects"
Cohesion: 0.05
Nodes (65): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+57 more)

### Community 1 - "Tooling: knowledge-graph audit + docs i18n stamping"
Cohesion: 0.05
Nodes (62): graphPath, outputDir, reporter, reportPath, subtreeTrackedOutput, trackedOutput, DOCS_AWAITING_MIRROR, gitList() (+54 more)

### Community 2 - "Storefront: Portable Text rendering + static CMS pages"
Cohesion: 0.05
Nodes (58): footerLinks, publishedSlugs, year, detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal() (+50 more)

### Community 3 - "Seed script: borneojek-mart tenant bootstrap"
Cohesion: 0.06
Nodes (64): ADR-0049, AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL (+56 more)

### Community 4 - "Storefront: checkout region picker + visitor analytics"
Cohesion: 0.06
Nodes (45): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+37 more)

### Community 5 - "Storefront: sitemap + theme tokens + site config"
Cohesion: 0.07
Nodes (42): absoluteUrl(), DEFAULT_THEME_COLORS, siteConfig, siteUrl, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme() (+34 more)

### Community 6 - "Storefront: newsletter form + analytics beacon + CSP origin"
Cohesion: 0.06
Nodes (31): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+23 more)

### Community 7 - "Storefront: news navigation + administrative regions"
Cohesion: 0.08
Nodes (40): rubrikColumn, year, daerahActive, getAllInstitutions(), buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf() (+32 more)

### Community 8 - "Storefront dev/CI stub: commerce + account state machine"
Cohesion: 0.09
Nodes (45): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), buildAffiliateLink(), buildPaymentInstructions(), computeQuote(), corsHeaders(), deterministicAffiliateCode() (+37 more)

### Community 9 - "Storefront: news/rubrik content helpers"
Cohesion: 0.07
Nodes (39): RawTerm, AuthorArchive, buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive, DaerahLink, estimasiWaktuBacaMenit() (+31 more)

### Community 10 - "Tooling: release cut + changeset/semver helpers"
Cohesion: 0.08
Nodes (37): dated, oldest, pending, reporter, todayIso, CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody() (+29 more)

### Community 11 - "Gate: documentation audit (links, ADR index, path citations)"
Cohesion: 0.09
Nodes (38): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+30 more)

### Community 12 - "Storefront: share row + social-icon detection"
Cohesion: 0.09
Nodes (33): followLinks, shareLinks, socialIcons, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform (+25 more)

### Community 13 - "Root package.json script registry"
Cohesion: 0.05
Nodes (41): description, engines, homepage, license, name, packageManager, private, repository (+33 more)

### Community 14 - "Storefront: anonymous commerce client + order tracking"
Cohesion: 0.07
Nodes (34): createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, PESANAN_PHONE_KEY, cancelOrder(), CartLineStatus, CreateOrderRequest (+26 more)

### Community 15 - "Storefront: wishlist contract, client, and account sync"
Cohesion: 0.14
Nodes (29): laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist(), saveWishlist() (+21 more)

### Community 16 - "Storefront: media resolution + institution pages"
Cohesion: 0.09
Nodes (29): RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), chunk(), fetchMediaPublicOrigin() (+21 more)

### Community 17 - "apps/storefront package.json script registry"
Cohesion: 0.06
Nodes (31): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @playwright/test (+23 more)

### Community 18 - "Storefront: article/video pages + NewsArticle JSON-LD"
Cohesion: 0.09
Nodes (26): getPosts(), getRelatedPosts(), ADR-0109, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema(), NewsArticleSchemaInput (+18 more)

### Community 19 - "Storefront: catalog listing/search core"
Cohesion: 0.09
Nodes (28): assertNeverProductStatus(), buildCategoryTree(), buildProdukIndex(), CategoryNode, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, getCategories() (+20 more)

### Community 20 - "Storefront: customer-account API client"
Cohesion: 0.18
Nodes (29): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilKomisiAfiliasi(), ambilPesananAkun(), ambilPesananAkunByKode(), ambilProfil() (+21 more)

### Community 21 - "Storefront: marketing-surface client"
Cohesion: 0.08
Nodes (25): CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus, isGoogleMapsEmbedUrl() (+17 more)

### Community 22 - "Storefront: route config + news search page"
Cohesion: 0.11
Nodes (15): FOOTER_PAGE_LINKS, PRIMARY_NAV, ROUTES, STATIC_PAGE_SLUGS, listDaerahLinks(), input, matches, needle (+7 more)

### Community 23 - "Storefront: product detail + Product JSON-LD"
Cohesion: 0.12
Nodes (14): buildPriceTiers(), collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, CommerceProductVariant, getCategoryBySlug(), productsInCategory(), BreadcrumbItem (+6 more)

### Community 24 - "Storefront: account session contract"
Cohesion: 0.15
Nodes (21): verifikasiKode(), Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun (+13 more)

### Community 25 - "Storefront: cart contract + client"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 26 - "Storefront: site profile + base layout chrome"
Cohesion: 0.18
Nodes (11): getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), getSiteIdentity(), isExpectedRefusal(), SiteIdentity, SocialLink (+3 more)

### Community 27 - "Tooling: legacy seputarborneo import"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 28 - "Storefront: blog_content client + ad placements"
Cohesion: 0.15
Nodes (17): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+9 more)

### Community 29 - "Storefront: date formatting + archive sidebar"
Cohesion: 0.20
Nodes (13): toDatetimeAttr(), listArsipBulan(), PostSummary, formatBulanArsipWIB(), formatTanggalPanjangWIB(), formatTanggalWaktuWIB(), formatWaktuWIB(), pernahDiperbaruiSetelahTerbit() (+5 more)

### Community 30 - "Storefront: search-listing script"
Cohesion: 0.15
Nodes (16): labelClassName(), paginateProdukIndex(), ProdukIndexEntry, GET(), prerender, emptyState, grid, heading (+8 more)

### Community 31 - "Storefront: rubrik archive pagination + feeds"
Cohesion: 0.14
Nodes (19): flattenRubrikTree(), getRubrikTree(), paginate(), rubrikPaginationLinks(), getNavUtama(), getUmumList(), getStaticPaths(), prerender (+11 more)

### Community 32 - "Tooling: Obsidian export safety checks"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 33 - "Storefront: cart page script + WhatsApp fallback"
Cohesion: 0.19
Nodes (17): formatPrice(), Cart, quoteCart(), QuoteLine, buildWhatsappCartMessage(), lineText(), ADR-0003, ADR-0007 (+9 more)

### Community 34 - "Storefront: ad popup script"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 35 - "Tooling: legacy-redirect push to the CMS"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 36 - "Storefront: OG/Twitter social metadata"
Cohesion: 0.23
Nodes (13): PostDetail, articleSocialMeta(), isHttpUrl(), listingSocialMeta(), MetaTag, ogImageMeta(), OgType, postSeoText() (+5 more)

### Community 37 - "Storefront: login page script"
Cohesion: 0.16
Nodes (13): Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, ValidationErrorDetail, clearFieldErrors(), hideSubmitError(), root, sendCode() (+5 more)

### Community 38 - "Storefront: read-aloud player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 39 - "Storefront: affiliate ?ref= capture"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 40 - "Tooling: legacy-import tests + redirect push"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 41 - "Storefront: product-listing script"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 42 - "Storefront: checkout submit script + phone formatting"
Cohesion: 0.17
Nodes (13): Alamat, keepDigitsAndLeadingPlus(), previewIndonesianPhone(), CartLineRequest, CartQuote, createOrder(), ShippingSelection, root (+5 more)

### Community 43 - "Storefront: account address-management script"
Cohesion: 0.28
Nodes (15): AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate(), openFormForEdit() (+7 more)

### Community 44 - "Storefront: homepage + derived CSP"
Cohesion: 0.28
Nodes (12): getActiveFlashSales(), getActivePopup(), getActiveSliders(), getActiveTestimonials(), getPublicVouchers(), isMissingEndpoint(), warnMissing(), getResolvedMedia() (+4 more)

### Community 45 - "Tooling: legacy MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 46 - "Storefront: price formatting"
Cohesion: 0.21
Nodes (11): filterProdukIndex(), normalizeSearchTerm(), comparePrices(), formatDiscountPercent(), PRICE_FORMATTER, priceToNumber(), ADR-0003, HARGA_FILE (+3 more)

### Community 47 - "Storefront: account affiliate dashboard script"
Cohesion: 0.27
Nodes (12): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, loadMoreKomisi(), render(), renderEnrolled(), root (+4 more)

### Community 48 - "Gate: lockfile-ownership check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 49 - "packages/kontrak tsconfig"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 50 - "Storefront: account order-history + WhatsApp fallback"
Cohesion: 0.32
Nodes (11): AkunPesananHalaman, buildWhatsappAccountMessage(), buildWhatsappUrl(), showSubmitError(), appendOrderRows(), hideSubmitError(), loadDetail(), loadMore() (+3 more)

### Community 51 - "Storefront: legacy row-based redirect map"
Cohesion: 0.29
Nodes (9): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), GET(), prerender (+1 more)

### Community 52 - "Storefront: product-detail page script"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 53 - "Storefront: registration page script"
Cohesion: 0.35
Nodes (10): mintaKode(), clearFieldErrors(), hideSubmitError(), root, sendCode(), showCodeStep(), showStatus(), showSubmitError() (+2 more)

### Community 54 - "Storefront: account reviews script"
Cohesion: 0.31
Nodes (10): UlasanAkun, hideSubmitError(), loadList(), render(), renderItem(), root, showGuestView(), showSubmitError() (+2 more)

### Community 55 - "Storefront: account dashboard script"
Cohesion: 0.35
Nodes (10): hideSubmitError(), LEVEL_LABELS, levelLabel(), render(), renderProfile(), root, showAccountView(), showGuestView() (+2 more)

### Community 56 - "Storefront: build-smoke shared bun-spawn helper"
Cohesion: 0.18
Nodes (5): canSpawnBun(), canSpawnBun(), canSpawnBun(), bun, gitRunInherit()

### Community 57 - "packages/kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 58 - "Gate: knowledge graph never writes into the apps/cms subtree"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 59 - "Storefront: checkout region-select component"
Cohesion: 0.44
Nodes (9): applyRegionSelection(), fetchRegionJson(), fillRegionOptions(), loadKabupaten(), loadKecamatan(), loadProvinces(), RegionOption, RegionSelects (+1 more)

### Community 61 - "Storefront: Playwright e2e global setup"
Cohesion: 0.33
Nodes (6): globalSetup(), ADR-0002, ADR-0007, waitForHttp(), PREVIEW_PORT, STUB_PORT

### Community 62 - "Tooling: seputarborneo export run"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 63 - "Gate: knowledge Obsidian-export tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 64 - "Storefront: homepage Terkini ticker"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 65 - "Storefront: social-metadata build-smoke"
Cohesion: 0.38
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 66 - "apps/storefront tsconfig"
Cohesion: 0.29
Nodes (6): compilerOptions, types, extends, astro/tsconfigs/strict, bun, ../../packages/config/tsconfig.base.json

### Community 67 - "Gate: kontrak import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 68 - "Storefront: GA4 init script"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 71 - "packages/config package manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 72 - "packages/gerbang package manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 73 - "Gate: release-audit unit test"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 74 - "Storefront: site-profile unit test"
Cohesion: 0.50
Nodes (4): DEFAULT_IDENTITY, mergeSiteIdentity(), parseSocialLinks(), EMPTY_PAYLOAD

### Community 75 - "Storefront: promo popup script"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 76 - "Storefront: share-row build-smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 77 - "Storefront: read-aloud build-smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 78 - "Storefront: institution-logo build-smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 79 - "packages/config base tsconfig"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 82 - "Storefront: build-id writer script"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 83 - "Storefront: site-wide RSS feed"
Cohesion: 0.67
Nodes (3): escapeXml(), GET(), prerender

### Community 88 - "Gate: toolchain-pin version test"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

## Knowledge Gaps
- **563 isolated node(s):** `SITE`, `Envelope`, `EnvSource`, `prerender`, `name` (+558 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `item()` connect `media.ts` to `audit-dokumen.mjs`, `pages/index.astro`, `wishlist-akun-sync.ts`?**
  _High betweenness centrality (0.281) - this node is a cross-community bridge._
- **Why does `auditLinkedCounts()` connect `audit-dokumen.mjs` to `media.ts`?**
  _High betweenness centrality (0.275) - this node is a cross-community bridge._
- **Why does `bun` connect `bun` to `audit-graf.mjs`, `rilis.mjs`, `audit-dokumen.mjs`, `scripts`, `mysql-dump-reader.ts`, `global-setup.ts`, `runExport`, `meta-sosial-build-smoke.test.ts`, `analitik-build-smoke.test.ts`, `sidebar-build-smoke.test.ts`, `audit-rilis.test.mjs`, `bagikan-build-smoke.test.ts`, `dengar-build-smoke.test.ts`, `logo-instansi-build-smoke.test.ts`, `write-build-id.mjs`, `afiliasi-build-smoke.test.ts`, `akun-dashboard-build-smoke.test.ts`, `akun-build-smoke.test.ts`, `berita-build-smoke.test.ts`, `buletin-build-smoke.test.ts`, `checkout-build-smoke.test.ts`?**
  _High betweenness centrality (0.168) - this node is a cross-community bridge._
- **What connects `SITE`, `Envelope`, `EnvSource` to the rest of the system?**
  _563 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `penyaji.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.05443037974683544 - nodes in this community are weakly interconnected._
- **Should `audit-graf.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.05030834144758196 - nodes in this community are weakly interconnected._
- **Should `portable-text.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05179982440737489 - nodes in this community are weakly interconnected._