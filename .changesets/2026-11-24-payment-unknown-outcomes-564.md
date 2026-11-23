---
bump: patch
type: fix
impact: public
---

# Tests for unknown gateway and refund outcomes

Issue #564 adds deterministic failure tests on real PostgreSQL (two tenants, FORCE RLS) for payment-gateway session creation, status polling, webhook settlement and gateway refunds, with zero-double-financial-effect invariants: timeouts before and after provider acceptance, lost acknowledgements, 429/5xx/malformed answers, concurrent duplicates, late paid webhooks after expiry, reordered and duplicate events, a crash after a refund provider accepted, and cross-tenant denial. One production fix: a Midtrans refund answered with `status_code` "202" ("Refund denied by the bank") was booked as succeeded, settling the refund leg and reversing the ledger for money the customer never received; now only "200" is succeeded, "201" pending, and every other code a failure.

- `apps/cms/tests/support/fake-payment-gateway.ts` is a stateful fake provider that remembers what it did, so a test can tell "the caller saw a failure" from "the provider did nothing".
- The Midtrans refund mapping fix (case K4) is covered by an active regression test. Three further reproduced cases are recorded as skipped tests (`RUN_KNOWN_DEFECTS=1` runs them) with follow-up issues, not fixed here: a provider-paid session is expired without asking the provider (K1), and a late `pending` webhook regresses a paid session, blocking a balance session (K2, K3).
- `docs/pengujian.md` (and its Indonesian mirror) gains a short section on running them.
