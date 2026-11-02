---
bump: minor
type: content
impact: public
---

# The commerce commission adapter is live through `hr_commission`'s intake queue (#391)

The adapter that reports a paid counter (POS) sale to `hr_commission` and reverses it on cancel or refund shipped dormant (#451, `sql/1053`) because the worker that runs event consumers may not touch payroll tables. Upstream's intake queue (ADR-0147) is the sanctioned path, so the three consumers are registered again and now **submit** to `CommissionIntakePort`; the job `hr-commission:intents:post`, running as `awcms_app`, posts. No grant on any `awcms_hr_*` table is re-issued, and the one local entry in the payroll sensitive-read registry is removed.

- **Behaviour.** `queued` is recorded, not accrued; a business refusal (no rule, closed period, source conflict) appears only in `GET /api/v1/hr-commission/intake/exceptions`. Commerce keeps its own insert-only record of what it submitted, `awcms_commerce_commission_submissions` (`sql/1063`, ids and codes only, no amount, no person), and voids exactly those lines. Audit actions are now `commerce.commission.submitted`, `.attribution_rejected`, `.reversal_submitted` and `.reversal_needs_attention`; `.attributed`, `.attribution_refused` and `.reversed` are no longer written.
- **Unavailable intake.** Intake switched off or full fails the delivery (rolled back, retried with the runtime back-off, then a replayable dead letter) instead of dropping the sale; a malformed request is audited and not retried; a cancel or refund with no person cannot be submitted and is audited for a human.
- **API.** `PUT /api/v1/commerce/commission/settings` no longer answers `409 COMMISSION_ADAPTER_DORMANT`; `GET` and `PUT` return `readiness` (`state`, `hrCommissionModuleEnabled`, `lastSubmittedAt`).
- **Operator.** Switch `hr_commission` on, then its commission intake with a system actor (`PUT /api/v1/hr-commission/intake/settings`), publish a rule and link the cashiers, and only then enable the commerce setting. `commerce` now consumes the `commission_intake` capability instead of `commission_accrual`. Under `compose.production.yaml` the poster job must connect as `awcms_app`, not the worker (see `docs/deployment.md`).
