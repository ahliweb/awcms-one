# Graph Report - .  (2026-11-18)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3729 nodes · 9001 edges · 156 communities (141 shown, 15 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 72 edges (avg confidence: 0.62)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f433abd4`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- checkout.ts
- lib/deps-freshness.ts
- orchestrate.ts
- plan.mjs
- stub-awcms.mjs
- penyaji.mjs
- booking-kontrak.ts
- bun
- catalog.ts
- rilis.mjs
- akun-klien.ts
- berita.ts
- toko-klien.ts
- navigasi-berita.ts
- seed-cms.ts
- routes.ts
- push-alur.ts
- push-pelanggan.ts
- archive.ts
- profil-uji-bersama.ts
- pemasaran.ts
- scripts
- blog.ts
- bagikan.test.ts
- pipeline.ts
- run.ts
- config/profil.ts
- wishlist-akun-sync.ts
- buletin.ts
- bun-only-deployment-manifests.test.mjs
- images.ts
- masuk.ts
- media.ts
- wilayah-checkout.ts
- booking-pesan.ts
- scripts
- portable-text.ts
- tables.ts
- formatPrice
- akun-reservasi.ts
- video/[slug].astro
- fetch.ts
- docs-i18n-stamp.mjs
- akun-notifikasi.ts
- audit-graf.mjs
- akun-pesanan.ts
- audit-dokumen.mjs
- readEnv
- bps-population-fetch.test.mjs
- seed-profil.test.mjs
- bacaSesi
- BeritaLayout.astro
- navigasi-profil.ts
- ArtikelView.astro
- sitemap-sources.ts
- import-seputarborneo.ts
- []
- akun-sesi.ts
- assertOk
- pwa-ikon-situs.ts
- akun-notifikasi.e2e.ts
- discover.ts
- run
- a11y-preferences.ts
- publish.ts
- site.ts
- kirim-tunggal.ts
- ADR-0048
- knowledge-graph-combine.mjs
- bps-population-archive.test.mjs
- theme.ts
- knowledge-obsidian-export.mjs
- bps-population-extract.test.mjs
- isGroupActive
- cari-listing.ts
- toko-permintaan.ts
- iklan-popup.ts
- rows.ts
- profil.mjs
- booking.e2e.ts
- security.ts
- redirect-push.ts
- dengar.ts
- akun-alamat.ts
- produk-listing.ts
- a11y-panel.e2e.ts
- deploy-preflight.mjs
- a11y-panel.ts
- pages.ts
- mysql-dump-reader.ts
- akun-afiliasi.ts
- awcms/analitik.ts
- profil-halaman.ts
- extract/regions.ts
- import-seputarborneo.test.mjs
- pwa-manifest.ts
- deploy-production.test.mjs
- build-and-serve.ts
- produk-detail.ts
- package.json
- cek-lockfile.mjs
- compilerOptions
- common.sh
- a11y-early.test.ts
- redactText
- districts.ts
- awcms-api.ts
- audit-graf.test.mjs
- aktifkanPerangkat
- a11y-css.test.ts
- compilerOptions
- kontrak/package.json
- compose-produksi.test.mjs
- knowledge-no-subtree-write.test.mjs
- PoliteClient
- kirim-tunggal-kontrak.test.ts
- knowledge-obsidian-export.test.mjs
- words.ts
- runExport
- sw-notifikasi.js
- checkout-guard-no-prerender.test.ts
- audit-exceptions.ts
- listPage
- kontrak-arah-impor.test.mjs
- applyPreferences
- booking-build-smoke.test.ts
- meta-sosial-build-smoke.test.ts
- status-prosa.test.mjs
- config/package.json
- reporter.mjs
- gerbang/package.json
- audit-dokumen.test.mjs
- audit-rilis.test.mjs
- ensureInstitutionsGeneric
- ga-init.ts
- overrides
- compilerOptions
- root-env-example-coverage.test.mjs
- knowledge-graph-update.mjs
- SITE_PROFILES
- isMotionReduced
- a11y-early.js.ts
- lynx-direction.test.mjs
- run-job-compose.sh
- RegionIndex
- select-and-offsite-copy.sh
- workspaces
- a11y-early.js
- 01-create-least-privilege-roles.sh
- run-backup-compose.sh
- deploy-production.sh
- deploy-remote.sh
- healthcheck-production.sh
- rollback-production.sh

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

## Communities (156 total, 15 thin omitted)

### Community 0 - "Storefront cart client and storage"
Cohesion: 0.05
Nodes (78): AFILIASI_STORAGE_KEY, AFILIASI_TTL_MS, AfiliasiTertangkap, bacaKodeAfiliasi(), bacaStorage(), isAfiliasiKedaluwarsa(), isIsoDateString(), parseAfiliasi() (+70 more)

### Community 1 - "Dependency freshness report tooling"
Cohesion: 0.06
Nodes (81): fixture(), FIXTURES, HOLD, json(), argValue(), collectAdvisories(), collectBun(), collectImageRefs() (+73 more)

### Community 2 - "Local CI fork and git helpers"
Cohesion: 0.06
Nodes (60): ADR-0021, gitRunOrThrow(), PKG, EXPECTED_CONTEXTS, orchestrate, pkg, VERSION, main() (+52 more)

