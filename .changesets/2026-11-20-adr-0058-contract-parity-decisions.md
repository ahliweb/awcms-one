---
bump: patch
type: docs
impact: internal
---

# ADR-0058: owner decisions on contract parity (issue #547 follow-up)

Adds ADR-0058 (with its Indonesian mirror and index rows) recording the owner's decisions of 20 November 2026: fixtures plus a schema check first, the storefront consumer-contract slice at the root `tests/` rather than in the `apps/cms` subtree, and `429 RATE_LIMITED` plus the optional idempotency header reported upstream (ahliweb/awcms#1385) instead of patched locally. Section 8.1 of the audit report now points at the ADR.

The "why": the slice location and the upstream routing decide which repository carries the cost at every subtree sync, and a later reader should find that reasoning in one place. Backlog issues #553 to #557 exist and wait for gate 9; no code, schema, workflow or test changed.
