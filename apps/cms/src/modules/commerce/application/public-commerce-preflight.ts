/**
 * The `OPTIONS` half of the storefront commerce cross-origin policy — copied
 * from `newsletter/application/public-newsletter-preflight.ts` almost
 * verbatim (see that file's header for the full reasoning: one shared
 * implementation across every route, rate-limited under the SAME key as the
 * request it precedes, decided before spending a database read).
 */
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../lib/security/rate-limit";
import {
  isCrossOriginRequest,
  parseRequestOrigin
} from "../../../lib/security/request-origin";
import { commercePreflightHeaders } from "../domain/commerce-cors";
import { resolvePublicCommerceOrigin } from "./public-commerce-tenant";

export type CommercePreflightLimits = { maxAttempts: number; windowMs: number };

export async function commercePreflightResponse(
  sql: Bun.SQL,
  request: Request,
  clientAddress: string,
  limiterKey: string,
  limits: CommercePreflightLimits,
  /** `["content-type", "authorization"]` for the bearer-secured account routes (Issue #89) — see `commercePreflightHeaders`'s own header. */
  allowedHeaders?: readonly string[]
): Promise<Response> {
  const parsed = parseRequestOrigin(request.headers.get("origin"));

  if (!parsed || !isCrossOriginRequest(parsed, request.url)) {
    return new Response(null, {
      status: 204,
      headers: commercePreflightHeaders({ kind: "same_origin" }, allowedHeaders)
    });
  }

  const budget = await checkSharedRateLimit(
    `${limiterKey}:${resolveClientIp(request, clientAddress)}`,
    limits
  );

  if (!budget.allowed) {
    return new Response(null, {
      status: 429,
      headers: {
        ...commercePreflightHeaders({ kind: "refused" }, allowedHeaders),
        "retry-after": String(budget.retryAfterSec)
      }
    });
  }

  const { decision } = await resolvePublicCommerceOrigin(sql, request);

  return new Response(null, {
    status: 204,
    headers: commercePreflightHeaders(decision, allowedHeaders)
  });
}
