import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../lib/database/client";
import {
  checkSharedRateLimit,
  resolveClientIp
} from "../../../../../../lib/security/rate-limit";
import { parsePositiveIntSetting } from "../../../../../../lib/security/env-thresholds";
import { fail } from "../../../../../../modules/_shared/api-response";
import { requireCommerceFeatureForPublicRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import { resolveDocumentLink } from "../../../../../../modules/commerce/application/document-delivery-directory";
import { withPublicCommerceTenant } from "../../../../../../modules/commerce/application/public-commerce-tenant";
import {
  hashDocumentLinkToken,
  looksLikeDocumentLinkToken
} from "../../../../../../modules/commerce/domain/document-delivery";

/**
 * `GET /api/v1/commerce/storefront/document-links/{token}` (Issue #295,
 * ADR-0034 D6) - anonymous. The OPAQUE token a delivery carried IS the
 * credential: 32 random bytes, only their SHA-256 stored, a hard expiry of at
 * most seven days. It renders the stored document's print page (the snapshot,
 * hash re-verified) under a locked-down CSP, `no-store`.
 *
 * An unknown token, a token of another tenant, a malformed one and a disabled
 * feature are all the same neutral `404`. A KNOWN token past its expiry is
 * `410` - its holder was once entitled to it, and 256 bits of entropy mean the
 * distinction tells a prober nothing.
 */
const RATE_LIMIT_MAX = parsePositiveIntSetting(
  process.env.COMMERCE_STOREFRONT_RATE_LIMIT_MAX,
  60,
  "COMMERCE_STOREFRONT_RATE_LIMIT_MAX"
);
const RATE_LIMIT_WINDOW_SEC = parsePositiveIntSetting(
  process.env.COMMERCE_STOREFRONT_RATE_LIMIT_WINDOW_SEC,
  60,
  "COMMERCE_STOREFRONT_RATE_LIMIT_WINDOW_SEC"
);

const NEUTRAL_NOT_FOUND = () =>
  fail(404, "NOT_FOUND", "Not found.", {}, undefined, { vary: "Origin" });

const PAGE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-type": "text/html; charset=utf-8",
  "content-disposition": "inline",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
} as const;

export const GET: APIRoute = async ({ params, request, clientAddress }) => {
  const clientIp = resolveClientIp(request, clientAddress);
  const rateLimit = await checkSharedRateLimit(
    `commerce:document-links:${clientIp}`,
    {
      maxAttempts: RATE_LIMIT_MAX,
      windowMs: RATE_LIMIT_WINDOW_SEC * 1000
    }
  );
  if (!rateLimit.allowed) {
    return fail(
      429,
      "RATE_LIMITED",
      "Too many requests. Try again later.",
      {},
      undefined,
      {
        "retry-after": String(rateLimit.retryAfterSec),
        vary: "Origin"
      }
    );
  }

  const token = params.token;
  if (!looksLikeDocumentLinkToken(token)) return NEUTRAL_NOT_FOUND();

  const sql = getDatabaseClient();
  const { result } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant) => {
      const gate = await requireCommerceFeatureForPublicRoute(
        tx,
        tenant.tenantId,
        "documentDelivery",
        NEUTRAL_NOT_FOUND
      );
      if (gate) return gate;
      const outcome = await resolveDocumentLink(
        tx,
        tenant.tenantId,
        hashDocumentLinkToken(token)
      );
      switch (outcome.kind) {
        case "not_found":
          return NEUTRAL_NOT_FOUND();
        case "expired":
          return fail(
            410,
            "LINK_EXPIRED",
            "This link has expired. Ask the store to send the document again.",
            {},
            undefined,
            { "cache-control": "private, no-store" }
          );
        case "integrity_failure":
          return NEUTRAL_NOT_FOUND();
        default:
          return new Response(outcome.html, {
            status: 200,
            headers: PAGE_HEADERS
          });
      }
    }
  );

  return result ?? NEUTRAL_NOT_FOUND();
};
