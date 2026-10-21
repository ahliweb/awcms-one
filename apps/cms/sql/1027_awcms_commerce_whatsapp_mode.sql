-- Commerce's per-tenant WhatsApp delivery mode (Issue #392, ADR-0133 section 6
-- phase 2, downstream ADR-0045). ONE file, one column pair, no table, no data
-- movement. It depends only on `awcms_commerce_store_settings` (sql/9xx), so by
-- ADR-0037 D2 it is safe at `1027` whatever order a fresh or an already-migrated
-- database applies it in.
--
-- ## The mode lives in COLUMNS, not in the settings jsonb
--
-- The same reasoning as `inventory_mode` (`sql/947`): `settings` is a jsonb blob
-- the owner replaces wholesale (`PUT`) or resets (`DELETE` stamps
-- `deleted_at`), and a "reset my store to defaults" must never move a tenant
-- from one WhatsApp queue to the other. The settings upsert never names these
-- two columns, and the readers (`application/whatsapp-mode.ts`) ignore
-- `deleted_at` on this row.
--
--   * `whatsapp_mode`: `legacy` (the default: `enqueueWhatsappMessage` writes
--     `awcms_commerce_whatsapp_messages`, byte-for-byte what it did before this
--     column existed) or `upstream` (it calls the `whatsapp_delivery` port and
--     the message enters `awcms_whatsapp_messages`).
--   * `whatsapp_mode_changed_at`: when the mode last changed; null until it has.
--
-- A tenant with no `store_settings` row at all is `legacy`. This migration only
-- adds the columns: it changes no existing row's behaviour, copies no message and
-- writes no new row. The guarded flip (refuse while the legacy queue holds a
-- non-terminal row) and the drain report are issue #393; until then a tenant
-- stays `legacy` unless an operator sets the column by hand.
ALTER TABLE awcms_commerce_store_settings
  ADD COLUMN IF NOT EXISTS whatsapp_mode text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS whatsapp_mode_changed_at timestamptz;

ALTER TABLE awcms_commerce_store_settings
  ADD CONSTRAINT awcms_commerce_store_settings_whatsapp_mode_check
    CHECK (whatsapp_mode IN ('legacy', 'upstream'));

COMMENT ON COLUMN awcms_commerce_store_settings.whatsapp_mode IS
  'Issue #392 / ADR-0133 section 6 — legacy (new WhatsApp messages go to awcms_commerce_whatsapp_messages) or upstream (they go to the whatsapp_delivery queue through WhatsappDeliveryPort). A tenant is in exactly one mode at a time; the guarded flip is issue #393.';
COMMENT ON COLUMN awcms_commerce_store_settings.whatsapp_mode_changed_at IS
  'Issue #392 — when whatsapp_mode last changed; null until it has.';
