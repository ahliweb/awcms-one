-- Issue #529 (ADR-0055 D3) - permission catalog rows for the admin side of a
-- shopper's data-subject request. One activity code, `customer_subject_requests`,
-- mirroring `src/modules/commerce/domain/customer-subject-permissions.ts` and
-- `module.ts`'s `permissions` array. Global catalog, idempotent via
-- `ON CONFLICT DO NOTHING`; existing roles do not retroactively gain them (see
-- `sql/914`'s header), an administrator grants them.
--
--   * `read`    - list requests (counts and codes, never a bundle).
--   * `export`  - produce one customer's export bundle (HIGH-RISK: a bulk
--                 disclosure of personal data; step-up not required to read,
--                 but the disclosure is audited at `critical`).
--   * `delete`  - REQUEST an erasure (HIGH-RISK; needs a fresh step-up). It
--                 creates a pending request after the precondition check and
--                 erases nothing.
--   * `approve` - decide a pending erasure as the SECOND person (HIGH-RISK;
--                 fresh step-up; never the requester).
--
-- The existing `AccessAction` vocabulary is reused (`delete` for the request,
-- not a new `erase` verb): all three write verbs are already classified
-- high-risk, and widening a shared union for one module is an upstream change.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'customer_subject_requests', 'read', 'List shopper data-subject requests (export and erasure): status, refusal code and counts, never a bundle (Issue #529)'),
  ('commerce', 'customer_subject_requests', 'export', 'Produce one shopper''s data-subject export bundle on their behalf; every disclosure is audited (Issue #529)'),
  ('commerce', 'customer_subject_requests', 'delete', 'Request the erasure of one shopper''s personal data (anonymise and delete, ledgers retained); creates a request that a second person approves (Issue #529)'),
  ('commerce', 'customer_subject_requests', 'approve', 'Approve or reject a pending shopper erasure request as the second person, with a fresh step-up; never the requester (Issue #529)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
