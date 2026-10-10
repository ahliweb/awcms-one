---
bump: patch
type: docs
impact: internal
---

# ADR-0041: gateway deposit sessions and mixed tenders on one order

Docs only (ADR-0040 D7): no code, migration or OpenAPI path. Resolves issue #353, cross-spec finding X2 and threat-model control C-07, and revisits the ADR-0025 D7 deferral.

- Each gateway session will carry a server-computed `expected_amount` and a `purpose` (`full`, `deposit`, `balance`), and the amount guard compares the provider figure to it in integer cents; whole-total orders keep exactly today's guard and behaviour.
- Deposit policy is per product (percentage or fixed, unset = full payment, no tenant default); points earn only at full settlement on deposit orders; points and a deposit cannot be combined and rental security deposits are out of v1 (owner answers Q2, Q3, Q5, Q8).
- The order keeps `dp_paid` with an explicit balance due between the deposit and the balance.
