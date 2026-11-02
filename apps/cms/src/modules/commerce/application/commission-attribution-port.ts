/**
 * The ONE place `commerce` names the concrete `hr_commission` INTAKE adapter
 * (Issue #391, ADR-0046 D12, upstream ADR-0147; the same single-seam shape as
 * `commerceInventoryPort()` in `commerce-inventory.ts`).
 *
 * `_shared/ports/commission-intake-port.ts` fixes the shape and says the
 * concrete adapter is wired "at the consumer's composition root"; for this
 * module that is here. Everything else in `commerce` depends on the TYPE
 * (`CommissionIntakePort`) and on nothing under `hr-commission/` or
 * `hr-workforce/`: `tests/commerce-commission-boundary.test.ts` fails if any
 * other commerce source file names those directories, or any of their tables.
 *
 * Why the INTAKE port and not `CommissionAccrualPort`: the three commission
 * consumers run in `domain-events:dispatch` as `awcms_worker`, which the payroll
 * boundary (ahliweb/awcms#1015) forbids any privilege on an accrual. The intake
 * port writes one row to `hr_commission`'s queue (the worker holds INSERT on it
 * and nothing else) and a job running as `awcms_app` posts it later. The
 * synchronous `CommissionAccrualPort` stays upstream's seam for a route with a
 * signed-in person; commerce no longer uses it.
 *
 * Declared as an OPTIONAL consumed capability on the `commerce` descriptor
 * (`capabilities.consumes`, `providedBy: "hr_commission"`), not as a lifecycle
 * `dependencies` entry: commerce must keep working, and stay enablable, for a
 * tenant that never switches `hr_commission` on. The consumer checks the
 * tenant's module state before it calls anything.
 */
import type { CommissionIntakePort } from "../../_shared/ports/commission-intake-port";
import { createCommissionIntakePort } from "../../hr-commission/application/hr-commission-intake-port-adapter";

export function commerceCommissionIntakePort(): CommissionIntakePort {
  return createCommissionIntakePort();
}
