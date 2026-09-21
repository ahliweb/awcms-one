---
bump: patch
type: fix
impact: internal
---

# `template-init-smoke` no longer runs the full root suite three times at once

Issue #147: two consecutive `main` runs each failed a *different* matrix
leg's final `Root bun test` step on a *different* storefront build-smoke
test's stub-start deadline — three copies of the full suite (each of which
starts its own stub CMS and runs its own `astro build`) competing for the
same two-core runner's CPU/IO, not a real profile-specific defect.

- The `toko`/`berita`/`landing` matrix legs still run the real
  `template:init` for their profile, start the stub CMS with an explicit
  PID and a deterministic `if: always()` teardown that surfaces
  `/tmp/stub-awcms.log` on failure, and build under `SITE_PROFILE`. They
  now assert the build's output with `apps/storefront/scripts/
  assert-profil-dist.ts` — a deterministic, non-rebuilding check derived
  from `apps/storefront/src/config/profil.ts` — instead of re-running a full `bun test`.
- A new `root-suite` job, with no matrix, runs `template:init --profil
  toko` and the full `bun test` exactly once, on its own runner.
- `apps/storefront/tests/profil-uji-bersama.ts` now exports `GROUP_FILES`/
  `GROUP_SITEMAP_PATHS` so `apps/storefront/tests/profil-build-smoke.test.ts` and the new
  assertion script share one definition of "this group's files" rather
  than two that could drift apart.
- No timeout was raised to mask the contention; the workflow is still not
  a required status check — promotion still waits for a run of consecutive
  green `main` runs (docs/alur-kerja-pengembangan.md).

## A second, independent contention source, found while validating this fix

After the job-split above landed, the REQUIRED `Check (toko)` job (a
different workflow, `ci.yml`) still hit the same failure *shape* on two
more PRs (runs `35594952727`/`35595042601`): `"stub-awcms did not answer
http://localhost:<port>/... in time"` inside `build-smoke.test.ts` and the
institution-emblem test, on two more random ports. Diagnosis: every
`*-build-smoke.test.ts` picked `stubPort = <base> + Math.random() * 4000`
— landing inside Linux's own ephemeral range (32768–60999) that a
*concurrent* `astro build`'s own outbound client sockets already use, so a
"free" port could already be bound by a different test's build a moment
earlier. The stub was spawned with `stdout: "pipe", stderr: "pipe"` that
nobody ever read, so a resulting `EADDRINUSE` bind failure (and the
process exiting immediately) was silently buffered — the calling test's
own polling `waitForStub` helper then read identically whether the stub
was slow or already dead, failing only after its own deadline elapsed.

Fixed with a new shared helper, `apps/storefront/tests/stub-lifecycle.ts`'s
`startStub()`: it starts the stub with `STUB_PORT=0` (a real, OS-assigned
free port — no collision possible), resolves readiness from the stub's own
`"serving fixtures on ..."` stdout line (an event, not a poll), and races
that against the process's own exit so a stub that fails to start rejects
immediately with its captured output. Every build-smoke test (and
`apps/storefront/tests/profil-uji-bersama.ts`'s `buildProfile()`) now uses
this one helper instead of its own copy of the random-port-plus-poll
pattern; `apps/storefront/tests/stub-lifecycle.ts`'s own docblock has the
full account. No test's assertions changed. `docs/pengujian.md`/`.id.md`
now describe this lifecycle in place of the old shared-deadline-only
description.

## A third, root-cause finding: `TEMPLATE_INIT_TEST_SCOPE=root` never scoped anything

`main` itself went red after PR #160 merged (run `35594610231`,
`template:init`'s own full-run-in-a-temp-copy test): "killed 1 dangling
process / bun test tests (root gate tests only) failed (exit signal
SIGTERM)", right after the nested run started
`apps/storefront/tests/profil-build-smoke.test.ts`. Reproduced directly: a
bare positional argument to `bun test` is a path **filter** (a substring
match against every test file's path), not a directory restriction —
`bun test tests` matches `apps/storefront/tests/*.test.ts` too, because
that path also contains the substring `tests`. `TEMPLATE_INIT_TEST_SCOPE=
root`'s `bun test tests` therefore silently re-ran the WHOLE workspace
suite (every storefront build-smoke test and its own stub-CMS
`astro build`) inside whatever budget the outer caller sized for "root
gate tests only" — exactly the double-build contention this option exists
to remove, decided by a race rather than prevented by the scope.

`tools/template-init/gates.mjs` now invokes `bun test ./tests/` (a leading
`./` is resolved as a real directory, never as a filter) via a new,
separately-exported `testScopeArgs(scope)`, so the exact argv can be
asserted directly rather than trusted from a docblock —
`tests/gerbang-test-scope.test.mjs` is the permanent regression test: a
temp directory with a root `tests/` file and a nested `apps/x/tests/`
file, proving `testScopeArgs("root")` runs exactly the root one (and, for
contrast, that the OLD `["test", "tests"]` argv runs both). `docs/
template.md`/`.id.md` now explain the filter-vs-directory distinction
where `TEMPLATE_INIT_TEST_SCOPE` is documented.
