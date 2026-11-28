# Vendored SAST rules (local-ci/security)

These are the rules the `local-ci/security` leg runs with the OpenGrep engine (`tools/ci/lib/opengrep-cli.ts`, ADR-0060). They are a frozen copy, not a live download.

| Item | Value |
| --- | --- |
| Source | <https://github.com/opengrep/opengrep-rules> (archived upstream) |
| Commit | `f1d2b562b414783763fd02a6ed2736eaed622efa` (2025-01-26) |
| Scope | every `.yaml` and `.yml` rule file under `javascript/` and `typescript/` at that commit, test fixtures (`*.test.yaml`, `*.fixed.yaml`) excluded: 203 rule files, same relative paths. `yaml/github-actions/` is not vendored: this repository has no root `.github/workflows/` (ADR-0021) |
| Licence | `LICENSE` in this directory, byte-identical to the one at that commit: "Commons Clause" License Condition v1.0 over LGPL-2.1. Licensor of the original `semgrep-rules`: Semgrep, Inc. |
| Integrity | `../rules.lock` lists, in `git ls-tree -r` format (hash first, path last), the git blob SHA-1 of the licence and of each of the 203 files, taken from that commit's tree; `tests/local-ci-opengrep.test.mjs` re-computes them and fails on any difference, addition or removal |

## This directory is not under the repository's MIT licence

The rest of this repository is MIT-licensed (`LICENSE` at the root). The files in this directory are not: they keep their upstream licence, the `LICENSE` file next to them, and a repository created from this template carries them under that same licence.

The Commons Clause condition only withholds the right to "Sell" the software: providing to third parties, for a fee, a product or service whose value derives substantially from the software. Running the rules in a repository's own CI is internal use and does not sell anything. The LGPL-2.1 base grants use, copying and modification. The notice requirement is met by keeping `LICENSE` here, unchanged, next to the rules.

The rules fork predates the relicensing of the upstream `semgrep-rules` repository to the "Semgrep Rules License v1.0" (internal business use only, no redistribution): the last upstream commit in this snapshot is from 2024-12-13 09:04 UTC, before the relicensing commits of that day. Rules from the Semgrep registry or from `semgrep/semgrep-rules` after that date are not used here and must not be added.

## Rules of this directory

- Never edit a rule file here by hand. A change is a deliberate bump: pick a new upstream commit, replace the files, regenerate `../rules.lock`, re-check the licence of that commit, re-run the leg, and record the bump in a changeset.
- Rules written by this repository itself do not go in this directory (the lock test would reject them); put them in a sibling directory and extend the scan configuration.
- The scan excludes this directory.
