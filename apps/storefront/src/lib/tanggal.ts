/**
 * WIB (`Asia/Jakarta`, UTC+7, no DST) date/time formatting for the news
 * surface (issue #28: "published/updated dates in WIB").
 *
 * ## Why this pins a timezone at all
 *
 * The sibling `media-lenterakalteng` template's own `tanggal.ts`
 * deliberately does NOT force a timezone — it formats in whatever zone the
 * build machine runs in, reasoning that a static build is produced once by
 * one machine, so internal consistency matters more than pinning a zone.
 * That reasoning does not carry over here: this issue explicitly promises a
 * READER-FACING timezone ("published ... in WIB"), which is a specific claim
 * about Indonesian news publication time, not an internal consistency
 * concern — and this app's build machine (a CI runner, most likely) has no
 * reason to run in `Asia/Jakarta` at all. `Intl.DateTimeFormat`'s own
 * `timeZone` option does the conversion; there is no manual UTC+7 offset
 * math anywhere in this file; that "no DST" note in the header exists
 * because `Asia/Jakarta` has none, so a fixed formatter is safe in a way a
 * fixed offset would not be for many other zones.
 */

const LOCALE = "id-ID";
const TIME_ZONE = "Asia/Jakarta";

/** "7 September 2026". Throws on an unparseable `iso` — a build should fail loudly on a malformed timestamp from awcms, not silently print "Invalid Date". */
export function formatTanggalPanjangWIB(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`formatTanggalPanjangWIB: "${iso}" is not a parseable date.`);
  }

  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(date);
}

/** "14.05 WIB" — 24-hour, always suffixed, so a reader never has to guess which zone a bare "14.05" means. */
export function formatWaktuWIB(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`formatWaktuWIB: "${iso}" is not a parseable date.`);
  }

  const time = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);

  return `${time} WIB`;
}

/** "7 September 2026, 14.05 WIB" — the byline's combined form. */
export function formatTanggalWaktuWIB(iso: string): string {
  return `${formatTanggalPanjangWIB(iso)}, ${formatWaktuWIB(iso)}`;
}

/** The full-precision, machine-readable form for a `<time datetime>` attribute — always UTC-suffixed ISO 8601, independent of the WIB display strings above. */
export function toDatetimeAttr(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`toDatetimeAttr: "${iso}" is not a parseable date.`);
  }
  return date.toISOString();
}

/**
 * Whether a post was genuinely edited after publication — strict `>`, not
 * `>=`, exploiting the fact awcms stamps `publishedAt`/`updatedAt`
 * identically in one statement on publish (the same fact the sibling
 * template's `pernahDiubahSetelahTerbit` relies on). `publishedAt: null`
 * (not yet published, or a row this app should never see) answers `false`
 * rather than throwing — a defensive default, not a claim about that state.
 */
export function pernahDiperbaruiSetelahTerbit(
  publishedAt: string | null,
  updatedAt: string
): boolean {
  if (!publishedAt) return false;
  return new Date(updatedAt).getTime() > new Date(publishedAt).getTime();
}

/** "September 2026" — a monthly archive's own heading, from its URL's `yyyy`/`mm` segments (`src/pages/arsip/[yyyy]/[mm].astro`), not from any post's own date. */
export function formatBulanArsipWIB(yyyy: string, mm: string): string {
  const year = Number(yyyy);
  const month = Number(mm);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`formatBulanArsipWIB: "${yyyy}/${mm}" is not a valid year/month pair.`);
  }

  // Noon UTC, not midnight: a date built at UTC midnight for a negative-UTC
  // offset zone would fall back into the PREVIOUS day in that zone. This
  // formatter only ever renders month/year, so the exact day/time within
  // the month never reaches the output — noon is simply a value nowhere
  // near either boundary.
  const date = new Date(Date.UTC(year, month - 1, 1, 12));

  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIME_ZONE,
    month: "long",
    year: "numeric"
  }).format(date);
}

/** The `{yyyy: string, mm: string}` an arsip post belongs to, in WIB — computed from `publishedAt`, never a bare UTC slice, so an article published late evening WIB is filed under the WIB calendar day/month a reader actually saw it on. */
export function arsipBulanWIB(publishedAtIso: string): { yyyy: string; mm: string } {
  const date = new Date(publishedAtIso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date);

  const yyyy = parts.find((p) => p.type === "year")?.value;
  const mm = parts.find((p) => p.type === "month")?.value;

  if (!yyyy || !mm) {
    throw new Error(`arsipBulanWIB: could not derive a year/month from "${publishedAtIso}".`);
  }

  return { yyyy, mm };
}
