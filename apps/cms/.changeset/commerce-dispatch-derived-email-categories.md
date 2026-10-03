---
"awcms": patch
---

fix(commerce): register the `derived.commerce_*` e-mail categories in the `email:dispatch` process (Issue #311, awcms-one)

`commerce`'s three derived e-mail categories move into one side-effect file (`src/modules/commerce/domain/email-template-categories.ts`) that `email/application/email-dispatch.ts` also imports, so the separate dispatcher renders OTP codes, conversation replies and campaign e-mails with their variables instead of empty. Allow-list semantics unchanged.
