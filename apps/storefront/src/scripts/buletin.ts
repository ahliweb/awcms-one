/**
 * Newsletter double opt-in (issue #50) — the subscribe form (`/buletin`,
 * and since issue #49 the news sidebar's and footer's boxes on every news
 * page) and the two token pages (`/newsletter/confirm`,
 * `/newsletter/unsubscribe` — a fixed apps/cms contract, not this app's own
 * naming; see the README) it links to from an e-mail. Wires up whichever
 * `[data-buletin-*]` roots the current page actually has — EVERY subscribe
 * form, not just the first (see `wireBuletinForms`) — the same
 * one-script-many-guarded-roots shape `checkout.ts`/`keranjang.ts` use, so
 * this file can be imported unchanged from every page that mounts it.
 *
 * ## Why this does not extend `src/lib/toko-klien.ts`
 *
 * That file is deliberately scoped to ONE base path —
 * `/api/v1/commerce/storefront/*` (its own docblock: "the ONLY file that
 * talks to" that prefix) — and is issue #30's file, outside this issue's
 * ownership. The newsletter endpoints live under a different base path
 * (`/api/v1/newsletter/*`) on the SAME CMS origin, so this file re-implements
 * `toko-klien.ts`'s own request contract byte-for-byte (`mode: "cors"`,
 * `credentials: "omit"`, the single `Content-Type` header, one error type
 * wrapping the envelope) against `apps/cms/src/pages/api/v1/newsletter/
 * {subscribe,confirm,unsubscribe}.ts` directly, rather than either widening
 * `toko-klien.ts` past its own documented scope or duplicating a second
 * cross-origin policy with different rules. `requireAwcmsOrigin()`
 * (`src/lib/awcms/toko-origin.ts`) — the one piece both files genuinely
 * share — is imported, not re-derived.
 *
 * ## Every user-facing string here is written by THIS file, never the CMS's
 *
 * All three CMS routes answer the SAME neutral body for every outcome —
 * "a new address", "already active", "suppressed", "unresolved tenant" all
 * read alike, on purpose (see `subscribe.ts`'s own docblock: a distinguishing
 * response would turn a public endpoint into a way to ask whether a named
 * person subscribes to this newsroom's list). That neutral body is also
 * written in English, and this storefront's copy is Indonesian throughout —
 * so a successful call's `data.message` is deliberately never rendered
 * verbatim; the fixed Indonesian sentences below say the same thing.
 */
import { requireAwcmsOrigin } from "../lib/awcms/toko-origin";

const NEWSLETTER_PATH_PREFIX = "/api/v1/newsletter";

/**
 * One error for every failure this file can produce — a failure envelope, a
 * network failure, or an unreadable response. Mirrors `TokoApiError`'s shape
 * (`src/lib/toko-klien.ts`) so a caller reasons about it the same way.
 *
 * `retryAfterSeconds` is read from the response's `Retry-After` HEADER, not
 * from `error.details` — the three CMS routes' own `429` calls
 * `fail(429, "RATE_LIMITED", "...", {}, undefined, { "retry-after": String(...), vary: "Origin" })`
 * (`apps/cms/src/modules/_shared/api-response.ts`'s `fail` signature is
 * `(status, code, message, meta, details, headers)`), so `details` is
 * `undefined` on every `429` this family sends and a wait time read from it
 * would always be `null`.
 */
export class BuletinApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "BuletinApiError";
  }
}

type Envelope =
  | { success: true; data: { message: string } }
  | { success: false; error: { code: string; message: string; details?: unknown } };

/**
 * One request against a `/api/v1/newsletter/*` route, built exactly the way
 * `toko-klien.ts`'s own docblock describes for its sibling endpoints: cross-
 * origin, credential-free, one header. Never retried — a double POST from a
 * hidden retry is exactly what `NEWSLETTER_CONFIRMATION_COOLDOWN_SEC` and the
 * per-IP limiter exist to price out, and a shopper's own retry (clicking the
 * button, or the e-mail link, again) is the correct way a SECOND attempt
 * happens.
 */
