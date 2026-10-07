/**
 * The per-tenant cut-over from the flat store-level percentage to the `tax`
 * module (Issue #293, ADR-0039 D4; upstream `tax-calculation.md` §11 A and F).
 * The composition root is `scripts/commerce-tax-cutover.ts`; this file is the
 * testable core, run inside ONE tenant transaction so a refusal leaves nothing
 * behind and a success is atomic (profile version + mode flip together).
 *
 * ## Steps
 *
 * 1. Derive the profile from the current settings (§11 A): ONE fallback rule,
 *    `taxable` with a single `net`-basis component at the store's percent (or
 *    `exempt` when the percentage is off or zero); `exclusive` pricing — today's
 *    total adds the tax on top of the prices, so prices exclude it; `half_up`,
 *    scale 2, `document` level — the single multiplication `quoteCart` performs;
 *    `effectiveFrom` = the server's date (a version cannot be published into the
 *    past, §11 A). If the profile already has a version in force it is REUSED,
 *    never overwritten — the merchant's own authoring wins, and the parity check
 *    below tells the operator whether it still agrees with the legacy figures.
 * 2. Shadow parity (§11 F): re-price the tenant's most recent flat-mode orders
 *    through the engine and compare with the tax each stored. With the same
 *    percentage, mode, scale and level the difference is exactly zero; any
 *    difference is a configuration mismatch, not a rounding tolerance, and the
 *    flip is REFUSED.
 * 3. Only on `--commit` and exact parity: create + publish the version (if
 *    needed) and set `tax_mode = engine`, audited.
 *
 * Historical orders are never recomputed or imported (§11 E): they keep the tax
 * they were issued with and carry no snapshot.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  createDraftVersion,
  publishRuleVersion,
  resolveRuleVersion
} from "../../tax/application/tax-rule-version-directory";
import { publishRuleVersionPublishedEvent } from "../../tax/application/tax-event-publisher";
import { TAX_MODULE_KEY } from "../../tax/domain/tax-permissions";
import type { ResolvedTaxRuleVersion } from "../../tax/domain/tax-types";
import {
  validateRuleVersionInput,
  type RuleVersionInput
} from "../../tax/domain/tax-validation";
import {
  fromCents,
  normalizeMoney,
  toCents
} from "../domain/price-calculation";
import {
  DEFAULT_TAX_PROFILE_CODE,
  computeEngineTax,
  type TaxMode
} from "../domain/tax-adapter";
import { fetchStoreSettings } from "./store-settings-directory";
import {
  fetchProductTaxCategories,
  fetchTaxAdapterConfig,
  setTaxAdapterConfig
} from "./tax-adapter-directory";

export const DEFAULT_PARITY_SAMPLE = 200;
export const MAX_PARITY_SAMPLE = 5000;
const MISMATCH_REPORT_LIMIT = 10;

export type ParityMismatch = {
  orderCode: string;
  storedTax: string;
  engineTax: string | null;
  error: string | null;
};

export type ParityReport = {
  checked: number;
  skipped: number;
  mismatches: ParityMismatch[];
  mismatchCount: number;
};

export type TaxCutoverStatus =
  | "already_engine"
  | "would_cut_over"
  | "cut_over"
  | "refused_parity"
  | "refused_version";

export type TaxCutoverReport = {
  tenantId: string;
  status: TaxCutoverStatus;
  profileCode: string;
  /** The percentage the tenant used on the flat path (`active` false reads as 0). */
  flat: { active: boolean; percent: number };
  /** `reused`: a version already in force; `created`: authored + published by this run; `planned`: dry-run. */
  version: {
    source: "reused" | "created" | "planned";
    versionNo: number | null;
    effectiveFrom: string | null;
  };
  parity: ParityReport;
  detail: string | null;
};

/** Today's flat behaviour, expressed as the version §11 A prescribes. */
export function deriveStoreDefaultVersionInput(
  flat: { active: boolean; percent: number },
  effectiveFrom: string,
  profileCode: string = DEFAULT_TAX_PROFILE_CODE
): RuleVersionInput {
  const taxed = flat.active && flat.percent > 0;
  const validation = validateRuleVersionInput({
    profileCode,
    name: "Store default (migrated from the flat store-level percentage)",
    jurisdictionCode: "store",
    currencyCode: "IDR",
    pricingMode: "exclusive",
    roundingMode: "half_up",
    roundingScale: 2,
    roundingLevel: "document",
    effectiveFrom,
    notes:
      "Created by commerce:tax:cutover (Issue #293, ADR-0039) from the store's payment.tax setting. Author new effective-dated versions to change the rate; this one is immutable once published.",
    definition: {
      categories: [],
      rules: [
        taxed
          ? {
              categoryCode: null,
              treatment: "taxable",
              components: [
                {
                  code: "tax",
                  name: "Tax",
                  rate: String(flat.percent),
                  basis: "net"
                }
              ]
            }
          : { categoryCode: null, treatment: "exempt", components: [] }
      ]
    }
  });

  if (!validation.valid) {
    throw new Error(
      `The derived store-default version is invalid: ${validation.errors.map((error) => `${error.field}: ${error.message}`).join("; ")}`
    );
  }

  return validation.value;
}

