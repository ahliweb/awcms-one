/**
 * The "Dengarkan berita ini" player's browser half (issue #52) — the engine
 * behind `src/components/berita/PemutarDengar.astro`. Ported from
 * seputarborneo.com v2.4.0's `initDengar()` (`js/main.js`, its issue #70)
 * and the contract its `AGENTS.md` records.
 *
 * ## Reading units, and why the article is not one long utterance
 *
 * The reader is given the article as a list of UNITS: the title, then the
 * dek/excerpt IF the page ever renders one (`.article-dek` — `ArtikelView`
 * does not today, so that lookup is a null-safe hook, not a live unit),
 * then each block-level child of `.article-body`. Units are what "previous"/"next" move between and what
 * the highlight follows. A body with no block children at all (a legacy
 * post whose whole text is one run of `<br>`s) is treated as ONE unit
 * rather than skipped — upstream learned that the hard way.
 *
 * Inside a unit, speech is split PER SENTENCE, because Chrome silently cuts
 * an utterance off after roughly fifteen seconds. The highlight, though,
 * stays per BLOCK: upstream's prototype highlighted per sentence and it
 * broke constantly on legacy bodies whose sentences run through `<strong>`
 * and `<br>` boundaries, so the highlight follows the block the sentence
 * belongs to.
 *
 * ## Why the highlight is an outline, not a background
 *
 * `outline` + `box-shadow` paint outside the box and cannot reflow text; a
 * background/padding change on a paragraph mid-read shifts every paragraph
 * below it while the reader is listening. See `src/styles/dengar.css`.
 *
 * ## What is skipped inside the body
 *
 * `figure`, `figcaption`, `script`, `style`, `iframe`, and the ad slots
 * (`.ad-slot`) — a photo credit, an embed, or an advertiser's name read out
 * in the middle of a sentence is worse than silence. The institution logo
 * figure (issue #59) is a `figure`, so it is covered by the same rule.
 *
 * ## Persistence
 *
 * Rate and chosen voice are remembered in `localStorage` (`dengar:rate`,
 * `dengar:suara`), each read and written inside `try/catch`: a private
 * window, blocked site data, or a quota error must degrade to "the player
 * works, it just does not remember", never to a broken player.
 */

const KUNCI_RATE = "dengar:rate";
const KUNCI_SUARA = "dengar:suara";

/** Elements inside `.article-body` whose text is never part of the article. */
const DILEWATI = new Set(["FIGURE", "FIGCAPTION", "SCRIPT", "STYLE", "IFRAME", "NOSCRIPT"]);

/** The class the block currently being spoken carries. Styled as an outline — see the docblock. */
export const KELAS_DIBACA = "is-dibaca";

export type UnitBaca = {
  /** The text handed to the speech engine. */
  teks: string;
  /** The element to highlight while this unit is read, or `null` for the title. */
  elemen: HTMLElement | null;
};

/**
 * Splits a unit's text into sentence-sized utterances.
 *
 * Chrome cuts an utterance off after ~15 seconds, so a 400-word paragraph
 * spoken as one utterance simply stops mid-way with no error. Splitting on
 * sentence punctuation keeps every utterance short enough, and has the
 * side benefit that pause/resume lands on a sentence boundary.
 *
 * Abbreviations are deliberately NOT special-cased: an over-split sentence
 * costs a short pause, while an under-split one costs the rest of the
 * paragraph.
 */
export function pecahKalimat(teks: string): string[] {
  return teks
    .split(/(?<=[.!?])\s+(?=[^\s])/u)
    .map((bagian) => bagian.trim())
    .filter((bagian) => bagian.length > 0);
}

/**
 * Collects the reading units of one article.
 *
 * @param judul the article's `<h1>` text, read first
 * @param dek the excerpt element, if the page has one
 * @param badan `.article-body`
 */
export function kumpulkanUnit(
  judul: string,
  dek: HTMLElement | null,
  badan: HTMLElement | null
): UnitBaca[] {
  const unit: UnitBaca[] = [];

  const judulBersih = judul.trim();
  if (judulBersih.length > 0) unit.push({ teks: judulBersih, elemen: null });

  const dekTeks = dek?.textContent?.trim() ?? "";
  if (dekTeks.length > 0) unit.push({ teks: dekTeks, elemen: dek });

  if (!badan) return unit;

  // Structural, not `instanceof HTMLElement`: this function is pure and is
  // unit-tested outside a DOM, where that global does not exist at all —
  // and a duck-typed check is exactly as correct inside one.
  const anak = Array.from(badan.children).filter(
    (el) => !DILEWATI.has(el.tagName) && !el.classList.contains("ad-slot")
  ) as HTMLElement[];

  if (anak.length === 0) {
    // A legacy body with no block children at all (one run of `<br>`s) —
    // one unit for the whole thing beats reading nothing.
    const semua = badan.textContent?.trim() ?? "";
    if (semua.length > 0) unit.push({ teks: semua, elemen: badan });
    return unit;
  }

  for (const el of anak) {
    const teks = el.textContent?.trim() ?? "";
    if (teks.length > 0) unit.push({ teks, elemen: el });
  }

  return unit;
}

