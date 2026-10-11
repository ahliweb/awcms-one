/**
 * `GET|POST /api/v1/commerce/segments` - CRM segments (Issue #360, ADR-0042).
 * `GET` (`commerce.segments.read`) is the keyset list, newest first, live
 * segments by default (`?includeRetired=true` adds the retired ones). It
 * returns definitions only - never a customer. `POST` (`commerce.segments.create`)
 * defines a segment and its version 1 from a rule tree in the closed
 * vocabulary (`domain/segment-rules.ts`); an unknown field, operator, key or a
 * depth above the bound is a `400` that names the offending path. Both methods
 * are gated on the tenant's `segments` feature (`409 FEATURE_DISABLED` off).
 */
import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import {
  createSegment,
  listSegments
} from "../../../../../modules/commerce/application/segment-directory";
import {
  readValidatedBody,
  requireSegmentsFeature
} from "../../../../../modules/commerce/application/segment-http";
import {
  validateCreateSegmentInput,
  type CreateSegmentInput
} from "../../../../../modules/commerce/domain/segment";
import { COMMERCE_SEGMENTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENTS_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENTS_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedList = { cursor: KeysetCursor | null; includeRetired: boolean };

export const GET = defineTenantRoute<PreparedList>({
  workClass: "interactive",
  prepare: ({ url }): PreparedList | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      const decoded = decodeKeysetCursor(cursorParam);
      if (!decoded)
        return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
      cursor = decoded;
    }
    return {
      cursor,
      includeRetired: url.searchParams.get("includeRetired") === "true"
    };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireSegmentsFeature(tx, tenantId);
    if (gate) return gate;
    return ok(
      await listSegments(tx, tenantId, prepared.cursor, prepared.includeRetired)
    );
  }
});

export const POST = defineTenantRoute<CreateSegmentInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateCreateSegmentInput),
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireSegmentsFeature(tx, tenantId);
    if (gate) return gate;
    const outcome = await createSegment(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared,
      locals.correlationId
    );
    if (outcome.kind === "name_taken") {
      return fail(
        409,
        "SEGMENT_NAME_TAKEN",
        "A segment with this name already exists."
      );
    }
    return created(outcome.segment);
  }
});
