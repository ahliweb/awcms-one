/**
 * Public tenant resolution for the bearer-secured
 * `/api/v1/practice-irm/storefront/account/*` endpoints (Issue #270),
 * copied from `commerce/application/public-commerce-tenant.ts` (itself
 * copied from `newsletter/application/public-newsletter-tenant.ts`) almost
 * verbatim — see either file's header for the full "what was actually
 * broken" history this repeats rather than relitigates: an unanswered
 * preflight, an unreadable answer with no `Access-Control-Allow-Origin`, and
 * a tenant resolved from the wrong thing (the request HOST, which for a
 * statically built `web-irmbydus.com` page is always this CMS).
 *
 * Every non-resolving/disabled/refused case collapses to `null` — an
 * unknown host, a suspended tenant, a tenant with `practice_irm` disabled,
 * a refused cross-origin caller. One answer, so a caller cannot learn which
 * of those happened, and `padUnresolvedPracticeIrmTenantLatency` keeps the
 * unresolved path cost-normalized against the resolved one.
 */
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import {
  isCrossOriginRequest,
  parseRequestOrigin
} from "../../../lib/security/request-origin";
import {
  resolvePublicTenantByHost,
  resolvePublicTenantFromRequest,
  type PublicHostResolverConfig,
  type PublicTenantResolution
} from "../../../lib/tenant/public-host-tenant-resolver";
import { fetchTenantModuleEntry } from "../../module-management/application/tenant-module-lifecycle";
import {
  practiceIrmCorsHeaders,
  type PracticeIrmOriginDecision
} from "../domain/practice-irm-cors";
import { PRACTICE_IRM_MODULE_KEY } from "../domain/practice-irm-permissions";

export type PracticeIrmTenantHandler<T> = (
  tx: Bun.TransactionSQL,
  tenant: PublicTenantResolution
) => Promise<T>;

/** Same fail-closed sentinel `app.current_tenant_id` defaults to. */
const TIMING_PAD_TENANT_ID = "00000000-0000-0000-0000-000000000000";

function buildConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PublicHostResolverConfig {
  return {
    mode: env.PUBLIC_TENANT_RESOLUTION_MODE,
    trustProxy: env.PUBLIC_TRUST_PROXY === "true"
  };
}

async function isPracticeIrmEnabled(
  tx: Bun.TransactionSQL,
  tenantId: string
): Promise<boolean> {
  const entry = await fetchTenantModuleEntry(
    tx,
    tenantId,
    PRACTICE_IRM_MODULE_KEY
  );
  return entry?.tenantEnabled ?? false;
}

export async function padUnresolvedPracticeIrmTenantLatency(
  sql: Bun.SQL
): Promise<void> {
  await withTenantOrThrow(sql, TIMING_PAD_TENANT_ID, async (tx) => {
    await isPracticeIrmEnabled(tx, TIMING_PAD_TENANT_ID);
  });
}

async function runWithPracticeIrmTenant<T>(
  sql: Bun.SQL,
  tenant: PublicTenantResolution,
  handler: PracticeIrmTenantHandler<T>
): Promise<T | null> {
  return withTenantOrThrow(sql, tenant.tenantId, async (tx) => {
    if (!(await isPracticeIrmEnabled(tx, tenant.tenantId))) return null;
    return handler(tx, tenant);
  });
}

export async function withPracticeIrmTenant<T>(
  sql: Bun.SQL,
  request: Request,
  handler: PracticeIrmTenantHandler<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<T | null> {
  const tenant = await resolvePublicTenantFromRequest(
    sql,
    request,
    buildConfigFromEnv(env)
  );
  if (!tenant) {
    await padUnresolvedPracticeIrmTenantLatency(sql);
    return null;
  }
  return runWithPracticeIrmTenant(sql, tenant, handler);
}

export async function resolvePublicPracticeIrmOrigin(
  sql: Bun.SQL,
  request: Request
): Promise<{
  decision: PracticeIrmOriginDecision;
  tenant: PublicTenantResolution | null;
}> {
  const parsed = parseRequestOrigin(request.headers.get("origin"));

  if (!parsed || !isCrossOriginRequest(parsed, request.url)) {
    return { decision: { kind: "same_origin" }, tenant: null };
  }

  const tenant = await resolvePublicTenantByHost(sql, parsed.hostname);

  return tenant
    ? { decision: { kind: "granted", origin: parsed.origin }, tenant }
    : { decision: { kind: "refused" }, tenant: null };
}

export type PublicPracticeIrmOutcome<T> = {
  result: T | null;
  corsHeaders: Record<string, string>;
  decision: PracticeIrmOriginDecision;
};

export async function withPublicPracticeIrmTenant<T>(
  sql: Bun.SQL,
  request: Request,
  handler: PracticeIrmTenantHandler<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<PublicPracticeIrmOutcome<T>> {
  const { decision, tenant: originTenant } =
    await resolvePublicPracticeIrmOrigin(sql, request);
  const corsHeaders = practiceIrmCorsHeaders(decision);

  if (decision.kind === "refused") {
    await padUnresolvedPracticeIrmTenantLatency(sql);
    return { result: null, corsHeaders, decision };
  }

  if (decision.kind === "granted" && originTenant) {
    return {
      result: await runWithPracticeIrmTenant(sql, originTenant, handler),
      corsHeaders,
      decision
    };
  }

  return {
    result: await withPracticeIrmTenant(sql, request, handler, env),
    corsHeaders,
    decision
  };
}
