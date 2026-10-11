-- Issue #363 (ADR-0043) - what `awcms_worker` needs for loyalty redemption.
--
-- `awcms_worker` runs the order-expiry job (`orders:expire`), which moves an
-- unpaid order to `expired` and, in the same transaction, gives back any
-- points that order had spent (`restore` row on the points ledger, a table the
-- worker can already INSERT into since sql/951). Finding those points needs to
-- read the redemption record, hence SELECT. DELETE is the generic
-- data-lifecycle engine's retention purge (`commerce.loyalty_redemptions`
-- descriptor, `commerce/module.ts`); there is no UPDATE - the table is
-- write-once (sql/1010).
--
-- The settings table (the tenant's point value) is read and written only by
-- request-time roles; the worker holds SELECT, DELETE on it for the retention
-- purge alone (`commerce.loyalty_redemption_settings` descriptor).
GRANT SELECT, DELETE ON awcms_commerce_loyalty_redemptions TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_loyalty_redemption_settings TO awcms_worker;
