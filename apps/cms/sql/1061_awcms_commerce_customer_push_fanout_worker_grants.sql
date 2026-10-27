-- Issue #432 (ADR-0048 sections 3.5, 5.4 to 5.6) - the worker grants the
-- customer-push fan-out needs, and the narrowing of the one grant #430 left
-- wider than any statement uses.
--
-- ## Why the worker INSERTs messages
--
-- The domain-event consumer that turns an order, payment, refund, return or
-- store-reply event into outbox rows (`commerce.customer_push_enqueuer`) runs
-- inside `domain-events:dispatch`, which connects as `awcms_worker` (the
-- runtime's delivery transaction is the worker's). sql/1058 deliberately gave
-- the worker no INSERT on `awcms_commerce_push_messages` ("the consumers that
-- enqueue run in the domain-event runtime and are mapped by #432"); this is that
-- mapping.
--
-- ## Column-only INSERT
--
-- The grant names the thirteen columns an enqueue supplies. Every other column
-- keeps its column default, so a compromised worker cannot insert a row that is
-- already `sent`, carries a `retry_count`, a `provider_message_id` or a lease. It
-- CAN insert a queued row for any device of the tenant with any text; that is
-- bounded by the other layers, not by this grant: the CHECKs (purpose list,
-- fixed-shape target path, 120/240 character text), the composite foreign keys
-- (a row names a real account and a real device of the SAME tenant) and, above
-- all, the dispatcher's send-time checks, which refuse a row whose text is not
-- one of the six catalogue strings, whose path is not the purpose's fixed path,
-- or whose account is not the device's current account (ADR-0048 I5, I6).
--
-- ## Column-only UPDATE (narrowing sql/1058)
--
-- sql/1058 granted `UPDATE` on the whole table because #430 did not yet know
-- which columns the dispatcher writes. #432 does: the status machine (`status`,
-- `retry_count`, `next_attempt_at`, `last_error`), the provider result
-- (`provider_name`, `provider_message_id`, `sent_at`) and `updated_at`. Nothing
-- in the worker ever rewrites `account_id`, `device_id`, `purpose`, `title`,
-- `body`, `target_path`, `tag`, `dedupe_key`, `source_event_id`, `event_type`,
-- `priority` or `expires_at` after the insert, so a worker that could (and so
-- could redirect an existing message to another account, device or text) is
-- exactly the lesson sql/1058 and upstream's sql/314 record for subscriptions.
-- `SELECT ... FOR UPDATE` (the claim) needs UPDATE on at least one column, which
-- the list below satisfies.
--
-- `DELETE` (the 30-day purge) and `SELECT` are unchanged. The attempts ledger
-- keeps `SELECT, INSERT, DELETE` (sql/1058): the dispatcher records every attempt.

GRANT INSERT (
  tenant_id, account_id, device_id, source_event_id, event_type, purpose,
  priority, tag, dedupe_key, title, body, target_path, expires_at
) ON awcms_commerce_push_messages TO awcms_worker;

REVOKE UPDATE ON awcms_commerce_push_messages FROM awcms_worker;
GRANT UPDATE (
  status, retry_count, next_attempt_at, last_error, provider_name,
  provider_message_id, sent_at, updated_at
) ON awcms_commerce_push_messages TO awcms_worker;
