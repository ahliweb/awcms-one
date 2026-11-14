---
bump: minor
type: content
impact: public
---

# Shoppers can export and erase their personal data, and staff can on their behalf

Issue #529 (ADR-0055). The upstream subject-data engine cannot bind a commerce customer (ADR-0016 D1: no tenant-user, identity or profile id), so `commerce` owns a subject-rights flow keyed by the customer id. Every customer-keyed descriptor keeps `unreachableBySubject`, and its rationale now names the flow.

- **Shopper**: `/akun/privasi` (toko profile) and `POST /api/v1/commerce/storefront/account/privacy/{otp,export,erasure}`. A bearer session plus a fresh one-time code of its own purpose (`subject_export`, `subject_erasure`). The export is a versioned JSON bundle returned once and never stored (secrets redacted, an `unanswered` section, `Cache-Control: no-store`). The erasure needs an `Idempotency-Key`, deletes personal rows (sessions, codes, wishlists, addresses, campaign recipients, push data), anonymises the identity and the text the shopper wrote with per-row-unique sentinels, marks it `erased_at`, retains orders, documents, returns, refunds and both ledgers, and revokes every session. It is refused (`409 ERASURE_REFUSED`) while an order, booking, stored-value balance, refund or affiliate payout is open, without consuming the code.
- **Staff**: a Privacy column and a requests panel on `/admin/commerce-customers`; `commerce.customer_subject_requests.{read,export,delete,approve}` (migration `sql/1067`); an erasure is maker/checker, each person with a fresh step-up.
- **Storage**: `sql/1065` (the evidence table: counts and codes, immutable once decided, worker `SELECT` for the lifecycle dry-run), `sql/1066` (`erased_at`, the OTP purposes).
- **Contract**: seven operations in `commerce.openapi.yaml`; the three storefront routes are in `CUSTOMER_BEARER_BODY_ENDPOINTS`. The admin client bundle grows (asset budget re-measured).
- **Not settled**: counsel's confirmation of the retention legal bases and the owner's confirmation of the refusal rules (proposals in the ADR); the upstream descriptor-declared subject kind (text in the ADR's appendix A, not opened from here); WhatsApp message rows matched only by a phone value.

The DB-backed integration suite (`commerce-customer-subject.integration.test.ts`) and the real-browser e2e (`akun-privasi.e2e.ts`) run through local CI only and were not executed where this change was written.

Review refinements: the export no longer discloses staff stamps or the staff-typed reason of a request row; the data-request code mail has its own template naming its purpose; the privacy POST routes are rate limited per account; a retried `decide` by the same approver replays; the stored-value refusal also counts disabled accounts; and the e-mail copies in the `email` module's outbound log are named as not reached.

Review follow-ups: an erasure now suspends the shopper's affiliate account so the public referral code stops earning; the shared POS walk-in customer is refused as `NOT_A_PERSON`; the retention projector no longer re-creates an erased shopper's row; every staff stamp is kept out of the export; concurrent requests with one `Idempotency-Key` serialise on an advisory lock; `/akun/privasi` reads a `401` after an ambiguous attempt as "erased".
