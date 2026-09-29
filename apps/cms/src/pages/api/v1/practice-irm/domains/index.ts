import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  createPracticeIrmDomain,
  listPracticeIrmDomains
} from "../../../../../modules/practice-irm/application/practice-irm-domain-directory";
import { PRACTICE_IRM_DOMAINS_ACTIVITY_CODE } from "../../../../../modules/practice-irm/domain/practice-irm-permissions";
import {
  isPracticeIrmDomainKey,
  type PracticeIrmDomainKey
} from "../../../../../modules/practice-irm/domain/practice-irm-domain-content";

/**
 * `GET/POST /api/v1/practice-irm/domains` (Issue #270) — admin CRUD for the
 * five canonical IRM domains' content. `GET` always returns exactly five
 * entries (live row or built-in default per key — see `listPracticeIrmDomains`'s
 * own header); `POST` creates the tenant's own row for a key that has none
 * yet.
 */
const READ_GUARD = {
  moduleKey: "practice_irm",
  activityCode: PRACTICE_IRM_DOMAINS_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "practice_irm",
  activityCode: PRACTICE_IRM_DOMAINS_ACTIVITY_CODE,
  action: "create"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId }) =>
    ok({ items: await listPracticeIrmDomains(tx, tenantId) })
});

type PreparedCreate = {
  domainKey: PracticeIrmDomainKey;
  name: string;
  description: string;
  copy: string;
  displayOrder: number;
};

export const POST = defineTenantRoute<PreparedCreate>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PreparedCreate | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
    if (bodyRead.malformed) {
      return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const body = bodyRead.value;
    if (typeof body !== "object" || body === null) {
      return fail(400, "VALIDATION_ERROR", "Request body must be an object.");
    }

    const input = body as Record<string, unknown>;

    if (
      typeof input.domainKey !== "string" ||
      !isPracticeIrmDomainKey(input.domainKey)
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "domainKey must be one of: identify, neutralize, navigate, embed, reinforce."
      );
    }
    if (typeof input.name !== "string" || input.name.trim() === "") {
      return fail(400, "VALIDATION_ERROR", "name is required.");
    }
    if (typeof input.description !== "string") {
      return fail(400, "VALIDATION_ERROR", "description must be a string.");
    }
    if (typeof input.copy !== "string") {
      return fail(400, "VALIDATION_ERROR", "copy must be a string.");
    }
    const displayOrder =
      typeof input.displayOrder === "number" ? input.displayOrder : 0;

    return {
      domainKey: input.domainKey,
      name: input.name,
      description: input.description,
      copy: input.copy,
      displayOrder
    };
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared }) => {
    const result = await createPracticeIrmDomain(
      tx,
      tenantId,
      auth.context.tenantUserId,
      {
        domainKey: prepared.domainKey,
        name: prepared.name,
        description: prepared.description,
        copy: prepared.copy,
        displayOrder: prepared.displayOrder
      }
    );

    if (result.kind === "already_exists") {
      return fail(
        409,
        "ALREADY_EXISTS",
        "This domain already has content. Use PUT to update it."
      );
    }

    return ok(result.domain);
  }
});
