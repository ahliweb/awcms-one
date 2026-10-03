---
bump: minor
type: content
impact: public
---

# Typed catalog attributes, safe attribute filtering, validated CSV import/export

Issue #291 (epic #281, OSPOS parity). The catalog gains tenant-defined, **typed** custom attributes, attribute filtering that cannot be turned into SQL injection, and a CSV import/export that validates before it writes. Everything is inside the existing `commerce` module (ADR-0008) and takes migrations `960`–`964` of the reserved range (ADR-0015). The decisions and the measured query plans are in [ADR-0027](../docs/adr/0027-catalog-custom-attributes-are-typed-and-allowlisted.md).

- **Attributes are typed columns, not a JSON blob.** Definitions (`key`, labels, a closed per-type constraint schema, searchable/filterable/visibility flags, product/variant applicability) and values (text, whole number, decimal, boolean, date, choice list) with a strict ASCII grammar: `1234.5` is a number, `1,5` is a 400 — a persisted number never depends on a locale.
- **Filtering is allowlisted by construction.** `attr=<key>:<op>:<value>` resolves the key to a definition id in the database, parses the operand with the same typed grammar, and maps each (type, operator) pair to one literal SQL template with bound parameters. There is no code path from a request to a SQL identifier or expression, and a test throws injection payloads at keys, operators and values.
- **The storefront API only ever sees public attributes.** Additive `attributes[]` on products and variants, `filterable && visible_public` filtering, and `q` search over searchable attributes of the same audience; existing fields are untouched.
- **Import is dry-run → report → apply, all-or-nothing and replay-safe.** Same planner for both, one savepoint, `Idempotency-Key`, `expectedSha256` to bind apply to the reviewed file, matched on `sku`, no media column, no network. Export neutralises spreadsheet formulas.
- A new **`import`** access action (high-risk, beside `export`), permissions `commerce.attributes.read|manage` and `commerce.products.import|export`.
- Operators: run `bun run db:migrate` (adds five migrations, no data change). Grant the new permissions to the roles that manage the catalog; existing tenants do not gain them automatically.
