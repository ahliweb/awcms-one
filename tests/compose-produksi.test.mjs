import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
      ["cms", "jobs", "migrate", "postgres", "storefront"].sort()
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
  });

  test("every DATABASE_URL-shaped variable across services is distinct by role name", () => {
    const roles = new Set();
    for (const name of ["cms", "jobs", "migrate"]) {
      const value = doc.services[name].environment.DATABASE_URL;
      roles.add(value);
    }
    // Three services, three DIFFERENT DSN expressions (they reference
    // different source env vars: DATABASE_URL, WORKER_DATABASE_URL,
    // SETUP_DATABASE_URL) — a real drift (e.g. jobs accidentally reusing
    // cms's own DATABASE_URL) would collapse this set to fewer than 3.
    expect(roles.size).toBe(3);
  });
});
