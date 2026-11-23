---
bump: patch
type: fix
impact: internal
---

# The local CI stops leaking CodeQL databases and postgres volumes

`~/.local/state/awcms-one-ci/evidence` grew from about 26 GB to 71 GB in four days, and unnamed Docker volumes added another 12-15 GB every few days, until the operator's disk reached 92%. Two legs caused it.

- `tools/ci/runners/security.ts` created the CodeQL database inside the evidence directory (about 1.2 GB per run) and never removed it. It is now removed in a `finally` as soon as analysis ends, pass or fail. The SARIF and the create/analyze logs remain as the evidence; the database is an intermediate and is not needed after the SARIF is written.
- `tools/ci/runners/check-cms.ts` removed its `postgres:18.6` container with `docker rm -f`. That image declares `VOLUME /var/lib/postgresql`, so every run left an anonymous volume behind. It is now `docker rm -f -v`.
