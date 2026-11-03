---
bump: minor
type: content
impact: public
---

# Front desk: check-in, check-out and balance collection at the till

Issue #388 (epic #280, item 16; UX surface D). The POS booking API of #383 had no screen. `/admin/commerce-pos` now has a **Front desk** tab (`?tab=front-desk`) that finds a reservation by its code together with the customer's phone or e-mail, shows the reservation card with the server's total, paid so far and balance due, collects the balance with split tenders and a change preview, and checks the guest in and out. No server code, route, permission or migration changed.

- **The check-in policy is followed, not decided.** The tab reads the lookup card's own `policy` and `actions.checkInBlockedReason` (the tenant setting `checkinRequiresSettlement` of #383, default block): with a balance owed and the default, **Check in guest** is `aria-disabled` with the reason beside it; there is no override control. The default stays pending the owner's confirmation (PR #443, residual R3).
- **Why a separate tab and not new POS screens:** it is the same register session, tender planner and ledger as the sale screen, so a balance taken here lands in the shift's cash-up; a second screen family would have meant a second place to keep those rules.
- **Keyboard and assistive technology.** Keyboard-only from the first field (a scanner's Enter moves from the code to the contact), the sale screen's shortcut map reused, focus moved on purpose after every outcome, refused values `aria-invalid` and tied to their message, unavailable controls `aria-disabled` with a visible reason, no browser dialogs, labels that contain their visible text. Layout verified at 360px and 1280px in both themes by a Playwright spec that runs on the trusted host's e2e legs.
- **No browser persistence of a lookup.** The card and the typed contact live in memory only; the contact field is emptied once the card shows. There is no arrivals list and no search, as the lookup control requires.
- **Cost.** The tab's script is a separate chunk loaded only on that tab. `APP_BUDGET_BYTES` rises; the measurement is in the constant's docblock. `AGENTS.md`'s divergence line needs the new figure at integration.
- Strings are in `locales/en.po` and `locales/id.po` (69 new); the three till permission keys left the admin screen coverage ledger's `NOT_YET_SCREENED` list.
