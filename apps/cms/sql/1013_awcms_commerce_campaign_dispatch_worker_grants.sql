-- Issue #403 - what `awcms_worker` needs to run one campaign dispatch tick.
--
-- `commerce:campaigns:dispatch` runs as `awcms_worker` in production
-- (`WORKER_DATABASE_URL`). Per recipient it (a) lazily auto-seeds the
-- tenant's `derived.commerce_campaign` e-mail template on first use
-- (`seedDefaultEmailTemplates`: `INSERT ... ON CONFLICT ... DO NOTHING`), then
-- enqueues the message into the e-mail outbox (`enqueueDirectAddressEmail`:
-- `INSERT INTO awcms_email_messages`) or, for the WhatsApp channel, into the
-- WhatsApp outbox (`enqueueWhatsappMessage`: `INSERT INTO
-- awcms_commerce_whatsapp_messages`). The worker held SELECT/UPDATE/DELETE on
-- those outboxes (`sql/022`, `sql/095`, `sql/925`) and SELECT on the template
-- table, but never INSERT, so the dispatcher worked only as `awcms_app`.
--
-- INSERT is the only verb added. SELECT was already held on each table (the
-- `ON CONFLICT` arbiter read and `RETURNING` need it; `sql/127`'s reasoning).
-- Nothing else changes: no UPDATE on the template table (the seed never
-- overwrites a tenant's copy), and the campaign and recipient tables already
-- carry what the dispatcher needs (`sql/929`).
GRANT INSERT ON awcms_email_templates TO awcms_worker;
GRANT INSERT ON awcms_email_messages TO awcms_worker;
GRANT INSERT ON awcms_commerce_whatsapp_messages TO awcms_worker;
