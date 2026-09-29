-- Issue #266 (IRMbyDUS, FR-COM-001) — widen
-- `awcms_commerce_products.type` with five additive kinds:
-- 'digital_ebook', 'digital_program', 'mentoring', 'bundle', 'event'.
--
-- Enum extension only, scoped deliberately narrow: this does NOT add a
-- digital-delivery linkage (tying a product to protected media/program/
-- mentoring content) — that is issue #267 (the entitlement module), a
-- separate, not-yet-started piece of work. No new columns, no new tables.
--
-- `sql/901`'s original CHECK admitted only
-- 'physical'/'digital'/'service'/'subscription'; a CHECK constraint cannot be
-- altered in place, so it is dropped and re-created with the wider list. No
-- data change — every existing row's `type` is still one of the original
-- four values and remains valid under the new CHECK.

ALTER TABLE awcms_commerce_products
  DROP CONSTRAINT IF EXISTS awcms_commerce_products_type_check;

ALTER TABLE awcms_commerce_products
  ADD CONSTRAINT awcms_commerce_products_type_check
    CHECK (type IN (
      'physical', 'digital', 'service', 'subscription',
      'digital_ebook', 'digital_program', 'mentoring', 'bundle', 'event'
    ));

COMMENT ON COLUMN awcms_commerce_products.type IS
  'physical | digital | service | subscription | digital_ebook | digital_program | mentoring | bundle | event (Issue #266: five PRD-required kinds added, additive; no digital-delivery linkage — see issue #267).';
