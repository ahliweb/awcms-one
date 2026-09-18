# Graph Report - .  (2026-09-18)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1709 nodes · 3543 edges · 90 communities (76 shown, 14 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 30 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3c64c66a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- penyaji.mjs
- seed-borneojek-mart.ts
- catalog.ts
- docs-i18n-stamp.mjs
- buletin.ts
- portable-text.ts
- berita.ts
- pemasaran.ts
- bagikan.test.ts
- scripts
- navigasi-berita.ts
- BeritaLayout.astro
- audit-graf.mjs
- wilayah-checkout.ts
- rilis.mjs
- produk-listing.ts
- stub-awcms.mjs
- Sidebar.astro
- site.ts
- scripts
- audit-dokumen.mjs
- toko-klien.ts
- profil.ts
- wishlist-kontrak.ts
- routes.ts
- import-seputarborneo.ts
- blog.ts
- video/[slug].astro
- redirect-push.ts
- keranjang-kontrak.ts
- keranjang.ts
- [slug]/feed.xml.ts
- knowledge-obsidian-export.mjs
- iklan-popup.ts
- dengar.ts
- formatPrice
- import-seputarborneo.test.mjs
- awcms/analitik.ts
- checkout.ts
- scripts/pesanan.ts
- mysql-dump-reader.ts
- theme.ts
- runExport
- lembaga.ts
- produk-detail.ts
- cek-lockfile.mjs
- compilerOptions
- getVideo
- wilayah.ts
- bun
- kontrak/package.json
- knowledge-no-subtree-write.test.mjs
- warna.ts
- global-setup.ts
- readEnv
- knowledge-obsidian-export.test.mjs
- [n].astro
- berita-terkini.ts
- meta-sosial-build-smoke.test.ts
- extends
- kontrak-arah-impor.test.mjs
- ga-init.ts
- analitik-build-smoke.test.ts
- sidebar-build-smoke.test.ts
- config/package.json
- gerbang/package.json
- audit-dokumen.test.mjs
- audit-rilis.test.mjs
- TokoApiError
- promo-popup.ts
- bagikan-build-smoke.test.ts
- dengar-build-smoke.test.ts
- compilerOptions
- audit-graf.test.mjs
- root-env-example-coverage.test.mjs
- write-build-id.mjs
- checkout-guard-no-prerender.test.ts
- versi-toolchain.test.mjs
- knowledge-graph-update.mjs
- video-facade.ts
- build-smoke.test.ts
- buletin-build-smoke.test.ts
- checkout-build-smoke.test.ts
- astro.config.mjs
- newsletter-path-contract.test.ts
- 01-create-least-privilege-roles.sh

