🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

# Architecture Decision Records

A record of decisions and the reasoning behind them — written so a proposal already argued and settled does not come back six months later with nobody remembering why it went the way it did.

A change in this repository needs an ADR when it:

- changes the shape of the output (static ↔ server, a URL's shape);
- changes the security posture (a new runtime credential, RLS, CSP);
- adds a runtime dependency or a third-party service;
- reverses one of the decisions below;
- decides an import direction, a data representation, or an embedding strategy that the rest of the codebase is then built to assume.

What does **not** need an ADR: adding a field within an already-decided schema, a routine dependency bump, a test, a copy edit.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-git-subtree-with-full-history-for-apps-cms.md) | `apps/cms` is `ahliweb/awcms`, embedded via `git subtree` with full history | Accepted |
| [0002](0002-static-output-with-build-time-fetch-for-the-storefront.md) | The storefront is `output: "static"`, fetching the catalog at build time | Accepted |
| [0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) | Money is `numeric(14,2)`, and crosses the wire as a string | Accepted |
| [0004](0004-a-type-only-contract-package-with-an-import-direction-gate.md) | `packages/kontrak` is a type-only contract, with a gate holding the import direction one-way | Accepted |
| [0005](0005-product-urls-match-the-live-sites-shape.md) | Product URLs match the live site's shape: `/product/{slug}`, no trailing slash, `/products` redirects | Accepted |
| [0006](0006-a-federated-knowledge-graph-that-never-duplicates-the-subtree.md) | A federated knowledge graph: root-owned, code-only, never duplicating `apps/cms`'s own | Accepted |
| [0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) | Cart, checkout and order tracking stay static; the browser calls the CMS's anonymous commerce endpoints directly | Accepted |
| [0008](0008-one-commerce-module-carries-the-whole-store-not-three.md) | One `commerce` module carries the whole store, not three | Accepted |
| [0009](0009-guest-checkout-by-order-code-and-phone.md) | Guest checkout, addressed by order code + phone; customer accounts come later | Accepted |
| [0010](0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md) | Manual payment and alternative courier first; gateways and aggregators arrive through the outbox | Accepted |

## Why the numbering starts at 0001

Unlike `ahliweb/media-lenterakalteng` (whose ADR corpus continues a reference template's own numbering from 0014), this repository's ADR corpus is its own from the start — `apps/cms` carries `ahliweb/awcms`'s own, separate ADR numbering under `apps/cms/docs/adr/`, for its own tree; it is not this index's to continue or to cite by bare number (a citation to one of `apps/cms`'s own ADRs is written with a marker — `awcms`, "reference repo", or a GitHub link in the same paragraph — precisely so [`bun run audit:dokumen`](../../AGENTS.md#the-gates) can tell the two numbering spaces apart).

## This table is guarded

`bun run audit:dokumen` requires it complete in both directions — every ADR file in this directory recorded here, every row pointing at a file that exists — with no duplicate rows, and requires the Status column to agree with the `- **Status:**` line inside the ADR file itself. It runs in CI on every push, needs no build and no network, and — per the correction `media-lenterakalteng`'s own copy of this gate records in its history — the same requirement covers this index's Indonesian mirror, [`README.id.md`](README.id.md): the translation gate's hash keeps that mirror the same AGE as this file, not correct against this directory's actual contents, so `audit:dokumen` checks the mirror's table too, independently.
