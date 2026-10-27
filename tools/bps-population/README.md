# tools/bps-population

Network crawl for issue #497 (population statistics from BPS "Dalam Angka" publications). Root-owned tooling,
Bun, argv-only spawns. Nothing here touches `apps/cms`. PDFs are never committed: they live in
`$BPS_CACHE_DIR` (default `~/.cache/awcms-bps-population`).

## Commands

```
bun tools/bps-population/discover.ts [--refresh]
bun tools/bps-population/fetch.ts --help
bun tools/bps-population/fetch.ts --stage <1|2|3|4> [--province NN] [--limit N] [--year 2026] [--retry-missing] [--dry-run]
bun tools/bps-population/fetch.ts --province-full NN
bun tools/bps-population/fetch.ts --all-provinces-full
```

- `discover.ts` writes `domains.json` from BPS's own link directory (`https://www.bps.go.id/id/tautan`), probes
  every office homepage politely (200 validates the host; its `ppid.bps.go.id/?mfd=NNNN` link gives the BPS
  domain code) and matches names to Kemendagri codes in `wilayah.sql` (read-only, with a small documented alias
  table for abbreviations and renames). Mismatches between BPS domain and Kemendagri code (BPS numbers
  regencies in its own order) and unmatched names are listed in the file and printed, never guessed.
- `fetch.ts` finds each office's `<Name> Dalam Angka <year>` (falls back to year-1 only when the year is
  absent, and records `fallbackYear`), reads catalogue/publication number/ISSN from the publication page,
  downloads to `$BPS_CACHE_DIR/pdf/<domain>-dalam-angka-<year>.pdf`, and records sha256, bytes and pages
  (`pdfinfo`) in `$BPS_CACHE_DIR/state.json`. An existing readable file is adopted, not re-downloaded.

Stages: 1 = province 62 office + its regency/city offices; 2 = every provincial office; 3 = every
regency/city office; 4 = the Kecamatan Dalam Angka of every regency/city office (`pdf/kecamatan/<code>-<year>.pdf`,
mapped to Kemendagri district codes by name within the regency; ambiguous or unmatched titles are logged, not
guessed; a 2026 file whose download answers the JSON 404 error falls back to 2025). Stages 2-4 take
`--province <Kemendagri province code>`. `--province-full NN` walks one province completely (provincial, then
regency/city, then Kecamatan); `--all-provinces-full` does that for every province in code order and writes
`PROVINCE-DONE <code> <counts>` to `progress.log` after each, so a finished province can be extracted and its
PDFs removed before disk fills.

## Resume

Everything is safe to interrupt at any moment (Ctrl-C, SIGTERM, kill -9, power or network loss):

- `state.json` is written to a temp file and renamed after EVERY item, so it is never torn.
- A leftover `*.part` is deleted at start and the file is downloaded again.
- Done items are skipped; `failed` ones are retried; `missing`/`unmatched` only with `--retry-missing`.
- SIGINT/SIGTERM abandon the current file (its `.part` is removed), log `INTERRUPTED` and exit.

To resume, re-run the command that was running:

```
cd /home/data/dev_bun/awcms-one
nohup bun tools/bps-population/fetch.ts --all-provinces-full >> ~/.cache/awcms-bps-population/fetch-runner.log 2>&1 &
```

Finished provinces (`provincesDone` in `state.json`) are skipped by `--all-provinces-full`; within the
interrupted province the per-item state skips what is done. To redo one province, delete its key from
`provincesDone` or run `--province-full NN`.

Disk: below 15 GB free the run pauses (polling every 10 min, logged `PAUSED`/`RESUMED`) instead of failing; delete
archived PDFs to let it continue. A transfer that receives no bytes for 60 s (or takes over 15 min) is aborted,
its `.part` removed and retried after 30 s / 2 min / 5 min, then recorded as failed ("stalled").

## Politeness and safety

One request at a time, at least 2 s apart (plus jitter; owner-approved floor), backoff 10/30/90 s on 429/5xx, a
normal browser user agent. On a 403 or Cloudflare challenge: pause 15 min and retry that URL once, pause 60 min
and retry once more, then stop (exit code 2, recorded in `state.json` and `progress.log`). No stealth, no proxy,
no UA or IP rotation; a VPN or hosting network egress is a reason to stop and report, not to retry.

## How the list is read

`/id/publication` is client rendered through a Next.js server action (`getListPublication`). The action id is
build specific, so it is discovered at run time from the publication page's JS chunk and cached in
`state.json`; a stale id is rediscovered once. If BPS changes the layout the crawl fails loudly rather than
guessing.

## Offices

BPS has 34 provincial offices and 514 regency/city offices. Kemendagri's four newer Papua provinces have no BPS
office of their own (their hosts do not resolve); their regencies are served by BPS offices whose domain code
still starts with 94/91/92, so domain and Kemendagri codes differ there (see `domains.json`).
