#!/usr/bin/env bash
# owner-runbook.sh: finishes the 2026-10-24 work that the cloud sandbox cannot
# do. Its GitHub proxy refuses commit statuses, tags, branch deletion and repo
# settings.
#
# Run it from the ROOT of your local awcms-one clone, as the `ahliweb` account
# with `gh auth login` done:
#
#   ./owner-runbook.sh check        # preflight only, changes nothing
#   ./owner-runbook.sh tags         # awcms-one v0.17.0, awcms-astro v0.6.1 + Release, omes-web v0.2.0
#   ./owner-runbook.sh branches     # delete 16 merged remote branches (omes-web, awcms-astro)
#   ./owner-runbook.sh protect      # omes-web #23: merge-commit only + protect main
#   ./owner-runbook.sh awcms-one    # local CI (ci:pr, ~30 min/PR) + merge #453 #457 #475 #477 #479
#   ./owner-runbook.sh awcms-one 477   # just one PR (resumable; skips merged ones)
#
# While ci:pr runs, do not run root `bun test` or a storefront build/dev server
# (ports 4310/4321 collide and fail e2e). `tags` creates only the three tags
# below through the API: it never runs `git push --tags`, so upstream awcms tags
# never reach the product namespace. `branches`/`protect` touch only
# omes-web and awcms-astro (awcms-one main is already protected).
#
# Only the awcms-one section uses this clone. It never touches your working
# tree: CI runs from a disposable runner worktree under $RUNNER_BASE.
# The other sections only call the GitHub API, so awcms-astro and omes-web
# do not need to be cloned.
set -euo pipefail

OWNER=ahliweb
RUNNER_BASE="${RUNNER_BASE:-${TMPDIR:-/tmp}/awcms-one-runbook}"
BUN_VERSIONS_DIR="${BUN_VERSIONS_DIR:-$HOME/.bun-versions}"
AWCMS_ONE_PRS=(453 457 475 477 479)   # merge order matters: #457 moves the Bun pin to 1.4.4

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }
confirm() { read -r -p "$1 [y/N] " a; [[ "$a" == [yY]* ]]; }

# Must run from the awcms-one checkout
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run this inside your awcms-one clone"
cd "$REPO_ROOT"
git remote get-url origin | grep -qiE 'ahliweb/awcms-one(\.git)?$' || die "origin is not ahliweb/awcms-one"
# keep the runbook itself out of commits
grep -qx 'owner-runbook.sh' .git/info/exclude 2>/dev/null || echo 'owner-runbook.sh' >> .git/info/exclude

preflight() {
  command -v gh >/dev/null || die "gh CLI not installed"
  gh auth status >/dev/null 2>&1 || die "run: gh auth login"
  local me; me="$(gh api user --jq .login)"
  [[ "$me" == "$OWNER" ]] || warn "gh is logged in as '$me' (expected '$OWNER'); admin calls may fail"
  command -v curl >/dev/null || die "curl not installed"
  echo "repo root : $REPO_ROOT"
  echo "gh user   : $me"
  echo "bun (PATH): $(command -v bun >/dev/null && bun --version || echo none)"
  echo "docker    : $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'NOT reachable (needed by awcms-one CI legs)')"
}

full_sha() { gh api "repos/$OWNER/$1/commits/$2" --jq .sha; }

# Create an annotated tag on GitHub (idempotent).
make_tag() { # repo tag commit message
  local repo=$1 tag=$2 commit message=$4
  commit="$(full_sha "$repo" "$3")"
  if gh api "repos/$OWNER/$repo/git/ref/tags/$tag" >/dev/null 2>&1; then
    echo "$repo $tag already exists, skipped"; return 0
  fi
  local obj
  obj="$(gh api "repos/$OWNER/$repo/git/tags" -f tag="$tag" -f message="$message" \
          -f object="$commit" -f type=commit --jq .sha)"
  gh api "repos/$OWNER/$repo/git/refs" -f ref="refs/tags/$tag" -f sha="$obj" >/dev/null
  echo "$repo $tag -> ${commit:0:12} (annotated)"
}

changelog_section() { # repo version -> prints the "## [version]" section body from main
  gh api "repos/$OWNER/$1/contents/CHANGELOG.md?ref=main" --jq .content | base64 -d |
    awk -v v="$2" 'BEGIN{h="## [" v "]"} index($0,h)==1{f=1;next} /^##? /{if(f)exit} f'
}

