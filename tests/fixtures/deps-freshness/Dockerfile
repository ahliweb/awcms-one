# fixture — shaped like apps/storefront/Dockerfile
ARG BUN_VERSION=1.4.4
ARG UNUSED=1

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /repo

FROM deps AS build
RUN echo "FROM not/an-image:1.0"

FROM oven/bun:${BUN_VERSION}-slim AS runtime
FROM scratch AS empty
FROM ${NOT_DECLARED} AS broken
FROM postgres:latest AS floating
FROM node AS bare