### Community 3 - "Seed profile CLI"
Cohesion: 0.06
Nodes (57): ADR-0018, canSpawnBun(), NOTE: this test file is NOT excluded from the copy any more. It used to, runTemplateInitTests(), applyPlan(), describeChecklist(), POST_INIT_CHECKLIST, applyColorDefaults() (+49 more)

### Community 4 - "Storefront dev stub server (awcms API)"
Cohesion: 0.06
Nodes (67): ACCOUNTS, ANALYTICS_RANGES, analyticsPages(), bookingStub, buildAffiliateLink(), buildCourierOptions(), buildPaymentInstructions(), computeQuote() (+59 more)

### Community 5 - "Dev server routing & Daerah panel"
Cohesion: 0.06
Nodes (63): canonicalRubrikSlug(), DAERAH_ENTRIES, DAERAH_NAMES, DAERAH_SLUG_BY_ALIAS, decodeSegment(), findNewsRowTargetById(), findVideoRowTargetById(), lastPathSegment() (+55 more)

### Community 6 - "Storefront booking and reservations"
Cohesion: 0.07
Nodes (62): alasanTidakBisaBatal(), bandingkanUang(), BarisUang, BOOKING_AKTIF_KEY, buatPathPesan(), catatanPembayaran(), dariSen(), DetailReservasi (+54 more)

### Community 7 - "Storefront build-id and stub lifecycle"
Cohesion: 0.05
Nodes (34): ADR-0036, canSpawnBun(), canSpawnBun(), canSpawnBun(), canSpawnBun(), runBuild(), ARTICLE_PAGE, canSpawnBun() (+26 more)

### Community 8 - "Commerce catalog wire types"
Cohesion: 0.06
Nodes (47): assertNeverProductStatus(), buildCategoryTree(), buildPriceTiers(), buildProdukIndex(), CategoryNode, collectCategorySubtreeIds(), CommerceBundle, CommerceBundleComponent (+39 more)

### Community 9 - "Release & changeset tooling"
Cohesion: 0.06
Nodes (47): ADR-0023, dated, oldest, pending, reporter, todayIso, changelogSection(), findChangelogHeadings() (+39 more)

### Community 10 - "Account API client"
Cohesion: 0.10
Nodes (54): Afiliasi, AfiliasiKomisi, ambilAfiliasi(), ambilAlamat(), ambilDetailReservasi(), ambilKomisiAfiliasi(), ambilKuotaPembatalan(), ambilPercakapan() (+46 more)

### Community 11 - "News feed, rubric and pagination"
Cohesion: 0.06
Nodes (44): RawTerm, AuthorArchive, buildRubrikForest(), collectAncestors(), collectDescendantSlugs(), DaerahArchive, DaerahLink, escapeCdata() (+36 more)

### Community 12 - "Storefront cart and affiliate contracts"
Cohesion: 0.06
Nodes (44): KetersediaanMenginap, KuotaBooking, TawaranBooking, createPesananRenderer(), PesananRenderer, PesananRenderRefs, STATUS_LABELS, STATUS_TONE_CLASS (+36 more)

### Community 13 - "News navigation"
Cohesion: 0.08
Nodes (41): daerahActive, getAllInstitutions(), buildRegionIndex(), findKaltengProvince(), getProvinces(), getRegenciesOf(), getResolvableRegionsByCode(), listLintasKalimantanProvinces() (+33 more)

### Community 14 - "CMS seed CLI"
Cohesion: 0.05
Nodes (46): AdPlacementSeed, ApiResult, attemptCreateVerifiedMediaObject(), BASE_URL, CategorySeed, Cli, ensureTenantDomains(), errorCodeOf() (+38 more)

### Community 15 - "Site identity composition"
Cohesion: 0.12
Nodes (22): socialIcons, tokoAktif, ROUTES, DEFAULT_IDENTITY, getStoreSettings(), ComposedSiteIdentity, EMPTY_PAYLOAD, fetchSiteIdentity() (+14 more)

### Community 16 - "Push enrolment and sign-out flow"
Cohesion: 0.08
Nodes (32): adalah401(), adalah404(), base64Url(), bersihkanLokalBilaPerlu(), cabutPerangkatLain(), HasilAktifkan, HasilKeluar, HasilMatikan (+24 more)

### Community 17 - "Customer push device and status contract"
Cohesion: 0.08
Nodes (38): APPLICATION_SERVER_KEY, CONSENT_TEXT_VERSION, createPushStub(), maskEndpoint(), PURPOSES, PUSH_HOSTS, DeskripsiTujuan, HasilMuat (+30 more)

### Community 18 - "BPS archive file layout"
Cohesion: 0.07
Nodes (43): candidate(), deps(), ARCHIVE_FILE_NAME, ArchiveKind, ArchiveOutcome, ArchivePlacement, ArchiveRecord, ArchiveScope (+35 more)

### Community 19 - "Shared profile-route test harness"
Cohesion: 0.11
Nodes (31): dead, excludedHits, failures, profile, sitemapDead, sitemapLeaks, sitemapPaths, routePathPrefix() (+23 more)

### Community 20 - "Marketing data client"
Cohesion: 0.08
Nodes (38): CSP_NEEDS, getMediaPublicOrigin(), CustomerLevel, DEFAULT_CUSTOMER_LEVELS, EMPTY_STORE_SETTINGS, findFlashSaleForProduct(), FlashSale, FlashSaleProductEntry (+30 more)

