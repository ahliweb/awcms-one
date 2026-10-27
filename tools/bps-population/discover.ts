#!/usr/bin/env bun
/**
 * Builds tools/bps-population/domains.json: every BPS provincial and regency/city office with its BPS domain
 * code, the Kemendagri code it corresponds to, its official name and its website host.
 *
 * Source of truth: BPS's own link directory https://www.bps.go.id/id/tautan (the host + name lists) and each
 * office's own homepage (the `ppid.bps.go.id/?mfd=<domain>` link carries the 4-digit domain code, and a 200
 * answer validates the host). Kemendagri codes come from matching names against
 * apps/cms/data/idn-admin-regions/upstream/cahyadsn-wilayah/db/wilayah.sql (read-only); a mismatch between
 * domain code and Kemendagri code is listed, never guessed.
 *
 *   bun tools/bps-population/discover.ts [--refresh]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PoliteClient, ChallengeError } from "./lib/http";
import { parseDomainCode, parseTautan } from "./lib/parse";
import { matchRegion, parseWilayah } from "./lib/regions";
import { appendProgress, cacheDir } from "./lib/state";
import type { OfficeLevel } from "./lib/names";

const ROOT = join(import.meta.dir, "..", "..");
const WILAYAH = join(ROOT, "apps/cms/data/idn-admin-regions/upstream/cahyadsn-wilayah/db/wilayah.sql");
const OUT = join(import.meta.dir, "domains.json");

interface Probe {
  status: number;
  domain: string | null;
  error?: string;
}

async function main(): Promise<void> {
  const refresh = process.argv.includes("--refresh");
  const dir = cacheDir();
  const cachePath = join(dir, "discover-cache.json");
  const cache: Record<string, Probe> = !refresh && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const client = new PoliteClient();

  const tautan = await client.getText("https://www.bps.go.id/id/tautan");
  if (tautan.status !== 200) throw new Error(`tautan page answered ${tautan.status}`);
  const listed = parseTautan(tautan.text);
  console.log(`tautan: ${listed.provinces.length} provincial and ${listed.regencies.length} regency/city offices listed`);

  const all = [
    ...listed.provinces.map((o) => ({ ...o, level: "province" as OfficeLevel })),
    ...listed.regencies.map((o) => ({ ...o, level: "regency_city" as OfficeLevel })),
  ];
  let n = 0;
  try {
    for (const o of all) {
      n++;
      if (cache[o.host]) continue;
      try {
        const res = await client.getText(`${o.host}/id`);
        cache[o.host] = { status: res.status, domain: res.status === 200 ? parseDomainCode(res.text) : null };
      } catch (err) {
        if (err instanceof ChallengeError) throw err;
        cache[o.host] = { status: 0, domain: null, error: String(err) };
      }
      writeFileSync(cachePath, JSON.stringify(cache));
      if (n % 25 === 0) appendProgress(dir, `discover ${n}/${all.length}`);
    }
  } catch (err) {
    writeFileSync(cachePath, JSON.stringify(cache));
    throw err;
  }

  const regions = parseWilayah(readFileSync(WILAYAH, "utf8"));
  const offices = all.map((o) => {
    const probe = cache[o.host]!;
    const domain = probe.domain;
    const m = domain
      ? matchRegion(o.level, domain, o.name, regions)
      : { kemendagriCode: null, matchedName: null, how: "unmatched" as const };
    const expected = domain ? (o.level === "province" ? domain.slice(0, 2) : `${domain.slice(0, 2)}.${domain.slice(2)}`) : null;
    return {
      domain,
      level: o.level,
      kemendagriCode: m.kemendagriCode,
      name: o.name,
      kemendagriName: m.matchedName,
      host: o.host,
      hostStatus: probe.status,
      match: m.how,
      codeEqualsDomain: m.kemendagriCode !== null && m.kemendagriCode === expected,
    };
  });
  offices.sort((a, b) => (a.domain ?? "9999").localeCompare(b.domain ?? "9999"));

  const hostFailures = offices.filter((o) => o.hostStatus !== 200 || o.domain === null);
  const unmatched = offices.filter((o) => o.match === "unmatched" || o.match === "ambiguous");
  const mismatches = offices.filter((o) => o.kemendagriCode !== null && !o.codeEqualsDomain);
  const dupDomains = offices.filter((o, i) => o.domain && offices.findIndex((p) => p.domain === o.domain) !== i);
  const matchedProv = new Set(offices.filter((o) => o.level === "province").map((o) => o.kemendagriCode));
  const provincesWithoutOffice = regions.filter((r) => !r.code.includes(".") && !matchedProv.has(r.code));
  const matchedKab = new Set(offices.filter((o) => o.level === "regency_city").map((o) => o.kemendagriCode));
  const regenciesWithoutOffice = regions.filter((r) => r.code.includes(".") && !matchedKab.has(r.code));

  const doc = {
    source: "https://www.bps.go.id/id/tautan (host and name lists); each office homepage (domain code via ppid.bps.go.id/?mfd=); Kemendagri codes by name from wilayah.sql",
    counts: {
      provinceOffices: offices.filter((o) => o.level === "province").length,
      regencyCityOffices: offices.filter((o) => o.level === "regency_city").length,
      hostFailures: hostFailures.length,
      unmatched: unmatched.length,
      codeMismatches: mismatches.length,
      duplicateDomains: dupDomains.length,
      kemendagriProvincesWithoutBpsOffice: provincesWithoutOffice.length,
      kemendagriRegenciesWithoutBpsOffice: regenciesWithoutOffice.length,
    },
    kemendagriProvincesWithoutBpsOffice: provincesWithoutOffice,
    kemendagriRegenciesWithoutBpsOffice: regenciesWithoutOffice,
    offices,
  };
  writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(JSON.stringify(doc.counts, null, 2));
  for (const o of unmatched) console.log("UNMATCHED", o.domain, o.name, o.host, o.match);
  for (const o of mismatches) console.log("MISMATCH", o.domain, "->", o.kemendagriCode, o.name);
  for (const o of hostFailures) console.log("HOSTFAIL", o.host, o.hostStatus);
  for (const r of provincesWithoutOffice) console.log("NO-BPS-PROVINCE-OFFICE", r.code, r.name);
  for (const r of regenciesWithoutOffice) console.log("NO-BPS-REGENCY-OFFICE", r.code, r.name);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
