import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Parses `compose.production.yaml` (issue #150, ADR-0019) with `Bun.YAML` —
 * available since Bun 1.4, so no extra dependency is added for a file this
 * repo's own root tooling never needs to parse at runtime, only to verify.
 *
 * These assertions are the compose file's own load-bearing claims, stated in
 * its comments: no literal credential value anywhere in it, the runtime
 * `cms`/`jobs` DSNs are documented as `awcms_app`/`awcms_worker` (never
 * `awcms_setup`/`postgres`), postgres publishes no host port, and the
 * storefront build never takes `AWCMS_API_TOKEN` as a build ARG.
 */

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const COMPOSE_PATH = join(REPO_ROOT, "compose.production.yaml");
const raw = readFileSync(COMPOSE_PATH, "utf8");
const doc = Bun.YAML.parse(raw);

/** A value that LOOKS like a real, hardcoded credential rather than a `${VAR}` reference, a placeholder path, or a plain identifier. */
function looksLikeHardcodedSecret(value) {
  if (typeof value !== "string") return false;
  if (value.includes("${")) return false; // an env-var reference, not a literal
  // A long, high-entropy-looking alnum string with no spaces and no slash —
  // the shape of an actual password/token, not a role name or a path.
  return /^[A-Za-z0-9_\-.]{20,}$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

function walkStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) walkStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) walkStrings(v, out);
  }
  return out;
}