### Community 21 - "Root package.json manifest"
Cohesion: 0.05
Nodes (43): scripts, audit:dokumen, audit:graf, audit:rilis, audit:translation, build, check, check:cms (+35 more)

### Community 22 - "Blog & ad-placement fetch helpers"
Cohesion: 0.08
Nodes (28): AD_PLACEMENT_KEYS, AdPlacementKey, fetchActiveAdPlacements(), fetchAllInstitutions(), fetchAllTerms(), fetchLegacyRedirectRows(), getActiveAdPlacements(), getAllPosts() (+20 more)

### Community 23 - "Share-row (bagikan) tests"
Cohesion: 0.09
Nodes (32): followLinks, shareLinks, buildShareLinks(), FOLLOW_LABEL, FOLLOW_ORDER, FollowLink, FollowPlatform, resolveFollowLinks() (+24 more)

### Community 24 - "BPS population pipeline"
Cohesion: 0.10
Nodes (38): harness(), normaliseRemoteRoot(), ARCHIVE_SCRIPT, archiveStepArgv(), emptyPipelineState(), EXTRACT_SCRIPT, extractStepArgv(), formatLogLine() (+30 more)

### Community 25 - "BPS extract checks and metadata"
Cohesion: 0.10
Nodes (38): attributionSentence(), cacheDir(), coverageOfDomain(), districtCoverMismatch(), DistrictRecord, findRecord(), FrontMatter, frontMatterText() (+30 more)

### Community 26 - "Site build-profile config"
Cohesion: 0.08
Nodes (31): CspNeeds, DEFAULT_SITE_PROFILE, FeedEntry, FEEDS, FEEDS_ALL, FOOTER_PAGE_LINKS, FooterPageLink, GROUP_STYLESHEET_HREFS (+23 more)

### Community 27 - "Customer session & wishlist sync"
Cohesion: 0.14
Nodes (29): laporkanKegagalan(), pasangSinkronisasiWishlist(), sinkronkanWishlistSaatMasuk(), statusElement(), tulisKeAkunJikaMasuk(), loadWishlist(), removeFromWishlist(), saveWishlist() (+21 more)

### Community 28 - "First-party analytics beacon"
Cohesion: 0.07
Nodes (22): BuletinApiError, buletinErrorMessage(), BuletinFormRoot, confirmNewsletterSubscription(), Envelope, request(), showStatus(), subscribeToNewsletter() (+14 more)

### Community 29 - "Bun-only deployment manifest gate tests"
Cohesion: 0.09
Nodes (33): activeLines(), argDefaults(), COMPOSE_FILES, composeViolations(), countOf(), DOCKERFILES, dockerfileStageViolations(), dockerInstructions() (+25 more)

### Community 30 - "Release image build tooling"
Cohesion: 0.14
Nodes (32): ADR-0020, gitRun(), cosignSign(), cosignVerify(), ensureBuilder(), fail(), headIsExactlyTag(), log() (+24 more)

### Community 31 - "Account session client and contract"
Cohesion: 0.11
Nodes (31): mintaKode(), OtpChannel, buatKunciBaru(), buatPengelolaKunci(), galatKonflikKunci(), jawabanFinal(), KODE_KONFLIK_KUNCI, kunciValid() (+23 more)

### Community 32 - "Region and institution lookups"
Cohesion: 0.09
Nodes (27): RawInstitution, buildMitraList(), getMitraBySlug(), getMitraList(), MitraSummary, toMitraSummary(), chunk(), fetchMediaPublicOrigin() (+19 more)

### Community 33 - "Checkout region & courier lookups"
Cohesion: 0.10
Nodes (27): ConcurrencyLimiter, configuredProvinceCodes(), createConcurrencyLimiter(), DEFAULT_PROVINCE_CODES, districtsCache, getAllCheckoutRegencies(), getCheckoutDistricts(), getCheckoutProvinces() (+19 more)

### Community 34 - "Booking order form script"
Cohesion: 0.15
Nodes (35): buatHoldAktif(), formatSisa(), isNol(), parseHoldAktif(), pengumumanAmbang(), sidikPermintaan(), teksSisa(), tujuanSesiGateway() (+27 more)

### Community 35 - "Storefront package.json manifest"
Cohesion: 0.06
Nodes (34): dependencies, astro, @astrojs/node, @awcms-one/kontrak, description, devDependencies, @astrojs/check, @axe-core/playwright (+26 more)

### Community 36 - "Static page & portable text rendering"
Cohesion: 0.10
Nodes (32): toPostSummary(), ALLOWED_LINK_SCHEMES, annotationMap(), BLOCK_STYLES, blockText(), collectGalleryMediaObjectIds(), documentHasPlayableVideo(), escapeHtml() (+24 more)

### Community 37 - "BPS table row fixtures"
Cohesion: 0.22
Nodes (34): row(), ageBandKey(), cx(), headerWords(), labelColumnCount(), nearestMarker(), ageByRegionColumns(), basisOf() (+26 more)

### Community 38 - "Price formatting and flash-sale countdown"
Cohesion: 0.09
Nodes (21): BeritaLoader, BeritaModule, defaultLoader(), getRecentPosts(), RecentPost, comparePrices(), formatDiscountPercent(), formatPrice() (+13 more)

### Community 39 - "Booking actions and CSS font test"
Cohesion: 0.12
Nodes (31): ADR-0045, HasilBayar, labelTombolBayar(), mulaiPembayaranGateway(), buatPathDetailReservasi(), labelPembayaran(), labelStatusReservasi(), NadaPil (+23 more)

