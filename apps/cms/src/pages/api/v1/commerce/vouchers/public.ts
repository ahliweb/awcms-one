import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { listPublicVouchers } from "../../../../../modules/commerce/application/voucher-directory";
import { COMMERCE_VOUCHERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
  action: "read"
} as const;

/** `GET /api/v1/commerce/vouchers/public` — the storefront's home-strip read model. Same authenticated, `read`-scoped shape as every other commerce route (`flash-sales/active.ts`'s header explains why "public" never means unauthenticated in this API). */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, now }) =>
    ok(await listPublicVouchers(tx, tenantId, now))
});
