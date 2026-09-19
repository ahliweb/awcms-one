# Graph Report - .  (2026-09-19)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1931 nodes · 4233 edges · 99 communities (83 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 38 edges (avg confidence: 0.61)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0d63eb92`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Static Server & Legacy Redirect Rules
- Documentation & Graph Audit Gates
- Portable Text & Static Pages
- BjekMart Seed Tool
- Build-Time CMS Client & Region Data
- Site Config, Sitemaps & Theme
- Newsletter Forms & Visitor Beacon
- Stub CMS State Machine
- navigasi-berita.ts
- [slug]/feed.xml.ts
- Release & Changeset Tooling
- Documentation Link Audit
- Share Row & Social Icons
- Root Workspace Manifest
- Commerce Storefront Client & Order Tracking
- Wishlist Storage & Account Sync
- media.ts
- Customer Session Store
- Storefront Package Manifest
- Article Pages & News JSON-LD
- Catalog Data & Product Index
- Account API Client
- Marketing Data (Flash Sales, Vouchers, Settings)
- routes.ts
- Product & Category Pages, Product JSON-LD
- Cart Storage & Cart Contract
- Site Profile & Base Layout
- Legacy Taxonomy Mapping (Importer)
- redirect-push.ts
- Blog Client & Ad Slots
- akun-pesanan.ts
- BeritaLayout.astro
- berita.ts
- Client-Side Search & Listing Renderer
- Obsidian Export Safety
- Cart Page & WhatsApp Fallback
- Ad Popup
- Account Dashboard Script
- Login (OTP) Page Script & Request Plumbing
- Read-Aloud Player
- Affiliate Referral Capture
- Importer Record Builders & Legacy URLs
- Registration Page Script
- Product Listing Filters & URL State
- Checkout Flow & Phone Preview
- Account Address Book Script
- MySQL Dump Reader
- Homepage & Derived CSP Artifact
- runExport
- Price Formatting & Product Cards
- Account Affiliate Page Script
- Lockfile Check
- Kontrak TypeScript Config
- Legacy Redirect Map & Video Lookup
- Product Detail Variants Script
- Build Smoke Harness (Bun Spawn)
- Kontrak Package Manifest
- Knowledge Subtree-Write Guard Test
- Cascading Region Selects
- Playwright Global Setup & Ports
- Obsidian Export Test
- Root RSS Feed
- Recent News Loader
- Social Meta Build Smoke
- Storefront TypeScript Config
- Kontrak Import Direction Test
- GA4 Init
- Analytics Build Smoke
- Sidebar Build Smoke
- Config Package Manifest
- Gerbang Package Manifest
- Release Audit Test
- Site Profile Merge Test
- Promo Popup
- Share Row Build Smoke
- Read-Aloud Build Smoke
- Institution Emblem Build Smoke
- Base TypeScript Config
- Graph Audit Test
- Root Env Example Coverage Test
- Build ID Writer
- Affiliate Build Smoke
- Account Dashboard Build Smoke
- No-Prerender Guard Test
- Toolchain Version Test
- Knowledge Graph Update Tool
- Account Pages Build Smoke
- News Build Smoke
- Newsletter Build Smoke
- Checkout Build Smoke
- Astro Config
- Newsletter Path Contract Test
- Least-Privilege DB Roles Script
- akun-ulasan.ts
- Flash Sale Countdown

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

## Communities (99 total, 16 thin omitted)

### Community 0 - "Static Server & Legacy Redirect Rules"
Cohesion: 0.05
Nodes (65): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+57 more)

### Community 1 - "Documentation & Graph Audit Gates"
Cohesion: 0.05
Nodes (62): graphPath, outputDir, reporter, reportPath, subtreeTrackedOutput, trackedOutput, DOCS_AWAITING_MIRROR, gitList() (+54 more)

### Community 2 - "Portable Text & Static Pages"
Cohesion: 0.05
Nodes (58): footerLinks, publishedSlugs, year, detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal() (+50 more)

### Community 3 - "BjekMart Seed Tool"
Cohesion: 0.06
Nodes (64): ADR-0049, AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL (+56 more)

### Community 4 - "Build-Time CMS Client & Region Data"
Cohesion: 0.06
Nodes (45): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+37 more)

### Community 5 - "Site Config, Sitemaps & Theme"
Cohesion: 0.07
Nodes (42): absoluteUrl(), DEFAULT_THEME_COLORS, siteConfig, siteUrl, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme() (+34 more)

