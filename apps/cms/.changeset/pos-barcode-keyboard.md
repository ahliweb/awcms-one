---
"awcms": minor
---

feat(commerce): barcodes, label printing, scanner input and a keyboard-first cashier layer (Issue #292, epic #281)

`sql/975` adds a nullable `barcode text` to `awcms_commerce_products` and `awcms_commerce_product_variants` (CHECK: 1-48 printable ASCII, no spaces), a partial `UNIQUE (tenant_id, barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL` on each (also the lookup index), and `awcms_commerce_barcode_cross_guard()` as a `BEFORE INSERT OR UPDATE` trigger on both: it refuses a code held by a live row of either table under `pg_advisory_xact_lock(918292, hash & 255)` (256 stripes - a per-code lock exhausted the shared lock table on a 20,000-row bulk load), and a restored row whose code was reused comes back with `barcode = NULL` instead of failing. `sql/976` seeds `commerce.barcodes.{read,update}`; `977`-`979` held. No new table, so no new retention descriptor, subject-data entry or worker grant.

New endpoints (behind the `barcode` feature flag, default OFF -> `409 FEATURE_DISABLED`):

- `GET /api/v1/commerce/barcodes/lookup?code=` (`commerce.barcodes.read`) - the one product/variant a code names in the caller's tenant with `requiresVariant`/`sellable`; unknown, soft-deleted and other-tenant codes are the same `404`
- `GET /api/v1/commerce/barcodes` (`commerce.barcodes.read`) - products-without-variants and variants with their barcode (`q`, `barcode=with|without`, `page`)
- `PUT /api/v1/commerce/barcodes` (`commerce.barcodes.update`) - set or clear one barcode; `400` malformed/bad GTIN check digit, `404` unknown/foreign id (one neutral answer), `409 BARCODE_DUPLICATE`

Pure domain modules `domain/barcode.ts` (GTIN check digit, validation, Code 128 / EAN-13 / EAN-8 encoders, numbers-only SVG renderer, label options), `domain/pos-scan.ts` (scan parsing, `ScanBurstDetector`) and `domain/pos-shortcuts.ts` (chord policy, conflicts, defaults -> tenant -> user layering). Admin: `/admin/commerce-labels` (assign + server-rendered, print-ready label sheets), the scan field, burst detector, shortcut layer and help dialog on `/admin/commerce-pos` (`lib/ui/pos-keyboard-client.ts`), a "Barcodes, labels and cashier shortcuts" toggle default-off in the commerce Features section, the `posShortcuts` module setting, ADR-0032 and Indonesian mirrors.
