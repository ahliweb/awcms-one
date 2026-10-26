/**
 * Pure parsers for the BPS web surface. Every function takes text or bytes and returns data; nothing
 * here performs I/O, so it is unit-tested without a network.
 */
import { slugify } from "./names";

export interface ListedOffice {
  host: string;
  name: string;
}

function cleanText(s: string): string {
  return s
    .replace(/<!--\s*-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const ANCHOR = /<a [^>]*href="(https:\/\/[a-z0-9-]+\.bps\.go\.id)"[^>]*>(.*?)<\/a>/g;

/**
 * The "Daftar Tautan" page (https://www.bps.go.id/id/tautan) holds two lists: "Website Badan Pusat Statistik
 * Provinsi" and "Website Badan Pusat Statistik Kabupaten/Kota". Returns both, in page order.
 */
export function parseTautan(html: string): { provinces: ListedOffice[]; regencies: ListedOffice[] } {
  const p = html.indexOf("Website Badan Pusat Statistik Provinsi<ul");
  const k = html.indexOf("Website Badan Pusat Statistik Kabupaten/Kota<ul");
  if (p < 0 || k < 0) throw new Error("tautan page: expected both office lists, layout changed");
  const take = (from: number): ListedOffice[] => {
    const end = html.indexOf("</ul>", from);
    const out: ListedOffice[] = [];
    for (const m of html.slice(from, end).matchAll(ANCHOR)) {
      out.push({ host: m[1]!, name: cleanText(m[2]!) });
    }
    return out;
  };
  return { provinces: take(p), regencies: take(k) };
}

/**
 * The 4-digit BPS domain code an office's own homepage declares: the PPID link (`ppid.bps.go.id/?mfd=6271`),
 * else the search form's hidden `mfd` input. Other `mfd=` mentions on a page can belong to the province.
 */
export function parseDomainCode(html: string): string | null {
  const ppid = /ppid\.bps\.go\.id\/\?mfd=(\d{4})\b/.exec(html);
  if (ppid) return ppid[1]!;
  const input = /name="mfd"\s+value="(\d{4})"/.exec(html);
  return input ? input[1]! : null;
}

/** The "Unduh Publikasi" link of a publication page, or null. */
export function extractDownloadLink(html: string): string | null {
  const m = /href="(https:\/\/webapi\.bps\.go\.id\/download\.php\?f=[^"]+)"/.exec(html);
  return m ? m[1]!.replace(/&amp;/g, "&") : null;
}

export interface PublicationPageMeta {
  catalogueNumber: string | null;
  publicationNumber: string | null;
  issn: string | null;
  releaseDateText: string | null;
}

function tableValue(html: string, label: string): string | null {
  const re = new RegExp(`<td>\\s*${label}\\s*</td>\\s*<td>[^<]*</td>\\s*<td>([^<]*)</td>`);
  const m = re.exec(html);
  const v = m ? m[1]!.trim() : "";
  return v === "" ? null : v;
}

/** Catalogue number, publication number, ISSN and release date from the page's metadata table. */
export function parsePublicationPage(html: string): PublicationPageMeta {
  return {
    catalogueNumber: tableValue(html, "Nomor Katalog"),
    publicationNumber: tableValue(html, "Nomor Publikasi"),
    issn: tableValue(html, "ISSN/ISBN"),
    releaseDateText: tableValue(html, "Tanggal Rilis"),
  };
}

/**
 * BPS's download server answers HTTP 200 with a small JSON body for a missing file, e.g.
 * `{"status":"error","message":"Remote server error (404)."}`. Returns the message, or null when the
 * bytes are not that error.
 */
export function detectJsonError(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, Math.min(bytes.length, 2048));
  if (head.length === 0) return "empty body";
  const first = String.fromCharCode(head[0]!);
  if (first !== "{" && first !== "<") return null;
  const text = new TextDecoder().decode(head).trim();
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(new TextDecoder().decode(bytes)) as { status?: unknown; message?: unknown };
      if (j && typeof j === "object" && j.status === "error") return String(j.message ?? "error");
    } catch {
      return "unparseable JSON body";
    }
    return null;
  }
  return "HTML body instead of a PDF";
}

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
}

