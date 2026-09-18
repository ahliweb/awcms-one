/**
 * `src/scripts/buletin.ts`'s `wireBuletinForms` (issue #49): EVERY
 * `[data-buletin-form]` on a page is wired, each with its own state. Issue
 * #49 renders the subscribe form twice on most news pages — the sidebar's
 * box and the footer's — and the earlier `document.querySelector` wiring
 * left the second one dead (a bare `<form>` GETting the reader's e-mail
 * onto the page URL). Complements `tests/buletin-klien.test.ts`, which
 * covers the REQUEST the pure client builds; this file covers the wiring.
 *
 * Plain `bun test` has no DOM (no shim is registered anywhere in this
 * workspace — `buletin.ts`'s own entry point is guarded on
 * `typeof document !== "undefined"` for exactly that reason), so the two
 * forms below are a hand-rolled fake of the tiny DOM surface the wiring
 * actually touches: `querySelectorAll`/`querySelector`, `addEventListener`,
 * `checkValidity`/`reportValidity`/`reset`, `hidden`/`disabled`/`value`/
 * `textContent`/`className`. `wireBuletinForms` takes its root as a
 * parameter (`BuletinFormRoot`) so this file can pass that fake in.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { wireBuletinForms, type BuletinFormRoot } from "../src/scripts/buletin";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ORIGIN = process.env.PUBLIC_AWCMS_ORIGIN;

type Listener = (event: { preventDefault(): void }) => void;

class FakeInput {
  value = "";
  valid = true;
  reported = 0;
  checkValidity(): boolean {
    return this.valid;
  }
  reportValidity(): boolean {
    this.reported += 1;
    return this.valid;
  }
}

class FakeStatus {
  hidden = true;
  textContent = "";
  className = "";
}

class FakeButton {
  disabled = false;
}

class FakeForm {
  email = new FakeInput();
  honeypot = new FakeInput();
  status = new FakeStatus();
  button = new FakeButton();
  resets = 0;
  private listeners: Listener[] = [];

  querySelector(selector: string): unknown {
    switch (selector) {
      case "[data-buletin-email]":
        return this.email;
      case "[data-buletin-honeypot]":
        return this.honeypot;
      case "[data-buletin-submit]":
        return this.button;
      case "[data-buletin-status]":
        return this.status;
      default:
        return null;
    }
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "submit") this.listeners.push(listener);
  }

  /** Dispatches a submit; returns whether `preventDefault()` was called (the native navigation a dead form would perform). */
  submit(): boolean {
    let prevented = false;
    for (const listener of this.listeners) {
      listener({
        preventDefault() {
          prevented = true;
        }
      });
    }
    return prevented;
  }

  reset(): void {
    this.resets += 1;
    this.email.value = "";
    this.honeypot.value = "";
  }
}

function rootWith(...forms: FakeForm[]): BuletinFormRoot {
  return {
    querySelectorAll: (selector: string) =>
      (selector === "[data-buletin-form]" ? forms : []) as unknown as ArrayLike<HTMLFormElement> &
        Iterable<HTMLFormElement>
  };
}

