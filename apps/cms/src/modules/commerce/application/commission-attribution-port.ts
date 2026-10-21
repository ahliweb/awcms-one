/**
 * The ONE place `commerce` names the concrete `hr_commission` accrual adapter
 * (Issue #391, ADR-0046; the same single-seam shape as
 * `commerceInventoryPort()` in `commerce-inventory.ts`).
 *
 * `_shared/ports/commission-accrual-port.ts` fixes the shape and says the
 * concrete adapter is wired "at the consumer's composition root"; for this
 * module that is here. Everything else in `commerce` depends on the TYPE
 * (`CommissionAccrualPort`) and on nothing under `hr-commission/` or
 * `hr-workforce/`: `tests/commerce-commission-boundary.test.ts` fails if any
 * other commerce source file names those directories, or any of their tables.
 *
 * Declared as an OPTIONAL consumed capability on the `commerce` descriptor
 * (`capabilities.consumes`, `providedBy: "hr_commission"`), not as a lifecycle
 * `dependencies` entry: commerce must keep working, and stay enablable, for a
 * tenant that never switches `hr_commission` on. The consumer checks the
 * tenant's module state before it calls anything.
 */
import type { CommissionAccrualPort } from "../../_shared/ports/commission-accrual-port";
import { createCommissionAccrualPort } from "../../hr-commission/application/hr-commission-accrual-port-adapter";

export function commerceCommissionAccrualPort(): CommissionAccrualPort {
  return createCommissionAccrualPort();
}
