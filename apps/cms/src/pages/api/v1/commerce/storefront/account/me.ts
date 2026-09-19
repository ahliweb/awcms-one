import type { APIRoute } from "astro";

import { getDatabaseClient } from "../../../../../../lib/database/client";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import {
  fetchCustomerAccountView,
  updateCustomerName,
  updateMarketingConsent
} from "../../../../../../modules/commerce/application/customer-auth";
import { requireCustomerSession } from "../../../../../../modules/commerce/application/customer-session-auth";
import { commercePreflightResponse } from "../../../../../../modules/commerce/application/public-commerce-preflight";
import { withPublicCommerceTenant } from "../../../../../../modules/commerce/application/public-commerce-tenant";

/**
 * `GET`/`PATCH /api/v1/commerce/storefront/account/me` (Issue #89, contract
 * #86/ADR-0016) — bearer. `phone`/`email` come back in the clear: this is
 * always a self-view (the caller is holding a live bearer session for this
 * very account), the same exception the subject-rights export makes for the
 * account owner's own data (`awcms-sensitive-data`).
 */
const PREFLIGHT_ALLOWED_HEADERS = ["content-type", "authorization"] as const;

type MeOutcome =
  | { kind: "unauthenticated" }
  | { kind: "blocked" }
  | { kind: "validation_error"; errors: { field: string; message: string }[] }
  | {
      kind: "ok";
      account: Awaited<ReturnType<typeof fetchCustomerAccountView>>;
    };

export const GET: APIRoute = async ({ request }) => {
  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant): Promise<MeOutcome> => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };

      const account = await fetchCustomerAccountView(
        tx,
        tenant.tenantId,
        authOutcome.account.id
      );
      return { kind: "ok", account };
    }
  );

  return respond(result, corsHeaders);
};

export const PATCH: APIRoute = async ({ request, clientAddress, locals }) => {
  void clientAddress;
  const bodyRead = await readJsonBody(request);
  if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

  const sql = getDatabaseClient();

  const { result, corsHeaders } = await withPublicCommerceTenant(
    sql,
    request,
    async (tx, tenant): Promise<MeOutcome> => {
      const authOutcome = await requireCustomerSession(
        request,
        tx,
        tenant.tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.status === "blocked") return { kind: "blocked" };

      const body = (bodyRead.value ?? {}) as Record<string, unknown>;
      const correlationId = (locals as { correlationId?: string } | undefined)
        ?.correlationId;

      let account = authOutcome.account
        ? await fetchCustomerAccountView(
            tx,
            tenant.tenantId,
            authOutcome.account.id
          )
        : null;

      if (body.name !== undefined) {
        const updated = await updateCustomerName(
          tx,
          tenant.tenantId,
          authOutcome.account,
          body.name
        );
        if (updated.kind === "validation_error") {
          return { kind: "validation_error", errors: updated.errors };
        }
        account = updated.account;
      }

      // Issue #114 (contract #106 ADR-0017 D9) — `marketingConsent` is
      // independent of `name`: either field, both, or neither may be
      // present on a given PATCH.
      if (body.marketingConsent !== undefined) {
        if (typeof body.marketingConsent !== "boolean") {
          return {
            kind: "validation_error",
            errors: [
              {
                field: "marketingConsent",
                message: "marketingConsent must be a boolean."
              }
            ]
          };
        }
        const updated = await updateMarketingConsent(
          tx,
          tenant.tenantId,
          authOutcome.account,
          body.marketingConsent,
          correlationId
        );
        account = updated.account;
      }

      return { kind: "ok", account };
    }
  );

  return respond(result, corsHeaders);
};

function respond(
  result: MeOutcome | null,
  corsHeaders: Record<string, string>
): Response {
  if (!result || result.kind === "unauthenticated") {
    return fail(
      401,
      "UNAUTHENTICATED",
      "Missing, invalid, or expired session.",
      {},
      undefined,
      corsHeaders
    );
  }

  if (result.kind === "blocked") {
    return fail(
      403,
      "ACCOUNT_BLOCKED",
      "This account has been blocked.",
      {},
      undefined,
      corsHeaders
    );
  }

  if (result.kind === "validation_error") {
    return fail(
      400,
      "VALIDATION_ERROR",
      "Invalid request.",
      {},
      result.errors,
      corsHeaders
    );
  }

  return ok({ account: result.account }, {}, corsHeaders);
}

export const OPTIONS: APIRoute = async ({ request, clientAddress }) =>
  commercePreflightResponse(
    getDatabaseClient(),
    request,
    clientAddress,
    "commerce:account:me",
    { maxAttempts: 60, windowMs: 60_000 },
    PREFLIGHT_ALLOWED_HEADERS
  );
