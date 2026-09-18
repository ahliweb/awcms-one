/**
 * `/index/wilayah-kabupaten-{provinceCode}.json` — one file per CONFIGURED
 * province (`PUBLIC_WILAYAH_PROVINSI`), each holding that province's
 * regencies/cities — the checkout address step's second `<select>`, fetched
 * client-side (same-origin, so no CORS/CSP concern at all) once a province
 * is chosen. See `src/lib/awcms/wilayah-checkout.ts`.
 *
 * The `Promise.all` below fans out one `getCheckoutRegencies` per configured
 * province; the HTTP requests behind it are bounded inside
 * `wilayah-checkout.ts` (`MAX_IN_FLIGHT_REGION_REQUESTS`, issue #71), shared
 * with `wilayah-kecamatan-[cityCode].json.ts`'s far larger fan-out.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { getCheckoutProvinces, getCheckoutRegencies, type WilayahRegion } from "../../lib/awcms/wilayah-checkout";

export const prerender = true;

export const getStaticPaths: GetStaticPaths = async () => {
  const provinces = await getCheckoutProvinces();

  return Promise.all(
    provinces.map(async (province) => ({
      params: { provinceCode: province.code },
      props: { regencies: await getCheckoutRegencies(province.code) }
    }))
  );
};

export const GET: APIRoute = ({ props }) => {
  const regencies = (props as { regencies: WilayahRegion[] }).regencies;

  return new Response(
    JSON.stringify(regencies.map(({ code, name }) => ({ code, name }))),
    { headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
};
