---
bump: patch
type: structure
impact: internal
---

# apps/cms synced from ahliweb/awcms main at ad35d12f

A documentation-only sync, still AWCMS v10.7.0. It brings ADR-0135, which admits day-granularity (nightly) stays into Booking v1 as the owner asked for the hotel/villa/rental vertical (ahliweb/awcms#931), and the booking and hr_payroll design packs with the awcms-one owner answers O4–O12 recorded (ahliweb/awcms#932). Both unblock the epic #280 DoR documents that depended on #931.

- No code, migration, OpenAPI or permission change in `apps/cms`.
- The only conflicts were the generated counts in `PROJECT_STATE.md` and `repo-inventory.md`, regenerated.
