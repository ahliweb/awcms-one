/**
 * The storefront's one in-flight ("single-flight") guard for every mutating
 * form or button (issue #513, decision 2).
 *
 * ## The problem it closes
 *
 * A shopper taps **Daftar** twice, or presses Enter while the first request is
 * still in the air. Without a guard the second tap sends a second request; the
 * first creates the account, the second finds the phone registered and answers
 * "already registered" for an account the same person just made. A client
 * guard stops the ACCIDENTAL double tap; it never replaces server idempotency
 * (a browser retry, a reload or a second tab bypass it entirely), which is why
 * `kunci-idempotensi.ts` exists beside this file.
 *
 * ## Two layers, on purpose
 *
 * 1. `buatPenjagaTunggal` - the PURE core: a three-state machine
 *    (`idle` -> `pending` -> `idle` again, or `settled`), no DOM, no timers,
 *    fully unit-testable with fake hooks. A call made while one is pending - or
 *    after a success that told the guard "a navigation follows" - is IGNORED,
 *    not queued: queuing a second submit would send exactly the duplicate this
 *    module exists to stop. The state is always restored in `finally`, so a
 *    throwing task can never leave a form dead.
 * 2. `buatPenjagaDom` / `penjagaUntuk` - a thin adapter over injected ports
 *    (`PortKontrol`, `PortForm`, `PortStatus`, `PortHalaman`) that, while a task
 *    is pending: disables the submit controls, sets `aria-busy="true"` on the
 *    form (or region) and writes "Memproses..." to the page's polite
 *    `aria-live` status; and on a `pageshow` with `persisted` (the back button
 *    restored the page from the back/forward cache with a script state frozen
 *    mid-flight) releases the lock so the form is usable, never dead.
 *
 * ## What the adapter promises the shopper
 *
 * - No layout shift: nothing is added or resized. The status line is a
 *   visually-hidden live region that already exists in `BaseLayout`
 *   (`[data-proses-status]`); a polite region only announces reliably when it
 *   exists before its text changes.
 * - Focus is not lost: browsers drop focus from a control that becomes
 *   disabled, so the control that had focus gets it back when the form
 *   becomes usable again.
 * - A successful task that says `kunciBila` ("a navigation follows") leaves
 *   everything DISABLED and `aria-busy="true"` until the page unloads - there
 *   is no window between the success and the redirect in which a second tap
 *   could register.
 * - A control that another part of the page owns (the resend button's
 *   countdown) is kept disabled on release through `tetapNonaktif`.
 *
 * No inline script or style is involved: `aria-busy`, `disabled` and text are
 * set through the DOM from an external module, so the derived CSP is untouched.
 */

export type KeadaanPenjaga = "idle" | "pending" | "settled";

export type HasilJalan<T> =
  | { dijalankan: true; hasil: T }
  | { dijalankan: false; alasan: "pending" | "settled" };

export type OpsiJalan<T> = {
  /**
   * Whether a successful run leaves the guard locked (`settled`) because a
   * navigation (a redirect to the account page, a hosted payment page) follows.
   * `true`, or a function of the task's result so a handler that caught its own
   * error and returned `false` is released instead. Default: not locked.
   */
  kunciBila?: boolean | ((hasil: T) => boolean);
};

export type KaitPenjaga = {
  /** Runs synchronously once the call is accepted, before the task starts. */
  saatMulai?: () => void;
  /** Runs in `finally`; `terkunci` is `true` when the guard stays locked. */
  saatSelesai?: (terkunci: boolean) => void;
  /** Runs when `lepas()` resets a settled/pending guard (bfcache restore). */
  saatLepas?: () => void;
};

export type PenjagaTunggal = {
  keadaan(): KeadaanPenjaga;
  /**
   * Runs `tugas` unless one is already pending or the guard is settled; in that
   * case it resolves `{ dijalankan: false }` WITHOUT calling `tugas`. A throw
   * from `tugas` restores the guard and is rethrown to the caller.
   */
  jalankan<T>(tugas: () => Promise<T>, opsi?: OpsiJalan<T>): Promise<HasilJalan<T>>;
  /** Forces the guard back to `idle` (a restored bfcache page). */
  lepas(): void;
};

export function buatPenjagaTunggal(kait: KaitPenjaga = {}): PenjagaTunggal {
  let keadaan: KeadaanPenjaga = "idle";

  return {
    keadaan: () => keadaan,

    async jalankan<T>(tugas: () => Promise<T>, opsi: OpsiJalan<T> = {}): Promise<HasilJalan<T>> {
      // Decided and set synchronously: two taps in the same task still see
      // `pending` on the second one.
      if (keadaan !== "idle") return { dijalankan: false, alasan: keadaan };
      keadaan = "pending";

      let terkunci = false;
      try {
        kait.saatMulai?.();
        const hasil = await tugas();
        const kunci = opsi.kunciBila;
        terkunci = typeof kunci === "function" ? kunci(hasil) === true : kunci === true;
        return { dijalankan: true, hasil };
      } finally {
        keadaan = terkunci ? "settled" : "idle";
        kait.saatSelesai?.(terkunci);
      }
    },

    lepas() {
      if (keadaan === "idle") return;
      keadaan = "idle";
      kait.saatLepas?.();
    }
  };
}

