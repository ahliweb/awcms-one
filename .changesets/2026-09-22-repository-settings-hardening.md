---
bump: patch
type: structure
impact: internal
---

# Repository settings hardening: admin enforcement, conversation resolution, template-init-smoke required

Issue #182 closed a gap between what `main`'s branch protection actually enforced and what a maintainer merging solo could still get away with: until now, an administrator (the only role that ever merges here) could push past a red or pending required check, and a review thread could be left unresolved at merge time. Neither is a defect a reviewer would catch, because both only matter on the one PR where someone is in a hurry — exactly when a mechanical gate is worth more than a habit.

- `enforce_admins` is now on: an administrator merging `main` is held to the same required-status-check bar as anyone else.
- `required_conversation_resolution` is now on: every review conversation on a PR must be marked resolved before it can merge.
- All four `template-init-smoke` legs (`toko`, `berita`, `landing`, `root-suite`) are now required status checks, alongside the existing `check-cms`/`Check (toko)`/`Check (berita)`/`Check (landing)` four — the workflow has run green on `main` with no path filter since issue #147's job split, so the promotion this document always described as pending has now happened.
- Secret scanning and push protection were confirmed on; two additional toggles (`secret_scanning_non_provider_patterns`, `secret_scanning_validity_checks`) were attempted but remain `disabled` — they appear to require a GitHub Secret Protection licence this user-owned public repository cannot enable. Documented as unavailable rather than claimed as enabled.
- The repository wiki was disabled after confirming it held nothing (`ahliweb/awcms-one.wiki.git` did not exist) — this repository's documentation already lives under `docs/**`.
- `.gitignore` now ignores `/redesign/`, so a local design-source drop (e.g. an unpacked redesign zip used as reference input) is never accidentally staged.

No code, schema, or runtime behaviour changes. `docs/alur-kerja-pengembangan.md`, `AGENTS.md`, `README.md`, and `docs/template.md` (each with its Indonesian mirror) are updated to match the settings as verified, with the `gh api` commands to re-verify them.
