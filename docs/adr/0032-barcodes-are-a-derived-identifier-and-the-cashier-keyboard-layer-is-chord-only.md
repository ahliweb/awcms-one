🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0032-barcodes-are-a-derived-identifier-and-the-cashier-keyboard-layer-is-chord-only.id.md)

# ADR-0032 — Barcodes are a per-tenant identifier with a derived symbology, labels are server-rendered, and the cashier keyboard layer is chord-only

- **Status:** Accepted
- **Date:** 4 October 2026
- **Decision maker:** ahliweb
- **Related:** issue [#297](https://github.com/ahliweb/awcms-one/issues/297) (template-only: a generic, reusable capability with no vendor-specific hardware coupling); [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) (what this repo treats as a credential: a barcode is not one); [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (migration range); [ADR-0028](0028-pos-register-sessions-and-cash-up.md) (the POS screen this extends); [ADR-0029](0029-commerce-documents-are-separate-records-and-numbered-documents-are-immutable-order-snapshots.md) (the held-sale controls it sits beside); issue [#292](https://github.com/ahliweb/awcms-one/issues/292) under epic [#281](https://github.com/ahliweb/awcms-one/issues/281). Bundle barcodes (issue #290) are deferred with the bundle epic, which is itself blocked on the inventory work of issue #282.

## Context

A counter is fast when the cashier's hands never leave the scanner and the keyboard. Mature POS systems offer a barcode on every item, printable labels, a scan field that "just works" with a USB scanner, and keyboard shortcuts for the actions a cashier repeats all day. This repository's POS screen had none of that: a cashier searched by name or SKU and clicked.

Four questions had to be answered before writing code: _what a barcode is and where it is stored_, _how a label is produced_, _how a scan is told apart from typing_, and _how a shortcut layer avoids fighting the browser, assistive technology and ordinary typing_. All four are constrained by the same issue text: **a barcode is an identifier, not authentication or authorisation.**

## Decision

### D1 — A barcode is a nullable column on the two sellable rows, unique per tenant across both; its symbology is derived, not stored

`barcode text` on `awcms_commerce_products` and `awcms_commerce_product_variants` (`sql/975`). 1 to 48 printable ASCII characters, no spaces (the Code 128 subset B repertoire a wedge scanner can type back); it may not start with `<digits>*` (the scan field's quantity-multiplier syntax, D5). An all-digit code of 8, 12, 13 or 14 digits is by definition a GTIN and must carry a valid GS1 check digit — a wrong one is rejected, never "corrected"; anything else is a free internal code. The symbology (EAN-13, EAN-8, UPC-A printed as EAN-13 with a leading zero, GTIN-14 and every internal code as Code 128) is a pure function of the code, so there is no second column that could disagree with it.

**Uniqueness** is per tenant among _live_ products **and** variants: a scanner reads one string and must resolve to exactly one thing. Each table has a partial unique index `(tenant_id, barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL` — which is also the lookup index — and a `BEFORE INSERT OR UPDATE` trigger refuses a code held by a live row of the other table, under a **striped** transaction-scoped advisory lock (256 stripes) so two concurrent writers of one new code queue rather than both passing the check. Two tenants may use the same code.

|                        | A. Column on each row + cross-table trigger (chosen)                                          | B. A separate `barcodes` table (one row per code, many codes per item)                                                 | C. Reuse `sku` as the barcode                   |
| ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Security               | inherits FORCE RLS, tenant filter and retention of the rows it names; nothing new to forget   | a new table with its own policy, lifecycle descriptor, subject-data entry and worker grants — each a place to be wrong | none new, but a SKU is human-facing and mutable |
| Performance            | one equality probe on the partial unique index; verified an index scan at 20,000 rows         | a join on every scan                                                                                                   | already indexed (trigram, not equality)         |
| Accessibility / UX     | one code per item: simple to explain and to print                                             | several codes per item (pack sizes, old EANs) — a real need for some retailers                                         | no GTIN check digit, no separate label code     |
| Compatibility          | adds a nullable column; no change to any existing query or response                           | new FKs and joins in the POS path                                                                                      | no change                                       |
| Operational complexity | one trigger; restoring a row whose code was reused comes back un-barcoded rather than failing | cleanup, orphan and merge logic for the extra table                                                                    | none                                            |
| Long term              | multiple codes per item can still be added later as table B without invalidating A's data     | the most general                                                                                                       | locks the SKU's meaning                         |

**Chosen: A.** One code per item is what the issue asks and what a small retailer needs; multiple codes per item is a deferred extension (see "Deferred").

**Lesson recorded.** The first version of the trigger took one advisory lock _per code_. A bulk load of 20,000 barcoded rows in one transaction died with `out of shared memory` — an advisory lock holds a slot of the shared lock table until commit. Striping bounds a transaction to 256 slots. The integration test inserts 20,000 barcoded rows in one statement for exactly this reason.

### D2 — Lookup is a permissioned, tenant-scoped equality probe with one neutral miss

`GET /api/v1/commerce/barcodes/lookup?code=` resolves a code to the one product or variant it names in the caller's tenant, gated on `commerce.barcodes.read` and the `barcode` feature. An unknown code, a soft-deleted row and another tenant's code answer the same `404` body — the endpoint is not an oracle for another tenant's codes. The predicate is a plain `=` on `text` (leakproof, so it is safe next to the RLS qualifier), and the response says `requiresVariant` (the bare parent of a product with variants cannot be sold) and `sellable` (active, in stock, variant-free), so the screen needs no second request. Assignment is `PUT /api/v1/commerce/barcodes` under `commerce.barcodes.update`; it sets state and so carries no `Idempotency-Key`. A duplicate is `409 BARCODE_DUPLICATE`.

The two permissions are **resource-split and new**: ringing up a sale (`commerce.pos.create`) does not let a cashier relabel the catalogue, and editing a product (`commerce.products.update`) does not let anyone re-point a code that is physically stuck to stock. `AccessAction` is not widened.

### D3 — Labels are rendered on the server, from numbers only, with no new dependency

`domain/barcode.ts` contains a Code 128 (subsets B and C, with checksum) and an EAN-13/EAN-8 encoder — about 150 lines plus the 107-row symbol table, verified by tests (every pattern sums to 11 modules, known check digits, known GTINs, guard bars and parity). The label screen renders each bar set as **one inline SVG `<path>` made only of integers**; every piece of tenant text (name, SKU, code, price) is ordinary escaped markup, never `set:html`. Layout numbers (columns, copies, label size) are clamped to integers before they reach a `style` attribute, and a code is rendered only if it re-validates.

|                        | A. Server-rendered SVG, own encoder (chosen)                                                | B. Client-side library (JsBarcode-class)                                           | C. Server-side PDF                       |
| ---------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| Security               | no script on the print path; SVG contains no tenant text                                    | third-party code on a screen that handles the catalogue; text is injected into SVG | a PDF toolchain on the server            |
| Performance            | zero client JavaScript for labels; the page is the sheet                                    | tens of kB added to the client budget                                              | CPU per print                            |
| Accessibility          | the sheet is real, printable HTML; the SVG is `aria-hidden` and the code is printed as text | canvas/SVG built at runtime                                                        | a PDF must be made accessible separately |
| Compatibility          | any browser that prints; `@media print` hides the chrome                                    | same                                                                               | needs a viewer                           |
| Operational complexity | none beyond the encoder's tests                                                             | dependency to track and audit                                                      | a heavy dependency and fonts             |
| Long term              | enough for Code 128 and EAN/UPC; QR/DataMatrix would need a real library later              | broad symbology support                                                            | good for pre-cut label stock             |

**Chosen: A**, with browser print as the output. A PDF export and additional symbologies (ITF-14 with bearer bars, GS1-128, QR) are deferred rather than half-built.

### D4 — Scan detection: a dedicated field plus a global fast-burst detector that never fires in a text field

The scan field takes a code on Enter at any typing speed (a cashier may type a code by hand). The global detector exists so a cashier who last clicked a button can still scan: it recognises a burst of printable characters whose every inter-key gap is at most 35 ms, at least four characters long, ending in Enter. It is a pure class fed key events with their own timestamps (so it is deterministic under test), and it **never fires for a key typed inside a text field** — the caller marks those and the buffer is dropped — so a scan cannot be mistaken for typing into the customer name, and the customer's typing cannot be mistaken for a scan. Tab, Space, arrows, modifier chords and any pause reset it. A recognised burst's Enter is swallowed (`preventDefault`) so it cannot also press a focused button — otherwise a scan could "click" _Complete sale_.

A wedge scanner configured with a Tab suffix is not honoured: Tab is how a keyboard-only cashier moves focus, and the detector must not eat it. The optional quantity syntax is `N*CODE` (1 to 999) in the scan field only; a bare multiplier (`3*`) is an error, and because a stored code may not start with `<1-3 digits>*` the split is unambiguous. Embedded-price or embedded-weight barcode formats (the issue's "allowlisted parser profile") are **not built**: there is no validated requirement, and a parser that reads a price out of a code lets whoever prints a label set a price — a trust boundary this ADR does not open.

Outcomes are told to assistive technology: success through a polite `role="status"` region, every failure (unknown code, out of stock, needs a variant, stock exceeded, lookup failed) through an inline `role="alert"` message. There is no modal.

### D5 — Shortcuts: chord-only, three layers, personal overrides stay in the browser

Defaults → the tenant's map (`commerce` module setting `posShortcuts`, edited through the existing module-settings API) → the user's own map (browser `localStorage`, `awcms-one:pos-shortcuts:v1`). Each layer may rebind any subset; every entry is validated and a layer that would collide with a lower one is dropped entry by entry, so a bad stored value degrades to the defaults and can never disable an action.

**What a combo may be:** `Alt+Shift+<letter or digit>`; the function keys `F2`, `F4`, `F8`, `F9`; `Ctrl+Enter` / `Ctrl+Shift+Enter`. Refused with a reason: any bare printable character (WCAG 2.1.4 Character Key Shortcuts), `Ctrl+<letter>` (browser), `Meta+…` (OS), unshifted `Alt+<letter>` (menu mnemonics), `Alt+Arrow/Home/F4`, `Tab`, `Escape`, `Enter`, `Space`, arrows, and the browser-reserved `F1 F3 F5 F6 F7 F10 F11 F12`. Matching uses the physical key (`event.code`) so it works on any keyboard layout and on macOS Option. Shortcuts are chords, so they work from inside a field on purpose (that is where a cashier's hands are) without ever consuming ordinary typing; they are ignored while a dialog is open.

|                        | A. Chord-only, tenant default + per-browser override (chosen)                                                    | B. Bare-key mnemonics (`/` to search, `h` to hold)                              | C. Per-user map stored server-side                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Security               | nothing new on the server                                                                                        | none                                                                            | a new table with subject-data and retention obligations |
| Accessibility          | satisfies WCAG 2.1.4; no conflict with screen-reader keys (they use Insert/CapsLock)                             | fails 2.1.4 unless every key is remappable or disableable; collides with typing | same as A                                               |
| UX                     | a visible help dialog lists and rebinds every chord; a persistent "Keyboard shortcuts" button makes it reachable | fastest for experts, hostile to a customer-name field                           | follows the person to any machine                       |
| Compatibility          | works in every browser; storage failure only loses the override                                                  | collides with browser type-ahead find                                           | needs the server round-trip                             |
| Operational complexity | none                                                                                                             | none                                                                            | a table, an endpoint, a purge path                      |

**Chosen: A.** A personal override is a per-device convenience (a cashier at a shared counter terminal wants the _terminal's_ layout), and the tenant default is the shared contract. A server-side per-user store is deferred until someone needs the map to follow a person across devices.

### D6 — The whole surface is behind a feature flag that defaults OFF

`features.barcode` (default **off**, the third such flag after `register` and `documents`). With it off there is no scan field, no detector, no shortcut layer, no help button, no navigation entry, and every barcode route answers `409 FEATURE_DISABLED` — a tenant that never opens "Features" sees exactly the POS it had. The scan field additionally needs `commerce.barcodes.read`; the shortcut layer does not. The existing mouse/touch flow is untouched: search, click-to-add, the tender section and the receipt are not restructured (the keyboard layer reaches them through their existing element ids and one `addScanned` hook).

## Consequences

- Migrations `sql/975`–`976` (columns, indexes, trigger; permissions). `977`–`979` stay held. No new table, so no new retention descriptor, subject-data entry or worker grant.
- Two permissions, three routes, one admin screen (`/admin/commerce-labels`), one client module (`lib/ui/pos-keyboard-client.ts`) and three pure domain modules, each with unit tests; integration tests cover uniqueness (same table, across tables, per tenant), the concurrent-writer race, RLS, BOLA, soft-delete reuse, restore, the 20,000-row index plan, the feature flag and the permission split.
- The client asset budget was re-measured (see `apps/cms/scripts/client-asset-budget.ts`).
- A barcode printed on a label outlives the row's name and price: changing a barcode on an item that is already on the shelf orphans its labels. The screen therefore asks nothing special — but the audit trail records every assignment and clear.

## Deferred (not built here, on purpose)

- **Multiple barcodes per item** (pack sizes, superseded EANs) — option B above; additive later.
- **Bundle barcodes** (issue #290) — blocked on the inventory epic (#282).
- **Embedded price/weight barcodes** — see D4; needs a validated requirement and its own trust review.
- **PDF label export, ITF-14, GS1-128, QR/DataMatrix** — D3.
- **A tenant-level shortcut editor screen** — the tenant map is edited through the module-settings API today; each cashier can already rebind their own.
- **A server-side per-user shortcut store** — D5.
- **A real-browser E2E of the scan/keyboard flow** — the timing and policy logic is unit-tested and the routes integration-tested, but the Playwright matrix (`local-ci/e2e-*`) was not extended in this change.
