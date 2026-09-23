---
bump: patch
type: docs
impact: internal
---

# First CodeQL triage: dismiss the false positives, record the standing rules

Thirteen of the fifteen CodeQL alerts open on `main` after issue #184 were false
positives, won't-fix, or test-only findings, each verified against the actual
flagged line before being dismissed via the code-scanning API with a reason —
not accepted or rejected on the tool's word alone.

- Dismissed: `js/insufficient-password-hash` ×3 (a SHA-256 hash over a
  `randomBytes(32)` token is not a password hash; `computePkceChallengeS256` is
  RFC 7636 §4.2, which mandates SHA-256), `js/file-access-to-http` ×4 and one
  `js/clear-text-logging` (`tools/seed-cms.ts`'s own purpose — reading local
  seed data and printing a one-time generated password for its operator),
  `js/file-system-race` ×3 (single-user local tooling, or test-only), and one
  each of `js/reflected-xss` and `js/incomplete-url-substring-sanitization`
  (both test-only, not production code paths).
- Left open, on purpose: two `js/clear-text-logging` alerts on
  `apps/cms/scripts/commerce-deploy-preflight.ts` — real findings, fixed as
  code by a sibling change rather than dismissed here.
- `SECURITY.md` gains a "CodeQL triage" section naming where alerts appear, why
  `security-extended` stays the query suite, how an `apps/cms/**` alert is
  triaged (upstream's tree vs. this repo's own `commerce` module), the
  dismissed rule IDs, and the two standing rules above so a future reader does
  not re-litigate them. `docs/alur-kerja-pengembangan.md`'s `codeql` workflow
  section now cross-links it instead of stating a since-outdated "no triage
  playbook yet".

Both changed governance documents ship their Indonesian mirror in this same
change (`bun run docs:i18n:stamp`).
