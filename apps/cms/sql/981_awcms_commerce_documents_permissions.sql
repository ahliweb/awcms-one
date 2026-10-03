-- Issue #286 (ADR-0029) — permission catalog seed for the commerce document
-- lifecycle (held sales, quotations, work orders, receipt/invoice documents),
-- mirroring `src/modules/commerce/module.ts`'s `permissions` array exactly (see
-- `sql/902`'s header for the reasoning this migration does not repeat: global
-- catalog, idempotent via `ON CONFLICT DO NOTHING`, existing tenants do not
-- retroactively gain these).
--
-- Deliberately SEPARATE, resource-split keys, each with its own enforcing
-- route, so that ringing up a sale (`commerce.pos.create`) grants none of them
-- and so that holding a cart, quoting, running a work order, issuing a legal
-- document and creating an order from a quote are five different authorities:
--
--   * `commerce.held_sales.{read,create,update}` — park / list / resume or
--     discard YOUR OWN held carts; `approve` is the supervisor override that
--     lets a holder see, resume or discard ANOTHER cashier's (a high-risk verb,
--     so a tenant may author SoD rules against it).
--   * `commerce.quotations.{read,create,update}` — read; create or revise;
--     send / accept / reject / cancel.
--   * `commerce.quotation_conversions.create` — convert an accepted quotation
--     into a commerce order (creates an order: its own key).
--   * `commerce.work_orders.{read,create,update}` — read; create; move through
--     the status machine / reassign.
--   * `commerce.documents.{read,create}` — read and render (print) a document;
--     ISSUE a numbered receipt or invoice (a legal-grade, irreversible act).
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'held_sales', 'read', 'List your own held sales (Issue #286)'),
  ('commerce', 'held_sales', 'create', 'Hold (park) a POS cart as a held sale (Issue #286)'),
  ('commerce', 'held_sales', 'update', 'Resume or discard your own held sale (Issue #286)'),
  ('commerce', 'held_sales', 'approve', 'See, resume or discard another cashier''s held sale (Issue #286)'),
  ('commerce', 'quotations', 'read', 'List and read quotations and their versions (Issue #286)'),
  ('commerce', 'quotations', 'create', 'Create a quotation or add a revised version (Issue #286)'),
  ('commerce', 'quotations', 'update', 'Send, accept, reject or cancel a quotation (Issue #286)'),
  ('commerce', 'quotation_conversions', 'create', 'Convert an accepted quotation into a commerce order (Issue #286)'),
  ('commerce', 'work_orders', 'read', 'List and read work orders and their status history (Issue #286)'),
  ('commerce', 'work_orders', 'create', 'Create a work order, optionally from an accepted quotation (Issue #286)'),
  ('commerce', 'work_orders', 'update', 'Move a work order through its status machine or reassign it (Issue #286)'),
  ('commerce', 'documents', 'read', 'List, read and render (print) receipt and invoice documents (Issue #286)'),
  ('commerce', 'documents', 'create', 'Issue a numbered receipt or invoice document for a finalized order (Issue #286)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