## God Nodes (most connected - your core abstractions)
1. `ROUTES` - 35 edges
2. `formatPrice()` - 27 edges
3. `scripts` - 26 edges
4. `bun` - 23 edges
5. `getSiteIdentity()` - 21 edges
6. `absoluteUrl()` - 19 edges
7. `readEnv()` - 18 edges
8. `getProducts()` - 18 edges
9. `getIndex()` - 18 edges
10. `assertOk()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `run()` --references--> `bun`  [EXTRACTED]
  tests/audit-dokumen.test.mjs → package.json
- `resolveBuildId()` --references--> `bun`  [EXTRACTED]
  apps/storefront/scripts/write-build-id.mjs → package.json
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/build-smoke.test.ts → package.json
- `canSpawnBun()` --references--> `bun`  [EXTRACTED]
  apps/storefront/tests/checkout-build-smoke.test.ts → package.json
- `auditLinkedCounts()` --indirect_call--> `item()`  [INFERRED]
  packages/gerbang/audit-dokumen.mjs → apps/storefront/tests/wishlist-kontrak.test.ts

## Import Cycles
- None detected.

## Communities (90 total, 14 thin omitted)

### Community 0 - "Storefront Server, CSP & Redirect Rules"
Cohesion: 0.05
Nodes (65): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+57 more)

### Community 1 - "Tenant Seed Script"
Cohesion: 0.06
Nodes (65): ADR-0049, AdPlacementSeed, apiCall(), ApiResult, applySiteProfile(), assertOk(), attemptCreateVerifiedMediaObject(), BASE_URL (+57 more)

### Community 2 - "Catalog Pages & Product JSON-LD"
Cohesion: 0.07
Nodes (45): assertNeverProductStatus(), buildCategoryTree(), buildPriceTiers(), buildProdukIndex(), CategoryNode, collectCategorySubtreeIds(), CommerceCategory, CommercePage (+37 more)

### Community 3 - "Docs i18n Stamping & Graph Combine"
Cohesion: 0.07
Nodes (43): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+35 more)

### Community 4 - "Browser Runtime: Newsletter & Analytics Beacon"
Cohesion: 0.06
Nodes (31): AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007, AnalyticsBeaconPayload, buildAnalyticsPayload(), isTrackingOptedOut(), reportPageView(), sendAnalyticsBeacon() (+23 more)

### Community 5 - "Portable Text & Static Pages"
Cohesion: 0.07
Nodes (48): footerLinks, publishedSlugs, year, detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal() (+40 more)

### Community 6 - "News Index Pages"
Cohesion: 0.07
Nodes (41): RawTerm, AuthorArchive, buildIndex(), buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive, DaerahLink (+33 more)

### Community 7 - "Marketing Read Models"
Cohesion: 0.08
Nodes (38): getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry, FlashSaleStatus (+30 more)

### Community 8 - "Article Share Row"
Cohesion: 0.09
Nodes (33): followLinks, shareLinks, socialIcons, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform (+25 more)

### Community 9 - "Root Package Manifest"
Cohesion: 0.05
Nodes (41): description, engines, homepage, license, name, packageManager, private, repository (+33 more)

### Community 10 - "News Navigation & Region Archives"
Cohesion: 0.09
Nodes (33): rubrikColumn, year, daerahActive, getAllInstitutions(), getResolvableRegionsByCode(), getDaerah(), listDaerahLinks(), RegionRef (+25 more)

### Community 11 - "Media Resolution & Social Meta"
Cohesion: 0.11
Nodes (29): chunk(), fetchMediaPublicOrigin(), isExpectedRefusal(), markUnresolved(), MediaPublicOrigin, RawResolvedMediaItem, resetMediaCachesForTests(), resolvedCache (+21 more)

### Community 12 - "Gate Reporters & Graph Audit"
Cohesion: 0.08
Nodes (28): graphPath, outputDir, reporter, reportPath, subtreeTrackedOutput, trackedOutput, dated, oldest (+20 more)

### Community 13 - "Checkout Region Indexes"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 14 - "Release & Changeset Parsing"
Cohesion: 0.11
Nodes (32): CHANGESET_IMPACTS, CHANGESET_TYPES, changesetBody(), isChangesetFile(), parseChangeset(), validateChangeset(), gitRunOrThrow(), atLeastAsSignificant() (+24 more)

### Community 15 - "Product Listing Scripts"
Cohesion: 0.11
Nodes (29): paginateProdukIndex(), ProductSort, ProdukIndexEntry, ProdukIndexFilter, emptyState, grid, heading, paginationEl (+21 more)

### Community 16 - "Stub CMS"
Cohesion: 0.12
Nodes (30): ANALYTICS_RANGES, analyticsPages(), buildPaymentInstructions(), computeQuote(), corsHeaders(), envelope(), envelopeError(), findOrderForPhone() (+22 more)

### Community 17 - "WIB Dates & News Sidebar"
Cohesion: 0.19
Nodes (13): toDatetimeAttr(), listArsipBulan(), PostSummary, formatBulanArsipWIB(), formatTanggalPanjangWIB(), formatTanggalWaktuWIB(), formatWaktuWIB(), pernahDiperbaruiSetelahTerbit() (+5 more)

### Community 18 - "Site URL & Sitemap"
Cohesion: 0.13
Nodes (24): absoluteUrl(), siteConfig, siteUrl, chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), KATALOG_SITEMAP_SOURCE_NAMES (+16 more)

### Community 19 - "Storefront Package Manifest"
Cohesion: 0.06
Nodes (31): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @playwright/test (+23 more)

### Community 20 - "Document Audit Gate"
Cohesion: 0.14
Nodes (31): ADR-0042, actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths() (+23 more)

### Community 21 - "Anonymous Commerce Client"
Cohesion: 0.09
Nodes (27): cancelOrder(), CartLineStatus, CreateOrderRequest, createPaymentProofUploadSession(), Envelope, finalizePaymentProofUpload(), OrderAddressInput, OrderCustomerInput (+19 more)

### Community 22 - "Site Profile & Flash-Sale Countdown"
Cohesion: 0.12
Nodes (15): DEFAULT_IDENTITY, ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity(), getSiteIdentity(), isExpectedRefusal(), mergeSiteIdentity(), parseSocialLinks() (+7 more)

### Community 23 - "Wishlist Contract"
Cohesion: 0.21
Nodes (22): loadWishlist(), removeFromWishlist(), saveWishlist(), toggleWishlist(), addWishlistItem(), createEmptyWishlist(), isIsoDateString(), isWishlisted() (+14 more)

### Community 24 - "Route Table & Store Header"
Cohesion: 0.15
Nodes (11): FOOTER_PAGE_LINKS, PRIMARY_NAV, ROUTES, STATIC_PAGE_SLUGS, input, matches, needle, resultsList (+3 more)

### Community 25 - "Legacy Export: Taxonomy"
Cohesion: 0.09
Nodes (25): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+17 more)

### Community 26 - "Blog Fetches & Ad Slots"
Cohesion: 0.14
Nodes (18): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+10 more)

### Community 27 - "Article Pages & News JSON-LD"
Cohesion: 0.12
Nodes (20): getRelatedPosts(), BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema(), NewsArticleSchemaInput, ADR-0109, breadcrumbItems (+12 more)

### Community 28 - "Legacy Export: Redirect Push & API Client"
Cohesion: 0.12
Nodes (21): apiCall(), ApiResult, AwcmsApiError, Session, ChunkOutcome, chunkRedirects(), createRedirectImportPoster(), FileWideDuplicate (+13 more)

### Community 29 - "Cart Contract & Count Badge"
Cohesion: 0.23
Nodes (15): addOrMergeLine(), Cart, CartLine, countCartItems(), createEmptyCart(), isIsoDateString(), isSameConfiguration(), KERANJANG_EVENT_NAME (+7 more)

### Community 30 - "Cart Runtime & WhatsApp Fallback"
Cohesion: 0.17
Nodes (20): addToCart(), loadCart(), removeCartLine(), saveCart(), updateCartLineQuantity(), quoteCart(), buildWhatsappCartMessage(), buildWhatsappUrl() (+12 more)

### Community 31 - "News Feeds & Search Index"
Cohesion: 0.14
Nodes (16): BeritaFeedItem, escapeCdata(), escapeXml(), getPost(), getPosts(), renderBeritaRssXml(), GET(), prerender (+8 more)

### Community 32 - "Obsidian Export Safety"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 33 - "Ad Popup Dialog"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 34 - "Read-Aloud Player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 35 - "Price Formatting & Product Feed"
Cohesion: 0.18
Nodes (15): filterProdukIndex(), normalizeSearchTerm(), comparePrices(), formatDiscountPercent(), formatPrice(), PRICE_FORMATTER, priceToNumber(), ADR-0003 (+7 more)

### Community 36 - "Legacy Export Tests"
Cohesion: 0.22
Nodes (15): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+7 more)

### Community 37 - "Terpopuler Analytics Reader"
Cohesion: 0.20
Nodes (11): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+3 more)

### Community 38 - "Checkout Script & Phone Helpers"
Cohesion: 0.18
Nodes (14): clearCart(), newCartId(), keepDigitsAndLeadingPlus(), previewIndonesianPhone(), CartLineRequest, CartQuote, createOrder(), ShippingSelection (+6 more)

### Community 39 - "Order Tracking Script"
Cohesion: 0.20
Nodes (13): PESANAN_PHONE_KEY, getOrder(), Order, loadOrder(), renderCountdown(), renderLines(), renderOrder(), renderPaymentInstructions() (+5 more)

### Community 40 - "MariaDB Dump Reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 41 - "Theme Tokens & Web Manifest"
Cohesion: 0.20
Nodes (11): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, GET() (+3 more)

### Community 42 - "Legacy Export Runner"
Cohesion: 0.20
Nodes (15): row(), buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), collectPendingAssignments(), flag(), main(), runAssignInstitutions(), runExport() (+7 more)

### Community 43 - "Institutions (Mitra)"
Cohesion: 0.21
Nodes (11): RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), resolveRegion(), getMitra() (+3 more)

### Community 44 - "Product Detail Script"
Cohesion: 0.23
Nodes (12): CommerceProductVariant, findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload (+4 more)

### Community 45 - "Lockfile Check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 46 - "Kontrak TSConfig"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 47 - "Legacy Redirect Map Builder"
Cohesion: 0.29
Nodes (9): getLegacyRedirectRows(), getVideo(), buildLegacyRedirectMap(), lastPathSegment(), LegacyRedirectRow, normalizeLegacyPath(), GET(), prerender (+1 more)

### Community 48 - "Region Lookup Client"
Cohesion: 0.30
Nodes (10): buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf(), listLintasKalimantanProvinces(), listRegions(), matchesProvinceName(), regenciesCache (+2 more)

### Community 49 - "Build-Smoke Harness"
Cohesion: 0.18
Nodes (5): canSpawnBun(), canSpawnBun(), canSpawnBun(), bun, gitRunInherit()

### Community 50 - "Kontrak Package Manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 51 - "Knowledge No-Subtree-Write Test"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 52 - "Colour Contrast"
Cohesion: 0.40
Nodes (7): contrastingForeground(), contrastRatio(), isValidHexColor(), relativeLuminance(), WCAG_AA_TEXT_CONTRAST, GET(), prerender

### Community 53 - "Playwright Setup"
Cohesion: 0.33
Nodes (6): globalSetup(), ADR-0002, ADR-0007, waitForHttp(), PREVIEW_PORT, STUB_PORT

### Community 54 - "Owner API Client & Env"
Cohesion: 0.42
Nodes (7): awcmsGet(), baseUrl(), Envelope, timeoutMs(), EnvSource, readEnv(), readEnvOr()

### Community 55 - "Obsidian Export Test"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 56 - "Rubrik Archive Pages"
Cohesion: 0.16
Nodes (17): flattenRubrikTree(), getRubrikTree(), paginate(), getNavUtama(), getUmumList(), getStaticPaths(), canonicalPath, getStaticPaths() (+9 more)

### Community 57 - "Recent News for the Store Home"
Cohesion: 0.33
Nodes (5): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost

### Community 58 - "Social Meta Build Smoke"
Cohesion: 0.38
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 59 - "Storefront TSConfig"
Cohesion: 0.29
Nodes (6): compilerOptions, types, extends, astro/tsconfigs/strict, bun, ../../packages/config/tsconfig.base.json

### Community 60 - "Kontrak Import-Direction Test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 61 - "GA4 Bootstrap"
Cohesion: 0.53
Nodes (3): gtag(), initGa(), Window

### Community 64 - "Config Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 65 - "Gerbang Package Manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 66 - "Document Audit Test"
Cohesion: 0.33
Nodes (4): cleanup, ADR-0042, run(), SCRIPT

### Community 67 - "Release Audit Test"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 69 - "Promo Popup"
Cohesion: 0.60
Nodes (4): dialog, markShown(), shouldShow(), storageKey()

### Community 70 - "Share Row Build Smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 71 - "Read-Aloud Build Smoke"
Cohesion: 0.40
Nodes (3): ARTICLE_PAGE, canSpawnBun(), VIDEO_PAGE

### Community 72 - "Base TSConfig"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 75 - "Build Id Stamp"
Cohesion: 0.50
Nodes (3): buildId, OUT_PATH, resolveBuildId()

### Community 78 - "Toolchain Version Test"
Cohesion: 0.50
Nodes (3): ci, pkg, VERSION

## Knowledge Gaps
- **533 isolated node(s):** `SITE`, `Envelope`, `EnvSource`, `prerender`, `name` (+528 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `item()` connect `wishlist-kontrak.ts` to `BeritaLayout.astro`, `audit-dokumen.mjs`, `pemasaran.ts`?**
  _High betweenness centrality (0.264) - this node is a cross-community bridge._
- **Why does `auditLinkedCounts()` connect `audit-dokumen.mjs` to `wishlist-kontrak.ts`?**
  _High betweenness centrality (0.258) - this node is a cross-community bridge._
- **Why does `gitRun()` connect `docs-i18n-stamp.mjs` to `bun`, `audit-graf.mjs`?**
  _High betweenness centrality (0.167) - this node is a cross-community bridge._
- **What connects `SITE`, `Envelope`, `EnvSource` to the rest of the system?**
  _533 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `penyaji.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.054527750730282376 - nodes in this community are weakly interconnected._
- **Should `seed-borneojek-mart.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06277436347673397 - nodes in this community are weakly interconnected._
- **Should `catalog.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06502816180235535 - nodes in this community are weakly interconnected._