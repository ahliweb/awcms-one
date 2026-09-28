---
bump: patch
type: fix
impact: public
---

# `release:images` runs cosign as root so it can read registry credentials (#263)

`tools/release/lib/cosign.mjs`'s `cosignSignArgs`/`cosignVerifyArgs` now run the pinned cosign container with `--user 0 -e HOME=/root`, right after `docker run --rm --network host`.

- The pinned cosign image's own `Config.User` is `65532` with no `HOME` set, so it never looked in `/root` — where `~/.docker/config.json` is mounted — for registry credentials. Even when it did look, the mounted file is normally `0600` on the host, unreadable by that uid anyway.
- `cosign sign`/`cosign verify` against an authenticated registry (GHCR included) therefore failed with `accessing image ... UNAUTHORIZED`, for `sign` **after the image had already been pushed unsigned**.
- Proven 29 Sep 2026 against a local authenticated `registry:2`: the old argv fails, `--user 0 -e HOME=/root` (config and key both `0600`) succeeds. Trivy and syft already run as root and needed no change.
- `docs/rilis.md`'s "Rehearsing without touching GHCR" now uses an authenticated throwaway registry (htpasswd via `httpd:2`), so this path stays exercised by anyone following the recipe; the earlier unauthenticated version is exactly what missed this bug.
- `v0.14.1`'s already-built images could not be signed/published with the old tooling (`release:images` requires `HEAD == tag`); this fix ships as `v0.14.2`, released against the same tag once cut.
