🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](0027-catalog-custom-attributes-are-typed-and-allowlisted.id.md)

# ADR-0027 — Catalog custom attributes are typed and allowlisted, and bulk import is validate-then-apply

- **Status:** Accepted
- **Date:** 3 October 2026
- **Deciders:** ahliweb
- **Related:** [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (exact numbers cross the wire as strings), [ADR-0008](0008-one-commerce-module-carries-the-whole-store-not-three.md) (this is `commerce`, not a new module), [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (migrations `960`–`964`), epic [#281](https://github.com/ahliweb/awcms-one/issues/281), issue [#291](https://github.com/ahliweb/awcms-one/issues/291)

## Context

OSPOS lets a merchant define custom item attributes, search and filter by them, and import items from a spreadsheet. Both halves have a bad history: custom-attribute search was patched more than once for SQL injection (a user-controlled attribute name or value reaching a SQL identifier or expression), and spreadsheet import is the classic place where "the file said so" bypasses the validation every interactive path enforces.

awcms-one's catalog today carries only fixed product columns plus the descriptive `variant_attributes` JSON. A store that sells anything other than the shape those columns assume (weight, material, a release date, an organic flag) has nowhere to put it, and nothing to filter on. The work is therefore a design problem with three hard constraints, taken from the epic: a value's type must be real (not a string that happens to look like a number), a request must never be able to shape SQL text, and a bulk write must go through exactly the validation, authentication and tenant isolation a single write does — and be recoverable.

## Decisions

### D1 — Values are typed columns in a normalised table, not a JSON document and not text-only EAV

`awcms_commerce_attribute_definitions` (the schema) and `awcms_commerce_product_attribute_values` (one row per entity and definition) carry the value in exactly one of `value_text`, `value_scaled` (integer/decimal), `value_boolean`, `value_date`, enforced by `CHECK (num_nonnulls(...) = 1)`, plus `value_search` (the normalised text of a text/enum value).

A `jsonb attributes` column on `awcms_commerce_products` would be one column and no new table, and it would make every filter a `->>`/cast expression built from a caller-supplied key — the exact dynamic-identifier shape the OSPOS fixes were about. Typed columns make a filter a comparison of a fixed column against a bound parameter, give numeric/date b-tree range scans, and put a real shape under `CHECK`.

References are tenant-safe in the schema, not only in application code: composite FKs `(tenant_id, definition_id)`, `(tenant_id, product_id)` and `(variant_id, product_id)`. RLS does not apply to FK checks, so without them a regressed code path could point tenant A's value at tenant B's definition. The integration suite inserts such rows through a connection that bypasses RLS and asserts the constraint refuses them. A variant's value row carries both `product_id` and `variant_id`, so "products whose attribute X is Y" is one indexed `EXISTS` whether the value sits on the product or on one of its variants (a variant-level match makes its product match — documented, intentional faceting semantics).

### D2 — A persisted number never depends on a locale, and is stored as an exact scaled `bigint`

The accepted grammar is ASCII and closed (`domain/attribute-value.ts`): integers `[+-]?[0-9]+`, decimals `[+-]?[0-9]+(\.[0-9]+)?`; `.` is the only separator, a leading digit is required, there is no exponent, grouping or whitespace. **`1.234,5` and `1,5` are refused, not interpreted** — whether `1,234` means 1234 or 1.234 is the ambiguity that corrupts a catalog, so the grammar has no reading of it. More fractional digits than the definition's `scale` is an error, never a rounding. A JSON decimal must arrive as a string (a JSON `0.1` is already a float); an integer may be a JSON number. Dates are strict ISO `YYYY-MM-DD` calendar dates (leap years honoured); booleans are JSON booleans or `true`/`false`; text is NFC-normalised, trimmed, single-line and length-bounded (code points, not UTF-16 units); an enum value is an exact member of the closed option list. The test suite re-runs the numeric parsing with a different process locale.

**Storage is `value_scaled bigint` = value × 10^6** (12 integer digits, ≤ 6 fractional), not `numeric` and not a float. This was decided by EXPLAIN, not taste: under `FORCE ROW LEVEL SECURITY` Postgres only pushes *leakproof* operators into an index condition, and `numeric`'s comparison operators are not leakproof (`pg_proc.proleakproof = f` for `numeric_ge`/`_le`/`_eq`) while `int8`'s are. With `numeric` a range filter could never use a b-tree for the `awcms_app` role — the first prototype's plans showed `Filter: (value_numeric >= 99.5)` over a full scan of the definition's rows. A scaled integer is exact (the same integer-arithmetic rule ADR-0003 sets for money), comparison is exact on the server and in the domain code (`BigInt`), and the canonical decimal is recovered by digit manipulation, with no division and no float anywhere. Wire form: integer → JSON number (always exactly representable), decimal → string.

### D3 — Definitions are metadata with a closed schema, and some fields are immutable

A definition has a stable `key` (`^[a-z][a-z0-9_]{0,62}$`, unique among live definitions per tenant, freed by soft delete), a default `label` plus per-locale `labels`, a `valueType`, a `constraints` document, the flags `is_searchable` / `is_filterable` / `visible_admin` / `visible_public`, `applies_to` (`product`, `variant`, `both`) and `sort_order`. Constraints are a **closed per-type schema** (text: `minLength`/`maxLength`; integer/decimal: `min`/`max` (+ `scale` ≤ 6); date: `min`/`max`; enum: `options[]`; boolean: none) and any other key is a 400 — there is deliberately no `pattern`/regex (a tenant-authored expression is a ReDoS vector and a second grammar nobody audits) and no expression language. `key` and `valueType` are immutable: stored values are typed columns, so a different type is a different attribute. Narrowing constraints does not rewrite stored values (a value is validated when written), with two refusals that would orphan data silently: an enum option still used by a stored value cannot be removed, and `applies_to` cannot narrow under stored values. Enum option values are unique case-insensitively (one btree serves text and enum equality, below). A tenant is capped at 100 live definitions, which bounds the import header, the per-request definition fetch and the definition list (never paginated).

Option labels are tenant-authored content, not catalogue strings; the admin chrome is translated through the usual catalogues.

### D4 — A request can never shape SQL text: two-stage parse, one literal template per (type, operator)

A filter is `attr=<key>:<operator>:<value>`, repeatable (≤ 5, AND-ed). Stage 1 (`parseAttributeFilterParams`) checks shape only: the key matches the slug grammar, the operator is a member of the **closed** set `eq`/`in`/`gte`/`lte`/`contains`, the value is non-empty and bounded. Stage 2 (`resolveAttributeFilters`) binds the key to a definition **the database returned**, checks the operator is legal for the type (`gte`/`lte` on integer/decimal/date; `contains` on text; no `in` on boolean), and parses every operand with the same typed grammar a stored value uses — `attr=weight:gte:1,5` fails exactly like a write of `1,5`. What survives is a definition **id**, an operator/type pair from closed unions and typed operands.

`application/attribute-filter-sql.ts` maps each (type, operator) pair to **one literal SQL template** whose column (`value_scaled`, `value_date`, `value_boolean`, `value_search`) is written into the template, and binds the operands as parameters. The `switch` is exhaustive over both unions, so a new operator is a compile error until it has its own template. There is no `tx.unsafe`, no `${column}`, no `${operator}` in that module — and a test asserts exactly that by source, plus a behavioural test that throws payloads at keys (`color";DROP TABLE ...;--`), operators (`eq;DROP...`) and values (`' OR '1'='1`, `1; DROP`, `\' OR 1=1 --`) and asserts every key/operator payload is rejected before it reaches SQL, every value payload is either rejected by the typed grammar or stored/matched as an inert bound string, no row leaks, and the products table survives. Unknown, non-filterable and (for the public audience) non-public keys produce **one and the same** 400, so the endpoint is not a schema oracle.

The product list's existing sort stays an allowlisted `ORDER BY` map; attribute-valued sorting is deferred (see Deferred).

### D5 — Audiences: the catalog API speaks to the public; the full attribute set needs a back-office permission

`GET /api/v1/commerce/products` (and `/{id}`, `/by-slug/{slug}`) is the read model a storefront consumes with a machine credential. It therefore always speaks to the **public** audience: filters may name only `filterable && visible_public` keys, `q` searches only `searchable && visible_public` attributes, and an additive `attributes[]` carries only `visible_public` values (also on each variant). Existing fields are untouched, so a consumer that predates attributes keeps working. A `searchable` attribute that is not public can never be probed through public search.

The *full* attribute set — back-office-only attributes included — is `GET /products/{id}/attributes`, gated on `commerce.attributes.read`, **not** `commerce.products.read`: a storefront credential holds the latter, and must not be able to read a supplier grade back. Writing values reuses `commerce.products.update` (values are part of editing a product, the same "one verb per sub-resource" rule images and variants follow). The admin screens call the directory directly with the admin audience **only when the operator also holds `attributes.read`**; a `products.read`-only operator's free-text `q` search uses the public audience, so a non-public searchable value cannot be probed (a match would reveal it) any more than it can be read. The route is authenticated, so it sits behind the per-credential controls every owner route has rather than the anonymous per-IP limiter of the storefront routes.

### D6 — Indexes are chosen from measured plans (migration `963`)

Method: 3 tenants (20k, 20k and 200k products) × 5 attributes (enum 8 values, decimal 0–99.99, date over 3 years, boolean 50/50, text 200/2000 distinct) = 1.2M value rows, `ANALYZE`d, `EXPLAIN (ANALYZE, BUFFERS)` of the exact statement the product list issues (the real fragments), **as the `awcms_app` role under the real policy** — a superuser would have shown different plans. Execution times, ms (PostgreSQL 18.4, one local container; absolute values are machine-dependent, the ratios and the plan shapes are the evidence):

| Filter | 20k products, before → after | 200k products, before → after | Plan after |
| --- | --- | --- | --- |
| decimal ≥ 99.5 (0.5% of rows) | 2.57 → 0.42 | 32.7 → 11.3 | index scan on `..._scaled_idx` |
| date = (0.1%) | 2.40 → 0.25 | 19.3 → 2.1 | index scan on `..._date_idx` |
| text eq (0.5% / 0.05%) | 3.47 → 0.57 | 27.9 → 1.2 | index scan on `..._search_idx` |
| decimal ≥ 90, enum eq, date ≥ (10–12%) | unchanged (noise) | unchanged (noise) | hash semi-join + seq scan: the planner correctly ignores the index |
| boolean eq (50%) | unchanged | unchanged | not indexed — two values have no selectivity |
| text `contains` (LIKE) | ~6–10 | ~60–95 | linear in the definition's rows, indexed or not |
| `q` over searchable attributes | ~25 | ~170–220 | the legacy name/sku `q` is already a seq scan at 200k (~120) |

So three indexes, each `(tenant_id, definition_id, <typed column>)`, **partial** on the column being non-null and the row being live, are created; one btree serves text and enum equality. Two things were measured and **rejected**: a `pg_trgm` GIN index on `value_search` was never chosen by the planner — `LIKE`/`ILIKE` are not leakproof either, so under RLS they cannot be an index condition even for a rare needle — and a boolean index. Blanket indexing would have cost every write for no read. `contains` and the searchable-`q` surcharge are accepted, bounded by the definition's rows, and only paid by a tenant that opted an attribute into them. An integration test (`query plans`) re-asserts, on a 20k-product database as `awcms_app`, that the selective filters use the sql/963 indexes and that no value query seq-scans the values table.

### D7 — Export: RFC 4180, UTF-8, formula-neutralised, round-trippable

`GET /products/export.csv` (`commerce.products.export`) writes the core columns plus one `attr:<key>` per live, product-applicable, admin-visible definition — but only the `visible_public` ones unless the caller also holds `commerce.attributes.read` (an `export`-only operator must not read back-office attribute values through the file; D5's rule applies to the CSV too); `costPrice` and `downloadLink` are not exported. Every cell is neutralised **then** quoted: a cell starting with `=`, `+`, `-`, `@`, TAB or CR is prefixed with `'` (the OWASP defence). One exemption: a cell that is, in full, a plain signed number (`-5`, `+3.25`) is written as-is — it cannot be a formula, and prefixing it would turn every negative number into text; `-5+cmd|...` is not a plain number and is neutralised. The importer reverses exactly this (`'` followed by a trigger character loses the quote), so an export re-imports as all-`unchanged` — asserted by a test; the cost is that a genuine text beginning with `'=` loses its quote on re-import. The ceiling is the import ceiling (5000 rows); `X-AWCMS-Export-Truncated` flags a bigger catalogue; the export is audited.

### D8 — Import is validate → report → apply, with one planner, all-or-nothing, and replay safety

**One path.** `planCatalogImport` reads the file and decides each row (`create`/`update`/`unchanged`/`error`) with SELECTs only. The dry-run returns its report; the apply calls the *same function* and executes the plan only if it has no error. Row fields go through `validateCreateProductInput`/`validateUpdateProductInput` — the validators the single-product API uses — and `attr:` cells through `validateAttributeAssignments`, the validator the attribute endpoints use. A rule added to either reaches the import for free; a value the API refuses, the import refuses for the same reason. Writes use `createProduct`/`updateProduct`, so audit rows, domain events, slug/SKU uniqueness and the status state machine all run per row.

**Match key and semantics.** Rows match on `sku` (the stable external key): a live product with that SKU is updated (only changed fields are written; no change is `unchanged`), any other SKU creates. A core cell left blank means "no change" (or the default for a create); a blank `attr:` cell *clears* that attribute, which is what makes an export a no-op on re-import; a column absent from the header is untouched. A slug that belongs to a different live product, two rows with the same SKU or slug in one file (no slug swaps within one file — do two imports), an unknown `categorySlug`, an illegal status transition are row errors. An unknown column is a *file* error, not ignored — a typo like `prise` silently dropped would import something the operator did not review.

**All-or-nothing, explicitly.** Apply runs inside a `SAVEPOINT` on the request transaction: every row lands or none does. A plan with any error is refused (`422 IMPORT_VALIDATION_FAILED`, nothing written); a write-time conflict the planner could not see (another request took a slug between plan and write) rolls the savepoint back (`409 IMPORT_CONFLICT`) and leaves the catalogue untouched; any other error is a defect and propagates (the whole request rolls back, `500`). Chunked/partial apply was considered and rejected: it leaves a catalogue that is half the file the operator reviewed and needs a second tool to reconcile. The honest cost is a size ceiling (5000 rows, 5 MiB) and one long transaction — measured: 5000 new products with two attribute values each apply in about 11–14 s on the test machine (≈ 2–3 ms per row, dominated by the per-row audit/event inserts), well inside the interactive budget and the reason the ceiling is where it is. The route uses the `background_sync` work class so a bulk write cannot starve interactive traffic.

**Idempotency and batch identity.** Apply needs an `Idempotency-Key`; the shared store records the request hash `sha256(file bytes)`, so replaying the same key with the same file returns the original response without re-applying and the same key with a different file is `409 IDEMPOTENCY_CONFLICT`. The request media type is exactly `text/csv`: `text/plain` is CORS-safelisted (no preflight), so accepting it would let a cross-site form post a dry-run unprompted; anything else is `415`. The key is claimed **first**, inside the apply savepoint, with `INSERT … ON CONFLICT (tenant_id, key hash) DO NOTHING`: a concurrent apply with the same key blocks on the unique index until the winner commits, then gets no row and writes nothing (`duplicate_key`), and the route answers with the winner's stored replay (same file) or `409 IDEMPOTENCY_CONFLICT` — never a raw unique violation / 500. A failed apply rolls the claim back with its writes, so a corrected file can reuse the key. `awcms_commerce_catalog_import_batches` records every applied batch (file hash, *hash* of the key, counts, actor); its unique `(tenant_id, key hash)` is the structural second guard — even a lost replay record cannot apply a key twice. A dry-run writes nothing at all, so it has no batch row. `expectedSha256` binds an apply to the file the operator reviewed (`409 IMPORT_FILE_MISMATCH`); the admin screen sends it automatically.

**Rollback strategy.** *Before* commit: the savepoint (above) — nothing to undo. *After* commit: there is no destructive step to reverse — updates are the product's ordinary audited updates, clears are soft deletes, and the batch row plus the audit trail (`catalog_import.apply`, per-product `update` events carrying the changed fields) identify exactly what a batch touched. Reverting a committed import is an import of the previous export (which is why the export round-trips); no "undo batch" button exists and none is claimed.

**Threat model.**

| Threat | Control |
| --- | --- |
| Formula injection through the exported file | Cell neutralisation on every export cell, with a test per trigger character |
| SQL injection through a header/key/value/operator | Keys resolved to definition ids; values parsed by the typed grammar and bound; no `unsafe` in the filter/import path (asserted) |
| Import bypassing validation | Same validators as the interactive API; same directory functions |
| Import bypassing authorization | `products.import` **and** `create` **and** `update` for apply; dry-run needs `import`; tenant from the verified session, RLS on every statement |
| Cross-tenant read/write | SKU/slug/category lookups are RLS-scoped and tenant-keyed; a test imports a SKU that exists only in another tenant (it creates, never updates, B's row stays untouched); composite FKs |
| Server-side request forgery / remote fetch | No network code in the importer; **no column accepts a media reference or URL** (`imageUrl`, `media`, … are unknown-column errors) — images stay a separate explicit step |
| Resource exhaustion (huge file, wide rows, huge cells, quote bombs) | 5 MiB body cap (`readTextBody`, streaming), 5000 rows, 200 columns, 10,000 characters per cell, NUL rejected, malformed quoting is a parse error, not repaired; the diagnostics list is bounded |
| Replay / double apply | Idempotency key + file hash + unique batch key |
| Applying a different file than the one reviewed | `expectedSha256` |
| Reading back-office attributes through the catalog API | Public audience filter + `attributes.read` gate on the full set (D5) |
| Information leak in diagnostics | Row diagnostics are the validators' own messages about the operator's own file; unexpected errors are never echoed (they propagate) |

### D9 — Permissions, with one new access action

`commerce.attributes.read` and `commerce.attributes.manage` (definitions are schema, one high-risk audience, so one action rather than create/update/delete); `commerce.products.export` and `commerce.products.import`. `import` is a new `AccessAction` (high-risk beside `export`; the SoD hook can reference it without a second change). Existing tenants do not gain these permissions retroactively (the catalogue seed is global, `sql/961`).

### D10 — Lifecycle: values soft-delete; the purge engine ages cleared values out

Clearing a value stamps `deleted_at` (it also leaves the live unique index, so setting the attribute again inserts a fresh row); the generic purge engine hard-deletes cleared values after the tenant's retention window and a live value (`deleted_at IS NULL`) can never be a purge candidate. Values also cascade away with their product, variant or purged definition. Both tables carry `dataLifecycle` descriptors; `subjectData` marks them unreachable-by-subject and retained (catalogue description, no person). Every read, filter, uniqueness check and partial index repeats `deleted_at IS NULL`.

## Consequences

- A catalogue can now describe itself in typed, validated, filterable terms; the cost is five migrations, three tables, and a real permission surface to grant.
- `bigint` scaling bounds numbers to 12 integer digits and 6 fractional digits — enough for dimensions, weights, counts and prices-as-attributes, not for scientific values. A wider range would need `numeric` and would give up index-supported range filters under RLS; that trade-off is deliberate.
- Filtering by a *variant* attribute makes the product match; per-variant availability filtering ("a size-L variant in stock") is not what this expresses.
- The searchable-`q` and `contains` paths are linear in a definition's rows. They are bounded (≤ 100 definitions, tenant catalogues of thousands) and opt-in, but a tenant with hundreds of thousands of products should not mark many attributes searchable.
- The import is one transaction. 5000 rows is the measured sweet spot; larger catalogues load in several imports (idempotent by SKU), not one giant request.
- Row diagnostics are the API validators' English messages, shown beside translated screen chrome — the file's own contract language, not a catalogue string.

## Deferred (not built — recorded so nobody assumes otherwise)

- **Variant attributes in the CSV.** The file is product-shaped; variants and their attribute values are edited through the admin screen and `PUT .../variants/{id}/attributes`. A variant CSV needs its own match key design (`variant sku`) and is a separate change.
- **Sorting by an attribute value.** Needs a keyset story over a typed, nullable, per-definition column; the existing allowlisted sorts are unchanged.
- **Storefront rendering/facets (`apps/storefront`).** The API is ready (`attributes[]`, `attr=` filters); building facet UI and pages is storefront work and is deliberately not part of this change.
- **Renaming an enum option** (a value rewrite) and per-locale option labels.
- **Chunked or background import** for catalogues past 5000 rows per file.
- **Attribute value history** beyond the audit trail's changed-key lists.
- **Per-row media references** — intentionally never; images stay a separate step.

## Alternatives considered

- **`jsonb` attributes on `products`** — rejected (D1): request-built `->>` expressions, no typed range scans, no CHECK-able shape.
- **`numeric` value storage** — rejected (D2/D6): not leakproof, so no index range scans under RLS; measured.
- **A query DSL with named attribute expressions** — rejected: the issue asks for one only "if the domain proves value", and `key:operator:value` over a closed operator set covers faceted filtering with a fraction of the attack surface.
- **Chunked import with per-chunk commits** — rejected (D8).
- **Per-row `INSERT … ON CONFLICT` import bypassing the directory functions** — rejected: faster, but it forks validation, events and audit from the interactive path, which is exactly the bypass this ADR forbids.
- **A trigram index for `contains`/search** — rejected (D6): measured never used under RLS.
