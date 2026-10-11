/**
 * Validation for `awcms_commerce_campaigns` (Issue #114, contract #106
 * ADR-0017 D9). Mirrors `domain/conversation-validation.ts`'s shape: a pure
 * function per request body, a discriminated `{valid: true, value} |
 * {valid: false, errors}` result, no I/O.
 *
 * The OpenAPI draft (`openapi/modules/commerce.openapi.yaml`) originally
 * listed `subject` as unconditionally `required` on `createCommerceCampaign`
 * while ALSO documenting it as "Ignored for `channel:"whatsapp"`" — an
 * inconsistency this file resolves in code (and the OpenAPI source is
 * corrected to match): `subject` is required only for `channel: "email"`;
 * for `channel: "whatsapp"` it is optional and, if given, ignored by the
 * dispatcher (the WhatsApp `commerce.campaign` template
 * (`domain/whatsapp-templates.ts`) never reads it).
 */

export type CampaignChannel = "email" | "whatsapp";
export const CAMPAIGN_CHANNELS: readonly CampaignChannel[] = [
  "email",
  "whatsapp"
];

export type CampaignStatus =
  "draft" | "scheduled" | "sending" | "sent" | "cancelled";
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled"
];

export type CampaignAudience = {
  levels: number[];
  hasAccount: boolean | null;
  lastOrderSince: string | null;
};

export type ValidationError = { field: string; message: string };

/**
 * Issue #362 (ADR-0042 Amendment) - a campaign may take a CRM segment as its
 * audience. `segmentVersion` null means "the segment's latest version at the
 * moment the draft is saved": the application pins it then, so a later edit of
 * the segment never changes what this campaign sends to (C-29).
 */
export type CampaignSegmentRequest = {
  segmentId: string;
  segmentVersion: number | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SegmentFieldsResult =
  | { valid: true; segment: CampaignSegmentRequest | null | undefined }
  | { valid: false; errors: ValidationError[] };

/**
 * `segmentId` / `segmentVersion` from a create or update body. `undefined`
 * means "not mentioned" (an update leaves the pin alone); `null` (update only)
 * detaches the segment. A version without an id is refused. A segment audience
 * and the legacy filters are mutually exclusive, which the callers enforce
 * against the audience they hold.
 */
function readSegmentFields(
  input: Record<string, unknown>
): SegmentFieldsResult {
  const errors: ValidationError[] = [];
  const rawId = input.segmentId;
  const rawVersion = input.segmentVersion;

  if (rawId === undefined && rawVersion === undefined) {
    return { valid: true, segment: undefined };
  }
  if (rawId === null && (rawVersion === undefined || rawVersion === null)) {
    return { valid: true, segment: null };
  }
  if (typeof rawId !== "string" || !UUID_PATTERN.test(rawId)) {
    errors.push({
      field: "segmentId",
      message: "segmentId must be a segment id (UUID), or null to detach."
    });
  }
  let version: number | null = null;
  if (rawVersion !== undefined && rawVersion !== null) {
    if (
      typeof rawVersion !== "number" ||
      !Number.isInteger(rawVersion) ||
      rawVersion < 1
    ) {
      errors.push({
        field: "segmentVersion",
        message: "segmentVersion must be a positive integer."
      });
    } else {
      version = rawVersion;
    }
  }
  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    segment: { segmentId: rawId as string, segmentVersion: version }
  };
}

function audienceIsEmpty(audience: CampaignAudience): boolean {
  return (
    audience.levels.length === 0 &&
    audience.hasAccount === null &&
    audience.lastOrderSince === null
  );
}

const SEGMENT_EXCLUSIVE_MESSAGE =
  "A segment is the whole audience: clear audience.levels, audience.hasAccount and audience.lastOrderSince, or detach the segment.";

const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 4000;
const MIN_BODY_LENGTH = 1;
const VALID_LEVELS = [1, 2, 3, 4];

