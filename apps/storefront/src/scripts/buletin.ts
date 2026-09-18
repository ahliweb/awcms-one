/**
 * Newsletter double opt-in (issue #50) — `/buletin`'s subscribe form and the
 * two token pages (`/newsletter/confirm`, `/newsletter/unsubscribe` — a fixed apps/cms contract, not this app's own naming; see the README) it links to
 * from an e-mail. Wires up whichever `[data-buletin-*]` root the current
 * page actually has — the same one-script-many-guarded-roots shape
 * `checkout.ts`/`keranjang.ts` use, so this file can be imported unchanged
 * from all three pages.
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

/** One error for every failure this file can produce — a failure envelope, a network failure, or an unreadable response. Mirrors `TokoApiError`'s shape (`src/lib/toko-klien.ts`) so a caller reasons about it the same way. */
export class BuletinApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "BuletinApiError";
  }

  /** `Retry-After` seconds for a `429 RATE_LIMITED`, or `null`. */
  get retryAfterSeconds(): number | null {
    if (this.code !== "RATE_LIMITED") return null;
    const details = this.details as { retryAfter?: number } | undefined;
    return typeof details?.retryAfter === "number" ? details.retryAfter : null;
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
    throw new BuletinApiError(payload.error.message, response.status, payload.error.code, payload.error.details);
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
 * Every documented failure this endpoint family can answer, mapped to
 * Indonesian copy — `VALIDATION_ERROR`/`RATE_LIMITED` are the only codes the
 * three CMS routes themselves ever return (their own route files), and
 * `NETWORK_ERROR`/`INVALID_RESPONSE` are this file's own. No other code is
 * possible, so there is no "raw server text" fallback to reach for.
 */
export function buletinErrorMessage(error: unknown): string {
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
        return "Tidak dapat menghubungi server. Periksa koneksi internet Anda dan coba lagi.";
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

// --- `/buletin`'s subscribe form -------------------------------------------

function wireBuletinForm(): void {
  const formRoot = document.querySelector<HTMLFormElement>("[data-buletin-form]");
  if (!formRoot) return;

  const emailInput = formRoot.querySelector<HTMLInputElement>("[data-buletin-email]");
  const honeypotInput = formRoot.querySelector<HTMLInputElement>("[data-buletin-honeypot]");
  const submitButton = formRoot.querySelector<HTMLButtonElement>("[data-buletin-submit]");
  const statusEl = formRoot.querySelector<HTMLElement>("[data-buletin-status]");

  let submitting = false;

  formRoot.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting) return;

    const email = emailInput?.value.trim() ?? "";
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
 * point of the link), call `action`, and render one of three states. A
 * missing/malformed token never reaches the network — that is a statement
 * about the LINK, not about any subscription, and answering it locally saves
 * the per-IP budget for a token that could actually be real.
 */
function wireTokenPage(
  rootSelector: string,
  action: (token: string) => Promise<{ message: string }>,
  successMessage: string
): void {
  const root = document.querySelector<HTMLElement>(rootSelector);
  if (!root) return;

  const statusEl = root.querySelector<HTMLElement>("[data-buletin-status]");
  if (!statusEl) return;

  const token = new URLSearchParams(window.location.search).get("token");

  if (!token || !/^[A-Za-z0-9_-]+$/.test(token) || token.length > 200) {
    showStatus(statusEl, "danger", "Tautan ini tidak lengkap atau tidak valid. Periksa kembali tautan dari email Anda.");
    return;
  }

  action(token)
    .then(() => showStatus(statusEl, "info", successMessage))
    .catch((error: unknown) => showStatus(statusEl, "danger", buletinErrorMessage(error)));
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
  wireBuletinForm();
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
