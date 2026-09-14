# Contracts index

Who owns which side of the backend/storefront boundary, and how data actually crosses it today — a map that changes shape once `packages/kontrak` lands, kept here rather than inferred fresh from the graph on every question.

## Responsibility

| Workspace | Owns |
| --- | --- |
| `apps/cms` | The commerce backend and system of record. Its public API surface (`apps/cms/openapi/`, [`apps/cms/openapi/README.md`](../../apps/cms/openapi/README.md)) is contract-first (ADR-0007, cited via `apps/cms/docs/adr/`) — every module composes fragments into one bundle, checked by `apps/cms`'s own `api:spec:check` / `api:docs:check` / `api:consumer-contract:check` gates (`bun run check:cms`). |
| `apps/storefront` | The public Astro storefront. Reads `apps/cms`'s public API only — never its internals (root [`AGENTS.md`](../../AGENTS.md#workspace-boundaries)). Today it calls that API through its own small client, [`apps/storefront/src/lib/awcms/client.ts`](../../apps/storefront/src/lib/awcms/client.ts), configured via [`apps/storefront/src/lib/env.ts`](../../apps/storefront/src/lib/env.ts). |
| `packages/kontrak` | **Not built yet** ([issue #6](https://github.com/ahliweb/awcms-one/issues/6)) — the type-only DTO contract `apps/storefront` will import from `apps/cms`, plus the import-direction gate keeping that a one-way dependency (storefront depends on the contract; the contract never depends on either app). Once it lands, this is the seam described below stops being informal. |

## The flow today, before `packages/kontrak`

`apps/storefront` calls `apps/cms`'s HTTP API directly and hand-shapes the response types itself (see `client.ts`'s own `CommerceCategory` / `CommerceProduct` types) — there is no shared, generated, or contract-checked type between the two workspaces yet. For local development without a running `apps/cms`, [`apps/storefront/scripts/stub-awcms.mjs`](../../apps/storefront/scripts/stub-awcms.mjs) serves fixture responses shaped like that same API.

This is a real gap, not an oversight: `packages/kontrak` is issue #6's whole purpose, landing in parallel with this issue. Until it lands, a change to `apps/cms`'s response shape can silently break `apps/storefront`'s hand-written types with nothing catching it at build time — the import-direction gate `packages/kontrak` brings is what closes that.

## Why this file exists separately from the graph

`graphify query` can find that `client.ts` calls `apps/cms`'s routes structurally, but it cannot say WHETHER that coupling is sanctioned, temporary, or about to change shape — that is a decision made by people, recorded here, and linked to the issue that will make it obsolete.
