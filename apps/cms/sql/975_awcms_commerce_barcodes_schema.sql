-- Issue #292 (epic #281; ADR-0032) - a scannable barcode identity for a
-- product or a variant. This issue owns 975-979 in the reserved commerce 9xx
-- range (ADR-0015): 975 this schema, 976 permissions; 977-979 are held.
--
-- ## What this is - and is not
--
-- ONE nullable `barcode` column on each of the two sellable rows, not a new
-- table: a barcode is an alternate IDENTIFIER of a row that already exists,
-- exactly like `sku` (`sql/901`/`sql/905`), so it inherits those tables' FORCE
-- RLS, tenant isolation, soft delete and retention descriptors unchanged and
-- adds no second row to keep consistent with the first. Nothing here makes a
-- barcode a credential: it names a catalogue row and nothing else (ADR-0032
-- D1, the issue's non-goal).
--
-- The SYMBOLOGY is deliberately NOT stored. It is a pure function of the code
-- (`domain/barcode.ts`'s `classifyBarcode`: an all-digit code of length
-- 8/12/13/14 is a GTIN and its check digit is validated; anything else is a
-- free Code 128 internal code), so a stored column could only ever disagree
-- with the value it describes.
--
-- ## Uniqueness: per tenant, across BOTH tables
--
-- A scanner reads one string and must resolve to exactly one thing, so a code
-- is unique among LIVE products AND variants of a tenant. A single-table unique
-- index cannot see across two tables (the `sku` precedent: `sql/905`'s header),
-- so the rule has two halves:
--   * each table's partial unique index (below) - the same-table half, which
--     also IS the lookup index (an equality scan on (tenant_id, barcode));
--   * a BEFORE INSERT/UPDATE trigger on each table that refuses a code held by
--     a live row of the OTHER table. It takes a transaction-scoped advisory
--     lock on (tenant, code) first, so two concurrent writers of the same new
--     code queue instead of both passing the check - the race the application
--     layer alone cannot close.
-- A soft-deleted row frees its code (the index is partial), so RESTORING a row
-- whose code has since been taken would collide; rather than fail a restore
-- with an opaque 500, the trigger clears the restored row's barcode (the row
-- comes back un-barcoded; the operator assigns a new one). That is the only
-- case where the trigger rewrites a value instead of refusing it. The trigger
-- therefore also checks the row's OWN table (not only the other one): it must
-- run before the unique index would, to be able to make that choice.
ALTER TABLE awcms_commerce_products
  ADD COLUMN IF NOT EXISTS barcode text;
ALTER TABLE awcms_commerce_product_variants
  ADD COLUMN IF NOT EXISTS barcode text;

-- Printable ASCII without spaces (0x21-0x7E), 1-48 characters: the Code 128
-- subset B repertoire a keyboard-wedge scanner can type back, with no control
-- characters, no whitespace, no non-ASCII. Mirrors `domain/barcode.ts`.
ALTER TABLE awcms_commerce_products
  DROP CONSTRAINT IF EXISTS awcms_commerce_products_barcode_check;
ALTER TABLE awcms_commerce_products
  ADD CONSTRAINT awcms_commerce_products_barcode_check
  CHECK (barcode IS NULL OR barcode ~ '^[!-~]{1,48}$');
ALTER TABLE awcms_commerce_product_variants
  DROP CONSTRAINT IF EXISTS awcms_commerce_product_variants_barcode_check;
ALTER TABLE awcms_commerce_product_variants
  ADD CONSTRAINT awcms_commerce_product_variants_barcode_check
  CHECK (barcode IS NULL OR barcode ~ '^[!-~]{1,48}$');

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_products_tenant_barcode_key
  ON awcms_commerce_products (tenant_id, barcode)
  WHERE deleted_at IS NULL AND barcode IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_product_variants_tenant_barcode_key
  ON awcms_commerce_product_variants (tenant_id, barcode)
  WHERE deleted_at IS NULL AND barcode IS NOT NULL;

CREATE OR REPLACE FUNCTION awcms_commerce_barcode_cross_guard()
RETURNS trigger AS $awcms_commerce_barcode_cross_guard$
DECLARE
  clash boolean;
BEGIN
  IF NEW.barcode IS NULL OR NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
    AND NEW.barcode IS NOT DISTINCT FROM OLD.barcode
    AND OLD.deleted_at IS NULL
  THEN
    RETURN NEW;
  END IF;

  -- Serialise concurrent writers of the same (tenant, code) across BOTH
  -- tables; released at commit/rollback. The key is STRIPED over 256 values,
  -- not one lock per code: an advisory lock occupies a slot of the shared lock
  -- table until the transaction ends, so a bulk load of N barcoded rows in one
  -- transaction would otherwise need N slots and die with "out of shared
  -- memory" (found by the 20,000-row integration test). Re-taking a lock the
  -- transaction already holds costs nothing, so a bulk load needs at most 256.
  -- The price is that two writers of DIFFERENT codes on the same stripe
  -- briefly queue; both transactions are short.
  PERFORM pg_advisory_xact_lock(
    918292,
    (hashtextextended(NEW.tenant_id::text || ':' || NEW.barcode, 0) & 255)::int
  );

  IF TG_TABLE_NAME = 'awcms_commerce_products' THEN
    SELECT EXISTS (
      SELECT 1 FROM awcms_commerce_product_variants
      WHERE tenant_id = NEW.tenant_id AND barcode = NEW.barcode
        AND deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM awcms_commerce_products
      WHERE tenant_id = NEW.tenant_id AND barcode = NEW.barcode
        AND deleted_at IS NULL AND id <> NEW.id
    ) INTO clash;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM awcms_commerce_products
      WHERE tenant_id = NEW.tenant_id AND barcode = NEW.barcode
        AND deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM awcms_commerce_product_variants
      WHERE tenant_id = NEW.tenant_id AND barcode = NEW.barcode
        AND deleted_at IS NULL AND id <> NEW.id
    ) INTO clash;
  END IF;

  IF clash THEN
    IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL THEN
      -- A restore whose code was reused meanwhile: come back un-barcoded.
      NEW.barcode := NULL;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'barcode already used by another live product or variant of this tenant'
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'awcms_commerce_barcode_cross_table_key';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_barcode_cross_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_products_barcode_guard
  ON awcms_commerce_products;
CREATE TRIGGER awcms_commerce_products_barcode_guard
  BEFORE INSERT OR UPDATE ON awcms_commerce_products
  FOR EACH ROW EXECUTE FUNCTION awcms_commerce_barcode_cross_guard();

DROP TRIGGER IF EXISTS awcms_commerce_product_variants_barcode_guard
  ON awcms_commerce_product_variants;
CREATE TRIGGER awcms_commerce_product_variants_barcode_guard
  BEFORE INSERT OR UPDATE ON awcms_commerce_product_variants
  FOR EACH ROW EXECUTE FUNCTION awcms_commerce_barcode_cross_guard();
