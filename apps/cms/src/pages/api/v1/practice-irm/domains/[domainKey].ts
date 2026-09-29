import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  deletePracticeIrmDomain,
  getPracticeIrmDomain,
  updatePracticeIrmDomain
} from "../../../../../modules/practice-irm/application/practice-irm-domain-directory";
import { PRACTICE_IRM_DOMAINS_ACTIVITY_CODE } from "../../../../../modules/practice-irm/domain/practice-irm-permissions";
import {
  isPracticeIrmDomainKey,
  type PracticeIrmDomainKey
} from "../../../../../modules/practice-irm/domain/practice-irm-domain-content";

/**
 * `GET/PUT/DELETE /api/v1/practice-irm/domains/{domainKey}` (Issue #270).
 * `DELETE` resets the domain back to the built-in default — see
 * `deletePracticeIrmDomain`'s own header; it never issues a real `DELETE`.
 */
const READ_GUARD = {
  moduleKey: "practice_irm",
  activityCode: PRACTICE_IRM_DOMAINS_ACTIVITY_CODE,
  action: "read"
} as const;

const UPDATE_GUARD = {
  moduleKey: "practice_irm",
  activityCode: PRACTICE_IRM_DOMAINS_ACTIVITY_CODE,
  action: "update"
} as const;

const DELETE_GUARD = {
  moduleKey: "practice_irm",
  activityCode: PRACTICE_IRM_DOMAINS_ACTIVITY_CODE,
  action: "delete"
} as const;

type PreparedDomainKey = { domainKey: PracticeIrmDomainKey };

function prepareDomainKey({
  params
}: {
  params: Record<string, string | undefined>;
}): PreparedDomainKey | Response {
  const domainKey = params.domainKey;
  if (!domainKey || !isPracticeIrmDomainKey(domainKey)) {
    return fail(
      400,
      "VALIDATION_ERROR",
      "domainKey must be one of: identify, neutralize, navigate, embed, reinforce."
    );
  }
  return { domainKey };
}

export const GET = defineTenantRoute<PreparedDomainKey>({
  workClass: "interactive",
  prepare: prepareDomainKey,
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await getPracticeIrmDomain(tx, tenantId, prepared.domainKey))
});

type PreparedUpdate = PreparedDomainKey & {
  name?: string;
  description?: string;
  copy?: string;
  displayOrder?: number;
};

export const PUT = defineTenantRoute<PreparedUpdate>({
  workClass: "interactive",
  prepare: async (context): Promise<PreparedUpdate | Response> => {
    const keyResult = prepareDomainKey(context);
    if (keyResult instanceof Response) return keyResult;

    const bodyRead = await readJsonBody(context.request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
    if (bodyRead.malformed) {
      return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const body = bodyRead.value;
    if (typeof body !== "object" || body === null) {
      return fail(400, "VALIDATION_ERROR", "Request body must be an object.");
    }
    const input = body as Record<string, unknown>;

    if (input.name !== undefined && typeof input.name !== "string") {
      return fail(400, "VALIDATION_ERROR", "name must be a string.");
    }
    if (
      input.description !== undefined &&
      typeof input.description !== "string"
    ) {
      return fail(400, "VALIDATION_ERROR", "description must be a string.");
    }
    if (input.copy !== undefined && typeof input.copy !== "string") {
      return fail(400, "VALIDATION_ERROR", "copy must be a string.");
    }
    if (
      input.displayOrder !== undefined &&
      typeof input.displayOrder !== "number"
    ) {
      return fail(400, "VALIDATION_ERROR", "displayOrder must be a number.");
    }

    return {
      domainKey: keyResult.domainKey,
      name: input.name as string | undefined,
      description: input.description as string | undefined,
      copy: input.copy as string | undefined,
      displayOrder: input.displayOrder as number | undefined
    };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared }) => {
    const result = await updatePracticeIrmDomain(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared.domainKey,
      {
        name: prepared.name,
        description: prepared.description,
        copy: prepared.copy,
        displayOrder: prepared.displayOrder
      }
    );

    if (result.kind === "not_found") {
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "This domain has no content yet. Use POST to create it."
      );
    }

    return ok(result.domain);
  }
});

export const DELETE = defineTenantRoute<PreparedDomainKey>({
  workClass: "interactive",
  prepare: prepareDomainKey,
  authorize: DELETE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared }) => {
    const result = await deletePracticeIrmDomain(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared.domainKey
    );

    if (result.kind === "not_found") {
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "This domain has no content to reset."
      );
    }

    return ok({ domainKey: prepared.domainKey, status: "reset" });
  }
});
