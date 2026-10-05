#!/usr/bin/env bun
/**
 * commerce-tax-cutover.ts — `bun run commerce:tax:cutover` (Issue #293,
 * ADR-0039 D4). OPS-ONLY, run by hand, never scheduled and never exposed over
 * HTTP: it is the composition root that calls the commerce cut-over core
 * (`src/modules/commerce/application/tax-cutover.ts`), which in turn calls the
 * `tax` module's application functions in process.
 *
 * Moves a tenant from the flat store-level percentage (`payment.tax`) to the
 * `tax` module (ADR-0127): derives and publishes the `store-default` profile
 * version from the current settings, re-prices the tenant's recent orders
 * through the engine ("shadow", `tax-calculation.md` §11 F), REFUSES to flip
 * unless every sampled order matches to the cent, then sets `tax_mode = engine`.
 *
 * DRY-RUN BY DEFAULT. Pass `--commit` to write. Nothing is written for a tenant
 * whose parity check fails; each tenant is one transaction, so a failure leaves
 * no half-published profile behind.
 *
 *   --tenant <code>   limit to one tenant (staged rollout); default: every active tenant
 *   --sample <n>      how many recent flat-mode orders to re-price (default 200, max 5000)
 *   --since <date>    only orders created on/after YYYY-MM-DD (e.g. after the last rate change)
 *   --rollback        set the mode back to `flat` instead (audited; engine-mode orders keep their snapshots)
 *
 * Exits non-zero when any tenant was refused.
 */
import { getDatabaseClient } from "../src/lib/database/client";
import { withTenantOrThrow } from "../src/lib/database/tenant-context";
import {
  DEFAULT_PARITY_SAMPLE,
  MAX_PARITY_SAMPLE,
  runTaxCutoverForTenant,
  runTaxRollbackForTenant
} from "../src/modules/commerce/application/tax-cutover";

type Args = {
  commit: boolean;
  rollback: boolean;
  tenantCode?: string;
  sample: number;
  since?: string;
};

export function parseArgs(argv: string[]): Args {
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);

    if (index < 0) return undefined;

    const value = argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }

    return value;
  };
  const sampleRaw = valueOf("--sample");
  const sample =
    sampleRaw === undefined ? DEFAULT_PARITY_SAMPLE : Number(sampleRaw);

  if (!Number.isInteger(sample) || sample < 1 || sample > MAX_PARITY_SAMPLE) {
    throw new Error(
      `--sample must be an integer from 1 to ${MAX_PARITY_SAMPLE}.`
    );
  }

  const since = valueOf("--since");

  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error("--since must be a calendar date (YYYY-MM-DD).");
  }

  return {
    commit: argv.includes("--commit"),
    rollback: argv.includes("--rollback"),
    tenantCode: valueOf("--tenant"),
    sample,
    since
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = getDatabaseClient();
  const mode = args.commit ? "COMMIT" : "DRY-RUN";
  let refused = 0;

  try {
    const tenants = (await (args.tenantCode
      ? sql`SELECT id, tenant_code FROM awcms_tenants WHERE tenant_code = ${args.tenantCode}`
      : sql`SELECT id, tenant_code FROM awcms_tenants WHERE status = 'active' ORDER BY tenant_code`)) as {
      id: string;
      tenant_code: string;
    }[];

    if (tenants.length === 0) {
      console.error(
        args.tenantCode
          ? `No tenant with code "${args.tenantCode}".`
          : "No active tenants."
      );
      process.exit(1);
    }

    console.log(
      `commerce:tax:cutover ${args.rollback ? "ROLLBACK " : ""}${mode} — ${tenants.length} tenant(s).`
    );

    for (const tenant of tenants) {
      if (args.rollback) {
        const result = await withTenantOrThrow(
          sql,
          tenant.id,
          (tx) =>
            runTaxRollbackForTenant(tx, tenant.id, { commit: args.commit }),
          { workClass: "background_sync" }
        );

        console.log(
          `  ${tenant.tenant_code}: ${result.status} (was ${result.previousMode}).`
        );
        continue;
      }

      const result = await withTenantOrThrow(
        sql,
        tenant.id,
        (tx) =>
          runTaxCutoverForTenant(tx, tenant.id, {
            commit: args.commit,
            sample: args.sample,
            since: args.since
          }),
        { workClass: "background_sync" }
      );
      const flat = result.flat.active ? `${result.flat.percent}%` : "off";

      console.log(
        `  ${tenant.tenant_code}: ${result.status} — flat ${flat}, profile ${result.profileCode} (${result.version.source}${result.version.versionNo ? ` v${result.version.versionNo}` : ""}), parity ${result.parity.checked - result.parity.mismatchCount}/${result.parity.checked} exact${result.parity.skipped ? `, ${result.parity.skipped} skipped` : ""}.`
      );

      if (result.detail) console.log(`    ${result.detail}`);

      for (const mismatch of result.parity.mismatches) {
        console.log(
          `    mismatch ${mismatch.orderCode}: stored ${mismatch.storedTax}, engine ${mismatch.engineTax ?? `refused (${mismatch.error})`}`
        );
      }

      if (result.status.startsWith("refused")) refused += 1;
    }
  } finally {
    await sql.close({ timeout: 1 });
  }

  if (refused > 0) process.exit(1);
}

if (import.meta.main) {
  await main();
}
