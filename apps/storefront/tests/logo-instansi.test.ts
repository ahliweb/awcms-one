/**
 * Unit coverage for the institution emblem (issue #59 / C1) — the mapping
 * half, which is where a defect would actually live: `toMitraSummary`
 * carrying the resolved emblem and its alt text, and the fallbacks for an
 * `apps/cms` that predates upstream awcms#806 (no fields at all), an
 * institution with no emblem, and a stale id that resolves to nothing.
 *
 * The rendered markup is covered end to end by
 * `logo-instansi-build-smoke.test.ts` against a real build; the placement
 * rule (first institution WITH an emblem, nothing at all otherwise) lives
 * in `LogoInstansi.astro` and is asserted there.
 */
import { describe, expect, test } from "bun:test";
import { toMitraSummary } from "../src/lib/awcms/lembaga";
import type { RawInstitution } from "../src/lib/awcms/blog";
import type { ResolvedMedia } from "../src/lib/awcms/media";

const LOGO: ResolvedMedia = {
  id: "00000000-0000-4000-8000-000000000099",
  publicUrl: "https://media.example.test/news/lambang-pemkab-kobar.png",
  alt: "Lambang Kabupaten Kotawaringin Barat",
  width: 240,
  height: 240,
  creditLine: null,
  sourceName: null,
  copyrightStatus: "owned"
};

function institution(extra: Partial<RawInstitution> = {}): RawInstitution {
  return {
    id: "i-pemkab-kobar",
    branch: "executive",
    name: "Pemkab Kotawaringin Barat",
    slug: "pemkab-kotawaringin-barat",
    regionCode: "62.02",
    description: "Pemerintah Kabupaten Kotawaringin Barat.",
    ...extra
  };
}

describe("toMitraSummary carries the institution emblem", () => {
  test("a resolved emblem and its authored alt text reach the summary", () => {
    const summary = toMitraSummary(
      institution({ logoMediaId: LOGO.id, logoAlt: "Lambang Kabupaten Kotawaringin Barat" }),
      "Kotawaringin Barat",
      LOGO
    );
    expect(summary.logo?.publicUrl).toBe(LOGO.publicUrl);
    expect(summary.logoAlt).toBe("Lambang Kabupaten Kotawaringin Barat");
  });

  test("an institution with no emblem carries none — and no alt text either", () => {
    const summary = toMitraSummary(institution(), "Kotawaringin Barat");
    expect(summary.logo).toBeNull();
    expect(summary.logoAlt).toBeNull();
  });

  test("a stale logo id that resolved to nothing renders nothing, never a broken image", () => {
    // `resolveMedia` reports an unresolvable id by omitting it from its map,
    // so the caller passes `null` — the summary must not invent a URL from
    // the id it still has.
    const summary = toMitraSummary(
      institution({ logoMediaId: "00000000-0000-4000-8000-0000000000ff", logoAlt: "Lambang" }),
      null,
      null
    );
    expect(summary.logo).toBeNull();
    expect(summary.logoAlt).toBe("Lambang");
  });

  test("an apps/cms older than the subtree pull sends neither field — the summary still builds", () => {
    // Both fields are optional on `RawInstitution` for exactly this case:
    // a build pointed at a CMS predating upstream awcms#806 must render no
    // emblem rather than crash on a missing property.
    const raw = institution();
    expect("logoMediaId" in raw).toBe(false);
    const summary = toMitraSummary(raw, "Kotawaringin Barat");
    expect(summary.logo).toBeNull();
    expect(summary.logoAlt).toBeNull();
    expect(summary.name).toBe("Pemkab Kotawaringin Barat");
  });

  test("an emblem with no authored alt text is decorative — alt stays null, never the name", () => {
    const summary = toMitraSummary(institution({ logoMediaId: LOGO.id }), null, LOGO);
    expect(summary.logo).not.toBeNull();
    expect(summary.logoAlt).toBeNull();
  });
});