/** Resolves when every pending microtask/promise chain from a submit has settled. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let requests: { url: string; body: unknown }[] = [];
let pending: Array<() => void> = [];

/** Every call answers the CMS's neutral success body; `hold` keeps each response pending until `release()` runs, to observe in-flight state. */
function mockFetch(hold = false): void {
  requests = [];
  pending = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (hold) await new Promise<void>((resolve) => pending.push(resolve));
    return new Response(JSON.stringify({ success: true, data: { message: "ok" } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.PUBLIC_AWCMS_ORIGIN = "https://cms.example.com";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ORIGIN === undefined) delete process.env.PUBLIC_AWCMS_ORIGIN;
  else process.env.PUBLIC_AWCMS_ORIGIN = ORIGINAL_ORIGIN;
});

describe("wireBuletinForms: two forms on one document", () => {
  test("wires BOTH forms — each submit is intercepted and posts its own address", async () => {
    mockFetch();
    const sidebar = new FakeForm();
    const footer = new FakeForm();
    wireBuletinForms(rootWith(sidebar, footer));

    footer.email.value = "footer@example.test";
    expect(footer.submit()).toBe(true); // preventDefault ran — no native GET navigation
    await settle();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://cms.example.com/api/v1/newsletter/subscribe");
    expect(requests[0]!.body).toEqual({ email: "footer@example.test", locale: "id" });

    sidebar.email.value = "sidebar@example.test";
    expect(sidebar.submit()).toBe(true);
    await settle();

    expect(requests).toHaveLength(2);
    expect(requests[1]!.body).toEqual({ email: "sidebar@example.test", locale: "id" });
  });

  test("each form owns its own status region and button — a submit on one never touches the other", async () => {
    mockFetch();
    const sidebar = new FakeForm();
    const footer = new FakeForm();
    wireBuletinForms(rootWith(sidebar, footer));

    footer.email.value = "footer@example.test";
    footer.submit();
    await settle();

    expect(footer.status.hidden).toBe(false);
    expect(footer.status.className).toBe("toko-banner toko-banner--info");
    expect(footer.status.textContent).toContain("email konfirmasi");
    expect(footer.resets).toBe(1);

    expect(sidebar.status.hidden).toBe(true);
    expect(sidebar.status.textContent).toBe("");
    expect(sidebar.button.disabled).toBe(false);
    expect(sidebar.resets).toBe(0);
  });

  test("the in-flight guard is per form: a pending submit on one form does not block the other, and does block its own double-submit", async () => {
    mockFetch(true);
    const sidebar = new FakeForm();
    const footer = new FakeForm();
    wireBuletinForms(rootWith(sidebar, footer));

    sidebar.email.value = "sidebar@example.test";
    sidebar.submit();
    await settle();
    expect(requests).toHaveLength(1);
    expect(sidebar.button.disabled).toBe(true);

    // Same form again while pending: swallowed, no second request.
    sidebar.submit();
    await settle();
    expect(requests).toHaveLength(1);

    // The OTHER form is not blocked by the sidebar's pending request.
    footer.email.value = "footer@example.test";
    footer.submit();
    await settle();
    expect(requests).toHaveLength(2);
    expect(footer.button.disabled).toBe(true);

    for (const release of pending) release();
    await settle();
    expect(sidebar.button.disabled).toBe(false);
    expect(footer.button.disabled).toBe(false);
  });

  test("validation and the honeypot are checked per form, before any request", async () => {
    mockFetch();
    const sidebar = new FakeForm();
    const footer = new FakeForm();
    wireBuletinForms(rootWith(sidebar, footer));

    // A malformed address on the footer form: reported there, nothing sent,
    // and the sidebar form is untouched.
    footer.email.value = "not-an-email";
    footer.email.valid = false;
    expect(footer.submit()).toBe(true);
    await settle();
    expect(requests).toHaveLength(0);
    expect(footer.email.reported).toBe(1);
    expect(sidebar.email.reported).toBe(0);

    // A filled honeypot on the sidebar form: the neutral message, no request.
    sidebar.email.value = "bot@example.test";
    sidebar.honeypot.value = "https://spam.example";
    sidebar.submit();
    await settle();
    expect(requests).toHaveLength(0);
    expect(sidebar.status.hidden).toBe(false);
    expect(sidebar.status.className).toBe("toko-banner toko-banner--info");
    expect(sidebar.resets).toBe(1);
    // The footer form's own status region is untouched by the sidebar's submit.
    expect(footer.status.hidden).toBe(true);
    expect(footer.resets).toBe(0);
  });

  test("a root with no form is a no-op", () => {
    mockFetch();
    expect(() => wireBuletinForms(rootWith())).not.toThrow();
    expect(requests).toHaveLength(0);
  });
});
