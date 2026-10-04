---
bump: patch
type: fix
impact: public
---

# Fix: customer e-mail OTPs, conversation replies and campaign e-mails were sent with empty variables (#311)

`email:dispatch` runs as its own process and renders each queued message at send time. `commerce` registered its `derived.commerce_*` e-mail categories only as an import side effect of application files that process never loaded, so `renderEmailTemplate` treated them as unknown and substituted nothing: the customer e-mail OTP went out without its code (login and register by e-mail were broken), and conversation replies and campaign e-mails lost their variables. WhatsApp OTP was unaffected.

The three registrations now live in one dependency-free file, `apps/cms/src/modules/commerce/domain/email-template-categories.ts`, imported by the existing application files and by `email/application/email-dispatch.ts` (one recorded upstream divergence in `AGENTS.md`). The allow-list semantics are unchanged: an unregistered category still renders no variables. Regression tests spawn a fresh process importing only the dispatcher, and an integration test drains a real OTP e-mail through `dispatchEmailQueue` into a capturing provider.