async function request(
  path: string,
  body: { token: string } | { email: string; locale?: string }
): Promise<{ message: string }> {
  const origin = requireAwcmsOrigin();
  const url = `${origin}${NEWSLETTER_PATH_PREFIX}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (cause) {
    throw new BuletinApiError(
      `Could not reach the store (${cause instanceof Error ? cause.message : String(cause)}).`,
      0,
      "NETWORK_ERROR"
    );
  }

  let payload: Envelope;
  try {
    payload = (await response.json()) as Envelope;
  } catch {
    throw new BuletinApiError(
      `The store returned an unreadable response (HTTP ${response.status}).`,
      response.status,
      "INVALID_RESPONSE"
    );
  }

  if (!payload.success) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : null;
    throw new BuletinApiError(
      payload.error.message,
      response.status,
      payload.error.code,
      payload.error.details,
      retryAfterSeconds
    );
  }

  return payload.data;
}

/** `POST …/newsletter/subscribe` — `locale` is always `"id"`: this storefront has no other UI language (see `docs/ui-ux.md`). */
export function subscribeToNewsletter(email: string): Promise<{ message: string }> {
  return request("/subscribe", { email, locale: "id" });
}

/** `POST …/newsletter/confirm` — the moment consent is actually recorded, per the CMS route's own docblock. */
export function confirmNewsletterSubscription(token: string): Promise<{ message: string }> {
  return request("/confirm", { token });
}

/** `POST …/newsletter/unsubscribe` — token only, per PRD §30: no session, no address, nothing to prove but holding the link. */
export function unsubscribeFromNewsletter(token: string): Promise<{ message: string }> {
  return request("/unsubscribe", { token });
}

/**
 * Every code this endpoint family's routes CAN send, mapped to Indonesian
 * copy — `NETWORK_ERROR`/`INVALID_RESPONSE` are this file's own, for a
 * `fetch()` that never got a response at all or answered with unreadable
 * JSON.
 *
 * ## `VALIDATION_ERROR`/`RATE_LIMITED` are same-origin-only in practice
 *
 * The three CMS routes answer a `400`/`429` BEFORE classifying the
 * request's `Origin` (`subscribe.ts`/`confirm.ts`/`unsubscribe.ts`: the
 * rate-limit and body-validation checks run first, and each such response
 * carries only `vary: "Origin"` — never `access-control-allow-origin`). A
 * response with no CORS grant is not just unreadable to this file's own
 * JSON parsing: for a CROSS-ORIGIN request (`mode: "cors"`, which every
 * real deployment of this storefront is — ADR-0007/ADR-0070 put the CMS on
 * a different origin from this app), the browser refuses to let ANY script
 * observe that response at all, and `fetch()` itself rejects — landing in
 * this file's own `NETWORK_ERROR` branch above, not here. These two `case`s
 * are kept because they are real, documented route behaviour and because a
 * SAME-origin deployment (this app served from the CMS's own origin — not
 * how this repo runs it, but not forbidden by anything here either) would
 * reach them normally; a reader on this app's actual, cross-origin
 * deployment will never see either message in practice.
 *
 * `context` disambiguates `NETWORK_ERROR`'s copy: it covers a REAL network
 * failure and both "hidden by CORS" cases above alike, and none of those are
 * a connectivity problem the copy should assert — see this function's own
 * git history/PR review for why an earlier version claiming one was wrong.
 * `"subscribe"` (the default) can reasonably suggest checking the address
 * just typed; `"token"` (confirm/unsubscribe) has no such field to point at.
 */
export function buletinErrorMessage(error: unknown, context: "subscribe" | "token" = "subscribe"): string {
  if (error instanceof BuletinApiError) {
    switch (error.code) {
      case "VALIDATION_ERROR":
        return "Alamat email tidak valid. Periksa kembali penulisannya.";
      case "RATE_LIMITED": {
        const seconds = error.retryAfterSeconds;
        return seconds
          ? `Terlalu banyak percobaan. Coba lagi dalam ${seconds} detik.`
          : "Terlalu banyak percobaan. Coba lagi sebentar lagi.";
      }
      case "NETWORK_ERROR":
        return context === "subscribe"
          ? "Pendaftaran belum berhasil. Periksa alamat e-mail Anda atau coba lagi beberapa menit lagi."
          : "Permintaan belum berhasil. Periksa kembali tautan dari email Anda atau coba lagi beberapa menit lagi.";
      default:
        return "Terjadi kesalahan yang tidak terduga. Coba lagi nanti.";
    }
  }
  return "Terjadi kesalahan yang tidak terduga. Coba lagi nanti.";
}

function showStatus(el: HTMLElement, tone: "info" | "danger", message: string): void {
  el.hidden = false;
  el.textContent = message;
  el.className = `toko-banner toko-banner--${tone}`;
}

// --- The subscribe form(s) --------------------------------------------------

/**
 * The slice of `Document`/`ParentNode` `wireBuletinForms` needs — a
 * parameter rather than a bare `document` so `tests/buletin-forms.test.ts`
 * can hand it a two-form fake root under plain `bun test`, which has no DOM
 * (no shim is registered anywhere in this workspace — see the entry point
 * below). Production passes `document`.
 */
export type BuletinFormRoot = {
  querySelectorAll(selector: string): ArrayLike<HTMLFormElement> & Iterable<HTMLFormElement>;
};

/**
 * Wires EVERY `[data-buletin-form]` under `root` — not just the first.
 * Issue #49 renders the form twice on most news pages (the sidebar's box AND
 * the footer's, as seputarborneo does); an earlier version of this file
 * used `document.querySelector` and would have left the second form dead:
 * a bare `<form>` with no `action`/`method` whose submit nothing intercepts
 * GETs its fields onto the page's own URL, putting the reader's e-mail
 * address in the address bar and the server log. Each form gets its own
 * closure via `wireBuletinForm` — its own `submitting` flag, its own
 * status region, its own button — so nothing is shared between them.
 */
export function wireBuletinForms(root: BuletinFormRoot): void {
  for (const formRoot of root.querySelectorAll("[data-buletin-form]")) {
    wireBuletinForm(formRoot);
  }
}

/** One form's own wiring — every piece of state below is local to this call. Exported for `tests/buletin-forms.test.ts`; production only ever reaches it through `wireBuletinForms`. */
export function wireBuletinForm(formRoot: HTMLFormElement): void {
  const emailInput = formRoot.querySelector<HTMLInputElement>("[data-buletin-email]");
  const honeypotInput = formRoot.querySelector<HTMLInputElement>("[data-buletin-honeypot]");
  const submitButton = formRoot.querySelector<HTMLButtonElement>("[data-buletin-submit]");
  const statusEl = formRoot.querySelector<HTMLElement>("[data-buletin-status]");

  let submitting = false;

  formRoot.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting) return;

    // The form itself is `novalidate` (this app never lets the browser's
    // own bubble UI silently swallow a submit elsewhere either — see
    // `checkout.ts`'s identical `[required]`/`checkValidity()` loop) so a
    // malformed address is never sent to `fetch()` at all: the CMS's own
    // `400 VALIDATION_ERROR` for one carries no CORS grant (see
    // `buletinErrorMessage`'s own docblock), so without this check every
    // typo would read to the reader as "could not reach the server" —
    // exactly the confusing, wrong-cause message this check exists to make
    // unreachable.
    if (!emailInput || !emailInput.checkValidity()) {
      emailInput?.reportValidity();
      return;
    }

    const email = emailInput.value.trim();
    if (!email) return;

    // A field a real reader never sees or reaches (see the component's own
    // markup: `hidden` + `tabindex="-1"`) but a naive bot that fills every
    // field in a scraped form still will. Answering with the SAME neutral
    // success message — never a distinguishing error — costs the bot
    // nothing to learn and this endpoint one fewer request to rate-limit.
    if (honeypotInput?.value) {
      if (statusEl) {
        showStatus(
          statusEl,
          "info",
          "Jika alamat itu dapat didaftarkan, email konfirmasi sedang dalam perjalanan."
        );
      }
      formRoot.reset();
      return;
    }

    submitting = true;
    if (submitButton) submitButton.disabled = true;
    if (statusEl) statusEl.hidden = true;

    subscribeToNewsletter(email)
      .then(() => {
        if (statusEl) {
          showStatus(
            statusEl,
            "info",
            "Jika alamat itu dapat didaftarkan, email konfirmasi sedang dalam perjalanan — periksa kotak masuk Anda dan klik tautan konfirmasi untuk mengaktifkan langganan."
          );
        }
        formRoot.reset();
      })
      .catch((error: unknown) => {
        if (statusEl) showStatus(statusEl, "danger", buletinErrorMessage(error));
      })
      .finally(() => {
        submitting = false;
        if (submitButton) submitButton.disabled = false;
      });
  });
}

// --- `/newsletter/confirm` and `/newsletter/unsubscribe` --------------------

/**
 * Shared wiring for both token pages: read `?token=` from the URL the reader
 * arrived at (never from `sessionStorage`/a form — the token IS the whole
 * point of the link), then wait for an explicit click on `[data-buletin-
 * action]` before calling `action` — never on page load.
 *
 * ## Why not just call `action(token)` as soon as the token parses
 *
 * That was this file's own first shape, and it is a real vulnerability: a
 * mail gateway's link-scanner (Outlook Safe Links, Google's/Microsoft's
 * inbound scanners, many corporate proxies) fetches and often fully RENDERS
 * — executes JS on — every link in an incoming e-mail before the recipient
 * ever sees it, specifically to check where it leads. A confirm/unsubscribe
 * link that fires its state change on load, rather than on a deliberate
 * click, gets confirmed or unsubscribed by the SCANNER, not the reader —
 * consent recorded from (or a subscription ended by) an IP address that
 * never made the choice. Requiring a click the token page renders is the
 * same mitigation e-mail-triggered state changes use everywhere (a
 * `GET`-only unsubscribe link is the textbook version of this exact bug);
 * a scanner that also simulates a real user click is not a threat model
 * anything short of CAPTCHA defends against, and this module's own PRD
 * (§30: unsubscribing must not require a login) does not ask for that.
 *
 * A missing/malformed token still never reaches the network and never shows
 * the button at all — that is a statement about the LINK, not about any
 * subscription, and answering it locally saves the per-IP budget for a
 * token that could actually be real.
 */
function wireTokenPage(
  rootSelector: string,
  action: (token: string) => Promise<{ message: string }>,
  successMessage: string
): void {
  const root = document.querySelector<HTMLElement>(rootSelector);
  if (!root) return;

  const statusEl = root.querySelector<HTMLElement>("[data-buletin-status]");
  const actionButton = root.querySelector<HTMLButtonElement>("[data-buletin-action]");
  if (!statusEl || !actionButton) return;

  const token = new URLSearchParams(window.location.search).get("token");

  if (!token || !/^[A-Za-z0-9_-]+$/.test(token) || token.length > 200) {
    showStatus(statusEl, "danger", "Tautan ini tidak lengkap atau tidak valid. Periksa kembali tautan dari email Anda.");
    return;
  }

  // Only revealed once a well-formed token is confirmed present — a reader
  // (or scanner) with no token, or a malformed one, never sees a button:
  // there is nothing correct for it to do.
  actionButton.hidden = false;

  let submitting = false;
  actionButton.addEventListener("click", () => {
    if (submitting) return;
    submitting = true;
    actionButton.disabled = true;
    statusEl.hidden = true;

    action(token)
      .then(() => {
        showStatus(statusEl, "info", successMessage);
        // The token is spent server-side on first use (both routes clear
        // their own token hash on success); hiding the button stops a
        // reader re-clicking into a second, pointless request rather than
        // relying on the per-IP limiter to make that harmless.
        actionButton.hidden = true;
      })
      .catch((error: unknown) => {
        showStatus(statusEl, "danger", buletinErrorMessage(error, "token"));
        submitting = false;
        actionButton.disabled = false;
      });
  });
}

// --- Entry point ------------------------------------------------------------
//
// Guarded on `typeof document !== "undefined"`, not just on each root's own
// `querySelector` returning null: `bun test` (this file's own
// `tests/buletin-klien.test.ts`) runs with NO DOM at all — no shim is
// registered anywhere in this workspace (unlike `apps/cms`'s suite) — so a
// bare top-level `document.querySelector(...)` would throw a
// `ReferenceError` the instant this module is imported, before a test ever
// gets to call `subscribeToNewsletter` and friends. Everything above stays
// pure and importable; only the wiring below needs an actual browser.
if (typeof document !== "undefined") {
  wireBuletinForms(document);
  wireTokenPage(
    "[data-buletin-confirm]",
    confirmNewsletterSubscription,
    "Jika tautan ini masih berlaku, langganan Anda kini telah dikonfirmasi. Terima kasih!"
  );
  wireTokenPage(
    "[data-buletin-unsubscribe]",
    unsubscribeFromNewsletter,
    "Jika tautan ini valid, Anda tidak akan lagi menerima buletin dari kami."
  );
}