export type ValidateAudienceResult =
  | { valid: true; value: CampaignAudience }
  | { valid: false; errors: ValidationError[] };

/** Validates the `audience` object shape shared by create/update/preview. `{}` is valid — it targets every consented account (this file's own header, and ADR-0017 D9). */
export function validateCampaignAudience(raw: unknown): ValidateAudienceResult {
  const errors: ValidationError[] = [];
  const value: CampaignAudience = {
    levels: [],
    hasAccount: null,
    lastOrderSince: null
  };

  if (raw === undefined || raw === null) {
    return { valid: true, value };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      valid: false,
      errors: [{ field: "audience", message: "audience must be an object." }]
    };
  }
  const audience = raw as Record<string, unknown>;

  if (audience.levels !== undefined) {
    if (
      !Array.isArray(audience.levels) ||
      !audience.levels.every(
        (level) => typeof level === "number" && VALID_LEVELS.includes(level)
      )
    ) {
      errors.push({
        field: "audience.levels",
        message: "audience.levels must be an array of integers 1-4."
      });
    } else {
      value.levels = audience.levels as number[];
    }
  }

  if (audience.hasAccount !== undefined && audience.hasAccount !== null) {
    if (typeof audience.hasAccount !== "boolean") {
      errors.push({
        field: "audience.hasAccount",
        message: "audience.hasAccount must be a boolean or null."
      });
    } else {
      value.hasAccount = audience.hasAccount;
    }
  }

  if (
    audience.lastOrderSince !== undefined &&
    audience.lastOrderSince !== null
  ) {
    if (
      typeof audience.lastOrderSince !== "string" ||
      Number.isNaN(Date.parse(audience.lastOrderSince))
    ) {
      errors.push({
        field: "audience.lastOrderSince",
        message:
          "audience.lastOrderSince must be an ISO 8601 date-time or null."
      });
    } else {
      value.lastOrderSince = new Date(audience.lastOrderSince).toISOString();
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value };
}

export type CreateCampaignInput = {
  channel: CampaignChannel;
  audience: CampaignAudience;
  subject: string | null;
  body: string;
  /** Issue #362: set only when the campaign's audience is a segment. */
  segment?: CampaignSegmentRequest;
};

export type ValidateCreateResult =
  | { valid: true; value: CreateCampaignInput }
  | { valid: false; errors: ValidationError[] };

/** `POST /api/v1/commerce/campaigns`. */
export function validateCreateCampaignInput(
  raw: unknown
): ValidateCreateResult {
  const errors: ValidationError[] = [];
  if (typeof raw !== "object" || raw === null) {
    return {
      valid: false,
      errors: [{ field: "body", message: "Request body must be an object." }]
    };
  }
  const input = raw as Record<string, unknown>;

  const channel = input.channel;
  if (
    typeof channel !== "string" ||
    !CAMPAIGN_CHANNELS.includes(channel as CampaignChannel)
  ) {
    errors.push({
      field: "channel",
      message: "channel must be one of: email, whatsapp."
    });
  }

  const audienceResult = validateCampaignAudience(input.audience);
  if (!audienceResult.valid) errors.push(...audienceResult.errors);

  const segmentResult = readSegmentFields(input);
  let segment: CampaignSegmentRequest | undefined;
  if (!segmentResult.valid) {
    errors.push(...segmentResult.errors);
  } else if (segmentResult.segment === null) {
    errors.push({
      field: "segmentId",
      message: "segmentId must be a segment id (UUID)."
    });
  } else if (segmentResult.segment !== undefined) {
    segment = segmentResult.segment;
    if (audienceResult.valid && !audienceIsEmpty(audienceResult.value)) {
      errors.push({
        field: "audience",
        message: SEGMENT_EXCLUSIVE_MESSAGE
      });
    }
  }

  const rawSubject = input.subject;
  let subject: string | null = null;
  if (rawSubject !== undefined && rawSubject !== null) {
    if (typeof rawSubject !== "string" || rawSubject.trim().length === 0) {
      errors.push({
        field: "subject",
        message: "subject must be a non-empty string."
      });
    } else if (rawSubject.length > MAX_SUBJECT_LENGTH) {
      errors.push({
        field: "subject",
        message: `subject must be at most ${MAX_SUBJECT_LENGTH} characters.`
      });
    } else {
      subject = rawSubject;
    }
  } else if (channel === "email") {
    errors.push({
      field: "subject",
      message: "subject is required for channel: email."
    });
  }

  const body = input.body;
  if (
    typeof body !== "string" ||
    body.length < MIN_BODY_LENGTH ||
    body.length > MAX_BODY_LENGTH
  ) {
    errors.push({
      field: "body",
      message: `body is required and must be between ${MIN_BODY_LENGTH} and ${MAX_BODY_LENGTH} characters.`
    });
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: {
      channel: channel as CampaignChannel,
      audience: audienceResult.valid
        ? audienceResult.value
        : { levels: [], hasAccount: null, lastOrderSince: null },
      subject,
      body: body as string,
      ...(segment ? { segment } : {})
    }
  };
}

