---
bump: patch
type: fix
impact: internal
---

# Tests for unknown gateway and refund outcomes

Issue #564 adds deterministic failure tests on real PostgreSQL (two tenants, FORCE RLS) for payment-gateway session creation, status polling, webhook settlement and gateway refunds, with zero-double-financial-effect invariants: timeouts before and after provider acceptance, lost acknowledgements, 429/5xx/malformed answers, concurrent duplicates, late paid webhooks after expiry, reordered and duplicate events, a crash after a refund provider accepted, and cross-tenant denial. No production code changes.

- `apps/cms/tests/support/fake-payment-gateway.ts` is a stateful fake provider that remembers what it did, so a test can tell "the caller saw a failure" from "the provider did nothing".
- Four reproduced cases (three defects) are recorded as skipped tests (`RUN_KNOWN_DEFECTS=1` runs them) and reported on the issue, not fixed here: a provider-paid session is expired without asking the provider, a late `pending` webhook regresses a paid session (blocking a balance session), and the Midtrans adapter books a `202 Refund denied by the bank` refund as succeeded.
- `docs/pengujian.md` (and its Indonesian mirror) gains a short section on running them.
