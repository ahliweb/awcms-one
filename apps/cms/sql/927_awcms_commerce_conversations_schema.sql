-- Issue #111 (part of epic #33 C4, contract #106 D8) — the commerce inbox: a
-- customer account's own thread with the store, and its messages. Two new
-- tenant-scoped tables, following `sql/901`'s conventions exactly (see that
-- file's header for the full reasoning this migration does not repeat):
-- `ENABLE` + `FORCE ROW LEVEL SECURITY`, one tenant-isolation `USING` policy,
-- `id uuid` PK `DEFAULT gen_random_uuid()`, `created_at`/`updated_at
-- timestamptz DEFAULT now()`, no per-table GRANT (`sql/019`'s `ALTER DEFAULT
-- PRIVILEGES` already covers `awcms_app`), an FK index for every FK column.
--
-- ## `awcms_commerce_conversations`
--
-- ONE row per thread, owned by exactly one `awcms_commerce_customer_accounts`
-- row (Issue #87/#89) — an inbox thread requires a verified account, unlike
-- guest checkout, matching #106 D8's own "customer account <-> store"
-- framing. `subject` (1-150 chars) is set once, at open time, and never
-- edited. `status` is the two-state open/closed machine `application/
-- conversation-directory.ts`'s `closeConversation`/`reopenConversation`
-- enforce — a CUSTOMER can never reopen a closed thread themselves (only
-- post to an OPEN one), a STORE reply implicitly reopens (its own
-- `application` function flips `status` back to `open` as part of the same
-- statement that inserts the reply). `last_message_at` is a denormalized
-- copy of the newest message's `created_at`, kept in the SAME transaction as
-- every insert into `awcms_commerce_messages` below — the account's own
-- list view (`GET .../account/conversations`) and the staff list
-- (`GET /api/v1/commerce/conversations`) both order by it, and deriving it
-- with a join on every list page would cost one extra scan per row for a
-- value that changes exactly once per message.
--
-- `unread_for_customer`/`unread_for_store` are independent booleans, not a
-- shared counter: `unread_for_store` flips true on every CUSTOMER message
-- and false the moment staff reads the thread
-- (`GET /api/v1/commerce/conversations/{id}`); `unread_for_customer` flips
-- true on every STORE reply and false the moment the customer reads the
-- thread (`GET .../account/conversations/{id}`) — the storefront's own
-- `Percakapan.unreadForCustomer` contract field
-- (`apps/storefront/src/lib/akun-klien.ts`) is a NUMBER only because it
-- travels as 0|1 over the wire, never a genuine multi-message count; the
-- column itself is a plain boolean, which is both simpler and matches this
-- issue's own schema description exactly.
--
-- `deleted_at` exists for lifecycle-descriptor symmetry with every other
-- table in this module (`module.ts`'s `dataLifecycle` array), even though
-- this increment ships no admin route that ever sets it — the same
-- "declared, unreachable in practice" shape `commerce.categories`/
-- `commerce.products` already have for a live row (see this module's own
-- `dataLifecycle` header comment).
--
-- ## `awcms_commerce_messages`
--
-- Append-only, like `awcms_commerce_order_events` (sql/913's header) — no
-- `deleted_at`, no `updated_at`: a message, once sent, is never edited or
-- retracted. `sender` is `customer`/`store`; `sender_tenant_user_id` is set
-- only for a `store` message (which tenant_user actually typed the reply,
-- for the admin screen's own attribution and the audit trail) and is always
-- `NULL` for a `customer` message — a customer has no `tenant_user_id` at
-- all (ADR-0016 D1), the same "no such column to point at" reasoning
-- `commerce.customer_accounts`'s own `subjectData` entry already gives.
-- `body` is 1-4000 chars, enforced again at the database boundary the same
-- way `awcms_commerce_reviews.body` is (belt-and-suspenders on top of
-- `domain/conversation-validation.ts`'s own check).

CREATE TABLE IF NOT EXISTS awcms_commerce_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  account_id uuid NOT NULL REFERENCES awcms_commerce_customer_accounts (id),
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  unread_for_store boolean NOT NULL DEFAULT true,
  unread_for_customer boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_conversations_status_check
    CHECK (status IN ('open', 'closed')),
  CONSTRAINT awcms_commerce_conversations_subject_length_check
    CHECK (char_length(subject) BETWEEN 1 AND 150)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_conversations_tenant_idx
  ON awcms_commerce_conversations (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_conversations_tenant_deleted_idx
  ON awcms_commerce_conversations (tenant_id, deleted_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_conversations_account_idx
  ON awcms_commerce_conversations (account_id, last_message_at DESC);

-- `GET .../account/conversations?cursor=`'s own keyset scan, newest-activity-first.
CREATE INDEX IF NOT EXISTS awcms_commerce_conversations_account_last_message_idx
  ON awcms_commerce_conversations (tenant_id, account_id, last_message_at DESC)
  WHERE deleted_at IS NULL;

-- `GET /api/v1/commerce/conversations?status=&unread=`'s own staff list scan.
CREATE INDEX IF NOT EXISTS awcms_commerce_conversations_tenant_last_message_idx
  ON awcms_commerce_conversations (tenant_id, last_message_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_conversations_tenant_status_idx
  ON awcms_commerce_conversations (tenant_id, status, last_message_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_conversations_tenant_unread_store_idx
  ON awcms_commerce_conversations (tenant_id, unread_for_store, last_message_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE awcms_commerce_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_conversations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_conversations_tenant_isolation
  ON awcms_commerce_conversations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE TABLE IF NOT EXISTS awcms_commerce_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  conversation_id uuid NOT NULL REFERENCES awcms_commerce_conversations (id),
  sender text NOT NULL,
  sender_tenant_user_id uuid,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_messages_sender_check
    CHECK (sender IN ('customer', 'store')),
  CONSTRAINT awcms_commerce_messages_body_length_check
    CHECK (char_length(body) BETWEEN 1 AND 4000),
  CONSTRAINT awcms_commerce_messages_sender_tenant_user_check
    CHECK (
      (sender = 'store' AND sender_tenant_user_id IS NOT NULL)
      OR (sender = 'customer' AND sender_tenant_user_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS awcms_commerce_messages_tenant_idx
  ON awcms_commerce_messages (tenant_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_messages_tenant_created_idx
  ON awcms_commerce_messages (tenant_id, created_at DESC);

-- A thread's own transcript read, oldest first.
CREATE INDEX IF NOT EXISTS awcms_commerce_messages_conversation_idx
  ON awcms_commerce_messages (conversation_id, created_at ASC);

ALTER TABLE awcms_commerce_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_messages_tenant_isolation
  ON awcms_commerce_messages
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- `module.ts`'s `commerce.conversations`/`commerce.messages` `dataLifecycle`
-- descriptors both declare `executionMode: "generic"` — see `sql/915`'s/
-- `sql/918`'s header for the identical reasoning (`awcms_worker` gets
-- nothing by default, `sql/019`'s `ALTER DEFAULT PRIVILEGES` only ever
-- covered `awcms_app`).
GRANT SELECT, DELETE ON awcms_commerce_conversations TO awcms_worker;
GRANT SELECT, DELETE ON awcms_commerce_messages TO awcms_worker;

COMMENT ON TABLE awcms_commerce_conversations IS
  'Issue #111 (contract #106 D8) — one thread per (tenant, customer account); last_message_at/unread_for_store/unread_for_customer are denormalized and kept in step with awcms_commerce_messages inside the same transaction as every insert.';
COMMENT ON TABLE awcms_commerce_messages IS
  'Issue #111 (contract #106 D8) — append-only transcript of a conversation; sender_tenant_user_id is set for a store message only.';