### Community 40 - "Article/video schema & breadcrumbs"
Cohesion: 0.08
Nodes (28): getPosts(), getRelatedPosts(), getVideo(), ADR-0109, BreadcrumbItem, breadcrumbListSchema(), combineSchemas(), newsArticleSchema() (+20 more)

### Community 41 - "BPS fetch and district selection"
Cohesion: 0.14
Nodes (32): arg(), Ctx, districtJobs(), fmt(), main(), Office, provinceCodes(), provinceFull() (+24 more)

### Community 42 - "Gate library and docs-translation audit"
Cohesion: 0.14
Nodes (25): DOCS_AWAITING_MIRROR, gitList(), listMirrors(), listSources(), ROOT, runChecks(), checkMirrorCoverage(), checkTranslationPair() (+17 more)

### Community 43 - "Push browser ports and platform detection"
Cohesion: 0.15
Nodes (30): ambilPemberitahuan(), pushDidukungPeramban(), deteksiPlatform(), KeadaanPush, lamaTunggu(), perangkatIni(), PESAN_PEMBERITAHUAN, petakanGalat() (+22 more)

### Community 44 - "Knowledge-graph gate (audit:graf)"
Cohesion: 0.11
Nodes (28): graphPath, ignoreExists, ignorePath, manifestPath, outputDir, reporter, reportPath, subtreeTrackedOutput (+20 more)

### Community 45 - "Order status rendering client"
Cohesion: 0.12
Nodes (29): AkunPesananHalaman, ambilPesananAkunByKode(), Percakapan, PercakapanHalaman, PESAN_KONFLIK_KUNCI, buildWhatsappAccountMessage(), buildWhatsappUrl(), showSubmitError() (+21 more)

### Community 46 - "Docs audit gate (audit:dokumen)"
Cohesion: 0.15
Nodes (30): actualCount(), adrStatus(), auditAdrCitations(), auditAdrIndex(), auditLinkedCounts(), auditLinks(), auditNamedPaths(), auditOneIndex() (+22 more)

### Community 47 - "Toko origin and CSP configuration"
Cohesion: 0.12
Nodes (20): CSP, awcmsGet(), baseUrl(), Envelope, timeoutMs(), AwcmsOriginConfigError, requireAwcmsOrigin(), ADR-0007 (+12 more)

### Community 48 - "BPS fetch client tests"
Cohesion: 0.11
Nodes (24): acquire(), DOWNLOAD_CONCURRENCY, HELP, ClientOptions, DownloadResult, pdfPages(), sha256File(), StallError (+16 more)

### Community 49 - "Seed-profile validation tests"
Cohesion: 0.14
Nodes (24): ALL_PROFILES, HAS_CONTOH_SEED, HAS_DEPRECATION_SHIM, NEUTRAL_PROFILES, SEED_ASSETS_ROOT, SEED_DATA_ROOT, check(), isNonEmptyString() (+16 more)

### Community 50 - "Account contract and session storage keys"
Cohesion: 0.16
Nodes (26): bacaSesi(), hapusSesi(), buatPortPemberitahuan(), buatPortPenanda(), buatPortPeramban(), DepsPush, buatDepsNyata(), adaPenandaPush() (+18 more)

### Community 51 - "Social meta and media resolution tests"
Cohesion: 0.13
Nodes (20): ResolvedMedia, PostDetail, articleSocialMeta(), isHttpUrl(), listingSocialMeta(), MetaTag, ogImageMeta(), OgType (+12 more)

### Community 52 - "News navigation tree selectors"
Cohesion: 0.12
Nodes (24): NavItem, PROFILE_NAV_DYNAMIC, flattenRubrikTree(), getRubrikTree(), paginate(), getNavUtama(), getUmumList(), selectNavUtamaRubrik() (+16 more)

### Community 53 - "News feed and rubric data"
Cohesion: 0.14
Nodes (18): absoluteShareUrl, avatarInitials, bodyHtml, breadcrumbItems, heroCaption, heroCredit, readingMinutes, wasUpdated (+10 more)

### Community 54 - "Sitemap XML rendering"
Cohesion: 0.16
Nodes (21): SITEMAP_SOURCES, chunkSitemapEntries(), collectSitemapEntries(), escapeXml(), getAllSitemapEntries(), KATALOG_SITEMAP_SOURCE_NAMES, registerSitemapSource(), renderSitemapIndexXml() (+13 more)

### Community 55 - "Legacy seputarborneo importer"
Cohesion: 0.09
Nodes (26): ADR-0114, RFC-3986, BASE_URL, BuildResult, DAERAH_LEAF_LABELS, ExportOptions, LegacyImportRecordJson, Manifest (+18 more)

### Community 56 - "Shared storefront components and helpers"
Cohesion: 0.11
Nodes (15): rubrikColumn, year, [], channelCandidates, footerLinks, publishedSlugs, year, SEARCH_SURFACE (+7 more)

### Community 57 - "Account contract types (akun-kontrak)"
Cohesion: 0.14
Nodes (18): Akun, AKUN_EVENT_NAME, AKUN_STORAGE_KEY, isIsoDateString(), isSesiKedaluwarsa(), parseSesi(), SesiAkun, ADR-0007 (+10 more)

