/**
 * Composition root of the CRM lead link's `CrmLeadPort` (Issue #463, ADR-0056
 * D2, the same shape as `booking-port.ts`): the one place that names
 * `crm_leads`' concrete adapter on behalf of `commerce`.
 *
 * `commerce` depends on the NEUTRAL port type (`_shared/ports/crm-lead-port.ts`)
 * and never imports `crm_leads`' code (a static test pins it); the adapter is
 * injected by a route that imports this file. Living in `src/lib/` keeps the
 * edge out of both module directories, where the boundary tests look. The
 * adapter is stateless; one instance is reused. The import is dynamic so a
 * descriptor or a route that never links a lead does not load `crm_leads`.
 *
 * The port performs NO access check and writes NO audit row: the caller (the
 * commerce route) authorizes `crm_leads.conversions.approve` through
 * `authorizeInTransaction` and audits the business action.
 */
import type { CrmLeadPort } from "../../modules/_shared/ports/crm-lead-port";

let port: CrmLeadPort | null = null;

export async function composedCrmLeadPort(): Promise<CrmLeadPort> {
  if (!port) {
    const { createCrmLeadPortAdapter } =
      await import("../../modules/crm-leads/application/crm-lead-port-adapter");
    port = createCrmLeadPortAdapter();
  }
  return port;
}
