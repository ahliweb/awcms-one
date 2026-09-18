/**
 * The share row's browser-side half (issue #51) — the Instagram SHARE
 * button in `src/components/berita/BarisBagikan.astro`. Ported from
 * seputarborneo.com's `js/main.js` `initBagikan()`.
 *
 * Instagram has no web share-intent URL of any kind (its `AGENTS.md` there,
 * issue #61: "Jangan mengarang URL berbagi web untuk Instagram"), so this
 * control cannot be a plain `<a>` like the Facebook/X/WhatsApp/Threads
 * links beside it. It is a real `<button>` and does one of two things, in
 * this order:
 *
 * 1. `navigator.share({ title, url })` — the OS share sheet, where the
 *    reader picks Instagram (Story/DM) or anything else. This is what
 *    virtually every phone has; a share sheet the READER drives needs no
 *    Instagram account of ours, which is why this button never reads
 *    `identity.socialLinks`. A dismissed sheet (`AbortError`) is the reader
 *    changing their mind — silent, no fallback, no status.
 * 2. Otherwise (a desktop browser with no Web Share API, or `share()`
 *    rejecting for any reason other than dismissal) —
 *    `navigator.clipboard.writeText(url)` and a visible, `aria-live`
 *    "Tautan disalin…" status, so the reader knows the click did something
 *    and what to do next.
 *
 * ## Why the status is a static, pre-rendered `role="status"` element
 *
 * `initBagikan()` upstream creates its toast `<div>` on the first click. An
 * `aria-live` region only reliably announces text that CHANGES inside a
 * region assistive technology already knew about — a region created and
 * filled in the same tick is announced by some screen readers and skipped
 * by others. `BarisBagikan.astro` therefore ships the
 * `[data-bagikan-status]` element empty in the static HTML, and this script
 * only ever sets its `textContent`. It is cleared again after a few seconds
 * so a second click re-announces (an unchanged string would not).
 *
 * ## What was deliberately NOT ported
 *
 * Upstream's two last-resort fallbacks — a hidden `<textarea>` +
 * `document.execCommand("copy")`, then `window.prompt()` — are not here.
 * Every browser this app's own baseline supports has the async Clipboard
 * API in a secure context (this site is HTTPS-only in production, and
 * `localhost` counts as secure), `execCommand` is deprecated, and a blocking
 * `prompt()` is exactly the jarring interruption an `aria-live` status
 * exists to avoid. When the clipboard is genuinely unavailable (a denied
 * permission, an insecure context in development), the status says so and
 * points at the address bar — the URL is the page the reader is already on.
 *
 * `script-src 'self'` (`server/penyaji.mjs`) has no `'unsafe-inline'` — this
 * file is an ordinary Astro-bundled external module, imported from the
 * component's own `<script>` block the same way `src/pages/video/
 * [slug].astro` imports `video-facade.ts`.
 */

/** How the click was ultimately handled — exported so the decision table is unit-testable without a DOM. */
export type HasilBagikan = "share" | "batal" | "salin" | "gagal";

export const PESAN_TERSALIN = "Tautan disalin. Tempel di Instagram (Story/DM) untuk membagikan.";
export const PESAN_GAGAL_SALIN =
  "Tautan tidak dapat disalin otomatis — salin alamat halaman ini dari bilah alamat peramban Anda.";

/** How long the status stays before it is cleared (see file docblock for why it is cleared at all). */
export const STATUS_TAMPIL_MS = 5000;

/**
 * The two browser capabilities this flow depends on, as an injectable
 * subset of `navigator` — `bun test` has no `navigator.share`, and a real
 * one cannot be driven from a test anyway (it requires a user gesture).
 */
export type KemampuanBagikan = {
  share?: (data: { title: string; url: string }) => Promise<void>;
  tulisPapanKlip?: (teks: string) => Promise<void>;
};

function kemampuanDariNavigator(nav: Navigator): KemampuanBagikan {
  return {
    share: typeof nav.share === "function" ? (data) => nav.share(data) : undefined,
    tulisPapanKlip:
      nav.clipboard && typeof nav.clipboard.writeText === "function"
        ? (teks) => nav.clipboard.writeText(teks)
        : undefined
  };
}