### Community 6 - "Newsletter Forms & Visitor Beacon"
Cohesion: 0.06
Nodes (31): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+23 more)

### Community 7 - "Stub CMS State Machine"
Cohesion: 0.09
Nodes (45): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), buildAffiliateLink(), buildPaymentInstructions(), computeQuote(), corsHeaders(), deterministicAffiliateCode() (+37 more)

### Community 8 - "News Navigation & Regions"
Cohesion: 0.07
Nodes (43): rubrikColumn, year, daerahActive, getAllInstitutions(), buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf() (+35 more)

### Community 9 - "Rubrik Pages & Feeds"
Cohesion: 0.11
Nodes (26): RawTerm, collectAncestors(), collectDescendantSlugs(), estimasiWaktuBacaMenit(), flattenRubrikTree(), getRubrik(), getRubrikTree(), paginate() (+18 more)

### Community 10 - "Release & Changeset Tooling"
Cohesion: 0.08
Nodes (37): dated, oldest, pending, reporter, todayIso, CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody() (+29 more)

### Community 11 - "Documentation Link Audit"
Cohesion: 0.09
Nodes (38): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+30 more)

### Community 12 - "Share Row & Social Icons"
Cohesion: 0.09
Nodes (33): followLinks, shareLinks, socialIcons, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform (+25 more)

### Community 13 - "Root Workspace Manifest"
Cohesion: 0.05
Nodes (41): description, engines, homepage, license, name, packageManager, private, repository (+33 more)

### Community 14 - "Commerce Storefront Client & Order Tracking"
Cohesion: 0.07
Nodes (34): createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, PESANAN_PHONE_KEY, cancelOrder(), CartLineStatus, CreateOrderRequest (+26 more)

### Community 15 - "Wishlist Storage & Account Sync"
Cohesion: 0.14
Nodes (29): laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist(), saveWishlist() (+21 more)

### Community 16 - "Media Resolution & Institutions (Mitra)"
Cohesion: 0.09
Nodes (29): RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), chunk(), fetchMediaPublicOrigin() (+21 more)

### Community 17 - "Customer Session Store"
Cohesion: 0.15
Nodes (21): verifikasiKode(), Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun (+13 more)

### Community 18 - "Storefront Package Manifest"
Cohesion: 0.06
Nodes (31): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @playwright/test (+23 more)

### Community 19 - "Article Pages & News JSON-LD"
Cohesion: 0.09
Nodes (26): getPosts(), getRelatedPosts(), ADR-0109, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema(), NewsArticleSchemaInput (+18 more)

### Community 20 - "Catalog Data & Product Index"
Cohesion: 0.09
Nodes (28): assertNeverProductStatus(), buildCategoryTree(), buildProdukIndex(), CategoryNode, CommercePage, CommerceProductImage, DEFAULT_TIER_LABELS, getCategories() (+20 more)

### Community 21 - "Account API Client"
Cohesion: 0.18
Nodes (29): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilKomisiAfiliasi(), ambilPesananAkun(), ambilPesananAkunByKode(), ambilProfil() (+21 more)

### Community 22 - "Marketing Data (Flash Sales, Vouchers, Settings)"
Cohesion: 0.08
Nodes (25): CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus, isGoogleMapsEmbedUrl() (+17 more)

### Community 23 - "Route Table & Site Header"
Cohesion: 0.14
Nodes (11): FOOTER_PAGE_LINKS, PRIMARY_NAV, ROUTES, STATIC_PAGE_SLUGS, input, matches, needle, resultsList (+3 more)

### Community 24 - "Product & Category Pages, Product JSON-LD"
Cohesion: 0.12
Nodes (14): buildPriceTiers(), collectCategorySubtreeIds(), CommerceCategory, CommerceProduct, CommerceProductVariant, getCategoryBySlug(), productsInCategory(), BreadcrumbItem (+6 more)

### Community 25 - "Cart Storage & Cart Contract"
Cohesion: 0.20
Nodes (21): addToCart(), clearCart(), loadCart(), newCartId(), removeCartLine(), saveCart(), updateCartLineQuantity(), addOrMergeLine() (+13 more)

### Community 26 - "Site Profile & Base Layout"
Cohesion: 0.18
Nodes (11): getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), getSiteIdentity(), isExpectedRefusal(), SiteIdentity, SocialLink (+3 more)

