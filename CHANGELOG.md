# Changelog

Every entry below is folded from `.changesets/` by `bun run release`, which also tags the release. The version is `MAJOR.MINOR.PATCH`, tagged `vX.Y.Z`; the next version is the largest `bump` declared among the changesets a release folds (see [`.changesets/README.md`](.changesets/README.md)) — never a level chosen at release time from a list of file names.

## [0.11.0] — 2026-09-23

### CODEOWNERS, a PR template, and issue forms

Contribution routing had no structure: no `CODEOWNERS` to route review requests, no PR template to put `AGENTS.md`'s Definition of Done in front of a contributor (human or agent) at the exact moment they open a PR, and no issue forms to separate the three shapes this repo's own history actually produces — a bug report, a feature request, and a `git subtree pull` of `apps/cms` from `ahliweb/awcms`, which carries its own checklist nothing else was reminding anyone of.

- `.github/CODEOWNERS`: `@ahliweb` (the repo's single user-account owner — not an org, no team syntax) as the default, plus explicit routing lines for `apps/cms/`, `.github/`, `packages/gerbang/`, `tools/`, and `docs/adr/`. Advisory only — branch protection does not require a code-owner review, so this drives GitHub's own routing UI, not a merge gate.
- `.github/pull_request_template.md`: Summary, linked issue, how it was verified, and a checklist mirroring `AGENTS.md`'s Definition of Done in substance — short enough to actually fill in.
- `.github/ISSUE_TEMPLATE/`: `bug_report.yml` and `feature_request.yml` (both with an area dropdown covering storefront/cms-commerce/cms-upstream/tooling-gates/docs/deployment), `upstream_sync.yml` (upstream commit/PR, reason, and a checklist naming the documented local divergences by path), and `config.yml` (blank issues off in the web chooser only — `gh issue create` and the API, which is how this repo's own epics get opened, are unaffected; a contact link routes vulnerability reports to a private GitHub Security Advisory, per `SECURITY.md`).
- `CONTRIBUTING.md` (+ `.id.md`): the contribution flow now points at the issue forms and the PR template, and a new "Code ownership" section explains what `CODEOWNERS` does and does not gate.

No code, gate, or runtime behaviour changes — this is contribution-process scaffolding.

### GitHub Releases are published from CHANGELOG.md on tag push

Ten release tags (`v0.1.0`–`v0.10.0`) existed with zero GitHub Release
objects behind them — a template user landing on this repo's own GitHub page
saw no release notes at all, even though every one of those tags already has
a perfectly good entry sitting in `CHANGELOG.md`. Writing the Release by hand
is exactly the kind of mechanical, easily-postponed step `tools/rilis.mjs`
already exists to take off a maintainer's plate for the rest of a release —
this closes the one part it did not yet cover.

- **`packages/gerbang/lib/changelog.mjs`** (new, pure, unit-tested): reads one
  version's section out of a `CHANGELOG.md`-shaped document, refusing —
  rather than silently mis-splitting — when a `##` heading has drifted from
  the one shape (`## [X.Y.Z] — <date>`) every version heading relies on.
- **`tools/rilis-catatan.mjs`** (new): the CLI shell around it — prints one
  version's section to stdout, accepting `v0.10.0` or `0.10.0`, exiting
  non-zero with a clear stderr message when the version is missing or the
  file is malformed. `tests/rilis-catatan.test.mjs` covers the parser
  directly (middle/first/last section, missing version, optional `v`
  prefix, CRLF, heading-format drift) and the CLI's own exit-code contract.
- **`.github/workflows/release.yml`** (new): `push: tags: ['v*']` plus a
  `workflow_dispatch` `tag` input, `permissions: contents: write` only.
  Extracts the pushed version's notes with the tool above and runs
  `gh release create --verify-tag`, marking `--latest` only when that tag is
  the highest `v*` semver (`git tag --sort=-v:refname`, the same comparison
  `tools/rilis.mjs` itself already relies on) — or `gh release edit` when a
  Release already exists, so a `workflow_dispatch` backfill or a re-publish
  is idempotent rather than failing. The tag is validated against
  `^v[0-9]+\.[0-9]+\.[0-9]+$` and only ever reaches a shell script through
  `env:`, never spliced into `run:` as a `${{ }}` expression, to close off
  script injection through a hostile tag name or dispatch input.
- **`tools/rilis.mjs`**: its printed next steps after `--apply` now say that
  pushing the tag publishes the GitHub Release automatically, and how to
  back-fill or re-publish one via `workflow_dispatch`.
- Docs: `docs/alur-kerja-pengembangan.md`'s "The release cut" section and
  `AGENTS.md`'s "Changesets and releases" section now describe the publish
  step, both with their Indonesian mirrors re-stamped.

After this merges, the manager backfills Releases for `v0.1.0`–`v0.10.0` by
dispatching this workflow once per tag.

### Publish `apps/cms`'s runtime/jobs images to GHCR, with SBOM and provenance

Every production deploy re-ran `bun install --frozen-lockfile` and a full `apps/cms`
build on the machine serving traffic, with nothing attestable behind the tag a
rollback would name. `apps/cms/Dockerfile.production`'s `runtime` and `jobs`
targets are content-independent — a pure function of a commit, unlike the
storefront's own image, which bakes a tenant's live catalog/news content at
build time using the CMS owner token as a BuildKit secret. That asymmetry is
why only the CMS images are published here (see [ADR-0020](docs/adr/0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md)
for the full reasoning and the rejected alternatives — publishing the
storefront too, a runtime-building storefront container, a third-party
registry).

- `.github/workflows/images.yml` (new, not a required check) builds both
  targets and, on a `v*` tag push or an explicit `workflow_dispatch` with its
  `push` input checked, publishes `ghcr.io/<owner>/<repo>-cms` and
  `-cms-jobs` — semver + sha tags, an SBOM, and a provenance attestation
  verifiable with `gh attestation verify`. It builds (never pushes) on a
  `pull_request` touching `apps/cms/**`/`apps/storefront/**`/
  `compose.production.yaml`, and separately proves `apps/storefront/Dockerfile`
  still builds, per `SITE_PROFILE`, against this repo's own stub CMS.
- `compose.production.yaml`'s `cms`/`jobs`/`migrate` services read their
  image name from `AWCMS_ONE_CMS_IMAGE`/`AWCMS_ONE_CMS_JOBS_IMAGE`, defaulting
  to today's local-build names — an operator can now point a deployment at a
  published tag instead of building on the deploy host, or change nothing.
- `docs/deployment.md` gains a "Published images" section (pulling via the
  new env vars, verifying the attestation/SBOM, GHCR package visibility) and
  corrects a stale "not built" note that pre-dated this pipeline; `AGENTS.md`'s
  "Not here yet" list is updated the same way. ADR-0019 itself is left
  untouched — it is cited from ADR-0020, not amended.

### Repository settings hardening: admin enforcement, conversation resolution, template-init-smoke required

Issue #182 closed a gap between what `main`'s branch protection actually enforced and what a maintainer merging solo could still get away with: until now, an administrator (the only role that ever merges here) could push past a red or pending required check, and a review thread could be left unresolved at merge time. Neither is a defect a reviewer would catch, because both only matter on the one PR where someone is in a hurry — exactly when a mechanical gate is worth more than a habit.

- `enforce_admins` is now on: an administrator merging `main` is held to the same required-status-check bar as anyone else.
- `required_conversation_resolution` is now on: every review conversation on a PR must be marked resolved before it can merge.
- All four `template-init-smoke` legs (`toko`, `berita`, `landing`, `root-suite`) are now required status checks, alongside the existing `check-cms`/`Check (toko)`/`Check (berita)`/`Check (landing)` four — the workflow has run green on `main` with no path filter since issue #147's job split, so the promotion this document always described as pending has now happened.
- Secret scanning and push protection were confirmed on; two additional toggles (`secret_scanning_non_provider_patterns`, `secret_scanning_validity_checks`) were attempted but remain `disabled` — they appear to require a GitHub Secret Protection licence this user-owned public repository cannot enable. Documented as unavailable rather than claimed as enabled.
- The repository wiki was disabled after confirming it held nothing (`ahliweb/awcms-one.wiki.git` did not exist) — this repository's documentation already lives under `docs/**`.
- `.gitignore` now ignores `/redesign/`, so a local design-source drop (e.g. an unpacked redesign zip used as reference input) is never accidentally staged.

No code, schema, or runtime behaviour changes. `docs/alur-kerja-pengembangan.md`, `AGENTS.md`, `README.md`, and `docs/template.md` (each with its Indonesian mirror) are updated to match the settings as verified, with the `gh api` commands to re-verify them.

### `audit:graf` fails once the root knowledge graph drifts too far from the tree

`graphify-out/` was last regenerated 2026-09-20, before v0.10.0's storefront
redesign — `audit:graf` verified the corpus was self-consistent but never
that it still described the current code, and CI has no `graphify` on `PATH`
to regenerate it itself.

- `audit:graf` now diffs `graphify-out/manifest.json`'s recorded per-file MD5
  (`graphify`'s own `ast_hash` — verified reproducible with plain
  `node:crypto`, no `graphify` install needed) against the current working
  tree, and fails once more than `MAX_STALE_FILES` (40) files show up
  changed/added/removed since the graph was last built — content-based, not
  git history, so it works under CI's possibly-shallow checkouts.
- `packages/gerbang/lib/graf-checks.mjs` gains the pure counting logic
  (`diffManifestStaleness`, `checkStaleness`, `md5Hex`,
  `manifestExtensions`, `inScopeCandidates`), unit-tested directly in
  `tests/graf-checks-staleness.test.mjs` (under/at/over the bound,
  added/removed in isolation) with the runner's wiring proven end-to-end in
  `tests/audit-graf.test.mjs`.
- The root graph is regenerated (`bun run knowledge:graph:update`,
  `--code-only`, `apps/cms/` still excluded) and every one of its 94
  communities carries a human-chosen name — the graph is at parity with the
  tree as of this change.

### CodeQL code scanning for JavaScript/TypeScript

Issue #184 (part of epic #179) adds GitHub CodeQL code scanning alongside the secret scanning + push protection and Dependabot security updates already enabled on this repository (issue #182).

- `.github/workflows/codeql.yml` — a new, separate workflow (`javascript-typescript`, `build-mode: none`) on push to `main`, every pull request, a weekly schedule, and manual dispatch. `github/codeql-action/{init,analyze}` are pinned to a commit SHA (`1c5b675653bb5c22dbe9b12b556ec555138e09fd`, `# v4.38.1`, verified against `github/codeql-action`'s own tag), the job's own permissions are the least required (`security-events: write`, `actions: read`, on top of the workflow-level `contents: read`), and the query suite is `security-extended` — not upstream `ahliweb/awcms`'s own `security-extended,security-and-quality`, since this repository has no CodeQL triage playbook of its own yet.
- `.github/codeql/codeql-config.yml` excludes only generated/build/vendored output (`node_modules`, `dist`, `.astro`, `graphify-out`, generated i18n catalogs, lockfiles, vendored datasets, Playwright run artefacts) at any depth in the workspace. **`apps/cms/**` SOURCE stays in scope** — it is the code that actually runs in this deployment, even though that tree is upstream `ahliweb/awcms` embedded via `git subtree`; a resulting finding there is triaged per `SECURITY.md` (fixed here only if it is one of `AGENTS.md`'s documented local divergences or this repository's own `commerce` module, otherwise reported/fixed upstream and pulled in via the normal subtree sync).
- Not a required status check yet — promoted, if ever, only after it has run green on `main` for a while, the same bar `check-cms` and `template-init-smoke` were held to before their own promotion.
- Docs: `SECURITY.md` (+ `.id.md`) now names all three forms of automated scanning in force and how a CodeQL alert on `apps/cms/**` is triaged; `docs/alur-kerja-pengembangan.md` (+ `.id.md`) gets a new "CI: a fifth workflow, not required — `codeql`" section describing the workflow's shape and scope decision.

### Dependabot version updates for GitHub Actions and this repo's own workspaces

`AGENTS.md`'s "Configuration and toolchain" already claimed GitHub Actions are pinned to a SHA "with a `# vX.Y.Z` comment Dependabot reads to keep both in step" — but no `.github/dependabot.yml` existed, so only Dependabot *security* updates ever ran and pinned actions/dependencies never received a routine version bump.

- Adds `.github/dependabot.yml`: `github-actions` (root workflows) and `bun` (this repo's own workspaces), both monthly and grouped (minor/patch together, majors separate).
- `bun` update excludes `apps/cms/**` (`exclude-paths`) — that tree is `ahliweb/awcms` embedded via `git subtree`, and upstream owns its own dependency set and its own (inert-here) `apps/cms/.github/dependabot.yml`.
- `bun` update ignores the `bun` dependency itself — its version is pinned in three places that must move together (`packageManager`/`engines.bun`, `bun-version` in every CI job), a deliberate hand-made change, not something a single-dependency PR should touch.
- `AGENTS.md` and `docs/alur-kerja-pengembangan.md` (plus their `.id.md` mirrors) now name the real config and describe what to check on a Dependabot PR against the lockfile gate.

### A newcomer-first README, with real per-profile screenshots

`README.md` (+ `.id.md`) had grown into the same increment-by-increment chronicle `docs/status.md` (issue #188) already moved out of `AGENTS.md` — a first-time visitor to a public template had to read five increments' worth of history before reaching "how do I run this". This restructures it around what a newcomer actually needs, in order: what the platform is (one paragraph) → screenshots of the redesigned storefront per build profile → "Use this as a template" + quick start → the documentation index → running locally → architecture at a glance → gates. The chronicle itself was never deleted — it lives in [`CHANGELOG.md`](CHANGELOG.md), and [`docs/status.md`](docs/status.md) is the current-state reference both documents now point to.

- Three new images, `docs/assets/readme-{toko,berita,landing}.webp` — an above-the-fold, 1280×800 crop of each build profile's home page, generated with `apps/storefront`'s own Playwright e2e harness (issue #183) and converted to WebP at quality 80. Combined weight: ~72 KB, well inside a 600 KB budget for this change. `apps/storefront/scripts/screenshots-readme.mjs` and `apps/storefront/tests/e2e/screenshots.e2e.ts` gained three new flags/env vars (`--pages`/`E2E_SCREENSHOT_PAGES`, `--viewport`/`E2E_SCREENSHOT_VIEWPORTS`, `--above-fold`/`E2E_SCREENSHOT_FULLPAGE`) so this exact shot is reproducible with one command per profile — documented in `docs/pengujian.md`. `.github/workflows/e2e.yml`'s own full-page, every-page, every-viewport CI capture is unchanged, since it sets none of the new env vars.
- A CI status badge for `.github/workflows/ci.yml`.
- The "Gates" section now names `MAX_STALE_FILES` (40, issue #186's bounded knowledge-graph staleness check) and briefly lists the four workflows that run on every push but are not yet required status checks (CodeQL, the Playwright e2e suite, the GHCR image publish, the release publish).
- `tools/template-init/rewriters.mjs`'s `rewriteReadme` structural markers (the H1 hero span, the "Use this as a template" span) are unchanged in shape, so `bun run template:init` still rewrites this README correctly for a derived repository — verified with `bun test ./tests/template-init.test.mjs` and the `template-init-smoke` workflow.

### Remove the Dependabot `bun` ecosystem block

Dependabot's `bun` updater cannot parse this repo's `bun.lock`
(`lockfileVersion` 2 — Bun 1.4's own format): its first scheduled run
failed outright (issue #199, run 35858077848), and a monthly job that
always fails is noise that hides a real failure. `.github/dependabot.yml`
now carries only the working `github-actions` block; this repo's own
workspace dependencies (root `package.json`, `apps/storefront`,
`packages/*`) are bumped by hand until Dependabot supports lockfile v2:
`bun update`, then `bun run check:lockfile`.

- `tests/dependabot-config.test.mjs` now asserts the block is absent
  while `bun.lock`'s `lockfileVersion` is greater than 1, and reads that
  number from the lockfile itself rather than hard-coding the invariant —
  so the test flips back to requiring the block the day it would pass.
- `AGENTS.md`'s "Configuration and toolchain" and
  `docs/alur-kerja-pengembangan.md`'s "Dependency updates" (plus both
  `.id.md` mirrors) describe the manual bump workflow and how to
  re-enable the block later.

### A single current-state status page; AGENTS.md becomes working rules only

`AGENTS.md`'s "What this repo is"/"What is here today" sections had grown into an increment-by-increment chronicle that went stale the moment the next increment landed — "Increment 1 — this epic — is foundation... with no live database" was still there after five increments. History belongs in `CHANGELOG.md` and the ADR index, not in the working contract a reader consults on every task.

- New `docs/status.md` (+ `.id.md`): the single, concise, current-state reference — what exists by surface (storefront per build profile, the `commerce` module, customer accounts, external integrations, ops/deploy, the template mechanism) and the short "not here yet" list, each item linking to its own document or ADR.
- `AGENTS.md` (+ `.id.md`): the two chronicle sections are replaced with a short summary pointing at `docs/status.md`; every working rule (the subtree embed, migration ranges, build profiles, the gates, the knowledge graph, toolchain, changesets, DoD, language, the bearer-session and `ROUTE_PARITY_EXEMPTIONS` rules) is kept in substance.
- `docs/README.md` (+ `.id.md`): added a `status.md` row, fixed the ADR count (eighteen → twenty), and made the `ui-ux.md`/`aksesibilitas.md`/`responsif.md` rows describe the documents as they are now (a design system with real product imagery; automated axe-core/browser-overflow verification, not only a manual read).
- Fixed a handful of present-tense claims elsewhere that contradicted the current tree: `docs/skema-basis-data.md` citing ADR-0016 as "not yet written" (it has been since increment 4), and `docs/arsitektur.md`'s epic-chronicle opening paragraph (now points at `docs/status.md` instead).
- `AGENTS.md`'s Dependabot bullet also updated to match reality: no `bun` ecosystem block (Dependabot's updater cannot parse this repo's `bun.lock` `lockfileVersion` 2 — issue #199), workspace dependencies bumped by hand instead.

### Storefront Playwright e2e now runs in CI: axe accessibility, no-overflow checks, per-profile screenshots

`apps/storefront/tests/e2e/` (Playwright: checkout, the ad popup) never ran in CI, and `docs/aksesibilitas.md`/`docs/responsif.md` both stated their claims were verified by reading code by hand, not by a tool or a browser — stale since the 2026-09 redesign rewrote every public page's visuals (issue #183, part of #179).

- Two new spec files, deterministic only: `aksesibilitas.e2e.ts` (`@axe-core/playwright`, `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` tags, failing on `serious`/`critical`) and `responsif.e2e.ts` (`document.documentElement.scrollWidth` vs. `window.innerWidth` at 360px/1280px) — both walk every key page of the active build profile via the new shared `profil-halaman.ts`.
- `screenshots.e2e.ts` captures a full-page PNG per key page per viewport, uploaded as a CI artifact and never diffed against a committed baseline (cross-OS font rendering, no paid visual-diff service).
- `.github/workflows/e2e.yml`: a new workflow, a 3-leg matrix over `SITE_PROFILE` (`toko`/`berita`/`landing`), Chromium cached, actions pinned to SHA — deliberately **not** a required status check yet, matching `template-init-smoke.yml`'s own promotion path.
- `bun run screenshots:readme` (`apps/storefront/scripts/screenshots-readme.mjs`) regenerates the same screenshots deterministically from the identical harness, for a future README-images change to consume.
- `apps/storefront/tests/e2e/build-and-serve.ts` factors the build+serve harness out of `global-setup.ts` so both the Playwright run and the new script share one implementation.
- The first real run found four real `serious` axe colour-contrast violations, a genuine flex-direction bug overflowing `/produk`'s filter sidebar at 360px, and a pre-existing `<dialog>` centering bug the global margin reset had silently broken — all fixed in `apps/storefront` tokens/components, documented in `docs/aksesibilitas.md`/`docs/responsif.md`.
- `docs/pengujian.md`, `docs/aksesibilitas.md`, `docs/responsif.md` (+ `.id.md` mirrors) restate every claim as tool-verified, with each tool's own stated limits.

`bun.lock` gained `@axe-core/playwright` as an `apps/storefront` devDependency, regenerated by `bun install`.

### Fix the storefront Dockerfile smoke job's unreachable stub CMS

`.github/workflows/images.yml`'s `storefront-smoke` job has never passed:
`astro build` inside `apps/storefront/Dockerfile` failed prerendering with
`awcms could not be reached at http://localhost:4310`. The job's
`docker/setup-buildx-action` step defaulted to the `docker-container`
driver, which runs BuildKit inside its own container with its own network
namespace — so `--network host` in the build step meant that container's
host namespace, not the runner's, and the stub CMS started on the runner
(`apps/storefront/scripts/stub-awcms.mjs`) was unreachable from inside the
build.

- `storefront-smoke` now passes `driver: docker` to `setup-buildx-action`,
  so the build runs in the runner's own dockerd, where `--network host` is
  the runner's real network namespace.
- `cms-images` is deliberately left on the default `docker-container`
  driver — it pushes to a registry and uses `cache-to: type=gha`, both of
  which need BuildKit features the classic `docker` driver does not
  support.

## [0.10.0] — 2026-09-22

### Storefront redesign — account and affiliate pages

Wave 2 of the 2026-09 redesign (issue #168), built on issue #166's foundation (`.btn`, `.pill`, `.field-label`/`.is-mono`, the 42px form controls) — markup/CSS only across `apps/storefront/src/profil/toko/pages/akun/**`, `masuk.astro`, `daftar.astro`, `apps/storefront/src/styles/akun.css`, and the account scripts' own DOM-building code. The bearer-session client (`akun-sesi.ts`/`akun-klien.ts`) and every data-fetching contract are unchanged; every pre-existing `data-*` hook a test asserts on is unchanged.

- **Account shell**: an avatar tile (initials on `--bg-inverse`), the account's name/e-mail, and a "Keluar" button, plus a persistent side navigation (Ringkasan/Pesanan/Alamat/Pesan/Ulasan/Afiliasi) with `aria-current="page"` on the six account pages.
- **Ringkasan**: three stat tiles (pesanan / sedang berjalan / wishlist), computed from `akun-klien.ts` functions the client already exposes — no new endpoint. The promo-preference checkbox (issue #115) is unchanged behaviour, restyled.
- **A shared status-pill tone map** across orders/reviews/affiliate/commissions: pending → warning, paid/published/approved/completed/active → success, cancelled/expired/rejected/void/suspended → danger, processing/shipped → info.
- **Pesanan/Alamat/Pesan/Ulasan**: order rows, address cards ("Utama" pill, dashed "+ Tambah alamat"), message threads (unread pill, arrow), and review cards (mono star rating on a new `--text-rating` token scoped to `akun.css`).
- **Afiliasi**: a status pill, the referral link in a dashed mono box (a real focusable `<input readonly>`), a "Salin"/"Tersalin!" copy button (behaviour unchanged), four stat tiles, and a commission table.
- **Masuk/Daftar**: the same 42px form controls, `.field-label`, `.is-mono` phone/OTP inputs, and `.btn` submit/resend controls.

Documented in `docs/ui-ux.md`'s "Design system (2026-09 redesign)" section under a new "Account & affiliate pages, redesigned (issue #168)" heading (+ Indonesian mirror).

### Storefront redesign — commerce pages (home, catalog, product, cart, checkout, tracking, wishlist)

Wave 2 of the 2026-09 redesign (issue #167), built on the foundation issue #166 landed (`.btn`, `.pill`, `.band-inverse`, `.stepper`, `.radio-card`, `.segmented`, `.field-label`/`.is-mono`, the token scales). Markup/CSS only — every client contract (`toko-klien`, `keranjang-kontrak`, `wishlist-kontrak`, the checkout quote/order flow) is unchanged.

- **Home**: the CMS slider now renders on the inverse band as a hero card (badge, heading, copy, primary + secondary CTAs); the flash-sale strip is an amber soft band; product cards carry a price/was/discount row and a "Grosir mulai …" tier line when the product actually has a level-2 price.
- **Product card** (`ProductCard.astro`, used by home/catalog/category/related-products): a grouped badges row, price/was/discount, tier line, and a 44px wishlist heart hit area.
- **Catalog** (`/produk`, `/kategori/[slug]`): the sidebar filter card and category-tree rows are restyled (a decorative marker box beside each — still real `<a>` navigation, the documented fallback for "no multi-select client contract to add"), sort/price/stock controls use the new form primitives.
- **Product detail**: badges, price-tier table in an info-toned `.tier-box`, a `[data-wishlist]` button beside "Tambah ke Keranjang" (wired for free by the site-wide `wishlist-tombol.ts`), a notes list, description before the restyled size-chart table, and `.btn`-toned share actions. No fabricated reviews list is rendered — awcms's contract has no `GET …/storefront/reviews` (only anonymous `POST` submission), so the existing rating-average + sold-count line is the only real review data available.
- **Cart**: line cards are restyled with a `.stepper` −/n/+ control (still calling the same `updateCartLineQuantity`) and a real line-total column (`quoteLine.lineTotal`, never computed client-side), a two-column layout with the summary sticky on desktop, and a proper `.empty-state`.
- **Checkout**: a decorative (non-interactive) step-pill row kept in sync by the existing `showStep()`, `.is-mono` phone/postcode fields, and shipping/payment options restyled as `.radio-card`-style rows — all over the unchanged quote/step logic.
- **Tracking**: mono inputs, a status pill toned by the real order status, and a "Bayar sekarang" band shown exactly when the existing gateway-pending condition is true.
- **Wishlist**: an info band, and a "Ke keranjang" link beside remove — a real navigation to the product page (a `WishlistItem` snapshot carries no `minPurchase`/`maxQuantity`/`sku`, so there is no honest quantity to add directly).

Documented in `docs/ui-ux.md`'s "Design system (2026-09 redesign)" section (+ Indonesian mirror).

### Storefront redesign foundation — self-hosted type system, tokens, primitives, site chrome

Wave 1 of the 2026-09 redesign (issue #166): everything issues #167/#168/#169 (product, cart/checkout, and account/news-chrome screens) build on, landed on its own so those issues never touch `apps/storefront/src/styles/global.css`'s top-of-file structure or the font vendoring again.

- **Self-hosted type system.** `apps/storefront/public/fonts/` vendors latin-subset `woff2` builds (SIL OFL) of Plus Jakarta Sans (400/500/600/700/800), Lora (400/500/600 + 400 italic), and IBM Plex Mono (400/500) — `@font-face` with `font-display: swap`, `--font-sans`/`--font-serif`/`--font-mono` tokens, and `BaseLayout.astro` preload hints for the three faces above the fold. No Google Fonts, no new CSP origin — every font stays same-origin (`font-src 'self'` unchanged).
- **New design tokens** in `global.css`: an inverse-band surface, soft status colour pairs, a named link colour, a radius scale, and a type scale — each with a `prefers-color-scheme: dark` counterpart. Brand colour is still read from `/theme-tokens.css`, never hard-coded.
- **New, additive CSS primitives**: `.btn`, `.pill`, `.band-inverse`, `.field-label`/`.is-mono`, token-driven 42px form controls, `.stepper`, `.radio-card`, `.segmented`, `.section-title` — every pre-existing class (`.card`, `.cart-count`, `.stock-badge`, …) is unchanged.
- **Site chrome**: a dark utility bar (Lacak pesanan / Berita / Akun saya), a brand-tile wordmark, and a footer "Kanal" column, all profile-gated through `apps/storefront/src/config/profil.ts` exactly like every existing chrome link.

Documented in `docs/ui-ux.md`'s new "Design system (2026-09 redesign)" section (+ Indonesian mirror), with matching updates to `docs/aksesibilitas.md`/`docs/responsif.md` and `apps/storefront/README.md`.

### Storefront redesign — news chrome, news home and article

Wave 2 of the 2026-09 redesign (issue #169), building on issue #166's foundation (`docs/ui-ux.md`'s "Design system (2026-09 redesign)" section) — markup/CSS restyling only, no data or behaviour change beyond what is called out below.

- **News chrome**: the date bar (`BilahUtilitas.astro`) is now `--news-bar-bg` (a new, news-only dark token) with a mono date, a static "· WIB" suffix, and — only when the `toko` group is also active — "Ke toko" and "Akun" (reusing `Header.astro`'s own `[data-akun-tautan]` account-link contract). The masthead (`NavBerita.astro`) is set in `--font-serif` with a mono kicker from `identity.description` when the CMS has one. The primary nav's active item gets a 2px `--news-accent` underline (a new, news-only red token — never the CMS-driven brand colour). The "Terkini" ticker (`Ticker.astro`) is now a light band with the label as a red pill carrying a reduced-motion-safe pulsing dot, and each headline truncates to one line.
- **News home** (`HalamanDepanBerita.astro`): a "Headline" tag and Lora typography on the hero block; Lora titles and a sky rubric eyebrow on the 6-card grid (`berita.css`, safe because that file loads only on the news layout). The sidebar's tested Terbaru/Mitra Borneo tabs are kept as-is (see `Sidebar.astro`'s own docblock for why); the always-visible "Terpopuler" section gets a mono, zero-padded 2-digit index. The newsletter card moves onto `.band-inverse`, wrapping the same double opt-in form.
- **Article** (`ArtikelView.astro`): Lora 32px title, a new lede paragraph from `post.excerpt` (no new fetch — the field already existed), decorative byline avatar initials, mono byline dates, `--font-serif` 16px/1.85 body, and a restyled pull-quote (3px `--color-primary` rule, italic, on a subtle background). The "Dengarkan berita ini" player gets a real 4px visual progress bar, wired from the same unit-index numbers `dengar.ts` already tracked. The share row keeps its 44px touch target (this repo's own accessibility floor) and only changes shape from a circle to a rounded square.
- **Deliberately not done**: the mockup's "Produk terkait dari toko" sidebar box — nothing in this app today correlates an article with a set of products, and this issue's own rules forbid adding a new build-time fetch to invent one.

Documented in `docs/ui-ux.md`'s "News chrome, news home and article (issue #169)" subsection (+ Indonesian mirror).

### apps/cms synced to ahliweb/awcms 8c64528d — the admin chrome restyle

Issue #170's upstream half landed as awcms PR #813 and is pulled in here with a
`git subtree pull` merged by merge commit (AGENTS.md, "The subtree embed"). The
admin gains the 2026-09-21 redesign's chrome without any local patch to
upstream files: a dark sidebar rail on a new `--color-sidebar-*` token family
(the mockup's faint text corrected to clear WCAG AA), a brand tile + tenant line,
count-badge and status-card slots, and shared primitives every screen can use —
`.admin-stat-card`, `.admin-status-pill[data-tone]`, `.admin-segmented`,
`.admin-bulk-bar`, `.admin-two-pane`, `.admin-toggle`, `.admin-timeline`,
`.admin-media-grid`. Issue #171 re-composes this repo's own commerce screens on
them.

- Conflicts resolved by keeping both sides: `requiredFeature` (#118) and
  upstream's new `badgeCount` on sidebar entries; `client-asset-budget.ts`'s
  app budget is this repo's 246,500 plus upstream's +8,000 chrome delta.
- AGENTS.md's "Known local divergences" list now records the three
  divergences this sync surfaced (AdminLayout/sidebar model, admin-screens.css,
  the asset budget) beside the original version-check patch.

### Commerce admin screens re-composed on the new admin primitives (issue #171)

Every `apps/cms` commerce admin screen is now built on the shared primitives issue #170's admin-chrome subtree sync (upstream awcms#813) added to `admin.css` — `.admin-stat-card`, `.admin-status-pill`, `.admin-segmented`, `.admin-bulk-bar`, `.admin-two-pane`, `.admin-toggle`, `.admin-timeline` — rather than page-specific markup, so the twelve commerce screens read as one coherent surface with the rest of the redesigned admin chrome. Real data only throughout: a screen omits a stat it cannot honestly compute (the dashboard's missing conversion-rate stat, for lack of a funnel/visit projection) rather than inventing one.

- **New `/admin/commerce-dashboard`**: stat cards (orders/revenue today, low-stock count), a 14-day revenue trend from the existing sales-report projections, a "needs attention" list (orders awaiting confirmation, reviews awaiting moderation, unread inbox threads, pending affiliate commissions — each permission-gated), and a recent-orders table. All figures come from the new `fetchDashboardSummary` (`apps/cms/src/modules/commerce/application/admin-dashboard.ts`).
- **New order detail page** (`/admin/commerce-orders/{id}.astro`): lines, totals, an `.admin-timeline` built from `order_events`, and the existing gateway-session/payment-events panel.
- **New shared `CommerceMarketingTabs.astro`** (`apps/cms/src/components/`): one `.admin-segmented` tab strip across flash sales/vouchers/sliders/popup/testimonials, replacing five near-duplicate hand-rolled headers.
- Products, orders list, POS, reports, inbox, affiliates, and settings restyled on the primitives above; POS deliberately keeps its own `.pos-layout` two-pane grid rather than the generic `.admin-two-pane`, since its cart side needs POS-specific controls the generic primitive does not model.
- A new sidebar entry, `admin.layout.nav_commerce_dashboard`, gets its label/icon in `sidebar-menu.ts`'s `SIDEBAR_LABELS`/`DEFAULT_SIDEBAR_ICONS`, plus catalog entries in `locales/en.po`/`locales/id.po` ("Commerce overview" / "Ringkasan komersial").
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised 254,500 → 259,000 B (measured 258,829 B) — markup/CSS reuse of existing primitives, not a new client script.

Documented in `docs/cms.md` (+ Indonesian mirror, the admin-screens table and a new re-composition section) and `docs/ui-ux.md` (+ mirror, a new "Admin (2026-09 redesign, issue #171)" section); `.claude/skills/awcms-one-commerce/SKILL.md` (+ mirror) gets an "Admin screen composition" note naming the primitives.

## [0.9.0] — 2026-09-21

### Merge commit is now the only merge method — subtree-sync protection is mechanical, not procedural

Issue #149 closed the gap this repo's own governance had named since ADR-0001: nothing in
GitHub's settings stopped a `git subtree pull` PR from being squashed or rebased, which would
destroy the merge base the next upstream sync needs — invisibly, until that next sync fails far
from the commit that broke it. The fix is a repository setting, not code: `allow_merge_commit=true`,
`allow_squash_merge=false`, `allow_rebase_merge=false` (applied separately, verified via
`gh api repos/ahliweb/awcms-one`). Required linear history stays disabled, deliberately — it would
conflict with the full-history subtree model this repo depends on.

This change updates every place that documented the old gap as procedural-only ("a rule to
remember, not one CI enforces") so it instead states the current, mechanically-enforced reality,
and records the operational consequence for ordinary PRs: a merge commit is now the only method
GitHub's merge button offers, repository-wide, not only for subtree syncs.

- `AGENTS.md`/`AGENTS.id.md` — "The one rule that protects every future sync" now describes the
  enforced state instead of "nothing mechanically stops this today".
- `GOVERNANCE.md`/`GOVERNANCE.id.md` — the decision-flow diagram and "Changes that may not be made
  alone" no longer describe a merge-strategy fork that no longer exists.
- `CONTRIBUTING.md`/`CONTRIBUTING.id.md`, `SECURITY.md`/`SECURITY.id.md` — the subtree merge-commit
  rule now notes it is mechanically enforced.
- `docs/alur-kerja-pengembangan.md`/`.id.md` — "Branch protection on `main`" and "Not enforced
  today" updated; the merge-strategy item is removed from what is not enforced.
- `docs/adr/0001-git-subtree-with-full-history-for-apps-cms.md`/`.id.md` — a dated status-update
  note is appended after the original decision text, which is left untouched as history.
- `knowledge/curated/ownership-boundaries.md` — notes the rule is now also a mechanical property
  of the repository, not only a documented one.

No `apps/cms/**` files were changed. This is a docs/governance-only change; the repository
settings themselves were applied out of band by a maintainer.

### A real production deployment path, and a fail-closed preflight

Issue #150 closed the gap between "a broad, tested feature set" and "a
reproducible way to run it in production": `docs/deployment.md` used to state
plainly that no production PostgreSQL deployment exists and that
`compose.yaml` is a local/CI convenience only. That is no longer the whole
story.

- **`compose.production.yaml`** — `postgres` (no host port published by
  default), a one-shot `migrate` service (the only one using the privileged
  owner/setup DSN), `cms` (the `awcms_app` runtime role), `jobs` (the
  `awcms_worker` role, gated behind a profile, invoked on a schedule rather
  than left running), and `storefront` (built with a BuildKit secret — see
  below). `tests/compose-produksi.test.mjs` mechanically checks the file for
  a hardcoded-looking secret, the role split, and the absent host ports.
- **`apps/storefront/Dockerfile`** — a new multi-stage build. `AWCMS_API_TOKEN`
  reaches the build ONLY through a BuildKit `--mount=type=secret`, never an
  ARG/ENV, so it can never enter an image layer.
- **`apps/cms/scripts/commerce-deploy-preflight.ts`** (`bun run
  commerce:deploy:preflight`, additive commerce-module tooling) and
  **`tools/deploy-preflight.mjs`** (`bun run deploy:preflight`, root) —
  fail-closed checks: the runtime DB role is never the owner/superuser
  (`--live` verifies this for real against a database), customer OTP
  delivery is production-capable, payment/shipping/WhatsApp adapters cannot
  silently stay on `log` in production, canonical URLs are valid https, the
  storefront build's `AWCMS_API_TOKEN` is never `PUBLIC_`-prefixed and no
  `PUBLIC_*` variable looks like a credential.
- **`ops/run-job-compose.sh`** — a drop-in replacement for
  `apps/cms/ops/run-job.sh` that runs a scheduled job through
  `compose.production.yaml` instead of a bare `docker run`, reusing the SAME
  crontab `bun run jobs:crontab:generate` already generates from the module
  registry — no hand-copied cron list.
- **[ADR-0019](docs/adr/0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md)**
  records the topology decisions; `docs/deployment.md`'s "Production
  topology" section is the operator-facing runbook.

Not built by this change: a CI pipeline that publishes `apps/storefront`'s
per-profile images to a registry, a reverse-proxy/TLS config beyond an
example, backup encryption (tracked upstream), and a Xendit/courier-tracking
adapter (both already-named ADR-0017 follow-ups).

### Security policy reconciled with the implemented customer and provider surfaces

`SECURITY.md`/`SECURITY.id.md` still said, under "What is NOT yet true," that
customer accounts do not exist and that there is no session/login attack
surface — stale since increment 4 (epic #32, ADR-0016) shipped OTP-verified
customer accounts and bearer sessions, and increment 5 (epic #33, ADR-0017)
added the Midtrans/WhatsApp/RajaOngkir provider ports. A stale security
policy is worse than a missing one: it tells a reviewer a surface does not
exist when it does.

- `SECURITY.md`/`SECURITY.id.md` now describe five surfaces, not three: the
  authenticated customer bearer-session surface (`Authorization: Bearer`,
  `awcms_commerce_customer_sessions`, `localStorage`-only, the XSS-not-CSRF
  residual risk, OTP rate limits and attempt caps) and the provider/webhook
  surfaces (Midtrans Snap's token-addressed webhook intake, the amount
  guard, the reconcile job, the WhatsApp OTP outbox, RajaOngkir rate
  caching, consent-gated campaigns) join the existing `apps/cms` and
  anonymous-commerce surfaces. "What is NOT yet true" now states plainly
  that customer accounts/sessions exist, and only what ADR-0016 D6 actually
  deferred (identifier change, phone verification) and the ADR-0017
  follow-ups (Xendit, courier tracking) remain undone.
- `CONTRIBUTING.md`/`CONTRIBUTING.id.md` no longer claim `apps/storefront`
  does not exist, and the changeset-backlog bound they quoted is corrected
  from 10 to the current 20 (`packages/gerbang/audit-rilis.mjs`).
- `SUPPORT.md`/`SUPPORT.id.md`'s "no live deployment" note now points at
  `docs/deployment.md` instead of a stale "increment 1" parenthetical.
- `apps/storefront/README.md` no longer claims the affiliate dashboard card
  still 404s — it has linked to a real page since issue #93 (S3).
- Added `tests/status-prosa.test.mjs`, a regression guard asserting the
  retired "customer accounts do not exist" phrasing never returns to either
  language of `SECURITY.md`, and that the bearer-session table/scheme and
  the webhook route family stay named concretely.

### `template-init-smoke` no longer runs the full root suite three times at once

Issue #147: two consecutive `main` runs each failed a *different* matrix
leg's final `Root bun test` step on a *different* storefront build-smoke
test's stub-start deadline — three copies of the full suite (each of which
starts its own stub CMS and runs its own `astro build`) competing for the
same two-core runner's CPU/IO, not a real profile-specific defect.

- The `toko`/`berita`/`landing` matrix legs still run the real
  `template:init` for their profile, start the stub CMS with an explicit
  PID and a deterministic `if: always()` teardown that surfaces
  `/tmp/stub-awcms.log` on failure, and build under `SITE_PROFILE`. They
  now assert the build's output with `apps/storefront/scripts/
  assert-profil-dist.ts` — a deterministic, non-rebuilding check derived
  from `apps/storefront/src/config/profil.ts` — instead of re-running a full `bun test`.
- A new `root-suite` job, with no matrix, runs `template:init --profil
  toko` and the full `bun test` exactly once, on its own runner.
- `apps/storefront/tests/profil-uji-bersama.ts` now exports `GROUP_FILES`/
  `GROUP_SITEMAP_PATHS` so `apps/storefront/tests/profil-build-smoke.test.ts` and the new
  assertion script share one definition of "this group's files" rather
  than two that could drift apart.
- No timeout was raised to mask the contention; the workflow is still not
  a required status check — promotion still waits for a run of consecutive
  green `main` runs (docs/alur-kerja-pengembangan.md).

#### A second, independent contention source, found while validating this fix

After the job-split above landed, the REQUIRED `Check (toko)` job (a
different workflow, `ci.yml`) still hit the same failure *shape* on two
more PRs (runs `35594952727`/`35595042601`): `"stub-awcms did not answer
http://localhost:<port>/... in time"` inside `build-smoke.test.ts` and the
institution-emblem test, on two more random ports. Diagnosis: every
`*-build-smoke.test.ts` picked `stubPort = <base> + Math.random() * 4000`
— landing inside Linux's own ephemeral range (32768–60999) that a
*concurrent* `astro build`'s own outbound client sockets already use, so a
"free" port could already be bound by a different test's build a moment
earlier. The stub was spawned with `stdout: "pipe", stderr: "pipe"` that
nobody ever read, so a resulting `EADDRINUSE` bind failure (and the
process exiting immediately) was silently buffered — the calling test's
own polling `waitForStub` helper then read identically whether the stub
was slow or already dead, failing only after its own deadline elapsed.

Fixed with a new shared helper, `apps/storefront/tests/stub-lifecycle.ts`'s
`startStub()`: it starts the stub with `STUB_PORT=0` (a real, OS-assigned
free port — no collision possible), resolves readiness from the stub's own
`"serving fixtures on ..."` stdout line (an event, not a poll), and races
that against the process's own exit so a stub that fails to start rejects
immediately with its captured output. Every build-smoke test (and
`apps/storefront/tests/profil-uji-bersama.ts`'s `buildProfile()`) now uses
this one helper instead of its own copy of the random-port-plus-poll
pattern; `apps/storefront/tests/stub-lifecycle.ts`'s own docblock has the
full account. No test's assertions changed. `docs/pengujian.md`/`.id.md`
now describe this lifecycle in place of the old shared-deadline-only
description.

#### A third, root-cause finding: `TEMPLATE_INIT_TEST_SCOPE=root` never scoped anything

`main` itself went red after PR #160 merged (run `35594610231`,
`template:init`'s own full-run-in-a-temp-copy test): "killed 1 dangling
process / bun test tests (root gate tests only) failed (exit signal
SIGTERM)", right after the nested run started
`apps/storefront/tests/profil-build-smoke.test.ts`. Reproduced directly: a
bare positional argument to `bun test` is a path **filter** (a substring
match against every test file's path), not a directory restriction —
`bun test tests` matches `apps/storefront/tests/*.test.ts` too, because
that path also contains the substring `tests`. `TEMPLATE_INIT_TEST_SCOPE=
root`'s `bun test tests` therefore silently re-ran the WHOLE workspace
suite (every storefront build-smoke test and its own stub-CMS
`astro build`) inside whatever budget the outer caller sized for "root
gate tests only" — exactly the double-build contention this option exists
to remove, decided by a race rather than prevented by the scope.

`tools/template-init/gates.mjs` now invokes `bun test ./tests/` (a leading
`./` is resolved as a real directory, never as a filter) via a new,
separately-exported `testScopeArgs(scope)`, so the exact argv can be
asserted directly rather than trusted from a docblock —
`tests/gerbang-test-scope.test.mjs` is the permanent regression test: a
temp directory with a root `tests/` file and a nested `apps/x/tests/`
file, proving `testScopeArgs("root")` runs exactly the root one (and, for
contrast, that the OLD `["test", "tests"]` argv runs both). `docs/
template.md`/`.id.md` now explain the filter-vs-directory distinction
where `TEMPLATE_INIT_TEST_SCOPE` is documented.

## [0.8.0] — 2026-09-20

### ADR-0018 + profile matrix + template contract (wave 0 of epic #135)

Increment 6 turns awcms-one into a **template** other applications can start from, while it
keeps running as the BjekMart reference deployment. Wave 0 (issue #136) settles the eight
architectural decisions (D1–D8) the whole increment codes against, before any code changes,
exactly as ADR-0016 and ADR-0017 did for their own increments.

- [ADR-0018](docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md)
  records the template shape (this repository stays the template, no fork, no second repo),
  build profiles (`SITE_PROFILE ∈ {toko, berita, landing}`), the page-group mechanism
  (`src/profil/<group>/pages/**` injected by an Astro integration — runtime 404 guards and
  one-app-per-profile are both rejected), the brand surface `template:init` rewrites, the
  `template:init` CLI's own idempotency/dry-run/exit-code contract, neutral per-profile sample
  seeds (with BjekMart's own content kept as the labelled reference example), a 3-leg CI
  matrix, and this increment's own v0.8.0 release / derived-repo-starts-at-0.1.0 versioning
  rule.
- The **profile matrix** assigns every one of the 52 files under `apps/storefront/src/pages/**`
  to `shared`/`toko`/`berita`, including three edge cases decided from reading the code rather
  than the issue text: `mitra/[slug].astro` is a news-institution directory (`berita`, not
  `toko` — it uses `BeritaLayout` and is registered as a `berita-mitra` sitemap source), the
  root `feed.xml.ts` is the PRODUCT feed (`toko`, not the news feed — `berita/feed.xml.ts` is
  that), and `index/wilayah-*.json` is the checkout address cascade (`toko`, despite the
  "wilayah" name overlapping with `berita`'s own regional sections).
- [`docs/template.md`](docs/template.md) walks through starting from the template
  ("Use this template" → `template:init` → `.env` → `db:up`/`db:migrate:cms`/`db:seed:cms
  --profil` → `bun run dev` → deploy), the `template:init` CLI flag table, the same profile
  matrix, the seeds section, and BjekMart as the reference example. Linked from
  [`docs/README.md`](docs/README.md) and root `README.md`, with a new "Use this as
  template" section pointing at both documents.
- `packages/gerbang/audit-dokumen.mjs`'s `EXCLUDED_PATHS` gains entries for the not-yet-built
  paths this wave-0 contract names ahead of #137/#138/#139 (`apps/storefront/src/config/profil.ts`,
  `apps/storefront/integrations/profil.mjs`, `tests/template-init.test.mjs`,
  `tools/seed-cms.ts`), plus ADR-0018's own two rejected-alternative paths under a hypothetical
  examples workspace (a shape this ADR turned down, never built), each citing the issue or ADR
  section that names it.

No code changes — this is the contract #137 (storefront profiles + CI matrix), #138
(`template:init`), and #139 (profile seeds) build against in parallel next.

### Neutral sample seeds per profile; BjekMart's seed becomes the labelled reference example

ADR-0018 D6, issue #139. `tools/seed-cms.ts` replaces `tools/seed-borneojek-mart.ts` as the
seeder every profile shares — `--profil toko|berita|landing|contoh:borneojek-mart`, `--dry-run`,
idempotent upsert-by-slug, a printed inventory summary — so a repository derived from this
template (`template:init`, #138) has real, honest, fast-to-seed sample content the moment it
first runs `bun run dev`, without inheriting BjekMart's own five-increment-deep production
content as its default.

- `tools/seed-data/*.json` moved, unchanged in shape, to
  `tools/seed-data/contoh/borneojek-mart/**` — the reference example. `bun run db:seed:cms`
  with no flag still targets it by default, so the live reference deployment's own workflow is
  unchanged; `tools/seed-borneojek-mart.ts` is now a one-release deprecation shim that prints a
  notice and delegates to `tools/seed-cms.ts --profil contoh:borneojek-mart`.
- Three new neutral, fictional seed sets under `tools/seed-data/profil/{toko,berita,landing}/*`
  — invented names ("Toko Nusantara", "Kabar Kita", "PT Contoh Karya"), placeholder contacts on
  `example.com`/`example.id` and `+62 800 0000 0000`-style numbers, no real people, brands, or
  places tied to BjekMart/seputarborneo. `toko` ships 6 categories/12 products/marketing/4
  pages/terms; `berita` ships 5 rubrics/10 news posts/3 informational author bylines/4 pages,
  plus the region/institution rows a `/daerah/{slug}` archive needs (resolved generically from
  the seed data itself, not a hardcoded region list); `landing` ships a site profile, 4 pages,
  and contact details. Placeholder images are simple, self-generated SVGs under
  `tools/seed-assets/profil/**`.
- Root `package.json`: `db:seed:cms` now points at `tools/seed-cms.ts` directly (same default
  behaviour); a new `db:seed:cms:profil` script is the ergonomic entry point for a chosen
  profile (`bun run db:seed:cms:profil toko`).
- `tests/seed-profil.test.mjs` (`tools/lib/seed-profil.mjs`'s shared, side-effect-free
  validators): every profile's JSON validates against the shapes `tools/seed-cms.ts`'s own
  `ensure*` functions expect, a no-PII regex sweep over each file's raw text, every asset
  reference resolves, and `--dry-run` exits 0 for all four profiles with no network call at
  all — `--dry-run` is deliberately network-free by design, a stronger guarantee than seeding
  against a fake server would give, and safe to run against a database that already holds real
  content.
- `docs/template.md`'s "Sample seeds" section now describes real, landed mechanism instead of a
  wave-0 target; a new "Seeding a profile locally" section in
  `docs/alur-kerja-pengembangan.md` warns against ever seeding a neutral profile into this
  repository's own shared local dev database (it already holds BjekMart's own tenant, and
  tenant setup is a once-per-database lock).
- `packages/gerbang/audit-dokumen.mjs`'s `EXCLUDED_PATHS` drops its `tools/seed-cms.ts` entry —
  the path this wave-0 contract named ahead of this issue now genuinely exists.

`#137` (storefront profiles + CI matrix) and `#138` (`template:init`) remain outstanding; this
issue's own scope is the seeder and its seed data only.

### Storefront build profiles: `SITE_PROFILE` = `toko` | `berita` | `landing` (issue #137)

`apps/storefront` now builds one of three sites from the same tree, decided at build time by
`SITE_PROFILE` ([ADR-0018](docs/adr/0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md)
D2/D3/D7) — the mechanism that lets this repository be a template a derived deployment can
start from without a second codebase. `toko` (the default when unset) is BjekMart's own
commerce + news site, byte-for-byte what the app built before; `berita` is a news portal only;
`landing` is a company-profile site (home, static pages, contact). An unknown value fails the
build naming the variable.

- **Page groups.** `apps/storefront/src/pages/**` now holds only the `shared` group (ten files
  every profile serves). The other 42 page files moved (`git mv`, history kept) to
  `apps/storefront/src/profil/<group>/pages/**` — 23 under `toko`, 19 under `berita` — with the
  same relative paths, per the profile matrix in `docs/template.md` (including its three
  code-decided edge cases: `mitra/[slug]` is `berita`, the root `feed.xml` is `toko`'s product
  feed, `index/wilayah-*` is `toko`'s checkout address cascade). A new Astro integration,
  `apps/storefront/integrations/profil.mjs`, `injectRoute`s every file of every ACTIVE group in
  `astro:config:setup` with project-root-relative entrypoints; an inactive group is never walked,
  so its pages, data fetches and artifacts never reach `dist/`. `apps/storefront/src/pages/index.astro` stays the
  one `/` route and imports `@profil/beranda`, an alias the integration points at the profile's
  own `src/profil/<profile>/Beranda.astro`.
- **One source of truth.** `apps/storefront/src/config/profil.ts` reads `SITE_PROFILE` and
  derives, from `routes.ts`'s new `ROUTE_GROUPS` annotation (every `ROUTES` key carries its
  group), the nav set, search surface, footer links, sitemap sources, feeds, `robots.txt` rules and
  CSP needs per profile. `Header`/`Footer`/`BaseLayout`, `robots.txt.ts`,
  `sitemap-sources.ts`/`sitemap-katalog.ts`, `csp.json.ts` and the server's rule-based legacy
  news redirects (now applied only when the build has a `berita.html`) all read it; nothing
  hardcodes a group twice. `PRIMARY_NAV`/`FOOTER_PAGE_LINKS` moved from `routes.ts` to
  `profil.ts`; `ROUTES` gains `newsletter`, `newsletterConfirm`, `newsletterUnsubscribe`,
  `orderTracking`.
- **CSP correction to the ADR matrix.** `connect-src` carries `PUBLIC_AWCMS_ORIGIN` on every
  profile (the visitor beacon posts there from every page), not only `toko`; what varies is which
  content the `img-src`/`frame-src` derivation reads.
- **Tests.** `profil-konfig` (pure config), `profil-integrasi` (the integration's pure half; the
  tree must match `docs/template.md`'s matrix row for row), `profil-routes` (no built page links
  outside the active profile, every internal link resolves), `profil-build-smoke` (every profile
  built against the stub CMS: excluded routes absent from `dist/` and `sitemap-*.xml`, robots/
  feeds/CSP per profile). Existing build-smoke tests pin `SITE_PROFILE: "toko"`; the
  no-`prerender = false` and no-`/news/**` guards now walk `src/profil/**` too.
- **CI.** The storefront `Check` job is a 3-leg matrix over `profile: [toko, berita, landing]`
  (`fail-fast: false`, shared install cache): each leg type-checks and builds/smoke-tests its
  profile; the root `bun test` and audits run once on the `toko` leg. `STUB_START_DEADLINE_MS`
  unchanged.
- **Docs.** `docs/routing.md`, `docs/seo.md`, `docs/pengujian.md`, `docs/arsitektur.md` (+ `.id.md`
  mirrors), `apps/storefront/README.md` and `.env.example` describe the profile mechanism, the
  `injectRoute` wiring and the CI matrix; page paths named in docs follow the moved files.

Operators of the BjekMart deployment need to do nothing: with `SITE_PROFILE` unset the build is
unchanged.

### `bun run template:init` — idempotent brand/profile initialisation for derived repos

Issue #138 (ADR-0018 D4/D5): a new root-level script that rewrites this
repository's brand surface (name, domain, colours, contact, `SITE_PROFILE`)
for a repository created from GitHub's own "Use this template" button, so a
derived repo's first commit is already green.

- `tools/template-init.ts` (entry) + `tools/template-init/**` (CLI parsing
  and prompting, targeted text-surgery rewriters, a `plan`/`apply` split so
  `--dry-run` and a real run share one code path, and the trailing gate
  chain: `docs:i18n:stamp`, `bun install`, `audit:dokumen`,
  `audit:translation`, `audit:rilis`, `bun test`).
- Idempotent by construction: every rewrite is diffed against the file's
  current content, so a second run with identical flags touches nothing
  (exit `0`, "nothing to do"); a run with different flags rewrites only what
  changed. `CHANGELOG.md`/`.changesets/*.md`/`package.json`'s version reset
  happen exactly once, gated on the new `package.json#awcmsOne.templateVersion`
  field. Refuses a dirty working tree, and refuses to run against the
  template itself (`package.json.name === "awcms-one"`), without `--yes`.
- Removes BjekMart-only artefacts — `tools/seed-borneojek-mart.ts` (issue
  #139's own deprecation shim) and `tools/seed-data/contoh/borneojek-mart/**`
  (its reference-example layout, checking the pre-#139 flat layout too,
  defensively), `tools/import-seputarborneo.ts` and its test — and resets
  `graphify-out/`/`knowledge/generated/` to absent, which
  `packages/gerbang/audit-graf.mjs` already treats as a valid, gate-passing
  state. Rewrites `tools/seed-cms.ts`'s `--profil` default and
  `package.json`'s `db:seed:cms` script from BjekMart's reference example
  to the deployment's own chosen profile. `tests/seed-profil.test.mjs`
  (#139) is kept, not removed — it validates the neutral profile seeds a
  derived repo keeps; its own `contoh:borneojek-mart`/deprecation-shim
  coverage now guards itself with an existence check and skips once
  `template:init` has removed what it describes.
- New CI workflow `.github/workflows/template-init-smoke.yml`, matrixed over
  `toko`/`berita`/`landing`, not yet a required status check.
- Two corrections to `docs/template.md`'s wave-0 draft, made in this same
  change: `SECURITY.md` carries no rewritable contact line as the tree
  actually stands, and `SITE_NAME`/`SITE_URL`/`SITE_DESCRIPTION`/
  `SITE_PROFILE` live in `apps/storefront/.env.example`, not the root one.

## [0.7.0] — 2026-09-20

### ADR-0017 + OpenAPI contract for external providers — payment gateway, courier rates, WhatsApp, POS, reports, inbox, campaigns

Epic #33 (external providers) needed its ten architectural decisions settled and its
API contract argued through review **before** any handler exists, so C1–C9 (issues
#107–#118) code against a contract already reviewed and settled instead of
re-deciding it issue by issue.

- [ADR-0017](docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)
  records the integration pattern (a port + adapters inside `commerce`, modelled on
  `email`, env-per-deployment credentials), inbound webhooks (token-addressed,
  `SECURITY DEFINER`-resolved, replay-protected), the payment gateway (a
  `PaymentGatewayProvider` port, Midtrans Snap first, redirect-based storefront
  flow), courier rates (a `ShippingRateProvider` port, RajaOngkir, a 6-hour cached
  rate), WhatsApp (an outbox, Fonnte + Meta Cloud API adapters, a third
  `CustomerOtpChannel` adapter), POS, reports, an inbox, campaigns, and the
  module-settings feature flags plus tiered pricing at quote.
- `apps/cms/openapi/modules/commerce.openapi.yaml` gains the payment-gateway
  session endpoint and public webhook intake, courier/gateway fields on the
  existing cart-quote/order/store-settings paths, a WhatsApp `via` option on OTP
  request, POS order creation, three `reporting`-hosted sales projections, a
  customer inbox (bearer + owner sides), and campaign CRUD/preview/send/cancel.
  Every new path is listed by name in `ROUTE_PARITY_EXEMPTIONS`
  (`apps/cms/scripts/api-spec-check.ts`), each entry citing the child issue that
  removes it, and exactly two new operations (the webhook intake and the
  payment-gateway session endpoint) join `ALLOWED_PUBLIC_OPERATIONS`.
- `docs/api.md` documents the new "External providers — planned — #107–#118"
  table and updates the "Not built" line to say the contract now exists
  (ADR-0017, issue #106) even though no handler does yet; the commerce module's
  README gains a matching "contract only" section.

### Commerce inbox — customer/store conversations, bearer + owner endpoints, admin screen

`commerce` gains a support inbox (Issue #111, contract #106 D8): `awcms_commerce_conversations`/`awcms_commerce_messages` (`sql/927`, FORCE RLS, one thread per verified customer account), and a `commerce.conversations.read|update` permission pair (`sql/928`).

Storefront (bearer, `Authorization: Bearer <customer session>`): `GET/POST /api/v1/commerce/storefront/account/conversations` (list, newest-activity-first, keyset-paginated; open a thread with its first message — subject 1-150 chars, body 1-4000 chars), `GET .../conversations/{id}` (thread + messages, marks it read for the customer), `POST .../conversations/{id}/messages` (post a reply; `409 CONVERSATION_CLOSED` once the thread is closed — a customer never reopens their own thread). Customer posts are rate-limited 10/hour per ACCOUNT (`COMMERCE_CONVERSATION_POST_RATE_LIMIT_MAX`), on top of the existing per-IP limiter every storefront route already applies.

Owner API: `GET /api/v1/commerce/conversations` (staff list, filterable by `status`/`unread`), `GET .../conversations/{id}` (marks it read for the store), `PATCH .../conversations/{id}` (explicit close/reopen), `POST .../conversations/{id}/messages` (staff reply — implicitly reopens a closed thread; requires `Idempotency-Key`). A store reply enqueues one `derived.commerce_conversation_reply` e-mail through the existing `email` module outbox in the SAME transaction as the reply insert, auto-seeding its default template on first miss (the same pattern `customer-otp-channel-adapters.ts` already established for OTP e-mail).

`unread_for_store`/`unread_for_customer` are independent flags on the conversation row, kept in step with every message insert; the storefront's own `Percakapan.unreadForCustomer` contract field travels as `0|1`.

New admin screen `/admin/commerce-inbox`: conversation list with status/unread filters and an unread badge, a thread view, a reply form (`Idempotency-Key` header), and close/reopen actions.

- Both new tables are `unreachableBySubject: true` in `subjectData` — the owning customer account carries no tenant_user/identity/profile/principal id (ADR-0016 D1), the same shape `commerce.customer_addresses`/`commerce.wishlists` already document; an account holder reaches their own threads through the bearer routes above, outside this automated engine's scope.
- New env var: `COMMERCE_CONVERSATION_POST_RATE_LIMIT_MAX` (default 10).
- `APP_BUDGET_BYTES` (`apps/cms/scripts/client-asset-budget.ts`) raised 231,000 -> 231,500 for this screen's own measured cost (624 B client script, built on the shared `onSubmit`/`onAction`/`mutateAndReload` helpers — no per-screen duplication).

### Payment gateway — schema, Midtrans Snap adapter, session endpoint, webhook endpoint tokens (C3)

Issue #110 (part of epic #33, C3; contract #106's D2/D3, ADR-0017). The second
external-provider integration under `commerce`, following the same
`rajaongkir-provider.ts` shape #107 established: a port + adapters, credentials
env-only per deployment, `withTimeout` + `getProviderCircuitBreaker`, provider calls
never inside a DB transaction (ADR-0006/0010).

**Schema** (`apps/cms/sql/926_awcms_commerce_payment_gateway_schema.sql`):
`awcms_commerce_payment_gateway_sessions` (one row per hosted-checkout attempt,
`UNIQUE (provider, provider_ref)`), `awcms_commerce_payment_events` (the D2
replay-protection ledger, `UNIQUE (tenant_id, provider, event_key)` — no writer yet,
the webhook INTAKE route is #113's own scope), `awcms_commerce_webhook_endpoints`
(a hashed opaque token per (tenant, provider)); `orders` gains `gateway_provider`/
`gateway_ref`. All three new tables `FORCE RLS`, indexed for the generic
purge/batching path, `awcms_worker`-granted. A `SECURITY DEFINER`
`awcms_resolve_commerce_webhook_endpoint(token_hash)` mirrors
`awcms_resolve_tenant_domain_lookup`'s bootstrap pattern exactly (dedicated NOLOGIN
owner role, a scoped read policy, EXECUTE restricted to `awcms_app`) — the bootstrap
lookup the webhook INTAKE route will use, before any tenant context exists.

**Domain**: `payment-gateway-provider.ts` (the `PaymentGatewayProvider` port —
`createSession`/`fetchStatus`/`verifyWebhook`), `midtrans-signature.ts`
(`sha512(order_id + status_code + gross_amount + ServerKey)`, timing-safe compare),
`gateway-status-mapping.ts` (Midtrans `transaction_status`/`fraud_status` →
`paid|pending|expired|failed|refunded`), `payment.gateway = {enabled}` added to
`store-settings-validation.ts`.

**Application** (`payment-gateway-directory.ts`): `createGatewaySession(sql,
tenantId, orderCode, auth, provider, providerKey)` — validate the order (gateway
method, `pending_payment`) and check for a still-live session in one short
transaction, call the provider with NONE open, persist in a second short
transaction; a genuinely concurrent double-create is caught by the `(provider,
provider_ref)` UNIQUE constraint and re-fetches the winner rather than 500ing.
Auth is `{phone}` or a customer bearer, matching `POST .../orders`'s own optional-
bearer pattern; a wrong phone, unknown order, or a live bearer for a different
order's owner all answer the SAME neutral 404 the order-tracking route uses.
Adapters `infrastructure/midtrans-provider.ts` (Snap `POST /snap/v1/transactions`,
`GET /v2/{orderId}/status`, sandbox/production base URLs by
`COMMERCE_MIDTRANS_IS_PRODUCTION`, both env-overridable) and
`log-payment-gateway-provider.ts` (no network call; `redirectUrl` is
`${COMMERCE_STOREFRONT_PUBLIC_URL}/pesanan?kode=...&gateway=log`; `fetchStatus`
answers `paid` once 60 real seconds have elapsed since creation, via an injectable
clock and a timestamp folded into `providerRef` — deterministic, no sleeping in
tests), resolved by `COMMERCE_PAYMENT_GATEWAY=midtrans|log` (`log` refused outside
non-production).

**Quote/order**: `POST .../cart/quote`'s `paymentMethods[]` gains `{method:
"gateway", available}` — `true` only when `payment.gateway.enabled` AND a
`PaymentGatewayProvider` is configured; `POST .../orders`'s `payment.method:
"gateway"` was already accepted by the orders schema and validator (additive,
already-shipped columns/checks), unchanged here.

**Routes**: `POST .../storefront/orders/{orderCode}/payment-gateway/sessions`
(anonymous, rate-limited, `409 PAYMENT_NOT_APPLICABLE` for a non-gateway/non-payable
order, `503 GATEWAY_UNAVAILABLE` when no provider is configured); owner
`GET|POST /api/v1/commerce/webhook-endpoints` (masked list; the raw token is
returned exactly once at creation, hashed at rest — deliberately NOT
idempotency-keyed, the same reasoning `machine-credential-directory.ts`'s issuance
route already gives) and `DELETE .../webhook-endpoints/{id}` (revoke, idempotent);
both gated on the new `commerce.webhook_endpoints.update` permission.

**Store settings / admin**: owner `PUT /store-settings` gains `payment.gateway`;
the public `payment.gatewayEnabled` is derived the same way `shipping.courierEnabled`
already is. `/admin/commerce-settings` gains a gateway-enable toggle and a
webhook-endpoints panel (list/create/revoke, built entirely from the shared
`onSubmit`/`onAction`/`mutateAndReload` admin-form-client helpers
`machine-credentials.astro` already established — no new lifecycle code).
`APP_BUDGET_BYTES` raised from 231,500 to 232,000 B for this genuinely new control
— reasoning recorded in that file's own docblock.

**Tests**: unit (Midtrans signature, status mapping, both adapters against a local
fake HTTP server / an injected clock, a static-text contract test on the migration's
SQL for the SECURITY DEFINER function) and integration against a real migrated
database (session creation idempotent with the `log` provider, phone- and
bearer-based auth, the neutral-404 mismatch cases, the 409 non-applicable case, the
webhook-endpoint token round-trip through the SECURITY DEFINER lookup with a revoked
token no longer resolving, RLS isolation for both new resource kinds) —
`apps/cms/tests/integration/commerce-payment-gateway.integration.test.ts`.

OpenAPI: the three DRAFT paths from #106 (`.../payment-gateway/sessions`,
`.../webhook-endpoints`, `.../webhook-endpoints/{id}`) are now backed by real
handlers and removed from `ROUTE_PARITY_EXEMPTIONS`; `CommerceWebhookEndpoint`
gains `label`/`revokedAt`; the revoke response is `200 {endpoint}` (not `204`) to
match this module's own DELETE convention; bundled.

Out of scope, explicitly: the webhook INTAKE route itself
(`POST /api/v1/commerce/webhooks/midtrans/{token}`), `markOrderPaidBySystem`, and
the `commerce:payments:reconcile` job — all #113.

### POS — cash counter sales, `orders.channel`, `commerce.pos.create`, POS screen + history

Issue #116 (epic #33 C7, contract #106 D6, ADR-0017). BjekMart's kasir as
one more order-creation path over the SAME order tables, quote engine and
status graph — never a second sales ledger. With it the last path #106
merged ahead of its handler has one, and `ROUTE_PARITY_EXEMPTIONS` is
empty again as `AGENTS.md` requires before the epic closes.

- `apps/cms/sql/931_awcms_commerce_pos_schema.sql`: `awcms_commerce_orders`
  gains `channel text NOT NULL DEFAULT 'storefront' CHECK IN
  ('storefront','pos')` (every pre-existing order is `storefront` by the
  default) and `pos_cashier_tenant_user_id uuid` (a plain stamp, not a
  foreign key — a fiscal record outlives a staff account); the
  `payment_method` CHECK is dropped and re-created with `cash`; indexes
  `(tenant_id, channel, created_at DESC)` and a partial cashier index.
  `sql/932` seeds the one new permission, `commerce.pos.create`.
- `PaymentMethod` gains `"cash"` — re-exported unchanged by
  `packages/kontrak`'s `pesanan.ts`, so `apps/storefront` sees the widened
  union at compile time (additive; the storefront's own checkout validator
  still refuses `cash`, and even a body that reached the application layer
  finds no available `cash` method). New `domain/pos-order-validation.ts`:
  lines/customer/payment shape, `amountTendered` REQUIRED for cash as a
  `numeric(14,2)` STRING, `computeChange` in `bigint` cents (ADR-0003).
- `application/pos-directory.ts`: `createPosOrder` — customer first (no
  phone → the tenant's single walk-in row under the documented sentinel
  `+620000000000`; a phone → find-or-create by normalised number, and that
  customer's `level` prices the sale), then the SAME `buildCartQuote` the
  storefront uses, insert `channel='pos'` + cashier stamp, decrement stock,
  audit `commerce.pos.sale`, and `pending_payment → paid` in the same
  transaction (actor `admin`) through the shared status transition, so
  #117's sales projections pick the sale up like any paid order.
  `Idempotency-Key` header required; the hash binds the acting cashier.
  `listPosOrders`: keyset history, `channel='pos'`, date/cashier filters.
- Owner routes `GET|POST /api/v1/commerce/pos/orders` (`commerce.orders.read`
  / `commerce.pos.create`), both `409 FEATURE_DISABLED` when the tenant's
  `pos` feature (#118) is off; `409 CART_CHANGED` / `INSUFFICIENT_TENDER` /
  `IDEMPOTENCY_CONFLICT` on the write.
- The storefront never serves a POS order: the anonymous tracking lookup and
  the bearer account history filter `channel = 'storefront'` (the sentinel
  phone is documented, so honouring it on tracking would expose every
  walk-in receipt by order code), and the storefront checkout refuses the
  sentinel phone as a customer identity.
- Admin screen `/admin/commerce-pos` (entry any-of `commerce.pos.create` /
  `commerce.orders.read`, nav entry `requiredFeature: pos`): product search
  + cart island, optional customer quick-fields, cash (tendered + live
  change) / QRIS, submit with `Idempotency-Key`, printable receipt
  (`@media print`), history tab with filters and keyset paging. Every
  client string is `t()`-rendered into `data-*` attributes; catalog data
  reaches the DOM through `textContent` only. English + Indonesian
  catalogue entries added.
- `apps/cms/scripts/client-asset-budget.ts` `APP_BUDGET_BYTES` 237,800 → 246,500:
  measured 246,276 B, +8,718 B = exactly this screen's own script (5,854 B)
  and scoped stylesheet (2,864 B) — the one admin screen that IS a client
  island by design.
- `commerce.orders`'s `subjectData` descriptor gains the cashier stamp as a
  `tenant_user` subject column; erasure stays `retain_under_obligation`.
- Tests: `apps/cms/tests/commerce-pos-domain.test.ts` (validation, string change
  arithmetic incl. the IEEE-754 failure cases, storefront refuses cash),
  `apps/cms/tests/integration/commerce-pos.integration.test.ts` (real Postgres: paid
  immediately + stock decremented + events/audit, history vs. storefront
  exclusion, walk-in reuse + level pricing, idempotent replay/conflict,
  short tender writes nothing, `409 FEATURE_DISABLED`), and the POS block
  of `apps/cms/tests/admin-commerce-page-contract.test.ts`.
- Docs: `docs/cms.md` (POS workflow + receipt), `docs/skema-basis-data.md`,
  `docs/kamus-data.md` (`channel`, `cash`, the walk-in sentinel),
  `docs/api.md`, the commerce module README, and their Indonesian mirrors.

### RajaOngkir courier rates — provider port, cached rates, destination in quote, courier settings (C1)

Issue #107 (part of epic #33, C1; contract #106's D4). The first external-provider
integration under `commerce` (ADR-0006/0010's "external providers are commerce-owned
ports with env credentials, never called from inside a DB transaction").

**Schema** (`apps/cms/sql/924_awcms_commerce_shipping_rates_schema.sql`):
`awcms_commerce_courier_destinations` (a tenant's `idn_admin_regions` district code
resolved once to a provider's own destination id, no TTL) and
`awcms_commerce_shipping_rates` (a rate cache keyed by `(tenant, provider, origin,
destination, weight bucket, courier, service)`, TTL 6 hours). Both `FORCE RLS`,
indexed for the generic purge/batching path, `awcms_worker`-granted.

**Domain**: `shipping-rate-provider.ts` (the `ShippingRateProvider` port + `Rate`
type), `courier-service-id.ts` (`"jne:REG"` parse/format), `weight-bucket.ts`
(rounds up to the next 100 g, floored at 1000 g — RajaOngkir's own minimum billable
weight), `shipping.courier = {enabled, originDestinationId, couriers[]}` added to
`store-settings-validation.ts`.

**Application** (`shipping-rate-directory.ts`): `resolveDestination` (cache → name
search against `idn_admin_regions` → provider search → store) and `getCourierRates`
(cache read in a short transaction, provider call with NONE open, write-back in a
second short transaction — a concurrent miss just means the last writer wins under
the cache's own `UNIQUE` key). Adapters `infrastructure/rajaongkir-provider.ts`
(Komerce API v2: `GET /destination/domestic-destination`, `POST
/calculate/domestic-cost`, `withTimeout` + `getProviderCircuitBreaker
("commerce-rajaongkir")`) and `log-shipping-rate-provider.ts` (deterministic
fixtures), resolved by `COMMERCE_SHIPPING_RATE_PROVIDER=rajaongkir|log` (+
`COMMERCE_RAJAONGKIR_API_KEY`, `_BASE_URL`, `_TIMEOUT_MS`).

**Quote/order**: `POST .../cart/quote` accepts an optional `destination:
{districtCode}`; when `shipping.courier.enabled` AND a provider is configured AND a
destination is present, `shippingOptions[]`'s courier entries are live per-service
rates (`{method:"courier", serviceId:"jne:REG", name, cost, etd, available:true}`);
otherwise a single `available:false` placeholder with a `note`. `POST
.../orders`'s `shipping: {method:"courier", serviceId}` is validated against a
non-expired cached rate keyed off the delivery address's own `districtCode` — never
a second live provider call inside `createOrderFromCart`'s write transaction; a
stale/unknown selection answers the same `409 CART_CHANGED` (with a fresh quote)
every other price/stock/shipping mismatch does.

**Job**: `commerce:shipping-rates:purge` (hourly) deletes every expired
`awcms_commerce_shipping_rates` row, across tenants, bounded per tick.

**Store settings / admin**: owner `PUT /store-settings` gains `shipping.courier`;
`GET /api/v1/commerce/shipping/destinations?search=` (owner-only,
`settings.update`) backs the origin-destination picker; the public
`shipping.courierEnabled` is now derived — `true` only when `courier.enabled` AND a
provider is configured, never a raw copy of the stored flag.

**Tests**: unit (weight bucket, service-id parse/format, `buildShippingOptions`'s
courier branch, both adapters against a mocked `fetch`/fixtures) and integration
against a real migrated database (destination cache miss/hit, rate cache
hit/miss with the `log` provider, a quote with a destination, order-creation
validation against the cache) — `tests/integration/commerce-shipping-rates.
integration.test.ts`.

OpenAPI: `destination`/`shippingOptions` added to the quote request/result schemas,
new `GET /api/v1/commerce/shipping/destinations` path, bundled.

**Admin screen**: `/admin/commerce-settings` gains a courier section — an enabled
toggle, a debounced origin-destination search (against the new endpoint above,
rendered through a native `<datalist>` rather than custom list markup/JS) that
doubles as the id field, and a couriers multi-select (`jne`/`jnt`/`sicepat`/`pos`/
`tiki`/`anteraja`); it writes through the existing `PUT /store-settings`, i18n
`en`+`id`. `APP_BUDGET_BYTES` (`apps/cms/scripts/client-asset-budget.ts`) raised
from 231,000 to 231,500 B to fit the new (non-duplicative) control — reasoning
recorded in that file's own docblock.

### Sales reports — three commerce reporting projections over order events + reports screen (C8)

Issue #117 (part of epic #33, C8; contract #106's D7, ADR-0017). `commerce`
contributes three `cursor_table` projections to the `reporting` module's generic
projection engine (Issue #753) from its own `module.ts` (`reportingProjections`):
`commerce.sales_daily`, `commerce.sales_by_product`, `commerce.sales_by_category`,
all over the append-only `awcms_commerce_order_events` log. The engine keeps its
cursor, freshness, rebuild, reconciliation and export machinery; `commerce`
supplies the descriptor, the pure delta rules and the sinks.

**Why a projection and not a live `GROUP BY`.** A sales report that re-aggregates
every order on each page view costs what the order table costs; a projection costs
one bounded pass per worker tick and answers from a table the size of the calendar.
The event log is the right source because it is the ONE append-only record of
"this order became paid / stopped being paid", which is exactly the property the
`cursor_table` strategy needs to be correct.

**Delta rules** (`domain/sales-report-deltas.ts`, pure): `-> paid` from a
not-yet-paid state adds the order's totals (gross = subtotal, discount = order +
voucher discount, shipping, net = total) and its lines per product and per
category; `-> cancelled|refunded` from a paid state subtracts them; every other
transition is a no-op — including a cancellation of a never-paid order and a refund
after a cancellation, so an order is never subtracted twice. Everything is
attributed to the day of the order's `paid_at` in `Asia/Jakarta`, so a reversal
lands on the same day row as its payment and `net` is a true per-day net.

**Schema** (`apps/cms/sql/933_awcms_commerce_reporting_projections_schema.sql`):
`awcms_commerce_sales_daily` (day, orders_paid, gross, discount, shipping, net),
`awcms_commerce_sales_by_product` (day, product_id, name snapshot, qty, gross),
`awcms_commerce_sales_by_category` (day, category_id, name, qty, gross) — all
`FORCE RLS`, upserted with additive deltas by primary key; `awcms_worker` gets
`SELECT, INSERT, UPDATE, DELETE` (mirrored in `WORKER_ROLE_GRANTS`); retention
answered by three `dataLifecycle` descriptors (cursor `day`, the same 3650-day
ceiling as `commerce.order_events`), subject data by `NO_SUBJECT_DATA` (derived,
rebuildable aggregates about nobody).

**One additive engine extension** — `MODULE_CONTRACT_VERSION` 4.1.0 → 4.2.0:
`ProjectionCursorStream.dimensional` (`selectColumns` + `applyBatch`, called by the
incremental worker AND the rebuild pass on every fetched batch, inside the same
bounded transaction, before the cursor advance) and
`ProjectionDescriptor.dimensional` (`resetForTenant` in the rebuild reset's own
transaction; `readProjectionTotals`/`computeSourceTotals` merged into
reconciliation; `exportRows` so exports carry the rows, not a metric snapshot).
`reporting:projections:registry:check` refuses a sink without the contract and vice
versa. No existing descriptor changes.

**Read routes** (`reporting.dashboard.read`, `defineTenantRoute`, `reporting` work
class): `GET /api/v1/reports/commerce/sales-daily?from&to`,
`sales-by-product?from&to&limit`, `sales-by-category?from&to` — owned by `commerce`
via `api.routes: ["/api/v1/reports/commerce"]`, documented in
`openapi/modules/commerce.openapi.yaml`, and their three `ROUTE_PARITY_EXEMPTIONS`
entries from the #106 contract-only PR are removed.

**Admin screen** `/admin/commerce-reports`: a GET date-range form, the three tables,
projection freshness (`reporting.projections.read`), an **Export CSV** button per
projection that POSTs to the real `/api/v1/reports/exports/trigger`
(`reporting.exports.export`), and the recent export runs with checksum-verified
download links (`reporting.exports.read`). English + Indonesian strings; nav entry
under Commerce.

**Tests**: pure delta rules + registry pairing (`apps/cms/tests/commerce-sales-report-domain.test.ts`);
against a real Postgres under the unprivileged role
(`apps/cms/tests/integration/commerce-sales-reports.integration.test.ts`): paid → rows,
cancel-after-paid → subtracted on the same day, rebuild byte-equal to live,
reconcile with no mismatch (a tampered table IS flagged), tabular export, RLS.

**Known limitation, stated**: order items snapshot the product name but not its
category, so by-category attribution reads the product's category at processing
time; a rebuild after a recategorisation re-attributes past sales. The control
totals are category-agnostic, so this never reads as a reconcile mismatch.

Docs: `docs/cms.md` "Sales reports", `docs/skema-basis-data.md` "Sales-report
projections", the commerce and reporting module READMEs, plus Indonesian mirrors.

### WhatsApp outbox, Fonnte/Meta adapters, OTP via WhatsApp, login by phone

`commerce` gains a second provider outbox modelled on `email` (ADR-0017 D1): `awcms_commerce_whatsapp_messages`/`awcms_commerce_whatsapp_delivery_attempts` (`sql/925`), a claim/send/finalize dispatcher (`bun run commerce:whatsapp:dispatch`) with the same lease/retry/circuit-breaker shape as `email-dispatch.ts`, and a retention purge (`bun run commerce:whatsapp:purge`). Two real adapters — Fonnte (`COMMERCE_WHATSAPP_PROVIDER=fonnte`) and the Meta WhatsApp Cloud API (`meta`) — plus a `log` adapter for dev/CI, resolved by `COMMERCE_WHATSAPP_PROVIDER`/gated by `COMMERCE_WHATSAPP_ENABLED`.

`CustomerOtpChannel` gains a third adapter, `whatsapp`: `POST .../account/otp/request` accepts `via?: "email"|"whatsapp"` (default `email`); `via: "whatsapp"` requires `phone`, only ever supports `purpose: "login"` (registration stays e-mail OTP only), and answers `409 CHANNEL_UNAVAILABLE` — before an OTP is ever issued — when the tenant has no WhatsApp channel configured (configuration, not enumeration). `POST .../account/otp/verify` accepts `phone` as an alternative to `email`; a phone-keyed OTP resolves the account via `findAccountByPhone`. `awcms_commerce_customer_otps` gains a nullable `phone_normalized` column (`email_normalized`'s own `NOT NULL` relaxed to a CHECK that at least one identifier is present).

New owner diagnostics: `GET /api/v1/commerce/whatsapp/messages` (`commerce.whatsapp.read`) plus a minimal `/admin/commerce-whatsapp` screen — masked phone only, never the raw number/rendered body/OTP code.

- `to_phone` is kept in the clear in the outbox (same reasoning `customers.phone` already documents — a provider adapter cannot deliver a message knowing only a hash), alongside `to_phone_hash`/`to_phone_masked`.
- Module-local WhatsApp template registry (`commerce.customer_otp`/`commerce.order_paid`/`commerce.campaign`) — `{{var}}` rendering with a per-template variable allowlist; only `commerce.customer_otp` is wired to a caller in this issue.
- New env vars: `COMMERCE_WHATSAPP_ENABLED`, `COMMERCE_WHATSAPP_PROVIDER`, `COMMERCE_WHATSAPP_SEND_TIMEOUT_MS`, `COMMERCE_WHATSAPP_SEND_MAX_RETRIES`, `COMMERCE_FONNTE_TOKEN`, `COMMERCE_FONNTE_API_BASE_URL`, `COMMERCE_META_WA_TOKEN`, `COMMERCE_META_WA_PHONE_NUMBER_ID`, `COMMERCE_META_WA_OTP_TEMPLATE`, `COMMERCE_META_WA_API_BASE_URL`.

### Customer campaigns: consent, mass e-mail/WhatsApp, dispatcher, admin screen (issue #114, C6 of #33)

`apps/cms` gains a consent-gated mass e-mail/WhatsApp send to a filtered
slice of a tenant's customer accounts, coded against
[issue #106](https://github.com/ahliweb/awcms-one/issues/106)'s
ADR-0017 D9 — reusing the SAME e-mail/WhatsApp outboxes D5/D8 already
dispatch from, no third delivery mechanism.

- `awcms_commerce_customer_accounts.marketing_consent_at` (nullable
  timestamp) — toggled only by the account itself, via `PATCH
  .../account/me {marketingConsent}` (matching the storefront shape
  `apps/storefront` already shipped against this contract). Both a grant
  and a revoke are audited.
- `awcms_commerce_campaigns`/`awcms_commerce_campaign_recipients`
  (`sql/929`, permission seed `sql/930` —
  `commerce.campaigns.{read,update,send}`): CRUD on a `draft`, an
  audience-count-only preview (never a resolved list), `send`/`cancel`
  (`Idempotency-Key` required, gated on the separate `.send` permission).
- `commerce:campaigns:dispatch` (script, `awcms_worker`, every 1-2
  minutes): claims due/resumed campaigns (`FOR UPDATE SKIP LOCKED`) and
  fans each one out in pages of 200 consented, addressable customers,
  inserting one recipient row per customer (resumable — a crash mid-send
  is picked back up from wherever the recipient ledger left off) and
  enqueuing into the e-mail outbox (a pass-through `derived.commerce_campaign`
  template) or the WhatsApp outbox (`commerce.campaign` template). A
  `cancel` between pages stops further dispatch immediately.
- A campaign's own `subject`/`body` may interpolate `{{name}}`/
  `{{storeName}}` only — an unknown placeholder is left as a literal.
- Admin screen `/admin/commerce-campaigns`: list, create-draft form,
  detail/editor panel with an audience-preview button and send/cancel
  actions.
- `ROUTE_PARITY_EXEMPTIONS` (`apps/cms/scripts/api-spec-check.ts`) loses
  its five `commerce/campaigns*` entries; the OpenAPI draft's
  `marketingConsent`/campaign paths are flipped from "not yet
  implemented" to real.

Docs updated: `docs/cms.md`, `docs/api.md`, `docs/skema-basis-data.md`,
`apps/cms/src/modules/commerce/README.md`, all with their Indonesian
mirrors.

### Commerce feature toggles per tenant + tiered pricing at quote for logged-in customers

Issue #118 (epic #33 C9, contract #106 D10, closing ADR-0016 D6's tiered-pricing
follow-up).

- `apps/cms/src/modules/commerce/module.ts` gains `settings: {schemaVersion: 1,
  defaults: {features: {pos, inbox, campaigns, gateway, courier}}}` (every flag
  `true` by default — no behaviour change for a tenant that never opens the new
  "Fitur" section) — `commerce`'s first use of `module_management`'s generic
  tenant-settings service.
- `apps/cms/src/modules/commerce/domain/commerce-features.ts` (new): pure
  `resolveCommerceFeatures`/`assertFeatureEnabled`/`FeatureDisabledError`.
  `apps/cms/src/modules/commerce/application/commerce-feature-gate.ts` (new):
  `fetchCommerceFeatures` + owner (`409 FEATURE_DISABLED`) and public (neutral
  `404`) route-guard helpers. Applied to every owner + storefront route of the
  inbox (conversations), campaigns, gateway (webhook-endpoints; the storefront
  payment-gateway-session route folds a disabled gateway into its existing `503
  GATEWAY_UNAVAILABLE`; the public webhook intake route answers the same neutral
  `404` an unknown token does), and courier (`GET /shipping/destinations`) —
  documented 409-vs-404 rule: `409` on an authenticated owner route, `404`/`503`
  on an anonymous one, never the reverse.
- `ModuleNavigationEntry` gains an optional `requiredFeature`, applied to the
  Inbox/Campaigns admin nav entries; `AdminLayout.astro` hides them per-tenant.
- `GET /api/v1/commerce/store-settings/public` gains `inboxEnabled`,
  `campaignsEnabled`, and `whatsappOtpEnabled` (matching `apps/storefront`'s
  already-expected field names); `gatewayEnabled`/`courierEnabled` now also
  require `features.gateway`/`features.courier`.
- `/admin/commerce-settings` gains a "Fitur" section writing through the generic
  `PATCH /api/v1/tenant/modules/commerce/settings` (`updateModuleSettings`,
  audited), gated on `module_management.settings.update`.
- `domain/cart-quote.ts`'s `quoteCart` accepts an optional `customerLevel`
  (1–4) and prices a line at `price_level_{n}` (falling back to `price`);
  `POST .../storefront/cart/quote` resolves it from an optional Bearer;
  `createOrderFromCart` resolves the same account's level before its own
  re-quote so quote and order always agree. No new column: the level is
  snapshotted only implicitly, via `order_items.unit_price`.
- Docs: `docs/cms.md`/`.id.md`, `docs/api.md`/`.id.md`, ADR-0016 status note,
  `apps/cms/src/modules/commerce/README.md`/`.id.md`.

### Payment gateway webhook intake, system-actor `paid`, and reconcile job (issue #113, C5 of #33)

Closes the payment-gateway loop issue #110 opened: `apps/cms` can now
actually learn that a hosted-checkout order was paid, from either an
inbound Midtrans callback or a scheduled poll, and applies it the same
way regardless of source.

- `POST /api/v1/commerce/webhooks/{provider}/{endpointToken}` — public,
  `POST`-only, tenant resolved from an opaque per-tenant token via the
  `SECURITY DEFINER` `awcms_resolve_commerce_webhook_endpoint` (`sql/926`).
  Unknown/revoked token, a provider mismatch, or no provider configured
  all answer the same padded-latency neutral `404`; a bad signature
  (`provider.verifyWebhook`) is `401`; a replayed event (`INSERT …
  ON CONFLICT DO NOTHING` on `awcms_commerce_payment_events` hitting zero
  rows) is a `200` no-op. The route never calls the provider's own
  `fetchStatus` — it only ever acts on what `verifyWebhook` already
  produced.
- `markOrderPaidBySystem` (`order-directory.ts`) — the new `system` actor
  edge `pending_payment -> paid`, alongside the existing `-> expired`.
  Idempotent (already-`paid`, or any status other than `pending_payment`,
  is a no-op). `paid -> refunded` is **deliberately never auto-applied** —
  there is no `refunded` order status at all; a gateway-reported refund is
  recorded as a payment event only, and an owner refunds manually via the
  existing admin `-> cancelled` action (see `order-status.ts`'s header and
  `docs/cms.md`'s payment-gateway runbook for the full reasoning).
- Amount guard (defense in depth): a verified event whose `gross_amount`
  differs from the order total is recorded as `outcome = 'amount_mismatch'`
  (`sql/934` widens the CHECK) with an audit entry, never marks the order
  paid, and still answers `200`; the reconcile job applies the same guard.
- `commerce:payments:reconcile` job (every 1-2 minutes) — polls every
  gateway session still `pending` more than 2 minutes old via
  `provider.fetchStatus`, called with no database transaction open
  (timeout + circuit breaker live inside the adapter itself), and applies
  the same transition path the webhook uses; expires any session past its
  own `expires_at` regardless of what `fetchStatus` answers.
- Admin: the order list screen (`/admin/commerce-orders`) gains a
  per-row, read-only gateway session/payment-events panel and a "Cek
  status" button (`commerce.orders.update`, `Idempotency-Key` required)
  that triggers a scoped single-order reconcile
  (`POST /api/v1/commerce/orders/{id}/payment-gateway/reconcile`) rather
  than the full batch job.
- `ROUTE_PARITY_EXEMPTIONS` (`apps/cms/scripts/api-spec-check.ts`) drops
  the webhook path now that it has a handler; the OpenAPI doc gains the
  request body schema and the new reconcile-one-order path.

Documented in `docs/cms.md` (operator runbook: minting an endpoint,
pointing Midtrans's dashboard at it, the `COMMERCE_MIDTRANS_*`/
`COMMERCE_WEBHOOK_RATE_LIMIT_*` env vars, how the reconcile job works),
`docs/deployment.md`, `docs/api.md`, and the commerce module README (all
with their Indonesian mirrors).

### Build-smoke tests wait 20 s, not 5 s, for the stub CMS to boot

Sixteen storefront build-smoke tests each spawn `apps/storefront/scripts/stub-awcms.mjs` and waited a hard-coded five seconds for its first answer. The stub now loads a dozen fixtures and state machines and the root `bun test` runs those builds concurrently, so a cold start on a two-core CI runner regularly crossed the line and a green change failed CI on a timing accident — four reruns in two days.

- One shared constant, `apps/storefront/tests/stub-deadline.ts` (`STUB_START_DEADLINE_MS = 20_000`), replaces every literal; a stub that truly cannot start still fails inside the test's own budget.

### Payment gateway checkout — "Bayar sekarang" + polling (issue #112, S2 of #33)

Checkout gains a fourth, redirect-based payment method — "Bayar online
(kartu, VA, e-wallet)" — and `/pesanan`/`/akun/pesanan` gain a live-polled
"Bayar sekarang" retry path. Coded against the contract
[issue #106](https://github.com/ahliweb/awcms-one/issues/106) (D3) names, so
wiring `apps/cms`'s own Midtrans Snap adapter in later needs no storefront
change.

- Checkout lists `Bayar online (kartu, VA, e-wallet)` whenever the quote's
  `paymentMethods[]` includes `gateway`. Placing the order is unchanged; a
  separate `createGatewaySession` call then sends the whole tab to the
  session's `redirectUrl` (`window.location.assign`, never an embed) —
  validated as `https:` (or `http:` only when this build's own
  `PUBLIC_AWCMS_ORIGIN` is itself `http:`, i.e. the local/CI stub). Any
  failure falls through to `/pesanan?kode=` instead, never a checkout error.
- `/pesanan` and `/akun/pesanan`'s detail view render a "Bayar sekarang"
  button in place of manual-transfer instructions for a `gateway` order
  still `pending_payment`, with an `aria-live="polite"` status line
  ("Menunggu konfirmasi pembayaran…" → "Pembayaran diterima.") and a 5-second
  poller (`apps/storefront/src/lib/pesanan-poll.ts`) that stops once the
  order leaves `pending_payment`, once its `expiresAt` passes, after 15
  minutes, or pauses (never stops) while the tab is hidden.
- `toko-klien.ts` gains `createGatewaySession`, `PaymentMethodAvailability`/
  `OrderPaymentInput` gain `"gateway"`, and `Order` gains an optional
  `gateway?: {provider, status}`.
- `apps/storefront/scripts/stub-awcms.mjs` lists `gateway` when
  `payment.gatewayEnabled` is on, mints an idempotent-per-order session
  pointing at its own hosted `GET /stub/gateway/{id}` page ("Bayar
  (simulasi)"/"Batal"), and redirects back to `/pesanan?kode=…` either way.

A pure `nextPollDecision` scheduler (`apps/storefront/src/lib/pesanan-poll.ts`)
and `isValidGatewayRedirectUrl` (`apps/storefront/src/lib/gateway-redirect.ts`)
are both unit-tested with no DOM/timer at all;
`apps/storefront/tests/e2e/checkout.e2e.ts` gains a full gateway scenario
against the stub's own hosted page.

### Checkout prices real courier rates per destination (issue #109, S1 of #33)

The checkout shipping step's courier row stops being a permanent "segera"
placeholder. Coded against the contract [issue #106](https://github.com/ahliweb/awcms-one/issues/106)
(D4) names, so wiring `apps/cms`'s own RajaOngkir adapter in later needs no
storefront change.

- `cart/quote` sends `destination: {districtCode}` as soon as the address
  step's kecamatan `<select>` has a value, and re-quotes on every district
  change (including a saved-address autofill). Courier options render one
  radio per real, priced service (name, ETD, price) — or the same single
  disabled placeholder as before, now carrying a visible `note` explaining
  which of three reasons applies (courier off, no destination yet, the
  provider could not price this destination).
- An `aria-live="polite"` status line announces "Menghitung ongkir…" while a
  quote is in flight and a short failure message otherwise; every disabled
  row keeps a real `<label>` and its note as visible help text
  (`aria-describedby`), not a tooltip.
- `apps/storefront/scripts/stub-awcms.mjs` prices real JNE/J&T/SiCepat
  services from a new fixture (`shipping-rates.json`, three district codes ×
  three couriers × two services, per-kilogram pricing) and re-validates the
  chosen courier service against a fresh quote at order time, answering
  `409 CART_CHANGED` on any mismatch — the same treatment a stock/price
  change already gets.
- A pure `describeShippingOption`/`isShippingOptionSelected` module
  (`apps/storefront/src/lib/kurir-opsi.ts`) now owns the option → label
  decision, unit-tested with no DOM.

- No client-side arithmetic was added — every price shown still comes from
  the quote, formatted only through the existing `formatPrice`.

### WhatsApp OTP, marketing consent, and `/akun/pesan` (issue #115, S3 of #33)

Sign-in gains a second OTP channel, `/akun` gains a promo-consent toggle,
and signed-in shoppers gain a message inbox with the store. Coded against
the contract [issue #106](https://github.com/ahliweb/awcms-one/issues/106)
(D5/D8/D9) names, so wiring `apps/cms`'s own WhatsApp adapter and inbox
storage in later needs no storefront change.

- `/masuk` renders a "Kirim kode lewat: E-mail | WhatsApp" channel choice
  only when the public store settings' new `whatsappOtpEnabled` is `true`
  at build time; choosing WhatsApp swaps the identifier field to a phone
  input (`type="tel"`, `autocomplete="tel"`, an Indonesian-format hint) and
  both request/verify send `phone`. `409 CHANNEL_UNAVAILABLE` is a plain
  message, not a dead end. `/daftar` stays e-mail-only, with a one-line note
  saying so — registration is never offered a channel choice.
- `/akun` gains a "Preferensi Promo" card: a real `<input type="checkbox">`
  in its own `<label>`, saving on `change` (`PATCH …/account/me
  {marketingConsent}`), confirmed through an `aria-live="polite"` region,
  reverting its own checked state on failure with no reload.
- `/akun/pesan` (new page + script) mirrors `/akun/pesanan`'s own
  list/`?id=`-detail split: a keyset-paginated conversation list with an
  `aria-label`'d unread badge, a "Pesan baru" form, a thread view with a
  reply form shown only while the thread is open (a closed thread shows a
  note instead). `ROUTES.accountMessages`/`accountMessage(id)` and a new
  dashboard nav card round this out.
- `akun-klien.ts` gains `via`/`phone` on the OTP request/verify functions,
  a `{name?, marketingConsent?}` `ubahProfil` input, and
  `ambilPercakapan`/`buatPercakapan`/`ambilPercakapanById`/
  `kirimPesanPercakapan` — every one bearer-only through the same
  `denganPembersihanSesi` wrapper every other account call already uses.
  `akun-kontrak.ts`'s `Akun` gains `marketingConsent: boolean` (defaults to
  `false` for a session stored before this field existed).
- `apps/storefront/scripts/stub-awcms.mjs` implements the whole surface:
  WhatsApp OTP for the fixture phone `+6281234567890` (code `123456`,
  `409 CHANNEL_UNAVAILABLE` when `whatsappOtpEnabled` is off),
  `marketingConsent` on every account, and a conversations state machine
  seeded with one open thread (an unread store reply already on it) and one
  closed thread — every new customer message schedules a simulated store
  auto-reply 2 seconds later, so unread flags are exercised without a
  manual second message.

`apps/storefront/tests/pesan-build-smoke.test.ts` (new file) proves the
real build; `akun-klien.test.ts`/`akun-kontrak.test.ts` gain unit coverage
for every new request shape and the `marketingConsent` default.

## [0.6.0] — 2026-09-19

### ADR-0016 + OpenAPI contract for customer accounts, OTP, bearer sessions, affiliates

Epic #32 (customer accounts) needed its four architectural decisions settled and its
API contract argued through review **before** any handler exists, so C2–C4 (issues
#87–#93) code against a contract already reviewed and settled instead of re-deciding
it wave by wave.

- [ADR-0016](docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)
  records identity (a `commerce` row, never `awcms_principals`), the OTP channel
  (e-mail now, WhatsApp deferred to #33), the bearer session transport (opaque
  token, `localStorage`, 30-day sliding TTL), the guest-row registration binding
  rule, the affiliate program's fresh design, and what stays explicitly out of scope.
- `apps/cms/openapi/modules/commerce.openapi.yaml` gains the full
  `/api/v1/commerce/storefront/account/*` surface plus the staff-side
  `/api/v1/commerce/affiliates*` routes, a new `customerBearer` security scheme kept
  deliberately separate from the staff `bearerAuth`/session schemes, and an optional
  bearer + `affiliateCode` on the existing anonymous order/review endpoints.
  Every new path is listed by name in `ROUTE_PARITY_EXEMPTIONS`
  (`apps/cms/scripts/api-spec-check.ts`) because no route file exists yet — each
  entry is removed the moment its own handler lands.
- `docs/api.md` documents the new "Customer accounts — planned — #87–#93" table and
  updates the "Not built" line to say the contract now exists (ADR-0016, issue #86)
  even though no handler does yet.

### Customer account auth endpoints — OTP request/verify, me, logout (C2)

Issue #89 (part of #32; contract #86/ADR-0016): the storefront's first four
`/api/v1/commerce/storefront/account/*` routes actually run. Built on #87's
schema/domain/store.

- `POST otp/request` — validates `{email, purpose, name?, phone?}` (register
  runs the full registration validator before an e-mail ever goes out), then
  always issues a code and always asks a new `CustomerOtpChannel` port to
  deliver it, answering `202 {sent:true, expiresInSeconds}` for every outcome
  (ADR-0016 D2's anti-enumeration rule); rate-limited 10/IP/h + 5/e-mail/h,
  env-tunable (`COMMERCE_ACCOUNT_OTP_RATE_LIMIT_*`).
- `POST otp/verify` — collapses every OTP failure reason into one
  `401 OTP_INVALID`; `purpose: "login"` with no account answers
  `404 ACCOUNT_NOT_FOUND`; `purpose: "register"` checks the phone against
  every existing account before binding (D4), answering
  `409 PHONE_ALREADY_REGISTERED` on conflict; a blocked account cannot
  verify into a session (`403 ACCOUNT_BLOCKED`). Success mints an opaque
  `cs_…` bearer session (D3) and answers `200 {token, expiresAt, account}`.
  Rate-limited 20/IP/h.
- `GET`/`PATCH me`, `POST logout` — bearer-secured via a new
  `application/customer-session-auth.ts` guard; a blocked account can still
  log out.
- `CustomerOtpChannel` (`domain/customer-otp-channel.ts`): an `email`
  adapter enqueues into `email`'s outbox, inside the same transaction as the
  OTP row, under a new derived category `derived.commerce_customer_otp`
  (`sql/919` seeds an EN+ID template per existing tenant); a `log` adapter
  (selected when `EMAIL_PROVIDER=log`/`EMAIL_ENABLED` isn't `"true"`) keeps
  dev/CI working without mail credentials. `commerce` gains a dependency on
  `email` for this.
- Commerce CORS preflight (`domain/commerce-cors.ts`) now accepts an
  `allowedHeaders` list, so the bearer routes' `OPTIONS` grants
  `authorization` alongside `content-type` — still no
  `Access-Control-Allow-Credentials` anywhere in the family.
- Audit events (masked e-mail/phone, never a code/token):
  `commerce.customer.otp_requested`, `otp_verified`, `login_failed`,
  `account_registered`, `logout`.
- The four implemented paths are removed from `ROUTE_PARITY_EXEMPTIONS`
  (`apps/cms/scripts/api-spec-check.ts`); OpenAPI/docs regenerated.
- Fixes a latent bug in #87's `consumeOtp`: the `registration` jsonb column
  round-tripped through `Bun.SQL`'s `UPDATE … RETURNING` as a raw JSON
  string rather than a parsed object, which #87's own tests never exercised
  far enough to notice — caught by this issue's integration suite.

### Customer account resource endpoints — addresses, wishlist, orders, reviews (C3)

Issue #91 (part of epic #32, C3; contract #86/ADR-0016). Built on #87's schema and
#89's bearer sessions, the storefront's account holders can now manage their own
data through eight `/api/v1/commerce/storefront/account/*` routes, all
`requireCustomerSession`-secured:

- `addresses` (`GET`/`POST`), `addresses/{id}` (`PATCH`/`DELETE`),
  `addresses/{id}/default` (`POST`) — max 10 live addresses, the first ever saved
  becomes the default automatically, and exactly one default per customer is now a
  DATABASE invariant (`apps/cms/sql/920_awcms_commerce_customer_addresses_default_index.sql`'s
  partial unique index), not merely an application one.
- `wishlist` (`GET`/`PUT`), `wishlist/{productId}` (`DELETE`) — `PUT` union-merges
  up to 200 product ids and returns the merged list; an id that is not a live
  product in the caller's own tenant is silently skipped, never a 400.
- `orders` (`GET`, keyset) and `orders/{orderCode}` (`GET`) — bounded to
  `created_at >= account.historyFrom` (ADR-0016 D4) and, for the detail route,
  ownership, both enforced INSIDE the query.
- `reviews` (`GET`) — the account's own submitted reviews.

The two existing anonymous routes, `POST .../storefront/orders` and
`POST .../storefront/reviews`, now accept an OPTIONAL bearer: present and valid,
the order/review is attributed to that account's own customer row instead of the
guest phone lookup; present but invalid/expired, `401 UNAUTHENTICATED` explicitly;
absent, unchanged. `POST .../orders` also accepts `affiliateCode` in the body —
shape-validated only in this issue, ignored until #92 wires attribution.

Removed from `ROUTE_PARITY_EXEMPTIONS` (`apps/cms/scripts/api-spec-check.ts`)
accordingly; only the C4 affiliate paths remain contract-only.

### Affiliate program — schema, commissions on completed orders, storefront + owner API, admin screen (C4)

Issue #92 (part of epic #32, C4; contract #86's D5). Built on #87–#91's customer
accounts, a customer can now enrol as an affiliate, refer other shoppers with an
`?ref=` code, and earn a commission staff can approve/pay/void.

**Schema** (`apps/cms/sql/921_awcms_commerce_affiliates_schema.sql`,
`922_awcms_commerce_affiliates_permissions.sql`,
`923_awcms_commerce_affiliates_worker_lifecycle_purge_grants.sql`):
`awcms_commerce_affiliates` (one row per
enrolled customer — an 8-char unambiguous-alphabet `code` unique per tenant, a
`commission_rate` snapshot copied from the store's own rate at enrolment time,
`status` `active`/`suspended`) and `awcms_commerce_affiliate_commissions` (one row
per order that ever earned a commission — `order_id` unique per tenant forever,
`base_amount`/`rate`/`amount` snapshots, `status` `pending → approved/void →
paid`). Plus `awcms_commerce_orders.affiliate_id` and
`awcms_commerce_store_settings.affiliate_commission_rate` (a real column, `null` =
program off). Permissions `commerce.affiliates.{read,update}`,
`commerce.affiliate_commissions.{read,update}` (`sql/922`); worker purge grants
(`sql/923`).

**Storefront** (bearer-secured, `requireCustomerSession`): `GET`/`POST
account/affiliate` (`POST` is idempotent — a second call returns the same row;
`409 AFFILIATE_PROGRAM_DISABLED` when the tenant's rate is unset) and `GET
account/affiliate/commissions` (keyset). `POST .../storefront/orders`'s
`affiliateCode` (shape-validated since #91) is now resolved against
`awcms_commerce_affiliates.code` — an unknown or suspended code links nothing and
never fails the checkout; a valid, active code sets `orders.affiliate_id`.

**Commission lifecycle**: the ONE place a commission is created is
`order-directory.ts`'s status-transition function, on the transition to
`completed` — `base = subtotal − discount − voucher_discount` (floored at zero),
`amount = round(base × rate / 100, 2)`, both via the module's existing
integer-cent string-decimal arithmetic (ADR-0003). No commission on self-referral,
and none if the affiliate has been suspended since the order was placed
(`shouldEarnCommission` re-checks both at completion time, independently of the
order-creation-time check).

**Owner API**, gated on the new permissions: `GET`/`PATCH
commerce/affiliates(/{id})` (list, edit status/rate), `GET
commerce/affiliate-commissions?status=` (list), `POST
commerce/affiliate-commissions/{id}/{approve,pay,void}` (state machine
`pending → approved → paid`, `pending|approved → void`, each transition requiring
an `Idempotency-Key`). `GET /commerce/store-settings/public` now exposes
`affiliateProgramEnabled: boolean` only — never the rate; the owner
`GET`/`PUT /commerce/store-settings` carry `affiliateCommissionRate` (0–100, two
decimals, nullable).

**Admin screen**: `/admin/commerce-affiliates.astro` — affiliates table
(code/customer/rate/status, suspend/activate/edit-rate) and a commissions table
(filterable by status, approve/pay/void), i18n `en`+`id`;
`/admin/commerce-settings.astro` gains the commission-rate field.

Removed from `ROUTE_PARITY_EXEMPTIONS` (`apps/cms/scripts/api-spec-check.ts`),
which is now empty — every path #86 documented ahead of its handler has one.

### Customer account, OTP and session schema (C1)

Issue #87 (part of #32; contract #86/ADR-0016 — this awcms repo's own ADR,
not yet written): the first slice of storefront customer accounts — schema,
domain and application layer only, no HTTP routes yet (those are Issue
#89's).

- `apps/cms/sql/917_awcms_commerce_customer_accounts_schema.sql` and
  `apps/cms/sql/918_awcms_commerce_customer_auth_worker_lifecycle_purge_grants.sql`:
  three new tenant-scoped, FORCE-RLS tables —
  `awcms_commerce_customer_accounts` (1:1 with an existing guest
  `awcms_commerce_customers` row, no password, ever), `awcms_commerce_customer_otps`
  (6-digit e-mail OTP, hashed, 10-minute TTL, 5 attempts) and
  `awcms_commerce_customer_sessions` (opaque `cs_` bearer token, only its
  hash stored, 30-day sliding TTL).
- New pure domain functions (`customer-otp.ts`, `customer-session-token.ts`,
  `customer-account-validation.ts`) and an application store
  (`customer-account-store.ts`) implementing ADR-0016 D4's `history_from`
  rule and a race-free, single-`UPDATE` OTP attempt counter.
- A new scheduled job, `commerce:customer-auth:purge`, deleting expired
  OTPs and expired/long-revoked sessions.
- Why now, separately from the HTTP layer: the schema/domain/store are the
  part every later slice (login, registration, session guard) depends on,
  and landing them first keeps each later PR small and independently
  reviewable.

### `db:commerce:renumber` could not run: the name list was bound as a malformed array

The one-off script from #72 passed a plain JavaScript array into `= ANY(${…})`, which Bun.SQL serialises as a comma-joined string rather than a PostgreSQL array, so the very first query failed with `malformed array literal` on every database. It now binds through `sql.array(names, "text")`, the way `data-lifecycle`'s executor already does.

- Verified against the local development database: `--dry-run` lists sixteen renames, the real run renames them, a second run reports nothing to do, and `db:migrate` then skips all 169 migrations instead of re-applying `901`.

### Affiliate program, from the shopper's side: `?ref=` capture, checkout attribution, `/akun/afiliasi` (issue #93, S3 of #32)

`apps/storefront` gains the shopper-facing half of #86's freshly designed affiliate program (D5) — the CMS/staff side is issue #92, tracked separately.

- `apps/storefront/src/lib/afiliasi-kontrak.ts` is a new pure-plus-storage contract: `validasiKodeAfiliasi` accepts exactly the contract's 8-character unambiguous-base32 code shape (`A`–`Z` without `I`/`O`, digits `2`–`9`), lenient on case; `bacaKodeAfiliasi`/`simpanKodeAfiliasi` read/write `localStorage` key `awcms-one:afiliasi:v1` (`{code, capturedAt}`), with a 30-day TTL an expired read drops and cleans up. Every storage access is guarded — a private window or blocked storage reads as "no referral captured", never throws.
- `apps/storefront/src/scripts/afiliasi-tangkap.ts`, mounted once from `BaseLayout.astro`'s existing script block (every page, not just the home page — a `?ref=` link can land a shopper anywhere), captures a valid `?ref=` on load and removes ONLY that parameter with `history.replaceState`, so canonical URLs stay clean without touching any other query string.
- `checkout.ts` sends `affiliateCode: bacaKodeAfiliasi()?.code ?? null` with every order — `toko-klien.ts`'s `CreateOrderRequest` gains the field additively. The CMS ignores an unknown/suspended code entirely (#86's D5): a bad or expired capture never blocks checkout.
- `apps/storefront/src/lib/awcms/pemasaran.ts`'s `StoreSettings` gains an optional `affiliateProgramEnabled` boolean, read from the public store-settings fetch at build time and defaulting to `false` when an older awcms does not send it — the same additive pattern `payment.proofUpload` already established.
- `/akun/afiliasi` (`afiliasi.astro` + `akun-afiliasi.ts`): when the program is disabled at build time, a short explanation and no controls at all; otherwise guest → link to `/masuk`; signed in with no affiliate row → "Gabung program afiliasi" (handles `409 AFFILIATE_PROGRAM_DISABLED`); enrolled → the referral link in a read-only input with a copy button (the same clipboard-API-plus-silent-fallback shape as `voucher-copy.ts`), commission rate, an Indonesian status label (Aktif/Ditangguhkan), stats formatted with `harga.ts`'s `formatPrice` (never computed client-side), and a keyset-paginated commissions list ("Muat lebih banyak") with per-row status labels (Menunggu/Disetujui/Dibayar/Dibatalkan). `aria-live`, `<noscript>`, a WhatsApp fallback, 44px controls, one `<h1>`, `noindex, follow` (the `/akun` `Disallow` prefix already covers the fetch).
- `apps/storefront/src/lib/akun-klien.ts` gains `ambilAfiliasi`, `gabungAfiliasi`, `ambilKomisiAfiliasi(cursor)` — bearer-only, wrapped in the same session-clearing behaviour every other function in that file already uses.
- `/akun`'s dashboard already links its "Afiliasi" card at `ROUTES.accountAffiliate` (declared since issue #88) — this issue is what makes that link resolve to a real page instead of a 404.
- `apps/storefront/scripts/stub-awcms.mjs` grows per-account `affiliate`/`commissions` state and `GET/POST /account/affiliate` + `GET /account/affiliate/commissions`; the fixture account (`budi@example.test`) is seeded already enrolled with a deterministic code and three commissions, one per status; a freshly registered account starts unenrolled. `POST /orders` records `affiliateCode` on the created order when present. `apps/storefront/tests/fixtures/awcms/store-settings-public.json` sets `affiliateProgramEnabled: true`.

### Customer accounts: addresses, order history, synced wishlist, reviews (issue #90, S2 of #32)

`apps/storefront` gains the rest of the customer-account surface #86 contracted: `/akun/alamat` (addresses), `/akun/pesanan` (order history and an owned-order detail view), `/akun/ulasan` (reviews), and an account-synced wishlist — all static (`output: "static"`, no `prerender = false`), calling `apps/cms`'s bearer-authenticated `/api/v1/commerce/storefront/account/*` routes directly from the browser, continuing S1's pattern (issue #88).

- `apps/storefront/src/lib/akun-klien.ts` gains one function per remaining #86 endpoint: addresses (list/create/update/delete/set-default), the account wishlist (get/union-merge `PUT`/remove), orders (keyset list/detail-by-code), and reviews (list) — every one bearer-only, clearing the local session on `401 UNAUTHENTICATED` like every existing function in that file.
- `apps/storefront/src/lib/wilayah-region-select.ts` is the province/city/district cascading-select wiring extracted out of `checkout.ts`'s original inline code, so `/akun/alamat`'s own form and `checkout.astro`'s new "Pilih alamat tersimpan" saved-address autofill share one region-selection module instead of two drifting copies.
- `apps/storefront/src/lib/pesanan-render.ts` extracts `/pesanan`'s (issue #30) own order-detail rendering out of `pesanan.ts` so `/akun/pesanan?kode=` renders an `Order` identically — `/pesanan`'s own behaviour and tests are unchanged.
- `apps/storefront/src/lib/wishlist-sinkron.ts` is a PURE wishlist-merge function (union by `productId`, earliest `addedAt` wins, capped at 200 items), wired in by `wishlist-akun-sync.ts`: on login the local wishlist is pushed to the account and replaced by the merge of local and server state; while signed in, every heart-button toggle and the `/wishlist` page's own remove action write through to the account; logging out leaves the local copy untouched; a network failure degrades to local-only operation with a shared `aria-live` status region.
- `toko-klien.ts`'s `createOrder` and `submitReview` each gain an OPTIONAL second `bearerToken` argument — every existing anonymous caller is unaffected; `checkout.ts` passes the signed-in shopper's session token so a placed order is bound to their account.
- `apps/storefront/scripts/stub-awcms.mjs` grows per-account addresses/wishlist/orders/reviews storage, seeding the fixture account with two addresses (one default) and two orders — one dated before `historyFrom` to prove the server, not the client, enforces #86's D4 history-window rule.

### Customer accounts: `/masuk`, `/daftar`, `/akun`, and a bearer client (issue #88, S1 of #32)

`apps/storefront` gains its first customer-facing authentication surface — an e-mail OTP sign-in (`/masuk`), registration (`/daftar`), and a signed-in account shell (`/akun`) — all static (`output: "static"`, no `prerender = false`), calling `apps/cms`'s `/api/v1/commerce/storefront/account/*` routes directly from the browser, per issue #86's contract. No password is ever collected, sent, or stored — matching ADR-0007's "the storefront holds no runtime credential" posture and #86's own D1/D2/D3 decisions (bearer session, no link to the staff `awcms_principals` table).

- A new customer-session store (`apps/storefront/src/lib/akun-sesi.ts`, pure logic in `apps/storefront/src/lib/akun-kontrak.ts`) keeps `{token, expiresAt, account}` in `localStorage` (`awcms-one:akun:v1`), expiring itself on read and dispatching `akun:berubah` on every write.
- A new bearer-aware client (`apps/storefront/src/lib/akun-klien.ts`) reuses the request/envelope plumbing extracted from `toko-klien.ts` into `apps/storefront/src/lib/toko-permintaan.ts` — `toko-klien.ts`'s own public API and behaviour are unchanged.
- `Header.astro` gained a `[data-akun-tautan]` link that swaps to the signed-in shopper's name once a session exists (`apps/storefront/src/scripts/akun-header.ts`).
- `apps/storefront/src/config/routes.ts` gained `login`, `register`, `account`, and four more constants (`accountOrders`, `accountOrder`, `accountAddresses`, `accountReviews`, `accountAffiliate`) for pages S2/S3 build later — their links resolve to a 404 until then, by design.
- `robots.txt.ts` disallows `/masuk`, `/daftar`, `/akun` (the bare `/akun` prefix also covers its future children); all three pages carry `<meta name="robots" content="noindex, follow">`.
- `apps/storefront/scripts/stub-awcms.mjs` implements the `/account/*` OTP/session state machine (fixed code `123456`, a seeded `budi@example.test` account) so this app's own build-smoke and future e2e tests exercise the real request/response shapes rather than a hand-rolled fixture.

## [0.5.0] — 2026-09-18

### Commerce migrations renumbered into a reserved `9xx` range

`apps/cms/sql/*.sql` is one flat, lexically-ordered migration sequence owned by upstream `ahliweb/awcms`'s own `db-migrate.ts`. This repo's own `commerce` module originally numbered its sixteen migrations `153`–`168`, inside upstream's own `001`–`899` range — the only range that existed at the time. Upstream has since started adding its own migrations from `153` onward (`sql/153_awcms_blog_institution_logo.sql`, issue #59), and every future upstream `git subtree pull` will keep colliding with this repo's own commerce numbers.

The sixteen commerce migrations are renumbered to `901`–`916` (offset +748: `153`→`901`, … `168`→`916`), a range upstream cannot reach. Future commerce migrations continue at `917`. See [ADR-0015](docs/adr/0015-commerce-migrations-live-in-the-reserved-9xx-range.md) for the options considered and rejected (widening the runner's pattern to four digits, keeping the numbers and documenting the tie-break, a separate `sql/commerce/` directory — all three would have required editing the upstream `db-migrate.ts` file this repo never patches locally).

- Every reference to the old `sql/153`–`sql/168` numbers across source, tests, OpenAPI, and documentation was updated to the new `sql/901`–`sql/916` numbers — except upstream's own `sql/153_awcms_blog_institution_logo.sql` and its references, which are untouched, and historical prose describing a specific past commit's diff, which stays historically accurate.
- A new `apps/cms/tests/commerce-migrations-range.test.ts` enforces the split (`9xx` for commerce, below `900` for everything else) so it stays true after every future `git subtree pull`.
- **Operator step:** a database that already ran `db:migrate` against the old file names must run `bun run db:commerce:renumber` once, from `apps/cms`, before its next `db:migrate` — a new, transactional, idempotent compatibility script (`apps/cms/scripts/commerce-migrations-renumber.ts`) that updates the sixteen already-applied rows' recorded names and checksums. No production PostgreSQL exists yet for this repo, so no database needs this today; a fresh database needs nothing at all, since it applies the new file names directly.

## [0.4.0] — 2026-09-18

### Reconcile apps READMEs found broken by #43's review

Two defects in `apps/**` READMEs, both found while reviewing PR #43 and out
of scope for it since it only touches root-level docs.

- `apps/storefront/README.md`'s stub-workflow paragraph: PR #41 (issue #30)
  inserted the new state-machine clause mid-sentence, between "straight from
  the committed fixtures" and "under `apps/storefront/tests/fixtures/
  awcms/`", orphaning the second half as its own fragment line. Restored the
  original sentence and made the issue #30 addition its own well-formed
  sentence, keeping the file's hard-wrap style.
- `apps/cms/src/modules/commerce/README.id.md` had fallen behind Issue #29:
  the whole "Customers, orders and reviews" section was missing from the
  mirror, the admin-screens heading and body still described the
  pre-#29 eight-screen/32-permission state, and the frontmatter table
  (tables, permissions, API, events, dependencies, jobs) plus several
  prose paragraphs (the `manualRating`/`manualSoldCount` note, the voucher
  redemption paragraph, the `downloadLink` DTO note, and "Dengan sengaja
  tidak ada di sini") still described the pre-#29 shape — one of them
  (the `downloadLink` note) had drifted into stating the opposite of what
  the corrected English source now says. Translated the missing section
  and brought every drifted paragraph back in line with `README.md`,
  paragraph by paragraph. Verified the module has nineteen
  `awcms_commerce_*` tables and 39 permissions against `module.ts`, both of
  which now match `README.md`; no factual error was found in the English
  source itself.

### `audit:rilis` count bound raised from 10 to 20 waiting changesets

The gate's own docblock called 10 files a "starting assumption pending real
release history". There is history now: v0.3.0 folded ten changesets from
one increment, and increment 3 (epic #46) produces one changeset per atomic
PR — fourteen children plus follow-ups — before its own release, so the
bound of 10 turned `check` red on every PR in the second half of the
increment while asking the contributor for nothing. Twenty is the measured
size of one increment's release plus headroom; the 14-day age bound, which
is the one that actually catches an unwatched backlog, is unchanged.

- Only felt while developing: `bun run audit:rilis` no longer reddens a
  branch merely because an increment is more than half merged.

### Rule-based legacy redirects for seputarborneo's rubrik/daerah/mitra/video/static/search URLs

Issue #28's redirect map only ever knows a URL an operator/import explicitly
recorded as a `awcms_seo_redirects` row — right for a single article, but
seeding one row per rubrik/daerah/mitra/video/static/search URL would mean
hundreds of rows for a handful of fixed, deterministic shapes that
seputarborneo's own `include/nav_menu.php`
(`seputarborneo_rubrik_resolve()`/`_kanonik()`) already encodes as a lookup
table, not a database query.

`apps/storefront/server/pengalihan-aturan.mjs` is a new, pure, table-driven
module for exactly those shapes, wired into `legacyRedirectLocation()`
**after** the row-based map — an operator-authored row always wins on
overlap. It covers `/rubrik/{slug}.html` (including `VIDEO`/`video` → the
`/video` list, not a rubrik archive), `/daerah/{kategori}.html` (plus 14 old
city names), `/mitra-borneo/{slug}.html` (24 channels, matching issue #57's
own institution seed list), `/umum/{slug}.html` (UMUM's children are
ordinary rubriks here), `/rubriks/?news=&kt=&lanjut=` (the SAME dispatch as
`/{A}/{B}.html`, not a re-derived one), `/video/?video={id}-{slug}.html`/
`{id}_{slug}.html`/the bare `?video={id}` shape (resolved only against a
known `/video/?video={id}-…` row — a DIFFERENT id space from `/news/…`,
never a guessed slug), the three static pages, the search box (302, not
301 — a search result is not permanently moved), and
`/img/?news={id}`/`/index.php`/`/?subscribed=1`.

- `apps/storefront/server/penyaji.mjs`'s `legacyRedirectLocation()` now
  falls through to the new module on a row-map miss; its return shape grew
  to allow `{ location, status }` for the one 302 case, while every
  existing caller (including
  `apps/storefront/tests/berita-penyaji-legacy.test.ts`, unedited) keeps
  working against the plain-string 301 shape it already returned.
- `apps/storefront/tests/pengalihan-aturan.test.ts` covers every rule
  (encoded/decoded input, trailing slash or not), the documented
  `WISATA`/`Wisata` collision (both intentionally land on
  `/rubrik/wisata`), and a loop guard proving no rule's destination matches
  any rule's own source shape.
- `docs/routing.md`/`.id.md`'s "Legacy redirects" section documents the full
  table.

#### Post-review corrections (PR #61)

Six defects found reviewing the first version of this change, all fixed on
the same branch:

1. The video rule (`?video={id}-…`) was matching the id against `/news/…`
   rows — `berita_red` (`/news/…`) and `berita_vid` (`/video/?video=…`) are
   two INDEPENDENT MariaDB id spaces (issue #58/B2), so this could redirect
   a reader to a numerically-coincidental, unrelated article. It now looks
   up a `/video/?video={id}-…`/`{id}_…` row exclusively, and also resolves
   the bare `?video={id}` shape the old homepage hard-coded.
2. The `/news/{id}…` id lookup only matched a hyphen separator; issue #58's
   importer documents an underscore template
   (`/news/{legacyId}_{slug}.html`), so a real row could silently miss. Now
   matches `-`, `_`, or `.` (a bare id with no slug).
3. `/rubriks/?news={A}&kt={B}` is exactly `/{A}/{B}.html` per `.htaccess`
   — it now reuses the same rubrik/daerah/mitra/umum dispatch instead of
   always answering `/rubrik/…`, so e.g. `news=daerah&kt=Sampit` correctly
   lands on `/daerah/kotawaringin-timur`, not `/rubrik/kotawaringin-timur`.
4. A `/rubriks/?news=` value that normalizes to empty (e.g. `%21%21%21`)
   no longer produces `Location: /rubrik/`.
5. `/rubrik/VIDEO.html`/`/rubrik/video.html` now redirect to `/video` (its
   own list page) instead of a `/rubrik/video` page this app does not have.
6. The `/news/…`/`/video/?video=…` id lookups now read from an
   `id -> target` index built once per row-based map object and cached
   (`WeakMap`), instead of an `Object.keys` scan repeated on every request
   — load-bearing once issue #58 (B2) imports seputarborneo's ~25k rows.

#### One more correction: the row-based (issue #28) map itself

`apps/storefront/src/profil/berita/pages/index/pengalihan-legacy.json.ts`'s row-based map — the one
`pengalihan-aturan.mjs` only ever falls through to on a miss — had two
related bugs of its own, found while wiring the above:

- It rebuilt every `legacy_blog` row's destination as `/berita/{slug}`
  unconditionally, but `apps/storefront/src/lib/berita.ts`'s `getPosts()` never publishes a
  video post there (only `/video/{slug}`) — every imported video's redirect
  would land on a page this app never builds. `buildLegacyRedirectMap()`
  now takes an optional `videoSlugs` set (default empty — every existing
  call/test keeps its prior behavior) and the page supplies it from one
  `getVideo()` call at build time.
- `normalizeLegacyPath` stripped the query string unconditionally, which
  collapsed every `/video/?video={id}-…` row (issue #58/B2's own template
  for a video redirect) onto the identical bare `/video` key — losing the
  id the video fix above needs, and setting up a build-time throw the
  moment a second, differently-targeted video row existed. It now preserves
  the query for that one shape only.

### Seed seputarborneo reference taxonomy, institutions, sample posts, legal pages, ad placements, social links, and legacy redirects

`tools/seed-borneojek-mart.ts` previously seeded 3 store-flavoured blog terms, 3 posts, 2 legal pages, 0 institutions, 0 ad placements, and 0 redirects — against a real database every news page the storefront's `/berita`, `/rubrik/*`, `/daerah/*`, and `/mitra/*` routes render was empty. This gives every developer, reviewer, and CI job something real to look at instead of an empty news IA, modelled on seputarborneo's own reference structure (`include/nav_menu.php`, verified 2026-09-18) so it matches the shape `apps/storefront`'s news pages were actually built against.

- An 8-rubrik `category` taxonomy tree (politik/hukum/nasional/olahraga/wisata/daerah/mitra-borneo/umum) with umum's topical children — including a `wisata-travel` child, a deliberate slug choice recorded in `tools/seed-borneojek-mart.ts`'s own docblock: `awcms_blog_terms_slug_dedup` (`apps/cms/sql/035_awcms_blog_content_schema.sql`) is unique on `(tenant_id, taxonomy_type, slug)` with no `parent_id` component, so this one tree cannot hold seputarborneo's own two `wisata` slugs (a top-level rubrik and a UMUM child) the way its legacy two-column MySQL schema could.
- The 27-institution legislative/executive directory — seputarborneo's own 24-channel Mitra Borneo list plus a bare `Pemkab` for the 3 regencies that list leaves out (Kotawaringin Barat, Sukamara, Barito Selatan), added so all 14 Kalteng regencies/cities have at least one institution to carry their `regionCode` (region membership is institution-only) — each `regionCode` resolved by NAME against `GET /api/v1/idn-regions/regions` at seed time rather than a hard-coded Kepmendagri code.
- 44 sample news posts — at least two per rubrik (all 14, including umum's children) and at least one filed to every one of the 27 institutions through `institutionIds`, so every `/rubrik/*`, all 14 `/daerah/*`, and all 27 `/mitra/*` archives render with content rather than an empty state; generic, clearly-marked placeholders with no real people or events, three carrying a Portable Text `videoNews` node with a clearly-marked placeholder YouTube id.
- Three additional legal pages: `redaksi` (generic placeholders, deliberately not seputarborneo's own company/personnel data), `pedoman-media-siber` (Dewan Pers's public text, ported), and `disclaimer` (genericized to this tenant).
- Six social links and a WhatsApp number on the site profile.
- 5 sample `legacy_blog`-origin redirects exercising `docs/routing.md`'s row-based legacy-redirect path.
- Ad placements are attempted for real (upload-session → PUT → finalize) and gracefully skipped with one explanatory line — counting only the placements actually left unapplied — when, and only when, the create-session route answers its `502 PROVIDER_ERROR` "R2 not configured" refusal (verified against `apps/cms/src/pages/api/v1/media/news-images/upload-sessions/index.ts`); this repo's local/CI compose stack is exactly such a deployment, so no ad placement is actually created here today, and the moment R2 is configured this step creates all 12 unattended (`sidebar_middle` with the 300x600 creative, matching seputarborneo's half-page `kiri-tengah` slot). Every other media failure — a 400 mime/size refusal, a 403 on the presigned PUT, a 422 or transient 502 from finalize, a network error, a rejected placement POST — is reported per placement and fails the seed, so a real breakage can never hide behind the "no R2 here" message.
- `MACHINE_CREDENTIAL_PERMISSION_KEYS` (the read-only token `apps/storefront`'s build uses) gains the 8 `blog_content`/`seo_distribution`/`site_profile`/`idn_admin_regions` read keys the news surface actually calls — each copied verbatim from its route file's own `authorize` guard, never guessed. Because the machine-credential surface has no "widen scope" verb (only create and `{id}/revoke`), a tenant seeded before this scope grew would otherwise have kept its narrower credential forever and the 403 this issue closes would have stayed open everywhere except a fresh database: the seed now compares the live credential's `allowedPermissionKeys` with its own list and, on a mismatch, revokes and reissues, printing the new token once with an `ACTION REQUIRED` line — the old token fails on its next request, so `AWCMS_API_TOKEN` must be updated wherever the build reads it.
- `resolveKaltengRegions` lists Kalimantan Tengah's regencies/cities with ONE `GET /api/v1/idn-regions/regions?level=2&parentCode=…` request and matches the 14 names in memory, instead of the 14 identical requests it used to issue.
- Found and fixed, for every page/post this script has ever seeded (not narrowly this issue's own): `createBlogPage`/`createBlogPost` always write `status: 'draft'`, and nothing published either past it, so `kebijakan-privasi`/`tos` and BjekMart's own 3 posts were, and would have stayed, invisible to `apps/storefront`'s build. Found and fixed while verifying this issue's own rendering acceptance criteria against a real seeded local CMS.
- Every step is additive to the existing seed and follows the same idempotent `ensure*` posture already established — verified locally with two consecutive `bun run db:seed:cms` runs against a freshly reset/migrated database: the second run reports 0 created for everything this issue adds. `apps/storefront`'s build against this real seeded CMS now renders `/berita` (19 article pages), all 14 Kalteng `/daerah/*` (19 total with the neighbouring Lintas Kalimantan provinces), all 27 `/mitra/*`, `/rubrik/politik`, `/halaman/redaksi`, and 3 `/video/*` pages.

### Exporter from the seputarborneo MariaDB dump to `blog_content`'s legacy-import pipeline

`tools/import-seputarborneo.ts` (`bun run import:seputarborneo`) reads seputarborneo.com's legacy MariaDB archive and writes the input files `apps/cms`'s own operator pipeline for exactly this job expects — `bun run blog:legacy:import` (Issue #599/ADR-0114 in upstream awcms). It makes no network call itself; the actual import runs from inside `apps/cms`, against the same `borneojek-mart` tenant `tools/seed-borneojek-mart.ts` bootstraps.

The **why** is mostly about what an earlier design got wrong: a first pass of this tool called the public HTTP API directly, but no public route can backdate `published_at` for an already-past article or write `legacy_source_id` — `apps/cms`'s own `blog:legacy:import` does both, and was built (per its own docblock) using this exact archive as its reference case. Routing through it also means this exporter does not need its own HTML→Portable Text converter — a second one would diverge from the converter whose refusals the pipeline actually reports and acts on.

- A streaming MariaDB dump reader (`tools/lib/mysql-dump-reader.ts`, unchanged from this issue's first pass) that learns each table's column order from its own `CREATE TABLE` statement — verified necessary against the real dump, whose `berita_vid` schema differs from the reference repo's own migrated fixture.
- The exporter writes `posts.ndjson`/`videos.ndjson` (`legacy-import-record.ts`'s exact field shape), `redirects.json` (built directly from the raw legacy title, correct even for the ~171 rows a naive `{slug}`-templated redirect would get wrong), `term-map-hints.json` (this exporter's own taxonomy classification, as a work aid), and `site-profile.json`.
- One small, deliberate exception to "no HTTP client": `--assign-institutions`, a follow-up pass run after `blog:legacy:import --commit`. That pipeline calls `syncPostTermAssignments` but never `syncPostInstitutionAssignments` (verified directly), so a `DAERAH`/`MITRA BORNEO` article would otherwise import with no institution at all and never reach `/daerah/{slug}`/`/mitra/{slug}` — both this issue's own acceptance criterion.
- Verified end to end against the real 228 MB dump: 25,490 `berita_red` rows read, 25,489 exported, 0 unmapped taxonomy values, 35 `berita_vid` rows exported. The full `blog:legacy:import --commit` run against a live, seeded tenant is deliberately deferred to after issue #57 merges.
- `redirects.json` is shaped by how it is consumed, not by the legacy URLs alone (review round 2 of PR #67): every row carries `origin: "legacy_blog"`, because the storefront's `getLegacyRedirectRows()` serves only that origin and would have silently ignored an `import`-origin row; and a video post's source is a synthetic, query-free `/video/{id}-{slug}.html` rather than the real `/video/?video={id}-{slug}.html`, because the CMS strips a redirect source's query string at write time and every video row would otherwise have collapsed onto one bare `/video` — breaking the import chunk, or redirecting the `/video` list page itself. `apps/storefront/server/pengalihan-aturan.mjs` now indexes that key by id and still answers the real inbound `?video={id}` URL from it.
- `--push-redirects [--commit]` (`tools/lib/redirect-push.ts`): ~51,000 redirect entries against a route capped at 200 per all-or-nothing call is a ~256-call loop, which the first runbook left to `curl` by hand. The exporter now runs it — a whole-file dry run by default, then real chunks each under an `Idempotency-Key` derived from the chunk's content, so a crash mid-run is safe to rerun (committed chunks replay from the CMS's idempotency record). A file-wide duplicate check runs before any call, because the route only detects duplicates within one chunk.

### Storefront ad popup: a native `<dialog>` on creative click

Since issue #47 an ad slot on the news surface renders its creative as a
real `<img>` — 300×250, the slot's own size — inside an anchor straight to
the advertiser. seputarborneo (the site this news surface mirrors) does
something more useful with that click: `js/main.js`'s `initAdPopup()`
opens the creative at full size in a modal, with a clear disclosure and a
deliberate "open the ad" step, so a reader can look at an ad without being
sent off-site by a mis-tap on a small image. Issue #53 ports that
behaviour, dropping the jQuery and the hand-rolled modal the original
needed: the native `<dialog>` already gives focus trapping, `Escape`, an
inert page behind it, and the backdrop.

`apps/storefront/src/scripts/iklan-popup.ts` is mounted once from
`apps/storefront/src/layouts/BeritaLayout.astro` (an external module —
this app's `script-src 'self'` allows nothing inline) and listens for one
delegated click on `.ad-slot [data-iklan-popup]`, so every slot on every
news page — including the sidebar slots issue #49 adds in parallel — is
covered without any page knowing the module exists. The dialog is built on
the first click and reused. `IklanSlot.astro` marks a linked creative's
anchor with `data-iklan-popup`/`data-iklan-nama`/`data-iklan-label` and
nothing else changes there; an UNLINKED creative, which had no anchor to
decorate, now wraps its image in a real `<button type="button">` so the
"no destination" state is reachable by keyboard too.

- A reader who clicks an ad creative sees it at natural size (capped at
  90vw/90vh), the advertiser's name, the disclosure label, and a "Buka
  iklan" CTA to the real destination (`rel="sponsored noopener"`); a
  creative with no destination shows "Iklan ini belum memiliki tautan
  tujuan" and no CTA. ✕, backdrop, and `Escape` close it; focus returns to
  the creative; the page does not scroll underneath.
- No JavaScript, or no `<dialog>` support: the anchor navigates as before.
  A Ctrl/Cmd/Shift/Alt or middle click is left to the browser.
- The CTA never trusts the CMS's `linkUrl` into a new `href` unchecked —
  anything that is not an absolute `http(s)` URL is treated as no
  destination.
- Tests: a Playwright spec through the existing `bun run test:e2e` harness
  (`apps/storefront/tests/e2e/iklan-popup.e2e.ts`) plus DOM-free unit and
  wiring guards (`apps/storefront/tests/iklan-popup.test.ts`). The ad
  fixture gains one unlinked `article_bottom` creative so an article page
  carries both trigger shapes.
- Found, not fixed (outside this issue's files): the preview server
  answers `/berita` and `/video` with the 404 page — `build.format:
  "file"` emits `berita.html` beside the `berita/` directory, and
  `@astrojs/node`'s static handler rewrites a directory-shaped URL to
  `berita/index.html` before `send`'s `.html` fallback runs. Recorded in
  `apps/storefront/README.md`'s "Ad popup" section for follow-up.

### Storefront build no longer floods the CMS with 56 concurrent region requests

`apps/storefront`'s `/index/wilayah-kecamatan-{code}.json` route fetched the
districts of every regency under every configured province in one
`Promise.all` — 56 concurrent `GET /api/v1/idn-regions/regions?level=3` calls
with the default `PUBLIC_WILAYAH_PROVINSI`. `apps/cms` admits at most 40
`interactive` requests at once (8 running + a bounded queue of 32,
`apps/cms/src/lib/database/work-class.ts`) and rejects the rest with a 503, so a
build against a real, seeded CMS failed deterministically with 16
`database.pool.rejected` — while every stub-backed gate stayed green, because
the stub never refuses anything. Found while verifying issue #57 against the
local database (issue #71).

- Every region request in `apps/storefront/src/lib/awcms/wilayah-checkout.ts`
  now passes through one module-level, dependency-free concurrency limiter
  (`MAX_IN_FLIGHT_REGION_REQUESTS` = 6). The bound lives inside the one function
  every request goes through, not in the routes, so no present or future caller
  can fan out past it by forgetting a helper; the routes' `Promise.all` stays,
  fanning out promises rather than requests.
- Why 6: under the CMS's 8 *running* `interactive` slots, not merely under the
  40 it admits — the region walk never queues on an idle CMS and leaves room
  for the rest of the same `astro build` and the CMS's own admin users.
- Fewer, bigger calls were considered and rejected: the route filters
  `parentCode` as an exact match on the direct parent and documents `after`
  only as "the last code of the previous page", so a province-wide level-3
  walk would mean either walking the whole country or inventing cursor
  semantics the API does not promise.
- `apps/storefront/tests/wilayah-checkout.test.ts` asserts the ceiling over the
  real 56-regency fan-out with a mocked client; `apps/storefront/README.md`
  documents the ceiling and the CMS limit it stays under.

### Logo Instansi — an institution's emblem beside the article it filed

Issue #59 (C1), the last of its three steps. seputarborneo.com v2.3.0 lets
an editor attach a regency's emblem to an ARTICLE; here every such article
is already filed under that regency's institution, so the emblem hangs off
the institution instead — upstream awcms#806's `logo_media_id`/`logo_alt`,
carried in by the `apps/cms` subtree pull (step 2, PR #68), resolved
through issue #47's media client.

- `/berita/{slug}` renders the emblem as a float beside the opening
  paragraph, linked to that institution's own page, with no background or
  border (an emblem is nearly always a transparent PNG/SVG — upstream's
  2.3.2 release removed those decorations for the same reason).
- `/mitra/{slug}` shows the same emblem on the institution's landing page,
  which until now rendered only a name, a description and a post list.
- One upload serves every article of that institution and changing it
  updates them all — the property seputarborneo's own "satu logo dipakai
  berulang" rule was after, with one source of truth instead of a per-post
  picker that can disagree with the channel the article is filed under.
- An article with no institution, an institution with no emblem, or a
  stale media id renders nothing at all: no empty frame, no broken image.

Only felt while developing: `RawInstitution.logoMediaId`/`logoAlt` are
OPTIONAL, so a build pointed at an `apps/cms` older than the subtree pull
renders no emblem rather than crashing on a missing property; every
emblem in the list resolves in the same batched `resolveMedia` call the
post images already use.

### Storefront media client: article images, ad creatives, YouTube facade

`apps/storefront` could see that a post, a gallery item, or an ad
placement HAD a photo or a video, but had no way to turn that into a URL —
`apps/storefront/src/lib/awcms/media.ts` had no `media_library` read client
at all, so every image-bearing block degraded to a stated placeholder
(issue #28's own recorded deviation). A reader of the news surface saw
text, never a photo; a video post linked out to YouTube instead of playing
inline; an ad slot showed its name, never its creative.

`apps/storefront/src/lib/awcms/media.ts` batch-resolves a media object id
to its public reference via `GET /api/v1/media/objects` (chunked at 100 ids
per call, memoized per build) and reads the deployment's media origin via
`GET /api/v1/media/public-origin` for the CSP artifact — both newly
verified against `apps/cms`'s own route files rather than guessed from the
issue text. `apps/storefront/src/lib/berita.ts` collects every visible
post's `featuredMediaId` and every gallery item's `mediaObjectId` up front
and resolves them in one batched call; an id that does not resolve
(unverified, deleted, or never uploaded) is logged once and renders as no
image, never a broken `<img>`.

- A news card and an article's hero figure now render a real, sized `<img>`
  (no CLS) with a credit line when the CMS has verified the media's rights.
- A gallery image and an ad creative render as real `<img>`s.
- A `videoNews` block renders a click-to-load facade — a poster image from
  YouTube's own fixed CDN convention, swapped for a real
  `youtube-nocookie.com` `<iframe>` only after a genuine click
  (`apps/storefront/src/scripts/video-facade.ts`) — never a third-party
  frame/script before that.
- `apps/storefront/src/pages/csp.json.ts` widens `img-src` with the
  resolved media origin and, only when this build has a video post,
  `img-src`/`frame-src` with the two YouTube origins the facade needs.
- The storefront build credential's permission set
  (`tools/seed-borneojek-mart.ts`) gains `media_library.media.read`.

**Known cross-PR dependency:** `apps/storefront/server/penyaji.mjs`'s
`buildCsp` (a sibling issue this wave, not this change) does not yet read
the CSP artifact's new `frameSrc` field — until it does, a real deployment
still serves `frame-src 'none'` and the facade's `<iframe>` will not load,
even though every other piece (the resolved images, the artifact itself)
already works. The artifact change is additive and does not regress an
older reader.

### `apps/storefront`: news chrome — primary nav, Daerah panel, ticker, utility bar, footer directory, footer leaderboard slot, back-to-top

Every news-surface page (`/berita`, `/rubrik/*`, `/daerah/*`, `/mitra/*`,
`/video`, `/tag/*`, `/penulis/*`, `/arsip/*`, `/cari-berita`) rendered the
STORE's commerce header/footer — product nav, a cart badge, a wishlist link —
because `BeritaLayout.astro` only ever wrapped `BaseLayout.astro` and added a
stylesheet. A reader landing on a news article saw "Keranjang"/"Wishlist" in
the header and a commerce footer with no way back into the news section's own
taxonomy. This closes issue #48 (increment 3, epic #46), porting
seputarborneo.com v2.4.0's own header/nav/footer patterns — not its PHP —
onto this app's real, live CMS data.

- `BaseLayout.astro` gained two named slots (`header`/`footer`, defaulting to
  the store's `Header`/`Footer` — every non-news page's rendered HTML is
  unaffected) so `BeritaLayout.astro` can keep wrapping it and fill those
  slots with the news chrome instead, while `<head>` and `<main id="konten">`
  stay the ONE shared implementation every page gets — no duplicated
  `<head>`, so issue #54's OG/Twitter meta and issue #56's analytics beacon
  (both landing in `BaseLayout.astro`) reach news pages automatically.
- The utility bar (`BilahUtilitas.astro`): today's WIB date, the editorial
  e-mail, the Redaksi/Pedoman Media Siber/Disclaimer links (rendered only
  when actually published), and official-account social icons — Facebook, X,
  Instagram, TikTok, YouTube, Threads — detected by URL host
  (`apps/storefront/src/lib/ikon-sosial.ts`), with an independent `http(s)`-only guard even
  though the CMS already filters at the source.
- The primary nav (`NavBerita.astro`, data from `apps/storefront/src/lib/navigasi-berita.ts`):
  Beranda · Politik · Hukum · Nasional · Olah Raga · Wisata · Daerah · Video —
  a rubrik missing from this build's taxonomy is omitted, never a dead link.
  The Daerah panel (14 Kalteng regencies/cities with an institution) is
  always fully server-rendered, with no `hidden` attribute in the initial
  HTML — a `<script>` only ever ADDS `hidden` at runtime, and only when the
  reader is not already on a `/daerah/*` page; `Escape` closes it and returns
  focus to the toggle.
- The "Terkini" ticker (`Ticker.astro`): the 3 latest post titles, as a plain
  static list — no auto-scrolling marquee, so there is no motion for
  `prefers-reduced-motion` to need to disable in the first place.
- The footer (`FooterBerita.astro`): brand/contact, Rubrik, Umum, and Daerah
  columns, the full Mitra Borneo institution directory ordered
  Pemprov/DPRD Kalteng first then per regency, a `<slot name="buletin" />`
  for issue #50's newsletter form, the legal bar, and a leaderboard
  (`<IklanSlot placement="homepage_bottom">`, decision 4 of epic #46 — reuses
  the existing placement key rather than inventing one) rendered above the
  footer. Back-to-top is a real, always-present `<a href="#atas">` — CSS
  hides it until scrolled, but `:focus-visible` reveals it for keyboard users
  regardless of scroll position.
- The masthead logo stays a text wordmark this wave — this app has no
  media-object client yet (issue #47 adds one for article images only); a
  `TODO` in `NavBerita.astro` marks where a future issue resolves
  `identity.logoMediaId` to an `<img>`.
- Today's date in the utility bar is rendered CLIENT-SIDE (a `<script>` fills
  `#bilah-tanggal` on load), never at build time — `apps/storefront` is a
  static build, so a value read from `new Date()` in frontmatter would freeze
  at whatever moment `astro build` ran and mislabel every later day as
  "today" until the next deploy.
- `daerahOrderIndex` (`apps/storefront/src/lib/navigasi-berita.ts`) strips a
  leading "Kota "/"Kabupaten " before comparing a region's name against the
  canonical order — the live `idn_admin_regions` dataset's own `name` column
  carries that term ("KOTA PALANGKA RAYA"), which a bare match against
  `DAERAH_URUTAN`'s un-prefixed names would never match, sorting Palangka
  Raya (and its institutions) last instead of first.

No page outside `apps/storefront` changed except `BaseLayout.astro`'s
two-line slot addition above, and no `apps/cms` endpoint shape is new —
every field this issue reads was already verified against a route file by
earlier issues (`src/lib/awcms/{blog,wilayah,pages,profil}.ts`).

### Shared news sidebar, homepage ad slots in seputarborneo's order, a real "Terpopuler" (issue #49)

Until now only `/berita` had a sidebar — an inline `<aside>` from issue #28
with a "Terpopuler" that was really "latest", one of the CMS's three sidebar
ad slots, and a tag cloud — and every other news page (article, video,
rubrik, tag, author, archive, search) had no side column at all. The site
this platform replaces (seputarborneo.com) renders one shared sidebar on
every one of those pages, and its own `include/sidebar.php` exists precisely
because the copy-pasted per-page versions before it had drifted. Two of the
three sidebar ad positions the CMS already models (`sidebar_middle`,
`sidebar_bottom`) and two of the three homepage positions (`homepage_middle`,
and `homepage_bottom` in its in-page position) had no surface to render on,
and issue #50's newsletter form existed but was mounted nowhere a reader
would find it.

- `Sidebar.astro` — one component, rendered by `/berita`, `/berita/{slug}`,
  `/video`, `/video/{slug}`, `/rubrik/**`, `/tag/{slug}`, `/penulis/{slug}`,
  `/arsip/{yyyy}/{mm}` and `/cari-berita`, in seputarborneo's order: the
  tabbed **Terbaru / Mitra Borneo** list (the real WAI-ARIA tabs pattern,
  BOTH panels in the HTML, the first shown with no JavaScript), `sidebar_top`,
  **Terpopuler**, the 24-institution Mitra Borneo directory, `sidebar_middle`,
  the newsletter box (`FormBuletin variant="sidebar"`), `sidebar_bottom`, the
  tag cloud. Every slot renders nothing when nothing is booked.
- `/berita`'s homepage slots now follow seputarborneo `index.php`'s order:
  `below_headline` after the headline, `homepage_middle` after the first
  three rubrik sections, `homepage_bottom` after the rest and before the
  video strip. `homepage_bottom` is also the key the footer leaderboard
  (issue #48) reuses — so on `/berita` that creative renders twice, a
  deliberate consequence of the issue's mapping, recorded rather than hidden,
  because a dedicated footer key is an upstream `blog_content` change.
- A top-level rubrik's front-page section now includes posts filed under
  any of its DESCENDANT rubrik — the same walk `/rubrik/{slug}` has always
  done. Surfaced by this change: a post filed straight into a grandchild
  rubrik (Hukum > Pidana) used to reach the front page only through the old
  aside's "Terpopuler" cards, so replacing that aside would otherwise have
  dropped it from `/berita` entirely.
- **"Terpopuler" is ranked from real readership.** A new
  `apps/storefront/src/lib/awcms/analitik.ts` reads `GET /api/v1/analytics/pages?range=7d`
  (route, query, `visitor_analytics.dashboard.read` permission and
  `{ range, pages: [{ name, count }] }` envelope all verified against the
  route file, not the issue text), folds every query-string variant of one
  post's `path_sanitized` into one count — that column keeps every
  non-sensitive parameter, so `/berita/x` and `/berita/x?utm_source=…` are
  separate rows the naive reading would split a post's readership across —
  ranks every post by it, and tops up with the newest posts. A 403/404
  (module off — it is off by default — permission missing, older CMS) or an
  empty answer degrades silently to exactly the pre-#49 "latest" list; the
  fallback is stated in code, never as a caveat in the UI, because a caveat
  there describes the deployment's configuration, not the news. The route
  returns the tenant-wide top 50 paths with no limit parameter, so a post
  ranked 51st or lower overall is invisible to the ranking and loses to a
  zero-view top-up post — documented, not worked around. The permission is
  added by name to the seed's storefront token set — **which changes the
  credential's scope: the seed's scope-reconcile (issue #57) revokes and
  reissues the live storefront credential on its next run against an
  already-seeded tenant, and a build still holding the previous
  `AWCMS_API_TOKEN` gets `401` until it is given the newly printed one.**
- **The newsletter form is mounted in the footer of every news page AND in
  the sidebar's box** — two forms on most news pages, as seputarborneo has.
  That exposed a defect in issue #50's `apps/storefront/src/scripts/buletin.ts`:
  it wired the FIRST `[data-buletin-form]` only, so the footer form (second
  in DOM order) would have submitted nowhere — a bare `<form>` GETs the
  reader's e-mail into the page's own URL. `wireBuletinForms(root)` now
  wires every form with its own closure (no shared mutable state), takes
  its root as a parameter, and is covered by a two-forms-on-one-document
  unit test with a hand-rolled fake DOM (`apps/storefront/tests/buletin-forms.test.ts`).
  The footer's own form CSS (`berita-chrome.css`, written before the form
  existed) is stacked instead of a single flex row, so the consent sentence
  no longer sits beside the input.
- Stub + fixture for the analytics endpoint (with the real route's `range`
  validation in front of it); `ad-placements-active.json` now books every
  sidebar and homepage slot, and leaves `article_top`/`article_bottom` empty
  so the build proves "no empty box" too. `apps/storefront/tests/analitik-terpopuler.test.ts`
  covers the mapping, ranking, fallback and the fetch's degrade rules;
  `apps/storefront/tests/sidebar-build-smoke.test.ts` asserts on the built HTML that the
  sidebar is byte-identical across page families, both tab panels ship, all
  six slots render in order, Terpopuler is ranked by the fixture, and a
  sidebar page carries both newsletter forms with distinct ids. The
  now-unused `getTerpopuler()` in `apps/storefront/src/lib/berita.ts` is removed.

### Storefront newsletter subscribe form and double opt-in pages (issue #50)

`apps/cms`'s `newsletter` module — an `awcms` module, ADR-0103 in
`ahliweb/awcms`'s own decision log — has shipped anonymous double opt-in
endpoints (`/api/v1/newsletter/{subscribe,confirm,unsubscribe}`) since
increment 2, and the legacy seputarborneo site this platform replaces
had a live subscribe form and admin screen — but this storefront had zero
way for a reader to actually join a list. Migrating without this would be a
functional regression against the site being replaced, not just a missing
nice-to-have.

- `FormBuletin.astro` (`variant: "footer" | "sidebar"`) — an accessible
  subscribe form: labelled e-mail field, a sentence naming double opt-in
  explicitly (PRD §30 forbids a pre-ticked/implied consent), a client-side-
  only honeypot, and an `aria-live="polite"` status region. Not mounted
  anywhere yet — placing it in the site chrome is a separate, parallel
  change (issue #46's A3), so the two changes never touch the same shared
  file at once.
- `apps/storefront/src/scripts/buletin.ts` — the browser-side client, calling the CMS's
  anonymous `/api/v1/newsletter/*` directly (cross-origin, credential-free,
  `PUBLIC_AWCMS_ORIGIN`, the same pattern `toko-klien.ts` established for
  cart/checkout in issue #30) and translating every documented outcome into
  Indonesian copy — the CMS's own response text is English by design (a
  neutral body shared with `awcms-astro`'s deployments) and is never shown
  to a reader verbatim.
- Three pages: `/buletin` (a standalone page for links from an e-mail/social
  post), `/newsletter/confirm`, `/newsletter/unsubscribe` (read `?token=`,
  call confirm/unsubscribe, `noindex, follow`). The two token pages sit at a
  CMS-imposed path, not this app's own naming: `apps/cms/src/modules/
  newsletter/domain/newsletter-mail.ts` bakes every confirmation/unsubscribe
  e-mail from the fixed, non-configurable constants
  `NEWSLETTER_CONFIRM_PATH`/`NEWSLETTER_UNSUBSCRIBE_PATH`, and its own
  `subscribe.ts` docblock says the public site in front of the CMS (this
  storefront) is expected to serve exactly those paths — so this app honours
  that contract directly rather than adding a redirect layer in front of a
  storefront-chosen URL. `apps/storefront/tests/newsletter-path-contract.test.ts`
  guards the two path strings, by file existence and without importing anything from
  `apps/cms`, against a future upstream rename. `robots.txt` disallows the
  two token pages, matching `/pesanan`'s existing precedent for a URL that
  carries a one-time, reader-specific credential.
- No CSP change: the newsletter endpoints live on the same CMS origin
  cart/checkout already call, and `connect-src` is already keyed by that
  whole origin, not by path.
- Documented, not shipped here (an operator action, not code): the CMS only
  composes a confirmation/unsubscribe link pointing at THIS storefront's
  origin — and only grants the CORS access the subscribe form needs at all —
  once that origin is registered and verified in `awcms_tenant_domains`
  (`POST /api/v1/tenant/domains` + `POST .../{id}/verify`). See
  `apps/storefront/README.md`'s "Newsletter" section.

Four fixes from review, all in `apps/storefront/src/scripts/buletin.ts`:

- The subscribe form now runs `checkValidity()`/`reportValidity()` before
  ever calling `fetch()` (the same pattern `checkout.ts` already uses) — a
  malformed address used to reach the network and come back as a CORS-
  opaque failure the reader saw as "could not reach the server".
- `VALIDATION_ERROR`/`RATE_LIMITED` are real route behaviour but effectively
  unreachable from this app's actual, cross-origin deployment (the CMS
  answers both BEFORE classifying `Origin`, with no CORS grant on either —
  the browser's `fetch()` rejects before the body is ever read, landing in
  `NETWORK_ERROR` instead). `NETWORK_ERROR`'s copy no longer asserts a
  connectivity cause, is worded differently for the subscribe form (an
  e-mail address to check) vs. the two token pages (a link to check, no
  address field to point at), and the two now-corrected docblocks say
  plainly that a reader on this app's real deployment will see
  `NETWORK_ERROR`'s message for what is very often really a bad address, not
  a dropped connection.
- `/newsletter/confirm` and `/newsletter/unsubscribe` no longer fire their
  state-changing `POST` on page load. A mail gateway's inbound link-scanner
  routinely fetches and fully renders — executes JS on — every link in an
  incoming e-mail before the reader sees it; an eager POST let the SCANNER
  confirm the subscription or unsubscribe the reader, not a choice the
  reader made. Both pages now ship an inert, `hidden` button in their static
  HTML that `buletin.ts` unhides and wires to a `click` handler only once a
  well-formed token is confirmed present.
- `RATE_LIMITED`'s wait is now read from the response's `Retry-After`
  HEADER. The CMS's own `fail(429, ...)` call never populates
  `error.details` — the wait travels as a header — so the previous
  `details.retryAfter` read always evaluated to `null` in production.

### Storefront link previews: `og:image`, `article:*`, `video.other`, Twitter cards, `rel=prev/next`

A news article or video shared from `apps/storefront` previewed as a bare
title-and-description card on WhatsApp, Facebook, X and Telegram — no
picture, no date — because `BaseLayout.astro` rendered one fixed
six-tag Open Graph block for every page and had no way for a page to add
a `<meta>` of its own. Issue #28 recorded the gap twice (the article
docblock, `docs/seo.md`'s "Not built"); issue #47 then made the picture
AVAILABLE (`PostDetail.image`, `post.video`) without a tag to put it in.
For a news site, the share card IS the front page most readers see first,
so this is a reach problem, not a polish one.

`BaseLayout.astro` now takes two optional props — `ogType` (`website`
default, `article`, `video.other`) and `meta` (a typed list of
`property=`/`name=` + `content=` pairs, rendered one `<meta>` each after
the fixed block). Both default to "render exactly what rendered before",
so no store page's `<head>` changed — a build-smoke test holds
`/`, `/produk`, `/kategori/{slug}`, `/product/{slug}` and `/halaman/{slug}`
to a frozen snapshot of the pre-change block. `apps/storefront/src/lib/meta-sosial.ts`
builds the tags as plain data, one builder per `og:type`, so a page cannot
pair one type's `og:type` with another type's namespace (Open Graph
silently drops `article:*` under `video.other` — a mistake that would
never fail a build).

- `/berita/{slug}`: `og:type=article`, `og:image` + width/height/alt when
  the featured image resolved, `article:published_time`/`modified_time`
  (the same ISO timestamps the `NewsArticle` JSON-LD already carries),
  `article:section`, one `article:tag` per tag, and a Twitter card
  (`summary_large_image` with an image, `summary` without).
- `/video/{slug}`: `og:type=video.other`, `og:image` = the post's own
  featured image or else the same `hqdefault.jpg` YouTube poster the card
  and the facade already load (featured-first, like the card thumbnail;
  never `maxresdefault`, which YouTube 404s for SD-only uploads and would
  leave a `summary_large_image` card empty), `og:video:url` = the
  identical `youtube-nocookie.com/embed/{id}` the click-to-load facade
  loads, `video:release_date`/`video:tag`.
- News listing pages (`/berita`, rubrik/daerah/mitra/tag/penulis/arsip,
  `/video`): the site logo as `og:image` when `identity.logoMediaId`
  resolves through the issue-#47 media client — applied once in
  `BeritaLayout.astro`, deliberately not in `BaseLayout.astro`, which is
  what keeps the store pages provably unchanged. An unresolved logo emits
  nothing.
- `/rubrik/{slug}` and `/rubrik/{slug}/halaman/{n}`: `<link rel="prev">`/
  `<link rel="next">` through the layout's `head` slot; page 2's `prev` is
  the bare rubrik URL, never `/halaman/1`.
- Every `content` value reaches the page only through Astro's attribute
  escaping at the one render boundary — `jsonForScript()` stays reserved
  for the JSON-LD script block, where its JSON escapes are the right ones.
- `docs/seo.md` (and its mirror) gains an "Open Graph and Twitter Card by
  page type" section and a truthful "Not built"; the article page's
  docblock no longer claims either gap.

### "Dengarkan berita ini" — the article read-aloud player

Issue #52. Every article page (never a video post — there is nothing to
read aloud beside a video the reader is already watching) now offers a
player that reads the headline and the body with the READER'S OWN device
voice: `window.speechSynthesis`, `lang = "id-ID"`. No API key, no audio
file built or stored, no request leaving the page — the article text never
travels anywhere except into the browser's own speech engine. Ported from
seputarborneo.com v2.4.0's own player and the contract its `AGENTS.md`
records.

- A reader can play/pause, skip to the previous or next section, stop,
  choose a speaking rate (0.75×–1.5×) and, on a device with more than one
  Indonesian voice, pick the voice. Rate and voice are remembered for the
  next visit.
- The section being read is outlined in the article as it is spoken. The
  highlight is an `outline`/`box-shadow`, never a background or border, so
  the article does not shift under the reader mid-sentence.
- The card is ALWAYS rendered with `hidden`; the script reveals it only
  when the browser really has `speechSynthesis` AND the device has a voice.
  A browser without the API, or a reader with JavaScript off, sees nothing
  at all rather than a dead control.
- Photo captions, credits, embeds and ad slots inside the article body are
  skipped — an advertiser's name read out mid-sentence is worse than
  silence.

Only felt while developing: speech is split per sentence (Chrome cuts an
utterance off after ~15 seconds) while the highlight stays per block; the
`data-dengar-*` attribute names are a three-sided contract between
`apps/storefront/src/components/berita/PemutarDengar.astro`, `apps/storefront/src/styles/dengar.css` and `apps/storefront/src/scripts/dengar.ts`,
listed in the component's own docblock.

### `/berita`, `/video` and every `/rubrik/{slug}` answered 404 on the served site

Issue #75. `apps/storefront` builds with `build.format: "file"` and
`trailingSlash: "never"`, so a landing page that also has children is
emitted as both a file and a directory — `dist/client/berita.html` beside
`dist/client/berita/`. `@astrojs/node`'s static handler (v11.1.5,
`serve-static.js`) checks for a directory before it asks `send` for a
file: a directory-shaped request with no trailing slash is rewritten to
`{path}/index.html`, which this build never writes, so `send`'s `.html`
fallback never runs and the request falls through to SSR — a 404 for a
page whose file exists, with every build gate green. The three news
landing surfaces (`/berita`, `/video`, and — one level down, not named in
the issue but found the same way — every `/rubrik/{slug}`) were the
affected pages; their children were never broken.

- `apps/storefront/server/penyaji.mjs` now walks `dist/client/` once at
  startup for every page shadowed by a same-named directory
  (`discoverShadowedHtmlPaths`) and, as the last step before the adapter —
  `/healthz`, `/products`, and both legacy-redirect layers keep precedence
  — rewrites `req.url` for exactly those paths to `{path}.html`
  (`shadowedHtmlUrl`). An internal rewrite, not a redirect: the reader's
  URL is unchanged, `/berita/` still 301s to `/berita` exactly as before,
  and the adapter's own `send` still serves the file (traversal,
  conditional GET, content type) — nothing new reads or streams a page.
- Why not `build.format: "directory"`: it would cure the shadow but move
  every page to `{slug}/index.html` and hand `trailingSlash: "never"` a
  directory-index rewrite on every request — the pairing
  `astro.config.mjs`'s `format` comment exists to avoid. Why not a
  per-request `stat`: which pages are shadowed is a fact about the build,
  fixed for the life of the process, and this file's rule is "no I/O at
  request time" for such facts.

Only felt while developing:

- `apps/storefront/tests/penyaji-bayangan-html.test.ts` covers the walk
  against a synthetic `dist/` tree (nested shadow included) and the
  `createServer` hook; `penyaji-bayangan-build-smoke.test.ts` builds
  against the stub and serves it through the real bundled
  `dist/server/penyaji.mjs` — the first test in the suite to do so — and
  fails with the fix removed.
- `docs/routing.md` (+ `.id.md`) gains a section on the rule.

### Storefront article share row — FB/X/WhatsApp/Threads, Instagram via Web Share, TikTok/YouTube follow (issue #51)

Every article and video page (`/berita/{slug}`, `/video/{slug}`) used to end
with two text links — "Bagikan ke WhatsApp" and "Bagikan ke Facebook". The
legacy seputarborneo site this news surface replaces ships a seven-control
row (its `sb_bagikan()`, issues #61/#67 there), and its own working
contract insists the row is THREE kinds of control that must not be
conflated: platforms with a real web share URL, one platform (Instagram)
with none at all that is still a share action, and two (TikTok, YouTube)
with none that are FOLLOW links to the site's own accounts. Inventing a
share URL for the last three — the obvious shortcut — is exactly what that
contract forbids, because there is no such URL to invent. This change ports
the row with that distinction intact.

- `apps/storefront/src/components/berita/BarisBagikan.astro` replaces the
  old block in `ArtikelView.astro` (the only edit to that file — an import,
  the component, and the now-dead `encodedTitle` constant removed).
  Facebook, X, WhatsApp and Threads are plain `<a rel="noopener nofollow">`
  intent links that need no JavaScript; TikTok/YouTube are
  `<a rel="noopener me">` follow links rendered only when
  `identity.socialLinks` actually carries one; Instagram is a real
  `<button>`. Every control has a full accessible name that names the verb
  ("Bagikan ke Facebook" vs "Ikuti kami di TikTok") and a 44×44 target.
- `apps/storefront/src/lib/bagikan.ts` (build-time, pure) — the four URL
  builders (title and URL each `encodeURIComponent`-ed; Facebook's sharer
  takes only `u=` and reads the title from the page's own OG tags) and the
  follow-link resolver, which goes through issue #48's
  `apps/storefront/src/lib/ikon-sosial.ts` rather than a second filter: the same
  `http(s)`-only scheme check that closes the stored-XSS hole an
  admin-typed `javascript:` URL would open, and the same hostname-based
  platform detection, so an editor's "TikTok" label on a non-TikTok URL is
  not believed. WhatsApp's SVG path is the one glyph this row adds; every
  other icon is `ikon-sosial.ts`'s.
- `apps/storefront/src/scripts/bagikan.ts` (browser, an external module —
  the CSP's `script-src 'self'` has no `'unsafe-inline'`) — the Instagram
  flow: `navigator.share({ title, url })` first, a dismissed share sheet
  stays silent, any other failure or no Web Share API falls through to
  `navigator.clipboard.writeText(url)` with a visible "Tautan disalin…"
  status in a `role="status"`/`aria-live="polite"` region. That region
  ships EMPTY in the static HTML rather than being created on first click
  as upstream does — a live region that is created and filled in the same
  tick is announced by some screen readers and skipped by others. A denied
  or unavailable clipboard ends in a visible failure message; upstream's
  `execCommand("copy")`/`window.prompt()` last resorts were deliberately
  not ported (deprecated, and a blocking prompt is the interruption an
  `aria-live` status exists to avoid).
- The Instagram button ships `hidden` and the script reveals it once its
  handler is attached: it has nothing to do without JavaScript (no share
  URL exists to fall back to), and a control that does nothing must not be
  offered. It never reads `identity.socialLinks` — the reader shares to
  THEIR Instagram; that needs no account of ours.
- No third-party script (no Facebook SDK, no Twitter widgets, no embed.js)
  — `apps/storefront/tests/bagikan.test.ts` greps every file under `src/` for their hosts,
  and `apps/storefront/tests/bagikan-build-smoke.test.ts` builds against the stub and
  asserts the rendered row (and the follow links' correct ABSENCE, given
  the fixture profile has no TikTok/YouTube) on a real article page and the
  video page.
- `apps/storefront/src/styles/bagikan.css` is a new, component-imported
  stylesheet; `apps/storefront/src/styles/berita.css` is untouched (its `.article-share`
  rules are now unused — a follow-up cleanup once this wave's concurrent
  edits to the article templates have landed).

### Storefront visitor beacon + optional GA4 (issue #56, A10)

`apps/storefront` sent no telemetry of any kind — the seputarborneo
reference this epic re-platforms from loads GA4 on every page and runs its
own per-IP-per-day counter; this repository's `apps/cms` already carries a
privacy-first, off-by-default `visitor_analytics` module with a public
ingest endpoint (`POST /api/v1/analytics/collect`) that nothing called it.
Without this change, A3's "Terpopuler" section (the module's rollups) would
have nothing real to read once it lands, and there was no way to add GA4
for an operator who wants it alongside.

- `apps/storefront/src/scripts/analitik.ts` — a first-party, privacy-
  respecting page-view beacon mounted on every page. It sends exactly
  `{ tenantCode, path, referrer? }`, verified against the route and its
  module's README rather than guessed, and honours Do Not Track/Global
  Privacy Control by not sending at all.
- **Scope correction, recorded rather than silently followed:** the issue's
  own Scope bullet named `navigator.sendBeacon` (fallback `fetch keepalive`).
  That is backwards for this specific endpoint — `sendBeacon`'s payload
  cannot carry the `content-type: application/json` header the endpoint
  requires cross-origin, a fact `apps/cms`'s own
  `visitor-analytics/domain/beacon-cors.ts` docblock already tested and
  documents. `fetch` with an explicit JSON content-type, `credentials:
  "include"`, and `keepalive: true` is what is actually sent; `sendBeacon`
  is never called. There is also no "viewport class" field in the route's
  validated schema, so none is invented.
- GA4 (`PUBLIC_GA_ID`, optional, off by default) — `BaseLayout.astro` loads
  `gtag.js` only when a real GA4 Measurement ID is configured, and
  `csp.json.ts`/`apps/storefront/server/penyaji.mjs` widen the served CSP's `script-src`/
  `connect-src` for GA's own fixed origins only then. The `dataLayer`/`gtag`
  bootstrap Google's own snippet normally inlines is instead
  `apps/storefront/src/scripts/ga-init.ts`, an ordinary same-origin bundled module — an
  inline `<script>` body is blocked by this app's strict CSP regardless of
  what `script-src` allows, and this static site has no per-request value to
  mint a CSP nonce from.
- Documented: `apps/storefront/.env.example`, `apps/storefront/README.md`,
  and `docs/deployment.md` (+ `.id.md`) gain "the two switches" a deployer
  needs — `apps/cms`'s own `VISITOR_ANALYTICS_ENABLED` (whether anything is
  actually recorded) and `apps/storefront`'s `PUBLIC_GA_ID` (whether GA4 is
  additionally on) — independent of each other, both off by default.

### Sync `apps/cms` from upstream `ahliweb/awcms` — institution logo, SVG safety scan

`git subtree pull --prefix=apps/cms awcms main`, merged with a merge commit
(the one rule AGENTS.md protects every future sync with), bringing
`apps/cms` from the v10.3.0 embed point (`749404d4`) to upstream `main`
`4e049743` — awcms PR #807, opened for awcms-one issue #59 (C1, "Logo
Instansi").

- `awcms_blog_institutions` gains `logo_media_id`/`logo_alt` (`sql/153`),
  exposed as `logoMediaId`/`logoAlt` on `/api/v1/blog/institutions`; the
  storefront renders it in issue #59's step 3.
- `media_library` now recognises SVG uploads at all (its sniffer never
  matched SVG's shape before) and scans them with a denylist — script
  elements, event handlers, `javascript:`/`data:` URIs after
  character-reference decoding, any `<!ENTITY` declaration.
- Upstream's `js-yaml`/`smol-toml`/`svgo` override bumps ride along.

Only felt while developing:

- The seven generated-document conflicts (`repo-inventory.md`,
  `PROJECT_STATE.*`, `ARCHITECTURE.*`, `.claude/skills/README.*`) were
  resolved by keeping this repo's copy and re-running upstream's generators,
  exactly as AGENTS.md's divergence rule prescribes; `prettier --write` on
  the regenerated tables and on `commerce/README.id.md` was needed for
  `bun run lint`.
- `sql/153_awcms_blog_institution_logo.sql` (upstream) now sits beside this
  repo's `sql/153_awcms_commerce_schema.sql`. The migration runner keys by
  full filename and applies both in lexical order, so nothing breaks — but
  every upstream migration from here on will share a number with a commerce
  one until the commerce migrations move out of upstream's range, which is
  tracked as a follow-up issue.

## [0.3.0] — 2026-09-17

### `bun run check:cms` is green again inside the subtree embed

`apps/cms/tests/version-check.test.ts` asserted that more than 20 git tags were examined — true in a clone of `ahliweb/awcms`, false by construction here, where `git tag` answers with this repo's own `v0.x` line and upstream's tags are deliberately never fetched. The whole CMS gate chain was red on a clean `main` because of it (issue #22).

- The non-vacuity floor is skipped only when `apps/cms` is embedded inside a larger repository; the namespace-conformance and version-not-behind assertions still run.
- `AGENTS.md` now carries a "known local divergences" list under the subtree section, so the next `git subtree pull` conflict on this file is expected rather than a surprise.

### Commerce transactional surface: customers, addresses, orders, payment confirmations, reviews

The transactional half of mart.borneojek.com — customers, addresses, cart quoting, orders and their lifecycle, payment confirmations, reviews (issue #29, epic #21) — plus the **anonymous, cross-origin storefront API** a statically built site calls from the browser with no bearer token, the same pattern already hardened for newsletter/site-search/comments.

- Eight new tables `awcms_commerce_{customers,customer_addresses,orders,order_items,order_events,payment_confirmations,reviews,wishlists}` (`sql/165`–`167`), 7 new permissions (`orders`/`customers`: `read`/`update` only — no admin route creates or hard-deletes either; `reviews`: `read`/`update`/`delete`), 7 new domain events (`order.{created,paid,status_changed,cancelled,expired}`, `voucher.redeemed`, `review.published`), one new scheduled job (`commerce:orders:expire`), 3 new admin screens.
- `domain/cart-quote.ts` composes #23's price calculation and #26's voucher arithmetic in the exact order the storefront contract specifies: subtotal → voucher discount → shipping (zeroed by voucher or store threshold) → insurance (`max(minFee, subtotal × ratePercent)`) → tax (percent of subtotal − discount) → total — every figure a `numeric(14,2)` string, integer-cent arithmetic throughout.
- Anonymous routes under `/api/v1/commerce/storefront/*`: cart quote, order creation (idempotent by a client-supplied key, re-quoting the cart inside the write transaction), order tracking (`orderCode` + phone as the credential, checked inside the query — an unknown code, a wrong phone, and another tenant's order all answer the same neutral 404), payment confirmations, cancel, reviews. Tenant is resolved from the request Origin/Host through `awcms_tenant_domains`, never a caller-supplied header.
- Idempotency reuses the shared `awcms_idempotency_keys` store (it needs only a tenant id, not a principal) rather than a bespoke column. Payment-proof upload answers `503 MEDIA_UNAVAILABLE` in this increment — the existing upload-session flow requires an authenticated principal a guest checkout does not have, and building a second, unreviewed anonymous auth seam for it was judged out of scope; a payment confirmation without a proof image is still fully accepted, and the public store-settings read model now says `payment.proofUpload: false` so the storefront hides the control.
- Customers are guest-checkout rows identified by phone (E.164, kept in the clear — it is also the tracking credential) — real personal data, but not addressable by this codebase's own ADR-0094 subject vocabulary (`tenant_user`/`identity`/`profile`), since there is no account behind a phone number yet (accounts are issue #32). All eight new tables are therefore `unreachableBySubject: true`, the same shape `commerce.testimonials` already uses for free-text personal data with no subject-id column — a genuine erasure/export request is handled as an ordinary admin lookup, outside the automated engine's scope by construction.
- `tools/seed-borneojek-mart.ts` registers the tenant's storefront origins in `awcms_tenant_domains` (manually attested `active`, the one place this script reaches Postgres directly instead of through HTTP — a fresh domain otherwise starts `pending_verification` and this script has no real DNS record to prove) and seeds one customer with two orders in different states (`pending_payment`, `paid`) through the anonymous order-creation path itself.

### Commerce marketing surface: flash sales, vouchers, sliders, testimonials, promo popup, store settings

Everything mart.borneojek.com's home page and promotions run on, as tenant-scoped tables in the one `commerce` module (issue #26, epic #21) — with a public read model per family that `apps/storefront` bakes the home page from, and six admin screens.

Why one module rather than three (the decision is recorded by issue #31, https://github.com/ahliweb/awcms-one/issues/31): every admission touches the same shared registries, and an order references products, flash-sale prices and vouchers as one aggregate.

- New tables `awcms_commerce_{flash_sales,flash_sale_products,vouchers,sliders,testimonials,popups,store_settings}` (`sql/161`–`164`), 22 new permissions, two flash-sale events fired by the `commerce:flash-sales:tick` job, 20 new OpenAPI operations.
- Voucher arithmetic is exact (integer cents, `maxDiscount` cap); `POST …/vouchers/validate` is a read — redemption belongs to the order (#29). Flash-sale status is derived from the window and persisted by the tick, never trusted from the column. At most one active popup per tenant, enforced by a partial unique index.
- Store settings are one versioned `jsonb` document per tenant; the public read model never carries a bank account number, holder, or QRIS reference. `DELETE` resets to defaults by stamping `deleted_at`, which is also what lets the singleton answer the retention question with a column rather than an exemption.
- Two #23 follow-ups: `downloadLink` (a digital product's paid asset) leaves the public product DTO for the admin record; `sizeChartImageUrl` joins it.
- Two latent defects found while proving the seed end to end: batch reads of images/variants bound a JS array straight into `= ANY(…)` (fails on two or more ids — now `tx.array(…)::uuid[]`, with a regression test); and `Bun.SQL` decodes a stored `0.00` as `"0"` through a parameterised query — every money field now passes through `normalizeMoney` so the wire shape is always two decimals.
- `tools/seed-borneojek-mart.ts` applies the #23 product fields and variants, seeds one flash sale, two vouchers, three testimonials, one popup and the live store-settings block (bank account a placeholder), and issues the storefront build credential with every marketing `read`. Product images and sliders stay recorded under `future`: both need a media object, and media objects need the R2-backed upload session.

### `commerce` reaches full BjekMart product-model parity

Issue #23 (part of epic #21) brings `apps/cms`'s `commerce` module from Issue #4's
13-column catalog core to the full legacy `commerce_bj_mart.products` shape, and
gives it the two related tables a real product page cannot render without.

- `awcms_commerce_products` gains every column Issue #4 deliberately deferred:
  tiered pricing (`price_level_2/3/4`), admin-only `cost_price`, weight,
  minimum purchase, manual rating/sold-count, insurance, promo banners, a size
  chart (image or table), a service intake form, subscription period, a
  digital download link, deposit/free-shipping flags, variant attributes, and
  explicit `is_featured`/`is_recommended` merchandising flags.
- Two new tables, `awcms_commerce_product_images` and
  `awcms_commerce_product_variants`, with their own CRUD routes under
  `/api/v1/commerce/products/{id}/{images,variants}`. `commerce` now depends
  on `media_library` so a product image's public URL resolves through
  `MediaLibraryPort`, the same capability `blog_content` already consumes.
- `GET /api/v1/commerce/products` gains `?categoryId=&status=&q=&sort=&
  featured=&recommended=` filters; every product response carries a
  server-computed `finalPrice` (exact integer-cents arithmetic, never a
  float) plus resolved `images[]`/`variants[]`. A new
  `GET .../products/by-slug/{slug}` route serves the storefront's detail
  fetch. `GET /api/v1/commerce/categories` gains `?parentId=` and a computed
  `productCount` per row.
- Restore endpoints for both categories and products
  (`POST .../{id}/restore`), the shape `office-directory.ts` already
  established, with a new `restore` permission on both activity codes.
- `/admin/commerce` is now a full product CRUD screen (filters, create/edit,
  an images picker sourced from the media registry, a variants editor,
  status transition, soft delete, restore); `/admin/commerce-categories` is
  a new category CRUD screen. Both are off `NOT_YET_SCREENED`.
- `packages/kontrak` re-exports the four new unions (`SizeChartType`,
  `SubscriptionPeriod`, `ServiceFormFieldType`, `ProductSort`) from
  `apps/cms`'s `domain/*.ts`, type-only, per ADR-0004.

Deliberate scope decisions, recorded here for #31 to fold into the schema/API
docs:

- `awcms_commerce_categories` also gained a `restored_at` column (the issue's
  own column table only listed it for products) — both restore endpoints need
  the same "when" fact, and this module's README already treats
  `awcms_offices`' restore shape as the precedent for both tables alike.
- Keyset pagination (`cursor`/`nextCursor`) stays scoped to the default
  `sort=newest`; `price_asc`/`price_desc`/`name` return a single bounded page
  (`PRODUCT_LIST_LIMIT` = 100, `nextCursor: null`) rather than a keyset walk
  ordered by a second column.
- `sizeChartMediaId`/a variant's `imageMediaObjectId` are validated as
  UUID-shaped only, not checked for live/verified existence — unlike a
  product IMAGE row's `mediaObjectId`, which is the one write path this issue
  checks against `MediaLibraryPort.isMediaReferenceSafe` before insert. A
  stale/foreign id in either scalar field simply resolves to no public URL at
  render time; RLS still keeps it from crossing a tenant boundary.
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` raised
  218,000 -> 219,000 B for the two admin screens' client script (4,974 B,
  measured on a clean build) — no new CSS, both screens reuse the existing
  admin design-system classes.

### Local PostgreSQL via docker compose, seed the BjekMart tenant, CI job for check:cms

Increment 2 needed a real PostgreSQL somewhere before `apps/cms` could migrate, run, or be seeded at all — issue #1's epic explicitly deferred it past increment 1's no-database foundation. This closes that gap for local development and CI, without touching production provisioning (still not done — see `docs/deployment.md`).

- `compose.yaml` + `docker/postgres-init/` — a disposable `postgres:18.4`, project `awcms-one`, host port 5433. Creates ONLY the `LOGIN` half of the three roles `apps/cms`'s own migrations (`sql/019`, `sql/022`) already create `NOLOGIN` and passwordless on purpose; every `GRANT` stays the migrations' job.
- `bun run db:up` / `db:down` / `db:reset` — new root scripts.
- `tools/seed-borneojek-mart.ts` (`bun run db:seed:cms`) — an idempotent HTTP client of `apps/cms`'s own `/api/v1/*` surface (never a direct import of its internals, since that module is mid-flight on another branch). Bootstraps the `borneojek-mart` tenant + owner, the 8-category catalog, one representative product per commerce `type`, a handful of blog terms/pages/posts, the site profile, and a read-only machine credential scoped to `commerce.products.read`/`commerce.categories.read` — the same shape `apps/storefront`'s build token needs. `tools/seed-data/*.json` separates each resource's `current` (what the API accepts today) from `future` (images, variants, `service_form`, `subscription_period`, tiers — issue #23's fields), so landing those is a data change, not a script restructure. `tools/seed-assets/` carries small, self-generated SVG placeholders for the extension point — no downloads from the live site.
- `.github/workflows/ci.yml` — new `check-cms` job (`needs: check`, `timeout-minutes: 20`): `apps/cms`'s own full `bun run check` against `DATABASE_URL=""`, then migrate + `bun test tests/integration/` against a real `postgres:18.4` service, with a job-summary line recording the DB-gated skip count before and after. Not yet a required status on `main` — `docs/alur-kerja-pengembangan.md` records the exact `gh api` command and the "green twice in a row" condition for a maintainer to run it.
- `docs/deployment.md` — the full local sequence, in order, with real values; what the seed script deliberately does not seed (legacy shipping/payment/customer-level settings with no API surface today) and why.
- `docs/alur-kerja-pengembangan.md` — the CI section now describes both jobs.
- Root `.env.example` — every new variable (`POSTGRES_*`, `AWCMS_*_PASSWORD`, `AWCMS_BASE_URL`, `SEED_*`), each with the consequence of leaving it unset.

### Storefront catalog parity: home, listing, category, flash sale, product detail

The public storefront now matches mart.borneojek.com's catalog surface end
to end, still static (ADR-0002): a real home page (slider, popular
categories, a flash-sale strip with a live countdown, featured/recommended
products, a promo section, a public-voucher strip, testimonials, recent
news, a promo popup), `/produk` (grid + sidebar, client-side search/filter/
sort/paginate over a build-time JSON index), `/kategori/[slug]`,
`/flash-sale`, and a full `/product/[slug]` (image gallery, tiered pricing,
variant picker, service-form fields, "Tambah ke keranjang", share buttons,
related products, structured data).

Why this shape rather than a thinner slice: increment 1 (issue #5) proved
the stack with a bare catalog grid and a minimal detail page — this closes
the gap to what a shopper on the live site actually sees, using the full
product/category model issue #23 landed and the marketing read models issue
#26 is landing in parallel (every marketing fetch is isolated to
`apps/storefront/src/lib/awcms/pemasaran.ts` and tolerates a 404 until then).

- The `localStorage` cart contract issue #30 builds on:
  `apps/storefront/src/lib/keranjang-kontrak.ts` — key `awcms-one:keranjang:v1`, shape
  `{id, lines, updatedAt}`, event `keranjang:berubah` dispatched on every
  write. Replaces increment-1's placeholder `"cart"` array key.
- Price display moved to `apps/storefront/src/lib/harga.ts`, the only place a price string
  is ever converted to a number — grep-guarded by a unit test over `src/`
  (ADR-0003).
- **The CSP now carries one exemption, derived rather than configured.**
  Product photos live on the CMS's public media origin, which a bare
  `img-src 'self'` blocks silently — correct HTML, green build, broken
  page. `apps/storefront/src/pages/csp.json.ts` writes the origins this build actually
  references to `dist/client/csp.json`; `apps/storefront/server/penyaji.mjs` reads it once
  at startup, re-validates every origin, and widens `img-src` by exactly
  those. A missing or malformed artifact degrades to the baseline policy
  (images stop rendering) rather than to a wider one.
- `BaseLayout.astro` gained a single `head` slot, last in `<head>`, for the
  per-page tags the layout does not model; `/cari` uses it for
  `noindex, follow` alongside the existing `Disallow: /cari` (the two do
  different jobs — one stops the fetch, the other stops the indexing).

### Storefront cart, checkout, order tracking, and wishlist

The storefront can now place a real order while staying 100% static
(ADR-0002 intact): no `prerender = false`, no runtime credential. This is
the architecture revision tracked at
https://github.com/ahliweb/awcms-one/issues/31 (to be recorded there as an
ADR — draft text is in this change's own pull request description): the
browser calls the CMS's anonymous, cross-origin storefront commerce
endpoints directly (`/api/v1/commerce/storefront/*`, issue #29's own
contract — awcms ADR-0103/0107/0118's established pattern, the same one the
newsletter form, site search, and comments already use), the CMS resolves
the tenant from the request `Origin`, and answers with CORS — never a
cookie, never a bearer token.

- **`PUBLIC_AWCMS_ORIGIN`** — the one new build-time variable, deliberately
  `PUBLIC_`-prefixed (an origin is not a secret) unlike `AWCMS_API_TOKEN`.
  `apps/storefront/src/lib/awcms/toko-origin.ts` validates it and is called
  from `apps/storefront/src/pages/csp.json.ts` — a page every build
  unconditionally prerenders — so an unset or malformed value **fails the
  build**, naming the variable, rather than shipping a checkout page that
  silently posts nowhere. The CSP's `connect-src` gains exactly this one
  origin, via the SAME artifact mechanism issue #27 built for `img-src`
  (`csp-asal-media.ts`'s `connectSrc` field, unused until now) — no second
  mechanism.
- **`apps/storefront/src/lib/toko-klien.ts`** — one function per endpoint
  (quote, create order, track, confirm payment, upload-session/finalize,
  cancel, review), every request `mode: "cors"` / `credentials: "omit"` /
  only a `Content-Type` header, envelope unwrapped into a typed
  `TokoApiError` carrying `code`/`details` (field errors, a fresh quote on
  `CART_CHANGED`, `Retry-After` on `RATE_LIMITED`).
- **`/keranjang`** — renders the `localStorage` cart (issue #27's contract),
  re-quotes it live, flags stale price/stock/min-purchase inline (never
  silently corrects), voucher code, quantity/remove, "Lanjut ke checkout".
- **`/checkout`** — one page, five progressively-disclosed steps (contact →
  address → shipping → payment → review); address regions come from
  `apps/storefront/src/lib/awcms/wilayah-checkout.ts`, baked at BUILD time
  into `/index/wilayah-{provinsi,kabupaten-*,kecamatan-*}.json`
  (`PUBLIC_WILAYAH_PROVINSI`, default every Kalimantan province) rather than
  the national ~90,000-village dataset; `VALIDATION_ERROR.details[].field`
  maps to an inline error next to the field it names.
- **`/pesanan`** — order tracking by `?kode=`; the phone comes from
  `sessionStorage` or a form, **never the URL**; status timeline, payment
  instructions while `pending_payment`, a countdown to `expiresAt`, a
  payment-confirmation form, cancel while cancellable.
- **`/wishlist`** — `localStorage`-only; `ProductCard.astro` gains an
  additive `[data-wishlist]` heart button, wired site-wide by
  `apps/storefront/src/scripts/wishlist-tombol.ts` (imported once from
  `Header.astro`, the same way the cart-count script already is).
- Every script above is an external module; every page has a `<noscript>`
  fallback offering a WhatsApp order link
  (`apps/storefront/src/lib/wa-fallback.ts`), is keyboard-reachable, uses
  `aria-live="polite"` for quote/status updates, and carries
  `noindex, follow` via the `head` slot issue #27 added.
- `apps/storefront/scripts/stub-awcms.mjs` (local/CI verification only,
  never shipped) gains a small in-memory state machine for the same
  storefront endpoints, built against the identical #29⇄#30 contract
  document the CMS agent implements in parallel — plus proper
  `level`/`parentCode` filtering for `/api/v1/idn-regions/regions`, which
  the fixture's second province/district rows now need.
- Browser-level Playwright coverage (`apps/storefront/tests/e2e/`, run by
  its own `bun run test:e2e` inside `apps/storefront` — never the root
  `bun test`) exercises add-to-cart → quote → checkout → tracking, and the
  neutral not-found state for a wrong phone.

Deviation from the issue's literal file naming: the cart page's script is
`apps/storefront/src/scripts/keranjang.ts` (matching every other page-level
script's location), not the src/lib-rooted path one line of the issue body
named for it — every interactive script in this app already lives under
`apps/storefront/src/scripts/`, and the issue's own "every script is an
external module" sentence agrees with that location, not the one-off
mention.

### Storefront site chrome + foundation

`apps/storefront` gains the shared shell every future page needs before it
can be a page: header/nav/search/footer, site identity and brand colors
read from `apps/cms` at build time, static/contact pages, and the
sitemap/robots/feed/manifest surface a public site needs (issue #24).

- Header/footer/mobile-nav, a `<main id="konten">` landmark, and a skip
  link, all built from a new route-constants module — so #27/#28/#30 only
  add pages, never touch the chrome again.
- Site identity (`GET /api/v1/site-profile/composed`) and brand colors
  (`GET /theming/{tenantCode}/tokens.css` — corrected from the issue's
  originally named `GET /api/v1/theming`, which cannot answer this question;
  see `apps/storefront/README.md`) replace the old hardcoded `SITE_NAME`/
  footer, degrading to BjekMart's own public defaults when the CMS has
  nothing rather than failing the build.
- New pages: `/kontak`, `/halaman/[slug]` (CMS pages rendered from Portable
  Text), `/cari`, `/404`.
- New build-time surfaces: `robots.txt`, `sitemap-index.xml`/
  `sitemap-[n].xml` (a registry, so later issues register their own URLs
  without touching this issue's files again), `feed.xml`,
  `manifest.webmanifest`, `theme-tokens.css`.
- `apps/storefront/server/penyaji.mjs` gains `GET /healthz` (reports the
  build id written by a new build step) and a `Link: rel=preload` header
  for the build's CSS — still no `AWCMS_*` read at runtime.
- Two deliberate scope trims, recorded in `apps/storefront/README.md`: no
  CMS-uploaded logo/favicon image is resolved (this app has no
  media-object client, and product/media imagery stays out of scope for
  this re-platform slice), and `/kontak` has no maps iframe or FAQ
  accordion — neither field exists on the real `site_profile` schema.

### Storefront news surface (article/rubrik/daerah/mitra/video/tag/search)

`apps/storefront` gains the seputarborneo/beritasampit-parity news surface
over `apps/cms`'s `blog_content` module: `/berita` (front page + article
detail + RSS), a hierarchical `/rubrik/{slug}` archive (with pagination and
its own feed), `/daerah/{slug}` (region archive, reached via an
institution's region), `/mitra/{slug}` (institution landing), `/video`
(posts carrying a `videoNews` block), `/tag/{slug}`/`/penulis/{slug}`/
`/arsip/{yyyy}/{mm}`, and `/cari-berita` (client-side search over a
build-time index) — issue #28.

- `apps/storefront/src/lib/berita.ts` is the new domain layer (mirrors
  `apps/storefront/src/lib/catalog.ts`'s shape: one memoized,
  once-per-build index); `apps/storefront/src/lib/awcms/{blog,wilayah,
  lembaga,iklan}.ts` are the raw, field-verified fetchers, every shape
  checked against the actual route/application code rather than the issue
  text or the OpenAPI doc alone.
- `apps/storefront/src/lib/portable-text.ts` (issue #24) is EXTENDED, not
  replaced: a well-formed `videoNews` block now renders a real, semantic
  outbound link (never an `<iframe>` — this app's CSP has no exemption for
  one, and widening it is outside this issue's scope) and a captioned
  `gallery` item renders a real `<figure>`/`<figcaption>` (never an
  `<img>` — still no media-object client). Every one of issue #24's own
  existing assertions in `apps/storefront/tests/portable-text.test.ts`
  still passes unmodified.
- A static legacy-URL redirect map (seputarborneo's `/news/{id}-{slug}.html`,
  beritasampit's `/{yyyy}/{mm}/{dd}/{slug}/`) is baked at build time
  (`apps/storefront/src/lib/pengalihan-legacy.ts`,
  `apps/storefront/src/profil/berita/pages/index/pengalihan-legacy.json.ts`) from
  `apps/cms`'s own `awcms_seo_redirects` (`origin: "legacy_blog"`) and
  applied by a new, additive hook in `apps/storefront/server/penyaji.mjs`
  — read once at server startup, never at request time.
- A guard test (`apps/storefront/tests/berita-guard-no-news-route.test.ts`)
  asserts no `/news/**` route family is ever introduced — that vocabulary
  is reserved by awcms ADR-0071 for `ahliweb/awcms-astro`, not this
  storefront.
- Six deliberate scope trims, recorded in `apps/storefront/README.md`'s new
  "News surface" section: no hero/gallery/ad-creative `<img>` and no
  YouTube `<iframe>` embed (no media-object client, and CSP widening is
  outside this issue's file ownership); no `article:published_time`/
  `rel=prev/next`/`noindex` (`BaseLayout.astro` has no head-extension
  mechanism); "Terpopuler" is always "latest" (no `visitor_analytics`
  endpoint in this issue's verified scope); no footer ad slot (none exists
  server-side); a region's slug is derived from its name (no CMS-issued
  one); "internal tag links" needed no renderer change (awcms's own
  auto-linking is a CMS-side render-time transform, not an authored node).

### Increment-2 documentation refresh: ADR-0007..0010, mirrors, root skills, knowledge graph

Every root `docs/**` document, `README.md`/`AGENTS.md`/`SECURITY.md`, and `knowledge/curated/monorepo-map.md` described the repository as it stood after increment 1 (issue #1's slice: catalog listing + product detail, no live database). Nine implementation PRs (#34–#42, epic #21) since landed the full BjekMart/news-portal parity increment — a provisioned PostgreSQL, the complete `commerce` module (catalog depth, marketing, orders), and the complete public storefront (catalog, news, cart, checkout, order tracking, wishlist) — without a single governance document catching up. A reader following this repository's own documentation would have been told cart, checkout, and orders "do not exist yet" on a `main` where they had shipped weeks earlier.

- Rewrote every root `docs/**` document against the merged tree, verified file-by-file against the code rather than the original issue text (`arsitektur.md`, `api.md`, `cms.md`, `routing.md`, `pengujian.md`, `skema-basis-data.md`, `kamus-data.md`, `aksesibilitas.md`, `responsif.md`, `ui-ux.md`, `seo.md`); reconciled `deployment.md` and `alur-kerja-pengembangan.md` with the ops/marketing/orders PRs that postdated them.
- Added four ADRs: ADR-0007 (cart/checkout/order-tracking stay static; the browser calls `apps/cms`'s anonymous commerce endpoints directly — the revised decision from the epic's amendment), ADR-0008 (one `commerce` module, not three), ADR-0009 (guest checkout by order code + phone), ADR-0010 (manual payment and alternative courier first, gateways via outbox) — each with its Indonesian mirror, and `docs/adr/README.md`'s index updated both ways.
- Rewrote `README.md`/`AGENTS.md`'s "what is here today, and what is not" sections and gates tables for the current tree (the `check-cms` CI job, both `Check` and `check-cms` as required status checks, the local subtree divergence list); rewrote `SECURITY.md`'s attack-surface section to cover the storefront's anonymous commerce endpoints, the derived CSP, and rate limits.
- Added `.claude/skills/awcms-one-storefront` and `.claude/skills/awcms-one-commerce` (+ Indonesian mirrors, + a root skills index) — practical how-tos for adding a storefront page and a commerce table/endpoint, mirroring `apps/cms/.claude/skills/awcms-new-endpoint`'s format.
- Updated `knowledge/curated/monorepo-map.md`'s structural map for the current workspace layout.

Nothing here changes runtime behaviour; every change is documentation.

## [0.2.0] — 2026-09-15

### Architecture and reference documentation, describing the merged tree as it actually is

Adds `docs/` (issue #7): architecture, six ADRs, the database schema, a data dictionary mapping every `awcms_commerce_*` column to its legacy `commerce_bj_mart` source column, the commerce API, the CMS authoring workflow, storefront routing, SEO, accessibility, responsive design, UI/UX, testing, deployment, and the development workflow — plus `docs/README.md` as the index. Every document is mirrored to Indonesian (`docs:i18n:stamp`) and lands with `AGENTS.md`/`README.md` updated to describe the tree as it now is: every child issue of #1 (#2, #4, #5, #6, #11) has landed, so the "not here yet" framing both documents carried is retired.

- `bun run audit:dokumen`'s ADR-index and `ADR-NNNN`-citation checks run for real for the first time in this repository, now that `docs/adr/` exists — both green against the six ADRs landed here.
- Where the tree disagreed with the original issue text, the documents follow the tree: the URL shape (`/product/{slug}`, per the live-site evidence on issue #5), the real API envelope (`{ items, nextCursor }`, not the originally assumed shape), and the real, verified branch-protection settings (a required `Check` status check; no merge-strategy restriction) are what is documented, not what was planned.
- A pre-existing, unrelated defect surfaced by activating the ADR-citation check for the first time — a generated Obsidian note under `knowledge/generated/graphify/` extracts `packages/gerbang/audit-dokumen.mjs`'s own illustrative example (`` `ADR-0042` ``) as a false citation — is filed as [issue #15](https://github.com/ahliweb/awcms-one/issues/15) rather than patched here, since fixing it needs a change to `packages/gerbang/` or a knowledge-graph regeneration, both outside this change's own scope.

### audit:dokumen no longer reads knowledge/generated/

`bun run audit:dokumen` now skips `knowledge/generated/` the way it already skips `apps/cms/` (issue #15). Graphify's Obsidian export extracts notes from source code; it does not author them. The first false positive was concrete: the moment `docs/adr/` existed, the ADR-citation check fired on three generated notes quoting the gate's own illustrative example citation (a placeholder ADR number in a comment in `packages/gerbang/audit-dokumen.mjs`). Every other check in the gate would misfire on generated notes the same way — their links are wikilinks the gate does not parse, and a stale path in one is graph staleness, which `bun run audit:graf` deliberately leaves alone. `knowledge/curated/` and `knowledge/README.md` are authored and stay in scope; two fixture tests pin both sides of that line.

### apps/cms: the `commerce` module — catalog domain, persistence, migrations, API

Adds the `commerce` module to the embedded CMS (issue #4): categories (hierarchical) and products, the catalog core of the legacy `commerce_bj_mart` schema, as `awcms_commerce_categories` and `awcms_commerce_products` under PostgreSQL row-level security, with `GET`/`POST` list-and-create and `GET`/`PATCH`/`DELETE` by id at `/api/v1/commerce/{products,categories}`, an OpenAPI fragment, three domain events, and a read-only `/admin/commerce` screen.

- Every table is `ENABLE` **and** `FORCE ROW LEVEL SECURITY` with a `tenant_id = current_setting('app.current_tenant_id')` policy. Proven, not declared: as the unprivileged `awcms_app` role, a query with no tenant context fails closed and an insert whose `tenant_id` differs from the session tenant is refused by the policy.
- `price` is `numeric(14,2)` and stays a **string** through the directory, the DTO, and the API — never a JS `number`. `discount_percent` and `stock` are `integer` with `CHECK` bounds.
- `status` (`draft`→`active`→`inactive`→`archived`, with legal transitions in the domain layer) and `deleted_at` are independent axes: unavailable-for-sale and deleted-by-the-merchant are different states.
- Migrations `sql/153`–`sql/155`. The full chain `001`→`155` was applied from an **empty** database, which is what a real deployment does. `sql/155` grants the lifecycle worker the rights the generic purge engine needs; `cursorColumn: "deleted_at"` means that engine is mathematically unable to purge a live row.
- Twenty-nine upstream files in `apps/cms/` are modified — the module registry, the event-type registry, the AsyncAPI and OpenAPI catalogues, the sidebar registry, the admin-screen coverage ledger, and the generated inventories and module-count lines that awcms's own `check` chain regenerates or enforces when a module is admitted. Each one is a future `git subtree pull` conflict point; the resolution is to re-run the generators after a sync, not to hand-merge generated output.
- The list endpoints return the awcms house envelope `{items, nextCursor}`; the storefront's local assumption of `{products}` / `{categories}` is reconciled in issue #6.

### Federated knowledge-graph workflow: root Graphify graph, `audit:graf`, safe Obsidian export

Adds a monorepo-level Graphify + Obsidian workflow (issue #11) without duplicating or corrupting the Graphify state already embedded inside `apps/cms` via the `ahliweb/awcms` subtree. Two graphs, federated on demand rather than one graph built twice — the same discipline the rest of this repo already applies to `apps/cms`'s own tree.

- Root `.graphifyignore` + a real, committed root graph (`graphify-out/graph.json`, 396 nodes) built `--code-only` — structural AST extraction, no LLM, no API key, no network, ever, by default. Excludes `apps/cms/**`, which already owns its own graph and its own gate.
- `bun run audit:graf` (alias `knowledge:check`) — the fourth `audit:*` gate, modelled on `apps/cms/scripts/graph-artifacts-check.ts`: tracked-artefact hygiene, report/graph agreement, chosen community names, `.graphifyignore` still excluding `apps/cms`, no duplicate-extracted node, the federated graph never tracked, and `apps/cms/graphify-out/` untouched by this repo's own tooling. Runs in CI (`.github/workflows/ci.yml`) — it reads only committed artefacts, no `graphify` installation needed.
- `bun run knowledge:graph:combine` — merges the root graph with `apps/cms/graphify-out/graph.json` into a gitignored, on-demand `graphify-out/combined/graph.json`, failing closed on a missing, malformed, empty, or `directed`-mismatched component graph (checks `graphify merge-graphs` itself does not make).
- `bun run knowledge:obsidian:export` — stages the root graph's Obsidian export, validates every file (rejecting a symlink, an unexpected extension, path traversal, or a curated-filename collision), and syncs only the allowlisted result to `knowledge/generated/graphify/`. `knowledge/curated/` is read only for collision-checking, never written.
- `packages/gerbang/lib/subtree-guard.mjs` guards every write both new tools perform; `tests/knowledge-no-subtree-write.test.mjs` runs both tools for real against a fixture tree and proves `apps/cms/` comes out byte-for-byte unchanged.
- `knowledge/README.md` + five thin `knowledge/curated/*.md` files record what code alone cannot state: ownership boundaries, cross-repo source-of-truth rules, the tracked/untracked table, and a nine-item threat model — no ISO/IEC certification claimed.
- `README.md`/`AGENTS.md` (and their Indonesian mirrors) revisit the earlier, now-outdated statement that `audit:graf` was not ported — it is, and both documents say why and what changed.

### packages/kontrak: the type-only DTO contract, and the storefront reconciled to the real envelope

Adds the fifth workspace member, `@awcms-one/kontrak` (issue #6): `ProductType`/`ProductStatus` re-exported, `export type` only, from `apps/cms`'s commerce domain layer (`apps/cms/src/modules/commerce/domain/{product-type,product-status}.ts`) — never hand-copied again. `tests/kontrak-arah-impor.test.mjs` guards the one-way import direction (`storefront -> kontrak -> cms`) that keeps `apps/cms`'s `git subtree pull` safe: a dependency pointing back at this repo's own code would turn every future sync into a merge conflict against code upstream never wrote.

Reconciles `apps/storefront/src/lib/catalog.ts` against the real commerce API that landed with issue #4, closing four mismatches a side-by-side review of the two merged PRs surfaced:

- Both list responses are read as `{ items, nextCursor }` — the awcms house keyset-page shape — not the invented `{ products }` / `{ categories }` this app shipped with, which would have crashed the build on `undefined`.
- Categories are now keyset-paginated with the same cursor walk products already use, not fetched as a single unpaginated page.
- `status` and `limit` are no longer sent as query parameters — the CMS route accepts only `cursor` and fixes the page size server-side; sending parameters it silently ignores was a lie in the request log.
- `getProducts()` now filters with an exhaustive `switch` (`isPubliclyVisible`) instead of a bare `status === "active"` comparison, so a `ProductStatus` `apps/cms` adds later cannot silently fall through — verified by hand: widening the union in a worktree turned `bun run check` red at that exact line (the captured error is in this change's pull request description).

`CommerceProduct`/`CommerceCategory` — the row DTO shapes — stay declared locally in `catalog.ts` rather than moving into `@awcms-one/kontrak`: they live in `apps/cms/src/modules/commerce/application/{product,category}-directory.ts`, not `domain/`, so they are out of that package's scope by its own rule (`application/` may carry I/O-bearing imports on other lines of the same file).

Fixtures (`apps/storefront/tests/fixtures/awcms/*.json`) and `apps/storefront/scripts/stub-awcms.mjs` now emit the real envelope too, so the offline build proof against the stub is honest rather than agreeing with the bug it used to ship with.

### Monorepo foundation: audit gates, release tooling, governance docs, and CI

Stands up the machinery `apps/storefront` (issue #5) and `packages/kontrak` (issue #6) will land into, modelled on `ahliweb/media-lenterakalteng`: `packages/gerbang`'s three audit gates (`audit:dokumen`, `audit:rilis`, `audit:translation`), `tools/rilis.mjs` + `cek-lockfile.mjs` + `docs-i18n-stamp.mjs`, the `.changesets/` convention itself, every governance document with its Indonesian mirror, and a CI workflow that runs the check job unconditionally.

- `bun install` resolves the workspace; `bun test` from the root is green and does not execute anything under `apps/cms/` (already excluded via `bunfig.toml`, proven here rather than merely trusted).
- Content, asset, and crawl gates (`audit:konten`, `audit:aset`, `audit:graf`, `audit:serapan`) are deliberately **not** ported: this repository has no built content, asset, or crawl surface yet for them to guard. Porting them now would ship gates that always pass trivially, which is worse than not having them — a green gate that checks nothing reads exactly like one that checked something and found it clean.
- `AGENTS.md` records the `git subtree` sync discipline for `apps/cms`: a subtree-sync PR must be merged with a merge commit, never squashed or rebased, or the next `git subtree pull` loses the merge base it needs.

### apps/storefront: the public catalog and product-detail storefront

Adds the fourth workspace member, `apps/storefront` (issue #5): an Astro app with `output: "static"` that fetches the catalog from `apps/cms` at **build** time and bakes it — the running container holds no API token and never reaches the database. Catalog at `/`, product pages at `/product/{slug}` with no trailing slash, matching the live `mart.borneojek.com` URL shape so indexed URLs, bookmarks, and shared links survive the cutover unchanged; `/products` (with or without a query string) 301s to `/`.

- `price` is carried as the `numeric(14,2)` **string** PostgreSQL emits and formatted only for display with `Intl.NumberFormat`; nothing in the app parses it into money arithmetic.
- The build fails loudly on a non-2xx, a `{success:false}` envelope, a catalog where no product is `active`, or a cursor that never terminates — a storefront that silently publishes an empty catalog is worse than a red build.
- CSP-strict by construction: `inlineStylesheets: "never"` and `assetsInlineLimit: 0`, so no inline `<style>`, `<script>`, or `data:` URI is ever emitted. CMS-supplied `labelColor` badges are compiled into a generated external stylesheet (`product-labels.css`) rather than inline styles, with a WCAG-contrast-chosen foreground.
- JSON-LD is written through an escaper that turns `<`, `>`, `&` into `\uXXXX` after `JSON.stringify` — the HTML parser closes a `<script>` at the first `</script>` regardless of `type`, so a product name containing one would otherwise break out of the data block. A committed fixture (`XSS-REGRESI-01`) guards it.
- The build is reproducible offline against `apps/storefront/scripts/stub-awcms.mjs` + `apps/storefront/tests/fixtures/awcms/`.
- The DTO unions are declared locally for now; issue #6 replaces them with a re-export from `@awcms-one/kontrak`.

## [0.1.0] — 2026-09-15

Initial workspace scaffolding, landed before the `.changesets/` convention itself existed — recorded here by hand rather than folded from a changeset entry.

- Bun workspace root (`workspaces: ["apps/*", "packages/*"]`), pinned toolchain (`bun@1.4.0`), and the dotfiles that govern it (`.gitignore`, `.editorconfig`, `.dockerignore`).
- `packages/config` — the shared `tsconfig.base.json` preset.
- `apps/cms` — `ahliweb/awcms` v10.3.0, embedded whole via `git subtree` with full history (closes #2).
