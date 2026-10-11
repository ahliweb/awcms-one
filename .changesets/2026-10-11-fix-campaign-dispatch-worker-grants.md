---
bump: patch
type: fix
impact: internal
---

# Fix: campaign dispatch runs as the least-privilege `awcms_worker` role

`awcms_worker` lacked `INSERT` on `awcms_email_templates`, `awcms_email_messages` and `awcms_commerce_whatsapp_messages`, so `commerce:campaigns:dispatch` worked only as `awcms_app` and failed in production, where jobs run as the worker. Migration `sql/1013` grants exactly those three `INSERT`s, mirrored in `WORKER_ROLE_GRANTS`, with an integration test running one dispatch tick as the real worker role on both channels (#403). Run `bun run db:migrate` on deploy.
