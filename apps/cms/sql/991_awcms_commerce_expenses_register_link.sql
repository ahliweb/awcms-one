-- Issue #294 (ADR-0031, resolves ADR-0028 D10) — the typed expense reference
-- on register movements. `sql/970` shipped `reference_kind` with the single
-- value `free_text` and promised that "the migration that ships the expenses
-- table widens this CHECK and adds the id column"; this is that migration.
--
-- A movement that an EXPENSE produced carries `reference_kind = 'expense'` and
-- `expense_id`, a composite tenant FK to `awcms_commerce_expenses`
-- (`sql/990`). Two movement shapes use it:
--
--   * the POSTING movement: `movement_type = 'expense'`, `direction = 'out'`
--     (the cash left the drawer);
--   * the REVERSAL movement: `movement_type = 'correction'`, `direction = 'in'`
--     (the compensating entry that puts the cash back in the books; the
--     original row is never touched - the table is append-only, `sql/970`).
--
-- ## Exactly once, mechanically
--
-- A cash-up derives its expected cash from `Σ movements in − Σ movements out`
-- (ADR-0028 D2), so "the expense is reflected exactly once" reduces to "an
-- expense has at most one OUT movement and at most one IN movement". The
-- partial UNIQUE index below states exactly that; it is the independent second
-- guard behind the application's row lock and the movement `source_key`
-- (`expense:<id>:post` / `expense:<id>:reverse`).
--
-- The append-only trigger of `sql/970` refuses every UPDATE of a movement, so
-- the new columns need no new guard: they are written once, at INSERT.
-- Existing rows keep `reference_kind = 'free_text'` and `expense_id IS NULL`
-- (the expand step; nothing to backfill).

ALTER TABLE awcms_commerce_register_movements
  ADD COLUMN IF NOT EXISTS expense_id uuid;

ALTER TABLE awcms_commerce_register_movements
  DROP CONSTRAINT IF EXISTS awcms_commerce_register_movements_reference_kind_check;

ALTER TABLE awcms_commerce_register_movements
  ADD CONSTRAINT awcms_commerce_register_movements_reference_kind_check
  CHECK (reference_kind IN ('free_text', 'expense'));

ALTER TABLE awcms_commerce_register_movements
  ADD CONSTRAINT awcms_commerce_register_movements_expense_fk
  FOREIGN KEY (tenant_id, expense_id)
  REFERENCES awcms_commerce_expenses (tenant_id, id);

-- The kind and the id travel together, and only an expense posting (out) or its
-- compensating reversal (in) may carry them.
ALTER TABLE awcms_commerce_register_movements
  ADD CONSTRAINT awcms_commerce_register_movements_expense_shape_check
  CHECK (
    (reference_kind = 'free_text' AND expense_id IS NULL)
    OR (
      reference_kind = 'expense'
      AND expense_id IS NOT NULL
      AND (
        (movement_type = 'expense' AND direction = 'out')
        OR (movement_type = 'correction' AND direction = 'in')
      )
    )
  );

-- At most one OUT and one IN movement per expense: the posting and its
-- reversal, each exactly once.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_register_movements_expense_direction_key
  ON awcms_commerce_register_movements (tenant_id, expense_id, direction)
  WHERE expense_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_register_movements_expense_fk_idx
  ON awcms_commerce_register_movements (expense_id)
  WHERE expense_id IS NOT NULL;

COMMENT ON COLUMN awcms_commerce_register_movements.expense_id IS
  'Issue #294 (ADR-0031) — the expense this movement posts (out) or reverses (in); set only with reference_kind = expense. At most one out and one in per expense.';