function toResolved(input: RuleVersionInput): ResolvedTaxRuleVersion {
  return {
    ruleVersionId: null,
    profileCode: input.profileCode,
    versionNo: 1,
    jurisdictionCode: input.jurisdictionCode,
    currencyCode: input.currencyCode,
    pricingMode: input.pricingMode,
    roundingMode: input.roundingMode,
    roundingScale: input.roundingScale,
    roundingLevel: input.roundingLevel,
    definition: input.definition
  };
}

/** The server's UTC calendar date — the earliest `effectiveFrom` a publish accepts. */
async function serverDate(tx: Bun.SQL): Promise<string> {
  const rows = (await tx`
    SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS today
  `) as { today: string }[];

  return rows[0]!.today;
}

type OrderRow = {
  id: string;
  order_code: string;
  tax: string;
  voucher_discount: string;
};

type ItemRow = {
  order_id: string;
  product_id: string;
  quantity: number;
  unit_price: string;
  line_total: string;
};

/**
 * Re-prices the tenant's most recent flat-mode orders under `version` and
 * compares with what each stored. Read-only.
 */
export async function runParityCheck(
  tx: Bun.SQL,
  tenantId: string,
  version: ResolvedTaxRuleVersion,
  options: { sample: number; since?: string }
): Promise<ParityReport> {
  const sample = Math.min(Math.max(options.sample, 1), MAX_PARITY_SAMPLE);
  const since = options.since ?? null;
  const orders = (await tx`
    SELECT id, order_code, tax, voucher_discount
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND tax_snapshot_id IS NULL
      AND (${since}::date IS NULL OR created_at >= ${since}::date)
    ORDER BY created_at DESC, id DESC
    LIMIT ${sample}
  `) as OrderRow[];

  if (orders.length === 0) {
    return { checked: 0, skipped: 0, mismatches: [], mismatchCount: 0 };
  }

  const items = (await tx`
    SELECT order_id, product_id, quantity, unit_price, line_total
    FROM awcms_commerce_order_items
    WHERE tenant_id = ${tenantId}
      AND order_id = ANY(${tx.array(
        orders.map((order) => order.id),
        "uuid"
      )}::uuid[])
      AND deleted_at IS NULL
    ORDER BY created_at ASC, id ASC
  `) as ItemRow[];
  const itemsByOrder = new Map<string, ItemRow[]>();

  for (const item of items) {
    const list = itemsByOrder.get(item.order_id) ?? [];

    list.push(item);
    itemsByOrder.set(item.order_id, list);
  }

  const categories = await fetchProductTaxCategories(
    tx,
    tenantId,
    items.map((item) => item.product_id)
  );
  const mismatches: ParityMismatch[] = [];
  let checked = 0;
  let skipped = 0;
  let mismatchCount = 0;

  for (const order of orders) {
    const lines = itemsByOrder.get(order.id) ?? [];

    if (lines.length === 0) {
      skipped += 1;
      continue;
    }

    const outcome = computeEngineTax(
      version,
      version.profileCode,
      "parity-check",
      lines.map((line, index) => ({
        lineRef: String(index + 1),
        categoryCode: categories.get(line.product_id) ?? null,
        quantity: Number(line.quantity),
        unitPrice: normalizeMoney(String(line.unit_price)),
        lineTotal: normalizeMoney(String(line.line_total))
      })),
      toCents(normalizeMoney(String(order.voucher_discount)))
    );

    checked += 1;

    const storedTax = normalizeMoney(String(order.tax));
    const engineTax = outcome.ok ? fromCents(outcome.figure.amountCents) : null;

    if (!outcome.ok || engineTax !== storedTax) {
      mismatchCount += 1;
      if (mismatches.length < MISMATCH_REPORT_LIMIT) {
        mismatches.push({
          orderCode: order.order_code,
          storedTax,
          engineTax,
          error: outcome.ok ? null : outcome.code
        });
      }
    }
  }

  return { checked, skipped, mismatches, mismatchCount };
}