section_tags() {
  say "awcms-one v0.17.0"
  make_tag awcms-one v0.17.0 49c7a296100a40e28968810599d7a1e3269d20ef "v0.17.0"

  say "awcms-astro v0.6.1 + GitHub Release (ADR-0052)"
  make_tag awcms-astro v0.6.1 91fdfe5 "v0.6.1"
  if gh release view v0.6.1 -R "$OWNER/awcms-astro" >/dev/null 2>&1; then
    echo "release v0.6.1 already exists, skipped"
  else
    local notes; notes="$(mktemp)"; changelog_section awcms-astro 0.6.1 > "$notes"
    [[ -s "$notes" ]] || die "could not extract CHANGELOG [0.6.1] from awcms-astro"
    gh release create v0.6.1 -R "$OWNER/awcms-astro" --verify-tag --latest \
      --title "v0.6.1 — dependency keamanan dibersihkan, Bun 1.4.4, dan CodeQL 4.38.2" \
      --notes-file "$notes"
    rm -f "$notes"
  fi

  say "omes-web v0.2.0 (release.yml publishes the GitHub Release from the tag push)"
  make_tag omes-web v0.2.0 d188bfafa420f585879373a0780479c32b726c6a "v0.2.0"
  echo "waiting up to 3 min for release.yml…"
  for _ in $(seq 1 18); do
    gh release view v0.2.0 -R "$OWNER/omes-web" >/dev/null 2>&1 && { echo "omes-web release v0.2.0 published"; return 0; }
    sleep 10
  done
  warn "no omes-web release yet; check: gh run list -R $OWNER/omes-web --workflow release.yml"
}

