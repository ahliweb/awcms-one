/**
 * Shared `media.download` audit writer (Issue #268, IRMbyDUS) — called by
 * BOTH halves of the issuance flow: the staff/ABAC-gated
 * `GET /api/v1/media/objects/{id}/download-url` (this module) and the
 * customer/entitlement-gated `GET /api/v1/commerce/storefront/products/{id}/
 * download` (`commerce`, which already depends on `media_library` — Issue
 * #23, product images).
 *
 * ## Why "every issuance", not "every successful download"
 *
 * The R2 GET the presigned URL is eventually redeemed for happens entirely
 * outside this application — a signed URL, once handed out, is used (or not)
 * against Cloudflare R2 directly, and this codebase has no hook into that
 * request at all. The one moment that IS observable, and the one this issue
 * requires be audited, is ISSUANCE: the decision to mint (or refuse to mint)
 * a signed URL. A caller who was denied for lacking a commerce entitlement is
 * therefore audited exactly like a caller who succeeded — `outcome` is what
 * tells the two apart on the audit trail, never the absence of a row.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";

const AUDIT_MODULE_KEY = "media_library";
const AUDIT_RESOURCE_TYPE = "news_media_object";
const AUDIT_ACTION = "media.download";

export type MediaDownloadIssuanceOutcome =
  "issued" | "denied_entitlement_required" | "denied_not_downloadable";

export type RecordMediaDownloadIssuanceInput = {
  tenantId: string;
  mediaObjectId: string;
  objectKey: string;
  outcome: MediaDownloadIssuanceOutcome;
  /** Set for the staff/ABAC path; omitted for the customer/entitlement path (customers hold no `tenant_user` id — ADR-0016 D1). */
  actorTenantUserId?: string;
  correlationId?: string;
};

function messageFor(input: RecordMediaDownloadIssuanceInput): string {
  switch (input.outcome) {
    case "issued":
      return `Presigned download URL issued for media object: ${input.objectKey}.`;
    case "denied_entitlement_required":
      return `Presigned download URL request DENIED (no active entitlement) for media object: ${input.objectKey}.`;
    case "denied_not_downloadable":
      return `Presigned download URL request DENIED (object not in a downloadable state) for media object: ${input.objectKey}.`;
  }
}

export async function recordMediaDownloadIssuance(
  tx: Bun.SQL,
  input: RecordMediaDownloadIssuanceInput
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId: input.tenantId,
    actorTenantUserId: input.actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: AUDIT_ACTION,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: input.mediaObjectId,
    severity: input.outcome === "issued" ? "info" : "warning",
    message: messageFor(input),
    attributes: { objectKey: input.objectKey, outcome: input.outcome },
    correlationId: input.correlationId
  });
}
