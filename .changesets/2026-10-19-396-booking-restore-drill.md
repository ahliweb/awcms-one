---
bump: minor
type: content
impact: public
---

# Booking adapter: post-restore reconciliation for the restore drill (issue #396, ADR-0045)

An operator can now prove, after restoring a backup, that the booking-commerce adapter came back intact. `bun run commerce:booking:reconcile` is a **read-only** CLI (no migration, route, permission or event; a tenant that never enabled `booking` sees nothing) to run against a restored database as the owner role or `awcms_app`. It exits 0 only on zero drift.

- **What it checks:** the adapter tables kept FORCE row-level security, their tenant-isolation policy, guard trigger and unique indexes (upstream's drill only asserts that some table has FORCE RLS); the zero-or-two-references reconciliation between reservation links and orders (threat control C-38: every active link's reservation names the order back, no link on a rescheduled reservation, no live reservation naming an order without a link, no order named twice); the existing C-09 settlement-versus-reservation comparison (a finding already in the operator queue, with an open attention flag, is reported and not failed); and booking refund decisions versus refund legs (order and return ownership, legs never above the decision, a completed return settled at least the decision).
- **Operators:** upstream's `restore-drill.sh` drops its scratch database before anything can query it and is not edited here, so the adapter half runs between `restore-postgres.sh --keep` and the drop; `--evidence-log <path>` appends one counts-only JSON line to the same `restore-drill-evidence.jsonl`, and `--require-links` fails a database with no reservation link (a drill that checked nothing). The commands are in `docs/deployment.md` ("Booking adapter restore drill"). Not for `awcms_worker`, which Booking gives no read of reservations.
- **Developers:** `BOOKING_RESTORE_EXTENSION_CHECKS` is the empty extension point the cancellation issue (#381) registers its own post-restore checks in. No refund decision exists until then, so that check is in place and returns nothing on today's data.

Docs: `docs/deployment.md` (+ Indonesian mirror), ADR-0045 implementation notes, `docs/status.md`, the commerce README.
