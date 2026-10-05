/**
 * The commerce side of the flat-percentage -> tax-module migration (Issue #293,
 * ADR-0039, upstream ADR-0127 and `docs/awcms/tax-calculation.md` §11).
 * Pure — no database, no I/O.
 *
 * ## Two modes, one seam
 *
 * `flat` is the behaviour this repository has always had and stays byte for byte
 * what `quoteCart` computes inline: `percent` of `subtotal - voucher discount`,
 * once, half-up, in cents. `engine` replaces that single multiplication with the
 * tax module's calculator over the SAME inputs. Nothing else about a quote moves.
 *
 * ## Mapping a quote onto tax lines (ADR-0039 D3)
 *
 * The storefront's voucher is a DOCUMENT-level discount, and the flat rule taxes
 * what is left after it. The tax module's discount is per line, so the voucher is
 * allocated across the lines in cents by the largest-remainder method (the same
 * `allocateOrderDiscount` returns and refunds already use, so a refunded line's
 * discount share and its tax base agree). Line amount =
 * `quantity x unitPrice - allocated discount`, and the lines sum to exactly
 * `subtotal - voucher discount`. With a `taxable` fallback rule at the same
 * percent, `exclusive` pricing, `half_up`, scale 2 and `document` level, the
 * engine's total therefore equals the flat figure EXACTLY, for any cart — proven
 * by a seeded property test, not merely argued.
 *
 * ## Money scale
 *
 * Commerce stores money as `numeric(14,2)`. A rule version at any other rounding
 * scale would produce figures the order columns cannot hold, so the adapter
 * refuses it instead of silently re-rounding (the snapshot, not commerce, is the
 * tax authority — it must never be recomputed locally).
 */
import { calculateTax } from "../../tax/domain/tax-calculator";
import {
  TaxCalculationError,
  type ResolvedTaxRuleVersion,
  type TaxCalculation,
  type TaxLineInput
} from "../../tax/domain/tax-types";
import { fromCents, normalizeMoney, toCents } from "./price-calculation";
import { allocateOrderDiscount } from "./returns";

export const TAX_MODES = ["flat", "engine"] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export const DEFAULT_TAX_PROFILE_CODE = "store-default";

/** The `documentType` every order's snapshot (and each refund's reversal of it) is filed under. */
export const TAX_ORDER_DOCUMENT_TYPE = "order";

/** The tax module's own `CODE_PATTERN`; a product's `tax_category_code` must satisfy it. */
export const TAX_CATEGORY_CODE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

/** The commerce money scale (`numeric(14,2)`), the only scale an engine version may use here. */
export const COMMERCE_TAX_SCALE = 2;

export function isTaxMode(value: unknown): value is TaxMode {
  return value === "flat" || value === "engine";
}

/** What `quoteCart` needs to price tax in engine mode — resolved by the caller before the pure call. */
export type CartQuoteTaxContext =
  | { mode: "flat" }
  | {
      mode: "engine";
      profileCode: string;
      /** The business date (store time zone) the version was resolved for. */
      taxDate: string;
      /** `null` when no published version of the profile covers `taxDate`. */
      version: ResolvedTaxRuleVersion | null;
      /** Product id -> tax category code (`null` = standard). */
      categoryByProductId: ReadonlyMap<string, string | null>;
    };

export type TaxQuoteLineInput = {
  lineRef: string;
  categoryCode: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
};

/**
 * One tax line per quoted line, the voucher allocated across them in cents.
 * The allocation is a pure function of the line totals and the discount, in line
 * order — never of anything unordered.
 */
export function buildTaxLineInputs(
  lines: readonly TaxQuoteLineInput[],
  documentDiscountCents: bigint
): TaxLineInput[] {
  const shares = allocateOrderDiscount(
    lines.map((line) => toCents(line.lineTotal)),
    documentDiscountCents
  );

  return lines.map((line, index) => ({
    lineRef: line.lineRef,
    categoryCode: line.categoryCode,
    quantity: String(line.quantity),
    unitPrice: line.unitPrice,
    discount: fromCents(shares[index]!)
  }));
}