### Community 27 - "Legacy Taxonomy Mapping (Importer)"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 28 - "Legacy Redirect Push & Importer API Session"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 29 - "Blog Client & Ad Slots"
Cohesion: 0.15
Nodes (17): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+9 more)

### Community 30 - "Account Orders Page Script"
Cohesion: 0.32
Nodes (11): AkunPesananHalaman, buildWhatsappAccountMessage(), buildWhatsappUrl(), showSubmitError(), appendOrderRows(), hideSubmitError(), loadDetail(), loadMore() (+3 more)

### Community 31 - "News Layout & Social Meta"
Cohesion: 0.23
Nodes (13): PostDetail, articleSocialMeta(), isHttpUrl(), listingSocialMeta(), MetaTag, ogImageMeta(), OgType, postSeoText() (+5 more)

### Community 32 - "News Index, Sidebar & Article View"
Cohesion: 0.07
Nodes (46): toDatetimeAttr(), AuthorArchive, buildIndex(), buildRubrikForest(), DaerahArchive, DaerahLink, getArsipBulan(), getAuthor() (+38 more)

### Community 33 - "Client-Side Search & Listing Renderer"
Cohesion: 0.15
Nodes (16): labelClassName(), paginateProdukIndex(), ProdukIndexEntry, GET(), prerender, emptyState, grid, heading (+8 more)

### Community 34 - "Obsidian Export Safety"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 35 - "Cart Page & WhatsApp Fallback"
Cohesion: 0.18
Nodes (18): formatPrice(), Cart, CartLineRequest, quoteCart(), QuoteLine, buildWhatsappCartMessage(), lineText(), ADR-0003 (+10 more)

### Community 36 - "Ad Popup"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 37 - "Account Dashboard Script"
Cohesion: 0.35
Nodes (10): hideSubmitError(), LEVEL_LABELS, levelLabel(), render(), renderProfile(), root, showAccountView(), showGuestView() (+2 more)

### Community 38 - "Login (OTP) Page Script & Request Plumbing"
Cohesion: 0.16
Nodes (13): Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, ValidationErrorDetail, clearFieldErrors(), hideSubmitError(), root, sendCode() (+5 more)

### Community 39 - "Read-Aloud Player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 40 - "Affiliate Referral Capture"
Cohesion: 0.23
Nodes (14): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+6 more)

### Community 41 - "Importer Record Builders & Legacy URLs"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 42 - "Registration Page Script"
Cohesion: 0.35
Nodes (10): mintaKode(), clearFieldErrors(), hideSubmitError(), root, sendCode(), showCodeStep(), showStatus(), showSubmitError() (+2 more)

### Community 43 - "Product Listing Filters & URL State"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 44 - "Checkout Flow & Phone Preview"
Cohesion: 0.18
Nodes (12): Alamat, keepDigitsAndLeadingPlus(), previewIndonesianPhone(), CartQuote, createOrder(), ShippingSelection, root, runCheckout() (+4 more)

### Community 45 - "Account Address Book Script"
Cohesion: 0.28
Nodes (15): AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate(), openFormForEdit() (+7 more)

### Community 46 - "MySQL Dump Reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 47 - "Homepage & Derived CSP Artifact"
Cohesion: 0.28
Nodes (12): getActiveFlashSales(), getActivePopup(), getActiveSliders(), getActiveTestimonials(), getPublicVouchers(), isMissingEndpoint(), warnMissing(), getResolvedMedia() (+4 more)

### Community 48 - "runExport"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 49 - "Price Formatting & Product Cards"
Cohesion: 0.21
Nodes (11): filterProdukIndex(), normalizeSearchTerm(), comparePrices(), formatDiscountPercent(), PRICE_FORMATTER, priceToNumber(), ADR-0003, HARGA_FILE (+3 more)

### Community 50 - "Account Affiliate Page Script"
Cohesion: 0.27
Nodes (12): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, loadMoreKomisi(), render(), renderEnrolled(), root (+4 more)

### Community 51 - "Lockfile Check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 52 - "Kontrak TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 53 - "Legacy Redirect Map & Video Lookup"
Cohesion: 0.29
Nodes (9): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), GET(), prerender (+1 more)

### Community 54 - "Product Detail Variants Script"
Cohesion: 0.26
Nodes (11): findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload, refresh() (+3 more)