### Community 58 - "CMS seed CLI HTTP helpers"
Cohesion: 0.22
Nodes (26): apiCall(), applySiteProfile(), assertOk(), ensureAdPlacements(), ensureBlogPages(), ensureBlogPosts(), ensureBlogTerms(), ensureCategories() (+18 more)

### Community 59 - "Storefront theme and brand tokens"
Cohesion: 0.14
Nodes (18): chunk(), crc32(), CRC_TABLE, encodePng(), GLYPHS, hexToRgb(), iconInitial(), IconSpec (+10 more)

### Community 60 - "E2E global setup"
Cohesion: 0.16
Nodes (22): api(), chooseAndEnable(), CORS(), enrolled(), enrolledOnAccount(), failRegistration(), installPushMock(), login() (+14 more)

### Community 61 - "BPS region discovery"
Cohesion: 0.15
Nodes (21): main(), OUT, Probe, ROOT, WILAYAH, ChallengeError, coreName(), matchTitle() (+13 more)

### Community 62 - "Local CI process and port helpers"
Cohesion: 0.25
Nodes (17): run(), RunOptions, RunResult, freePort(), LegContext, LegOutcome, runCheckCmsLeg(), skipCount() (+9 more)

### Community 63 - "Reading-preferences panel and module"
Cohesion: 0.13
Nodes (16): A11Y_STORAGE_VERSION, ATTRIBUTES, clearStoredPreferences(), DEFAULT_PREFERENCES, isTextSize(), parsePreferences(), readStoredPreferences(), ScrollDocument (+8 more)

### Community 64 - "Release evidence and latest-flag tooling"
Cohesion: 0.21
Nodes (18): gitRunInherit(), buildEvidence(), validateEvidence(), computeLatestFlag(), deriveImageTags(), highestTag(), imageRepository(), isValidTag() (+10 more)

### Community 65 - "News feed tests and post lookups"
Cohesion: 0.16
Nodes (17): absoluteUrl(), DefaultIdentity, siteConfig, siteUrl, BeritaFeedItem, getPost(), renderBeritaRssXml(), renderPortableText() (+9 more)

### Community 66 - "Single-flight guard and account messages"
Cohesion: 0.12
Nodes (17): buatPenjagaDom(), buatPenjagaTunggal(), HasilJalan, KaitPenjaga, KeadaanPenjaga, OpsiJalan, OpsiPenjagaDom, OpsiPenjagaUntuk (+9 more)

### Community 67 - "Push guard and worker configuration"
Cohesion: 0.11
Nodes (16): adaPenanda(), jagaPenandaPush(), isCustomerPushEnabled(), PUSH_WORKER_PATH, PUSH_WORKER_SCOPE, ADR-0049, PUSH_MARKER_KEY, PUSH_NOTICE_KEY (+8 more)

### Community 68 - "Docs i18n mirror stamping"
Cohesion: 0.13
Nodes (17): checkMergedResult(), checkMergeInputsCompatible(), validateGraphFile(), assertNotUnderSubtree(), isAbsoluteLike(), isUnderSubtree(), CMS_GRAPH, cmsResult (+9 more)

### Community 69 - "BPS archive and checksums"
Cohesion: 0.12
Nodes (21): ITEM, LOCAL, NO_REGIONS, PDF_BYTES, SHA, ArchiveDeps, archiveOne(), compareVerification() (+13 more)

### Community 70 - "Site theme extraction and API origin"
Cohesion: 0.16
Nodes (16): DEFAULT_THEME_COLORS, apiOrigin(), extractThemeToken(), fetchSiteTheme(), getSiteTheme(), tenantCode(), ThemeColors, contrastingForeground() (+8 more)

### Community 71 - "Obsidian export tool"
Cohesion: 0.14
Nodes (16): ALLOWED_EXTENSIONS, basenameOf(), checkCuratedCollision(), classifyEntry(), extensionOf(), isAbsoluteLike(), KNOWN_HOUSEKEEPING_BASENAMES, resolveWithin() (+8 more)

### Community 72 - "BPS extract test fixtures"
Cohesion: 0.17
Nodes (18): ctxOf(), fixture(), pageOf(), snakeCase(), absDiff(), CheckFailure, CheckReport, dedupe() (+10 more)

### Community 73 - "Checkout and popup e2e site config"
Cohesion: 0.14
Nodes (16): activeRouteKeys(), cspNeedsFor(), describeProfile(), excludedRouteKeys(), feedsFor(), groupStylesheetsFor(), isGroupActive(), isRouteActive() (+8 more)

### Community 74 - "Product listing filters & sort"
Cohesion: 0.18
Nodes (16): preferredScrollBehavior(), filterProdukIndex(), normalizeSearchTerm(), paginateProdukIndex(), ProdukIndexEntry, emptyState, grid, heading (+8 more)

### Community 75 - "Review list rendering and status tones"
Cohesion: 0.14
Nodes (14): UlasanAkun, Envelope, STOREFRONT_PATH_PREFIX, TokoApiError, hideSubmitError(), loadList(), render(), renderItem() (+6 more)

### Community 76 - "Ad popup widget"
Cohesion: 0.15
Nodes (14): BODY_OPEN_CLASS, CLOSE_LABEL, CTA_LABEL, DEFAULT_LABEL, DIALOG_ID, IklanPopupData, initIklanPopup(), isModifiedClick() (+6 more)

