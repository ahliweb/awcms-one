/**
 * The order-time deposit derivation (Issue #380, ADR-0041 D4, ADR-0045 D5 and
 * decision G10). Pure - integer cents, no float, no I/O.
 *
 * ## The rule (ADR-0041 D4)
 *
 * A product with an ACTIVE deposit-policy row contributes its deposit; a line
 * without one contributes its whole (taxed) line total, because it is due up
 * front; shipping and insurance are due up front too. A percentage applies to
 * the line's TAXED total and rounds half up in integer cents; a fixed amount is
 * PER UNIT of quantity (per night for a nightly product); either is capped at
 * the line's taxed total and floored at one cent. The sum is the order's
 * `dp_amount` - the release threshold of ADR-0025 D3 - capped at the order
 * total, and snapshotted on the order so editing a policy later never alters
 * an existing order.
 *
 * ## G10: policy row first, the legacy store-wide rule only when there is no row
 *
 * A cart in which NO line has a policy takes today's store-wide down-payment
 * rule untouched (`cart-quote.ts`; owner decision M9: existing tenants are
 * unchanged). The moment any line has a policy, the policy derivation above is
 * the only one that applies, whatever the store-wide switch says.
 *
 * ## The tax share of a line
 *
 * Tax is computed on the whole order (flat percent of `subtotal - voucher`, or
 * the tax engine's figure), so a line's share is its proportion of the order's
 * subtotal, half up. For the booking path (one line) that is the whole tax.
 */
import { fromCents, toCents } from "./price-calculation";

export type DepositPolicySnapshot =
  { kind: "percent"; percent: string } | { kind: "fixed"; fixedAmount: string };

export type DepositLineFacts = {
  productId: string;
  quantity: number;
  /** `numeric(14,2)` string. */
  lineTotal: string;
};

const ONE_CENT = 1n;

/** Basis points of a `numeric(5,2)` percent string (`"30.00"` -> 3000n). */
export function percentToBasisPoints(percent: string): bigint {
  const [whole, fraction = ""] = percent.split(".");
  return BigInt(whole!) * 100n + BigInt((fraction + "00").slice(0, 2));
}

/** `n * basisPoints / 10000`, rounded half up. */
function applyBasisPoints(cents: bigint, basisPoints: bigint): bigint {
  return (cents * basisPoints + 5000n) / 10000n;
}

/** A line's share of the order tax: `tax * lineTotal / subtotal`, half up (0 when nothing is sold). */
export function lineTaxShareCents(
  taxCents: bigint,
  lineTotalCents: bigint,
  subtotalCents: bigint
): bigint {
  if (subtotalCents <= 0n || taxCents <= 0n) return 0n;
  return (
    (taxCents * lineTotalCents * 2n + subtotalCents) / (2n * subtotalCents)
  );
}

/** The deposit of one policy-bearing line, capped at its taxed total and floored at one cent. */
export function policyLineDepositCents(
  policy: DepositPolicySnapshot,
  line: DepositLineFacts,
  taxedLineCents: bigint
): bigint {
  if (taxedLineCents <= 0n) return 0n;
  const raw =
    policy.kind === "percent"
      ? applyBasisPoints(taxedLineCents, percentToBasisPoints(policy.percent))
      : toCents(policy.fixedAmount) * BigInt(Math.max(line.quantity, 0));
  const capped = raw > taxedLineCents ? taxedLineCents : raw;
  return capped < ONE_CENT ? ONE_CENT : capped;
}

export type PolicyDownPayment =
  | { applies: false }
  | {
      applies: true;
      /** The `dp_amount`, `numeric(14,2)`. */
      amount: string;
      amountCents: bigint;
      /** The deposit as a whole percent of the total (informational; the cart quote reports it as `percent`). */
      percentOfTotal: number;
    };

/**
 * The policy-based deposit for a priced cart, or `{ applies: false }` when no
 * line has a policy (the legacy store-wide rule then applies, G10).
 */
export function derivePolicyDownPayment(input: {
  lines: readonly DepositLineFacts[];
  policies: ReadonlyMap<string, DepositPolicySnapshot>;
  subtotalCents: bigint;
  taxCents: bigint;
  /** Shipping + insurance, due up front. */
  upFrontExtrasCents: bigint;
  totalCents: bigint;
}): PolicyDownPayment {
  const bearing = input.lines.filter((line) =>
    input.policies.has(line.productId)
  );
  if (bearing.length === 0 || input.totalCents <= 0n) {
    return { applies: false };
  }

  let sum = input.upFrontExtrasCents;
  for (const line of input.lines) {
    const lineCents = toCents(line.lineTotal);
    const taxed =
      lineCents +
      lineTaxShareCents(input.taxCents, lineCents, input.subtotalCents);
    const policy = input.policies.get(line.productId);
    sum += policy ? policyLineDepositCents(policy, line, taxed) : taxed;
  }

  const capped = sum > input.totalCents ? input.totalCents : sum;
  return {
    applies: true,
    amount: fromCents(capped),
    amountCents: capped,
    percentOfTotal: Number(
      (capped * 100n + input.totalCents / 2n) / input.totalCents
    )
  };
}
