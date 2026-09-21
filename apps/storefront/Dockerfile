# apps/storefront/Dockerfile — issue #150 / ADR-0019.
#
# Multi-stage build for the ONE build-profile-specific storefront image. This
# app is `output: "static"` (ADR-0002) — the runtime stage serves a build
# `astro build` already produced; it never talks to apps/cms again (see
# apps/storefront/server/penyaji.mjs's own header). Build from the REPO ROOT
# context (`docker build -f apps/storefront/Dockerfile .`), never from
# apps/storefront/ alone: this app's build imports type-only contracts from
# packages/kontrak, which itself imports from apps/cms's own source
# (packages/kontrak/package.json — "Type-only DTO contract... imported from
# its source"), and the workspace root's own bun.lock/package.json govern the
# whole install.
#
# Build ARGs are baked into the STATIC build (catalog/news content, canonical
# origins) — none of them is a runtime secret. `AWCMS_API_TOKEN` is the one
# exception and is NEVER an ARG/ENV: it is read only inside the single RUN
# below via a BuildKit secret mount, so it never becomes part of any image
# layer (ADR-0019 D4).
#
#   DOCKER_BUILDKIT=1 docker build \
#     -f apps/storefront/Dockerfile \
#     --build-arg SITE_PROFILE=toko \
#     --build-arg SITE_URL=https://shop.example.test \
#     --build-arg AWCMS_API_URL=https://cms.example.test \
#     --build-arg PUBLIC_AWCMS_ORIGIN=https://cms.example.test \
#     --secret id=awcms_api_token,env=AWCMS_API_TOKEN \
#     -t awcms-one-storefront:toko .
#
# Each profile (toko/berita/landing) is its OWN image, built with its own
# SITE_PROFILE — see docs/deployment.md's "Production runbook".

ARG BUN_VERSION=1.4.0

# ---------------------------------------------------------------------------
# deps — installs the whole workspace's dependencies once, cached by
# package.json/bun.lock alone so an ordinary source-only change never
# reinstalls.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /repo

COPY package.json bun.lock ./
COPY apps/storefront/package.json apps/storefront/package.json
COPY apps/cms/package.json apps/cms/package.json
COPY packages/kontrak/package.json packages/kontrak/package.json
COPY packages/config/package.json packages/config/package.json

RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — the real source tree, one profile's static build.
#
# `COPY . .` (the whole repo, filtered by the root `.dockerignore`) was
# CHOSEN over a narrower `COPY package.json bun.lock packages/ apps/storefront/`
# after actually trying the narrower form (issue #150 review) and watching it
# break: `apps/storefront`'s own `check` script (`astro check`, the first step
# of `bun run build`) failed with
# `src/lib/catalog.ts:285:39 - error ts(2345): Argument of type
# 'ProductStatus' is not assignable to parameter of type 'never'` — because
# `packages/kontrak` re-exports TYPE-ONLY from `apps/cms/src/modules/**/domain/
# *.ts` (see that package's own docblock), and without that source present
# TypeScript resolves the re-exported type to `never` instead of failing to
# find it outright. There is no small, stable subset of `apps/cms/src/**` to
# allowlist instead: `kontrak` draws from several modules' domain layers, and
# a hand-picked list would silently rot the next time it grows one import.
# `.dockerignore` is what keeps this COPY cheap and safe despite covering the
# whole tree — it, not a narrower COPY, is the mechanism doing the work here.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY . .

ARG SITE_PROFILE=toko
ARG SITE_URL
ARG AWCMS_API_URL
ARG PUBLIC_AWCMS_ORIGIN
ARG PUBLIC_GA_ID

WORKDIR /repo/apps/storefront

# AWCMS_API_TOKEN is read ONLY inside this RUN's own environment, from the
# BuildKit secret file — never assigned to an ARG or ENV, so it is absent
# from `docker history` and from every other layer. The secret ID
# (`awcms_api_token`) must match the `--secret id=...` flag the caller
# passes; a build run without `--secret` fails this RUN closed (the file
# does not exist) rather than silently building with an empty token.
RUN --mount=type=secret,id=awcms_api_token \
    export SITE_PROFILE="${SITE_PROFILE}" \
    SITE_URL="${SITE_URL}" \
    AWCMS_API_URL="${AWCMS_API_URL}" \
    PUBLIC_AWCMS_ORIGIN="${PUBLIC_AWCMS_ORIGIN}" \
    PUBLIC_GA_ID="${PUBLIC_GA_ID}" \
    AWCMS_API_TOKEN="$(cat /run/secrets/awcms_api_token)" \
    && bun run build

# ---------------------------------------------------------------------------
# runtime — only the finished static build plus the tiny Bun server that
# serves it (apps/storefront/server/penyaji.mjs, bundled to
# dist/server/penyaji.mjs by the build above). No source, no
# node_modules, no apps/cms — nothing this container could leak beyond the
# already-public build output.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

COPY --from=build /repo/apps/storefront/dist ./dist

ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# The image's own `bun` user (uid 1000) — never root. This container serves
# only static files it already owns; there is no reason it should be able to
# write outside its own dist/ even if the server process were compromised.
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "dist/server/penyaji.mjs"]
