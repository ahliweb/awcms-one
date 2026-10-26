/**
 * Self-validation of extracted rows. The same consistency rules the importer
 * applies, evaluated here first so a dataset that fails is never written.
 * Arithmetic is on scaled integers (BigInt) - no floating point.
 */
import { parentCode, type RegionIndex } from "./regions";
import type { OutRow } from "./tables";

const SCALE = 4;

export function toScaled(value: string): bigint {
  const [i = "0", f = ""] = value.split(".");
  return BigInt(i + f.padEnd(SCALE, "0").slice(0, SCALE));
}

export interface CheckFailure {
  check: string;
  region: string;
  detail: string;
  sourceTable: string;
}

export interface CheckReport {
  passed: number;
  skipped: number;
  failures: CheckFailure[];
  /** Same spec key, different unit or basis: the importer's unique key must distinguish them. */
  keyCollisions: number;
  duplicatesDropped: number;
  conflicts: string[];
  skipReasons: Record<string, number>;
}

function tolerance(unit: string, parts: number): bigint {
  if (unit === "jiwa") return 0n;
  // each published figure is rounded to 0.01: |diff| <= 0.005 * (parts + 1)
  return (BigInt(parts + 1) * 5n * 10n ** BigInt(SCALE)) / 1000n;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function fmt(v: bigint): string {
  const s = v.toString().padStart(SCALE + 1, "0");
  return `${s.slice(0, -SCALE)}.${s.slice(-SCALE)}`;
}

/** Drops exact duplicates (same figure read from two tables) and flags real conflicts. */
export function dedupe(rows: OutRow[]): { rows: OutRow[]; report: Pick<CheckReport, "keyCollisions" | "duplicatesDropped" | "conflicts"> } {
  const bySpecKey = new Map<string, OutRow[]>();
  const kept: OutRow[] = [];
  let dropped = 0;
  let collisions = 0;
  const conflicts: string[] = [];
  for (const r of rows) {
    const k = [r.region_code, r.dimension, r.category, r.sex, r.reference_year, r.universe].join("|");
    const prior = bySpecKey.get(k) ?? [];
    const same = prior.find((p) => p.unit === r.unit && p.figure_basis === r.figure_basis);
    if (same) {
      if (toScaled(same.value) === toScaled(r.value)) {
        dropped++;
        continue;
      }
      conflicts.push(`${r.region_code} ${r.dimension}/${r.category}/${r.sex} ${r.reference_year}: ${same.value} (table ${same.source_table}) vs ${r.value} (table ${r.source_table})`);
      continue;
    }
    if (prior.length > 0) collisions++;
    prior.push(r);
    bySpecKey.set(k, prior);
    kept.push(r);
  }
  return { rows: kept, report: { keyCollisions: collisions, duplicatesDropped: dropped, conflicts } };
}

export function runChecks(rows: OutRow[], index: RegionIndex): CheckReport {
  const failures: CheckFailure[] = [];
  let passed = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};
  const skip = (why: string) => {
    skipped++;
    skipReasons[why] = (skipReasons[why] ?? 0) + 1;
  };
  const groups = new Map<string, OutRow[]>();
  for (const r of rows) {
    if (r.unit === "rupiah") continue;
    const g = [r.region_code, r.reference_year, r.universe, r.unit, r.figure_basis, r.source_table].join("|");
    const list = groups.get(g) ?? [];
    list.push(r);
    groups.set(g, list);
  }
  const compare = (check: string, region: string, table: string, unit: string, parts: bigint[], expected: bigint, label: string) => {
    const sum = parts.reduce((a, b) => a + b, 0n);
    const d = absDiff(sum, expected);
    if (d <= tolerance(unit, parts.length)) passed++;
    else failures.push({ check, region, sourceTable: table, detail: `${label}: parts sum ${fmt(sum)} != ${fmt(expected)} (diff ${fmt(d)})` });
  };
  for (const list of groups.values()) {
    const first = list[0]!;
    const { region_code: region, unit, source_table: table } = first;
    const pick = (dimension: string, category?: string, sex?: string) =>
      list.filter((r) => r.dimension === dimension && (category === undefined || r.category === category) && (sex === undefined || r.sex === sex));
    const total = pick("total")[0];
    const sexRows = pick("sex");
    const sexVal = (s: string) => sexRows.find((r) => r.category === s);
    if (total && sexRows.length) {
      if (sexVal("laki_laki") && sexVal("perempuan")) {
        compare("sex-sum", region, table, unit, sexRows.map((r) => toScaled(r.value)), toScaled(total.value), "sex split vs total");
      } else skip("sex-sum: a sex value is not published");
    }
    for (const dim of ["age_group", "religion", "occupation"]) {
      const all = pick(dim);
      if (all.length === 0) continue;
      const both = all.filter((r) => r.sex === "");
      if (both.length && total) compare(`${dim}-sum`, region, table, unit, both.map((r) => toScaled(r.value)), toScaled(total.value), `${dim} vs total`);
      else if (both.length) skip(`${dim}-sum: no total in the same table`);
      for (const s of ["laki_laki", "perempuan"]) {
        const part = all.filter((r) => r.sex === s);
        const sv = sexVal(s);
        if (part.length && sv) compare(`${dim}-by-${s}`, region, table, unit, part.map((r) => toScaled(r.value)), toScaled(sv.value), `${dim} (${s}) vs sex value`);
        else if (part.length) skip(`${dim}-by-sex: no sex value in the same table`);
      }
    }
  }
  // children -> parent
  const byKey = new Map<string, OutRow>();
  for (const r of rows) {
    if (r.unit === "rupiah") continue;
    byKey.set([r.region_code, r.dimension, r.category, r.sex, r.reference_year, r.universe, r.unit, r.source_table].join("|"), r);
  }
  for (const r of rows) {
    if (r.unit === "rupiah") continue;
    const kids = index.childrenOf.get(r.region_code) ?? [];
    if (kids.length === 0) continue;
    const parts: bigint[] = [];
    let complete = true;
    for (const k of kids) {
      const c = byKey.get([k.code, r.dimension, r.category, r.sex, r.reference_year, r.universe, r.unit, r.source_table].join("|"));
      if (c) parts.push(toScaled(c.value));
      else {
        complete = false;
        break;
      }
    }
    if (!complete) {
      // only count as skipped when at least one child row exists in this table
      const any = kids.some((k) => byKey.has([k.code, r.dimension, r.category, r.sex, r.reference_year, r.universe, r.unit, r.source_table].join("|")));
      if (any) skip("children-sum: not every child region is published in this table");
      continue;
    }
    compare("children-sum", r.region_code, r.source_table, r.unit, parts, toScaled(r.value), `${r.dimension}/${r.category}/${r.sex || "-"} ${r.reference_year}`);
  }
  void parentCode;
  return { passed, skipped, failures, keyCollisions: 0, duplicatesDropped: 0, conflicts: [], skipReasons };
}
