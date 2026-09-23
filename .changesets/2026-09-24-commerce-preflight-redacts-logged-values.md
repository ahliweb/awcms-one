---
bump: patch
type: structure
impact: internal
---

# `commerce:deploy:preflight` redacts credential-shaped values before printing

CodeQL's first triage after the production-preflight work (#184) flagged two
`js/clear-text-logging` alerts on `apps/cms/scripts/commerce-deploy-preflight.ts`:
the two paths that echo a delegated script's captured child-process stderr
print a value CodeQL taints back to `process.env`. Neither path was actually
printing a credential today, but the property was only true by hand-checked
convention in a script whose output runs through deploy pipelines with
retained logs.

- A single exported `redact()` helper now masks a `postgres://user:pass@host`
  DSN's password, a bearer/API-token-shaped value, and the whole value of any
  env variable whose NAME matches `/(PASSWORD|SECRET|TOKEN|KEY|DSN|DATABASE_URL)/i`.
- Applied to every string the script actually prints — `printResult`, the
  `main()` startup banner, and both captured child-process stderr/stdout
  tails — so nothing bypasses it. A benign value (a provider name, a role
  name, a plain URL) passes through unchanged, unit-tested alongside the
  three masked shapes in `apps/cms/tests/commerce-deploy-preflight.test.ts`.
- `docs/deployment.md` (+ its Indonesian mirror) now says what the preflight
  prints and what it redacts.
