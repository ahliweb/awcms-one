#!/bin/sh
# docker/postgres-init/01-create-least-privilege-roles.sh — issue #25.
#
# Runs once, automatically, the FIRST time the `postgres` service's named
# volume is empty (the official postgres image's own entrypoint executes
# every `/docker-entrypoint-initdb.d/*.sh` in this container exactly then,
# before accepting any other connection — never again against a volume that
# already has data, which is why `bun run db:reset` has to drop the volume to
# re-run this).
#
# ## What this creates, and — more importantly — what it does NOT
#
# `apps/cms`'s own migrations already create three roles: `awcms_app`
# (sql/019), and `awcms_worker`/`awcms_setup` (sql/022). Each is created
# `NOLOGIN` and passwordless ON PURPOSE — a password is a secret and a
# committed SQL migration is not where secrets live (see each file's own
# header). Every GRANT those roles hold is likewise the migrations' job
# (sql/019, sql/021, sql/022) and stays there; duplicating any GRANT here
# would be a second, drifting source of truth for privileges a migration can
# narrow or widen later.
#
# So this script's entire job is the ONE thing no migration does: give each
# role a real password and flip it to `LOGIN`. It runs BEFORE
# `bun run db:migrate:cms` in the documented sequence (docs/deployment.md),
# so when each migration's own
# `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '...')` guard runs,
# the role already exists — the migration is a no-op for the role itself
# (its `IF NOT EXISTS` skips the `CREATE ROLE ... NOLOGIN`) and only applies
# its GRANTs, exactly as sql/019's own header describes: "a deployment init
# script may have created it (with LOGIN) already, in which case this is a
# no-op and the LOGIN attribute is preserved."
#
# The migration OWNER connection (`POSTGRES_USER`/`POSTGRES_PASSWORD`, a
# Postgres superuser on the official image) needs no role of its own here —
# the official image already creates it from those two environment
# variables before any `/docker-entrypoint-initdb.d` script runs.
set -eu

for var in AWCMS_APP_PASSWORD AWCMS_WORKER_PASSWORD AWCMS_SETUP_PASSWORD; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    echo "postgres-init: \$$var is required (see root .env.example) — refusing to create a role with an empty password." >&2
    exit 1
  fi
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awcms_app') THEN
      CREATE ROLE awcms_app LOGIN PASSWORD '${AWCMS_APP_PASSWORD}';
    ELSE
      ALTER ROLE awcms_app LOGIN PASSWORD '${AWCMS_APP_PASSWORD}';
    END IF;
  END
  \$\$;

  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awcms_worker') THEN
      CREATE ROLE awcms_worker LOGIN PASSWORD '${AWCMS_WORKER_PASSWORD}';
    ELSE
      ALTER ROLE awcms_worker LOGIN PASSWORD '${AWCMS_WORKER_PASSWORD}';
    END IF;
  END
  \$\$;

  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awcms_setup') THEN
      CREATE ROLE awcms_setup LOGIN PASSWORD '${AWCMS_SETUP_PASSWORD}';
    ELSE
      ALTER ROLE awcms_setup LOGIN PASSWORD '${AWCMS_SETUP_PASSWORD}';
    END IF;
  END
  \$\$;
EOSQL

echo "postgres-init: awcms_app / awcms_worker / awcms_setup are LOGIN-capable (grants remain the migrations' job)."
