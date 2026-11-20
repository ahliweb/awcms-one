---
bump: patch
type: structure
impact: internal
---

# The `local-ci/security` leg pins the CodeQL query pack to its CLI

`tools/ci/runners/security.ts` downloaded `codeql/javascript-queries` without a version and analysed with an unversioned suite reference. On 2026-11-20 the registry's latest pack became 2.5.1, which is built for CodeQL CLI 2.27.5 and ships JSON-with-comments data extensions. The pinned CLI 2.27.1 rejects them ("Invalid data extension file", `codeql resolve extensions-by-pack` exit 2), so every PR's security leg failed for a reason unrelated to the code under review.

- `CODEQL_JS_QUERY_PACK = "codeql/javascript-queries@2.5.0"` sits next to `CODEQL_CLI_VERSION` in `tools/ci/lib/codeql-cli.ts`; 2.5.0 is the newest pack that runs on CLI 2.27.1.
- Both `codeql pack download` and the `database analyze` suite reference use the versioned name. The package cache keeps every version ever downloaded, and an unversioned reference resolves to the newest one there, so pinning only the download would not be enough.
- Moving to a newer pack means bumping the CLI with it (and re-verifying its checksum), deliberately.
