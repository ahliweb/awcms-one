/**
 * `GET|PATCH|DELETE /api/v1/commerce/segments/{id}` - one CRM segment
 * (Issue #360, ADR-0042). `GET` (`commerce.segments.read`) returns the head and
 * its versions (rules only). `PATCH` (`commerce.segments.update`) renames the
 * segment and/or adds a NEW version of its rules - it never edits an existing
 * one - and must carry the `baseVersion` it started from (`409
 * SEGMENT_VERSION_CONFLICT` otherwise). `DELETE` (`commerce.segments.delete`,
 * high-risk) retires the segment and KEEPS every version, so a past consumer's
 * `(segment, version)` stays explainable. An unknown id and another tenant's
 * id are the same `404`. All three are gated on the tenant's `segments` feature.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  fetchSegment,
  retireSegment,
  updateSegment
} from "../../../../../../modules/commerce/application/segment-directory";
import {
  readValidatedBody,
  requireSegmentsFeature,
  segmentNotFoundResponse
} from "../../../../../../modules/commerce/application/segment-http";
import {
  validateUpdateSegmentInput,
  type UpdateSegmentInput
} from "../../../../../../modules/commerce/domain/segment";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_SEGMENTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENTS_ACTIVITY_CODE,
  action: "read"
} as const;

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENTS_ACTIVITY_CODE,
  action: "update"
} as const;

const DELETE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SEGMENTS_ACTIVITY_CODE,
  action: "delete"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireSegmentsFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) return segmentNotFoundResponse();
    const segment = await fetchSegment(tx, tenantId, params.id);
    return segment ? ok(segment) : segmentNotFoundResponse();
  }
});

export const PATCH = defineTenantRoute<UpdateSegmentInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateUpdateSegmentInput),
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireSegmentsFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) return segmentNotFoundResponse();
    const outcome = await updateSegment(
      tx,
      tenantId,
      auth.context.tenantUserId,
      params.id,
      prepared,
      locals.correlationId
    );
    switch (outcome.kind) {
      case "not_found":
        return segmentNotFoundResponse();
      case "retired":
        return fail(
          409,
          "SEGMENT_RETIRED",
          "A retired segment cannot be edited."
        );
      case "version_conflict":
        return fail(
          409,
          "SEGMENT_VERSION_CONFLICT",
          "The segment changed since you opened it. Reload and apply your edit to the latest version.",
          {},
          { latestVersion: outcome.latestVersion }
        );
      case "name_taken":
        return fail(
          409,
          "SEGMENT_NAME_TAKEN",
          "A segment with this name already exists."
        );
      case "updated":
        return ok(outcome.segment);
    }
  }
});

export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: DELETE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const gate = await requireSegmentsFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) return segmentNotFoundResponse();
    const outcome = await retireSegment(
      tx,
      tenantId,
      auth.context.tenantUserId,
      params.id,
      locals.correlationId
    );
    switch (outcome.kind) {
      case "not_found":
        return segmentNotFoundResponse();
      case "already_retired":
        return fail(409, "SEGMENT_RETIRED", "The segment is already retired.");
      case "retired":
        return ok(outcome.segment);
    }
  }
});
