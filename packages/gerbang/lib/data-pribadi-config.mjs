/**
 * data-pribadi-config.mjs — the DATA behind `audit:data-pribadi`.
 *
 * ## Why this is a separate module from the checks
 *
 * What counts as "obviously fake", which e-mail domains are placeholders and
 * which cloud-drive hosts matter differ per product: a derived application
 * that handles personal data tightens them, one that ships public sample
 * content loosens a few. Keeping every pattern and list in this one file
 * means a derived product tunes the gate by editing data, never by editing
 * the scanner in `data-pribadi.mjs`.
 *
 * Pure data and no side effects: importing it runs nothing.
 *
 * ## Categories
 *
 *   - `national-id`       16 digits shaped like a national identity number
 *                         (region code, birth date with the day offset used
 *                         for one sex, serial) that carries no reserved
 *                         fake prefix and is not a trivial repetition.
 *   - `mobile-phone`      a mobile number that is not recognisably fake.
 *   - `email`             an address outside {@link PLACEHOLDER_EMAIL_DOMAINS}.
 *   - `file-share-link`   a cloud-drive style link carrying a file id.
 *   - `tracked-data-file` a tracked spreadsheet, CSV, archive, log or
 *                         snapshot, judged by name alone.
 *
 * Findings never print the matched value (see `audit-data-pribadi.mjs`).
 */

/** Every category the gate can report; an allow-list entry must name one. */
export const CATEGORIES = [
  "national-id",
  "mobile-phone",
  "email",
  "file-share-link",
  "tracked-data-file"
];

/**
 * Paths the scan skips: the embedded upstream subtree. A derived product
 * lists in {@link OWNED_SUBTREE_PATHS} the sub-paths of that tree it owns
 * itself; everything else under it is upstream's.
 */
export const SKIPPED_PREFIXES = ["apps/cms/"];

/**
 * Sub-paths of {@link SKIPPED_PREFIXES} a derived product declares as its
 * own and wants scanned. Each entry is a directory prefix ending in `/`.
 * Empty by default: nothing under the subtree is scanned until a product
 * says it owns it.
 *
 * @type {string[]}
 */
export const OWNED_SUBTREE_PATHS = [];

/**
 * A national identity number: 2-digit province, 2-digit regency, 2-digit
 * district, a `ddmmyy` birth date (the day is +40 for one sex), a 4-digit
 * serial. The alphanumeric look-arounds keep it out of longer tokens such
 * as hashes and base64 integrity strings.
 */
export const NATIONAL_ID_PATTERN =
  /(?<![0-9A-Za-z])[1-9]\d{5}(?:[0-3]\d|[4-7]\d)(?:0[1-9]|1[0-2])\d{2}\d{4}(?![0-9A-Za-z])/g;

/**
 * A number starting with one of these is a reserved test value. `99` is not
 * an assigned province code, so no real number begins with it.
 */
export const RESERVED_NATIONAL_ID_PREFIXES = ["99"];

/**
 * A mobile number: country code `+62`, `62` or trunk `0`, then `8`, a
 * second digit 1-9, and 7-10 more digits (separators tolerated).
 */
export const MOBILE_PHONE_PATTERN =
  /(?<![\w+.-])(?:\+62|62|0)[\s-]?8[1-9]\d(?:[\s.-]?\d){6,9}(?!\d)/g;

/**
 * An e-mail address. The domain must start with a letter and end in an
 * alphabetic TLD so a version such as `pkg@4.0.7.patch` or `pkg@1.2.3` never
 * matches.
 */
export const EMAIL_PATTERN =
  /[A-Za-z0-9._%+-]+@([A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/** A domain equal to, or a subdomain of, one of these is a placeholder. */
export const PLACEHOLDER_EMAIL_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "example.id",
  "example.co.id",
  // Indonesian "contoh" = "example": the neutral names this template's own
  // `template:init` docs and seed profiles use.
  "contoh.id",
  "contoh.com",
  "toko-contoh.id"
];

/** Whole addresses that are protocol syntax, not a person (git over SSH). */
export const PLACEHOLDER_EMAIL_ADDRESSES = ["git@github.com"];

/**
 * A domain whose last label is one of these is a placeholder: RFC 2606 and
 * 6761 names, `.local` (RFC 6762) and `.internal` (private-use).
 */
export const PLACEHOLDER_EMAIL_TLDS = [
  "example",
  "test",
  "invalid",
  "localhost",
  "local",
  "internal"
];

/**
 * Cloud-drive style links that carry a file id. Each pattern's first capture
 * group is the id; an id shorter than `minIdLength` is a placeholder such as
 * `FILE_ID`, not a real one.
 *
 * @type {{ pattern: RegExp, minIdLength: number }[]}
 */
export const FILE_SHARE_LINKS = [
  {
    pattern:
      /https?:\/\/(?:drive|docs)\.google\.com\/(?:file|document|spreadsheets|presentation|forms)\/d\/([A-Za-z0-9_-]+)/g,
    minIdLength: 20
  },
  {
    pattern: /https?:\/\/drive\.google\.com\/(?:open|uc)\?[^\s"']*\bid=([A-Za-z0-9_-]+)/g,
    minIdLength: 20
  },
  { pattern: /https?:\/\/(?:www\.)?dropbox\.com\/(?:s|scl\/fi)\/([A-Za-z0-9_-]+)/g, minIdLength: 8 },
  { pattern: /https?:\/\/1drv\.ms\/[a-z]\/(?:s!)?([A-Za-z0-9_-]+)/g, minIdLength: 8 },
  {
    pattern: /https?:\/\/onedrive\.live\.com\/[^\s"']*\bresid=([A-Za-z0-9!%_-]+)/g,
    minIdLength: 8
  },
  { pattern: /https?:\/\/mega\.nz\/(?:file|folder)\/([A-Za-z0-9_-]+)/g, minIdLength: 8 },
  { pattern: /https?:\/\/(?:[\w-]+\.)?box\.com\/s\/([A-Za-z0-9_-]+)/g, minIdLength: 8 }
];

/** Tracked file name suffixes (lower case) that are data, not source. */
export const DATA_FILE_EXTENSIONS = [
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".ods",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".log",
  ".snap",
  ".sqlite",
  ".sqlite3",
  ".db"
];

/** A path containing one of these segments is a snapshot directory. */
export const DATA_DIRECTORY_SEGMENTS = ["__snapshots__"];

/** Files larger than this are not read (the name checks still apply). */
export const MAX_SCAN_BYTES = 4 * 1024 * 1024;