// ---------------------------------------------------------------------------
// The DOM adapter - ports are injected, so the tests use plain objects.
// ---------------------------------------------------------------------------

export type PortKontrol = { disabled: boolean; focus?: () => void };
/** `aria-busy` carrier; a fake or a minimal element without these methods is tolerated (the guard still works, only the attribute is skipped). */
export type PortForm = {
  setAttribute?(nama: string, nilai: string): void;
  removeAttribute?(nama: string): void;
};
export type PortStatus = { textContent: string | null };
export type PortHalaman = {
  addEventListener(jenis: "pageshow", pendengar: (peristiwa: { persisted: boolean }) => void): void;
};

export type OpsiPenjagaDom = {
  /** The form (or region) that carries `aria-busy`. `null` is tolerated (markup variant without it). */
  form: PortForm | null;
  /** Re-evaluated on every start/finish: controls that render later (a step, a list row) are still covered. */
  kontrol: () => readonly PortKontrol[];
  /** The polite live region. Absent -> nothing is announced, the guard still works. */
  status?: PortStatus | null;
  halaman?: PortHalaman;
  /** The currently focused element, to hand focus back after the release. */
  elemenAktif?: () => unknown;
  /** Overrides the default release (back to each control's own prior state): `true` keeps the control disabled (e.g. the resend button while its countdown runs). */
  tetapNonaktif?: (kontrol: PortKontrol) => boolean;
  /** Default `"Memproses..."`. */
  pesan?: string;
};

export const PESAN_MEMPROSES = "Memproses...";

export function buatPenjagaDom(opsi: OpsiPenjagaDom): PenjagaTunggal {
  const pesan = opsi.pesan ?? PESAN_MEMPROSES;
  let fokusSemula: PortKontrol | null = null;
  let sebelumnya = new Map<PortKontrol, boolean>();

  function pulihkan(): void {
    opsi.form?.removeAttribute?.("aria-busy");
    if (opsi.status) opsi.status.textContent = "";
    const daftar = opsi.kontrol();
    // Back to what each control was before the run (a control that was already
    // disabled stays so), unless the caller owns the answer (`tetapNonaktif`).
    for (const kontrol of daftar) {
      kontrol.disabled = opsi.tetapNonaktif ? opsi.tetapNonaktif(kontrol) === true : sebelumnya.get(kontrol) === true;
    }
    sebelumnya = new Map();
    const asal = fokusSemula;
    fokusSemula = null;
    if (asal && daftar.includes(asal) && !asal.disabled) asal.focus?.();
  }

  const inti = buatPenjagaTunggal({
    saatMulai() {
      const daftar = opsi.kontrol();
      const aktif = opsi.elemenAktif?.();
      fokusSemula = daftar.find((kontrol) => (kontrol as unknown) === aktif) ?? null;
      sebelumnya = new Map(daftar.map((kontrol) => [kontrol, kontrol.disabled]));
      opsi.form?.setAttribute?.("aria-busy", "true");
      if (opsi.status) opsi.status.textContent = pesan;
      for (const kontrol of daftar) kontrol.disabled = true;
    },
    saatSelesai(terkunci) {
      // Locked: everything stays disabled and busy until the navigation unloads the page.
      if (!terkunci) pulihkan();
    },
    saatLepas() {
      pulihkan();
    }
  });

  opsi.halaman?.addEventListener("pageshow", (peristiwa) => {
    if (peristiwa.persisted) inti.lepas();
  });

  return inti;
}

// ---------------------------------------------------------------------------
// The browser convenience every script uses.
// ---------------------------------------------------------------------------

export type OpsiPenjagaUntuk = {
  /** CSS selector of the controls to disable inside `wadah`. Default: every button and submit input. */
  selektor?: string;
  /** An explicit control list (re-evaluated each time) for controls that do not live under one region. */
  kontrol?: () => ReadonlyArray<HTMLElement | null>;
  tetapNonaktif?: (kontrol: PortKontrol) => boolean;
  pesan?: string;
};

const SELEKTOR_KONTROL = 'button, input[type="submit"]';

/**
 * The guard for one form or region of the page: its buttons are the controls,
 * `wadah` carries `aria-busy`, the layout's `[data-proses-status]` is the
 * polite status. One guard per form is shared by every step of that form (send
 * code and verify can never overlap).
 */
export function penjagaUntuk(wadah: HTMLElement | null, opsi: OpsiPenjagaUntuk = {}): PenjagaTunggal {
  const selektor = opsi.selektor ?? SELEKTOR_KONTROL;
  return buatPenjagaDom({
    form: wadah,
    // A lone button is its own region: it carries `aria-busy` and is the one control.
    kontrol: () =>
      opsi.kontrol
        ? (opsi.kontrol().filter((el) => el !== null) as unknown as PortKontrol[])
        : wadah === null
        ? []
        : wadah.matches(selektor)
          ? [wadah as HTMLButtonElement]
          : Array.from(wadah.querySelectorAll<HTMLButtonElement | HTMLInputElement>(selektor)),
    // Guarded: the unit tests run without a DOM and pass fake forms.
    status: typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-proses-status]"),
    halaman: typeof window === "undefined" ? undefined : window,
    elemenAktif: () => (typeof document === "undefined" ? null : document.activeElement),
    tetapNonaktif: opsi.tetapNonaktif,
    pesan: opsi.pesan
  });
}
