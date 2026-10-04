---
bump: minor
type: structure
impact: public
---

# Deliver receipts, invoices, quotations and work-order notices by e-mail and WhatsApp (issue #295, ADR-0034)

A receipt could be printed but not sent. It can now be delivered to the customer by e-mail or WhatsApp **without a new notification subsystem**: a delivery is an append-only request row (`awcms_commerce_document_deliveries` — migrations `965`–`967` under `apps/cms/sql/`, starting at `apps/cms/sql/965_awcms_commerce_document_deliveries_schema.sql`) in front of the two outboxes that already exist, whose dispatchers keep calling the providers outside any transaction. The options weighed, the transactional-versus-marketing decision and the one deviation (the three source references are a trigger, not foreign keys, because this issue's migration range sorts before the tables they reference) are in [ADR-0034](../docs/adr/0034-commercial-documents-are-delivered-through-the-existing-outboxes-as-transactional-messages-built-from-immutable-sources.md).

- New: `POST /api/v1/commerce/document-deliveries` (idempotent; a new key is an explicit, attributable re-send; five per document per rolling hour) and `GET /api/v1/commerce/document-deliveries?targetType=&targetId=` (the history, with each outbox row's live status, provider message id, retry count and last error); a **Deliver** dialog on `/admin/commerce-documents`; an opt-in private link to a receipt's print view (`GET /api/v1/commerce/storefront/document-links/{token}` — opaque, hashed at rest, expires within 168 hours, audited). Event `awcms.commerce.document.delivery_requested`.
- The message is built from a stored source only: a document's snapshot (hash re-verified), a quotation version, or a work order's status and target date. An order edited after issue cannot change a re-send; money in a message is the snapshot's own string.
- Transactional, not marketing: marketing consent is not required, the e-mail suppression list is honoured, the recipient defaults to the customer the document names, and any other recipient needs its own permission and is stored masked. No address, name or message body is stored in the delivery table, its audit events or its logs.
- Three new permissions, none implied by the document, quotation or work-order keys: `commerce.document_deliveries.{read,create}` and `commerce.document_delivery_overrides.create`. Existing tenants do not gain them retroactively.
- **Backward compatible, opt-in.** Behind the new `documentDelivery` feature flag (commerce settings → Features), which defaults OFF and also needs `documents`; a channel additionally needs `EMAIL_ENABLED` / `COMMERCE_WHATSAPP_ENABLED` and its dispatcher scheduled, as it already did. New optional env `COMMERCE_DOCUMENT_LINK_BASE_URL` (falls back to `APP_URL`). No existing table gained a column; one partial index was added to the WhatsApp outbox for the correlation-id join.
- Not here yet (ADR-0034 Deferred): customer-requested resend, PDF, a push channel, automatic delivery on payment or status change, a WhatsApp opt-out list, link revocation.
