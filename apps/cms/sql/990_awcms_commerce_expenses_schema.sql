-- Issue #294 (epic #281, ADR-0031) — commerce-local, register-linked petty cash
-- and operational expenses. This issue owns 990-993 in the reserved commerce
-- 9xx range (ADR-0015): 990 this schema, 991 the typed expense reference on
-- register movements, 992 permissions, 993 worker grants.
--
-- ## What this is, and what it is NOT
--
-- A small, tenant-scoped expense record (category, amount, tender, date,
-- reason, optional payee, optional receipt) whose ONE integration with the
-- rest of the platform is the POS register (#284): an expense paid in cash
-- from an open drawer, once POSTED, appends a register `expense` cash-out
-- movement (`sql/991`) — the expense never edits a cash-up total itself — and a
-- REVERSAL appends a compensating cash-in movement. It is deliberately NOT a
-- general ledger, an accounts-payable system, a vendor master or a budget:
-- there are no accounts, no journal lines, no due dates, no taxes. The schema
-- boundary (category, expense, posting → movement) is kept narrow so a future
-- upstream finance module can absorb it through an adapter (ADR-0031 D1).
--
-- Same conventions as `sql/970`/`sql/936` (not repeated in full): ENABLE +
-- FORCE ROW LEVEL SECURITY with a `WITH CHECK`, `id uuid` PK, `numeric(14,2)`
-- money (ADR-0003), an index for every FK column, `text` + `CHECK` for every
-- enumerated column, composite `(tenant_id, …)` foreign keys backed by
-- `UNIQUE (tenant_id, id)`.
--
-- ## Lifecycle (`status`), enforced by a trigger as well as by the code
--
--   draft            — editable (category, amount, tender, date, reason, payee,
--                      drawer session, receipt).
--   pending_approval — submitted for posting but the amount exceeds the
--                      tenant's `expenses.approvalThreshold` and the submitter
--                      could not approve it themselves; CONTENT IS FROZEN so
--                      the approver decides what was submitted. Approve →
--                      posted; reject → back to draft (the note is kept).
--   posted           — in effect. A drawer-paid expense has its register
--                      movement (`posted_movement_id`). Content is frozen
--                      (a receipt may still be ATTACHED once, never replaced).
--   reversed         — a compensating action: terminal. A drawer-paid expense
--                      has its compensating movement (`reversal_movement_id`).
--   cancelled        — a draft that was discarded: terminal. (A posted expense
--                      is never "deleted": it is reversed.)
--
-- ## Columns worth explaining
--
--   * `register_session_id` — set only for an expense paid FROM THE DRAWER; the
--     CHECK pins `tender_type = 'cash'` then (the drawer holds cash). It is
--     chosen while the expense is a draft and must be an `open` session when
--     the expense is POSTED (the movement trigger of `sql/970` refuses a
--     movement on any other session). An expense with no session (bank
--     transfer, QRIS, or cash paid from the safe) touches no register.
--   * `approval_threshold` / `decision` — snapshotted at posting: the threshold
--     in force, and whether the expense was `auto`-approved (within it),
--     `approved` by someone other than its creator, or `rejected` (kept on the
--     draft that came back).
--   * `payee_name` — free text. There is no canonical party/profile reference
--     in the commerce module to point at (ADR-0016 D1 keeps customers outside
--     the profile vocabulary, and a vendor master is a non-goal); a typed
--     reference is the documented follow-up (ADR-0031 D8). Never audited or
--     exported to events.
--   * `receipt_media_object_id` — a `visibility = 'private'` media-library
--     object (PR #278). PostgreSQL cannot check another table's column, so the
--     private/downloadable requirement is enforced in the directory at attach
--     AND re-verified at every issuance. The FK is the single-column
--     `awcms_news_media_objects (id)` that `sql/905` and `sql/939` use; the
--     tenant match is made by the application (RLS also hides the object).
--   * `*_tenant_user_id` actor columns are plain uuid STAMPS, not FKs
--     (`sql/931`): a fiscal record must outlive the staff account.
--   * `deleted_at` exists ONLY as the retention engine's cursor and is never
--     set (the `awcms_commerce_orders` / `sql/970` shape): an expense is
--     reversed or cancelled, never deleted, and a register movement keeps a
--     foreign key to it.
--
-- `awcms_app` loses DELETE on both tables: only the retention worker may
-- delete, past the ten-year ceiling (`sql/993`).

CREATE TABLE IF NOT EXISTS awcms_commerce_expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by_tenant_user_id uuid,
  updated_by_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_expense_categories_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_expense_categories_code_check
    CHECK (char_length(code) BETWEEN 1 AND 40),
  CONSTRAINT awcms_commerce_expense_categories_name_check
    CHECK (char_length(name) BETWEEN 1 AND 120)
);

-- "ICE" and "ice" are the same category.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_expense_categories_tenant_code_key
  ON awcms_commerce_expense_categories (tenant_id, lower(code));

CREATE INDEX IF NOT EXISTS awcms_commerce_expense_categories_tenant_idx
  ON awcms_commerce_expense_categories (tenant_id);

-- The (tenant, cursor) composite the generic purge engine requires.
CREATE INDEX IF NOT EXISTS awcms_commerce_expense_categories_tenant_deleted_idx
  ON awcms_commerce_expense_categories (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_expense_categories FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_expense_categories_tenant_isolation
  ON awcms_commerce_expense_categories
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_expense_categories FROM awcms_app;

CREATE TABLE IF NOT EXISTS awcms_commerce_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  category_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  amount numeric(14, 2) NOT NULL,
  tender_type text NOT NULL,
  occurred_on date NOT NULL,
  description text NOT NULL,
  payee_name text,
  register_session_id uuid,
  receipt_media_object_id uuid REFERENCES awcms_news_media_objects (id),
  created_by_tenant_user_id uuid NOT NULL,
  updated_by_tenant_user_id uuid,
  submitted_by_tenant_user_id uuid,
  submitted_at timestamptz,
  approval_threshold numeric(14, 2),
  decision text,
  decided_by_tenant_user_id uuid,
  decided_at timestamptz,
  decision_note text,
  posted_by_tenant_user_id uuid,
  posted_at timestamptz,
  posted_movement_id uuid,
  reversed_by_tenant_user_id uuid,
  reversed_at timestamptz,
  reversal_reason text,
  reversal_session_id uuid,
  reversal_movement_id uuid,
  cancelled_by_tenant_user_id uuid,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_expenses_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_expenses_category_fk
    FOREIGN KEY (tenant_id, category_id)
    REFERENCES awcms_commerce_expense_categories (tenant_id, id),
  CONSTRAINT awcms_commerce_expenses_register_session_fk
    FOREIGN KEY (tenant_id, register_session_id)
    REFERENCES awcms_commerce_register_sessions (tenant_id, id),
  CONSTRAINT awcms_commerce_expenses_reversal_session_fk
    FOREIGN KEY (tenant_id, reversal_session_id)
    REFERENCES awcms_commerce_register_sessions (tenant_id, id),
  CONSTRAINT awcms_commerce_expenses_posted_movement_fk
    FOREIGN KEY (tenant_id, posted_movement_id)
    REFERENCES awcms_commerce_register_movements (tenant_id, id),
  CONSTRAINT awcms_commerce_expenses_reversal_movement_fk
    FOREIGN KEY (tenant_id, reversal_movement_id)
    REFERENCES awcms_commerce_register_movements (tenant_id, id),
  CONSTRAINT awcms_commerce_expenses_status_check
    CHECK (status IN ('draft', 'pending_approval', 'posted', 'reversed', 'cancelled')),
  CONSTRAINT awcms_commerce_expenses_amount_check
    CHECK (amount > 0),
  CONSTRAINT awcms_commerce_expenses_tender_check
    CHECK (tender_type IN ('cash', 'manual_qris', 'manual_bank_transfer')),
  CONSTRAINT awcms_commerce_expenses_description_check
    CHECK (char_length(description) BETWEEN 1 AND 500),
  CONSTRAINT awcms_commerce_expenses_payee_check
    CHECK (payee_name IS NULL OR char_length(payee_name) BETWEEN 1 AND 120),
  CONSTRAINT awcms_commerce_expenses_decision_check
    CHECK (decision IS NULL OR decision IN ('auto', 'approved', 'rejected')),
  CONSTRAINT awcms_commerce_expenses_decision_note_check
    CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500),
  CONSTRAINT awcms_commerce_expenses_reversal_reason_check
    CHECK (reversal_reason IS NULL OR char_length(reversal_reason) BETWEEN 1 AND 500),
  CONSTRAINT awcms_commerce_expenses_threshold_check
    CHECK (approval_threshold IS NULL OR approval_threshold >= 0),
  -- Only a cash expense can come out of the drawer.
  CONSTRAINT awcms_commerce_expenses_drawer_cash_check
    CHECK (register_session_id IS NULL OR tender_type = 'cash'),
  -- A pending expense names who submitted it.
  CONSTRAINT awcms_commerce_expenses_pending_shape_check
    CHECK (
      status <> 'pending_approval'
      OR (submitted_by_tenant_user_id IS NOT NULL AND submitted_at IS NOT NULL)
    ),
  -- A posted (or later reversed) expense names who posted it, when, and how
  -- it was approved; a drawer-paid one has its register movement.
  CONSTRAINT awcms_commerce_expenses_posted_shape_check
    CHECK (
      status NOT IN ('posted', 'reversed')
      OR (
        posted_by_tenant_user_id IS NOT NULL
        AND posted_at IS NOT NULL
        AND decision IN ('auto', 'approved')
        AND approval_threshold IS NOT NULL
        AND (register_session_id IS NULL) = (posted_movement_id IS NULL)
      )
    ),
  -- An expense approved by someone names the approver, who is never its creator
  -- (segregation of duties as a schema fact, not only a code path).
  CONSTRAINT awcms_commerce_expenses_approver_check
    CHECK (
      (decision = 'approved' AND decided_by_tenant_user_id IS NOT NULL AND decided_at IS NOT NULL
        AND decided_by_tenant_user_id <> created_by_tenant_user_id)
      OR (decision = 'rejected' AND decided_by_tenant_user_id IS NOT NULL AND decided_at IS NOT NULL)
      OR (decision = 'auto' AND decided_by_tenant_user_id IS NULL)
      OR decision IS NULL
    ),
  CONSTRAINT awcms_commerce_expenses_reversed_shape_check
    CHECK (
      status <> 'reversed'
      OR (
        reversed_by_tenant_user_id IS NOT NULL
        AND reversed_at IS NOT NULL
        AND reversal_reason IS NOT NULL
        AND (register_session_id IS NULL) = (reversal_movement_id IS NULL)
        AND (reversal_movement_id IS NULL) = (reversal_session_id IS NULL)
      )
    ),
  CONSTRAINT awcms_commerce_expenses_cancelled_shape_check
    CHECK (
      status <> 'cancelled'
      OR (cancelled_by_tenant_user_id IS NOT NULL AND cancelled_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_tenant_idx
  ON awcms_commerce_expenses (tenant_id);

-- The (tenant, cursor) composite the generic purge engine requires.
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_tenant_deleted_idx
  ON awcms_commerce_expenses (tenant_id, deleted_at);

-- The keyset history (newest first) and the status filter.
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_tenant_created_idx
  ON awcms_commerce_expenses (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_tenant_status_idx
  ON awcms_commerce_expenses (tenant_id, status, created_at DESC, id DESC);

-- The pending-approvals scan.
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_pending_idx
  ON awcms_commerce_expenses (tenant_id, created_at)
  WHERE status = 'pending_approval';

-- Reporting by date and category.
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_tenant_occurred_idx
  ON awcms_commerce_expenses (tenant_id, occurred_on);

-- One index per FK column (doc 10 convention).
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_category_idx
  ON awcms_commerce_expenses (tenant_id, category_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_category_fk_idx
  ON awcms_commerce_expenses (category_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_register_session_idx
  ON awcms_commerce_expenses (tenant_id, register_session_id)
  WHERE register_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_register_session_fk_idx
  ON awcms_commerce_expenses (register_session_id)
  WHERE register_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_reversal_session_fk_idx
  ON awcms_commerce_expenses (reversal_session_id)
  WHERE reversal_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_posted_movement_fk_idx
  ON awcms_commerce_expenses (posted_movement_id)
  WHERE posted_movement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_expenses_reversal_movement_fk_idx
  ON awcms_commerce_expenses (reversal_movement_id)
  WHERE reversal_movement_id IS NOT NULL;
-- UNIQUE: one private object serves at most ONE expense. Without it an employee
-- holding `expense_receipts.create` could attach any private object they know
-- the id of to their own expense and read it back through the receipt route (a
-- confused deputy). The directory also requires the attacher to be the
-- object's uploader and refuses an object that gates a product download.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_expenses_receipt_media_key
  ON awcms_commerce_expenses (receipt_media_object_id)
  WHERE receipt_media_object_id IS NOT NULL;

ALTER TABLE awcms_commerce_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_expenses FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_expenses_tenant_isolation
  ON awcms_commerce_expenses
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_expenses FROM awcms_app;

-- The lifecycle guard. Identity columns are always frozen; the legal status
-- moves are draft -> pending_approval | posted | cancelled,
-- pending_approval -> posted | draft, posted -> reversed; reversed and
-- cancelled are terminal. Outside `draft` the CONTENT is frozen (a pending
-- expense is decided as submitted; a posted one is evidence) - except that a
-- receipt may be attached to a posted/reversed expense ONCE (NULL -> object),
-- since a receipt often arrives after the cash left. The BEGIN/END below are
-- PL/pgSQL block delimiters in a dollar-quoted body, not transaction control
-- (`sql/033`'s precedent).
CREATE OR REPLACE FUNCTION awcms_commerce_expenses_guard()
RETURNS trigger AS $awcms_commerce_expenses_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.created_by_tenant_user_id IS DISTINCT FROM OLD.created_by_tenant_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_expenses row % is frozen: identity and creator never change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('reversed', 'cancelled') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      OR (to_jsonb(NEW) - 'receipt_media_object_id' - 'updated_at' - 'updated_by_tenant_user_id')
         IS DISTINCT FROM
         (to_jsonb(OLD) - 'receipt_media_object_id' - 'updated_at' - 'updated_by_tenant_user_id')
      OR (OLD.receipt_media_object_id IS NOT NULL
          AND NEW.receipt_media_object_id IS DISTINCT FROM OLD.receipt_media_object_id)
    THEN
      RAISE EXCEPTION
        'awcms_commerce_expenses row % is % and immutable',
        OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('pending_approval', 'posted', 'cancelled'))
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('posted', 'draft'))
    OR (OLD.status = 'posted' AND NEW.status = 'reversed')
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_expenses row %: illegal status transition % -> %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Content is editable only while the row is (and stays) a draft.
  IF OLD.status <> 'draft' AND (
    NEW.category_id IS DISTINCT FROM OLD.category_id
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.tender_type IS DISTINCT FROM OLD.tender_type
    OR NEW.occurred_on IS DISTINCT FROM OLD.occurred_on
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.payee_name IS DISTINCT FROM OLD.payee_name
    OR NEW.register_session_id IS DISTINCT FROM OLD.register_session_id
    OR (OLD.status = 'pending_approval'
        AND NEW.receipt_media_object_id IS DISTINCT FROM OLD.receipt_media_object_id
        AND NEW.status = OLD.status)
    OR (OLD.status = 'posted'
        AND OLD.receipt_media_object_id IS NOT NULL
        AND NEW.receipt_media_object_id IS DISTINCT FROM OLD.receipt_media_object_id)
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_expenses row % is % and its content is frozen',
      OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A posted expense's posting facts are evidence too.
  IF OLD.status = 'posted' AND (
    NEW.posted_by_tenant_user_id IS DISTINCT FROM OLD.posted_by_tenant_user_id
    OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
    OR NEW.posted_movement_id IS DISTINCT FROM OLD.posted_movement_id
    OR NEW.decision IS DISTINCT FROM OLD.decision
    OR NEW.decided_by_tenant_user_id IS DISTINCT FROM OLD.decided_by_tenant_user_id
    OR NEW.approval_threshold IS DISTINCT FROM OLD.approval_threshold
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_expenses row % is posted: its posting facts never change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_expenses_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_expenses_guard
  ON awcms_commerce_expenses;
CREATE TRIGGER awcms_commerce_expenses_guard
  BEFORE UPDATE ON awcms_commerce_expenses
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_expenses_guard();

COMMENT ON TABLE awcms_commerce_expenses IS
  'Issue #294 (ADR-0031) — a commerce-local, register-linked petty cash / operational expense. NOT a general ledger: a posted drawer-paid expense appends a register movement (sql/991); it never edits a cash-up total.';
