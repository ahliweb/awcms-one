---
"awcms": minor
---

feat(commerce): POS registers, register sessions, drawer movements and cash-up reconciliation (Issue #284, epic #281)

New tables `awcms_commerce_registers`, `awcms_commerce_register_sessions`, `awcms_commerce_register_movements`, `awcms_commerce_register_close_requests`, `awcms_commerce_register_close_lines`, `awcms_commerce_register_corrections` (`sql/970` schema + triggers + REVOKEs, `sql/971` the `register_session_id` stamp on `awcms_commerce_orders` and `awcms_commerce_payment_allocations`, `sql/972` ten permissions, `sql/973` worker purge grants; `974` held). One active (open/closing) session per register (partial unique index + register-row lock); append-only movements; a close request per attempt with per-tender expected/counted/variance lines; a closed session frozen by trigger and amended only by compensating corrections (`corrected`).

The expected closing amount per tender is derived from the payment-allocation ledger legs stamped with the session (never a time window — a leg's `created_at` is its transaction start) plus drawer movements for cash; the cash-up never rewrites a sale or a payment. Session-row lock modes: `FOR SHARE` for a sale/movement/stamped leg, `FOR NO KEY UPDATE` for handover/close/approve/correct (not `FOR UPDATE`, which deadlocks against FK key-share inserts — the ADR-0025 lesson); every session-scoped mutation locks first and reads the idempotency store after.

New endpoints (all behind the `register` feature flag, default OFF → `409 FEATURE_DISABLED`; every mutation requires `Idempotency-Key`):

- `GET`/`POST /api/v1/commerce/registers`, `GET`/`PATCH .../registers/{id}` (`commerce.registers.{read,create,update}`)
- `GET`/`POST /api/v1/commerce/register-sessions` (read / open — `commerce.register_sessions.{read,create}`), `GET .../register-sessions/{id}` (the cash-up report)
- `POST .../register-sessions/{id}/movements` and `/handover` (`commerce.register_sessions.update`; handover by the current cashier or a holder of `commerce.register_cash_ups.approve`)
- `POST .../register-sessions/{id}/close` (`commerce.register_cash_ups.create`; gross variance above `cashUp.approvalThreshold` leaves the session `closing` unless the closer also holds the approve key), `POST .../close-decision` (`commerce.register_cash_ups.approve`), `POST .../corrections` (`commerce.register_corrections.approve`), `GET .../report.csv` (`commerce.register_sessions.export`, formula-neutralised)

`POST /api/v1/commerce/pos/orders` accepts `registerId` (required while the feature is on; refused with `409 FEATURE_DISABLED` while off — a pre-existing payload hashes and replays exactly as before) and returns `registerSessionId`. Events `awcms.commerce.register_session.{opened,movement_recorded,closed,corrected}` on the session aggregate (registered in `module.ts`, the event-type registry and AsyncAPI). `dataLifecycle`/`subjectData` descriptors for all six tables (`domain/register-lifecycle.ts`). Admin: `/admin/commerce-registers`, `/admin/commerce-registers/{id}`, a register banner on the POS screen, a "POS registers and cash-up" toggle in the commerce Features section.
