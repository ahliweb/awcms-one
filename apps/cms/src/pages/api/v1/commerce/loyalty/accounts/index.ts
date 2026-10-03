import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import type { KeysetCursor } from "../../../../../../modules/_shared/keyset-pagination";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import {
  findCustomerForLoyaltyLookup,
  LOYALTY_ACCOUNT_LIST_DEFAULT_LIMIT,
  LOYALTY_ACCOUNT_LIST_MAX_LIMIT,
  listLoyaltyAccounts
} from "../../../../../../modules/commerce/application/loyalty-ledger";
import {
  parsePageParams,
  UUID_PATTERN
} from "../../../../../../modules/commerce/application/loyalty-route-support";
import { COMMERCE_LOYALTY_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import { normalizePhoneNumber } from "../../../../../../modules/commerce/domain/phone-normalisation";

/**
 * `GET /api/v1/commerce/loyalty/accounts` (Issue #289) — keyset list of loyalty
 * accounts (newest first), each with the customer's name and MASKED phone.
 * `?customerId=` narrows to one customer; `?phone=` is the counter lookup — it
 * additionally returns a `customer` block (with a balance of 0 when the
 * customer has no account yet) so a cashier can redeem or adjust for someone
 * who has never earned.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
  action: "read"
} as const;

type Prepared = {
  cursor: KeysetCursor | null;
  limit: number;
  customerId?: string;
  e164Phone?: string;
};

export const GET = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: ({ url }): Prepared | Response => {
    const page = parsePageParams(
      url,
      LOYALTY_ACCOUNT_LIST_DEFAULT_LIMIT,
      LOYALTY_ACCOUNT_LIST_MAX_LIMIT
    );
    if (page instanceof Response) return page;

    const customerId = url.searchParams.get("customerId") ?? undefined;
    if (customerId && !UUID_PATTERN.test(customerId)) {
      return fail(400, "VALIDATION_ERROR", "customerId must be a valid uuid.");
    }

    let e164Phone: string | undefined;
    const phone = url.searchParams.get("phone");
    if (phone) {
      const normalised = normalizePhoneNumber(phone);
      if (!normalised.valid) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "phone is not a valid Indonesian phone number."
        );
      }
      e164Phone = normalised.value;
    }

    return { ...page, customerId, e164Phone };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    const customer = prepared.e164Phone
      ? await findCustomerForLoyaltyLookup(tx, tenantId, prepared.e164Phone)
      : null;

    // A phone that matches no customer answers an empty page, not a 404: the
    // lookup is "who is this", and "nobody" is a normal answer.
    const customerId = prepared.e164Phone ? customer?.id : prepared.customerId;
    if (prepared.e164Phone && !customer) {
      return ok({ items: [], nextCursor: null, customer: null });
    }

    const page = await listLoyaltyAccounts(
      tx,
      tenantId,
      { customerId },
      prepared.cursor,
      prepared.limit
    );
    return ok(prepared.e164Phone ? { ...page, customer } : { ...page });
  }
});
