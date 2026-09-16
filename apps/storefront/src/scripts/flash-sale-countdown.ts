/**
 * A generic flash-sale countdown, shared by the home page's flash-sale
 * strip, `/flash-sale`, and a product detail page currently in one.
 *
 * DOM contract: any element `[data-countdown][data-ends-at="<ISO>"]` gets
 * its text content replaced with the remaining time, re-computed every
 * `UPDATE_INTERVAL_MS`. The element (or a page that wants finer control)
 * should carry `aria-live="polite"` ITSELF in markup — this script never
 * sets ARIA attributes, only text — and `UPDATE_INTERVAL_MS` is deliberately
 * coarser than one second so a screen reader announces the countdown at
 * roughly minute granularity (issue #27's own accessibility bullet), not on
 * every tick.
 *
 * When an item's time is up, its nearest `[data-flash-sale-item]` ancestor
 * is hidden (`el.hidden = true`) — "the strip hides itself after `ends_at`
 * without a rebuild" (issue #27) — rather than the countdown text alone
 * changing to something like "Berakhir" and the stale card staying visible.
 */

const UPDATE_INTERVAL_MS = 30_000;

function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return "Berakhir";

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} hari`);
  if (days > 0 || hours > 0) parts.push(`${hours} jam`);
  parts.push(`${minutes} menit`);

  return `${parts.join(" ")} lagi`;
}

function tick(): void {
  const now = Date.now();

  for (const el of document.querySelectorAll<HTMLElement>("[data-countdown][data-ends-at]")) {
    const endsAt = el.dataset.endsAt;
    if (!endsAt) continue;

    const end = Date.parse(endsAt);
    if (Number.isNaN(end)) continue;

    const remaining = end - now;
    el.textContent = formatRemaining(remaining);

    if (remaining <= 0) {
      el.closest<HTMLElement>("[data-flash-sale-item]")?.setAttribute("hidden", "");
    }
  }
}

tick();
setInterval(tick, UPDATE_INTERVAL_MS);
