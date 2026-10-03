-- Issue #284 (epic #281, ADR-0028) — POS registers, register sessions, drawer
-- movements, cash-up (close) requests and post-close corrections. This issue
-- owns 970-974 in the reserved commerce 9xx range (ADR-0015): 970 this schema,
-- 971 the stamping columns on orders/allocations, 972 permissions, 973 worker
-- grants; 974 is held and unused.
--
-- Same conventions as `sql/917`/`sql/936`/`sql/940` (not repeated in full):
-- `ENABLE` + `FORCE ROW LEVEL SECURITY`, one tenant-isolation policy with a
-- `WITH CHECK`, `id uuid` PK `DEFAULT gen_random_uuid()`, `numeric(14,2)`
-- money (ADR-0003), an index for every FK column, `text` + `CHECK` for every
-- enumerated column (never a native ENUM), composite `(tenant_id, …)` foreign
-- keys backed by `UNIQUE (tenant_id, id)` so a row of tenant A can never point
-- at a row of tenant B even through a service credential that bypasses RLS.
--
-- ## What a register session is
--
-- A REGISTER is a named till (`code`, `name`, an optional location label,
-- `active`). A SESSION is one shift on one register: opened with a counted
-- opening float, owned by a current cashier (a handover changes the cashier,
-- never the history — handovers are audit events), and ended by a close
-- (cash-up). While a session is `open`, POS sales are stamped with it
-- (`sql/971`) and drawer MOVEMENTS are recorded against it; the session's
-- EXPECTED closing amount per tender is DERIVED, never stored as a running
-- total:
--
--   expected(cash)   = opening float
--                    + Σ succeeded cash payment legs stamped with the session
--                    − Σ succeeded cash reversal legs stamped with the session
--                    + Σ movements in − Σ movements out
--   expected(other)  = Σ succeeded payments − Σ succeeded reversals of that
--                      tender stamped with the session
--
-- (Cash payment legs carry the APPLIED amount, change already excluded —
-- `sql/940`.) The expected figures are SNAPSHOTTED once, onto the close
-- request's lines, so a closed session's numbers are evidence, not a query.
--
-- ## One active session per register, mechanically
--
-- `awcms_commerce_register_sessions_one_active` is a partial UNIQUE index on
-- `(tenant_id, register_id) WHERE status IN ('open', 'closing')`. The
-- application also locks the register row (`FOR NO KEY UPDATE`) before
-- reading it, so two genuinely concurrent opens serialise and the loser gets
-- a clean 409 rather than a unique violation — the index is the independent
-- second guard that holds even for a writer that skipped the lock.
--
-- ## Statuses and the close workflow
--
--   open     — sales, movements and handovers are accepted.
--   closing  — a close was REQUESTED and its variance exceeds the tenant's
--              approval threshold: the counted amounts are saved on a
--              `pending` close request and the session accepts nothing until
--              a user holding the approve permission decides it. Approve →
--              closed; reject → back to `open` (the rejected request stays as
--              history, and the next attempt is attempt n+1).
--   closed   — immutable. Every column of the session row is frozen by the
--              guard trigger below except the single transition
--              `closed → corrected`.
--   corrected— a compensating correction (`awcms_commerce_register_corrections`)
--              exists. The original close request and its lines are preserved
--              untouched; the corrected counted amount per tender is the
--              original counted + the sum of its corrections.
--
-- ## Append-only, mechanically
--
-- Movements, close lines and corrections can never be updated (a trigger
-- refuses it, and `awcms_app` loses UPDATE and DELETE on them), and
-- `awcms_app` loses DELETE on every table here (`sql/019` granted all four
-- verbs by default — `sql/125`'s/`sql/940`'s precedent). A close request may
-- change in exactly one way: `pending → approved | rejected` (+ the decider).
-- `awcms_worker` keeps SELECT + DELETE (`sql/973`) only for the generic
-- data-lifecycle engine's retention ceiling.
--
-- ## Columns worth explaining
--
--   * `awcms_commerce_registers.deleted_at` / `…_sessions.deleted_at` exist
--     ONLY as the retention engine's cursor column (`commerce/module.ts`):
--     like `awcms_commerce_orders.deleted_at` this module never sets them (a
--     register and a session are fiscal records, deactivated not deleted), so
--     the purge predicate can never match them.
--   * `*_tenant_user_id` actor columns are plain uuid STAMPS, not FKs
--     (`sql/931`'s reasoning for `pos_cashier_tenant_user_id`): a fiscal
--     record must outlive the staff account that produced it.
--   * `movement_type` / `direction`: cash only (the drawer holds cash). The
--     CHECK pins the direction of the three types that only ever go one way
--     (`cash_in` in; `cash_out`, `safe_drop`, `expense` out); `transfer` and
--     `correction` may go either way and a `correction` must say why.
--   * `reference_kind`: the TYPED REFERENCE HOOK for an `expense` movement.
--     Today the only kind is `free_text` (a typed note in `reference`); the
--     expenses domain (#294) does not exist, and an id column pointing at
--     nothing would be a claim, not a feature. The migration that ships the
--     expenses table widens this CHECK and adds the id column.
--   * `source_key`: the row-level idempotency key (`UNIQUE (tenant_id,
--     source_key)`), the independent second guard behind the shared
--     `awcms_idempotency_keys` store's HTTP replay semantics.
--   * `variance_total` is NET (counted − expected, summed); `variance_gross`
--     is the sum of the ABSOLUTE per-tender variances — the figure compared
--     with the approval threshold, so a cash surplus cannot hide a QRIS
--     shortfall by netting to zero. A reason is mandatory whenever the
--     gross variance is non-zero.

CREATE TABLE IF NOT EXISTS awcms_commerce_registers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  code text NOT NULL,
  name text NOT NULL,
  location_label text,
  active boolean NOT NULL DEFAULT true,
  created_by_tenant_user_id uuid,
  updated_by_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_registers_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_registers_code_check
    CHECK (char_length(code) BETWEEN 1 AND 40),
  CONSTRAINT awcms_commerce_registers_name_check
    CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT awcms_commerce_registers_location_check
    CHECK (location_label IS NULL OR char_length(location_label) BETWEEN 1 AND 120)
);

-- A register code is unique per tenant, case-insensitively ("KASIR-1" and
-- "kasir-1" are the same till).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_registers_tenant_code_key
  ON awcms_commerce_registers (tenant_id, lower(code));

CREATE INDEX IF NOT EXISTS awcms_commerce_registers_tenant_idx
  ON awcms_commerce_registers (tenant_id);

-- The (tenant, cursor) composite the generic purge engine requires.
CREATE INDEX IF NOT EXISTS awcms_commerce_registers_tenant_deleted_idx
  ON awcms_commerce_registers (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_registers ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_registers FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_registers_tenant_isolation
  ON awcms_commerce_registers
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_registers FROM awcms_app;

CREATE TABLE IF NOT EXISTS awcms_commerce_register_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  register_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by_tenant_user_id uuid NOT NULL,
  opening_float numeric(14, 2) NOT NULL,
  current_cashier_tenant_user_id uuid NOT NULL,
  closed_at timestamptz,
  closed_by_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_register_sessions_register_fk
    FOREIGN KEY (tenant_id, register_id)
    REFERENCES awcms_commerce_registers (tenant_id, id),
  CONSTRAINT awcms_commerce_register_sessions_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_register_sessions_status_check
    CHECK (status IN ('open', 'closing', 'closed', 'corrected')),
  CONSTRAINT awcms_commerce_register_sessions_float_check
    CHECK (opening_float >= 0),
  -- `closed_at`/`closed_by` are stamped exactly when the session is closed
  -- (and stay on a corrected one).
  CONSTRAINT awcms_commerce_register_sessions_closed_check
    CHECK (
      (status IN ('closed', 'corrected')) = (closed_at IS NOT NULL)
      AND (closed_at IS NULL) = (closed_by_tenant_user_id IS NULL)
    )
);

-- One ACTIVE session per register (see the header).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_register_sessions_one_active
  ON awcms_commerce_register_sessions (tenant_id, register_id)
  WHERE status IN ('open', 'closing');

CREATE INDEX IF NOT EXISTS awcms_commerce_register_sessions_tenant_idx
  ON awcms_commerce_register_sessions (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_sessions_register_idx
  ON awcms_commerce_register_sessions (register_id);

-- A register's own history, newest first.
CREATE INDEX IF NOT EXISTS awcms_commerce_register_sessions_tenant_register_opened_idx
  ON awcms_commerce_register_sessions (tenant_id, register_id, opened_at DESC);

-- "My open session" (the POS banner) and the status-filtered list.
CREATE INDEX IF NOT EXISTS awcms_commerce_register_sessions_tenant_status_idx
  ON awcms_commerce_register_sessions (tenant_id, status, opened_at DESC);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_sessions_tenant_cashier_idx
  ON awcms_commerce_register_sessions (tenant_id, current_cashier_tenant_user_id, status);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_sessions_tenant_deleted_idx
  ON awcms_commerce_register_sessions (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_register_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_register_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_register_sessions_tenant_isolation
  ON awcms_commerce_register_sessions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_register_sessions FROM awcms_app;

-- Session guard. Identity columns are always frozen. A `closed`/`corrected`
-- session is immutable apart from the one transition `closed -> corrected`.
-- Legal status moves: open -> closing | closed, closing -> open | closed,
-- closed -> corrected. The BEGIN/END below are PL/pgSQL block delimiters in a
-- dollar-quoted body, not transaction control (`sql/033`'s precedent).
CREATE OR REPLACE FUNCTION awcms_commerce_register_sessions_guard()
RETURNS trigger AS $awcms_commerce_register_sessions_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.register_id IS DISTINCT FROM OLD.register_id
    OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
    OR NEW.opened_by_tenant_user_id IS DISTINCT FROM OLD.opened_by_tenant_user_id
    OR NEW.opening_float IS DISTINCT FROM OLD.opening_float
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_register_sessions row % is frozen: identity, opening float and opening time never change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('closed', 'corrected') THEN
    IF NOT (OLD.status = 'closed' AND NEW.status = 'corrected')
       AND NEW.status IS DISTINCT FROM OLD.status
    THEN
      RAISE EXCEPTION
        'awcms_commerce_register_sessions row % is closed: only the closed -> corrected transition is allowed',
        OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.current_cashier_tenant_user_id IS DISTINCT FROM OLD.current_cashier_tenant_user_id
      OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
      OR NEW.closed_by_tenant_user_id IS DISTINCT FROM OLD.closed_by_tenant_user_id
      OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    THEN
      RAISE EXCEPTION
        'awcms_commerce_register_sessions row % is closed and immutable',
        OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'open' AND NEW.status IN ('closing', 'closed'))
    OR (OLD.status = 'closing' AND NEW.status IN ('open', 'closed'))
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_register_sessions row %: illegal status transition % -> %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_register_sessions_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_register_sessions_guard
  ON awcms_commerce_register_sessions;
CREATE TRIGGER awcms_commerce_register_sessions_guard
  BEFORE UPDATE ON awcms_commerce_register_sessions
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_register_sessions_guard();

-- Shared append-only guards (one function per intent, reused below).
CREATE OR REPLACE FUNCTION awcms_commerce_register_append_only()
RETURNS trigger AS $awcms_commerce_register_append_only$
BEGIN
  RAISE EXCEPTION
    '% row % is append-only (a correction is a new compensating row)',
    TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$awcms_commerce_register_append_only$ LANGUAGE plpgsql;

-- A movement / close request may only be written against an `open` session
-- (a closed session is immutable; a `closing` one accepts nothing).
CREATE OR REPLACE FUNCTION awcms_commerce_register_require_open_session()
RETURNS trigger AS $awcms_commerce_register_require_open_session$
DECLARE
  session_status text;
BEGIN
  SELECT status INTO session_status
  FROM awcms_commerce_register_sessions
  WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id;
  IF session_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION
      '% may only be written against an open register session (session % is %)',
      TG_TABLE_NAME, NEW.session_id, COALESCE(session_status, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_register_require_open_session$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS awcms_commerce_register_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  session_id uuid NOT NULL,
  movement_type text NOT NULL,
  direction text NOT NULL,
  amount numeric(14, 2) NOT NULL,
  reference_kind text NOT NULL DEFAULT 'free_text',
  reference text,
  note text,
  actor_tenant_user_id uuid NOT NULL,
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_register_movements_session_fk
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES awcms_commerce_register_sessions (tenant_id, id),
  CONSTRAINT awcms_commerce_register_movements_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_register_movements_type_check
    CHECK (movement_type IN ('cash_in', 'cash_out', 'safe_drop', 'expense', 'transfer', 'correction')),
  CONSTRAINT awcms_commerce_register_movements_direction_check
    CHECK (direction IN ('in', 'out')),
  CONSTRAINT awcms_commerce_register_movements_type_direction_check
    CHECK (
      (movement_type = 'cash_in' AND direction = 'in')
      OR (movement_type IN ('cash_out', 'safe_drop', 'expense') AND direction = 'out')
      OR movement_type IN ('transfer', 'correction')
    ),
  CONSTRAINT awcms_commerce_register_movements_amount_check
    CHECK (amount > 0),
  -- The typed reference hook (see the header): `free_text` is the only kind.
  CONSTRAINT awcms_commerce_register_movements_reference_kind_check
    CHECK (reference_kind IN ('free_text')),
  CONSTRAINT awcms_commerce_register_movements_reference_check
    CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 100),
  CONSTRAINT awcms_commerce_register_movements_note_check
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  -- An expense or a transfer names what it was for / where it went; a
  -- correction names why.
  CONSTRAINT awcms_commerce_register_movements_reference_required_check
    CHECK (movement_type NOT IN ('expense', 'transfer') OR reference IS NOT NULL),
  CONSTRAINT awcms_commerce_register_movements_correction_note_check
    CHECK (movement_type <> 'correction' OR note IS NOT NULL),
  CONSTRAINT awcms_commerce_register_movements_source_key_check
    CHECK (char_length(source_key) BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_register_movements_source_key
  ON awcms_commerce_register_movements (tenant_id, source_key);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_movements_tenant_idx
  ON awcms_commerce_register_movements (tenant_id);

-- A session's own movement read and expected-total sum.
CREATE INDEX IF NOT EXISTS awcms_commerce_register_movements_tenant_session_idx
  ON awcms_commerce_register_movements (tenant_id, session_id, created_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_movements_session_idx
  ON awcms_commerce_register_movements (session_id);

-- The (tenant, cursor) composite the generic purge engine requires.
CREATE INDEX IF NOT EXISTS awcms_commerce_register_movements_tenant_created_idx
  ON awcms_commerce_register_movements (tenant_id, created_at);

ALTER TABLE awcms_commerce_register_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_register_movements FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_register_movements_tenant_isolation
  ON awcms_commerce_register_movements
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP TRIGGER IF EXISTS awcms_commerce_register_movements_require_open
  ON awcms_commerce_register_movements;
CREATE TRIGGER awcms_commerce_register_movements_require_open
  BEFORE INSERT ON awcms_commerce_register_movements
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_register_require_open_session();

DROP TRIGGER IF EXISTS awcms_commerce_register_movements_append_only
  ON awcms_commerce_register_movements;
CREATE TRIGGER awcms_commerce_register_movements_append_only
  BEFORE UPDATE ON awcms_commerce_register_movements
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_register_append_only();

-- Pure append: the runtime role may only SELECT and INSERT (the trigger above
-- would refuse an UPDATE anyway; the REVOKE makes it a privilege error too).
REVOKE UPDATE, DELETE ON awcms_commerce_register_movements FROM awcms_app;

-- One row per close ATTEMPT of a session (a rejected request stays as
-- history; the next attempt is attempt n+1).
CREATE TABLE IF NOT EXISTS awcms_commerce_register_close_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  session_id uuid NOT NULL,
  attempt integer NOT NULL,
  requested_by_tenant_user_id uuid NOT NULL,
  variance_total numeric(14, 2) NOT NULL,
  variance_gross numeric(14, 2) NOT NULL,
  approval_threshold numeric(14, 2) NOT NULL,
  approval_required boolean NOT NULL,
  variance_reason text,
  decision text NOT NULL,
  decided_by_tenant_user_id uuid,
  decided_at timestamptz,
  decision_note text,
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_register_close_requests_session_fk
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES awcms_commerce_register_sessions (tenant_id, id),
  CONSTRAINT awcms_commerce_register_close_requests_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_register_close_requests_attempt_key
    UNIQUE (tenant_id, session_id, attempt),
  CONSTRAINT awcms_commerce_register_close_requests_attempt_check
    CHECK (attempt >= 1),
  CONSTRAINT awcms_commerce_register_close_requests_gross_check
    CHECK (variance_gross >= 0),
  CONSTRAINT awcms_commerce_register_close_requests_threshold_check
    CHECK (approval_threshold >= 0),
  CONSTRAINT awcms_commerce_register_close_requests_decision_check
    CHECK (decision IN ('auto', 'pending', 'approved', 'rejected')),
  -- A reason is mandatory whenever anything is off.
  CONSTRAINT awcms_commerce_register_close_requests_reason_check
    CHECK (
      (variance_gross = 0 OR (variance_reason IS NOT NULL AND char_length(variance_reason) BETWEEN 1 AND 500))
      AND (variance_reason IS NULL OR char_length(variance_reason) BETWEEN 1 AND 500)
    ),
  -- `auto` = within the threshold, closed on the spot; `pending` waits for an
  -- approver; `approved`/`rejected` name who decided.
  CONSTRAINT awcms_commerce_register_close_requests_decision_shape_check
    CHECK (
      (decision = 'auto' AND decided_at IS NOT NULL AND decided_by_tenant_user_id IS NULL AND NOT approval_required)
      OR (decision = 'pending' AND decided_at IS NULL AND decided_by_tenant_user_id IS NULL AND approval_required)
      OR (decision IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decided_by_tenant_user_id IS NOT NULL AND approval_required)
    ),
  CONSTRAINT awcms_commerce_register_close_requests_note_check
    CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500),
  CONSTRAINT awcms_commerce_register_close_requests_source_key_check
    CHECK (char_length(source_key) BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_register_close_requests_source_key
  ON awcms_commerce_register_close_requests (tenant_id, source_key);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_close_requests_tenant_idx
  ON awcms_commerce_register_close_requests (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_close_requests_session_idx
  ON awcms_commerce_register_close_requests (session_id);

-- The (tenant, cursor) composite the generic purge engine requires, and the
-- pending-approvals scan.
CREATE INDEX IF NOT EXISTS awcms_commerce_register_close_requests_tenant_created_idx
  ON awcms_commerce_register_close_requests (tenant_id, created_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_close_requests_pending_idx
  ON awcms_commerce_register_close_requests (tenant_id, created_at)
  WHERE decision = 'pending';

ALTER TABLE awcms_commerce_register_close_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_register_close_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_register_close_requests_tenant_isolation
  ON awcms_commerce_register_close_requests
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP TRIGGER IF EXISTS awcms_commerce_register_close_requests_require_open
  ON awcms_commerce_register_close_requests;
CREATE TRIGGER awcms_commerce_register_close_requests_require_open
  BEFORE INSERT ON awcms_commerce_register_close_requests
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_register_require_open_session();

-- A close request changes in exactly one way: `pending` resolves to
-- `approved`/`rejected`, stamping who decided and when.
CREATE OR REPLACE FUNCTION awcms_commerce_register_close_requests_guard()
RETURNS trigger AS $awcms_commerce_register_close_requests_guard$
BEGIN
  IF OLD.decision <> 'pending' OR NEW.decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION
      'awcms_commerce_register_close_requests row % is append-only: only a pending request may be approved or rejected',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.attempt IS DISTINCT FROM OLD.attempt
    OR NEW.requested_by_tenant_user_id IS DISTINCT FROM OLD.requested_by_tenant_user_id
    OR NEW.variance_total IS DISTINCT FROM OLD.variance_total
    OR NEW.variance_gross IS DISTINCT FROM OLD.variance_gross
    OR NEW.approval_threshold IS DISTINCT FROM OLD.approval_threshold
    OR NEW.approval_required IS DISTINCT FROM OLD.approval_required
    OR NEW.variance_reason IS DISTINCT FROM OLD.variance_reason
    OR NEW.source_key IS DISTINCT FROM OLD.source_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_register_close_requests row % is append-only: a decision may change only decision/decided_by/decided_at/decision_note',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_register_close_requests_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_register_close_requests_guard
  ON awcms_commerce_register_close_requests;
CREATE TRIGGER awcms_commerce_register_close_requests_guard
  BEFORE UPDATE ON awcms_commerce_register_close_requests
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_register_close_requests_guard();

REVOKE DELETE ON awcms_commerce_register_close_requests FROM awcms_app;

-- The per-tender snapshot of a close request: what the ledger + movements
-- said the drawer should hold (`expected`), what was counted, and the
-- difference. `variance = counted - expected` is an invariant of the row.
CREATE TABLE IF NOT EXISTS awcms_commerce_register_close_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  close_request_id uuid NOT NULL,
  session_id uuid NOT NULL,
  tender_type text NOT NULL,
  expected numeric(14, 2) NOT NULL,
  counted numeric(14, 2) NOT NULL,
  variance numeric(14, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_register_close_lines_request_fk
    FOREIGN KEY (tenant_id, close_request_id)
    REFERENCES awcms_commerce_register_close_requests (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_register_close_lines_session_fk
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES awcms_commerce_register_sessions (tenant_id, id),
  CONSTRAINT awcms_commerce_register_close_lines_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_register_close_lines_tender_key
    UNIQUE (tenant_id, close_request_id, tender_type),
  CONSTRAINT awcms_commerce_register_close_lines_tender_check
    CHECK (tender_type IN ('cash', 'manual_qris', 'manual_bank_transfer', 'gateway')),
  CONSTRAINT awcms_commerce_register_close_lines_counted_check
    CHECK (counted >= 0),
  CONSTRAINT awcms_commerce_register_close_lines_variance_check
    CHECK (variance = counted - expected)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_close_lines_tenant_idx
  ON awcms_commerce_register_close_lines (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_close_lines_request_idx
  ON awcms_commerce_register_close_lines (close_request_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_close_lines_session_idx
  ON awcms_commerce_register_close_lines (session_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_close_lines_tenant_created_idx
  ON awcms_commerce_register_close_lines (tenant_id, created_at);

ALTER TABLE awcms_commerce_register_close_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_register_close_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_register_close_lines_tenant_isolation
  ON awcms_commerce_register_close_lines
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

DROP TRIGGER IF EXISTS awcms_commerce_register_close_lines_append_only
  ON awcms_commerce_register_close_lines;
CREATE TRIGGER awcms_commerce_register_close_lines_append_only
  BEFORE UPDATE ON awcms_commerce_register_close_lines
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_register_append_only();

-- Pure append: the runtime role may only SELECT and INSERT (the trigger above
-- would refuse an UPDATE anyway; the REVOKE makes it a privilege error too).
REVOKE UPDATE, DELETE ON awcms_commerce_register_close_lines FROM awcms_app;

-- Post-close corrections: compensating rows, one per (correction, tender).
-- `adjustment` is a signed delta to the COUNTED amount of that tender; the
-- original close lines are never touched. A correction may only be written
-- against a closed/corrected session.
CREATE TABLE IF NOT EXISTS awcms_commerce_register_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  session_id uuid NOT NULL,
  correction_id uuid NOT NULL,
  tender_type text NOT NULL,
  adjustment numeric(14, 2) NOT NULL,
  reason text NOT NULL,
  actor_tenant_user_id uuid NOT NULL,
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_register_corrections_session_fk
    FOREIGN KEY (tenant_id, session_id)
    REFERENCES awcms_commerce_register_sessions (tenant_id, id),
  CONSTRAINT awcms_commerce_register_corrections_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_register_corrections_group_tender_key
    UNIQUE (tenant_id, correction_id, tender_type),
  CONSTRAINT awcms_commerce_register_corrections_tender_check
    CHECK (tender_type IN ('cash', 'manual_qris', 'manual_bank_transfer', 'gateway')),
  CONSTRAINT awcms_commerce_register_corrections_adjustment_check
    CHECK (adjustment <> 0),
  CONSTRAINT awcms_commerce_register_corrections_reason_check
    CHECK (char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT awcms_commerce_register_corrections_source_key_check
    CHECK (char_length(source_key) BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_register_corrections_source_key
  ON awcms_commerce_register_corrections (tenant_id, source_key, tender_type);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_corrections_tenant_idx
  ON awcms_commerce_register_corrections (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_corrections_tenant_session_idx
  ON awcms_commerce_register_corrections (tenant_id, session_id, created_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_corrections_session_idx
  ON awcms_commerce_register_corrections (session_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_register_corrections_tenant_created_idx
  ON awcms_commerce_register_corrections (tenant_id, created_at);

ALTER TABLE awcms_commerce_register_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_register_corrections FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_register_corrections_tenant_isolation
  ON awcms_commerce_register_corrections
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE FUNCTION awcms_commerce_register_corrections_require_closed()
RETURNS trigger AS $awcms_commerce_register_corrections_require_closed$
DECLARE
  session_status text;
BEGIN
  SELECT status INTO session_status
  FROM awcms_commerce_register_sessions
  WHERE tenant_id = NEW.tenant_id AND id = NEW.session_id;
  IF session_status IS NULL OR session_status NOT IN ('closed', 'corrected') THEN
    RAISE EXCEPTION
      'a register correction may only be written against a closed session (session % is %)',
      NEW.session_id, COALESCE(session_status, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_register_corrections_require_closed$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_register_corrections_require_closed
  ON awcms_commerce_register_corrections;
CREATE TRIGGER awcms_commerce_register_corrections_require_closed
  BEFORE INSERT ON awcms_commerce_register_corrections
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_register_corrections_require_closed();

DROP TRIGGER IF EXISTS awcms_commerce_register_corrections_append_only
  ON awcms_commerce_register_corrections;
CREATE TRIGGER awcms_commerce_register_corrections_append_only
  BEFORE UPDATE ON awcms_commerce_register_corrections
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_register_append_only();

-- Pure append: the runtime role may only SELECT and INSERT (the trigger above
-- would refuse an UPDATE anyway; the REVOKE makes it a privilege error too).
REVOKE UPDATE, DELETE ON awcms_commerce_register_corrections FROM awcms_app;

COMMENT ON TABLE awcms_commerce_registers IS
  'Issue #284 (ADR-0028) — a named POS till (code, name, optional location label, active flag). Tenant-scoped.';
COMMENT ON TABLE awcms_commerce_register_sessions IS
  'Issue #284 (ADR-0028) — one shift on one register: opening float, current cashier, status open|closing|closed|corrected. One active (open/closing) session per register; a closed session is immutable except closed -> corrected.';
COMMENT ON TABLE awcms_commerce_register_movements IS
  'Issue #284 (ADR-0028) — append-only cash drawer movements (cash in/out, safe drop, expense, transfer, correction) against an open session.';
COMMENT ON TABLE awcms_commerce_register_close_requests IS
  'Issue #284 (ADR-0028) — one row per close (cash-up) attempt; variance, reason, approval decision. Pending resolves to approved/rejected only.';
COMMENT ON TABLE awcms_commerce_register_close_lines IS
  'Issue #284 (ADR-0028) — the per-tender expected/counted/variance snapshot of one close request. Append-only.';
COMMENT ON TABLE awcms_commerce_register_corrections IS
  'Issue #284 (ADR-0028) — compensating post-close corrections to a tender''s counted amount; the original close lines are preserved. Append-only.';
COMMENT ON COLUMN awcms_commerce_register_movements.reference_kind IS
  'Typed reference hook for an expense movement (Issue #284): only free_text today; the expenses domain (#294) widens this CHECK and adds the id column.';
