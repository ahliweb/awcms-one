---
bump: patch
type: fix
impact: internal
---

# Commerce admin screens adopt upstream's single-flight guard for direct submits

The #1225 sync brought the shared single-flight guard of `admin-form-client.ts` (`onSubmit`, `onAction`) and a source contract (`tests/single-flight-source-contract.test.ts`) that fails when a page script attaches its own `submit` listener or its own mutating `click` handler. Nine `commerce` bindings were outside it. They now go through the helpers: the booking override and reschedule dialogs (with `holdForNavigation()` before their reload), the order payment and reversal forms, the POS checkout form and its hold and resume buttons, the store settings and feature-toggle forms, the barcode save button of the labels screen, the catalog import Validate button, the returns wizard submit and provider-refund buttons, the products bulk-action buttons, and the front-desk lookup, balance and check-in/check-out controls.

- Two local allow-list entries in `apps/cms/scripts/lib/single-flight-audit.ts` (a divergence from upstream's file, listed in `AGENTS.md`): the front-desk island's two keydown listeners (they only call `doLookup`, which its own `busy` flag guards) and the catalog import Apply button (the handler leaves it disabled once the reviewed file is spent, which the shared release would undo; one `Idempotency-Key` and `expectedSha256` per review make a repeat replay).
- `commerce`'s `WhatsappNotQueuedReason` gains the three sender-aware refusals of upstream's `WhatsappDeliveryPort` 1.1.0 (`SENDER_UNAVAILABLE`, `SENDER_AFFINITY_CONFLICT`, `REPLY_TARGET_UNKNOWN`), mapped to `TEMPLATE_UNAVAILABLE` for a document delivery. Commerce passes no sender fields, so it does not receive them today; without the three the adapter no longer typechecked.
- The audit tables `docs/awcms/ui-single-flight-audit.md` (+ `.id.md`) were regenerated.
