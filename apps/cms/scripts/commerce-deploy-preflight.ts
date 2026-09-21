#!/usr/bin/env bun
/**
 * commerce-deploy-preflight.ts — `bun run commerce:deploy:preflight` (issue
 * #150 of `ahliweb/awcms-one`).
 *
 * ## What this is, and what it is not
 *
 * `apps/cms/scripts/validate-env.ts` (`bun run config:validate`) and
 * `apps/cms/scripts/security-readiness.ts` (`bun run security:readiness`)
 * already answer the FOUNDATION questions this platform's production
 * deployment depends on — env shape, RLS, least-privilege connection role.
 * This script does NOT re-implement either. It delegates to `validate-env.ts`
 * by spawning it (argv array, never a shell string — see
 * `packages/gerbang/lib/git.mjs`'s own rule, followed here for the same
 * reason), and it checks the handful of PRODUCTION-DEPLOYMENT invariants that
 * are specific to awcms-one's own `commerce` module and its topology: the
 * runtime DB role is not the migration owner, every `commerce` provider that
 * can be switched to a `log`/dev adapter is not one in production, and the
 * job-schedule artefact is current. It is additive commerce-module tooling —
 * it lives in `apps/cms` but never edits an upstream file (AGENTS.md's
 * subtree rule).
 *
 * ## Fail-closed, one line per check
 *
 * Every check prints exactly one line: `PASS|FAIL|SKIP  <name>  — <reason>`.
 * The process exits non-zero the moment any check is FAIL — never on a SKIP,
 * which means "this check needs `--live`/a reachable database and none was
 * given", not "this check passed". No secret VALUE is ever printed — only
 * variable names and PASS/FAIL/SKIP.
 *
 * ## `--production` vs `APP_ENV=production`
 *
 * The production-only checks below run when `APP_ENV=production` in the read
 * env bag, OR when `--production` is passed on the command line — the latter
 * lets an operator dry-run the production ruleset against a `.env` file that
 * does not itself set `APP_ENV` yet (e.g. reviewing a file before it is
 * copied into place).
 *
 * ## `--live`
 *
 * Without `--live`, every check that would need a database connection is
 * printed as SKIP with a reason — the script never connects unless asked.
 * With `--live`, it opens a short-lived connection to `DATABASE_URL` (closed
 * before exit) and additionally checks: the connected role is not a
 * superuser and does not bypass RLS, it does not OWN any `awcms_commerce_*`
 * table, every `awcms_commerce_*` table has `relrowsecurity AND
 * relforcerowsecurity`, and the migration ledger
 * (`awcms_schema_migrations`) has no `sql/9NN_awcms_commerce_*.sql` file
 * pending.
 *
 * Usage:
 *   bun run commerce:deploy:preflight [--file <path>] [--live] [--production]
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

type EnvBag = Record<string, string | undefined>;
type CheckStatus = "PASS" | "FAIL" | "SKIP";
type CheckResult = { name: string; status: CheckStatus; reason: string };

const ROOT = path.resolve(import.meta.dirname, "..");

function parseArgs(argv: string[]) {
  const fileIndex = argv.indexOf("--file");
  return {
    file: fileIndex >= 0 ? argv[fileIndex + 1] : undefined,
    live: argv.includes("--live"),
    production: argv.includes("--production")
  };
}

/** Same shape as `validate-env.ts`'s own env-file parser — `KEY=value`, `#` comments, blank lines skipped. */
function parseEnvFile(source: string): EnvBag {
  const bag: EnvBag = {};
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    bag[key] = value;
  }
  return bag;
}

async function loadEnv(file: string | undefined): Promise<EnvBag> {
  if (!file) return { ...process.env };
  const source = await readFile(file, "utf8");
  return parseEnvFile(source);
}

export function isProduction(env: EnvBag, forceProduction: boolean): boolean {
  return forceProduction || env.APP_ENV === "production";
}

/** The DSN's own username — never its password. `postgres://user:pass@host/db`. */
export function dsnUser(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined;
  try {
    return decodeURIComponent(new URL(databaseUrl).username || "");
  } catch {
    return undefined;
  }
}

export function isValidHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The roles this repo's own migrations create: `awcms_setup`/`awcms_setup`
 * style owner roles, `postgres` (the compose superuser), and any name equal
 * to the DSN user of `SETUP_DATABASE_URL` — the migration-owner connection.
 * A runtime `DATABASE_URL` that resolves to any of these is the owner/setup
 * identity, not the least-privilege runtime role this checks for.
 */
