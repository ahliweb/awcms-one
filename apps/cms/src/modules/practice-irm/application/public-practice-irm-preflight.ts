/**
 * The `OPTIONS` half of the practice-irm cross-origin policy — copied from
 * `commerce/application/public-commerce-preflight.ts` almost verbatim (see
 * that file's header): one shared implementation, rate-limited under the
 * same key as the request it precedes, decided before spending a database
 * read.
 */
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../lib/security/rate-limit";
import {
  isCrossOriginRequest,
  parseRequestOrigin
} from "../../../lib/security/request-origin";
import { practiceIrmPreflightHeaders } from "../domain/practice-irm-cors";
import { resolvePublicPracticeIrmOrigin } from "./public-practice-irm-tenant";

export type PracticeIrmPreflightLimits = {
  maxAttempts: number;
  windowMs: number;
};

export async function practiceIrmPreflightResponse(
  sql: Bun.SQL,
  request: Request,
  clientAddress: string,
  limiterKey: string,
  limits: PracticeIrmPreflightLimits
): Promise<Response> {
  const parsed = parseRequestOrigin(request.headers.get("origin"));

  if (!parsed || !isCrossOriginRequest(parsed, request.url)) {
    return new Response(null, {
      status: 204,
      headers: practiceIrmPreflightHeaders({ kind: "same_origin" })
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
        ...practiceIrmPreflightHeaders({ kind: "refused" }),
        "retry-after": String(budget.retryAfterSec)
      }
    });
  }

  const { decision } = await resolvePublicPracticeIrmOrigin(sql, request);

  return new Response(null, {
    status: 204,
    headers: practiceIrmPreflightHeaders(decision)
  });
}