### Community 77 - "BPS cell and row parsing"
Cohesion: 0.19
Nodes (18): CellKind, indonesianPart(), isCellToken(), isIndexToken(), numeric(), parseCell(), ParsedCell, analysePage() (+10 more)

### Community 78 - "Astro profile route injection"
Cohesion: 0.19
Nodes (15): SITE, BERANDA_ALIAS, berandaVariantPath(), collectInjectedRoutes(), ENDPOINT_EXTENSIONS, listPageFiles(), PAGE_EXTENSIONS, profil() (+7 more)

### Community 79 - "Booking e2e helpers"
Cohesion: 0.15
Nodes (14): api(), browserPage(), confirmed(), day(), hold(), login(), open(), payDeposit() (+6 more)

### Community 80 - "Local CI security baseline"
Cohesion: 0.21
Nodes (14): BaselineEntry, isBaselined(), parseBaseline(), partitionHighSeverityFindings(), SecurityFinding, CODEQL_CLI_SHA256, CODEQL_CLI_VERSION, codeqlCacheDir() (+6 more)

### Community 81 - "Redirect import push tool"
Cohesion: 0.15
Nodes (18): chunkIdempotencyKey(), ChunkOutcome, chunkRedirects(), FileWideDuplicate, findFileWideDuplicates(), ImportErrorEnvelope, ImportItemReport, ImportPoster (+10 more)

### Community 82 - "Read-aloud (dengar) player"
Cohesion: 0.20
Nodes (11): bacaSimpanan(), DILEWATI, initDengar(), KELAS_DIBACA, kumpulkanUnit(), pasangPemutar(), pecahKalimat(), suaraIndonesia() (+3 more)

### Community 83 - "Account address book"
Cohesion: 0.26
Nodes (16): Alamat, AlamatInput, clearFieldErrors(), closeForm(), deleteAlamat(), hideSubmitError(), loadList(), openFormForCreate() (+8 more)

### Community 84 - "Product listing state and sort types"
Cohesion: 0.17
Nodes (16): ProductSort, ProdukIndexFilter, applyAndRender(), countEl, emptyState, form, grid, isProductSort() (+8 more)

### Community 85 - "Reading-preferences panel e2e"
Cohesion: 0.15
Nodes (15): axePanel(), axeSerious(), describeViolations(), fab(), FAILING_IMPACT, htmlAttribute(), openPanel(), panel() (+7 more)

### Community 86 - "Deploy preflight reporter tests"
Cohesion: 0.22
Nodes (14): createReporter(), checkDistForToken(), checkStorefrontEnvShape(), collectFiles(), isHttpsUrl(), loadEnv(), looksLikeToken(), main() (+6 more)

### Community 87 - "Reading-preferences constants and change event"
Cohesion: 0.18
Nodes (15): A11Y_CHANGE_EVENT, OsPreferences, resolveEffectivePreferences(), SWITCH_KEYS, SwitchKey, TEXT_SIZES, TextSize, initA11yPanel() (+7 more)

### Community 88 - "Environment access and static page fetch"
Cohesion: 0.18
Nodes (12): AwcmsApiError, detailCache, fetchStaticPage(), fetchStaticPageList(), getStaticPage(), isExpectedRefusal(), listStaticPages(), StaticPageDetail (+4 more)

### Community 89 - "MySQL dump reader"
Cohesion: 0.18
Nodes (11): DumpRow, extractCreateTableColumns(), findMatchingParen(), findNextStatementStart(), Mode, readMysqlDumpRows(), SqlInsertTokenizer, tryParseValueTuple() (+3 more)

### Community 90 - "WhatsApp fallback and account status labels"
Cohesion: 0.22
Nodes (14): AfiliasiKomisiHalaman, appendKomisiRows(), hideSubmitError(), KOMISI_STATUS_LABELS, KOMISI_STATUS_TONES, loadMoreKomisi(), render(), renderEnrolled() (+6 more)

### Community 91 - "Terpopuler analytics client"
Cohesion: 0.23
Nodes (10): fetchTopPaths(), getTopPaths(), hitungTayangPerSlug(), isExpectedRefusal(), pilihTerpopuler(), resetAnalitikCacheForTests(), slugDariPath(), TERPOPULER_RANGE (+2 more)

### Community 92 - "E2E accessibility and responsive specs"
Cohesion: 0.20
Nodes (9): FAILING_IMPACT, WCAG_TAGS, ACTIVE_PROFILE, KEY_PAGES, KeyPage, VIEWPORTS, ALL_VIEWPORTS, requestedPageNames (+1 more)

### Community 93 - "BPS region extraction"
Cohesion: 0.19
Nodes (14): index, buildIndex(), coreLabel(), kindFromGroupLine(), KindHint, NAME_ALIASES, normalizeLabel(), parentCode() (+6 more)

### Community 94 - "Legacy importer tests"
Cohesion: 0.28
Nodes (12): buildPostRecord(), buildVideoRecord(), legacyNewsUrlCurrent(), legacyNewsUrlPre2000(), legacyVideoIdSlug(), legacyVideoUrl(), newPostSlug(), normalizeYoutubeVideoId() (+4 more)

### Community 95 - "PWA web manifest"
Cohesion: 0.23
Nodes (11): SITE_PROFILE, buildManifest(), ICON_PATHS, MANIFEST_ID, MANIFEST_SCOPE, MANIFEST_START_URL, ManifestInput, PROFILE_CATEGORIES (+3 more)

