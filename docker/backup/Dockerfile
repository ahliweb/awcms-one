# docker/backup/Dockerfile — issue #213.
#
# The container image `compose.production.yaml`'s `backup`/`restore-drill`/
# `offsite-copy` services run apps/cms/deploy/backup/*.sh inside. This file
# adds NOTHING of its own to the backup/restore logic — it only supplies the
# three things apps/cms/deploy/backup/README.md's own "Base images ship
# neither `age` nor a database client by default" note says a runner image
# needs, on top of the SAME `postgres:18.4` image the production `postgres`
# service itself uses (`pg_dump`/`pg_restore` must be version-matched to the
# server, per that README and every script's own header comment):
#
#   - `age`             — encryption/decryption (ADR-0123, apps/cms)
#   - `rsync`+`openssh-client` — the off-site copy leg (offsite-copy.sh)
#
# apps/cms/deploy/backup/*.sh are bind-mounted read-only into a container
# built from this image (see compose.production.yaml) — nothing here forks,
# reimplements, or wraps their logic; this is exactly the "container that has
# those binaries and no Bun" a backup script's own header already assumes.
# It also carries ONE small glue script of THIS repo's own, select-and-
# offsite-copy.sh — not a fork of any upstream script, just the "pick the
# newest backup artifact" one-liner apps/cms/deploy/cron/awcms.crontab's own
# "Off-site copy" entry already documents inline for host cron, written out
# as a real file so compose.production.yaml's `offsite-copy` service does not
# have to fight docker compose's own `${...}` interpolation inside a `command:`
# block (that interpolation runs before this container ever sees the string).
FROM postgres:18.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends age rsync openssh-client \
    && rm -rf /var/lib/apt/lists/*

COPY select-and-offsite-copy.sh /usr/local/bin/select-and-offsite-copy.sh
RUN chmod 0755 /usr/local/bin/select-and-offsite-copy.sh