const KNOWN_OWNER_USER_NAMES = new Set(["postgres", "root", "awcms_setup"]);

export function checkRuntimeRoleShape(env: EnvBag): CheckResult {
  const name = "runtime DB role is not the owner/superuser (DSN shape)";
  const user = dsnUser(env.DATABASE_URL);

  if (!user) {
    return {
      name,
      status: "FAIL",
      reason: "DATABASE_URL is missing or has no parseable username."
    };
  }

  if (KNOWN_OWNER_USER_NAMES.has(user)) {
    return {
      name,
      status: "FAIL",
      reason: `DATABASE_URL connects as "${user}", a known owner/superuser role name. Use the least-privilege "awcms_app" role for runtime.`
    };
  }

  const setupUser = dsnUser(env.SETUP_DATABASE_URL);
  if (setupUser && setupUser === user) {
    return {
      name,
      status: "FAIL",
      reason: `DATABASE_URL and SETUP_DATABASE_URL both connect as "${user}" — the runtime role must differ from the migration-owner role.`
    };
  }

  return {
    name,
    status: "PASS",
    reason: `DATABASE_URL connects as "${user}", distinct from every known owner/superuser role name.`
  };
}

async function checkLiveRoleAndRls(
  env: EnvBag,
  live: boolean
): Promise<CheckResult[]> {
  const roleCheck = {
    name: "runtime DB role does not bypass RLS (live)",
    status: "SKIP" as CheckStatus,
    reason: "no --live flag given — connect-and-verify was not attempted."
  };
  const ownershipCheck = {
    name: "runtime DB role does not own commerce tables (live)",
    status: "SKIP" as CheckStatus,
    reason: "no --live flag given — connect-and-verify was not attempted."
  };
  const rlsCheck = {
    name: "every awcms_commerce_* table has RLS ENABLE+FORCE (live)",
    status: "SKIP" as CheckStatus,
    reason: "no --live flag given — connect-and-verify was not attempted."
  };
  const ledgerCheck = {
    name: "migration ledger is current (live)",
    status: "SKIP" as CheckStatus,
    reason: "no --live flag given — connect-and-verify was not attempted."
  };

  if (!live) return [roleCheck, ownershipCheck, rlsCheck, ledgerCheck];

  if (!env.DATABASE_URL) {
    const reason = "DATABASE_URL is not set — cannot connect.";
    for (const c of [roleCheck, ownershipCheck, rlsCheck, ledgerCheck]) {
      c.status = "FAIL";
      c.reason = reason;
    }
    return [roleCheck, ownershipCheck, rlsCheck, ledgerCheck];
  }

  let sql: Bun.SQL | undefined;
  try {
    sql = new Bun.SQL(env.DATABASE_URL, { max: 1 });

    const roleRows = (await sql`
      SELECT rolname, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user
    `) as { rolname: string; rolsuper: boolean; rolbypassrls: boolean }[];
    const role = roleRows[0];

    if (!role) {
      roleCheck.status = "FAIL";
      roleCheck.reason = "Could not resolve current_user in pg_roles.";
    } else if (role.rolsuper || role.rolbypassrls) {
      roleCheck.status = "FAIL";
      roleCheck.reason = `current_user "${role.rolname}" is ${role.rolsuper ? "a SUPERUSER" : "BYPASSRLS"} — it bypasses RLS regardless of FORCE.`;
    } else {
      roleCheck.status = "PASS";
      roleCheck.reason = `current_user "${role.rolname}" is neither superuser nor bypassrls.`;
    }

    const ownedRows = (await sql`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname LIKE 'awcms\\_commerce\\_%'
        AND r.rolname = current_user
    `) as { relname: string }[];

    if (ownedRows.length > 0) {
      ownershipCheck.status = "FAIL";
      ownershipCheck.reason = `current_user owns ${ownedRows.length} commerce table(s) (${ownedRows
        .slice(0, 3)
        .map((r) => r.relname)
        .join(
          ", "
        )}${ownedRows.length > 3 ? ", ..." : ""}) — the runtime role must not be the table owner.`;
    } else {
      ownershipCheck.status = "PASS";
      ownershipCheck.reason = "current_user owns no awcms_commerce_* table.";
    }

    const rlsRows = (await sql`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname LIKE 'awcms\\_commerce\\_%'
    `) as {
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }[];

    const notEnforced = rlsRows.filter(
      (r) => !r.relrowsecurity || !r.relforcerowsecurity
    );

    if (rlsRows.length === 0) {
      rlsCheck.status = "FAIL";
      rlsCheck.reason =
        "No awcms_commerce_* table found — has the commerce module been migrated?";
    } else if (notEnforced.length > 0) {
      rlsCheck.status = "FAIL";
      rlsCheck.reason = `${notEnforced.length} commerce table(s) missing ENABLE+FORCE RLS: ${notEnforced
        .map(
          (r) =>
            `${r.relname}(rls=${r.relrowsecurity},force=${r.relforcerowsecurity})`
        )
        .join(", ")}`;
    } else {
      rlsCheck.status = "PASS";
      rlsCheck.reason = `${rlsRows.length} awcms_commerce_* table(s), all ENABLE+FORCE.`;
    }

    let appliedNames: Set<string>;
    try {
      const appliedRows = (await sql`
        SELECT migration_name FROM awcms_schema_migrations
      `) as { migration_name: string }[];
      appliedNames = new Set(appliedRows.map((r) => r.migration_name));
    } catch {
      ledgerCheck.status = "FAIL";
      ledgerCheck.reason =
        "awcms_schema_migrations does not exist — has bun run db:migrate ever been run against this database?";
      appliedNames = new Set();
    }

    if (ledgerCheck.status !== "FAIL") {
      const sqlDir = path.join(ROOT, "sql");
      const files = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql"));
      const pending = files.filter((f) => !appliedNames.has(f));

      if (pending.length > 0) {
        ledgerCheck.status = "FAIL";
        ledgerCheck.reason = `${pending.length} migration file(s) not yet applied: ${pending
          .slice(0, 5)
          .join(", ")}${pending.length > 5 ? ", ..." : ""}`;
      } else {
        ledgerCheck.status = "PASS";
        ledgerCheck.reason = `${files.length} migration file(s), all applied.`;
      }
    }
  } catch (error) {
    const reason = `Could not connect/query: ${error instanceof Error ? error.message : String(error)}`;
    for (const c of [roleCheck, ownershipCheck, rlsCheck, ledgerCheck]) {
      if (c.status === "SKIP") {
        c.status = "FAIL";
        c.reason = reason;
      }
    }
  } finally {
    await sql?.close({ timeout: 1 });
  }

  return [roleCheck, ownershipCheck, rlsCheck, ledgerCheck];
}