describe("compose.production.yaml", () => {
  test("parses and declares the expected services", () => {
    expect(Object.keys(doc.services).sort()).toEqual(
      [
        "backup",
        "cms",
        "jobs",
        "jobs-app",
        "migrate",
        "offsite-copy",
        "postgres",
        "restore-drill",
        "storefront"
      ].sort()
    );
  });

  test("no service's environment/build-args contains a hardcoded credential-shaped value", () => {
    const offenders = [];
    for (const [name, service] of Object.entries(doc.services)) {
      const strings = walkStrings(service.environment ?? {})
        .concat(walkStrings(service.build?.args ?? {}));
      for (const value of strings) {
        if (looksLikeHardcodedSecret(value)) offenders.push(`${name}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("cms's runtime DATABASE_URL is documented as the awcms_app role, never awcms_setup/postgres", () => {
    const env = doc.services.cms.environment;
    expect(env.DATABASE_URL).toMatch(/awcms_app/);
    expect(env.DATABASE_URL).not.toMatch(/awcms_setup/);
  });

  test("jobs's runtime DATABASE_URL is documented as the awcms_worker role", () => {
    const env = doc.services.jobs.environment;
    expect(env.DATABASE_URL).toMatch(/awcms_worker/);
  });

  test("migrate uses the privileged setup DSN, distinct from cms/jobs", () => {
    const env = doc.services.migrate.environment;
    expect(env.DATABASE_URL).toMatch(/SETUP_DATABASE_URL/);
  });

  test("postgres publishes no host port by default", () => {
    expect(doc.services.postgres.ports).toBeUndefined();
  });

  test("postgres has no env_file — it must never receive apps/cms's own secrets (issue #150 review)", () => {
    // Every ${VAR:?...} on postgres is meant to be interpolated by `docker
    // compose` itself from the root .env/shell — the SAME source
    // compose.yaml's own local/CI postgres service already reads. An
    // `env_file: [apps/cms/.env]` here would hand the DATABASE container
    // every apps/cms-only secret (Midtrans server key, WhatsApp tokens, …)
    // it has no reason to hold.
    expect(doc.services.postgres.env_file).toBeUndefined();
  });

  test("cms and storefront publish no host port by default (reverse proxy expected in front)", () => {
    expect(doc.services.cms.ports).toBeUndefined();
    expect(doc.services.storefront.ports).toBeUndefined();
  });

  test("storefront's build has no AWCMS_API_TOKEN build arg — it is a BuildKit secret instead", () => {
    const args = doc.services.storefront.build.args ?? {};
    expect(Object.keys(args)).not.toContain("AWCMS_API_TOKEN");
    expect(doc.services.storefront.build.secrets).toContain("awcms_api_token");
  });

  test("storefront's runtime carries no env_file/environment/secrets — a static build needs no runtime credential", () => {
    const service = doc.services.storefront;
    expect(service.env_file).toBeUndefined();
    expect(service.environment).toBeUndefined();
    expect(service.secrets).toBeUndefined();
  });

  test("migrate and jobs are gated behind explicit profiles, never started by a plain `up`", () => {
    expect(doc.services.migrate.profiles).toEqual(["migrate"]);
    expect(doc.services.jobs.profiles).toEqual(["jobs"]);
    expect(doc.services["jobs-app"].profiles).toEqual(["jobs-app"]);
  });

  test("jobs-app holds the APP role DSN (the cms one), never the worker/setup DSN, and jobs never holds the app DSN", () => {
    const app = doc.services["jobs-app"].environment.DATABASE_URL;
    expect(app).toMatch(/^\$\{DATABASE_URL:\?/);
    expect(app).toMatch(/awcms_app/);
    expect(app).not.toMatch(/WORKER_DATABASE_URL|SETUP_DATABASE_URL/);
    expect(doc.services.jobs.environment.DATABASE_URL).not.toMatch(/^\$\{DATABASE_URL[:}-]/);
    // Same image and build as `jobs`: one image, two roles.
    expect(doc.services["jobs-app"].image).toBe(doc.services.jobs.image);
    expect(doc.services["jobs-app"].build).toEqual(doc.services.jobs.build);
    expect(doc.services["jobs-app"].env_file).toEqual(doc.services.jobs.env_file);
  });

  test("every DATABASE_URL-shaped variable across services is distinct by role name", () => {
    const roles = new Set();
    for (const name of ["cms", "jobs", "jobs-app", "migrate"]) {
      const value = doc.services[name].environment.DATABASE_URL;
      roles.add(value);
    }
    // `cms` and `jobs-app` deliberately share the APP DSN expression; the
    // other two are distinct (DATABASE_URL, WORKER_DATABASE_URL,
    // SETUP_DATABASE_URL) — a real drift (e.g. jobs accidentally reusing
    // cms's own DATABASE_URL) would collapse this set to fewer than 3.
    expect(roles.size).toBe(3);
    expect(doc.services["jobs-app"].environment.DATABASE_URL).toBe(doc.services.cms.environment.DATABASE_URL);
  });
});

/**
 * Backup assurance (issue #213) — a thin wrapper around upstream
 * apps/cms/deploy/backup/*.sh. The safety-critical claim here is structural,
 * not documentary: `restore-drill` must have NO possible path to a
 * `--target`-style destructive restore, ever, regardless of environment
 * variables or arguments a caller might supply.
 */
describe("compose.production.yaml — backup assurance (issue #213)", () => {
  test("backup, restore-drill, and offsite-copy are each gated behind their own profile", () => {
    expect(doc.services.backup.profiles).toEqual(["backup"]);
    expect(doc.services["restore-drill"].profiles).toEqual(["restore-drill"]);
    expect(doc.services["offsite-copy"].profiles).toEqual(["offsite-copy"]);
  });

  test("backup and restore-drill connect with the SAME migration-owner DSN as migrate, never awcms_app/awcms_worker", () => {
    for (const name of ["backup", "restore-drill"]) {
      expect(doc.services[name].environment.DATABASE_URL).toMatch(/SETUP_DATABASE_URL/);
    }
  });

  test("restore-drill's command is hard-coded to restore-drill.sh — no --target flag anywhere in this file", () => {
    const command = doc.services["restore-drill"].command;
    expect(command).toEqual(["bash", "/scripts/restore-drill.sh"]);
    expect(JSON.stringify(command)).not.toMatch(/--target/);
  });

  test("backup's command is hard-coded to backup-postgres.sh", () => {
    expect(doc.services.backup.command).toEqual(["bash", "/scripts/backup-postgres.sh"]);
  });

  test("no compose service anywhere in this file passes --target to a backup script", () => {
    // Structural, not just for restore-drill: nothing in this file should
    // ever be able to make a scheduled/automated invocation destructive.
    for (const [name, service] of Object.entries(doc.services)) {
      if (service.command) {
        expect(JSON.stringify(service.command)).not.toMatch(/--target/);
      }
    }
  });

  test("restore_age_identity (private key) is never in backup's own secret list — only in restore-drill's", () => {
    expect(doc.services.backup.secrets ?? []).not.toContain("restore_age_identity");
    expect(doc.services["restore-drill"].secrets ?? []).toContain("restore_age_identity");
  });

  test("backup/restore-drill/offsite-copy read their secrets from /run/secrets, never a literal value in `environment:`", () => {
    for (const name of ["backup", "restore-drill", "offsite-copy"]) {
      const strings = walkStrings(doc.services[name].environment ?? {});
      for (const value of strings) {
        if (/AGE|HMAC|SSH_KEY/.test(value)) {
          expect(value.startsWith("/run/secrets/") || value.includes("${")).toBe(true);
        }
      }
    }
  });

  test("the four backup-assurance secrets are declared, file-backed, and never committed inline", () => {
    for (const name of [
      "backup_age_recipients",
      "backup_hmac_key",
      "restore_age_identity",
      "offsite_ssh_key"
    ]) {
      expect(doc.secrets[name]).toBeDefined();
      expect(doc.secrets[name].file).toMatch(/\.secrets\//);
    }
  });

  test("awcms-one-production-backups is a named volume, distinct from the pgdata volume", () => {
    expect(doc.volumes["awcms-one-production-backups"]).toBeDefined();
    expect(doc.volumes["awcms-one-production-backups"].name).toBe(
      "awcms-one-production-backups"
    );
  });
});

describe("root .dockerignore (apps/storefront/Dockerfile's build stage COPYs the whole repo — issue #150 review)", () => {
  const dockerignorePath = join(REPO_ROOT, ".dockerignore");
  const dockerignore = readFileSync(dockerignorePath, "utf8");

  test("exists at the repo root", () => {
    expect(dockerignore.length).toBeGreaterThan(0);
  });

  // Docker's own pattern matcher does NOT recurse a directory-less pattern
  // the way `.gitignore` does — verified empirically (issue #150 review):
  // `node_modules/` alone excludes only a TOP-LEVEL `node_modules`, not
  // `apps/cms/node_modules`. So the required entries below must carry the
  // `**/` prefix wherever the excluded thing can exist inside a nested
  // workspace, not merely be present under some name.
  for (const required of ["**/node_modules", ".git", ".secrets"]) {
    test(`lists \`${required}\``, () => {
      expect(dockerignore.split("\n").some((line) => line.trim() === required)).toBe(true);
    });
  }
});

/**
 * Job -> database role routing on the compose path (issue #391 unblock).
 *
 * `ops/run-job-compose.sh` picks `jobs` (awcms_worker) or `jobs-app`
 * (awcms_app) per target from upstream's GENERATED classification in
 * `apps/cms/ops/run-job.sh`. These tests hold the wrapper to that file and to
 * the generated crontab, so a future upstream job cannot silently land on the
 * wrong role.
 */
describe("ops/run-job-compose.sh — job to database-role routing", () => {
  const SCRIPT = join(REPO_ROOT, "ops", "run-job-compose.sh");
  const UPSTREAM = join(REPO_ROOT, "apps", "cms", "ops", "run-job.sh");

  function route(job, upstream = UPSTREAM) {
    const r = spawnSync("bash", [SCRIPT, job], {
      encoding: "utf8",
      env: { ...process.env, AWCMS_RUN_JOB_PRINT_SERVICE: "1", AWCMS_UPSTREAM_RUN_JOB: upstream }
    });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr };
  }

  /** The app-client block, parsed independently of the shell (regex on the generated source). */
  function appTargets() {
    const src = readFileSync(UPSTREAM, "utf8");
    const block = src.match(
      /BEGIN GENERATED: targets that need DATABASE_URL[\s\S]*?case "\$JOB" in\n\s+([^)\n]+)\)/
    );
    expect(block).not.toBeNull();
    return block[1].split("|").map((t) => t.trim());
  }

  function crontabTargets() {
    const text = readFileSync(join(REPO_ROOT, "apps", "cms", "ops", "awcms-jobs.crontab"), "utf8");
    const out = [];
    for (const line of text.split("\n")) {
      const m = line.match(/\$AWCMS_RUN_JOB (\S+)/);
      if (m) out.push(m[1]);
    }
    return out;
  }

  test("hr-commission:intents:post runs as the app role; a worker job does not", () => {
    expect(route("hr-commission:intents:post")).toMatchObject({ code: 0, out: "jobs-app" });
    expect(route("email:dispatch")).toMatchObject({ code: 0, out: "jobs" });
    expect(route("commerce:whatsapp:dispatch")).toMatchObject({ code: 0, out: "jobs" });
  });

  test("every generated-crontab target routes exactly as upstream's classification says", () => {
    const app = new Set(appTargets());
    const targets = crontabTargets();
    expect(targets.length).toBeGreaterThan(20);
    for (const t of targets) {
      expect(route(t).out).toBe(app.has(t) ? "jobs-app" : "jobs");
    }
  });

  test("the SET of scheduled targets on the app role is pinned — a new app-client cron job needs a deliberate review here", () => {
    // If upstream schedules another job that reaches the app client, this
    // fails: confirm the compose wiring (docs/deployment.md "Which job runs
    // under which database role") and extend the list on purpose.
    const app = new Set(appTargets());
    expect(crontabTargets().filter((t) => app.has(t)).sort()).toEqual(["hr-commission:intents:post"]);
  });

  test("fails closed: a missing or garbled classification, an operator-only target and a path-shaped target all refuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-job-compose-"));
    const noBlock = join(dir, "no-block.sh");
    writeFileSync(noBlock, "#!/usr/bin/env bash\necho nothing generated here\n");
    expect(route("hr-commission:intents:post", noBlock).code).toBe(1);
    expect(route("email:dispatch", join(dir, "absent.sh")).code).toBe(1);
    expect(route("config:validate").code).toBe(1); // operator-only per upstream
    expect(route("./scripts/security-readiness.ts").code).toBe(1);
    expect(route("a b").code).toBe(1);
  });

  test("never routes an operator-only target and never names a service other than jobs/jobs-app", () => {
    for (const t of crontabTargets()) {
      expect(["jobs", "jobs-app"]).toContain(route(t).out);
    }
  });
});