/** A Cloudflare challenge or block page: never bypassed, always a reason to stop. */
export function isChallenge(status: number, headers: Headers, bodyHead: string): boolean {
  if (headers.get("cf-mitigated")?.toLowerCase() === "challenge") return true;
  if (status === 403) return true;
  return /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(bodyHead) || /Attention Required! \| Cloudflare/i.test(bodyHead);
}

/** The Next.js server action id of `getListPublication`, read from the publication page's JS chunk. */
export function extractActionId(js: string): string | null {
  const m = /createServerReference\)?\(\s*"([0-9a-f]{20,})"[^"]*?(?:"[^"]*"[^"]*?)*?"getListPublication"/.exec(js);
  if (m) return m[1]!;
  const m2 = /createServerReference\("([0-9a-f]{20,})",[^)]*"getListPublication"\)/.exec(js);
  return m2 ? m2[1]! : null;
}

/** The chunk URL (path) of the publication page's own JS, from the publication page HTML. */
export function findPublicationChunk(html: string): string | null {
  const m = /\/_next\/static\/chunks\/app\/%5Blang%5D\/publication\/page-[0-9a-f]+\.js/.exec(html);
  return m ? m[0] : null;
}

export interface ListedPublication {
  pubId: string;
  title: string;
  issn: string | null;
  releaseDate: string | null;
  pdf: string | null;
  sizeText: string | null;
}

export interface ListPage {
  page: number;
  pages: number;
  total: number;
  items: ListedPublication[];
}

/**
 * Splits a text/x-component (React flight) body into rows by id. A text row is `id:T<hexLength>,<bytes>` and
 * carries exactly that many UTF-8 bytes with NO trailing newline (the next row can follow directly, and the
 * text may itself contain newlines); every other row ends at a newline.
 */
export function rscRows(body: string): Map<string, string> {
  const buf = Buffer.from(body, "utf8");
  const rows = new Map<string, string>();
  let pos = 0;
  while (pos < buf.length) {
    const colon = buf.indexOf(0x3a, pos);
    if (colon < 0) break;
    const id = buf.toString("utf8", pos, colon);
    if (!/^[0-9a-f]+$/i.test(id)) break;
    let start = colon + 1;
    if (buf[start] === 0x54 /* T */) {
      const comma = buf.indexOf(0x2c, start);
      const len = Number.parseInt(buf.toString("utf8", start + 1, comma), 16);
      if (comma < 0 || Number.isNaN(len)) break;
      rows.set(id, buf.toString("utf8", comma + 1, comma + 1 + len));
      pos = comma + 1 + len;
    } else {
      let end = buf.indexOf(0x0a, start);
      if (end < 0) end = buf.length;
      rows.set(id, buf.toString("utf8", start, end));
      pos = end + 1;
    }
  }
  return rows;
}

/** Parses the text/x-component body of the getListPublication server action. */
export function parseListResponse(body: string): ListPage {
  const line = rscRows(body).get("1");
  if (!line) throw new Error("server action response has no row 1 (action id stale?)");
  const parsed = JSON.parse(line) as { status?: boolean; response?: unknown };
  const resp = parsed.response as { data?: unknown } | undefined;
  const data = resp?.data;
  if (!Array.isArray(data)) {
    // Zero results come back without a data array.
    if (parsed.status === true) return { page: 1, pages: 0, total: 0, items: [] };
    throw new Error("server action response has an unexpected shape");
  }
  const head = (data[0] ?? {}) as { page?: number; pages?: number; total?: number };
  const rows = (Array.isArray(data[1]) ? data[1] : []) as Array<Record<string, unknown>>;
  return {
    page: Number(head.page ?? 1),
    pages: Number(head.pages ?? 1),
    total: Number(head.total ?? rows.length),
    items: rows.map((r) => ({
      pubId: String(r.pub_id ?? ""),
      title: String(r.title ?? ""),
      issn: r.issn ? String(r.issn) : null,
      releaseDate: r.rl_date ? String(r.rl_date) : null,
      pdf: r.pdf ? String(r.pdf) : null,
      sizeText: r.size ? String(r.size) : null,
    })),
  };
}

/** `https://<host>/id/publication/YYYY/MM/DD/<pubId>/<slug>.html` */
export function publicationPageUrl(host: string, releaseDate: string, pubId: string, title: string): string {
  const [y, m, d] = releaseDate.split("-");
  return `${host}/id/publication/${y}/${m}/${d}/${pubId}/${slugify(title)}.html`;
}