/**
 * Customer accounts have no feature switch in this module — every checkout
 * can reach the OTP-verified account flow (ADR-0016), so OTP delivery is
 * always "enabled" from a preflight point of view. If a future change adds a
 * real toggle, this is the one place to read it instead of assuming "always
 * on".
 */
export function checkOtpDelivery(
  env: EnvBag,
  production: boolean
): CheckResult[] {
  const results: CheckResult[] = [];

  const emailName = "customer OTP e-mail delivery is production-capable";
  if (!production) {
    results.push({
      name: emailName,
      status: "SKIP",
      reason: "not a production check (APP_ENV != production, no --production)."
    });
  } else if (env.EMAIL_ENABLED !== "true") {
    results.push({
      name: emailName,
      status: "FAIL",
      reason:
        'Customer accounts (ADR-0016) always require OTP delivery, and EMAIL_ENABLED is not "true".'
    });
  } else if (!env.EMAIL_PROVIDER || env.EMAIL_PROVIDER === "log") {
    results.push({
      name: emailName,
      status: "FAIL",
      reason: `EMAIL_PROVIDER is "${env.EMAIL_PROVIDER ?? "(unset)"}" — a log/dev adapter cannot deliver a real OTP in production.`
    });
  } else {
    results.push({
      name: emailName,
      status: "PASS",
      reason: `EMAIL_ENABLED=true, EMAIL_PROVIDER=${env.EMAIL_PROVIDER}.`
    });
  }

  const waName = "WhatsApp OTP delivery is production-capable when enabled";
  if (env.COMMERCE_WHATSAPP_ENABLED !== "true") {
    results.push({
      name: waName,
      status: "SKIP",
      reason: 'COMMERCE_WHATSAPP_ENABLED is not "true" — WhatsApp OTP is off.'
    });
  } else {
    const provider = env.COMMERCE_WHATSAPP_PROVIDER;
    if (provider !== "fonnte" && provider !== "meta") {
      results.push({
        name: waName,
        status: production ? "FAIL" : "SKIP",
        reason: `COMMERCE_WHATSAPP_PROVIDER is "${provider ?? "(unset)"}" — must be "fonnte" or "meta" when WhatsApp is enabled${production ? " in production" : ""}.`
      });
    } else if (provider === "fonnte" && !env.COMMERCE_FONNTE_TOKEN) {
      results.push({
        name: waName,
        status: "FAIL",
        reason:
          "COMMERCE_WHATSAPP_PROVIDER=fonnte but COMMERCE_FONNTE_TOKEN is not set."
      });
    } else if (
      provider === "meta" &&
      (!env.COMMERCE_META_WA_TOKEN || !env.COMMERCE_META_WA_PHONE_NUMBER_ID)
    ) {
      results.push({
        name: waName,
        status: "FAIL",
        reason:
          "COMMERCE_WHATSAPP_PROVIDER=meta but COMMERCE_META_WA_TOKEN/COMMERCE_META_WA_PHONE_NUMBER_ID is not set."
      });
    } else {
      results.push({
        name: waName,
        status: "PASS",
        reason: `COMMERCE_WHATSAPP_PROVIDER=${provider}, its credential(s) present.`
      });
    }
  }

  return results;
}