export async function runTaxCutoverForTenant(
  tx: Bun.SQL,
  tenantId: string,
  options: {
    commit: boolean;
    sample?: number;
    since?: string;
    correlationId?: string;
  }
): Promise<TaxCutoverReport> {
  const config = await fetchTaxAdapterConfig(tx, tenantId);
  const settings = await fetchStoreSettings(tx, tenantId);
  const flat = {
    active: settings.payment.tax.active,
    percent: settings.payment.tax.percent
  };
  const empty: ParityReport = {
    checked: 0,
    skipped: 0,
    mismatches: [],
    mismatchCount: 0
  };
  const report = (
    status: TaxCutoverStatus,
    patch: Partial<TaxCutoverReport>
  ): TaxCutoverReport => ({
    tenantId,
    status,
    profileCode: config.profileCode,
    flat,
    version: { source: "planned", versionNo: null, effectiveFrom: null },
    parity: empty,
    detail: null,
    ...patch
  });

  if (config.mode === "engine") {
    return report("already_engine", {
      detail: "The tenant is already in engine mode; nothing to do."
    });
  }

  const today = await serverDate(tx);
  const existing = await resolveRuleVersion(
    tx,
    tenantId,
    config.profileCode,
    today
  );
  const planned = deriveStoreDefaultVersionInput(
    flat,
    today,
    config.profileCode
  );
  const version = existing ?? toResolved(planned);
  const parity = await runParityCheck(tx, tenantId, version, {
    sample: options.sample ?? DEFAULT_PARITY_SAMPLE,
    since: options.since
  });
  const versionInfo = existing
    ? {
        source: "reused" as const,
        versionNo: existing.versionNo,
        effectiveFrom: null
      }
    : { source: "planned" as const, versionNo: 1, effectiveFrom: today };

  if (parity.mismatchCount > 0) {
    return report("refused_parity", {
      version: versionInfo,
      parity,
      detail: `${parity.mismatchCount} of ${parity.checked} sampled order(s) re-price differently under the engine. Any difference is a configuration mismatch (percentage, pricing mode, rounding, a product category, or a tax percentage changed since those orders), not a rounding tolerance: fix it, or narrow the sample with --since, then re-run.`
    });
  }

  if (!options.commit) {
    return report("would_cut_over", {
      version: versionInfo,
      parity,
      detail: "Dry run: nothing written. Re-run with --commit to apply."
    });
  }

  let created: { versionNo: number; effectiveFrom: string } | null = null;

  if (!existing) {
    const draft = await createDraftVersion(
      tx,
      tenantId,
      null as unknown as string,
      planned
    );
    const published = await publishRuleVersion(
      tx,
      tenantId,
      null as unknown as string,
      draft.id
    );

    if (published.kind !== "published") {
      return report("refused_version", {
        version: versionInfo,
        parity,
        detail: `The store-default version could not be published (${published.kind}).`
      });
    }

    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: TAX_MODULE_KEY,
      action: "tax.rule_version.publish",
      resourceType: "tax_rule_version",
      resourceId: published.version.id,
      severity: "critical",
      message: "Tax rule version published by the commerce cut-over.",
      attributes: {
        profileCode: published.version.profileCode,
        versionNo: published.version.versionNo,
        effectiveFrom: published.version.effectiveFrom,
        origin: "commerce:tax:cutover"
      },
      correlationId: options.correlationId
    });
    await publishRuleVersionPublishedEvent(
      tx,
      tenantId,
      published.version,
      published.closedVersionId,
      {
        actorTenantUserId: null as unknown as string,
        correlationId: options.correlationId
      }
    );
    created = {
      versionNo: published.version.versionNo,
      effectiveFrom: published.version.effectiveFrom
    };
  }

  await setTaxAdapterConfig(
    tx,
    tenantId,
    null,
    { mode: "engine", profileCode: config.profileCode },
    {
      origin: "commerce:tax:cutover",
      flatActive: flat.active,
      flatPercent: flat.percent,
      parityChecked: parity.checked,
      versionCreated: created !== null
    },
    options.correlationId
  );

  return report("cut_over", {
    version: created ? { source: "created", ...created } : versionInfo,
    parity,
    detail:
      "Engine mode is on. Rollback: bun run commerce:tax:cutover --rollback --commit (historical engine orders keep their snapshots)."
  });
}

export type TaxRollbackReport = {
  tenantId: string;
  status: "rolled_back" | "would_roll_back" | "already_flat";
  previousMode: TaxMode;
};

/**
 * Rollback = set the mode back to `flat`, audited. Engine-mode orders already
 * placed keep their snapshots and stay reversible from them; new orders are
 * priced by the flat percentage again.
 */
export async function runTaxRollbackForTenant(
  tx: Bun.SQL,
  tenantId: string,
  options: { commit: boolean; correlationId?: string }
): Promise<TaxRollbackReport> {
  const config = await fetchTaxAdapterConfig(tx, tenantId);

  if (config.mode === "flat") {
    return { tenantId, status: "already_flat", previousMode: "flat" };
  }

  if (!options.commit) {
    return { tenantId, status: "would_roll_back", previousMode: config.mode };
  }

  await setTaxAdapterConfig(
    tx,
    tenantId,
    null,
    { mode: "flat", profileCode: config.profileCode },
    { origin: "commerce:tax:cutover", rollback: true },
    options.correlationId
  );

  return { tenantId, status: "rolled_back", previousMode: config.mode };
}
