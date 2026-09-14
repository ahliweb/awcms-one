🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](SECURITY.id.md)

# Security Policy

## Reporting a vulnerability

**Do not open a public issue for an exploitable vulnerability.**

Report it through [GitHub Security Advisory](https://github.com/ahliweb/awcms-one/security/advisories/new) (a private route). Include reproduction steps, the impact you estimate, and the commit you tested.

We aim for an initial response within **3 working days** and a fix for a confirmed vulnerability within **14 working days**, depending on severity.

## Two different surfaces, reported the same way but owned differently

This repo is a monorepo, and today it holds one real attack surface plus the machinery around it:

- **`apps/cms`** — `ahliweb/awcms`, embedded whole via `git subtree`. It is this platform's system of record: the database, authentication, authorization (RBAC/ABAC), and every module that will eventually store commerce data. A vulnerability found in its code, as it stands in this repository, is reported here (GitHub Security Advisory on `ahliweb/awcms-one`), because that is where the affected code actually runs. [`apps/cms/SECURITY.md`](apps/cms/SECURITY.md) (carried over from upstream) documents that surface's own specifics in more depth. If the same defect is unpatched in current `ahliweb/awcms` too, report it there as well, since other deployments of that project share it — this repo's own copy is fixed here regardless, following the subtree pull described in [`AGENTS.md`](AGENTS.md#the-subtree-embed).
- **The workspace root** (`packages/gerbang/`, `tools/`, `tests/`) — build and release tooling, not a running service. It has no network listener, no database connection, and no user-facing surface at all; its only external interaction is spawning `git` as an argv array (never through a shell — see `packages/gerbang/lib/git.mjs`). A vulnerability class here looks like a script that can be made to write outside the repo, or one that would execute something an attacker controls (a hostile branch name, a hostile changeset file name) — report it the same way, here.

**`apps/storefront` does not exist yet** ([issue #5](https://github.com/ahliweb/awcms-one/issues/5)). This document will grow a section for its own surface — reading `apps/cms`'s public API, rendering to a reader's browser — once it does.

## What is NOT yet true, stated plainly

**There is no live production deployment of this platform yet.** Increment 1 (the current epic, [issue #1](https://github.com/ahliweb/awcms-one/issues/1)) is foundation plus one authored vertical slice, with no live database — migrating and seeding a real PostgreSQL instance is increment 2. Until then, there is no running system at `mart.borneojek.com` for this repo's own code to expose; the surface that exists is `apps/cms`'s general-purpose one as `ahliweb/awcms`, not this platform's own commerce data.

## Controls in force today

- **No secret, token, or credential** in code, commits, issues, or documentation.
- **`bun audit` must report zero vulnerabilities** before a release (`tools/rilis.mjs` runs it before applying).
- **GitHub Actions are pinned to a commit SHA**, not a tag — see `AGENTS.md`'s "Configuration and toolchain".
- **A `git subtree pull` PR is merged with a merge commit, never squashed or rebased** — not a security control against an external attacker, but a control against corrupting this repo's own ability to pull upstream security patches into `apps/cms` in the future. See `AGENTS.md`'s "The subtree embed".

## Not a security vulnerability

The following matter, but are not security reports — use an ordinary issue, or the routes in [`SUPPORT.md`](SUPPORT.md):

- A defect in `apps/cms` that is purely `ahliweb/awcms`'s own general-purpose behaviour, unrelated to this platform's commerce work.
- A missing feature, or a gap between the borneojek-mart source schema and what has landed here so far — see [issue #1](https://github.com/ahliweb/awcms-one/issues/1) for what is in scope for the current increment.