export function checkPaymentAndShipping(
  env: EnvBag,
  production: boolean
): CheckResult[] {
  const results: CheckResult[] = [];

  const paymentName = "payment gateway is not a log/dev adapter in production";
  if (!production) {
    results.push({
      name: paymentName,
      status: "SKIP",
      reason: "not a production check."
    });
  } else if (
    !env.COMMERCE_PAYMENT_GATEWAY ||
    env.COMMERCE_PAYMENT_GATEWAY === "log"
  ) {
    results.push({
      name: paymentName,
      status: "FAIL",
      reason: `COMMERCE_PAYMENT_GATEWAY is "${env.COMMERCE_PAYMENT_GATEWAY ?? "(unset)"}" — a log adapter is refused in production.`
    });
  } else if (env.COMMERCE_PAYMENT_GATEWAY === "midtrans") {
    if (!env.COMMERCE_MIDTRANS_SERVER_KEY) {
      results.push({
        name: paymentName,
        status: "FAIL",
        reason:
          "COMMERCE_PAYMENT_GATEWAY=midtrans but COMMERCE_MIDTRANS_SERVER_KEY is not set."
      });
    } else if (env.COMMERCE_MIDTRANS_IS_PRODUCTION !== "true") {
      results.push({
        name: paymentName,
        status: "FAIL",
        reason:
          'COMMERCE_PAYMENT_GATEWAY=midtrans in production but COMMERCE_MIDTRANS_IS_PRODUCTION is not "true" — this would charge against the Midtrans sandbox.'
      });
    } else {
      results.push({
        name: paymentName,
        status: "PASS",
        reason:
          "COMMERCE_PAYMENT_GATEWAY=midtrans, server key present, IS_PRODUCTION=true."
      });
    }
  } else {
    results.push({
      name: paymentName,
      status: "PASS",
      reason: `COMMERCE_PAYMENT_GATEWAY=${env.COMMERCE_PAYMENT_GATEWAY} (not "log").`
    });
  }

  const shippingName =
    "shipping rate provider is not a log/dev adapter in production";
  if (!production) {
    results.push({
      name: shippingName,
      status: "SKIP",
      reason: "not a production check."
    });
  } else if (
    !env.COMMERCE_SHIPPING_RATE_PROVIDER ||
    env.COMMERCE_SHIPPING_RATE_PROVIDER === "log"
  ) {
    results.push({
      name: shippingName,
      status: "FAIL",
      reason: `COMMERCE_SHIPPING_RATE_PROVIDER is "${env.COMMERCE_SHIPPING_RATE_PROVIDER ?? "(unset)"}" — a log adapter is refused in production.`
    });
  } else if (
    env.COMMERCE_SHIPPING_RATE_PROVIDER === "rajaongkir" &&
    !env.COMMERCE_RAJAONGKIR_API_KEY
  ) {
    results.push({
      name: shippingName,
      status: "FAIL",
      reason:
        "COMMERCE_SHIPPING_RATE_PROVIDER=rajaongkir but COMMERCE_RAJAONGKIR_API_KEY is not set."
    });
  } else {
    results.push({
      name: shippingName,
      status: "PASS",
      reason: `COMMERCE_SHIPPING_RATE_PROVIDER=${env.COMMERCE_SHIPPING_RATE_PROVIDER}.`
    });
  }

  return results;
}

