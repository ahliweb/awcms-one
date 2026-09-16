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
  commerceCorsHeaders,
  type CommerceOriginDecision
} from "../domain/commerce-cors";

const COMMERCE_MODULE_KEY = "commerce";

/**
 * Public tenant resolution for every anonymous `/api/v1/commerce/
 * storefront/*` route (Issue #29), copied from
 * `newsletter/application/public-newsletter-tenant.ts` almost verbatim —
 * see that file's header for the full reasoning (Origin-first resolution
 * for a cross-origin caller, host-first for a same-origin one, every
 * non-resolving/disabled case collapsing to the SAME `null` so a caller
 * cannot distinguish "unknown tenant" from "commerce disabled" from
 * "genuinely not found").
 *
 * The one behavioural difference from newsletter: this module's routes are
 * a mix of pure reads (`cart/quote`, `GET .../orders/{code}`) and writes
 * (`POST .../orders`, payment confirmations, cancel, reviews) — all of them
 * share this ONE resolution seam regardless, since the write/read
 * distinction is the ROUTE's concern (rate limits, idempotency), not the
 * tenant resolver's.
 */
export type CommerceTenantHandler<T> = (
  tx: Bun.TransactionSQL,
  tenant: PublicTenantResolution
) => Promise<T>;

/** Same fail-closed sentinel `app.current_tenant_id` defaults to — `public-search-tenant-resolution.ts`'s own convention. */
const TIMING_PAD_TENANT_ID = "00000000-0000-0000-0000-000000000000";

function buildConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): PublicHostResolverConfig {
  return {
    mode: env.PUBLIC_TENANT_RESOLUTION_MODE,
    trustProxy: env.PUBLIC_TRUST_PROXY === "true"
  };
}

async function isCommerceEnabled(
  tx: Bun.TransactionSQL,
  tenantId: string
): Promise<boolean> {
  const entry = await fetchTenantModuleEntry(tx, tenantId, COMMERCE_MODULE_KEY);
  return entry?.tenantEnabled ?? false;
}

/** Exported so a test can prove the resolved and unresolved paths pay the same round trip (no timing oracle). */
export async function padUnresolvedCommerceTenantLatency(
  sql: Bun.SQL
): Promise<void> {
  await withTenantOrThrow(sql, TIMING_PAD_TENANT_ID, async (tx) => {
    await isCommerceEnabled(tx, TIMING_PAD_TENANT_ID);
  });
}

async function runWithCommerceTenant<T>(
  sql: Bun.SQL,
  tenant: PublicTenantResolution,
  handler: CommerceTenantHandler<T>
): Promise<T | null> {
  return withTenantOrThrow(sql, tenant.tenantId, async (tx) => {
    if (!(await isCommerceEnabled(tx, tenant.tenantId))) return null;
    return handler(tx, tenant);
  });
}

export async function withCommerceTenant<T>(
  sql: Bun.SQL,
  request: Request,
  handler: CommerceTenantHandler<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<T | null> {
  const tenant = await resolvePublicTenantFromRequest(
    sql,
    request,
    buildConfigFromEnv(env)
  );
  if (!tenant) {
    await padUnresolvedCommerceTenantLatency(sql);
    return null;
  }
  return runWithCommerceTenant(sql, tenant, handler);
}

/**
 * Classify a public commerce request's `Origin` and, when it is
 * cross-origin, resolve the tenant that origin names — the lookup is
 * `resolvePublicTenantByHost` and nothing else (no env/setup default): a
 * cross-origin caller naming a hostname this deployment does not serve is
 * `refused`, never this deployment's own default tenant.
 */
export async function resolvePublicCommerceOrigin(
  sql: Bun.SQL,
  request: Request
): Promise<{
  decision: CommerceOriginDecision;
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

export type PublicCommerceOutcome<T> = {
  /** `null` for every non-resolving/disabled/refused case — the caller answers with its own neutral body. */
  result: T | null;
  corsHeaders: Record<string, string>;
  decision: CommerceOriginDecision;
};

/**
 * The entry point every anonymous route under
 * `/api/v1/commerce/storefront/*` calls: classify the origin, resolve the
 * tenant on whichever path that implies, and hand back both the handler's
 * answer and the CORS headers the response must carry.
 *
 * A refused origin pays `padUnresolvedCommerceTenantLatency`, exactly like
 * an unresolved host — without it, "this origin belongs to a tenant on this
 * deployment" would leak from response TIME even though the body is the
 * same neutral `404` either way.
 */
export async function withPublicCommerceTenant<T>(
  sql: Bun.SQL,
  request: Request,
  handler: CommerceTenantHandler<T>,
  env: NodeJS.ProcessEnv = process.env
): Promise<PublicCommerceOutcome<T>> {
  const { decision, tenant: originTenant } = await resolvePublicCommerceOrigin(
    sql,
    request
  );
  const corsHeaders = commerceCorsHeaders(decision);

  if (decision.kind === "refused") {
    await padUnresolvedCommerceTenantLatency(sql);
    return { result: null, corsHeaders, decision };
  }

  if (decision.kind === "granted" && originTenant) {
    return {
      result: await runWithCommerceTenant(sql, originTenant, handler),
      corsHeaders,
      decision
    };
  }

  return {
    result: await withCommerceTenant(sql, request, handler, env),
    corsHeaders,
    decision
  };
}
