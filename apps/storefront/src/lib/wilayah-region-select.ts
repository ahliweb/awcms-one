/**
 * The shared browser-side wiring for the province → kabupaten/kota →
 * kecamatan cascading `<select>` triplet — built for `checkout.ts` (issue
 * #30) and extracted here (issue #90) so `/akun/alamat`'s own address form
 * (`akun-alamat.ts`) reuses the SAME region control/data module rather than
 * a second, drifting copy of this cascading-fetch logic.
 *
 * Every fetch here is SAME-ORIGIN against the build-time
 * `/index/wilayah-*.json` indexes (`src/lib/awcms/wilayah-checkout.ts`), so
 * none of it needs the CORS/CSP handling `toko-klien.ts`/`akun-klien.ts`
 * apply to their own, cross-origin CMS calls.
 */

export type RegionOption = { code: string; name: string };

async function fetchRegionJson(path: string): Promise<RegionOption[]> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return (await response.json()) as RegionOption[];
}

/** Replaces every `<option>` in `select` with a placeholder plus one option per item — the one DOM-mutation helper every region select in this app uses. */
export function fillRegionOptions(select: HTMLSelectElement, items: RegionOption[], placeholder: string): void {
  select.innerHTML = "";
  const placeholderOption = document.createElement("option");
  placeholderOption.value = "";
  placeholderOption.textContent = placeholder;
  select.appendChild(placeholderOption);

  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.code;
    option.textContent = item.name;
    select.appendChild(option);
  }
}

export function loadProvinces(select: HTMLSelectElement): void {
  fetchRegionJson("/index/wilayah-provinsi.json")
    .then((provinces) => fillRegionOptions(select, provinces, "Pilih provinsi"))
    .catch(() => {
      // Degrades to an empty select — a missing region index must not block
      // the form the select belongs to.
    });
}

export function loadKabupaten(provinceCode: string): Promise<RegionOption[]> {
  return fetchRegionJson(`/index/wilayah-kabupaten-${provinceCode}.json`);
}

export function loadKecamatan(cityCode: string): Promise<RegionOption[]> {
  return fetchRegionJson(`/index/wilayah-kecamatan-${cityCode}.json`);
}

export type RegionSelects = {
  province: HTMLSelectElement;
  city: HTMLSelectElement;
  district: HTMLSelectElement;
};

/**
 * Wires the three cascading selects exactly the way `checkout.ts` originally
 * did inline: a province change repopulates (and disables until loaded) the
 * city select, a city change repopulates the district select. `onChange` is
 * called after either cascade fires, for a caller (`checkout.ts`) that needs
 * to know the shopper touched the region manually — e.g. to stop treating a
 * "Pilih alamat tersimpan" selection as still authoritative.
 */
export function wireCascadingRegionSelects(selects: RegionSelects, onChange?: () => void): void {
  const { province, city, district } = selects;

  loadProvinces(province);

  province.addEventListener("change", () => {
    city.disabled = !province.value;
    fillRegionOptions(city, [], "Pilih kabupaten/kota");
    district.disabled = true;
    fillRegionOptions(district, [], "Pilih kabupaten/kota dahulu");

    if (province.value) {
      loadKabupaten(province.value)
        .then((regencies) => fillRegionOptions(city, regencies, "Pilih kabupaten/kota"))
        .catch(() => {});
    }
    onChange?.();
  });

  city.addEventListener("change", () => {
    district.disabled = !city.value;
    fillRegionOptions(district, [], "Pilih kecamatan");

    if (city.value) {
      loadKecamatan(city.value)
        .then((districts) => fillRegionOptions(district, districts, "Pilih kecamatan"))
        .catch(() => {});
    }
    onChange?.();
  });
}

/**
 * Programmatically fills and selects `province`/`city`/`district` for the
 * given codes, awaiting each cascading fetch in turn — used to autofill a
 * saved address (checkout's "Pilih alamat tersimpan") or to re-open an
 * existing address for editing (`/akun/alamat`). Stops silently at the
 * first fetch failure, leaving whatever was already filled in place rather
 * than throwing into the caller's own click/change handler.
 */
export async function applyRegionSelection(
  selects: RegionSelects,
  values: { provinceCode: string; cityCode: string; districtCode: string }
): Promise<void> {
  const { province, city, district } = selects;

  province.value = values.provinceCode;

  try {
    const regencies = await loadKabupaten(values.provinceCode);
    city.disabled = false;
    fillRegionOptions(city, regencies, "Pilih kabupaten/kota");
    city.value = values.cityCode;

    const districts = await loadKecamatan(values.cityCode);
    district.disabled = false;
    fillRegionOptions(district, districts, "Pilih kecamatan");
    district.value = values.districtCode;
  } catch {
    // Best-effort only — see this function's own docblock.
  }
}