export function checkPublicUrls(
  env: EnvBag,
  production: boolean
): CheckResult[] {
  const results: CheckResult[] = [];

  for (const [name, value] of [
    ["APP_URL", env.APP_URL],
    ["COMMERCE_STOREFRONT_PUBLIC_URL", env.COMMERCE_STOREFRONT_PUBLIC_URL]
  ] as const) {
    const checkName = `${name} is a valid https URL`;
    if (!production && !value) {
      results.push({
        name: checkName,
        status: "SKIP",
        reason: `${name} is not set and this is not a production check.`
      });
      continue;
    }
    if (isValidHttpsUrl(value)) {
      results.push({
        name: checkName,
        status: "PASS",
        reason: `${name}=${value}`
      });
    } else if (!production) {
      results.push({
        name: checkName,
        status: "SKIP",
        reason: `${name}="${value ?? "(unset)"}" is not https — allowed outside production.`
      });
    } else {
      results.push({
        name: checkName,
        status: "FAIL",
        reason: `${name}="${value ?? "(unset)"}" must be a valid https:// URL in production.`
      });
    }
  }

  return results;
}

/** Spawns a `bun run <script>` target as a subprocess — argv array, never a shell string (see packages/gerbang/lib/git.mjs's own rule, followed here for the same reason). */
function runBunScriptCheck(scriptName: string): CheckResult {
  const result = Bun.spawnSync(["bun", "run", scriptName], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe"
  });

  if (result.exitCode !== 0) {
    const tail = [
      new TextDecoder().decode(result.stderr).trim(),
      new TextDecoder().decode(result.stdout).trim()
    ]
      .filter(Boolean)
      .join(" | ")
      .split("\n")
      .slice(-3)
      .join(" | ");
    return {
      name: scriptName,
      status: "FAIL",
      reason: `exit ${result.exitCode}: ${tail}`
    };
  }

  return { name: scriptName, status: "PASS", reason: "exit 0." };
}

function printResult(result: CheckResult) {
  console.log(`${result.status.padEnd(4)}  ${result.name}  — ${result.reason}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = await loadEnv(args.file);
  const production = isProduction(env, args.production);

  console.log(
    `commerce:deploy:preflight — APP_ENV=${env.APP_ENV ?? "(unset)"}${args.production ? " (--production forced)" : ""}, ${args.live ? "--live" : "no --live"}`
  );

  const results: CheckResult[] = [];

  results.push(checkRuntimeRoleShape(env));
  results.push(...(await checkLiveRoleAndRls(env, args.live)));
  results.push(...checkOtpDelivery(env, production));
  results.push(...checkPaymentAndShipping(env, production));
  results.push(...checkPublicUrls(env, production));

  results.push(runBunScriptCheck("jobs:crontab:check"));
  results.push(runBunScriptCheck("jobs:env-allowlist:check"));

  // Delegate the foundation env contract to upstream's own validator —
  // argv array, never a shell string. It reads process.env by default, or
  // the same --file this script was given, so its verdict lines up with
  // every check above.
  const validateEnvArgs = [
    "bun",
    "run",
    "scripts/validate-env.ts",
    ...(args.file ? ["--file", args.file] : [])
  ];
  const validateEnvResult = Bun.spawnSync(validateEnvArgs, {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe"
  });
  if (validateEnvResult.exitCode !== 0) {
    const tail = [
      new TextDecoder().decode(validateEnvResult.stderr).trim(),
      new TextDecoder().decode(validateEnvResult.stdout).trim()
    ]
      .filter(Boolean)
      .join(" | ")
      .split("\n")
      .slice(-5)
      .join(" | ");
    results.push({
      name: "scripts/validate-env.ts",
      status: "FAIL",
      reason: `exit ${validateEnvResult.exitCode}: ${tail}`
    });
  } else {
    results.push({
      name: "scripts/validate-env.ts",
      status: "PASS",
      reason: "exit 0."
    });
  }

  for (const result of results) printResult(result);

  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  console.log(
    `\ncommerce:deploy:preflight — ${results.length} check(s): ${results.length - failed.length - skipped.length} PASS, ${failed.length} FAIL, ${skipped.length} SKIP.`
  );

  if (failed.length > 0) {
    console.error(
      `\nFAILED — ${failed.length} check(s) block production go-live. Fix them and re-run.`
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
