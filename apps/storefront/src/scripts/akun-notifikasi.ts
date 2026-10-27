/**
 * `/akun/notifikasi` interactivity (issue #431, ADR-0048 section 7).
 *
 * Decides, from the server's answer and what only the browser knows, which of
 * the page's static panels shows (`tentukanKeadaan`), renders the versioned
 * consent text and the device list, and wires the four actions: turn on (the
 * ONLY place a permission prompt or a subscription can start - from a submit
 * click, after the text was shown), turn this device off, remove another
 * device, and change a purpose.
 *
 * Rules this file keeps:
 *  - never asks for a permission or subscribes on load, on login, on a timer;
 *  - the bearer is attached by `akun-klien.ts` per request and nowhere else;
 *    the service worker is never given it;
 *  - every message the shopper reads comes from `push-pelanggan.ts`'s mapping,
 *    never from the server's English `message`;
 *  - text is set with `textContent` only (device summaries come from the
 *    server, rendered as text, never as markup);
 *  - after an action focus moves to the `aria-live` status region so a
 *    keyboard or screen-reader user hears the outcome.
 */
import { ambilStatusPush, ubahPreferensiPush } from "../lib/akun-klien";
import { bacaSesi } from "../lib/akun-sesi";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";
import {
  aktifkanPerangkat,
  ambilPemberitahuan,
  bersihkanLokalBilaPerlu,
  buatPortPenanda,
  buatPortPeramban,
  cabutPerangkatLain,
  matikanPerangkatIni,
  pushDidukungPeramban,
  type DepsPush
} from "../lib/push-alur";
import { buatDepsNyata } from "../lib/push-deps";
import {
  PESAN_PEMBERITAHUAN,
  PUSH_PURPOSES,
  deteksiPlatform,
  parsePreferences,
  parseStatus,
  perangkatIni,
  petakanGalat,
  teksPersetujuan,
  tentukanKeadaan,
  tujuanDitawarkan,
  type GalatPush,
  type HasilMuat,
  type KeadaanPush,
  type PushDevice,
  type PushPurpose,
  type PushStatus,
  type TeksPersetujuan
} from "../lib/push-pelanggan";
import { TokoApiError } from "../lib/toko-permintaan";

const root = document.querySelector<HTMLElement>("[data-notif-root]");

