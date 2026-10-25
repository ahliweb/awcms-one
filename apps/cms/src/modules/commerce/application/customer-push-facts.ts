/**
 * Small read helpers the customer-push fan-out consumer and the dispatcher share
 * (Issue #432, ADR-0048 sections 5.4 and 5.5): the tenant's active storefront
 * hostnames, the CMS/admin origin and the tenant's default locale. Plain reads
 * on an already-open RLS-scoped transaction; no network, no credential, no
 * `push_delivery` import (so the consumer that uses them reaches no secret).
 */
import { resolveCustomerPushLocale } from "../domain/customer-push-policy";
import type { CustomerPushLocale } from "../domain/customer-push-policy";

/**
 * The normalised hostnames of the tenant's ACTIVE, non-deleted domains: the set a
 * device's stored storefront origin must still belong to (ADR-0048 6.3). Read
 * through the worker's column grant on `awcms_tenant_domains` (sql/304), never the
 * `awcms_resolve_tenant_domain_lookup` function, which only `awcms_app` may call.
 */
export async function loadActiveDomainHostnames(
  tx: Bun.SQL,
  tenantId: string
): Promise<Set<string>> {
  const rows = (await tx`
    SELECT normalized_hostname
    FROM awcms_tenant_domains
    WHERE tenant_id = ${tenantId} AND status = 'active' AND deleted_at IS NULL
  `) as { normalized_hostname: string }[];

  return new Set(rows.map((row) => row.normalized_hostname.toLowerCase()));
}

/**
 * The CMS/admin origin (`APP_URL`) a storefront device must never be bound to
 * (ADR-0048 T8), or `null` when it is unset or does not parse (a configuration
 * error `validate-env` reports; it cannot make an origin MORE acceptable).
 */
export function resolveAdminOrigin(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const appUrl = env.APP_URL?.trim();
  if (!appUrl) return null;

  try {
    return new URL(appUrl).origin;
  } catch {
    return null;
  }
}

/** The tenant's default locale reduced to a catalogue language (`awcms_tenants` has no RLS). */
export async function loadTenantPushLocale(
  tx: Bun.SQL,
  tenantId: string
): Promise<CustomerPushLocale> {
  const rows = (await tx`
    SELECT default_locale FROM awcms_tenants WHERE id = ${tenantId}
  `) as { default_locale: string | null }[];

  return resolveCustomerPushLocale(rows[0]?.default_locale);
}