export type EngineTaxFigure = {
  /** The tax the engine reports, in cents (extracted tax when prices are inclusive). */
  amountCents: bigint;
  /** `true` when the version prices tax INTO the line amounts: the tax is not added to the total. */
  inclusive: boolean;
  calculation: TaxCalculation;
  lineInputs: TaxLineInput[];
};

export type EngineTaxOutcome =
  | { ok: true; figure: EngineTaxFigure }
  | { ok: false; code: string; message: string };

/**
 * Prices `lines` under `version`. Never throws for a calculation the rules
 * cannot answer: a missing version, a category with no rule and no fallback, a
 * scale commerce cannot store — each is a typed refusal the quote turns into
 * "cannot check out", never into silently untaxed money.
 */
export function computeEngineTax(
  version: ResolvedTaxRuleVersion | null,
  profileCode: string,
  taxDate: string,
  lines: readonly TaxQuoteLineInput[],
  documentDiscountCents: bigint
): EngineTaxOutcome {
  if (!version) {
    return {
      ok: false,
      code: "TAX_RULE_VERSION_NOT_FOUND",
      message: `No published rule version for profile "${profileCode}" covers ${taxDate}.`
    };
  }

  if (version.roundingScale !== COMMERCE_TAX_SCALE) {
    return {
      ok: false,
      code: "TAX_INPUT_INVALID",
      message: `Commerce stores money at ${COMMERCE_TAX_SCALE} decimals; rule version ${version.profileCode} v${version.versionNo} rounds at ${version.roundingScale}.`
    };
  }

  const lineInputs = buildTaxLineInputs(lines, documentDiscountCents);

  if (lineInputs.length === 0) {
    return {
      ok: true,
      figure: {
        amountCents: 0n,
        inclusive: version.pricingMode === "inclusive",
        calculation: emptyCalculation(version),
        lineInputs
      }
    };
  }

  try {
    const calculation = calculateTax(version, lineInputs);

    return {
      ok: true,
      figure: {
        amountCents: toCents(normalizeMoney(calculation.taxTotal)),
        inclusive: version.pricingMode === "inclusive",
        calculation,
        lineInputs
      }
    };
  } catch (error) {
    if (error instanceof TaxCalculationError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

function emptyCalculation(version: ResolvedTaxRuleVersion): TaxCalculation {
  return {
    pricingMode: version.pricingMode,
    roundingMode: version.roundingMode,
    roundingScale: version.roundingScale,
    roundingLevel: version.roundingLevel,
    currencyCode: version.currencyCode,
    lines: [],
    netTotal: "0.00",
    taxTotal: "0.00",
    grossTotal: "0.00",
    componentTotals: [],
    treatmentTotals: []
  };
}

/**
 * The single percentage a quote's legacy `tax.percent` field reports for an
 * engine version: the first component of the FALLBACK rule (0 when the fallback
 * is exempt/zero-rated or absent). Display only — the amount is never derived
 * from it.
 */
export function fallbackRatePercent(version: ResolvedTaxRuleVersion): number {
  const fallback = version.definition.rules.find(
    (rule) => rule.categoryCode === null
  );
  const first = fallback?.components[0];
  const rate = first ? Number(first.rate) : 0;

  return Number.isFinite(rate) ? rate : 0;
}

/** Does the version tax anything at all (any `taxable` rule)? Drives the legacy `tax.active`. */
export function versionTaxesAnything(version: ResolvedTaxRuleVersion): boolean {
  return version.definition.rules.some((rule) => rule.treatment === "taxable");
}

/**
 * The calendar date of `now` in `timeZone` as `YYYY-MM-DD` — the "tax date" an
 * order is finalised under (`tax-calculation.md` §2: a calendar date the CALLER
 * states, never the server clock).
 */
export function businessDateInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const pick = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}