/** Reads a remembered value, tolerating every way storage can be unavailable. */
export function bacaSimpanan(kunci: string): string | null {
  try {
    return window.localStorage.getItem(kunci);
  } catch {
    return null;
  }
}

/** Writes a remembered value; a failure is never allowed to reach the reader. */
export function tulisSimpanan(kunci: string, nilai: string): void {
  try {
    window.localStorage.setItem(kunci, nilai);
  } catch {
    /* private window, blocked site data, quota — the player still works. */
  }
}

/** The Indonesian voices a device offers, in the order it offers them. */
export function suaraIndonesia(semua: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return semua.filter((suara) => suara.lang.toLowerCase().startsWith("id"));
}

function pasangPemutar(kartu: HTMLElement): void {
  const sintesis = window.speechSynthesis;

  const tombolPutar = kartu.querySelector<HTMLButtonElement>("[data-dengar-putar]");
  const ikon = kartu.querySelector<HTMLElement>("[data-dengar-ikon]");
  const label = kartu.querySelector<HTMLElement>("[data-dengar-label]");
  const tombolSebelum = kartu.querySelector<HTMLButtonElement>("[data-dengar-sebelum]");
  const tombolBerikut = kartu.querySelector<HTMLButtonElement>("[data-dengar-berikut]");
  const tombolHenti = kartu.querySelector<HTMLButtonElement>("[data-dengar-henti]");
  const progres = kartu.querySelector<HTMLElement>("[data-dengar-progres]");
  const catatan = kartu.querySelector<HTMLElement>("[data-dengar-catatan]");
  const pilihRate = kartu.querySelector<HTMLSelectElement>("[data-dengar-rate]");
  const pilihSuara = kartu.querySelector<HTMLSelectElement>("[data-dengar-suara]");
  const wadahSuara = kartu.querySelector<HTMLElement>("[data-dengar-suara-wadah]");

  if (!tombolPutar) return;

  const judul = kartu.getAttribute("data-dengar-judul") ?? "";
  const dek = document.querySelector<HTMLElement>(".article-dek");
  const badan = document.querySelector<HTMLElement>(".article-body");

  const unit = kumpulkanUnit(judul, dek, badan);
  if (unit.length === 0) return;

  let indeks = 0;
  let kalimat: string[] = [];
  let posisiKalimat = 0;
  let sedangMain = false;
  let suaraTerpilih: SpeechSynthesisVoice | null = null;

  const rateTersimpan = Number(bacaSimpanan(KUNCI_RATE));
  if (pilihRate && Number.isFinite(rateTersimpan) && rateTersimpan > 0) {
    pilihRate.value = String(rateTersimpan);
  }

  function tulisProgres(): void {
    if (progres) progres.textContent = `Bagian ${indeks + 1} dari ${unit.length}`;
  }

  function tulisCatatan(teks: string): void {
    if (catatan) catatan.textContent = teks;
  }

  function sorot(aktif: boolean): void {
    const el = unit[indeks]?.elemen;
    if (!el) return;
    el.classList.toggle(KELAS_DIBACA, aktif);
  }

  function bersihkanSorotan(): void {
    for (const u of unit) u.elemen?.classList.remove(KELAS_DIBACA);
  }

  function setTombol(main: boolean): void {
    sedangMain = main;
    tombolPutar!.setAttribute("aria-pressed", main ? "true" : "false");
    if (ikon) ikon.textContent = main ? "⏸" : "▶";
    if (label) label.textContent = main ? "Jeda" : indeks === 0 && !kalimat.length ? "Dengarkan berita ini" : "Lanjutkan";
    for (const t of [tombolSebelum, tombolBerikut, tombolHenti]) {
      if (t) t.disabled = false;
    }
  }

  function ucapkan(): void {
    const teks = kalimat[posisiKalimat];
    if (teks === undefined) {
      // End of this unit — move on, or finish.
      sorot(false);
      if (indeks + 1 >= unit.length) {
        selesai();
        return;
      }
      indeks += 1;
      mulaiUnit();
      return;
    }

    const ucapan = new SpeechSynthesisUtterance(teks);
    ucapan.lang = "id-ID";
    ucapan.rate = pilihRate ? Number(pilihRate.value) || 1 : 1;
    if (suaraTerpilih) ucapan.voice = suaraTerpilih;
    ucapan.onend = () => {
      posisiKalimat += 1;
      if (sedangMain) ucapkan();
    };
    ucapan.onerror = () => {
      tulisCatatan("Pembacaan terhenti. Coba lagi.");
      hentikan();
    };
    sintesis.speak(ucapan);
  }

  function mulaiUnit(): void {
    sintesis.cancel();
    bersihkanSorotan();
    kalimat = pecahKalimat(unit[indeks]?.teks ?? "");
    posisiKalimat = 0;
    tulisProgres();
    sorot(true);
    setTombol(true);
    ucapkan();
  }

  function selesai(): void {
    sintesis.cancel();
    bersihkanSorotan();
    sedangMain = false;
    indeks = 0;
    kalimat = [];
    posisiKalimat = 0;
    setTombol(false);
    if (label) label.textContent = "Dengarkan berita ini";
    if (progres) progres.textContent = "";
    tulisCatatan("Selesai dibacakan.");
  }

  function hentikan(): void {
    sintesis.cancel();
    bersihkanSorotan();
    sedangMain = false;
    indeks = 0;
    kalimat = [];
    posisiKalimat = 0;
    setTombol(false);
    if (label) label.textContent = "Dengarkan berita ini";
    if (progres) progres.textContent = "";
    for (const t of [tombolSebelum, tombolBerikut, tombolHenti]) {
      if (t) t.disabled = true;
    }
  }

  tombolPutar.addEventListener("click", () => {
    tulisCatatan("");
    if (!sedangMain) {
      if (kalimat.length > 0 && sintesis.paused) {
        sintesis.resume();
        setTombol(true);
        return;
      }
      mulaiUnit();
      return;
    }
    sintesis.pause();
    setTombol(false);
  });

  tombolSebelum?.addEventListener("click", () => {
    if (indeks === 0) return;
    indeks -= 1;
    mulaiUnit();
  });

  tombolBerikut?.addEventListener("click", () => {
    if (indeks + 1 >= unit.length) {
      selesai();
      return;
    }
    indeks += 1;
    mulaiUnit();
  });

  tombolHenti?.addEventListener("click", hentikan);

  pilihRate?.addEventListener("change", () => {
    tulisSimpanan(KUNCI_RATE, pilihRate.value);
    if (sedangMain) mulaiUnit();
  });

  pilihSuara?.addEventListener("change", () => {
    const daftar = suaraIndonesia(sintesis.getVoices());
    suaraTerpilih = daftar.find((s) => s.voiceURI === pilihSuara.value) ?? null;
    tulisSimpanan(KUNCI_SUARA, pilihSuara.value);
    if (sedangMain) mulaiUnit();
  });

  function muatSuara(): void {
    const daftar = suaraIndonesia(sintesis.getVoices());
    if (daftar.length === 0) return;

    kartu.removeAttribute("hidden");

    const tersimpan = bacaSimpanan(KUNCI_SUARA);
    suaraTerpilih = daftar.find((s) => s.voiceURI === tersimpan) ?? daftar[0] ?? null;

    // The picker only earns its space when the device really has a choice.
    if (daftar.length > 1 && pilihSuara && wadahSuara) {
      pilihSuara.replaceChildren(
        ...daftar.map((s) => {
          const opsi = document.createElement("option");
          opsi.value = s.voiceURI;
          opsi.textContent = s.name;
          if (s.voiceURI === suaraTerpilih?.voiceURI) opsi.selected = true;
          return opsi;
        })
      );
      wadahSuara.removeAttribute("hidden");
    }
  }

  muatSuara();
  sintesis.addEventListener?.("voiceschanged", muatSuara);

  // A reader who navigates away mid-article must not hear the rest of it
  // from a page they can no longer see (bfcache keeps the page alive).
  window.addEventListener("pagehide", () => {
    sintesis.cancel();
  });
}

export function initDengar(root: ParentNode = document): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  for (const kartu of Array.from(root.querySelectorAll<HTMLElement>("[data-dengar]"))) {
    pasangPemutar(kartu);
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initDengar());
  } else {
    initDengar();
  }
}
