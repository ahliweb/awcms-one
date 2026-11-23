---
bump: minor
type: structure
impact: internal
---

# `audit:data-pribadi` — a personal-data scan gate for the git tree

A new root gate, `bun run audit:data-pribadi` (issue #533), scans every git-tracked file for personal data that is usually pasted by accident into fixtures, snapshots, logs and issue text.

- Five generic categories: a national-identity-number-shaped number, a mobile number, an e-mail address outside the placeholder domains, a cloud-drive link carrying a file id, and a tracked spreadsheet/CSV/archive/log/snapshot file.
- Findings print as `path:line` under a category heading and **never the value**, so the gate cannot copy a leak into CI logs.
- False positives live in `packages/gerbang/data-pribadi-allowlist.json`, one entry with a reason each; an entry that covers nothing fails the gate so the list cannot rot.
- `apps/cms/**` (the upstream subtree) is skipped, except for sub-paths a derived product declares in `OWNED_SUBTREE_PATHS`. Patterns, placeholder domains and reserved prefixes are data in `packages/gerbang/lib/data-pribadi-config.mjs`, so a derived product tunes them without editing the scanner.
- `--history` is an opt-in diagnostic over past commits' added lines; it is not part of CI and always exits 0.
- Wired into `local-ci/check-toko` beside the other root audits.