### Community 96 - "Deploy scenario test harness"
Cohesion: 0.18
Nodes (13): baseEnv(), callIndexOf(), calls(), DEPLOY_DIR, DEPLOY_PRODUCTION, DEPLOY_REMOTE, GOOD_SHA, HEALTHCHECK (+5 more)

### Community 97 - "E2E ports and global setup entry"
Cohesion: 0.23
Nodes (9): buildAndServe(), BuildAndServeOptions, BuiltSite, waitForHttp(), globalSetup(), PREVIEW_PORT, STUB_PORT, ADR-0002 (+1 more)

### Community 98 - "Product detail variant pricing"
Cohesion: 0.23
Nodes (12): CommerceProductVariant, findVariantForSelection(), currentVariant(), effectiveMaxQuantity(), effectivePrice(), FlashSalePayload, hasSelection(), ProdukDetailPayload (+4 more)

### Community 99 - "Root package manifest"
Cohesion: 0.15
Nodes (12): description, engines, homepage, license, name, packageManager, private, repository (+4 more)

### Community 100 - "Lockfile consistency check"
Cohesion: 0.19
Nodes (11): stripTrailingCommas(), ALL_PACKAGES, DEPENDENCY_BLOCKS, findWorkspaces(), foundPaths, foundWorkspaces, lock, problems (+3 more)

### Community 101 - "Base tsconfig compiler options"
Cohesion: 0.15
Nodes (12): compilerOptions, isolatedModules, lib, module, noEmit, strict, target, extends (+4 more)

### Community 102 - "Deploy shell common library"
Cohesion: 0.22
Nodes (7): deploy_acquire_lock(), deploy_audit_append(), deploy_ensure_state_dir(), deploy_fail(), deploy_log(), deploy_write_current_release(), common.sh script

### Community 103 - "Reading-preferences storage and early-apply tests"
Cohesion: 0.20
Nodes (9): A11Y_STORAGE_KEY, A11yPreferences, Attributes, fakeRoot(), runEarly(), SOURCE, ADR-0057, VALID (+1 more)

### Community 104 - "Log redaction helpers"
Cohesion: 0.32
Nodes (7): redactLine(), redactText(), fakeBearerValue, fakeDsnPassword, fakeGithubToken, redact(), main()

### Community 105 - "BPS district job planning"
Cohesion: 0.23
Nodes (11): blankDistrict(), DistrictJob, districtPdfPath(), listFor(), listKecamatan(), DistrictMatch, districtPdfName(), DistrictRegion (+3 more)

### Community 106 - "CMS API fetch client"
Cohesion: 0.21
Nodes (10): collectPendingAssignments(), runAssignInstitutions(), termMapHintFor(), apiCall(), ApiResult, assertOk(), AwcmsApiError, resolveExistingTenantSession() (+2 more)

### Community 107 - "Build id writer script"
Cohesion: 0.16
Nodes (7): buildId, OUT_PATH, resolveBuildId(), cleanup, fixture(), run(), SCRIPT

### Community 108 - "Push browser port permissions and subscription"
Cohesion: 0.27
Nodes (4): aktifkanPerangkat(), PortPeramban, petakanGalatPeramban(), TeksPersetujuan

### Community 109 - "Reading-preferences CSS invariants test"
Cohesion: 0.20
Nodes (8): ATTRIBUTE_SECTION, CSS, GLOBAL_CSS, OS_SECTION, PANEL, RAW_CSS, section(), ADR-0057

### Community 110 - "Storefront tsconfig compiler options"
Cohesion: 0.18
Nodes (10): compilerOptions, baseUrl, paths, types, extends, @profil/beranda, astro/tsconfigs/strict, bun (+2 more)

### Community 111 - "kontrak package manifest"
Cohesion: 0.18
Nodes (10): awcms, dependencies, awcms, description, exports, name, private, type (+2 more)

### Community 112 - "Production compose file tests"
Cohesion: 0.18
Nodes (5): ADR-0019, COMPOSE_PATH, doc, raw, REPO_ROOT

### Community 113 - "Subtree-write guard tests"
Cohesion: 0.24
Nodes (8): buildFixture(), cleanup, COMBINE_SCRIPT, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 115 - "Single-flight contract test"
Cohesion: 0.28
Nodes (7): BACA_SAJA, DIKECUALIKAN, LIBS, mutasiDalam(), mutatingExports(), SCRIPTS, stripKomentar()

### Community 116 - "Obsidian export tool tests"
Cohesion: 0.31
Nodes (7): buildFixture(), cleanup, EXPORT_SCRIPT, fakeGraph(), fakeGraphifyBin(), REPO_ROOT, write()

### Community 117 - "BPS table and region index"
Cohesion: 0.36
Nodes (8): bboxWindow(), decodeEntities(), ENTITIES, loadPages(), median(), parseBboxPages(), pdfPageCount(), Word

### Community 118 - "runExport"
Cohesion: 0.28
Nodes (9): buildRedirectEntry(), buildSiteProfileUpdateFromConfig(), flag(), main(), runExport(), runPushRedirects(), usage(), formatPushSummary() (+1 more)

### Community 119 - "Push-only service worker click handling"
Cohesion: 0.39
Nodes (5): isRecord(), normalizePayload(), resolveTarget(), tagOf(), text()

