#!/usr/bin/env bash
#
# select-and-offsite-copy.sh — issue #213.
#
# Thin glue, not backup logic: selects the newest eligible backup artifact
# under $BACKUP_DIR and its verifiable sidecars, then hands them unmodified
# to apps/cms/deploy/backup/offsite-copy.sh (bind-mounted at /scripts, never
# copied/forked). The selection algorithm itself — `find` with `-print0`,
# not a `ls`/glob pipeline — is copied from apps/cms/deploy/backup/
# restore-drill.sh's own `select_backup()`, the ONE place upstream already
# solved "pick the newest eligible artifact" correctly: a `ls -1t
# label_*.dump label_*.dump.age` pipeline breaks under `set -e -o pipefail`
# the moment either glob matches nothing (an unmatched glob is passed to
# `ls` as a literal filename, `ls` exits non-zero for the missing one, and
# pipefail then poisons the whole pipeline's exit status even though `head`
# itself succeeded) — exactly the shape of bug apps/cms/deploy/cron/
# awcms.crontab's own inline one-liner avoids only because that crontab
# entry does NOT run under `set -e`. This script does, so it uses the safe
# algorithm instead of the fragile one.
#
# Env:
#   BACKUP_DIR     default /backup (matches the compose service's own mount).
#   BACKUP_LABEL   default awcms-one — must match backup-postgres.sh's own
#                  BACKUP_LABEL, or nothing will be selected.
set -euo pipefail

die() {
  printf 'select-and-offsite-copy: %s\n' "$*" >&2
  exit 1
}

backup_dir="${BACKUP_DIR:-/backup}"
label="${BACKUP_LABEL:-awcms-one}"

[ -d "$backup_dir" ] || die "BACKUP_DIR does not exist: $backup_dir"

newest=""
newest_mtime=0
while IFS= read -r -d '' candidate; do
  mtime="$(stat -c %Y "$candidate" 2>/dev/null || stat -f %m "$candidate" 2>/dev/null)"
  if [ "$mtime" -gt "$newest_mtime" ]; then
    newest="$candidate"
    newest_mtime="$mtime"
  fi
done < <(find "$backup_dir" -maxdepth 1 -type f \( -name "${label}_*.dump" -o -name "${label}_*.dump.age" \) -print0)

[ -n "$newest" ] ||
  die "no eligible backup found under ${backup_dir} matching ${label}_*.dump or ${label}_*.dump.age"

siblings=()
for s in "${newest}.sha256" "${newest}.manifest.json" "${newest}.manifest.json.hmac"; do
  [ -f "$s" ] && siblings+=("$s")
done

exec /scripts/offsite-copy.sh "$newest" "${siblings[@]}"
