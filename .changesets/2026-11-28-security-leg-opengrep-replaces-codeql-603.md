---
bump: minor
type: fix
impact: internal
---

# The `local-ci/security` leg runs OpenGrep instead of CodeQL

CodeQL is no longer run anywhere in the portfolio, public repositories included (owner decision of 2026-11-27, internal cross-portfolio standard DL-098): the repositories created from this template are usually private, where the CodeQL terms forbid the CLI without a paid GitHub Advanced Security licence. Since then the leg could not run, so `local-ci/security` could not be posted green for any PR (issue #603). [ADR-0060](../docs/adr/0060-sast-with-opengrep-replaces-codeql-in-the-security-leg.md) records the decision and the blind spots it accepts.

- The leg runs OpenGrep `v2.1.0` (`opengrep_linux_x86`, sha256-pinned, downloaded to a `.part` file and verified before use, re-verified from the cache), gitleaks and `bun audit` (both unchanged). The context name stays `local-ci/security`.
- Rules: 203 `.yaml`/`.yml` rules under `javascript/` and `typescript/` vendored from `opengrep/opengrep-rules` at `f1d2b562b414783763fd02a6ed2736eaed622efa`, with the upstream `LICENSE` and `tools/ci/sast/rules.lock` (git blob id per file, checked by `tests/local-ci-opengrep.test.mjs`). That directory keeps its own licence (Commons Clause over LGPL-2.1), not the repository's MIT.
- The gate fails only on an ERROR finding outside `tools/ci/security-baseline.json` (rule id + path); WARNING and INFO are counted, not gated. Offline scan (`--disable-version-check`, `SEMGREP_SEND_METRICS=off`, no `--metrics`), `--jobs` from `CI_LOKAL_CPUS` (default 5), no upload to code scanning.
- The adoption baseline was generated once on the CI server with `bun tools/ci/cli/sast-baseline.ts` at commit `3ab6849` (OpenGrep `v2.1.0`, 8771 files, 278 s): 27 ERROR findings in 21 (rule id, path) entries, 1250 WARNING and 770 INFO counted only. Every entry is recorded as a pre-existing finding that is not yet triaged; `BASELINE_CEILING` in `tests/local-ci-baseline.test.mjs` is 21, and the baseline only shrinks from here. The CodeQL-era entries (CodeQL rule ids) are gone; their reasoning stays in `SECURITY.md`.
- Removed: `.github/codeql/codeql-config.yml`, the `codeql-cli.ts` and `sarif.ts` modules under `tools/ci/lib/` (with the CLI and query-pack pins), the SARIF upload and the `--upload-sarif` option of `bun run ci`. The local-CI token needs `statuses:write` only.