export type UpdateCampaignInput = {
  audience?: CampaignAudience;
  subject?: string | null;
  body?: string;
  /** Issue #362: undefined leaves the pin alone, null detaches it, a request (re)pins it. */
  segment?: CampaignSegmentRequest | null;
};

export type ValidateUpdateResult =
  | { valid: true; value: UpdateCampaignInput }
  | { valid: false; errors: ValidationError[] };

/** `PATCH /api/v1/commerce/campaigns/{id}` — only while `draft` (enforced by the caller, `application/campaign-directory.ts`). Every field optional; only the ones given are validated/applied. */
export function validateUpdateCampaignInput(
  raw: unknown
): ValidateUpdateResult {
  const errors: ValidationError[] = [];
  if (typeof raw !== "object" || raw === null) {
    return {
      valid: false,
      errors: [{ field: "body", message: "Request body must be an object." }]
    };
  }
  const input = raw as Record<string, unknown>;
  const value: UpdateCampaignInput = {};

  if (input.audience !== undefined) {
    const audienceResult = validateCampaignAudience(input.audience);
    if (!audienceResult.valid) errors.push(...audienceResult.errors);
    else value.audience = audienceResult.value;
  }

  const segmentResult = readSegmentFields(input);
  if (!segmentResult.valid) {
    errors.push(...segmentResult.errors);
  } else if (segmentResult.segment !== undefined) {
    value.segment = segmentResult.segment;
    if (
      segmentResult.segment !== null &&
      value.audience !== undefined &&
      !audienceIsEmpty(value.audience)
    ) {
      errors.push({ field: "audience", message: SEGMENT_EXCLUSIVE_MESSAGE });
    }
  }

  if (input.subject !== undefined) {
    if (input.subject !== null) {
      if (
        typeof input.subject !== "string" ||
        input.subject.trim().length === 0
      ) {
        errors.push({
          field: "subject",
          message: "subject must be a non-empty string or null."
        });
      } else if (input.subject.length > MAX_SUBJECT_LENGTH) {
        errors.push({
          field: "subject",
          message: `subject must be at most ${MAX_SUBJECT_LENGTH} characters.`
        });
      } else {
        value.subject = input.subject;
      }
    } else {
      value.subject = null;
    }
  }

  if (input.body !== undefined) {
    if (
      typeof input.body !== "string" ||
      input.body.length < MIN_BODY_LENGTH ||
      input.body.length > MAX_BODY_LENGTH
    ) {
      errors.push({
        field: "body",
        message: `body must be between ${MIN_BODY_LENGTH} and ${MAX_BODY_LENGTH} characters.`
      });
    } else {
      value.body = input.body;
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value };
}
