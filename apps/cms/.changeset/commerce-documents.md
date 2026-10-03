---
"awcms": minor
---

feat(commerce): held sales, versioned quotations, work orders, and numbered immutable receipt/invoice documents (Issue #286, epic #281)

New tables `awcms_commerce_document_sequences`, `awcms_commerce_held_sales`, `awcms_commerce_quotations`, `awcms_commerce_quotation_versions`, `awcms_commerce_work_orders`, `awcms_commerce_work_order_events`, `awcms_commerce_documents` (`sql/980` schema + guard/append-only triggers + REVOKEs + a `UNIQUE (tenant_id, id)` index on `awcms_commerce_customers`, `sql/981` thirteen permissions, `sql/982` worker purge grants (all seven tables); `983`–`984` held). No existing table gained a column; checkout, POS and the order APIs are unchanged.

Document numbers (`INV-`/`RCP-`/`QUO-`/`WO-` + UTC year + six digits) come from one upsert on the sequence table, in the same transaction as the numbered row, so they are gapless per tenant, type and year; a trigger makes the counter strictly +1 and only the retention worker (for a finished year) can delete one. A document is an immutable snapshot of one finalized order (`UNIQUE (tenant_id, doc_type, source_type, source_id)`), whose money a `BEFORE INSERT` trigger verifies equal to the order's; its SHA-256 is re-verified on every render. A quotation converts through `createPosOrder` (`allowDue`, no tenders) inside a savepoint so a changed total (`409 QUOTATION_PRICE_CHANGED`) undoes the order and still answers; `quotations.converted_order_id` is set once and unique (idempotent, race-safe). Held sales store lines only, reserve no stock, expire, and resume once.

New endpoints (all behind the `documents` feature flag, default OFF → `409 FEATURE_DISABLED`; every mutation requires `Idempotency-Key`):

- `GET`/`POST /api/v1/commerce/held-sales`, `POST .../held-sales/{id}/resume` and `/discard` (`commerce.held_sales.{read,create,update}`; another cashier's cart needs `commerce.held_sales.approve`, otherwise a neutral `404`)
- `GET`/`POST /api/v1/commerce/quotations`, `GET .../quotations/{id}`, `POST .../{id}/versions`, `POST .../{id}/actions/{send,accept,reject,cancel}` (`commerce.quotations.{read,create,update}`), `POST .../{id}/convert` (`commerce.quotation_conversions.create` and `commerce.pos_due.create`)
- `GET`/`POST /api/v1/commerce/work-orders`, `GET`/`PATCH .../work-orders/{id}` (`commerce.work_orders.{read,create,update}`)
- `GET`/`POST /api/v1/commerce/documents`, `GET .../documents/{id}`, `GET .../documents/{id}/render?format=json|text|html&locale=id|en` (`commerce.documents.{read,create}`; html is script-free, served under `Content-Security-Policy: default-src 'none'`)

Events `awcms.commerce.quotation.{accepted,converted}`, `awcms.commerce.work_order.status_changed`, `awcms.commerce.document.issued` (registered in `module.ts`, the event-type registry and AsyncAPI). `dataLifecycle`/`subjectData` descriptors for six of the tables (`domain/documents-lifecycle.ts`); the sequence table has one too (purged only once its year is over: allocation touches the current UTC year's row, so an older counter can never be used again) and is on the `NO_SUBJECT_DATA` ledger with the reason. Admin: `/admin/commerce-documents` (four tabs), hold/resume on `/admin/commerce-pos`, a "Documents" toggle default-off in the commerce Features section, ADR-0029 and Indonesian mirrors.