delete_branch() { # repo branch
  if gh api "repos/$OWNER/$1/git/ref/heads/$2" >/dev/null 2>&1; then
    local ahead; ahead="$(gh api "repos/$OWNER/$1/compare/main...$2" --jq .ahead_by)"
    if [[ "$ahead" != "0" && "$2" != dependabot/* ]]; then
      warn "$1:$2 is $ahead commit(s) ahead of main, kept"; return 0
    fi
    gh api -X DELETE "repos/$OWNER/$1/git/refs/heads/$2" && echo "deleted $1:$2"
  else
    echo "$1:$2 already gone"
  fi
}

section_branches() {
  say "omes-web merged branches"
  for b in chore/sync-awcms-8e9bce0c chore/sync-awcms-9ca28dee docs/redesain-ui-ux-2026-10 \
           fix/bun-audit-advisories release/omes-web-0.2.0; do delete_branch omes-web "$b"; done
  say "awcms-astro merged branches"
  # dependabot/...analyze-4.38.2 is 1 ahead, but CodeQL 4.38.2 is already on main (#134, PR #121 closed superseded)
  for b in chore/codeql-4.38.2 chore/release-0.6.1 chore/125-bun-1.4.4 claude/lucid-tesla-bwijtn \
           dependabot/github_actions/github/codeql-action/analyze-4.38.2 docs/redesain-ui-ux-2026-10 \
           docs/123-bun-realtime-client-boundary docs/127-crm-public-ux fix/deps-security-2026-10 \
           fix/graf-design-di-luar-cakupan fix/serapan-adr-0125-0146; do delete_branch awcms-astro "$b"; done
}

section_protect() {
  say "omes-web #23: merge methods"
  gh api -X PATCH "repos/$OWNER/omes-web" -F allow_merge_commit=true -F allow_squash_merge=false \
    -F allow_rebase_merge=false -F delete_branch_on_merge=true \
    --jq '{allow_merge_commit,allow_squash_merge,allow_rebase_merge,delete_branch_on_merge}'
  say "omes-web #23: protect main (12 checks verified green on PR #27; linear history OFF for subtree merges)"
  gh api -X PUT "repos/$OWNER/omes-web/branches/main/protection" --input - >/dev/null <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": [
    "Check (toko)", "Check (berita)", "Check (landing)", "check-cms",
    "template-init-smoke (toko)", "template-init-smoke (berita)",
    "template-init-smoke (landing)", "template-init-smoke (root-suite)",
    "e2e (toko)", "e2e (berita)", "e2e (landing)", "Analyze (javascript-typescript)" ] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
  gh api "repos/$OWNER/omes-web/branches/main/protection" \
    --jq '{checks: .required_status_checks.contexts, strict: .required_status_checks.strict, admins: .enforce_admins.enabled, reviews: .required_pull_request_reviews.required_approving_review_count}'
  echo "Paste the output above into omes-web #23 as evidence."
}

# Bun: use the exact version a checkout pins
ensure_bun() { # version -> prints path to a bun binary of that version
  local v=$1
  if command -v bun >/dev/null && [[ "$(bun --version)" == "$v" ]]; then command -v bun; return; fi
  local dir="$BUN_VERSIONS_DIR/$v"
  if [[ ! -x "$dir/bin/bun" ]]; then
    echo "installing Bun $v into $dir (official installer)" >&2
    curl -fsSL https://bun.sh/install | BUN_INSTALL="$dir" bash -s "bun-v$v" >&2
  fi
  [[ "$("$dir/bin/bun" --version)" == "$v" ]] || die "Bun $v install failed"
  echo "$dir/bin/bun"
}
pin_of() { git show "$1:package.json" | sed -n 's/.*"packageManager": *"bun@\([0-9.]*\)".*/\1/p'; }

prepare_runner() { # ref -> sets RUNNER (a clean worktree at ref)
  RUNNER="$RUNNER_BASE/runner"
  mkdir -p "$RUNNER_BASE"
  if git worktree list --porcelain | grep -qx "worktree $RUNNER"; then
    git -C "$RUNNER" checkout -q --detach "$1"
    git -C "$RUNNER" clean -qfdx -e node_modules
  else
    git worktree add -q --detach "$RUNNER" "$1"
  fi
}

run_pr() { # pr number
  local n=$1 state draft
  state="$(gh pr view "$n" --json state --jq .state)"
  [[ "$state" == "MERGED" ]] && { echo "#$n already merged, skipped"; return 0; }
  [[ "$state" == "OPEN" ]] || die "#$n is $state"
  say "awcms-one #$n: $(gh pr view "$n" --json title --jq .title)"

  draft="$(gh pr view "$n" --json isDraft --jq .isDraft)"
  if [[ "$draft" == "true" ]]; then
    confirm "#$n is a draft; mark it ready for review?" || { warn "skipped #$n"; return 0; }
    gh pr ready "$n"
  fi

  # bring the PR up to date with main by a MERGE commit (never rebase)
  gh pr update-branch "$n" 2>/dev/null && echo "updated #$n from main (merge commit)" || echo "#$n already up to date"
  sleep 10   # let GitHub finish the update-branch merge
  git fetch -q origin main
  git fetch -q origin "refs/pull/$n/head"
  local head; head="$(git rev-parse FETCH_HEAD)"

  # Runner = trusted tooling on origin/main, unless the PR moves the Bun pin
  # (#457: 1.4.3 -> 1.4.4). ci:pr enforces runner pin == running Bun, and the
  # PR's own tests need its pin, so then the runner is the PR head.
  local main_pin pr_pin runner_ref=origin/main
  main_pin="$(pin_of origin/main)"; pr_pin="$(pin_of "$head")"
  if [[ "$main_pin" != "$pr_pin" ]]; then
    warn "#$n pins bun@$pr_pin but main pins bun@$main_pin; the CI tooling must run from the PR head."
    confirm "Run ci:pr from #$n's head (${head:0:12})?" || { warn "skipped #$n"; return 0; }
    runner_ref="$head"
  fi
  prepare_runner "$runner_ref"
  local bunbin; bunbin="$(ensure_bun "$(pin_of "$runner_ref")")"
  echo "runner: $RUNNER @ $(git -C "$RUNNER" rev-parse --short HEAD) | bun $("$bunbin" --version)"

  ( cd "$RUNNER"
    PATH="$(dirname "$bunbin"):$PATH"
    bun install --frozen-lockfile
    bun run ci:pr -- "$n" )                       # posts local-ci/* to the exact head SHA

  # merge only if all 12 required contexts are success on exactly that SHA
  local ok
  ok="$(gh api "repos/$OWNER/awcms-one/commits/$head/status?per_page=100" \
        --jq '[.statuses[] | select(.context|startswith("local-ci/")) | select(.state=="success")] | length')"
  [[ "$ok" -ge 12 ]] || die "#$n: only $ok/12 local-ci statuses are success on ${head:0:12}; not merging"
  gh pr merge "$n" --merge --match-head-commit "$head"
  echo "#$n merged"
}

section_awcms_one() {
  command -v docker >/dev/null && docker version >/dev/null 2>&1 || die "Docker must be running (Postgres, gitleaks)"
  git fetch -q origin
  local prs=("$@"); [[ ${#prs[@]} -gt 0 ]] || prs=("${AWCMS_ONE_PRS[@]}")
  for n in "${prs[@]}"; do run_pr "$n"; done
  say "done. Remove the runner with: git worktree remove --force '$RUNNER_BASE/runner'"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  check)      preflight ;;
  tags)       preflight; section_tags ;;
  branches)   preflight; section_branches ;;
  protect)    preflight; section_protect ;;
  awcms-one)  preflight; section_awcms_one "$@" ;;
  all)        preflight; section_tags; section_branches; section_protect; section_awcms_one ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