async function salinTautan(
  url: string,
  kemampuan: KemampuanBagikan,
  tampilkanStatus: (teks: string) => void
): Promise<HasilBagikan> {
  if (!kemampuan.tulisPapanKlip) {
    tampilkanStatus(PESAN_GAGAL_SALIN);
    return "gagal";
  }

  try {
    await kemampuan.tulisPapanKlip(url);
    tampilkanStatus(PESAN_TERSALIN);
    return "salin";
  } catch {
    tampilkanStatus(PESAN_GAGAL_SALIN);
    return "gagal";
  }
}

/**
 * The decision table (Web Share → clipboard → visible failure), separated
 * from the DOM so it is testable. `tampilkanStatus` is only ever called on
 * the clipboard branches: a completed OR dismissed share sheet is its own
 * feedback, and announcing "Tautan disalin" after a share that actually
 * went out would be false.
 */
export async function bagikanKeInstagram(
  data: { title: string; url: string },
  kemampuan: KemampuanBagikan,
  tampilkanStatus: (teks: string) => void
): Promise<HasilBagikan> {
  if (kemampuan.share) {
    try {
      await kemampuan.share(data);
      return "share";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "batal";
      // Any other rejection (NotAllowedError without a gesture, a data
      // shape this OS refuses, DataError) — fall through to the clipboard,
      // the same way upstream's `initBagikan()` does.
    }
  }

  return salinTautan(data.url, kemampuan, tampilkanStatus);
}

/** The one thing a status region needs to be: `textContent` writable — a real element in the browser, a plain object under `bun test`. */
export type ElemenStatus = { textContent: string | null };

/** Injectable timer pair so the clear-after-delay behaviour is testable without real time passing. */
export type PenjadwalStatus = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/**
 * Builds the `tampilkanStatus` callback for ONE status region, owning ONE
 * clear-timer. The timer lives inside this closure — per region, never
 * shared across regions (PR #69 review): with a single page-wide timer,
 * two rows on one page (should a future template ever render the row
 * above AND below an article) would cancel each other's clear when
 * clicked within `STATUS_TAMPIL_MS` of each other — row A's "Tautan
 * disalin…" would stick, and an identical string set later would not be
 * re-announced by `aria-live`. Each region clearing itself is also what
 * makes a repeat click on the SAME row re-announce (see file docblock).
 */
export function buatPenampilStatus(
  status: ElemenStatus | null,
  penjadwal: PenjadwalStatus = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
): (teks: string) => void {
  let timer: unknown = null;

  return (teks: string): void => {
    if (!status) return;
    status.textContent = teks;
    if (timer !== null) penjadwal.clearTimeout(timer);
    timer = penjadwal.setTimeout(() => {
      status.textContent = "";
      timer = null;
    }, STATUS_TAMPIL_MS);
  };
}

function initBagikan(): void {
  const tombolSemua = document.querySelectorAll<HTMLButtonElement>("[data-bagikan-instagram]");
  if (tombolSemua.length === 0) return;

  const kemampuan = kemampuanDariNavigator(navigator);

  for (const tombol of tombolSemua) {
    // The status element is the button's OWN row's — `closest()` rather
    // than a page-wide `querySelector`, so two rows on one page each
    // announce into their own region, each with its own clear-timer
    // (`buatPenampilStatus`).
    const baris = tombol.closest<HTMLElement>("[data-bagikan]");
    const status = baris?.querySelector<HTMLElement>("[data-bagikan-status]") ?? null;
    const tampilkanStatus = buatPenampilStatus(status);

    // Shipped `hidden` in the static HTML (see `BarisBagikan.astro`): a
    // button whose only behaviour is JavaScript must not be shown to a
    // reader who has none. Revealed here, once the handler that makes it
    // do something is actually attached.
    tombol.hidden = false;

    tombol.addEventListener("click", () => {
      const url = tombol.dataset.url ?? "";
      const title = tombol.dataset.judul ?? "";
      if (!url) return;
      void bagikanKeInstagram({ title, url }, kemampuan, tampilkanStatus);
    });
  }
}

if (typeof document !== "undefined") {
  initBagikan();
}
