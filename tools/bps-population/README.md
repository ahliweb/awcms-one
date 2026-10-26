# tools/bps-population

Network crawl for issue #497 (population statistics from BPS "Dalam Angka" publications). Root-owned tooling,
Bun, argv-only spawns. Nothing here touches `apps/cms`. PDFs are never committed: they live in
`$BPS_CACHE_DIR` (default `~/.cache/awcms-bps-population`).

## Commands

```
bun tools/bps-population/discover.ts [--refresh]
bun tools/bps-population/fetch.ts --stage <1|2|3> [--province 62] [--limit N] [--year 2026] [--retry-missing] [--dry-run]
```

- `discover.ts` writes `domains.json` from BPS's own link directory (`https://www.bps.go.id/id/tautan`), probes
  every office homepage politely (200 validates the host; its `ppid.bps.go.id/?mfd=NNNN` link gives the BPS
  domain code) and matches names to Kemendagri codes in `wilayah.sql` (read-only). Mismatches between BPS
  domain and Kemendagri code, unmatched names and Kemendagri regions without a BPS office are listed in the
  file and printed, never guessed.
- `fetch.ts` finds each office's `<Name> Dalam Angka <year>` (falls back to year-1 only when the year is
  absent, and records `fallbackYear`), reads catalogue/publication number/ISSN from the publication page,
  downloads to `$BPS_CACHE_DIR/pdf/<domain>-dalam-angka-<year>.pdf`, and records sha256, bytes and pages
  (`pdfinfo`) in `$BPS_CACHE_DIR/state.json`. An existing readable file is adopted, not re-downloaded.

Stages: 1 = province 62 office + its regency/city offices; 2 = every provincial office; 3 = every
regency/city office, one province at a time with `--province <Kemendagri province code>`.

## Resuming

Re-run the same command. `done` items are skipped; `failed` ones are retried; `missing` (no publication, or
the download server answered HTTP 200 with `{"status":"error",...}`) are retried only with `--retry-missing`.
A progress line per province is appended to `$BPS_CACHE_DIR/progress.log`.

## Politeness and safety

One request at a time, at least 2 s apart (plus jitter; owner-approved floor), backoff 10/30/90 s on 429/5xx, a normal browser
user agent, and a hard stop (exit code 2, recorded in `state.json` and `progress.log`) on a 403 or a
Cloudflare challenge: no stealth, no proxy. The crawl stops when free disk space drops below 15 GB.

## How the list is read

`/id/publication` is client rendered through a Next.js server action (`getListPublication`). The action id is
build specific, so it is discovered at run time from the publication page's JS chunk and cached in
`state.json`; a stale id is rediscovered once. If BPS changes the layout the crawl fails loudly rather than
guessing.

## Offices

BPS has 34 provincial offices and 514 regency/city offices. Kemendagri's four newer Papua provinces have no BPS
office of their own (their hosts do not resolve); their regencies are served by BPS offices whose domain code
still starts with 94/91/92, so domain and Kemendagri codes differ there (see `domains.json`).