if (root) {
  const namaToko = root.dataset.storeName ?? "toko";
  const bantuanPasang = root.dataset.bantuanPasang ?? "";

  const statusEl = root.querySelector<HTMLElement>("[data-notif-status]");
  const galatEl = root.querySelector<HTMLElement>("[data-notif-galat]");
  const galatPesanEl = root.querySelector<HTMLElement>("[data-notif-galat-pesan]");
  const cobaLagiButton = root.querySelector<HTMLButtonElement>("[data-notif-coba-lagi]");
  const muatUlangButton = root.querySelector<HTMLButtonElement>("[data-notif-muat-ulang]");
  const masukUlangLink = root.querySelector<HTMLAnchorElement>("[data-notif-masuk-ulang]");
  const muatUlangIzinButton = root.querySelector<HTMLButtonElement>("[data-notif-muat-ulang-izin]");
  const panels = Array.from(root.querySelectorAll<HTMLElement>("[data-panel]"));
  const form = root.querySelector<HTMLFormElement>("[data-notif-form]");
  const aktifkanButton = root.querySelector<HTMLButtonElement>("[data-notif-aktifkan]");
  const tujuanEl = root.querySelector<HTMLElement>("[data-notif-tujuan]");
  const tujuanGalatEl = root.querySelector<HTMLElement>("[data-notif-tujuan-galat]");
  const teksEl = root.querySelector<HTMLElement>("[data-notif-teks]");
  const versiEl = root.querySelector<HTMLElement>("[data-notif-versi]");
  const prefsEl = root.querySelector<HTMLElement>("[data-notif-prefs]");
  const prefsKosongEl = root.querySelector<HTMLElement>("[data-notif-prefs-kosong]");
  const teksAktifEl = root.querySelector<HTMLElement>("[data-notif-teks-aktif]");
  const versiAktifEl = root.querySelector<HTMLElement>("[data-notif-versi-aktif]");
  const nonaktifkanButton = root.querySelector<HTMLButtonElement>("[data-notif-nonaktifkan]");
  const perangkatPanel = root.querySelector<HTMLElement>('[data-panel="perangkat"]');
  const perangkatJudul = perangkatPanel?.querySelector<HTMLElement>("h2") ?? null;
  const perangkatEl = root.querySelector<HTMLElement>("[data-notif-perangkat]");
  const perangkatKosongEl = root.querySelector<HTMLElement>("[data-notif-perangkat-kosong]");
  const maksEl = root.querySelector<HTMLElement>("[data-notif-maks]");
  const bantuanPasangTautan = root.querySelector<HTMLElement>("[data-bantuan-pasang-tautan]");

  /** The last answer, kept so a purpose change or a device removal can re-render without guessing. */
  let status: PushStatus | null = null;
  let deps: DepsPush | null = null;
  const dapatkanDeps = (): DepsPush => (deps ??= buatDepsNyata());

  // -------------------------------------------------------------------------
  // Small DOM helpers
  // -------------------------------------------------------------------------

  function pasangKeadaan(nama: string | null, perangkatTampil: boolean): void {
    for (const panel of panels) {
      const name = panel.dataset.panel;
      if (name === "perangkat") panel.hidden = !perangkatTampil;
      else panel.hidden = name !== nama;
    }
  }

  function umumkan(pesan: string, fokus = true): void {
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.textContent = pesan;
    if (fokus) statusEl.focus();
  }

  function sembunyikanGalat(): void {
    if (galatEl) galatEl.hidden = true;
    if (cobaLagiButton) cobaLagiButton.hidden = true;
    if (muatUlangButton) muatUlangButton.hidden = true;
    if (masukUlangLink) masukUlangLink.hidden = true;
  }

  function tampilkanGalat(galat: GalatPush): void {
    if (!galatEl || !galatPesanEl) return;
    galatPesanEl.textContent = galat.pesan;
    galatEl.hidden = false;
    if (cobaLagiButton) cobaLagiButton.hidden = galat.tindakan !== "coba_lagi";
    if (muatUlangButton) muatUlangButton.hidden = galat.tindakan !== "muat_ulang";
    if (masukUlangLink) masukUlangLink.hidden = galat.tindakan !== "masuk_ulang";
    if (galat.tindakan === "hapus_perangkat" && perangkatJudul) {
      // The way forward is the device list: take the keyboard focus there.
      perangkatJudul.focus();
    } else {
      galatEl.focus();
    }
  }

  function bersihkan(el: Element | null): void {
    if (el) el.replaceChildren();
  }

  function buatCheckbox(opsi: { id: string; nilai: string; label: string; deskripsi: string; dicentang: boolean }): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = "akun-consent-label akun-notif-opsi";
    label.htmlFor = opsi.id;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = opsi.id;
    input.value = opsi.nilai;
    input.checked = opsi.dicentang;
    input.setAttribute("aria-describedby", `${opsi.id}-desk`);

    const teks = document.createElement("span");
    const judul = document.createElement("span");
    judul.textContent = opsi.label;
    const deskripsi = document.createElement("small");
    deskripsi.id = `${opsi.id}-desk`;
    deskripsi.textContent = opsi.deskripsi;
    teks.append(judul, document.createElement("br"), deskripsi);

    label.append(input, teks);
    return label;
  }

  function renderTeks(target: HTMLElement | null, teks: TeksPersetujuan): void {
    if (!target) return;
    target.replaceChildren(
      ...teks.paragraf(namaToko).map((isi) => {
        const p = document.createElement("p");
        p.textContent = isi;
        return p;
      })
    );
  }

  function formatTanggal(iso: string): string {
    const tanggal = new Date(iso);
    if (Number.isNaN(tanggal.getTime())) return "";
    return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(tanggal);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderPerangkat(devices: PushDevice[], tersimpan: string | null): void {
    if (!perangkatEl) return;
    bersihkan(perangkatEl);

    if (perangkatKosongEl) perangkatKosongEl.hidden = devices.length > 0;

    for (const device of devices) {
      const ini = perangkatIni(device, tersimpan);
      const item = document.createElement("li");
      const kartu = document.createElement("div");
      kartu.className = "akun-card akun-perangkat";

      const kepala = document.createElement("div");
      kepala.className = "akun-perangkat-kepala";
      const nama = document.createElement("strong");
      nama.textContent = device.userAgentSummary ?? "Perangkat tidak dikenal";
      kepala.append(nama);
      if (ini) {
        const lencana = document.createElement("span");
        lencana.className = "akun-badge-utama";
        lencana.textContent = "Perangkat ini";
        kepala.append(lencana);
      }

      const rincian = document.createElement("p");
      rincian.className = "akun-countdown";
      const terdaftar = formatTanggal(device.registeredAt);
      const terakhir = device.lastSuccessAt ? formatTanggal(device.lastSuccessAt) : "";
      rincian.textContent =
        `${device.endpointMasked}` +
        (terdaftar ? ` · Terdaftar ${terdaftar}` : "") +
        (terakhir ? ` · Pemberitahuan terakhir dikirim ${terakhir}` : " · Belum ada pemberitahuan terkirim");

      const aksi = document.createElement("div");
      aksi.className = "akun-actions";
      const hapus = document.createElement("button");
      hapus.type = "button";
      hapus.className = "btn btn--quiet btn--sm akun-btn-danger";
      hapus.textContent = ini ? "Hapus perangkat ini" : "Hapus";
      hapus.setAttribute("aria-label", `Hapus ${device.userAgentSummary ?? "perangkat tidak dikenal"}${ini ? " (perangkat ini)" : ""} dari daftar notifikasi`);
      hapus.addEventListener("click", () => void hapusPerangkat(device, ini, hapus));
      aksi.append(hapus);

      kartu.append(kepala, rincian, aksi);
      item.append(kartu);
      perangkatEl.append(item);
    }
  }

  function renderPreferensi(statusSaatIni: PushStatus, teks: TeksPersetujuan): void {
    if (!prefsEl) return;
    bersihkan(prefsEl);
    const ditawarkan = tujuanDitawarkan(statusSaatIni.capability, teks);
    for (const purpose of ditawarkan) {
      const pref = statusSaatIni.preferences.find((p) => p.purpose === purpose);
      prefsEl.append(
        buatCheckbox({
          id: `notif-pref-${purpose}`,
          nilai: purpose,
          label: teks.tujuan[purpose].label,
          deskripsi: teks.tujuan[purpose].deskripsi,
          dicentang: pref?.enabled === true
        })
      );
    }
    for (const input of prefsEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
      input.addEventListener("change", () => void ubahTujuan(input, teks));
    }
    perbaruiPrefsKosong();
  }

  function perbaruiPrefsKosong(): void {
    if (!prefsEl || !prefsKosongEl) return;
    const adaYangAktif = Array.from(prefsEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).some(
      (input) => input.checked
    );
    prefsKosongEl.hidden = adaYangAktif;
  }

  function renderForm(statusSaatIni: PushStatus, teks: TeksPersetujuan): void {
    renderTeks(teksEl, teks);
    if (versiEl) versiEl.textContent = teks.version;
    if (tujuanGalatEl) tujuanGalatEl.textContent = "";
    if (!tujuanEl) return;
    bersihkan(tujuanEl);
    for (const purpose of tujuanDitawarkan(statusSaatIni.capability, teks)) {
      // Nothing is on by default. Only a purpose this account already granted
      // under THIS text version comes back ticked (the shopper's own earlier choice).
      const sebelumnya = statusSaatIni.preferences.find((p) => p.purpose === purpose);
      const dicentang =
        sebelumnya?.enabled === true && sebelumnya.consentTextVersion === statusSaatIni.capability.consentTextVersion;
      tujuanEl.append(
        buatCheckbox({
          id: `notif-tujuan-${purpose}`,
          nilai: purpose,
          label: teks.tujuan[purpose].label,
          deskripsi: teks.tujuan[purpose].deskripsi,
          dicentang
        })
      );
    }
  }

  function render(keadaan: KeadaanPush, perangkatTersimpan: string | null): void {
    sembunyikanGalat();
    const adaStatus = status !== null && status.capability.enabled;
    const tampilPerangkat =
      adaStatus &&
      (keadaan.jenis === "siap" ||
        keadaan.jenis === "aktif" ||
        keadaan.jenis === "izin_ditolak" ||
        keadaan.jenis === "tidak_didukung" ||
        keadaan.jenis === "ios_pasang" ||
        keadaan.jenis === "ios_lama");

    switch (keadaan.jenis) {
      case "memuat":
        pasangKeadaan("memuat", false);
        break;
      case "galat":
        pasangKeadaan(null, false);
        tampilkanGalat(keadaan.galat);
        break;
      case "server_nonaktif":
      case "kunci_rusak": {
        pasangKeadaan("server_nonaktif", false);
        const alasan = keadaan.jenis === "kunci_rusak" ? "kunci_rusak" : keadaan.alasan;
        for (const p of root!.querySelectorAll<HTMLElement>("[data-alasan]")) p.hidden = p.dataset.alasan !== alasan;
        break;
      }
      case "ios_pasang":
        pasangKeadaan("ios_pasang", tampilPerangkat);
        if (bantuanPasangTautan) bantuanPasangTautan.hidden = bantuanPasang === "";
        break;
      case "siap":
      case "aktif":
      case "izin_ditolak":
      case "tidak_didukung":
      case "ios_lama":
      case "tamu":
      case "disembunyikan":
      case "diblokir":
      case "belum_verifikasi":
        pasangKeadaan(
          keadaan.jenis === "siap" ? "aktifkan" : keadaan.jenis,
          tampilPerangkat
        );
        break;
    }

    if (status && status.capability.enabled) {
      const teks = teksPersetujuan(status.capability.consentTextVersion);
      if (maksEl) maksEl.textContent = String(status.capability.maxDevices);
      renderPerangkat(status.devices, perangkatTersimpan);

      if (!teks) {
        // The page does not know the wording the server will accept: it must not
        // record a grant against text the shopper never saw.
        if (keadaan.jenis === "siap" || keadaan.jenis === "aktif") {
          pasangKeadaan(null, tampilPerangkat);
          tampilkanGalat({
            kode: "CONSENT_TEXT_UNKNOWN",
            pesan: "Teks persetujuan di halaman ini belum cocok dengan versi terbaru toko. Muat ulang halaman, lalu coba lagi.",
            tindakan: "muat_ulang",
            tunggu: null
          });
        }
        return;
      }
      if (keadaan.jenis === "siap") renderForm(status, teks);
      if (keadaan.jenis === "aktif") {
        renderPreferensi(status, teks);
        renderTeks(teksAktifEl, teks);
        if (versiAktifEl) versiAktifEl.textContent = teks.version;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  function lingkungan() {
    return deteksiPlatform({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      displayModeStandalone: window.matchMedia?.("(display-mode: standalone)").matches ?? false,
      navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
      secureContext: window.isSecureContext === true,
      hasServiceWorker: "serviceWorker" in navigator,
      hasPushManager: "PushManager" in window,
      hasNotification: "Notification" in window,
      permission: "Notification" in window ? Notification.permission : "denied"
    });
  }

  async function ambilHasil(): Promise<HasilMuat> {
    // Never render a previous account's devices for a page that no longer has them.
    status = null;
    if (!bacaSesi()) return { jenis: "tamu" };

    try {
      const diurai = parseStatus(await ambilStatusPush());
      if (!diurai) {
        return {
          jenis: "galat",
          galat: petakanGalat(new TokoApiError("The status answer could not be read.", 200, "INVALID_RESPONSE"))
        };
      }
      status = diurai;
      return { jenis: "tersedia", status: diurai };
    } catch (error) {
      status = null;
      const galat = petakanGalat(error);
      if (galat.tindakan === "sembunyikan") return { jenis: "disembunyikan" };
      if (galat.kode === "UNAUTHENTICATED") return { jenis: "tamu" };
      if (galat.kode === "ACCOUNT_BLOCKED") return { jenis: "diblokir" };
      if (galat.kode === "ACCOUNT_NOT_VERIFIED") return { jenis: "belum_verifikasi" };
      return { jenis: "galat", galat };
    }
  }

  async function muat(): Promise<void> {
    sembunyikanGalat();
    pasangKeadaan("memuat", false);

    // A marker that belongs to no session / another account is cleared first
    // (no network involved), so what follows is judged on a clean slate.
    if (pushDidukungPeramban() || buatPortPenanda().baca()) {
      await bersihkanLokalBilaPerlu(dapatkanDeps());
    }

    const hasil = await ambilHasil();
    const platform = lingkungan();
    const penanda = buatPortPenanda().baca();

    let langgananAda = false;
    if (platform.pushDidukung) {
      langgananAda = (await buatPortPeramban().ambilLangganan()) !== null;
    }

    // A marker without a live subscription is stale.
    if (penanda && !langgananAda) buatPortPenanda().hapus();

    const keadaan = tentukanKeadaan({
      hasil,
      platform,
      perangkatTersimpan: langgananAda ? (penanda?.deviceId ?? null) : null,
      langgananAda
    });

    // This browser is subscribed AND the server lists it as current, but the
    // marker was lost: restore it so a later sign-out can revoke the device.
    if (keadaan.jenis === "aktif" && status && bacaSesi()) {
      const saya = status.devices.find((device) => device.current);
      if (saya && (!penanda || penanda.deviceId !== saya.id)) {
        buatPortPenanda().tulis({ deviceId: saya.id, accountId: bacaSesi()!.account.id, at: new Date().toISOString() });
      }
    }

    render(keadaan, langgananAda ? (penanda?.deviceId ?? null) : null);

    const pemberitahuan = ambilPemberitahuan();
    if (pemberitahuan) umumkan(PESAN_PEMBERITAHUAN[pemberitahuan], false);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function tujuanTercentang(): PushPurpose[] {
    if (!tujuanEl) return [];
    return Array.from(tujuanEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))
      .filter((input) => input.checked)
      .map((input) => input.value)
      .filter((nilai): nilai is PushPurpose => (PUSH_PURPOSES as readonly string[]).includes(nilai));
  }

  form?.addEventListener("submit", (event) => {
    // `preventDefault` and the call below stay SYNCHRONOUS in this handler: the
    // browser's permission prompt must start inside the user gesture.
    event.preventDefault();
    sembunyikanGalat();
    if (tujuanGalatEl) tujuanGalatEl.textContent = "";

    const sesi = bacaSesi();
    if (!status || !sesi) return;

    const purposes = tujuanTercentang();
    if (purposes.length === 0) {
      if (tujuanGalatEl) tujuanGalatEl.textContent = "Pilih minimal satu jenis notifikasi.";
      tujuanEl?.querySelector<HTMLInputElement>("input[type=checkbox]")?.focus();
      return;
    }

    void jalankanAktifkan(purposes, sesi.account.id);
  });

  async function jalankanAktifkan(purposes: PushPurpose[], akunId: string): Promise<void> {
    if (!status) return;
    if (aktifkanButton) aktifkanButton.disabled = true;
    umumkan("Mengaktifkan notifikasi…", false);

    // The promise is created here, in the submit handler's own call stack.
    const hasil = await aktifkanPerangkat(dapatkanDeps(), { capability: status.capability, purposes, akunId });

    if (aktifkanButton) aktifkanButton.disabled = false;

    if (!hasil.ok) {
      if (statusEl) statusEl.hidden = true;
      tampilkanGalat(hasil.galat);
      // The permission may have changed (denied): re-render from facts.
      if (hasil.galat.kode === "PERMISSION_DENIED") await muat();
      return;
    }

    await muat();
    umumkan("Notifikasi diaktifkan di perangkat ini.");
  }

  async function ubahTujuan(input: HTMLInputElement, teks: TeksPersetujuan): Promise<void> {
    if (!status) return;
    const purpose = input.value as PushPurpose;
    const diinginkan = input.checked;
    input.disabled = true;
    sembunyikanGalat();

    try {
      // Turning ON records the version of the text the shopper can read on this
      // very page; turning OFF needs none.
      const jawaban = await ubahPreferensiPush({ [purpose]: diinginkan }, diinginkan ? teks.version : undefined);
      const diurai = (jawaban as { preferences?: unknown } | null)?.preferences;
      if (Array.isArray(diurai) && status) status = { ...status, preferences: parsePreferences(diurai) };
      umumkan(
        diinginkan
          ? `${teks.tujuan[purpose].label} diaktifkan.`
          : `${teks.tujuan[purpose].label} dimatikan.`
      );
    } catch (error) {
      // Never leave the box showing a state the server did not confirm.
      input.checked = !diinginkan;
      const galat = petakanGalat(error);
      if (galat.kode === "UNAUTHENTICATED") {
        await muat();
        return;
      }
      tampilkanGalat(galat);
    } finally {
      input.disabled = false;
      perbaruiPrefsKosong();
    }
  }

  nonaktifkanButton?.addEventListener("click", async () => {
    nonaktifkanButton.disabled = true;
    sembunyikanGalat();
    const tersimpan = buatPortPenanda().baca()?.deviceId ?? status?.devices.find((d) => d.current)?.id ?? null;
    const hasil = await matikanPerangkatIni(dapatkanDeps(), tersimpan);
    nonaktifkanButton.disabled = false;
    await muat();
    umumkan(
      hasil.terkonfirmasi
        ? "Notifikasi dimatikan di perangkat ini."
        : "Notifikasi sudah dimatikan di perangkat ini, tetapi server belum bisa dihubungi, jadi perangkat masih tercantum di daftar. Coba hapus lagi dari daftar perangkat nanti."
    );
  });

  async function hapusPerangkat(device: PushDevice, ini: boolean, tombol: HTMLButtonElement): Promise<void> {
    tombol.disabled = true;
    sembunyikanGalat();

    if (ini) {
      const hasil = await matikanPerangkatIni(dapatkanDeps(), device.id);
      await muat();
      umumkan(
        hasil.terkonfirmasi
          ? "Perangkat ini dihapus dan notifikasi dimatikan."
          : "Notifikasi sudah dimatikan di perangkat ini, tetapi server belum bisa dihubungi. Coba hapus lagi nanti."
      );
      return;
    }

    const { galat } = await cabutPerangkatLain(dapatkanDeps(), device.id);
    if (galat) {
      tombol.disabled = false;
      if (galat.kode === "UNAUTHENTICATED") {
        await muat();
        return;
      }
      tampilkanGalat(galat);
      return;
    }
    await muat();
    umumkan("Perangkat dihapus dari daftar notifikasi.");
  }

  cobaLagiButton?.addEventListener("click", () => void muat());
  muatUlangButton?.addEventListener("click", () => window.location.reload());
  muatUlangIzinButton?.addEventListener("click", () => window.location.reload());

  void muat();
  window.addEventListener(AKUN_EVENT_NAME, () => void muat());
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "awcms-one:akun:v1") void muat();
  });
}
