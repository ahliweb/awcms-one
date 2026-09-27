---
bump: patch
type: fix
impact: public
---

# Apply Debian security updates in the storefront runtime image

`apps/storefront/Dockerfile`'s `runtime` stage is `FROM oven/bun:${BUN_VERSION}-slim`, a
Debian base that only carries the package versions current the day that tag
was cut. A trivy scan of `oven/bun:1.4.2-slim` (27 Sep 2026, `--severity
CRITICAL`) found three CRITICAL CVEs — CVE-2026-13221, CVE-2026-42496,
CVE-2026-8376 — all in `perl-base` 5.40.1-6, all fixed by Debian security in
5.40.1-6+deb13u1.

- The `runtime` stage now runs `apt-get update && apt-get upgrade -y
  --no-install-recommends && rm -rf /var/lib/apt/lists/*` before `USER bun`,
  closing these (and future Debian-security fixes) on every rebuild rather
  than waiting on `oven/bun` to re-cut the base tag.
- Only the `runtime` stage changes; `deps` and `build` are untouched.
- `docs/deployment.md`/`.id.md` describe the updated runtime stage.
- New test: `tests/storefront-dockerfile-security-updates.test.mjs` asserts
  the upgrade-and-cleanup RUN precedes `USER bun`.