### Community 55 - "Build Smoke Harness (Bun Spawn)"
Cohesion: 0.18
Nodes (5): canSpawnBun(), canSpawnBun(), canSpawnBun(), bun, gitRunInherit()

### Community 56 - "Kontrak Package Manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 57 - "Knowledge Subtree-Write Guard Test"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 58 - "Cascading Region Selects"
Cohesion: 0.44
Nodes (9): applyRegionSelection(), fetchRegionJson(), fillRegionOptions(), loadKabupaten(), loadKecamatan(), loadProvinces(), RegionOption, RegionSelects (+1 more)

### Community 59 - "Playwright Global Setup & Ports"
Cohesion: 0.33
Nodes (6): globalSetup(), ADR-0002, ADR-0007, waitForHttp(), PREVIEW_PORT, STUB_PORT

### Community 60 - "Obsidian Export Test"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 61 - "Root RSS Feed"
Cohesion: 0.67
Nodes (3): escapeXml(), GET(), prerender

### Community 62 - "Recent News Loader"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 63 - "Social Meta Build Smoke"
Cohesion: 0.38
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 64 - "Storefront TypeScript Config"
Cohesion: 0.29
Nodes (6): compilerOptions, types, extends, astro/tsconfigs/strict, bun, ../../packages/config/tsconfig.base.json

### Community 65 - "Kontrak Import Direction Test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 66 - "GA4 Init"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 69 - "Config Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 70 - "Gerbang Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 71 - "Release Audit Test"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 72 - "Site Profile Merge Test"
Cohesion: 0.50
Nodes (4): DEFAULT_IDENTITY, mergeSiteIdentity(), parseSocialLinks(), EMPTY_PAYLOAD

### Community 73 - "Promo Popup"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 74 - "Share Row Build Smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 75 - "Read-Aloud Build Smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 76 - "Institution Emblem Build Smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_WITH_LOGO, canSpawnBun(), MITRA_WITH_LOGO

### Community 77 - "Base TypeScript Config"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 80 - "Build ID Writer"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 85 - "Toolchain Version Test"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

### Community 97 - "Account Reviews Page Script"
Cohesion: 0.31
Nodes (10): UlasanAkun, hideSubmitError(), loadList(), render(), renderItem(), root, showGuestView(), showSubmitError() (+2 more)

## Knowledge Gaps
- **563 isolated node(s):** `SITE`, `Envelope`, `EnvSource`, `prerender`, `name` (+558 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `item()` connect `media.ts` to `Documentation Link Audit`, `Wishlist Storage & Account Sync`, `Homepage & Derived CSP Artifact`?**
  _High betweenness centrality (0.281) - this node is a cross-community bridge._
- **Why does `auditLinkedCounts()` connect `Documentation Link Audit` to `media.ts`?**
  _High betweenness centrality (0.275) - this node is a cross-community bridge._
- **Why does `bun` connect `Build Smoke Harness (Bun Spawn)` to `Documentation & Graph Audit Gates`, `Release & Changeset Tooling`, `Documentation Link Audit`, `Root Workspace Manifest`, `MySQL Dump Reader`, `runExport`, `Playwright Global Setup & Ports`, `Social Meta Build Smoke`, `Analytics Build Smoke`, `Sidebar Build Smoke`, `Release Audit Test`, `Share Row Build Smoke`, `Read-Aloud Build Smoke`, `Institution Emblem Build Smoke`, `Build ID Writer`, `Affiliate Build Smoke`, `Account Dashboard Build Smoke`, `Account Pages Build Smoke`, `News Build Smoke`, `Newsletter Build Smoke`, `Checkout Build Smoke`?**
  _High betweenness centrality (0.168) - this node is a cross-community bridge._
- **What connects `SITE`, `Envelope`, `EnvSource` to the rest of the system?**
  _563 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Static Server & Legacy Redirect Rules` be split into smaller, more focused modules?**
  _Cohesion score 0.05443037974683544 - nodes in this community are weakly interconnected._
- **Should `Documentation & Graph Audit Gates` be split into smaller, more focused modules?**
  _Cohesion score 0.05030834144758196 - nodes in this community are weakly interconnected._
- **Should `Portable Text & Static Pages` be split into smaller, more focused modules?**
  _Cohesion score 0.05179982440737489 - nodes in this community are weakly interconnected._