### Community 120 - "No-prerender guard tests"
Cohesion: 0.29
Nodes (7): listAllPageFiles(), listSourceFiles(), PAGES_ROOT, PROFIL_ROOT, SRC_ROOT, TOKO_PAGES_ROOT, ADR-0007

### Community 121 - "Local CI audit exceptions parser"
Cohesion: 0.46
Nodes (6): valid, AuditException, auditIgnoreArgs(), loadAuditIgnoreArgs(), parseAuditExceptions(), runBunAuditWithExceptions()

### Community 122 - "BPS publication discovery"
Cohesion: 0.25
Nodes (8): blank(), discoverActionId(), findPublication(), listPage(), pdfPath(), processOffice(), extractActionId(), findPublicationChunk()

### Community 123 - "Contract import-direction test"
Cohesion: 0.38
Nodes (4): join(), SCANNED_EXTENSIONS, SKIP, sourceFiles()

### Community 124 - "Preference attribute application"
Cohesion: 0.47
Nodes (4): applyPreferences(), AttributeTarget, clearAppliedPreferences(), toggleAttribute()

### Community 125 - "Booking pages build smoke tests"
Cohesion: 0.33
Nodes (3): canSpawnBun(), PAGE_SOURCES, PAGES

### Community 126 - "Social-meta build-smoke test"
Cohesion: 0.47
Nodes (4): canSpawnBun(), headOf(), relLinks(), socialMeta()

### Community 127 - "Stale-phrase prose check"
Cohesion: 0.33
Nodes (5): ADR-0016, EN, ID, STALE_EN_PHRASES, STALE_ID_PHRASES

### Community 128 - "packages/config manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 129 - "Gate report formatter"
Cohesion: 0.40
Nodes (3): formatReport(), SCRIPT_DIRS, scripts

### Community 130 - "packages/gerbang manifest"
Cohesion: 0.33
Nodes (5): description, name, private, type, version

### Community 131 - "Docs audit test suite"
Cohesion: 0.33
Nodes (4): cleanup, ADR-0042, run(), SCRIPT

### Community 132 - "Release audit tests"
Cohesion: 0.33
Nodes (3): cleanup, run(), SCRIPT

### Community 133 - "Seed CLI region resolution"
Cohesion: 0.53
Nodes (6): ensureInstitutionsGeneric(), fetchRegionItems(), matchRegionCode(), namesMatchIgnoringSpaces(), resolveKaltengRegions(), resolveRegionCode()

### Community 135 - "Root dependency overrides"
Cohesion: 0.40
Nodes (5): overrides, sharp, shell-quote, smol-toml, source-map-js

### Community 136 - "Kontrak tsconfig compiler options"
Cohesion: 0.40
Nodes (4): compilerOptions, jsx, jsxImportSource, moduleResolution

### Community 138 - "Graph-update tool (knowledge:graph:update)"
Cohesion: 0.40
Nodes (4): COST_PATH, GRAPHIFY_ENV, ROOT, run()

### Community 139 - "README screenshots script"
Cohesion: 0.50
Nodes (3): run, { values }, SITE_PROFILES

### Community 145 - "BPS extractor region index types"
Cohesion: 0.50
Nodes (4): RegionIndex, PageInfo, Ctx, Found

### Community 147 - "Workspace member globs"
Cohesion: 0.67
Nodes (3): workspaces, apps/*, packages/*

## Knowledge Gaps
- **948 isolated node(s):** `Envelope`, `EnvSource`, `name`, `type`, `version` (+943 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **15 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `bun` connect `bun` to `lib/deps-freshness.ts`, `orchestrate.ts`, `audit-dokumen.test.mjs`, `audit-rilis.test.mjs`, `plan.mjs`, `rilis.mjs`, `knowledge-graph-update.mjs`, `archive.ts`, `profil-uji-bersama.ts`, `pipeline.ts`, `run.ts`, `images.ts`, `bps-population-fetch.test.mjs`, `run`, `publish.ts`, `security.ts`, `deploy-preflight.mjs`, `mysql-dump-reader.ts`, `deploy-production.test.mjs`, `build-and-serve.ts`, `package.json`, `audit-graf.test.mjs`, `words.ts`, `runExport`, `audit-exceptions.ts`, `booking-build-smoke.test.ts`, `meta-sosial-build-smoke.test.ts`?**
  _High betweenness centrality (0.262) - this node is a cross-community bridge._
- **Why does `ADR-0018` connect `plan.mjs` to `seed-cms.ts`, `profil.mjs`, `routes.ts`, `profil-uji-bersama.ts`, `config/profil.ts`?**
  _High betweenness centrality (0.102) - this node is a cross-community bridge._
- **Why does `ADR-0048` connect `ADR-0048` to `stub-awcms.mjs`, `akun-klien.ts`, `akun-notifikasi.ts`, `push-alur.ts`, `push-pelanggan.ts`, `bacaSesi`, `profil-uji-bersama.ts`, `sw-notifikasi.js`, `akun-sesi.ts`, `akun-notifikasi.e2e.ts`, `bun-only-deployment-manifests.test.mjs`, `masuk.ts`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **What connects `Envelope`, `EnvSource`, `name` to the rest of the system?**
  _948 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `checkout.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.050042955326460484 - nodes in this community are weakly interconnected._
- **Should `lib/deps-freshness.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.060784313725490195 - nodes in this community are weakly interconnected._
- **Should `orchestrate.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06234177215189873 - nodes in this community are weakly interconnected._